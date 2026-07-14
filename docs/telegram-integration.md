# Proposta: Integração Telegram (notificação + controle remoto)

> **Status: Funcionalidade 1 (notificação) implementada no `checkin.sh` e nas
> rotinas cloud; da Funcionalidade 2, o comando `/pular` foi implementado nas
> rotinas cloud via modo piggyback (2026-07-14) — o restante (poller local,
> `/horario`, `schedule` no config) segue proposta.**
> Este documento especifica duas funcionalidades debatidas pelo time para serem
> aplicadas sobre o `checkin.sh` e a cron que o agenda.
>
> **`/pular` interativo (implementado — webhook na Cloudflare):** o bot roda
> como **Cloudflare Worker** (`worker/worker.js`, deploy
> `https://lab-checkin-bot.gu1o.workers.dev`) recebendo updates via
> `setWebhook` — sempre no ar, sem depender do WSL. Comandos: `/pular`
> pergunta a data (botões Hoje/Amanhã/Outra data ou texto DD/MM via
> ForceReply), `/retomar` desfaz, `/pulos` lista. O skip confirmado vira uma
> **mensagem fixada** no chat (`SKIP: YYYY-MM-DD, ...`) — não expira, agenda
> com qualquer antecedência; o worker é stateless (todo estado vive no
> Telegram). As rotinas cloud (preenchimento 10h e lembrete 14h) leem a
> mensagem fixada via `getChat`; se hoje está na lista, a 10h não preenche
> (confirma com 🚫) e a 14h silencia. Segurança: header
> `X-Telegram-Bot-Api-Secret-Token` validado contra o secret `WEBHOOK_SECRET`
> (cópia em `config.json` → `telegram.webhook_secret`); requests sem ele
> recebem 403. Deploy: `cd worker && npx wrangler deploy` (secrets
> `BOT_TOKEN`/`WEBHOOK_SECRET` via `wrangler secret put`); logs:
> `npx wrangler tail`. **Nota:** com webhook ativo o `getUpdates` fica
> bloqueado pelo Telegram — o poller local `telegram_poller.py`
> (`lab-checkin-bot.service`, hoje desativado) é o plano B caso se queira
> abandonar a Cloudflare: `deleteWebhook` + `systemctl --user enable --now
> lab-checkin-bot`. O fallback getUpdates das rotinas cloud tornou-se inerte
> (recebe 409 e é ignorado), inofensivo.

---

## Funcionalidade 1 — Notificação no Telegram após o check-in

Quando a cron rodar `checkin.sh auto`, o resultado (sucesso, pulo ou erro) é
enviado para um chat do Telegram via bot.

### Por que é simples

O `cmd_auto` já imprime uma linha clara em todos os desfechos e retorna exit
code correto (`set -euo pipefail`):

| Desfecho | Saída | Exit code |
|---|---|---|
| Enviado | `Check-in enviado (HTTP 302) — iniciativa 6, data ...` | 0 |
| Já preenchido | `Check-in para iniciativa 6 ja preenchido hoje. Pulando.` | 0 |
| Fim de semana / feriado | `Hoje e fim de semana/feriado. Pulando check-in.` | 0 |
| Falha (sessão expirada, HTTP != 302, etc.) | `ERRO: ...` no stderr | 1 |

Basta capturar output + exit code e repassar pro Telegram.

### Setup do bot (uma vez só)

1. No Telegram, falar com **@BotFather** → `/newbot` → guardar o **token**.
2. Mandar qualquer mensagem pro bot criado e obter o `chat_id` em
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   (para notificar o time inteiro, adicionar o bot a um grupo e usar o
   `chat_id` do grupo, que é negativo).
3. Enviar mensagem não tem dependência nenhuma — mesmo `curl` já usado no script:

   ```bash
   curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
       -d chat_id="${CHAT_ID}" \
       --data-urlencode text="✅ Check-in enviado"
   ```

### Configuração

Novo bloco no `config.json` (e no `config.json.example`):

```json
"telegram": {
  "bot_token": "",
  "chat_id": ""
}
```

### Implementação no `checkin.sh`

- Nova função `notify(emoji, texto)` que lê `telegram.bot_token`/`chat_id` do
  `config.json`. **Se não estiver configurado, retorna em silêncio** — assim
  o script continua funcionando para quem não usa Telegram (não quebra o
  fluxo dos outros devs nem da extensão).
- `cmd_auto` chama `notify` no fim de cada desfecho:
  - ✅ enviado (incluir resumo do "ontem/hoje" gerado)
  - ℹ️ pulado (já preenchido / fim de semana / feriado) — opcional, pode ser
    silencioso para não gerar ruído diário
  - ❌ erro (capturar via `trap ERR` ou wrapper, incluindo o caso clássico de
    **cookie `remember_web` expirado** — esse é o alerta mais valioso, porque
    hoje a automação falharia calada)

---

