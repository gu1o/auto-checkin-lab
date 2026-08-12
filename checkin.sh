#!/usr/bin/env bash
#
# Preenche o check-in diario de Saude da Entrega no Ideal Lab
# (https://lab.idealtrends.io/saude-entrega/daily).
#
# Autenticacao: cookie remember_web persistido em cookies.txt (ao lado deste
# script). A cada execucao o script faz um GET para renovar a sessao e obter
# um XSRF-TOKEN fresco, depois faz o POST. O POST atualiza o check-in do dia
# se ele ja existir.
#
# Uso:
#   ./checkin.sh status
#       Mostra o estado dos check-ins de hoje (por iniciativa).
#
#   ./checkin.sh submit --yesterday "..." --today "..." [opcoes]
#       Envia o check-in. Opcoes:
#         --yesterday TEXT    o que foi feito ontem (obrigatorio)
#         --today TEXT        o que sera feito hoje (obrigatorio)
#         --confidence N      1-5 (padrao: 5)
#         --blockers TEXT     (padrao: "Nenhum")
#         --artifact URL      (padrao: vazio)
#         --initiative ID     (padrao: 6 = Auditoria Ideal)
#         --date YYYY-MM-DD   (padrao: hoje)
#
#   ./checkin.sh auto [--initiative ID] [--dry-run]
#       Preenche o check-in automaticamente buscando atividades do Jira/Bitbucket.
#       Com initiative_config no config.json, roteia a atividade por iniciativa
#       (project key do Jira / repo do Bitbucket) e faz um submit por iniciativa
#       com atividade; o --initiative e a iniciativa padrao (atividade nao
#       mapeada + dia sem atividade). Sem initiative_config, um unico submit.
#       Respeita schedule.enabled/schedule.time do config.json (modelo tick).
#
#   ./checkin.sh pular DD/MM      (ou hoje/amanha/YYYY-MM-DD)
#       Cancela o check-in local de uma data (arquivo .skips.json), sem Telegram.
#   ./checkin.sh retomar DD/MM    Desfaz um skip local.
#   ./checkin.sh pulos            Lista os skips locais agendados.
#
#   ./checkin.sh repos [PADRAO]
#       Confirmacao (so leitura): lista os repos do workspace que casam com o
#       PADRAO (regex/substring). Sem PADRAO, usa o bitbucket.repositories do
#       config.json. Util para validar o filtro antes de deixar a cron rodar.

set -Eeuo pipefail

BASE_URL="https://lab.idealtrends.io"
ENDPOINT="$BASE_URL/saude-entrega/daily"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$DIR/cookies.txt"
CONFIG="$DIR/config.json"
SKIPS_FILE="$DIR/.skips.json"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

# Só os comandos que falam com o Lab (status/submit/auto) exigem o cookie;
# pular/retomar/pulos mexem so no arquivo local .skips.json.
require_jar() {
    [ -f "$JAR" ] || { echo "ERRO: $JAR nao existe (cookie remember_web necessario)" >&2; exit 1; }
}

