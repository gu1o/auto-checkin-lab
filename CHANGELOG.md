# Changelog — lab-checkin

Cada versão é a data da mudança. As tags dizem **o que você precisa fazer** depois
de um `git pull`:

- `[rotina]` — mexe no roteiro do modo B: sua rotina no claude.ai está desatualizada
  até você rodar `/setup-checkin` (ou pedir ao Claude "atualize minha rotina").
- `[cli]` / `[extensão]` — o `git pull` já resolve (extensão: recarregue em `chrome://extensions`).
- `[worker]` — o admin faz `wrangler deploy`; quem usa `/runner on` não faz nada.
- `[setup]` — só afeta quem está configurando pela primeira vez.

A versão mais recente com `[rotina]` é o carimbo que vai na primeira linha do
prompt da rotina (`# lab-checkin roteiro <versão>`).

---

## 2026-08-13 — `[worker]` `[cli]` `[setup]`

**E-mail virou canal de verdade, sem depender do Telegram.** O `POST /notify`
passou a aceitar `{ email, text }` direto no corpo (antes só resolvia o destino
pelo `chatId` no KV — inútil justamente para quem não tem Telegram) e entrega
por Resend. O domínio do destinatário é conferido contra `NOTIFY_EMAIL_DOMAINS`
e recusado se não estiver na lista: o `NOTIFY_SECRET` é compartilhado no time e
sem essa trava viraria relay aberto na conta Resend. Falha de entrega agora
responde 502 — com 200 `{ok:false}` o `curl -sf` do `checkin.sh` lia sucesso e
nunca caía no fallback do Telegram.

No `config.json`: campo novo `notify.email`. Com `notify.url` + `notify.secret`
+ `notify.email`, o cron local também notifica por e-mail. **Admin**: setar
`RESEND_API_KEY`, `NOTIFY_EMAIL_FROM` (domínio verificado na Resend) e
`NOTIFY_EMAIL_DOMAINS`, e `wrangler deploy`.

Motivo: com a migração do Google Workspace para a Microsoft, o conector Gmail
não alcança a maioria das caixas do time — o worker alcança qualquer domínio.

## 2026-08-13 — `[setup]`

**Notificação deixou de ser "Telegram ou nada".** O setup agora pergunta o canal
(Telegram / e-mail pelo conector Gmail / nenhum) em vez de funilar para o bot, e
o bloco `Notificar` do prompt da rotina passou a existir sempre, com uma das três
variantes. Quem escolher "nenhum" liga depois rodando `/setup-checkin` e pedindo
notificação: só esse bloco é reescrito — credenciais, iniciativas e estilo ficam
como estão. Rotina existente não precisa de nada.

## 2026-08-12 — `[rotina]` `[cli]` `[extensão]` `[worker]`

**Envio confirmado, e o campo novo denunciado.** O Lab responde HTTP 302 tanto no
sucesso quanto na validação reprovada, então o status sozinho vinha sendo lido como
✅ mesmo quando nada era gravado. Agora todo envio relê a página e só considera
enviado se o card da iniciativa voltar com `existing`; se não voltar, o erro cita os
campos reprovados (lidos de `props.errors` do Inertia) e destaca os que não estão no
payload — que é como um campo novo do formulário do Lab aparece. Nenhum caminho
tenta adivinhar valor para campo novo: sem saber o tipo, chute vira dado errado na
métrica.

**Commit conta pelo e-mail, não só pelo username.** O `user.name` do git diverge do
display name da conta Atlassian (ex.: `Guio` × `Guilherme Ribeiro`), e filtrar só
pelo username descartava commits em silêncio. Agora casa por
`bitbucket.author_emails` (vazio = e-mail do Jira) **ou** username.

Na rotina: o bloco `Confirmar` é novo e o critério de autoria mudou — atualize.

## 2026-08-12 — `[setup]`

Abrir o Claude Code na pasta do repo sem `config.json` agora pergunta qual modo
você quer (extensão / rotina na nuvem / cron local / agora não) e conduz o setup.
"Agora não" grava `.claude/.setup-declined` e não pergunta de novo.
