# Plano: compartilhar a automação de check-in com o time

> **Status: implementado (2026-07-16) — Fases 1, 1B, 2, 3, 4 e 5.**
> Worker multi-usuário com `/start` + aprovação + KV em deploy; `/config` +
> formulário one-time-link com AES-GCM; `/pular` no `checkin.sh`; extensão
> como hub (Telegram, iniciativa padrão, exportar config.json), motor
> plugável Gemini/Claude e modo automático via `chrome.alarms`.
> Pendentes (conforme demanda): Fase 1C (deep linking) e Fase 6 (runner
> centralizado no worker).
> Contexto: hoje a automação completa (CLI + rotinas cloud + bot do Telegram
> com `/pular` via Cloudflare Worker) atende **um** dev. O objetivo é abrir
> para ~5 devs, cada um configurando as próprias credenciais (Jira, Bitbucket,
> Lab) e reaproveitando o que já está em deploy. O onboarding acontece **pelo
> próprio bot**: o dev acha o @CheckInLabBot, manda `/start` e configura tudo
> a partir dali.

## O que já existe (e já é multi-dev por natureza)

| Peça | Estado | Por dev ou compartilhada? |
|---|---|---|
| `checkin.sh` + `auto_activity.py` (CLI/cron) | pronto | por dev (`config.json` + `cookies.txt` próprios) |
| Extensão Chrome (auditoria/envio manual) | pronta | por dev (config no storage do navegador) |
| Rotina cloud Claude Code (preenche 10h + lembrete 14h) | pronta (1 usuário) | por dev — cada um cria a sua na própria conta claude.ai |
| Bot Telegram @CheckInLabBot (worker `worker/worker.js`) | em deploy (`lab-checkin-bot.<subdominio>.workers.dev`) | **compartilhável com a Fase 1 abaixo** |
| Notificações Telegram (`notify()` no `checkin.sh`) | pronta | por dev (mesmo bot token, `chat_id` próprio) |

Dois insights que tornam o compartilhamento barato:

1. **O estado dos skips é a mensagem fixada do chat privado de cada dev com o
   bot** (`SKIP: YYYY-MM-DD, ...`). Cada pessoa conversando com o mesmo bot tem
   o próprio chat → o próprio estado. O isolamento por usuário já vem de graça.
2. **Bots do Telegram são públicos e o update já traz o `chat.id` de quem
   mandou.** Ninguém precisa descobrir/colar o próprio chat_id: no primeiro
   `/start` o worker já sabe quem é. O onboarding pode ser 100% self-service.

O que falta é o worker aceitar mais de um chat e ter onde guardar os
registros — entra o **Workers KV**.

---

## Fase 1 — Worker multi-usuário com auto-registro (`/start` + KV)

Hoje o worker atende um único `CHAT_ID` fixo no `wrangler.toml` e ignora
qualquer outro remetente. Em vez da allowlist estática (que exigiria editar
var + redeploy a cada dev), o registro passa a ser dinâmico:

1. **KV namespace** (`USERS`) vinculado ao worker. Chave `user:<chat_id>` →
   JSON `{ name, username, status: "pending" | "active", prefs: {...} }`.
2. **`/start`** (qualquer remetente): salva o registro como `pending` e
   responde "cadastro recebido, aguardando aprovação". Se já registrado,
   mostra a ajuda.
3. **Aprovação pelo admin**: ao receber um `/start` novo, o worker manda para
   o `ADMIN_CHAT_ID` (var; hoje `140674932`) uma mensagem "Fulano (@user) quer
   se registrar" com botões inline **Aprovar/Recusar** — mesma mecânica de
   `callback_query` já usada no `/pular`. Aprovado → `status: "active"`.
   Zero redeploy para adicionar gente.
4. **Comandos restritos a `active`**: `/pular`, `/retomar`, `/pulos` e o
   restante só funcionam para usuários aprovados. `pending`/desconhecidos
   recebem orientação de mandar `/start` ou aguardar aprovação.
5. **Todas as respostas no `chat.id` da mensagem recebida** (hoje respondem no
   `env.CHAT_ID` fixo). O mesmo vale para `getChat`/pin dos skips: sempre no
   chat de origem. Os skips continuam na mensagem fixada — nada muda nesse
   mecanismo, ele já é por chat.
6. **Preferências não-sensíveis pelo chat**: após aprovado, o bot pergunta em
   sequência (iniciativa padrão, notificações on/off, horário) via
   `ForceReply` + `reply_to_message` — mesmo truque do "Outra data" no
   `/pular`. A pergunta pendente fica em `prefs._pending` no KV. Respostas
   ficam em `prefs`.