notify() {
    # Notifica o desfecho. Preferencia (Fase 5b): se notify.url + notify.secret
    # estiverem no config.json, manda pro worker /notify (o bot_token sai do
    # config do dev). Senao, se telegram.bot_token/chat_id existirem, fala direto
    # com o Telegram. Sem nada configurado, nao faz nada (fluxo dos demais devs
    # intacto).
    local text="$1" fields notify_url notify_secret token chat_id
    [ -f "$CONFIG" ] || return 0
    fields="$(python3 -c '
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
n = c.get("notify", {}) or {}
t = c.get("telegram", {}) or {}
print(n.get("url", ""))
print(n.get("secret", ""))
print(t.get("bot_token", ""))
print(str(t.get("chat_id", "")))
' "$CONFIG")" || return 0
    notify_url="$(sed -n 1p <<<"$fields")"
    notify_secret="$(sed -n 2p <<<"$fields")"
    token="$(sed -n 3p <<<"$fields")"
    chat_id="$(sed -n 4p <<<"$fields")"

    if [ -n "$notify_url" ] && [ -n "$notify_secret" ] && [ -n "$chat_id" ]; then
        local payload
        payload="$(python3 -c 'import json,sys; print(json.dumps({"chatId": int(sys.argv[1]), "text": sys.argv[2]}))' "$chat_id" "$text")"
        if curl -sf -o /dev/null --max-time 10 \
            -H "content-type: application/json" \
            -H "x-notify-secret: ${notify_secret}" \
            --data-raw "$payload" \
            "${notify_url%/}/notify"; then
            return 0
        fi
        # falha no worker: cai no envio direto abaixo se houver bot_token
    fi
    [ -n "$token" ] && [ -n "$chat_id" ] || return 0
    curl -s -o /dev/null --max-time 10 \
        "https://api.telegram.org/bot${token}/sendMessage" \
        -d chat_id="${chat_id}" \
        --data-urlencode text="$text" || true
}

# Notifica falhas do modo auto (o alerta mais valioso: cookie remember_web
# expirado faria a cron falhar calada). Ativado apenas dentro de cmd_auto.
NOTIFY_ON_ERR=false
on_err() {
    local code=$?
    [ "$NOTIFY_ON_ERR" = "true" ] || return 0
    NOTIFY_ON_ERR=false
    notify "❌ lab-checkin: falha no check-in automatico (exit $code, $(date '+%F %H:%M')).
Causa comum: cookie remember_web expirado. Verifique o auto.log."
}
trap on_err ERR

refresh_session() {
    # GET renova ceo_vision_ia_session + XSRF-TOKEN no cookie jar e devolve o HTML
    curl -sf -b "$JAR" -c "$JAR" \
        -H "accept: text/html" \
        -H "user-agent: $UA" \
        "$ENDPOINT"
}

page_props() {
    refresh_session \
        | grep -o 'data-page="[^"]*"' \
        | python3 -c 'import sys, html; s = html.unescape(sys.stdin.read()).strip(); print(s[len("data-page=\""):-1])'
}

xsrf_token() {
    # Cookie XSRF-TOKEN url-decodificado, como o navegador manda no header
    grep -P '^\S+\t.*\tXSRF-TOKEN\t' "$JAR" | tail -1 | cut -f7 \
        | python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))'
}

cmd_status() {
    page_props | python3 -c '
import json, sys
p = json.load(sys.stdin)["props"]
print(f"Usuario: {p['"'"'auth'"'"']['"'"'user'"'"']['"'"'name'"'"']}  |  Data: {p['"'"'today'"'"']}")
for c in p["cards"]:
    e = c.get("existing")
    if e:
        print(f"  [OK] {c['"'"'initiativeId'"'"']} {c['"'"'initiativeName'"'"']} — enviado {e['"'"'submittedAt'"'"']} (confidence {e['"'"'confidenceScore'"'"']})")
    else:
        print(f"  [--] {c['"'"'initiativeId'"'"']} {c['"'"'initiativeName'"'"']} — pendente")
'
}

is_submitted() {
    local init_id="${1:-6}"
    page_props | python3 -c '
import json, sys
p = json.load(sys.stdin)["props"]
for c in p["cards"]:
    if c["initiativeId"] == int(sys.argv[1]) and c.get("existing"):
        sys.exit(0)
sys.exit(1)
' "$init_id"
}

