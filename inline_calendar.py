#!/usr/bin/env python3
"""Calendario inline para bots do Telegram.

Porta em Python (stdlib) do calendario de navegacao do
VDS13/telegram-inline-calendar v2.x (MIT) — o original e um pacote npm e nao
roda neste poller. Mesmo layout, com a semana comecando no domingo e os
rotulos pt-br do language.json dele:

    <<      Ago 2026     >>
    Dom Seg Ter Qua Qui Sex Sab
     ₁   ₂   ₃   ₄   ₅   ₆   ₇
    ...
    <                        >
    ✔ Confirmar (2)    ✖ Sair

Dia sem check-in para pular (passado, fim de semana) aparece em SUBSCRITO e sem
acao a nao ser explicar no balao: some do teclado, nao do mes.

A SELECAO VIVE NO TEXTO DA MENSAGEM (linha "Marcados: 26/08, 27/08"): sai de
graca, atravessa a navegacao de mes e o usuario le o que marcou. O
`callback_data` (64 bytes) nao daria conta de carregar N datas.

callback_data (o esquema e o mesmo do worker.js, para as duas implementacoes se
lerem igual; o original usava "n_AAAA-MM-DD_0" + um operador de mes):
    cal:t:AAAA-MM-DD  alterna o dia
    cal:b:AAAA-MM-DD  dia bloqueado (so explica no balao)
    cal:n:AAAA-MM     navegacao, com o mes destino ja calculado e limitado
    cal:ok / cal:no   confirma / desiste
    cal:x             celula sem acao (o Telegram exige callback_data nao vazio)
"""
import calendar
import datetime
import re

WEEK_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"]  # start_week_day=0
MONTH_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
            "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
SUB = "₀₁₂₃₄₅₆₇₈₉"
SEL_LABEL = "Marcados: "
BLANK = {"text": " ", "callback_data": "cal:x"}


def _first(d):
    return d.replace(day=1)


