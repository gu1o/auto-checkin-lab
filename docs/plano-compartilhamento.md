# Plano: compartilhar a automação de check-in com o time

> **Status: planejado — nada deste documento foi implementado ainda.**
> Contexto: hoje a automação completa (CLI + rotinas cloud + bot do Telegram
> com `/pular` via Cloudflare Worker) atende **um** dev. O objetivo é abrir
> para ~5 devs, cada um configurando as próprias credenciais (Jira, Bitbucket,
> Lab) e reaproveitando o que já está em deploy.

## O que já existe (e já é multi-dev por natureza)

| Peça | Estado | Por dev ou compartilhada? |
|---|---|---|
| `checkin.sh` + `auto_activity.py` (CLI/cron) | pronto | por dev (`config.json` + `cookies.txt` próprios) |
| Extensão Chrome (auditoria/envio manual) | pronta | por dev (config no storage do navegador) |
| Rotina cloud Claude Code (preenche 10h + lembrete 14h) | pronta (1 usuário) | por dev — cada um cria a sua na própria conta claude.ai |
| Bot Telegram @CheckInLabBot (worker `worker/worker.js`) | em deploy (`lab-checkin-bot.<subdominio>.workers.dev`) | **compartilhável com a Fase 1 abaixo** |
| Notificações Telegram (`notify()` no `checkin.sh`) | pronta | por dev (mesmo bot token, `chat_id` próprio) |

O insight que torna o compartilhamento barato: **o estado do bot é a mensagem
fixada do chat privado de cada dev com o bot** (`SKIP: YYYY-MM-DD, ...`).
Cada pessoa conversando com o mesmo bot tem o próprio chat → o próprio estado.
O isolamento por usuário já vem de graça; falta só o worker aceitar mais de um
chat.

---

## Fase 1 — Worker multi-usuário

Hoje o worker atende um único `CHAT_ID`. Mudanças em `worker/worker.js`:

1. `CHAT_ID` (var) → `CHAT_IDS` (allowlist, ex.: `"140674932,111111,222222"`).
2. Todas as respostas passam a usar o `chat.id` **da mensagem recebida** (hoje
   respondem no `env.CHAT_ID` fixo). O mesmo vale para `getChat`/pin: sempre
   no chat de origem.
3. Novo comando **`/meuid`**, aberto a QUALQUER remetente (fora da allowlist
   inclusive): responde o `chat_id` de quem mandou. Resolve o onboarding — com
   o webhook ativo, o truque antigo de ler o `getUpdates` não funciona mais.
   Todos os demais comandos continuam restritos à allowlist.
4. Redeploy: `cd worker && npx wrangler deploy` (a allowlist é var no
   `wrangler.toml`, então adicionar um dev = editar a lista + redeploy).

Onboarding de um dev no bot: ele manda `/meuid` → admin adiciona o id em
`CHAT_IDS` → redeploy → pronto (`/pular`, `/retomar`, `/pulos` funcionam no
chat dele).

## Fase 2 — `/pular` no CLI local (`checkin.sh`)

Hoje só as rotinas cloud respeitam a mensagem fixada. Adicionar ao `cmd_auto`
(logo após as guardas de fim de semana/feriado):

- Ler `telegram.bot_token`/`chat_id` do `config.json`; se ausentes, pular a
  checagem (mesmo contrato do `notify()`).
- `curl getChat` → se `result.pinned_message.text` contiver `SKIP:` e a data
  de hoje (`YYYY-MM-DD`) estiver na lista → não preencher, informar no stdout
  e via `notify()` (🚫).
- Falha na chamada não bloqueia o check-in (mesma filosofia das rotinas).

Com isso, quem roda por cron local ganha o mesmo `/pular` de quem usa rotina
cloud.

## Fase 3 — Extensão como hub de configuração

A extensão já guarda Jira/Bitbucket/Gemini no storage do navegador. Virar o
ponto único de configuração do time:

1. Campos novos na aba Configurações: **chat_id do Telegram** (com instrução
   "mande /meuid pro @CheckInLabBot"), **iniciativa padrão**, e o token do bot
   (pré-preenchível/compartilhado internamente).
2. Botão **"Exportar config.json"**: gera e baixa o arquivo no formato do
   `config.json.example`, preenchido com o que está no storage. É a ponte para
   quem também roda CLI/cron — configura uma vez na UI, exporta, coloca na
   pasta do repo. (Extensão não escreve arquivo direto — sandbox; download é o
   caminho.)

## Fase 4 — Escolha do motor de geração (Gemini ou Claude)