submit_failure() {
    # Depois do POST: imprime o motivo se o check-in NAO gravou (silencio = gravou).
    # O Inertia flasheia os erros de validacao na sessao e eles voltam em
    # props.errors deste GET — e assim que sabemos o nome de um campo novo do
    # formulario, sem adivinhar. Uso: submit_failure <initiative_id> <payload_json>
    page_props | python3 -c '
import json, sys
props = json.load(sys.stdin)["props"]
init, payload = int(sys.argv[1]), json.loads(sys.argv[2])
if any(c["initiativeId"] == init and c.get("existing") for c in props.get("cards", [])):
    sys.exit(0)
errs = props.get("errors") or {}
vals = list(errs.values())
if len(vals) == 1 and isinstance(vals[0], dict):  # bag nomeado
    errs = vals[0]
items = [(f, m[0] if isinstance(m, list) else m) for f, m in errs.items()]
if not items:
    print("o Lab aceitou a requisicao mas o check-in nao aparece no card — o formulario provavelmente ganhou um campo obrigatorio novo")
else:
    msg = "o Lab reprovou o envio: " + "; ".join(f"{f} ({m})" for f, m in items)
    novos = [f for f, _ in items if f not in payload]
    if novos:
        msg += " — campo(s) novo(s) no formulario que o script nao preenche: " + ", ".join(novos)
    print(msg)
' "$1" "$2"
}

is_skipped() {
    # Respeita o /pular do bot: le a mensagem fixada do chat com o
    # @CheckInLabBot ("SKIP: YYYY-MM-DD, ...") via getChat. Mesmo contrato do
    # notify(): sem telegram no config.json, nao checa; falha na chamada nao
    # bloqueia o check-in (mesma filosofia das rotinas cloud).
    local creds token chat_id pinned today
    [ -f "$CONFIG" ] || return 1
    creds="$(python3 -c '
import json, sys
try:
    t = json.load(open(sys.argv[1])).get("telegram", {})
    tok, chat = t.get("bot_token", ""), str(t.get("chat_id", ""))
    if tok and chat:
        print(tok)
        print(chat)
except Exception:
    pass
' "$CONFIG")" || return 1
    [ -n "$creds" ] || return 1
    token="$(sed -n 1p <<<"$creds")"
    chat_id="$(sed -n 2p <<<"$creds")"
    pinned="$(curl -s --max-time 10 \
        "https://api.telegram.org/bot${token}/getChat" \
        -d chat_id="${chat_id}" \
        | python3 -c '
import json, sys
try:
    r = json.load(sys.stdin)
    print((r.get("result") or {}).get("pinned_message", {}).get("text", ""))
except Exception:
    pass
')" || return 1
    today="$(date +%F)"
    case "$pinned" in
        *SKIP:*"$today"*) return 0 ;;
    esac
    return 1
}

is_holiday() {
    python3 -c "
import sys, datetime
sys.path.append('$DIR')
import auto_activity
today = datetime.date.today()
sys.exit(0 if auto_activity.is_holiday(today) else 1)
"
}

# Skip LOCAL (arquivo .skips.json) — alternativa ao /pular do Telegram para
# quem roda so no CLI/cron, sem depender do bot. Formato:
#   {"skips": ["YYYY-MM-DD", ...]}
is_locally_skipped() {
    [ -f "$SKIPS_FILE" ] || return 1
    python3 -c '
import json, sys, datetime
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if datetime.date.today().isoformat() in (data.get("skips") or []) else 1)
' "$SKIPS_FILE"
}

