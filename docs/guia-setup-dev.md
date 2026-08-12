# Guia de setup — check-in automático do Ideal Lab

Este guia é para o dev que vai configurar o check-in automático da **Saúde da
Entrega** (`https://lab.idealtrends.io/saude-entrega/daily`). Existem três
modos de usar a automação — **a escolha é sua**, e dá para trocar depois (as
credenciais são as mesmas, só muda onde o fluxo roda):

| Modo | Onde roda | Melhor para quem... | Precisa de |
|---|---|---|---|
| **A. Extensão do Chrome** | No seu navegador | Quer **revisar/editar** o texto antes de enviar, ou quer o automático sem mexer em terminal (basta o Chrome aberto) | Tokens Jira/Bitbucket, key de IA; sessão do Lab vem do próprio navegador (sem cookie manual) |
| **B. Rotina no Claude Code** | Na nuvem (claude.ai), na **sua** conta corporativa | Quer 100% automático, sem depender de máquina ligada ou navegador aberto | Tokens Jira/Bitbucket, cookie `remember_web`, assento corporativo do Claude — ou, sem token do Jira, os conectores **Atlassian** e **Ideal Lab** ligados na sua conta (modo A da skill `/setup-checkin`; o cookie continua necessário para enviar) |
| **C. CLI + cron local** | Na sua máquina (WSL/Linux) | Já vive no terminal e a máquina fica ligada no horário | Tokens Jira/Bitbucket, key de IA, cookie `remember_web` |

> Os modos não conflitam: todos respeitam as mesmas guardas (fim de semana,
> feriado, `/pular`, já preenchido), então rodar mais de um não duplica nada.

### Não quer decidir lendo tabela? Deixe o Claude perguntar

Clone o repo e **abra o Claude Code na pasta** — enquanto não existir um
`config.json` ali, ele começa a sessão perguntando qual dos modos você quer
(A / B / C, ou "agora não") e conduz o setup a partir da sua resposta:

```bash
git clone <repo> && cd lab-checkin
claude
```

- Escolheu **B (rotina)** ou **C (cron)** → ele chama a skill `/setup-checkin`
  sozinho: pede as credenciais que faltam, valida uma a uma contra Jira,
  Bitbucket e Lab, lista as suas iniciativas, pergunta horário e estilo de
  escrita e cria o agendamento. É o caminho mais curto para o modo B.
- Escolheu **A (extensão)** → ele te guia pela instalação abaixo; depois, o
  "Exportar config.json" migra você para B ou C sem redigitar nada.
- Escolheu **agora não** → ele não pergunta de novo (grava
  `.claude/.setup-declined`). Rode `/setup-checkin` quando quiser.

Já tem `config.json` na pasta (veio da extensão) e quer a rotina? A pergunta
não aparece — rode `/setup-checkin` direto; a skill importa o arquivo.

---

## Passo 0 — Comum a todos os modos

### 0.1 Telegram (recomendado, não obrigatório)

O bot **@CheckInLabBot** dá as notificações (✅ enviado / ❌ falhou / 🚫
pulado) e os comandos remotos (`/pular` um dia pelo celular, `/testar` as
credenciais, `/config` para credenciais na nuvem).

1. Mande `/start` para o @CheckInLabBot e aguarde a aprovação do admin.
2. Aprovado, o bot pergunta suas preferências (iniciativa padrão, horário).
3. Guarde seu `chat_id` (o bot informa) — você vai usá-lo na configuração.
4. Token do bot: peça ao admin (é compartilhado no time; cada dev tem o
   próprio chat, então ninguém vê notificação de ninguém).

O `/config` do bot também guarda o seu **estilo de escrita** (o mesmo material
do B.3): cole ali 2–3 check-ins seus e a IA passa a imitá-los. E com
`/aprovar on` o bot para de enviar direto — manda o rascunho no chat com
**✅ Enviar** / **✏️ Refazer**; se você recusar, ele pergunta o contexto a usar
de base e regera na hora. Isso vale para quem roda pelo **runner do worker**
(`/runner on`) — a rotina do modo B envia sozinha e não tem como esperar o seu
clique.

Sem Telegram? Tudo funciona igual, só sem notificação/comando remoto — deixe
os campos de Telegram em branco. (Canais alternativos — e-mail, notificação
do navegador — estão no roadmap: `docs/plano-rollout-time.md`.)

### 0.2 Credenciais que você vai precisar

| Credencial | Onde gerar | Usada por |
|---|---|---|
| **Jira API token** | id.atlassian.com → Security → API tokens | Todos os modos |
| **Bitbucket API token** (permissão `Repositories: Read`) | id.atlassian.com → Security → API tokens | Todos os modos |
| **Key de IA** — Gemini (free tier) ou Anthropic | Google AI Studio / Console da Anthropic | Extensão e CLI (a rotina do Claude Code gera o texto sozinha, sem key) |
| **Cookie `remember_web`** do Lab | **Automático**: logado no Lab, o "Exportar config.json" da extensão captura o cookie sozinho (sem DevTools) | Só modos B e C (a extensão lê a sessão do navegador) |

