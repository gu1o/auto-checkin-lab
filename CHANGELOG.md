# Changelog — lab-checkin

Cada versão é a data da mudança. As tags dizem **o que você precisa fazer** depois
de um `git pull`:

- `[rotina]` — mexe no roteiro do modo B: sua rotina no claude.ai está desatualizada
  até você rodar `/setup-checkin` (ou pedir ao Claude "atualize minha rotina").
- `[cli]` / `[extensão]` — o `git pull` já resolve (extensão: recarregue em `chrome://extensions`).
- `[local]` — o `git pull` **não** basta: a mudança pede editar o seu `config.json`
  (campo novo) ou a linha do `crontab`. Rode `/setup-checkin` e ele aplica.
- `[worker]` — o admin faz `wrangler deploy`; quem usa `/runner on` não faz nada.
- `[setup]` — só afeta quem está configurando pela primeira vez.

A versão mais recente com `[rotina]` é o carimbo que vai na primeira linha do
prompt da rotina (`# lab-checkin roteiro <versão>`).

---

## 2026-09-17 — `[rotina]` `[cli]` `[worker]`

**Dia sem check-in agora é decidido uma vez, não três.** A retentativa em três
horários (2026-09-15) valia para todo mundo, inclusive para o dia que já estava
resolvido por escolha: quem pulou o dia no `/pular` do bot levava um 🚫 por
execução, e o mesmo acontecia no skip local, no feriado e no "o Lab não pediu
check-in hoje". Retentar um dia pulado não tem o que consertar — só barulho.

- **CLI: `.auto_state.json` fecha o dia em todo desfecho, não só no envio.**
  Ele passa a guardar também o motivo (`{"date", "motivo"}`) e a guarda dele
  virou a **primeira** de todas: pulado (bot ou `checkin.sh pular`), fim de
  semana, feriado e sem convocação gravam o dia como resolvido, então o 2º e o
  3º tick saem na hora — sem chamar o Telegram de novo, sem coletar nada e sem
  repetir o aviso. `checkin.sh retomar hoje` apaga o estado gravado pelo skip,
  senão o retomar não teria efeito no mesmo dia. `--force` ignora tudo isso.
- **Rotina (nuvem): 🚫 de dia pulado só na primeira execução.** Nas retentativas
  a guarda 2 para em silêncio (só o Sinal de vida). Fim de semana e feriado já
  paravam calados.
- **Worker: o watchdog parou de cobrar em dia que não tinha check-in.** A
  cobrança das 18h ("sua rotina não deu sinal de vida hoje") disparava todo
  sábado e domingo, todo feriado e nos dias pulados — justamente os dias em que
  o silêncio é o comportamento certo. Agora ela sai antes em fim de semana e
  feriado, e pula quem tem a data em `skips:<e-mail>`.

Aplicar: `git pull` resolve o CLI; `/setup-checkin` (modo atualização) reescreve
a rotina da nuvem; o admin faz `wrangler deploy` para o watchdog.

## 2026-09-15 — `[rotina]` `[local]` `[worker]`

**Envio que falha agora tem segunda chance — automática na rotina, manual no
bot.** Quando o Lab cai no horário do check-in (hoje foi a tela sem o modal de
envio), o dia ficava em branco: a rotina da nuvem roda uma vez, manda o ❌ e
morre, e `/agora` respeita fim de semana, feriado e `/pular` — no modo aprovação
ainda devolve o rascunho para confirmar de novo.

- **Rotina (nuvem): três execuções por dia em vez de uma.** O horário escolhido
  mais duas retentativas ~3h depois (09:30 → `30 9,12,16`). Em dia normal as
  duas extras param na guarda "já preenchida" antes de tocar no Jira e no
  Bitbucket — custo perto de zero e nenhuma notificação. A guarda virou por
  iniciativa: com o mapa multi-iniciativa, ela só para o dia quando **todas**
  têm card, e o envio pula as que já foram, então uma falha parcial é retentada
  sem duplicar as que passaram. Todo ❌ agora diz que haverá outra tentativa.
- **Cron local: mesma coisa, com estado.** A linha do crontab passa a ter três
  horários. Para a retentativa não custar uma coleta inteira do Jira/Bitbucket e
  uma geração de IA por tick, o `auto` grava `.auto_state.json` ao fechar o dia
  e as execuções seguintes param nele — a guarda "já preenchida" existia só
  dentro do loop, **depois** do gasto. Falha não grava estado (o `cmd_submit`
  derruba o script), então é exatamente o dia ruim que é retentado. Dia sem
  atividade também não grava: o tick da tarde pega o commit que apareceu depois.
  Isso também conserta o desperdício que já existia em quem usa o modelo tick
  (`*/15` + `schedule.time`). `./checkin.sh auto --force` ignora tudo isso.
- **"O Lab não pediu check-in hoje" deixou de ser erro.** Num dia útil o Lab
  pode devolver `props.cards` vazio com `props.semConvocacao` explicando o porquê
  (janela fechada, módulo concluído, versão encerrada). O roteiro e o `auto` não
  conheciam esse estado: caíam no "erro não previsto" e mandavam ❌. Com três
  execuções por dia isso seriam três ❌ iguais, então virou desfecho próprio —
  encerra sem erro e avisa ℹ️ com o motivo uma vez só, na última execução.
- **Bot: `/forcar`.** Roda o check-in sem nenhuma guarda de calendário e envia
  direto, sem passar pela aprovação. A guarda de "já preenchida" continua
  valendo — é ela que impede duplicata no card. A mensagem de falha cita o
  comando, para quem levou o ❌ saber o que fazer.

