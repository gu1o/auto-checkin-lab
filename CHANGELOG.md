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

## 2026-08-26 — `[worker]` `[cli]`

**O `/pular` ganhou calendário — como Mini App.** "Outra data" abria um
`ForceReply` pedindo a data digitada. Agora a mensagem do `/pular` traz um botão
`web_app` que abre uma **página nossa** (rota `/picker` do Worker) com o
[Air Datepicker](https://air-datepicker.com) (MIT) em `multipleDates`: seleção
real, célula desabilitada de verdade, mês em pt-BR e as cores do tema do
Telegram. Nada disso um `inline_keyboard` entrega — a primeira versão do dia,
desenhada com botões (`✓26`, dia bloqueado em subscrito, `✔ Confirmar (N)`),
foi substituída por esta.

A ideia veio do [TGDates](https://github.com/harshil21/TGDates), mas **não a
dependência**: o endpoint público dele morreu junto com os `*.repl.co`, o código
é GPL-3.0 (contaminaria o Worker) e o `host.py`+webpack não serve para nada aqui
— o Worker já serve HTTP (`/setup`, `/notify`, `/devlink`).

**Entrada e retorno.** Botão inline `web_app`, não `KeyboardButton`: mantém o
fluxo na própria mensagem em vez de trocar o teclado da pessoa. Em troca não há
`sendData()` (só existe em `KeyboardButton`), então o retorno é um **POST na
própria rota**, autenticado pelo `initData` — HMAC-SHA256 do bot token, receita
da doc, ~20 linhas de WebCrypto — que é também de onde sai o `chat_id`. Sem essa
validação a rota seria um `/pular` aberto para qualquer um.

O calendário **já abre marcando o que está agendado**; desmarcar um dia agendado
o retoma. A seleção é o estado final: `writeSkips` uma vez e relato do diff, em
vez de encadear `doPular` + `doRetomar`. Passado e fim de semana ficam
`disabled` (`minDate` + `onRenderCell`), e o `minDate` vem do **servidor** (fuso
de São Paulo), não do relógio do aparelho. As datas voltam como `YYYY-MM-DD`
montado das partes locais — `Date.toISOString()` converteria para UTC e em fuso
positivo devolveria o dia anterior (é o bug que o TGDates tem).

**O `/retomar` abriu o mesmo calendário.** `/retomar` sem data listava os
agendados e mandava você digitar; agora traz o mesmo botão, com `?m=retomar`:
só os dias agendados são clicáveis, e cada toque é um dia que volta a rodar.

**Cada modo anda para um lado só.** O `/pular` soma, o `/retomar` subtrai — a
primeira versão fazia as duas coisas no mesmo calendário (desmarcar um agendado
o retomava) e não dava para saber se desmarcar era "não quero mais pular" ou
"nunca quis". Os dois abrem sem nada marcado; no `/pular` o agendado aparece
mas vem `disabled` (informa, não se mexe).

**Legenda e duas cores.** O calendário e a legenda ficam no mesmo cartão.
Laranja é o que já está agendado, a cor do botão do tema é o que está sendo
escolhido agora — vale nos dois modos, com a legenda trocando os rótulos
(`Já agendado` / `Escolhido agora` no `/pular`, `Agendado` / `Volta a rodar` no
`/retomar`). Duas regras de CSS sobre o `-selected-` que a própria lib liga e
desliga, então não dependem de re-render; a classe `agendado` sai do
`onRenderCell` a partir do conjunto que veio do servidor.

Air Datepicker vem do **jsdelivr** (49KB+20KB), não vendorizado. Custo conhecido:
Mini App exige cliente oficial recente e o CDN precisa estar de pé — nos dois
casos a saída é `DD/MM` digitado (ou o período `DD/MM-DD/MM`), que continua
valendo e é o que os testes cobrem.

O `telegram_poller.py` (alternativa local, desativada enquanto o webhook está
ativo) fica com o calendário de botões do `inline_calendar.py`: sem servir HTTP
não há Mini App para abrir.

Admin: `wrangler deploy`. Checagem: `node worker/test_pular.mjs` e
`python3 inline_calendar.py`.

## 2026-08-17 — `[rotina]`

**A rotina parou de pedir aprovação para rodar os próprios passos.** O sandbox
do claude.ai exige aprovação humana para todo comando em que o `&` possa ser
operador de background — e isso inclui o `&` de query string quando alguma aspa
não fecha. Como a rotina roda sozinha, cada comando desses ficava ~1 min preso
e morria com `unexpected EOF`. Não é ajuste de `allowed_tools`: a checagem roda
por análise do comando, `Bash` liberado não a dispensa. O roteiro agora traz uma
**regra de shell** — sem `&` de background, uma chamada Bash por repositório
(nada de loop `for` multi-linha), URL sempre entre aspas simples — e a execução
tem que relatar se algum comando ficou preso em aprovação.

Na mesma linha: o envio passou a usar `--data @arquivo` em vez de
`--data-raw "@arquivo"`, que mandava o literal `@arquivo` como corpo e fazia o
Lab reprovar **todos** os campos como obrigatórios. Junto veio a exceção no
passo de confirmação: payload inteiro reprovado por "obrigatório" é falha de
transmissão, não campo novo do formulário — conserta e reenvia uma vez, em vez
de desistir e mandar ❌.

Quem usa rotina: atualize (`/setup-checkin` ou "atualize minha rotina"). Cron
local e extensão não são afetados — não há camada de permissão no caminho deles.

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