# skip_tool <add|remove|list> [data] — gerencia o .skips.json (datas locais).
skip_tool() {
    python3 - "$SKIPS_FILE" "$@" <<'PY'
import json, sys, datetime, re
path = sys.argv[1]
action = sys.argv[2] if len(sys.argv) > 2 else "list"
raw = (sys.argv[3] if len(sys.argv) > 3 else "").strip().lower()
today = datetime.date.today()

def parse(s):
    if s == "hoje": return today
    if s in ("amanha", "amanhã"): return today + datetime.timedelta(days=1)
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        try: return datetime.date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError: return None
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?", s)
    if not m: return None
    day, mon = int(m[1]), int(m[2])
    year = int(m[3]) if m[3] else today.year
    if year < 100: year += 2000
    try: d = datetime.date(year, mon, day)
    except ValueError: return None
    if not m[3] and d < today: d = datetime.date(year + 1, mon, day)
    return d

try:
    skips = set(json.load(open(path)).get("skips") or [])
except Exception:
    skips = set()
skips = {s for s in skips if s >= today.isoformat()}  # limpa passado

if action == "list":
    print("Skips locais: " + (", ".join(sorted(skips)) if skips else "nenhum"))
    sys.exit(0)

d = parse(raw)
if not d:
    print("ERRO: nao entendi a data (use DD/MM, hoje, amanha ou YYYY-MM-DD)", file=sys.stderr)
    sys.exit(1)
iso = d.isoformat()
if action == "add":
    if d < today:
        print(f"ERRO: {iso} ja passou.", file=sys.stderr); sys.exit(1)
    skips.add(iso)
    msg = f"🚫 Check-in local de {iso} sera pulado. Desfaz com: checkin.sh retomar {d:%d/%m}"
elif action == "remove":
    if iso not in skips:
        print(f"{iso} nao estava na lista de skips locais."); sys.exit(0)
    skips.discard(iso)
    msg = f"✅ Skip local de {iso} removido — o check-in volta ao normal nesse dia."
else:
    print(f"ERRO: acao desconhecida: {action}", file=sys.stderr); sys.exit(1)

json.dump({"skips": sorted(skips)}, open(path, "w"))
print(msg)
PY
}

cmd_pular() {
    [ -n "${1:-}" ] || { echo "ERRO: uso: checkin.sh pular DD/MM (ou hoje/amanha/YYYY-MM-DD)" >&2; exit 1; }
    skip_tool add "$1"
}

cmd_retomar() {
    [ -n "${1:-}" ] || { echo "ERRO: uso: checkin.sh retomar DD/MM" >&2; exit 1; }
    skip_tool remove "$1"
}

cmd_pulos() { skip_tool list; }

# Confirmacao de repositorios (so leitura) — delega ao auto_activity.py.
cmd_repos() { python3 "$DIR/auto_activity.py" --list-repos "$@"; }

# Gate de agendamento (modelo tick): a crontab roda de X em X minutos; so
# prossegue se schedule.enabled != false E (schedule.time vazio OU horario
# atual >= schedule.time). Torna a cron idempotente e resolve maquina desligada
# no horario exato (o proximo tick apos o boot envia). Sem bloco schedule (ou
# time vazio), sempre prossegue. Codigos: 0=ok, 2=pausado, 3=antes do horario.
schedule_gate() {
    [ -f "$CONFIG" ] || return 0
    python3 -c '
import json, sys, datetime
try:
    s = json.load(open(sys.argv[1])).get("schedule", {}) or {}
except Exception:
    sys.exit(0)
if s.get("enabled") is False:
    sys.exit(2)
t = (s.get("time") or "").strip()
if t and datetime.datetime.now().strftime("%H:%M") < t:
    sys.exit(3)
sys.exit(0)
' "$CONFIG"
}