## Funcionalidade 2 — Alterar o horário da cron remotamente (bot e extensão)

### Viabilidade

| Canal | Dá para alterar o horário? | Como |
|---|---|---|
| **Bot do Telegram** | ✅ Sim | Um poller local processa comandos do chat e ajusta o agendamento |
| **Extensão do Chrome** | ❌ Não diretamente | Extensão roda na sandbox do navegador, sem acesso a arquivos/shell do WSL. Só seria possível via *native messaging host* (um binário local registrado no Chrome) — complexidade alta pro ganho. Recomendação: extensão continua com o papel de auditoria/envio manual; agendamento fica com o bot. |

### Arquitetura recomendada: cron "tick" + horário em config

Em vez de o bot reescrever a crontab (frágil, e a linha da cron vira estado
fora do versionamento), a crontab fica **fixa** e o horário desejado vira
**configuração**:

```
# Crontab fixa: tick a cada 15 min em horário comercial, seg-sex
*/15 8-18 * * 1-5  /home/guilherme/scripts/lab-checkin/checkin.sh auto >> /home/guilherme/scripts/lab-checkin/auto.log 2>&1
```

```json
"schedule": {
  "time": "09:30",
  "enabled": true
}
```

O `cmd_auto` ganha uma checagem no início: só prossegue se
`agora >= schedule.time` e `schedule.enabled == true` (as guardas existentes —
fim de semana, feriado, já-preenchido — continuam valendo e tornam o tick
idempotente: rodar 40x por dia não reenvia nada).

**Bônus dessa arquitetura:** resolve o problema do WSL2. Se a máquina estiver
desligada às 09:30, o próximo tick após o boot envia o check-in mesmo assim —
com crontab de horário fixo o dia seria simplesmente perdido.

### O poller do bot

Script `telegram_poller.py` (ou bash) que faz long-polling em
`getUpdates` e processa comandos. Duas formas de rodar:

1. **Serviço persistente** — systemd user service no WSL (WSL2 atual suporta
   systemd) fazendo long-poll contínuo. Resposta imediata aos comandos.
2. **Piggyback no tick da cron** — a cada tick, drenar os updates pendentes
   (`getUpdates` com `offset`) antes de decidir se envia. Zero processo extra,
   com latência de até 15 min nos comandos.

Comandos propostos:

| Comando | Ação |
|---|---|
| `/status` | Roda `checkin.sh status` e responde com o resultado |
| `/horario HH:MM` | Atualiza `schedule.time` no `config.json` |
| `/pausar` / `/retomar` | Alterna `schedule.enabled` |
| `/agora` | Força `checkin.sh auto` imediatamente (ignora `schedule.time`) |
| `/dryrun` | Roda `checkin.sh auto --dry-run` e responde com o rascunho gerado |

**Segurança:** o poller deve ignorar qualquer update cujo `chat_id`/`from.id`
não esteja numa allowlist no `config.json` — token de bot é público o
suficiente (qualquer um que descobrir o @username pode mandar mensagem).

### E a extensão?

Se no futuro valer a pena dar esse poder à extensão sem native messaging, o
caminho é ela **não** falar com a máquina local: mover o "estado de
agendamento" para algo que os dois lados alcançam. Opções em ordem de esforço:

1. Não fazer — bot cobre o caso (recomendado por ora).
2. A extensão ganha uma aba "Agendamento" que apenas **exibe** o horário/estado
   atual, lendo de um gist/endpoint compartilhado que o poller mantém.
3. Native messaging host (Chrome ↔ binário local) — só se houver demanda real.

---

## Nota: se a automação roda como rotina cloud (claude.ai), não como crontab local

Parte do time roda o `auto` por crontab local; o Guilherme roda por uma
**rotina agendada no claude.ai** (Claude Code cloud). Nesse cenário:

- **Notificação (Func. 1):** ainda mais simples — a própria rotina executa o
  `curl` do `sendMessage` como último passo do prompt, com o resultado do POST.
  Único pré-requisito: adicionar `api.telegram.org` ao allowlist de egress do
  environment da rotina (config só pela UI do claude.ai, no ícone do
  environment → engrenagem).
- **Alterar horário (Func. 2):** a rotina cloud não lê o `config.json` local,
  então o padrão tick+config não se aplica. O horário é o cron da própria
  rotina, alterável em segundos pedindo ao Claude Code (`/schedule`) ou pela
  UI em claude.ai/code/routines. Um bot do Telegram **não** consegue alterar
  a rotina cloud diretamente (não há API pública para isso) — o comando
  `/horario` do poller só faz sentido para quem usa crontab local.

---

## Ordem de aplicação sugerida

1. `telegram` no `config.json.example` + `notify()` no `checkin.sh` (Func. 1).
2. Crontab tick + bloco `schedule` + checagem de horário no `cmd_auto`.
3. Poller com comandos do bot (Func. 2), começando pelo modo piggyback.
4. (Opcional) systemd service para resposta imediata.