Aplicar: `/setup-checkin` (modo atualização) reagenda a rotina da nuvem e
reescreve a linha do crontab. O que a retentativa **não** conserta: cookie expirado e campo novo obrigatório
no formulário falham igual nas três tentativas — nesses o ❌ continua sendo
para o dev agir. Quem usa `/runner on` não muda nada: o cron do worker já
retenta a cada 15 min.

## 2026-08-27 — `[rotina]` `[worker]` `[cli]`

**Quem escolheu e-mail agora é avisado quando a rotina falha — e quando ela
nem roda.** O ❌ por e-mail já existia, mas só saía se a rotina chegasse viva
até o bloco `Notificar`. Fora daí era silêncio: execução que morre no meio
(limite de token, conector caído, comando preso em aprovação), rotina pausada
ou sem crédito, e — o pior — o próprio e-mail sendo recusado (403 de domínio,
502 sem `RESEND_API_KEY`, host do worker fora da allowlist de egress) enquanto
a execução era marcada como **sucesso** no histórico. Cego dos dois lados.

Quatro consertos, três deles no prompt da rotina:

- **Aviso que não sai derruba a execução.** Resposta do `/notify` fora do 2xx
  agora encerra a rotina com erro, em vez de só registrar o corpo no log. Se o
  dev não pode ser avisado, ao menos o histórico fica vermelho.
- **Erro não previsto tenta avisar antes de morrer.** A variante "sem canal" já
  mandava encerrar com erro; as outras não mandavam nada.
- **A guarda do `/pular` sai quando não há Telegram.** Ela lia a mensagem
  fixada via `getChat` — sem bot token, um dev só-de-e-mail tropeçava numa
  guarda antes de fazer qualquer coisa.
- **O runner do worker parou de furar o `prefs.email`.** O `runnerCron` mandava
  o ❌ com `send()` direto no Telegram, enquanto o `/notify` resolvia o canal
  pelo KV — dois lugares decidindo a mesma coisa de jeitos diferentes. Agora só
  existe um, o `deliver()`, e quem escolheu e-mail recebe por e-mail nos dois
  caminhos.
- **Watchdog no worker** (`watchdogCron`), o único que pega "a rotina não
  rodou": ela pinga `POST /notify` com `{"email": ..., "heartbeat": true}` em
  **todo** desfecho — inclusive quando para numa guarda — e o tick das 18h de
  SP cobra por e-mail quem não pingou no dia.

O heartbeat é o caminho barato: a alternativa era o worker conferir o Lab
sozinho, e para isso ele precisaria do cookie, da iniciativa e de um cadastro
de cada dev de e-mail — coisas que hoje só existem para quem passou pelo
`/config` do bot. O ping não precisa de nada: o registro `watch:<email>` nasce
no primeiro sinal de vida (ou na primeira notificação entregue) e expira 30
dias depois do último, então rotina abandonada para de cobrar sozinha. O
marcador `alerted` garante um e-mail por dia, não um por tick, e a cobrança só
é marcada se o e-mail realmente saiu.

Custo conhecido: a cobrança sai num horário fixo para todo mundo (18h de SP,
o último tick do cron). Quem agendar a rotina para depois disso precisa de um
horário por dev no registro.

Admin: `wrangler deploy`. Dev: `/setup-checkin` para atualizar a rotina — sem
isso não há heartbeat e o watchdog cobra em falso. Checagem:
`node worker/test_notify.mjs`.

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

**Quem não tem Telegram voltou a poder pular um dia — inclusive no modo B.**
O estado do `/pular` vive na *mensagem fixada* do chat com o bot: sem chat não
há onde guardar, e por isso a guarda de skip saía inteira do roteiro de quem
escolheu e-mail. Resultado: rotina na nuvem sem nenhuma forma de cancelar um
dia — só desligando a rotina na mão, o que agora dispara o watchdog como se ela
tivesse morrido.

O mesmo estado passou a caber no KV: `GET/POST /skips` guarda as datas em
`skips:<e-mail>` (mesma identidade que o watchdog usa) com a **auth do
`/notify`** — `NOTIFY_SECRET` mais o domínio na allowlist, porque o segredo é
compartilhado no time e sem a trava um dev pularia o dia do outro. A lista
enviada **é** o estado final, mesmo contrato do calendário do Mini App; o
worker descarta passado e fim de semana e devolve o que ficou valendo.

Do lado do dev não há comando novo: `checkin.sh pular/retomar/pulos` já
existiam e já liam `notify.{url,secret,email}` — agora espelham o
`.skips.json` no worker e imprimem `Skips na nuvem: ...` de volta. Sem os três
campos, seguem só locais e calados sobre a nuvem. Falha no espelho **não**
derruba o comando (o skip local já está gravado), mas avisa, porque o silêncio
aqui seria um check-in enviado num dia que o dev achou que tinha cancelado.
Reenviar a lista é idempotente, então `pulos` também conserta um espelho que
falhou antes — não existe um caminho de leitura separado.

Na rotina, a guarda 2 deixou de ser removida na variante sem Telegram: em vez
do `getChat` ela consulta o `/skips`. Se a consulta cair, **segue com o
check-in** — consulta que falhou não é dia pulado, e parar ali seria um dia sem
check-in e sem ninguém avisado.

Descartado no caminho: reaproveitar o Mini App fora do Telegram (o auth é o
`initData`, HMAC do bot token — daria uma página aberta com outro segredo) e
pôr o calendário no popup da extensão (o modo nuvem + MCP roda **sem
extensão**, justamente quem precisa disso).

Admin: `wrangler deploy`. Checagem: `node worker/test_pular.mjs` (o teste de
datas também parou de apodrecer — usava `26/08` fixo, que virou passado e
passou a rolar para 2027).

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

## 2026-08-13 — `[worker]` `[cli]` `[local]` `[setup]`

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