> ⚠️ Sobre a key da Anthropic: a assinatura corporativa do claude.ai **não**
> gera API key — key é do Console (platform.claude.com, cobrança separada).
> Se você não tem, use Gemini (default) ou o modo B, que dispensa key de IA.

---

## Modo A — Extensão do Chrome

1. `chrome://extensions` → ativar **Modo do desenvolvedor** → **Carregar sem
   compactação** → selecionar a pasta `extension/` deste repo.
2. Abrir a extensão → aba **Configurações**: preencher Jira, Bitbucket, motor
   de IA, Telegram (opcional) e preferências (iniciativa padrão, horário).
   - Bitbucket: liste os repositórios separados por vírgula, ou deixe vazio
     para varrer todos os do workspace filtrando pelos seus commits.
3. **Validar antes de salvar**: use **🧪 Enviar mensagem de teste** (Telegram)
   e depois **Gerar Rascunho** na aba Check-in (valida Jira/Bitbucket/IA).
   O banner no topo mostra se a sessão do Lab está ativa.
4. Uso manual: **Gerar Rascunho** → revisar → **Enviar Check-in**.
5. Uso automático: ligar o toggle **Modo automático** — um alarme diário envia
   sozinho no horário configurado (Chrome precisa estar aberto; sessão
   expirada gera aviso ❌ no Telegram).
6. (Opcional) **Exportar config.json** — gera o arquivo pronto para os modos
   B e C, para você não redigitar nada. Estando logado no Lab, o cookie
   `remember_web` é incluído automaticamente no export.

## Modo B — Rotina agendada no Claude Code (conta corporativa)

A rotina roda na nuvem do claude.ai, **no seu assento** — não consome a conta
de ninguém e não precisa de máquina ligada nem de navegador aberto. Todo dia,
no horário marcado, um agente sobe do zero (sem memória do dia anterior),
segue o roteiro que você escreveu, e morre. É por isso que **tudo o que ele
precisa saber tem que estar no texto do prompt** — inclusive o seu jeito de
escrever.

O que ele faz, em ordem: checa as guardas → coleta Jira + Bitbucket → gera o
texto → faz o POST no Lab → te notifica no Telegram.

> ✅ **Este modo tem setup guiado**: abra o Claude Code na pasta do repo e
> rode **`/setup-checkin`** — a skill importa o config.json exportado pela
> extensão, valida todas as credenciais, monta a rotina (inclusive com
> roteamento multi-iniciativa, se você configurou o mapa na extensão) e te
> orienta nos passos manuais. Os passos abaixo documentam o que ela faz, caso
> prefira o caminho manual:

### B.1 — Antes de começar (checklist)

| Item | Como conseguir | Obrigatório? |
|---|---|---|
| `config.json` exportado pela extensão | Modo A, passo 6 (já vem com o cookie do Lab) | Sim — ou `config.json.example` preenchido na mão |
| ID da sua iniciativa | Abra `/saude-entrega/daily`; o card da sua iniciativa tem o id (ou pergunte ao admin) | Sim |
| Assento corporativo do claude.ai | Já tem, se você usa o Claude Code do time | Sim |
| Conectores Atlassian / Ideal Lab | Ligados na sua conta claude.ai | Só se você **não** quiser usar token do Jira |
| Telegram (`bot_token` + `chat_id`) | Passo 0.1 | Não (sem ele, falha silenciosa) |
| 2–3 check-ins seus antigos, copiados | Do próprio Lab, ou do que você mandaria hoje na daily | Não, mas é o que faz o texto sair com a sua cara — ver B.3 |

### B.2 — Criar a rotina

No Claude Code, rode `/schedule` e crie uma rotina diária (ex.: 09:30,
seg–sex) com o prompt de B.4. Três coisas que costumam ser esquecidas:

- **Credenciais fora do prompt**: cole o `config.json`/cookie nos secrets ou
  no ambiente da rotina. Nunca no texto do prompt se ela for compartilhada.
- **`allowed_tools` precisa incluir `ToolSearch`** além dos `mcp__<conector>`
  — sem ela o agente não carrega o schema de nenhuma tool de conector e
  reporta "tool não existe" (parece bug de permissão, não é).
- **Allowlist de egress** (passo manual, só via UI do claude.ai): ícone do
  environment da rotina → engrenagem → liberar `lab.idealtrends.io`,
  `api.telegram.org`, `*.atlassian.net` e `api.bitbucket.org`. Sem isso o POST
  no Lab morre em timeout sem mensagem clara.