def _shift(d, months):
    m = d.month - 1 + months
    return datetime.date(d.year + m // 12, m % 12 + 1, 1)


def _nav(cur, months, label, start, stop):
    """Botao que anda `months` meses a partir de `cur`, preso a [start, stop]."""
    tgt = _shift(cur, months)
    if start and tgt < _first(start):
        tgt = _first(start)
    if stop and tgt > _first(stop):
        tgt = _first(stop)
    if tgt == cur:
        return BLANK
    return {"text": label, "callback_data": f"cal:n:{tgt:%Y-%m}"}


def keyboard(month, start=None, stop=None, enabled=None, sel=()):
    """inline_keyboard do mes de `month` (dia ignorado), com `sel` marcado.

    Dias fora de [start, stop] ou reprovados por `enabled(date)` ficam em
    subscrito e sem acao (equivale a start_date/stop_date/lock_date do
    original), mas continuam visiveis.
    """
    cur = _first(month)
    sel = {d.isoformat() if hasattr(d, "isoformat") else d for d in sel}
    rows = [
        [_nav(cur, -12, "<<", start, stop),
         {"text": f"{MONTH_PT[cur.month - 1]} {cur.year}", "callback_data": "cal:x"},
         _nav(cur, 12, ">>", start, stop)],
        [{"text": w, "callback_data": "cal:x"} for w in WEEK_PT],
    ]
    for week in calendar.Calendar(firstweekday=6).monthdayscalendar(cur.year, cur.month):
        row = []
        for day in week:
            if not day:
                row.append(BLANK)
                continue
            d = cur.replace(day=day)
            ok = (not start or d >= start) and (not stop or d <= stop) \
                and (not enabled or enabled(d))
            if not ok:
                row.append({"text": str(day).translate(str.maketrans("0123456789", SUB)),
                            "callback_data": f"cal:b:{d:%Y-%m-%d}"})
            else:
                row.append({"text": f"✓{day}" if d.isoformat() in sel else str(day),
                            "callback_data": f"cal:t:{d:%Y-%m-%d}"})
        rows.append(row)
    rows.append([_nav(cur, -1, "<", start, stop), BLANK, _nav(cur, 1, ">", start, stop)])
    rows.append([{"text": f"✔ Confirmar ({len(sel)})", "callback_data": "cal:ok"},
                 {"text": "✖ Sair", "callback_data": "cal:no"}])
    return rows


def short(d):
    """"26/08" — o que vai na linha "Marcados:"."""
    return f"{d:%d/%m}"


def text(instrucao, sel):
    """Texto da mensagem do calendario, com a selecao embutida."""
    marcados = ", ".join(short(d) for d in sorted(sel)) if sel else "nenhum"
    return f"{instrucao}\n\n{SEL_LABEL}{marcados}"


def selection(msg_text, resolve):
    """Le a selecao de volta do texto. `resolve("26/08")` -> date (o mesmo
    parse_date dos comandos digitados, que resolve o ano para a proxima
    ocorrencia — e toda selecao e de hoje pra frente)."""
    for line in (msg_text or "").split("\n"):
        if line.startswith(SEL_LABEL):
            got = (resolve(m) for m in re.findall(r"\b\d{2}/\d{2}\b", line))
            return sorted({d for d in got if d})
    return []


def parse(data):
    """callback_data -> ("toggle"|"blocked", date) | ("nav", 1o do mes) | ("ok"|"no", None) | None."""
    if not data.startswith("cal:"):
        return None
    parts = data.split(":")
    op, payload = parts[1], parts[2] if len(parts) > 2 else ""
    if op in ("ok", "no"):
        return op, None
    if op == "n":
        y, m = payload.split("-")
        return "nav", datetime.date(int(y), int(m), 1)
    if op in ("t", "b"):
        return ("toggle" if op == "t" else "blocked"), datetime.date.fromisoformat(payload)
    return None


def _demo():
    cell = lambda kb: [b for r in kb[2:-2] for b in r]
    livres = lambda kb: [b for b in cell(kb) if b["callback_data"].startswith("cal:t:")]
    bloq = lambda kb: [b for b in cell(kb) if b["callback_data"].startswith("cal:b:")]

    # Ago/2026 comeca num sabado -> 6 semanas; +cabecalho(2) +navegacao +acoes = 10
    kb = keyboard(datetime.date(2026, 8, 26))
    assert len(kb) == 10, len(kb)
    assert [len(r) for r in kb] == [3, 7, 7, 7, 7, 7, 7, 7, 3, 2]
    assert kb[0][1]["text"] == "Ago 2026"
    assert [b["text"] for b in kb[1]] == WEEK_PT
    # 01/08/2026 e sabado: 6 celulas vazias antes dele (dom..sex)
    assert [b["text"] for b in cell(kb)[:7]] == [" "] * 6 + ["1"]
    assert len(livres(kb)) == 31 and not bloq(kb)
    assert livres(kb)[0]["callback_data"] == "cal:t:2026-08-01"
    assert kb[-1][0]["callback_data"] == "cal:ok" and kb[-1][1]["callback_data"] == "cal:no"

    # bloqueado: subscrito, sem acao de toggle, e o mes segue inteiro na tela
    kb = keyboard(datetime.date(2026, 8, 1), start=datetime.date(2026, 8, 26))
    assert len([b for b in cell(kb) if b["text"] != " "]) == 31
    assert cell(kb)[6]["text"] == "₁" and cell(kb)[6]["callback_data"] == "cal:b:2026-08-01"
    assert [b["callback_data"] for b in livres(kb)] == \
        [f"cal:t:2026-08-{d}" for d in range(26, 32)]
    assert len(bloq(kb)) == 25
    # "<" e "<<" presos ao mes do start; ">>" pula 12 meses
    assert kb[-2][0] == BLANK and kb[-2][2]["callback_data"] == "cal:n:2026-09"
    assert kb[0][0] == BLANK and kb[0][2]["callback_data"] == "cal:n:2027-08"
    assert keyboard(datetime.date(2027, 1, 1),
                    start=datetime.date(2026, 8, 26))[0][0]["callback_data"] == "cal:n:2026-08"

    # enabled: fim de semana visivel, sem acao
    util = lambda d: d.weekday() < 5
    kb = keyboard(datetime.date(2026, 8, 1), enabled=util)
    assert len(livres(kb)) == 21 and len(bloq(kb)) == 10

    # selecao: marca com ✓, conta no botao, e nao muda quem e clicavel
    a, b = datetime.date(2026, 8, 26), datetime.date(2026, 8, 27)
    kbs = keyboard(a, enabled=util, sel=[a, b])
    assert [x["text"] for x in cell(kbs) if x["text"].startswith("✓")] == ["✓26", "✓27"]
    assert kbs[-1][0]["text"] == "✔ Confirmar (2)"
    assert kb[-1][0]["text"] == "✔ Confirmar (0)"  # sempre presente
    assert [x["callback_data"] for x in livres(kbs)] == [x["callback_data"] for x in livres(kb)]
    # a selecao atravessa a navegacao de mes (nenhum ✓ em setembro, contador igual)
    kbn = keyboard(datetime.date(2026, 9, 1), enabled=util, sel=[a, b])
    assert not [x for x in cell(kbn) if x["text"].startswith("✓")]
    assert kbn[-1][0]["text"] == "✔ Confirmar (2)"

    # texto <-> selecao, com um resolve DD/MM fixo em 2026
    def resolve(s):
        d, m = s.split("/")
        return datetime.date(2026, int(m), int(d))
    assert selection(text("oi", [a, b]), resolve) == [a, b]
    assert selection(text("oi", []), resolve) == []
    assert selection(None, resolve) == [] and selection("sem a linha", resolve) == []
    # data fora da linha "Marcados:" nao conta; duplicata e ordem nao importam
    assert selection("Manda 21/07\nMarcados: nenhum", resolve) == []
    assert selection("Marcados: 27/08, 26/08, 27/08", resolve) == [a, b]

    # virada de ano nos dois sentidos
    assert _shift(datetime.date(2026, 1, 1), -1) == datetime.date(2025, 12, 1)
    assert _shift(datetime.date(2026, 12, 1), 1) == datetime.date(2027, 1, 1)
    assert _shift(datetime.date(2026, 3, 1), -12) == datetime.date(2025, 3, 1)

    # parse
    assert parse("cal:t:2026-08-21") == ("toggle", datetime.date(2026, 8, 21))
    assert parse("cal:b:2026-08-01") == ("blocked", datetime.date(2026, 8, 1))
    assert parse("cal:n:2026-07") == ("nav", datetime.date(2026, 7, 1))
    assert parse("cal:ok") == ("ok", None) and parse("cal:no") == ("no", None)
    assert parse("cal:x") is None and parse("pular:hoje") is None
    print("ok")


if __name__ == "__main__":
    _demo()
