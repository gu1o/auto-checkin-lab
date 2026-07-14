#!/usr/bin/env python3
"""Poller do bot do Telegram (@CheckInLabBot) para o lab-checkin.

Escuta o chat via long-polling e implementa o /pular interativo:
pergunta a data (botoes Hoje/Amanha ou texto DD/MM), confirma e registra
o cancelamento como MENSAGEM FIXADA no chat, no formato:

    SKIP: 2026-07-15, 2026-07-20 -- ...

As rotinas cloud (preenchimento 10h / lembrete 14h) leem a mensagem fixada
via getChat — que nao expira, ao contrario da fila do getUpdates (24h).
Enquanto este poller roda, ele e o unico consumidor do getUpdates (um
getUpdates concorrente das rotinas recebe 409, tratado como fallback la).

Comandos: /pular [data], /retomar [data], /pulos, /cancelar.

Roda como servico systemd de usuario (ver docs/telegram-integration.md).
Credenciais: bloco "telegram" do config.json ao lado deste script.
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo

DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(DIR, "config.json")
STATE_PATH = os.path.join(DIR, ".poller_state.json")
SP = zoneinfo.ZoneInfo("America/Sao_Paulo")
SKIP_MARKER = "SKIP:"
WEEKDAYS_PT = ["segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo"]

HELP = (
    "Comandos:\n"
    "/pular — cancela o check-in automatico de um dia (pergunto a data)\n"
    "/pular DD/MM — cancela direto para a data\n"
    "/retomar DD/MM — desfaz um cancelamento\n"
    "/pulos — lista os cancelamentos agendados\n"
    "/cancelar — aborta a pergunta em andamento"
)


def log(msg):
    print(f"[{datetime.datetime.now(SP):%F %T}] {msg}", flush=True)


def load_config():
    with open(CONFIG_PATH) as f:
        t = json.load(f).get("telegram", {})
    token, chat = t.get("bot_token", ""), str(t.get("chat_id", ""))
    if not token or not chat:
        sys.exit("ERRO: telegram.bot_token/chat_id ausentes no config.json")
    return token, int(chat)


TOKEN, CHAT_ID = load_config()


def api(method, params=None, timeout=65):
    url = f"https://api.telegram.org/bot{TOKEN}/{method}"
    data = urllib.parse.urlencode(params or {}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        log(f"API {method} HTTP {e.code}: {body[:200]}")
        return {"ok": False, "error_code": e.code, "description": body}
    except Exception as e:  # rede fora, timeout etc.
        log(f"API {method} falhou: {e}")
        return {"ok": False, "description": str(e)}


def send(text, reply_markup=None):
    params = {"chat_id": CHAT_ID, "text": text}
    if reply_markup:
        params["reply_markup"] = json.dumps(reply_markup)
    return api("sendMessage", params)


def today():
    return datetime.datetime.now(SP).date()


def parse_date(raw):
    """Aceita: hoje, amanha, DD/MM, DD/MM/AAAA, AAAA-MM-DD. None se invalido."""
    s = raw.strip().lower().replace("amanhã", "amanha")
    if s == "hoje":
        return today()
    if s == "amanha":
        return today() + datetime.timedelta(days=1)
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try:
            return datetime.date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s)
    if not m:
        return None
    day, month = int(m[1]), int(m[2])
    year = int(m[3]) if m[3] else today().year
    if year < 100:
        year += 2000
    try:
        d = datetime.date(year, month, day)
    except ValueError:
        return None
    if not m[3] and d < today():  # DD/MM sem ano e ja passou -> proximo ano
        d = datetime.date(year + 1, month, day)
    return d


def fmt(d):
    return f"{d:%d/%m} ({WEEKDAYS_PT[d.weekday()]})"


# --- mensagem fixada com as datas de skip ---------------------------------

def get_skips():
    """Retorna (pinned_message | None, [datas ISO ordenadas])."""
    r = api("getChat", {"chat_id": CHAT_ID})
    pm = r.get("result", {}).get("pinned_message")
    if not pm or SKIP_MARKER not in (pm.get("text") or ""):
        return None, []
    dates = sorted(set(re.findall(r"\d{4}-\d{2}-\d{2}", pm["text"])))
    return pm, dates


def write_skips(pm, dates):
    """Regrava a mensagem fixada com `dates` (ISO), descartando datas passadas."""
    dates = sorted(d for d in set(dates) if d >= today().isoformat())
    if not dates:
        if pm:
            api("unpinChatMessage", {"chat_id": CHAT_ID, "message_id": pm["message_id"]})
            api("deleteMessage", {"chat_id": CHAT_ID, "message_id": pm["message_id"]})
        return
    text = (
        f"{SKIP_MARKER} {', '.join(dates)} — o check-in automatico NAO sera "
        "enviado nessas datas (agendado via /pular; desfaca com /retomar)"
    )
    if pm:
        api("editMessageText", {"chat_id": CHAT_ID, "message_id": pm["message_id"], "text": text})
    else:
        r = send(text)
        if r.get("ok"):
            api("pinChatMessage", {
                "chat_id": CHAT_ID,
                "message_id": r["result"]["message_id"],
                "disable_notification": True,
            })


# --- comandos ---------------------------------------------------------------

def do_pular(d):
    if d is None:
        send("Nao entendi a data. Manda DD/MM (ex: 21/07), \"hoje\" ou \"amanha\".")
        return False
    if d < today():
        send(f"{fmt(d)} ja passou — nada a cancelar.")
        return True
    if d.weekday() >= 5:
        send(f"{fmt(d)} e fim de semana — o check-in nem roda nesse dia, nada a cancelar.")
        return True
    pm, dates = get_skips()
    if d.isoformat() in dates:
        send(f"O check-in de {fmt(d)} ja estava cancelado.")
        return True
    write_skips(pm, dates + [d.isoformat()])
    send(f"🚫 Fechado! Vou pular o check-in de {fmt(d)}. Pra desfazer: /retomar {d:%d/%m}")
    log(f"skip agendado: {d}")
    return True


def do_retomar(arg):
    pm, dates = get_skips()
    if not dates:
        send("Nao ha nenhum cancelamento agendado.")
        return
    if arg:
        d = parse_date(arg)
        if d is None:
            send("Nao entendi a data. Ex: /retomar 21/07")
            return
    elif len(dates) == 1:
        d = datetime.date.fromisoformat(dates[0])
    else:
        send("Ha mais de um cancelamento agendado: "
             + ", ".join(f"{datetime.date.fromisoformat(x):%d/%m}" for x in dates)
             + ". Especifique: /retomar DD/MM")
        return
    if d.isoformat() not in dates:
        send(f"{fmt(d)} nao estava cancelado. Agendados: "
             + ", ".join(f"{datetime.date.fromisoformat(x):%d/%m}" for x in dates))
        return
    write_skips(pm, [x for x in dates if x != d.isoformat()])
    send(f"✅ Cancelamento desfeito — o check-in de {fmt(d)} volta a ser enviado normalmente.")
    log(f"skip removido: {d}")


def do_pulos():
    _, dates = get_skips()
    if not dates:
        send("Nenhum cancelamento agendado — check-ins seguem normais.")
    else:
        send("Check-ins cancelados: "
             + ", ".join(fmt(datetime.date.fromisoformat(x)) for x in dates))


# --- loop principal ----------------------------------------------------------

pending = None  # 'pular' quando aguardando a data


def ask_date():
    global pending
    pending = "pular"
    send("Pular o check-in de quando?", reply_markup={
        "inline_keyboard": [[
            {"text": "Hoje", "callback_data": "pular:hoje"},
            {"text": "Amanha", "callback_data": "pular:amanha"},
        ]]
    })
    # sem botao para outra data: e so responder com DD/MM


def handle_text(text):
    global pending
    t = text.strip()
    low = t.lower()
    if low.startswith("/pular"):
        pending = None
        arg = t[len("/pular"):].strip()
        if arg:
            do_pular(parse_date(arg))
        else:
            ask_date()
            send("(ou responda com a data: DD/MM)")
    elif low.startswith("/retomar"):
        pending = None
        do_retomar(t[len("/retomar"):].strip())
    elif low.startswith("/pulos"):
        pending = None
        do_pulos()
    elif low.startswith("/cancelar"):
        pending = None
        send("Ok, deixa pra la.")
    elif low.startswith("/"):
        pending = None
        send(HELP)
    elif pending == "pular":
        if do_pular(parse_date(t)):
            pending = None
    else:
        send(HELP)


def handle_callback(cq):
    global pending
    api("answerCallbackQuery", {"callback_query_id": cq["id"]})
    msg = cq.get("message")
    if msg:  # remove os botoes da pergunta ja respondida
        api("editMessageReplyMarkup", {"chat_id": CHAT_ID, "message_id": msg["message_id"]})
    data = cq.get("data", "")
    if data.startswith("pular:"):
        pending = None
        do_pular(parse_date(data.split(":", 1)[1]))


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f)


def main():
    api("setMyCommands", {"commands": json.dumps([
        {"command": "pular", "description": "Cancelar o check-in automatico de um dia"},
        {"command": "retomar", "description": "Desfazer um cancelamento (/retomar DD/MM)"},
        {"command": "pulos", "description": "Listar cancelamentos agendados"},
    ])})
    state = load_state()
    offset = state.get("offset")
    if offset is None:
        # primeira execucao: descarta o backlog para nao responder mensagens antigas
        r = api("getUpdates", {"timeout": 0})
        upds = r.get("result", [])
        offset = (upds[-1]["update_id"] + 1) if upds else 0
        save_state({"offset": offset})
        log(f"backlog de {len(upds)} update(s) descartado")
    log(f"poller iniciado (chat {CHAT_ID}, offset {offset})")

    last_cleanup = None
    while True:
        if last_cleanup != today():  # remove datas passadas da mensagem fixada
            pm, dates = get_skips()
            if pm:
                write_skips(pm, dates)
            last_cleanup = today()
        r = api("getUpdates", {"offset": offset, "timeout": 50})
        if not r.get("ok"):
            time.sleep(10 if r.get("error_code") == 409 else 5)
            continue
        for u in r["result"]:
            offset = u["update_id"] + 1
            try:
                if "callback_query" in u:
                    cq = u["callback_query"]
                    if cq["from"]["id"] == CHAT_ID:
                        handle_callback(cq)
                elif "message" in u:
                    m = u["message"]
                    if m["chat"]["id"] == CHAT_ID and m.get("text"):
                        log(f"msg: {m['text']!r}")
                        handle_text(m["text"])
            except Exception as e:
                log(f"erro processando update {u.get('update_id')}: {e}")
        if r["result"]:
            save_state({"offset": offset})


if __name__ == "__main__":
    main()