cmd_auto() {
    local initiative=6 dry_run=false force=false
    while [ $# -gt 0 ]; do
        case "$1" in
            --initiative) initiative="$2"; shift 2 ;;
            --dry-run)    dry_run=true;     shift ;;
            --force)      force=true;       shift ;;
            *) echo "ERRO: opcao desconhecida: $1" >&2; exit 1 ;;
        esac
    done

    # 0. Gate de agendamento (modelo tick) — nao aplica em dry-run nem --force.
    if [ "$dry_run" != "true" ] && [ "$force" != "true" ]; then
        local gate=0; schedule_gate || gate=$?
        if [ "$gate" -eq 2 ]; then echo "schedule.enabled=false — automatico pausado."; return 0; fi
        if [ "$gate" -eq 3 ]; then echo "Ainda antes do schedule.time configurado. Pulando este tick."; return 0; fi
    fi

    NOTIFY_ON_ERR=true

    # 1. Ignora fim de semana
    local dow; dow="$(date +%u)"
    if [ "$dow" -eq 6 ] || [ "$dow" -eq 7 ]; then
        echo "Hoje e fim de semana. Pulando check-in."
        return 0
    fi

    # 2. Ignora feriado
    if is_holiday; then
        echo "Hoje e feriado. Pulando check-in."
        return 0
    fi

    # 2b. Ignora se o dia foi cancelado via /pular (mensagem fixada no Telegram)
    #     ou via skip local (checkin.sh pular / arquivo .skips.json).
    if is_locally_skipped; then
        echo "Check-in de hoje cancelado via skip local (.skips.json). Pulando."
        notify "🚫 lab-checkin: check-in de hoje NAO enviado — skip local. Para desfazer: checkin.sh retomar hoje"
        return 0
    fi
    if is_skipped; then
        echo "Check-in de hoje cancelado via /pular (mensagem fixada no Telegram). Pulando."
        notify "🚫 lab-checkin: check-in de hoje NAO enviado — cancelado via /pular. Para desfazer: /retomar hoje"
        return 0
    fi

    # 3. Coleta atividade, roteada por iniciativa quando initiative_config estiver
    #    configurado (senao, um unico check-in na iniciativa padrao). A guarda de
    #    "ja preenchido" passa a ser por iniciativa, dentro do loop abaixo.
    local json_output; json_output="$(python3 "$DIR/auto_activity.py" --default-initiative "$initiative")"

    # Aviso de roteamento (atividade sem mapeamento -> iniciativa padrao)
    local warnings; warnings="$(echo "$json_output" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("warnings", []):
    print(w)
')"
    if [ -n "$warnings" ]; then
        echo "$warnings"
        [ "$dry_run" = "true" ] || notify "⚠️ lab-checkin: $warnings"
    fi

    local count; count="$(echo "$json_output" | python3 -c 'import sys, json; print(len(json.load(sys.stdin).get("checkins", [])))')"
    if [ "$count" -eq 0 ]; then
        echo "Nenhuma atividade para enviar hoje. Nenhum check-in enviado."
        NOTIFY_ON_ERR=false
        return 0
    fi

    # 4. Um submit por iniciativa com atividade
    local i=0
    while [ "$i" -lt "$count" ]; do
        local init yesterday today
        init="$(echo "$json_output" | python3 -c 'import sys, json; print(json.load(sys.stdin)["checkins"]['"$i"']["initiative"])')"
        yesterday="$(echo "$json_output" | python3 -c 'import sys, json; print(json.load(sys.stdin)["checkins"]['"$i"']["yesterday"])')"
        today="$(echo "$json_output" | python3 -c 'import sys, json; print(json.load(sys.stdin)["checkins"]['"$i"']["today"])')"
        i=$((i + 1))

        if [ "$dry_run" = "true" ]; then
            echo "=== DRY RUN (Iniciativa $init) ==="
            echo "ONTEM (Yesterday):"
            echo "$yesterday"
            echo "------------------"
            echo "HOJE (Today):"
            echo "$today"
            echo
            continue
        fi

        if is_submitted "$init"; then
            echo "Check-in para iniciativa $init ja preenchido hoje. Pulando."
            continue
        fi

        cmd_submit --yesterday "$yesterday" --today "$today" --initiative "$init"
        notify "✅ Check-in enviado — iniciativa $init ($(date +%F))

Ontem:
$yesterday

Hoje:
$today"
    done

    NOTIFY_ON_ERR=false
}