### B.3 — Dar contexto do **seu** jeito de escrever

Esta é a parte que muda a qualidade do resultado. O agente não tem histórico:
sem exemplos, ele escreve um check-in genérico de LLM ("Realizei atividades de
desenvolvimento e correções") — correto e sem graça, e o time percebe.

O Lab **não** expõe endpoint de check-ins anteriores (a página só devolve os
cards de hoje), então os exemplos têm que ser colados por você, uma vez, no
prompt da rotina. Vale a pena: cole 2–3 check-ins reais seus no bloco
`Estilo` do prompt e ajuste as regras de estilo para o que é verdade sobre
você. Perguntas que ajudam a preencher isso:

- Você escreve em frases corridas ou em bullets?
- Cita código de task (`PROJ-123`) ou fala do assunto por extenso?
- Fala em 1ª pessoa ("Finalizei…") ou impessoal ("Finalizada…")?
- Quantas linhas costuma ter? Duas? Uma para cada frente de trabalho?
- Usa termos do domínio que só o time entende (nome de módulo, de cliente)?
- Como você escreve um dia parado — "sem entregas" ou omite?

Revise o bloco depois da primeira semana: se o texto gerado estiver escorregando
para o genérico, quase sempre é exemplo de menos, não regra de mais.

### B.4 — Roteiro do prompt

A primeira linha carimba a versão do roteiro (a mais recente do
`CHANGELOG.md`). É o que deixa `git pull` + `/setup-checkin` saberem se a sua
rotina está atrasada — mantenha-a atualizada quando reescrever o prompt.

```text
# lab-checkin roteiro <VERSAO_DO_CHANGELOG>

Você preenche meu check-in diário de Saúde da Entrega no Ideal Lab.

Guardas (pare silenciosamente se qualquer uma valer):
1. Fim de semana ou feriado nacional/SP (calcule os móveis: Carnaval,
   Sexta Santa, Corpus Christi).
2. O dia de hoje consta na mensagem fixada do meu chat com o
   @CheckInLabBot (leia via getChat da API do Telegram; formato
   "SKIP: YYYY-MM-DD, ..."). Nesse caso, notifique 🚫 e pare.
3. O check-in de hoje já está preenchido (GET na página
   /saude-entrega/daily autenticado com meu cookie remember_web; os
   cards vêm no atributo data-page).

Coleta: minhas issues do Jira atualizadas desde o último dia útil
(assignee = eu) e meus commits no Bitbucket desde então (repos do
config; vazio = todos do workspace). Um commit é meu se o author.raw
contiver o meu e-mail OU o meu username do Bitbucket — não filtre só
pelo display name da conta Atlassian, isso descarta commits em silêncio.

Estilo — escreva como EU escrevo, não como um assistente escreveria.
Regras (ajuste para o seu caso):
- 1ª pessoa, tom de daily falada, direto ao ponto.
- Não cite código de task (PROJ-123); fale do assunto por extenso.
- Agrupe commits em realizações lógicas, não liste commit a commit.
- 2 a 4 linhas por campo; sem preâmbulo ("Hoje eu irei...") e sem
  fechamento ("Qualquer dúvida, estou à disposição").
- Nunca invente: se a atividade não aparece no Jira/Bitbucket, não entra.

Exemplos reais meus (imite o tom e o tamanho, não o conteúdo):
  Ontem: "Fechei o ajuste de permissão do módulo de auditoria e subi a
  correção do relatório que estava duplicando linha. Comecei a olhar o
  import de planilha, que está estourando memória em arquivo grande."
  Hoje: "Termino o import de planilha processando em lote e volto para os
  testes do fluxo de aprovação."
  [COLE AQUI MAIS 1–2 CHECK-INS SEUS DE VERDADE]

Gerar: "Ontem" (o que fiz) e "Hoje" (o que farei), seguindo o Estilo
acima. Último dia útil foi feriado/fds → "Ontem" em branco.

Enviar: POST em /saude-entrega/daily (Inertia: renove a sessão com um
GET, extraia o XSRF-TOKEN do cookie e mande no header x-xsrf-token).
Campos: initiative_id=<MINHA_INICIATIVA>, checkin_date=hoje,
yesterday_text, today_text, confidence_score=5, blockers_text="".

Confirmar: o 302 não prova envio — o Inertia responde 302 também quando
a validação reprova. Refaça o GET e confira que o card da iniciativa
veio com "existing"; se não veio, leia props.errors do data-page desse
mesmo GET (é onde o Inertia entrega os erros; pode vir em
props.errors.default), me notifique ❌ citando campo + mensagem e diga
quais desses campos não estão no payload acima — esses são campos novos
do formulário, que preciso mapear no script. Preencho o dia na mão.

Notificar (se Telegram configurado): sendMessage com ✅ + resumo em
sucesso, ❌ + causa provável em falha (ex.: cookie expirado).
```

Substitua `<MINHA_INICIATIVA>`, troque os exemplos do bloco `Estilo` pelos
seus e informe onde estão as credenciais.

### B.5 — Testar

Rode a rotina manualmente uma vez (pela UI de routines) num dia em que o
check-in ainda não foi preenchido, e confira **o texto** no Lab — não só se
enviou. Se soou genérico, o ajuste é no bloco `Estilo`, não nas credenciais.
Com o bot configurado, `/testar` valida as credenciais guardadas no `/config`
a qualquer momento.

> 💡 Conectores: se você tiver o **Atlassian MCP** conectado na sua conta, a
> rotina pode ler o Jira por ele (dispensa o token). O envio ao Lab usa o
> cookie `remember_web` — que o export da extensão captura sozinho; quando
> expirar (❌ no Telegram), logue no Lab, re-exporte e rode `/setup-checkin`
> de novo.

## Modo C — CLI + cron local

Siga o README principal (seções "Opção 2: CLI"): `cookies.txt` +
`config.json` (ou o exportado da extensão), teste com
`./checkin.sh auto --initiative N --dry-run` e agende na crontab. O modo
automático respeita as mesmas guardas dos outros modos.

---

## Mantendo atualizado

O repo muda: campo novo no formulário do Lab, ajuste na coleta, guarda nova. O
`CHANGELOG.md` diz, por versão, **o que aquilo exige de você**:

```bash
git pull
claude        # na pasta do repo
```

Se a sua versão aplicada estiver atrás, o Claude abre a sessão resumindo o que
mudou e oferece atualizar. Se preferir puxar você mesmo: *"leia o CHANGELOG e
atualize minha rotina"* ou `/setup-checkin`.

| Tag no changelog | O que você faz |
|---|---|
| `[rotina]` | Sua rotina no claude.ai está desatualizada — deixe o Claude reescrever o prompt dela (ele mostra o que muda antes, e não mexe no seu bloco `Estilo` sem você pedir) |
| `[cli]` | Nada além do `git pull` |
| `[extensão]` | `git pull` + recarregar em `chrome://extensions` |
| `[worker]` | Nada — o admin faz o deploy; quem usa `/runner on` já pega pronto |
| `[setup]` | Nada, só afeta quem está configurando pela primeira vez |

A versão aplicada fica em `.checkin-version` (local, fora do git). O roteiro da
sua rotina carrega o mesmo carimbo na primeira linha — é assim que dá para saber
se ela está atrasada sem reler o prompt inteiro.

---

## Validação e problemas comuns

| Sintoma | Causa provável | Correção |
|---|---|---|
| `/testar` mostra ❌ Ideal Lab | Cookie `remember_web` expirado | Logar no Lab no navegador → **Exportar config.json** na extensão (cookie novo incluído) → rodar `/setup-checkin` ou atualizar via `/config` |
| ❌ Jira/Bitbucket no `/testar` | Token inválido ou sem permissão | Regerar token; Bitbucket precisa de `Repositories: Read` |
| Rascunho vazio | Sem issues/commits no período, ou username do Bitbucket não bate com o autor dos commits | Confira o campo username / deixe vazio para auto-detectar |
| Nada chega no Telegram | chat_id errado ou cadastro não aprovado | `/start` de novo; use o botão 🧪 da extensão para validar token+chat_id |
| Workspace com muitos repos ficou lento | Auto-descoberta varre repo a repo (e trunca em 100) | Liste os repos no config (melhoria `project_key` no roadmap) |
| Texto enviado soou genérico ("realizei atividades de desenvolvimento") | Poucos exemplos no bloco `Estilo` do prompt (modo B) | Cole 2–3 check-ins reais seus no bloco `Estilo` (B.3) e rode de novo |
| Rotina diz "tool não existe" (modo B) | `allowed_tools` sem `ToolSearch` | Adicione `ToolSearch` junto dos `mcp__<conector>` (B.2) |
| Rotina trava/timeout no envio (modo B) | Egress do environment não liberado | Liberar `lab.idealtrends.io` e os demais domínios na UI do claude.ai (B.2) |
| ❌ "o Lab reprovou o envio: `campo` (…) — campo novo no formulário" | O formulário do Lab ganhou um campo (provavelmente obrigatório) que o script não preenche | Preencher o dia na mão e mandar a mensagem para o admin: o nome do campo vem na própria notificação (sai do `props.errors` do Inertia) e precisa entrar no payload em `checkin.sh`, `extension/lib.js` e `worker.js` — e no roteiro da sua rotina (`/setup-checkin` reescreve) |
| Trabalho em 2+ projetos misturado num form só | Roteamento multi-iniciativa ainda não implementado | Roadmap (Fase 4) — por ora use a iniciativa do projeto atual |