A extensão chama o Gemini para sintetizar os textos. Tornar o gerador
plugável:

1. Abstrair a chamada de LLM numa função única (`generateDraft(provider,
   apiKey, contexto)`).
2. Providers:
   - **Gemini** (atual) — tem free tier, segue como default.
   - **Claude (API Anthropic)** — Messages API direto do browser exige o
     header de opt-in `anthropic-dangerous-direct-browser-access: true`; cada
     dev usa a própria API key (paga). Modelo sugerido: o Sonnet mais recente.
3. Seletor na aba Configurações + validação da key.

**Distinção importante para a UI/docs:** o que a extensão pluga é a *API* do
Claude (uma chamada de geração de texto). O **Claude Code** — o agente que
coleta atividade, cruza fontes e envia sozinho — é outro trilho (rotina cloud
ou CLI), não roda dentro de extensão.

## Fase 5 — Modo automático da extensão (`chrome.alarms`)

O trilho mais promissor para a maioria: automação total **sem cookie manual e
sem cron**, usando a sessão viva do navegador (elimina o problema nº 1, o
`remember_web` expirado).

1. Alarme diário (`chrome.alarms`) no horário configurado; roda no service
   worker (MV3), não precisa de aba do Lab aberta — só o Chrome rodando e o
   login válido (cookies acessíveis via `host_permissions`).
2. Fluxo do alarme = mesmas guardas do `cmd_auto`: fim de semana → feriado
   (BrasilAPI) → `/pular` (mensagem fixada) → já preenchido? → coleta
   Jira/Bitbucket → gera (provider da Fase 4) → envia → `notify()` no
   Telegram (✅/⚠️/❌; 🚫 quando pulado).
3. Se a sessão do Lab estiver deslogada no horário: notificar ❌ pedindo
   login (não há o que renovar automaticamente).
4. Toggle "Modo automático" + horário na aba Configurações.

## Trilhos disponíveis por dev (após as fases)

| Trilho | Automação | Requisitos | Fraqueza |
|---|---|---|---|
| Extensão manual | revisa e clica | Chrome logado no Lab | manual |
| Extensão automática (Fase 5) | total | Chrome aberto no horário | Chrome fechado = não roda |
| Cron local (`checkin.sh auto`) | total | máquina ligada, cookie válido | cookie expira |
| Rotina cloud (Claude Code) | total | conta claude.ai + environment | cookie expira; setup maior |

Todos os trilhos compartilham: o mesmo bot (`/pular`/notificações), a mesma
mensagem fixada como estado, e a mesma config (via extensão + export).

## Onboarding de um dev novo (resumo)

1. Clonar o repo; instalar a extensão (`chrome://extensions` → Load unpacked).
2. Configurar na extensão: tokens Jira/Bitbucket, key do LLM, iniciativa.
3. Telegram: falar com @CheckInLabBot → `/meuid` → pedir inclusão na allowlist
   (Fase 1) → preencher chat_id na extensão.
4. Escolher o trilho de automação (tabela acima). Para CLI/cron: "Exportar
   config.json" + `cookies.txt` próprio + crontab. Para rotina cloud: copiar o
   template de prompt (parametrizar nome/e-mail/cookie/token/chat_id/
   iniciativa) e criar a rotina + environment com egress liberado
   (`lab.idealtrends.io`, `brasilapi.com.br`, `api.bitbucket.org`,
   `api.telegram.org`).

## Considerações de segurança

- **Token do bot é compartilhado** com o time (necessário para `notify()`).
  Quem tem o token controla o bot; a allowlist do worker protege contra
  externos, não contra colegas. Nunca commitá-lo — vive só em `config.json`
  (gitignored), nos secrets do worker e nos prompts das rotinas.
- **Worker/conta Cloudflare**: hoje na conta pessoal de um dev. Se o uso do
  time consolidar, migrar para uma conta do time (redeploy + `setWebhook`
  novo).
- **Webhook** exige o header `X-Telegram-Bot-Api-Secret-Token` correto
  (secret nos secrets do worker); requests sem ele levam 403.
- `config.json`, `cookies.txt`, `.poller_state.json` e `__pycache__/` estão no
  `.gitignore` — manter assim.

## Ordem sugerida de implementação

1. Fase 1 (worker multi-usuário + `/meuid`) — destrava o bot para o time.
2. Fase 2 (`/pular` no CLI) — paridade entre trilhos.
3. Fase 3 (extensão como hub + export) — destrava o onboarding.
4. Fase 4 (motor plugável Gemini/Claude).
5. Fase 5 (modo automático da extensão).