Onboarding no bot vira: dev manda `/start` → admin toca "Aprovar" → bot guia
as preferências → pronto.

## Fase 1B — Segredos via formulário one-time-link (nunca pelo chat)

Credenciais (cookie `remember_web` do Lab, tokens Jira/Bitbucket, API key de
LLM) **não passam pelo chat do Telegram**: transitariam pelos servidores do
Telegram e ficariam no histórico. O padrão recomendado é o próprio worker
servir um formulário:

1. Comando **`/config`** (ou passo final do onboarding): o worker gera um
   código aleatório de uso único, salva `setup:<codigo>` → `chat_id` no KV com
   **TTL de 10 minutos**, e responde com o link
   `https://lab-checkin-bot.<sub>.workers.dev/setup?t=<codigo>`.
2. **`GET /setup`**: valida o código e serve um form HTML simples (campos do
   `config.json.example`: Jira, Bitbucket, LLM, cookie do Lab). Código
   inválido/expirado → 403 com instrução de pedir `/config` de novo.
3. **`POST /setup`**: o envio vai direto por HTTPS ao worker (nada pelo
   Telegram). O worker **criptografa cada credencial com AES-GCM (WebCrypto)**
   usando uma chave em worker secret (`wrangler secret put KV_ENC_KEY`) e
   salva em `secrets:<chat_id>` no KV. Consome o código (delete) e confirma no
   chat: "✅ credenciais configuradas".
4. Atualização = mandar `/config` de novo (novo link, sobrescreve).

Com a criptografia em repouso, nem o dashboard do Cloudflare expõe os tokens;
só o worker em execução decripta. O limite honesto: quem controla a conta
Cloudflare consegue tudo — centralizar segredos de ~5 devs concentra risco
(um comprometimento vaza todos, vs. um por dev no modelo local). É uma troca
consciente por onboarding self-service; os trilhos locais (Fases 3 e 5)
continuam existindo para quem preferir manter credenciais só na própria
máquina — **o Telegram é opcional**, e sem segredos no KV o bot segue útil
para `/pular` + notificações.

## Fase 1C (futuro) — Deep linking com a extensão

O Telegram suporta `https://t.me/CheckInLabBot?start=CODIGO` (o `/start`
chega com o payload). A extensão (Fase 3) pode mostrar um botão "Conectar
Telegram" que gera um código curto; o usuário clica, cai no chat, e o worker
vincula o chat_id àquela config automaticamente — sem digitar nada e sem
aprovação manual (o código prova que a pessoa veio da extensão). Evolução
natural depois do auto-registro básico funcionar.

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
ponto único de configuração para quem prefere o trilho local:

1. Campos novos na aba Configurações: **chat_id do Telegram** (com instrução
   "mande /start pro @CheckInLabBot — ele te responde já registrado"),
   **iniciativa padrão**, e o token do bot (pré-preenchível/compartilhado
   internamente).
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

O trilho mais promissor para quem não quer centralizar credenciais: automação
total **sem cookie manual e sem cron**, usando a sessão viva do navegador
(elimina o problema nº 1, o `remember_web` expirado).

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

## Fase 6 (opcional, decidir depois) — Check-in centralizado no worker

Guardar segredos no KV (Fase 1B) só se paga por completo se algo os consumir.
A consequência natural: um **Cron Trigger** no próprio worker rodando o
check-in diário de todos os usuários `active` — coleta Jira/Bitbucket via
`fetch`, gera o texto (API do LLM), respeita a mensagem fixada de cada chat e
envia ao Lab com a credencial de cada um. Eliminaria a rotina cloud por dev e
o cron local. É uma expansão de escopo relevante (o worker vira o runner de
todo mundo) — fica registrado como possibilidade, não como compromisso.

## Melhoria estrutural (independente das fases): token de API pessoal no Lab

O segredo mais problemático do sistema é o cookie `remember_web`: é a sessão
inteira do usuário no Lab (não escopado), expira e só se obtém copiando do
navegador. Como o Lab é plataforma interna da Ideal Trends, o melhor
investimento de longo prazo é o Lab emitir **tokens de API pessoais**
escopados (só escrever check-in), de longa duração e revogáveis. Isso elimina
a expiração, reduz o dano de um vazamento e torna qualquer trilho (e a Fase
1B/6) muito mais tranquilo. Levado ao limite, o check-in automático poderia
rodar dentro do próprio Lab (server-side), sem credencial nenhuma a
distribuir — mas isso é outro projeto.