cmd_submit() {
    local yesterday="" today="" confidence=5 blockers="Nenhum" artifact="" initiative=6 date=""
    date="$(date +%F)"

    while [ $# -gt 0 ]; do
        case "$1" in
            --yesterday)  yesterday="$2";  shift 2 ;;
            --today)      today="$2";      shift 2 ;;
            --confidence) confidence="$2"; shift 2 ;;
            --blockers)   blockers="$2";   shift 2 ;;
            --artifact)   artifact="$2";   shift 2 ;;
            --initiative) initiative="$2"; shift 2 ;;
            --date)       date="$2";       shift 2 ;;
            *) echo "ERRO: opcao desconhecida: $1" >&2; exit 1 ;;
        esac
    done
    [ -n "$yesterday" ] && [ -n "$today" ] || { echo "ERRO: --yesterday e --today sao obrigatorios" >&2; exit 1; }

    refresh_session > /dev/null
    local token; token="$(xsrf_token)"
    [ -n "$token" ] || { echo "ERRO: nao consegui obter XSRF-TOKEN (sessao expirada? renove o cookie remember_web)" >&2; exit 1; }

    local payload
    payload="$(python3 - "$initiative" "$date" "$yesterday" "$artifact" "$today" "$confidence" "$blockers" <<'PY'
import json, sys
a = sys.argv
blockers_text = a[7]
if blockers_text.strip().lower() == "nenhum":
    blockers_text = ""
print(json.dumps({
    "initiative_id": int(a[1]),
    "checkin_date": a[2],
    "yesterday_text": a[3],
    "yesterday_artifact_url": a[4],
    "today_text": a[5],
    "confidence_score": int(a[6]),
    "blockers_text": blockers_text,
}))
PY
)"

    local http_code
    http_code="$(curl -s -o /dev/null -w '%{http_code}' \
        -b "$JAR" -c "$JAR" \
        -H "content-type: application/json" \
        -H "accept: text/html, application/xhtml+xml" \
        -H "origin: $BASE_URL" \
        -H "referer: $ENDPOINT" \
        -H "user-agent: $UA" \
        -H "x-inertia: true" \
        -H "x-inertia-version: 1" \
        -H "x-requested-with: XMLHttpRequest" \
        -H "x-xsrf-token: $token" \
        --data-raw "$payload" \
        "$ENDPOINT")"

    # Inertia responde 302 (redirect de volta) tanto no sucesso quanto na
    # validacao reprovada — os erros ficam na sessao, nao no status. Se o form
    # do Lab ganhar um campo obrigatorio novo, o 302 sozinho seria um sucesso
    # falso: quem prova que gravou e o card preenchido.
    if [ "$http_code" = "302" ] || [ "$http_code" = "303" ] || [ "$http_code" = "200" ]; then
        # (a pagina so devolve os cards de hoje; com --date no passado nao da para conferir)
        local detail=""
        if [ "$date" = "$(date +%F)" ]; then
            # ponytail: falha em reler a pagina (rede/sessao) nao vira erro de envio — o
            # POST pode ter gravado; nesse caso confia no status, como antes.
            detail="$(submit_failure "$initiative" "$payload" || true)"
        fi
        if [ -n "$detail" ]; then
            echo "ERRO: iniciativa $initiative — $detail." >&2
            echo "      Preencha o check-in de hoje manualmente e avise o admin." >&2
            exit 1
        fi
        echo "Check-in enviado (HTTP $http_code) — iniciativa $initiative, data $date"
        cmd_status
    else
        echo "ERRO: POST retornou HTTP $http_code" >&2
        exit 1
    fi
}

case "${1:-}" in
    status)  shift; require_jar; cmd_status "$@" ;;
    submit)  shift; require_jar; cmd_submit "$@" ;;
    auto)    shift; require_jar; cmd_auto "$@" ;;
    pular)   shift; cmd_pular "$@" ;;
    retomar) shift; cmd_retomar "$@" ;;
    pulos)   shift; cmd_pulos "$@" ;;
    repos)   shift; cmd_repos "$@" ;;
    *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 1 ;;
esac
