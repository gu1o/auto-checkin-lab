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

set -euo pipefail

BASE_URL="https://lab.idealtrends.io"
ENDPOINT="$BASE_URL/saude-entrega/daily"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR="$DIR/cookies.txt"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"

[ -f "$JAR" ] || { echo "ERRO: $JAR nao existe (cookie remember_web necessario)" >&2; exit 1; }

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
print(json.dumps({
    "initiative_id": int(a[1]),
    "checkin_date": a[2],
    "yesterday_text": a[3],
    "yesterday_artifact_url": a[4],
    "today_text": a[5],
    "confidence_score": int(a[6]),
    "blockers_text": a[7],
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

    # Inertia responde o POST com 302 (redirect de volta) em caso de sucesso
    if [ "$http_code" = "302" ] || [ "$http_code" = "303" ] || [ "$http_code" = "200" ]; then
        echo "Check-in enviado (HTTP $http_code) — iniciativa $initiative, data $date"
        cmd_status
    else
        echo "ERRO: POST retornou HTTP $http_code" >&2
        exit 1
    fi
}

case "${1:-}" in
    status) shift; cmd_status "$@" ;;
    submit) shift; cmd_submit "$@" ;;
    *) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 1 ;;
esac