## Trilhos disponíveis por dev (após as fases)

| Trilho | Automação | Requisitos | Fraqueza |
|---|---|---|---|
| Extensão manual | revisa e clica | Chrome logado no Lab | manual |
| Extensão automática (Fase 5) | total | Chrome aberto no horário | Chrome fechado = não roda |
| Cron local (`checkin.sh auto`) | total | máquina ligada, cookie válido | cookie expira |
| Rotina cloud (Claude Code) | total | conta claude.ai + environment | cookie expira; setup maior |
| Worker centralizado (Fase 6) | total | segredos no KV (Fase 1B) | centraliza risco; escopo maior |

Todos os trilhos compartilham: o mesmo bot (`/pular`/notificações), a mesma
mensagem fixada como estado, e a mesma config (via extensão + export, ou via
`/config` no bot).

## Onboarding de um dev novo (resumo)

1. **Telegram (self-service)**: procurar @CheckInLabBot → `/start` → admin
   aprova pelo botão → bot guia as preferências → (opcional) `/config` para
   preencher credenciais no formulário one-time-link. `/pular`, `/retomar`,
   `/pulos` e notificações já funcionam.
2. **Trilho local (alternativa sem segredos no KV)**: clonar o repo; instalar
   a extensão (`chrome://extensions` → Load unpacked); configurar tokens
   Jira/Bitbucket, key do LLM e iniciativa na extensão; preencher o chat_id
   (o bot informa no `/start`).
3. Escolher o trilho de automação (tabela acima). Para CLI/cron: "Exportar
   config.json" + `cookies.txt` próprio + crontab. Para rotina cloud: copiar o
   template de prompt (parametrizar nome/e-mail/cookie/token/chat_id/
   iniciativa) e criar a rotina + environment com egress liberado
   (`lab.idealtrends.io`, `brasilapi.com.br`, `api.bitbucket.org`,
   `api.telegram.org`).

## Considerações de segurança

- **Segredos nunca pelo chat do Telegram** — transitam pelos servidores do
  Telegram e ficam no histórico. Sempre pelo formulário one-time-link
  (Fase 1B), direto por HTTPS ao worker.
- **KV com criptografia em repouso** (AES-GCM, chave em worker secret): o
  dashboard/export do KV não expõe tokens. Quem controla a conta Cloudflare
  ainda decripta — centralizar segredos do time concentra risco; os trilhos
  locais existem justamente como alternativa.
- **Links de setup**: uso único, TTL de 10 min, código aleatório longo,
  consumido no POST.
- **Registro aberto, uso não**: qualquer pessoa no mundo pode mandar `/start`
  (bots são públicos); só usuários aprovados pelo admin usam comandos e podem
  salvar credenciais.
- **Token do bot é compartilhado** com o time (necessário para `notify()`).
  Quem tem o token controla o bot — inclusive ler/enviar como ele; a aprovação
  no worker protege contra externos, não contra colegas. Nunca commitá-lo —
  vive só em `config.json` (gitignored), nos secrets do worker e nos prompts
  das rotinas.
- **Worker/conta Cloudflare**: hoje na conta pessoal de um dev. Se o uso do
  time consolidar (especialmente com Fase 1B/6), migrar para uma conta do time
  (redeploy + `setWebhook` novo).
- **Webhook** exige o header `X-Telegram-Bot-Api-Secret-Token` correto
  (secret nos secrets do worker); requests sem ele levam 403. As rotas
  `/setup` ficam fora dessa checagem (são do usuário, não do Telegram) —
  a proteção delas é o código one-time + TTL.
- `config.json`, `cookies.txt`, `.poller_state.json` e `__pycache__/` estão no
  `.gitignore` — manter assim.

## Ordem sugerida de implementação

1. Fase 1 (auto-registro `/start` + KV + aprovação + respostas por chat de
   origem) — destrava o bot para o time sem redeploy por dev.
2. Fase 1B (formulário one-time-link + AES-GCM) — destrava credenciais
   self-service.
3. Fase 2 (`/pular` no CLI) — paridade entre trilhos.
4. Fase 3 (extensão como hub + export) — onboarding do trilho local.
5. Fase 4 (motor plugável Gemini/Claude).
6. Fase 5 (modo automático da extensão).
7. Fase 1C (deep linking) e Fase 6 (runner centralizado) — conforme demanda.
