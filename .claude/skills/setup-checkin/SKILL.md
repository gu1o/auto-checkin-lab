---
name: setup-checkin
description: Configura o check-in automático diário da Saúde da Entrega (Ideal Lab) para o dev atual — pergunta onde vai rodar (rotina agendada na nuvem ou cron local), pega as credenciais dos conectores MCP (Atlassian/Ideal Lab) ou do config.json da extensão, valida tudo e cria o agendamento. Use quando o dev quiser ativar, reconfigurar ou renovar credenciais do check-in automático — e também depois de um `git pull`, para conferir no CHANGELOG.md o que mudou e atualizar a rotina dele.
---

# Setup do check-in automático (Ideal Lab)

Você vai configurar o check-in diário de Saúde da Entrega para o dev que está
executando esta skill, criando uma **rotina agendada na conta dele** no Claude
Code. Siga as etapas na ordem. Contexto completo: `docs/guia-setup-dev.md`.

Regras gerais:
- **Nunca imprima tokens/cookies no chat** — refira-se a eles como "o token do
  Jira", "o cookie do Lab" etc.
- Pare em qualquer validação que falhar, explique a correção e aguarde o dev.
- Se já existir uma rotina de check-in criada por uma execução anterior
  (procure com a skill `schedule` listando as rotinas por nome contendo
  "check-in" ou "lab-checkin"), **atualize-a** em vez de criar duplicata —
  este é também o fluxo de renovação de cookie.

## Modo atualização (depois de um `git pull`)

Se o dev já tem `config.json` e já roda o check-in, e o que ele quer é aplicar
mudanças novas do repo, **não refaça o setup**:

1. Leia o `CHANGELOG.md` e o `.checkin-version` (versão aplicada por último;
   ausente = nunca aplicada). As entradas acima dela são o que ele ainda não tem.
2. Resuma em 2–3 linhas o que mudou e o que cada tag exige dele: `[rotina]` =
   rotina do claude.ai desatualizada; `[cli]`/`[extensão]` = o `git pull` já
   resolveu (extensão pede recarregar em `chrome://extensions`); `[worker]` =
   deploy do admin, ele não faz nada.
3. Sem nenhuma entrada `[rotina]`: só grave a versão nova em `.checkin-version`
   e encerre.
4. Com entrada `[rotina]`: localize a rotina existente (skill `schedule`, nome
   com "check-in"/"lab-checkin"), **mostre ao dev o que vai mudar no prompt
   antes de mexer** e atualize só os trechos afetados — credenciais, iniciativas
   e principalmente o bloco `Estilo`/exemplos são dele e não se tocam sem ele
   pedir. Atualize o carimbo `# lab-checkin roteiro <versão>` da primeira linha
   e grave a mesma versão em `.checkin-version`.

Se o dev pedir setup novo, ou não houver `config.json`, siga a partir da etapa 0.

## 0. Duas escolhas iniciais

Pergunte as duas com `AskUserQuestion` (se a sessão começou com o aviso de
"repo sem config.json", a primeira já pode ter sido respondida).

**0.1 Onde roda** (define a etapa 6):

- **Nuvem** — rotina agendada na conta claude.ai do dev. Roda com a máquina
  desligada; é o setup do Guilherme. Default.
- **Local** — `cron` na máquina do dev chamando `checkin.sh auto`. Só roda com
  a máquina ligada; precisa de key de IA (Gemini free serve) para gerar o texto.

**0.2 Origem das credenciais** (default: **MCP** se ele já usa conectores):

- **MCP** — Jira e Lab (leitura) vêm dos conectores da conta dele; só o token
  do Bitbucket e o cookie do Lab são digitados. Sem extensão. **Só vale no modo
  nuvem** — o `checkin.sh` local não fala MCP, então local ⇒ config.json.
- **config.json da extensão** — tudo vem do export (etapa 1).

Modo MCP: peça para o dev conectar em `claude.ai` → Configurações → Conectores:
**Atlassian** (Jira) e **Ideal Lab**. As tools de conector são *deferred*: só o
nome aparece, o schema não. Carregue antes de chamar, sempre pelo nome completo
com prefixo — `ToolSearch("select:mcp__claude_ai_Atlassian__atlassianUserInfo,mcp__claude_ai_Ideal_Lab__list-initiatives")`
— e confirme chamando as duas. Só considere o conector desconectado se a tool
falhar *depois* de carregada; "não achei a tool" com nome curto (sem prefixo)
é falso negativo, não desconexão. Depois peça no chat:

| Dado | Como obter |
|---|---|
| Token do Bitbucket (`Repositories: Read`) | id.atlassian.com → Security → API tokens |
| Cookie `remember_web` do Lab | Extensão → "Exportar config.json", ou DevTools → Application → Cookies em `lab.idealtrends.io` |

Grave-os em `config.json` (mesmo formato do `config.json.example`, campos de
Jira vazios) para o `/testar` e o CLI reaproveitarem, e pule para a etapa 4.

> O cookie é obrigatório mesmo no modo A: o MCP do Lab lê iniciativas e saúde,
> mas não envia check-in diário — o envio é o POST em `/saude-entrega/daily`.

## 1. Obter o config.json (modo B)

Procure `config.json` na raiz deste repositório. Se não existir, oriente o dev:

1. Instalar a extensão: `chrome://extensions` → Modo do desenvolvedor →
   "Carregar sem compactação" → pasta `extension/` deste repo.
2. Fazer login em `https://lab.idealtrends.io` no navegador.
3. Na aba **Configurações** da extensão: preencher Jira, Bitbucket e — se
   quiser notificações — Telegram; salvar; clicar **Exportar config.json**
   (o cookie do Lab é capturado automaticamente da sessão do navegador).
4. Mover o arquivo baixado para a raiz do repo.

Aguarde o dev confirmar antes de continuar. **Não commite o config.json**
(confira que está no .gitignore; se não estiver, adicione).

## 2. Validar o conteúdo

Leia o arquivo e confira:

| Campo | Obrigatório | Se faltar |
|---|---|---|
| `jira.url`, `jira.email`, `jira.api_token` | Sim | Voltar à etapa 1 |
| `bitbucket.api_token`, `bitbucket.workspace` | Sim | Voltar à etapa 1 |
| `lab.cookie_name`, `lab.cookie_value` | Sim | Export antigo ou dev deslogado do Lab: pedir para logar no Lab e re-exportar |
| `telegram.bot_token`, `telegram.chat_id` | Não | Perguntar se quer notificações (etapa 3); sem elas a rotina roda silenciosa |
| `initiative_config` (mapa por iniciativa) | Não | Resolver iniciativas na etapa 4 |

## 3. Telegram (opcional)

Se o dev quiser notificações e o telegram estiver vazio:

1. Mandar `/start` para o **@CheckInLabBot** e aguardar aprovação do admin
   (Guilherme).
2. O token do bot é compartilhado no time — o dev pega com o admin; o chat_id
   o próprio bot informa após aprovação.
3. Preencher na extensão e re-exportar (ou informar aqui os dois valores).

O bot também dá `/pular DD/MM` (cancela um dia), `/testar` (valida as
credenciais salvas no `/config`) e `/config` (formulário seguro de
credenciais na nuvem). Atalho: na extensão, o botão **🔗 Conectar Telegram**
faz o registro por deep link e já preenche o `chat_id` sozinho (sem digitar).

**Notificação por e-mail (alternativa ao Telegram):** na rotina cloud, o dev
pode dispensar o Telegram e pedir para a rotina te avisar por **e-mail via o
conector Gmail** dele — acrescente ao final do prompt da rotina um passo
"envie um e-mail para {EMAIL} com o resumo do check-in" (o Claude Code usa o
conector Gmail do próprio dev). Não distribua credencial SMTP.

## 4. Validar credenciais e descobrir iniciativas

Execute os checks abaixo (via curl/fetch) e mostre um relatório ✅/❌. Todos
são somente-leitura. **No modo MCP**, troque o check do Jira por
`atlassianUserInfo` e o das iniciativas por `list-initiatives` do MCP do Lab
(o check do cookie continua valendo — é ele que envia).

- **Jira**: `GET {jira.url}/rest/api/3/myself` com `Authorization: Basic
  base64(email:api_token)` → 200; guarde o displayName.
- **Bitbucket**: `GET https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1`
  — token começando com `ATATT` usa Basic `base64(jira.email:token)`; outros
  usam `Bearer` → 200.
- **Lab**: `GET https://lab.idealtrends.io/saude-entrega/daily` com header
  `Cookie: {cookie_name}={cookie_value}`, **sem seguir redirect** → 200 =
  sessão ativa; 302 = cookie inválido (relogar + re-exportar).
- **Telegram** (se configurado): `getChat` com o chat_id → ok.

Do HTML do Lab (200), extraia o JSON do atributo `data-page` (HTML-escaped) e
liste os **cards de iniciativas vinculadas** do dev (`initiativeId`,
`initiativeName`) — use na próxima etapa.

## 5. Definir agenda, iniciativas e estilo de escrita

Pergunte ao dev (com defaults):

- **Horário** do check-in (default 09:30, seg–sex; a rotina pula fim de
  semana/feriado sozinha de qualquer forma).
- **Iniciativa(s)**: mostre as encontradas no Lab. Uma só → essa é a padrão.
  Mais de uma em que ele trabalha → monte o mapa por iniciativa
  (`initiative_config` do export já pode trazer repos/projetos Jira por
  iniciativa — confirme com o dev) e defina uma default para atividade não
  mapeada.

### 5.1 Exemplos de estilo (peça sempre — é o que evita texto genérico)

O Lab não expõe check-ins anteriores (a página só devolve os cards de hoje),
então o único jeito de o agente escrever como o dev é ele colar exemplos. Sem
isso o texto sai correto e sem cara de ninguém ("Realizei atividades de
desenvolvimento e correções") — e o time percebe.

Peça no chat:

> Cole 2–3 check-ins seus de verdade (o par "Ontem"/"Hoje"), do jeito que
> você escreveria. Pode ser do Lab, do Slack ou o que você diria na daily de
> hoje. Se não tiver à mão, escreva um de exemplo — é o que a rotina vai
> imitar todo dia.

Se ele não tiver nenhum, use `AskUserQuestion` para fechar o estilo em uma
rodada (não faça um interrogatório): bullets × frases corridas; 1ª pessoa ×
impessoal; cita código de task (`PROJ-123`) × só o assunto. Registre também
qualquer termo do domínio que ele usa (nome de módulo, de cliente).

Guarde o resultado — os exemplos e as regras vão no bloco `Estilo` do prompt
da etapa 6-nuvem. **Não invente exemplos em nome do dev**: sem material,
mantenha só as regras.

Se o dev usa o **runner do worker** (`/runner on` no bot) em vez da rotina,
o mesmo material vai no campo **Estilo de escrita** do formulário `/config` —
avise que lá também existe `/aprovar on`, que manda o rascunho no chat com
botões ✅/✏️ antes de enviar (recusar = o bot pede o contexto e regera). Na
rotina cloud isso não existe: ela roda e morre, sem esperar clique.

No modo **local** pule esta etapa: o `auto_activity.py` usa um prompt fixo, e
personalizar exige editar a função `generate_text_gemini` no arquivo — diga
isso ao dev em vez de prometer um campo de config que não existe.

## 6. Criar o agendamento

### 6-local — cron na máquina do dev

Só se ele escolheu **Local** em 0.1. Confira que o `config.json` tem a key de
IA (`gemini`/`claude`) — sem ela o `auto` não gera texto — e valide com
`./checkin.sh auto --dry-run` (não envia nada; mostre a saída ao dev). Depois
acrescente a entrada de cron, sem apagar as existentes e sem duplicar
(`crontab -l` primeiro; se já houver linha com `checkin.sh`, substitua-a):

```
{MIN} {HORA} * * 1-5 cd {REPO} && ./checkin.sh auto >> /tmp/lab-checkin.log 2>&1
```

Alternativa se a máquina costuma estar desligada no horário: `schedule.enabled`
/ `schedule.time` no config + cron de tick a cada 15 min (`*/15 * * * *`) — o
gate interno só envia no/depois do horário e uma vez por dia. Pule para a
etapa 7 (só o item 3 se aplica).

### 6-nuvem — rotina agendada no claude.ai

Monte o prompt da rotina a partir do template abaixo, preenchendo os
placeholders com os dados do config (as credenciais entram no corpo da rotina,
que é privada da conta do dev). Em seguida crie a rotina com a skill
`schedule`: diária, seg–sex, no horário escolhido, timezone
`America/Sao_Paulo`, nome `lab-checkin`.

A primeira linha do prompt carimba a versão do roteiro (a mais recente do
`CHANGELOG.md`) — é o que permite, num `git pull` futuro, saber se a rotina
está atrasada sem ler o prompt inteiro. **Atualize esse carimbo sempre que
reescrever a rotina.**

```text
# lab-checkin roteiro {VERSAO_DO_CHANGELOG}

Você preenche meu check-in diário de Saúde da Entrega no Ideal Lab.

Credenciais: Jira {URL} (email {EMAIL}, token {JIRA_TOKEN}); Bitbucket
workspace {WORKSPACE} (token {BB_TOKEN}); cookie do Lab
{COOKIE_NAME}={COOKIE_VALUE}; Telegram bot {BOT_TOKEN}, chat {CHAT_ID}.
[omitir a linha do Telegram se não configurado]
[modo MCP: troque a parte do Jira por "Use o conector Atlassian (MCP) para o
Jira. As tools são deferred — carregue primeiro com
ToolSearch(\"select:mcp__Atlassian__searchJiraIssuesUsingJql,mcp__Atlassian__getJiraIssue\"),
sempre pelo nome completo com o prefixo mcp__<nome do connector>__ (na rotina
cloud o connector chama Atlassian ⇒ mcp__Atlassian__). Busque com
assignee = currentUser() passando fields: [\"summary\",\"status\",\"updated\"] —
sem isso o retorno traz a description inteira de cada issue e estoura o limite
de tokens. Se a tool não aparecer pelo nome curto, é falso negativo — use o
nome completo; e se o Jira falhar mesmo assim, siga só com o Bitbucket em vez
de abortar." e mantenha Bitbucket/cookie/Telegram como acima]

⚠️ `allowed_tools` da rotina **precisa incluir `ToolSearch`** além de
`mcp__<connector>` — sem ela o agente não consegue carregar o schema de
nenhuma tool de conector e reporta "tool não existe".

Guardas — pare silenciosamente se qualquer uma valer:
1. Hoje é fim de semana ou feriado nacional/SP (calcule os móveis: Carnaval,
   Sexta-feira Santa, Corpus Christi).
2. A data de hoje consta na mensagem fixada do meu chat com o bot (leia via
   getChat; formato "SKIP: YYYY-MM-DD, ..."). Nesse caso notifique 🚫 e pare.
3. O check-in de hoje já está preenchido (GET em
   https://lab.idealtrends.io/saude-entrega/daily com o cookie; os cards vêm
   no atributo data-page, HTML-escaped).

Coleta: minhas issues do Jira atualizadas desde o último dia útil
(assignee = currentUser()) e meus commits no Bitbucket desde então
(repositórios: {REPOS_OU_TODOS} — cada entrada é um padrão regex/substring
casado contra os slugs do workspace, ex. "auditoriaideal" pega
auditoriaideal.com.br, api.auditoriaideal.com.br e
local-infra.auditoriaideal.com.br). Um commit é meu se o author.raw contiver
o e-mail {EMAIL} **ou** o usuário {BB_USERNAME} — o user.name do meu git
diverge do display name da conta Atlassian, então NÃO filtre só pelo display
name (isso descarta commits em silêncio). Colete de todos os branches: chame
/commits com um include= por branch de refs/branches com target.date desde o
último dia útil, já que sem include o endpoint só devolve o branch principal
e meus commits ficam em branches de feature até o merge.

Estilo — escreva como EU escrevo, não como um assistente escreveria:
- 1ª pessoa, tom de daily falada, direto ao ponto.
- Não cite código de task (PROJ-123); fale do assunto por extenso.
- Agrupe commits em realizações lógicas, não liste commit a commit.
- 2 a 4 linhas por campo; sem preâmbulo ("Hoje eu irei...") e sem
  fechamento ("Qualquer dúvida, estou à disposição").
- Nunca invente: atividade que não aparece no Jira/Bitbucket não entra.
[substitua as regras acima pelas que o dev confirmou na etapa 5.1]

Exemplos reais meus (imite o tom e o tamanho, não o conteúdo):
{EXEMPLOS_DE_ESTILO}
[cole aqui, literalmente, os 2–3 pares Ontem/Hoje que o dev deu na etapa
5.1; se ele não deu nenhum, remova este bloco inteiro — não invente]

Gerar: "Ontem" (o que fiz) e "Hoje" (o que farei), seguindo o Estilo acima.
Se o último dia útil foi feriado/fim de semana, "Ontem" vai em branco.

[SE MULTI-INICIATIVA] Roteamento: agrupe a atividade pelo project key do
Jira presente na issue e no nome do branch/mensagem do commit (padrão
KEY-123), usando o mapa: {MAPA id -> jira_projects/repos}. Gere e envie um
check-in POR iniciativa com atividade; iniciativas sem atividade hoje não
recebem envio; atividade sem mapeamento vai para a iniciativa {DEFAULT} —
mencione isso na notificação.

Enviar (por iniciativa): POST em /saude-entrega/daily — renove a sessão com
um GET (o Set-Cookie devolve XSRF-TOKEN), mande o XSRF url-decodificado no
header x-xsrf-token, headers x-inertia: true e x-requested-with:
XMLHttpRequest. Body JSON: initiative_id, checkin_date (hoje, YYYY-MM-DD),
yesterday_text, today_text, confidence_score: 5, blockers_text: "",
yesterday_artifact_url: "".

Confirmar: o 302 NAO prova nada — o Inertia responde 302 tambem quando a
validacao reprova (volta para a pagina com os erros na sessao). Depois do POST,
refaca o GET e confira que o card da iniciativa veio com "existing"
preenchido. Se nao veio, trate como FALHA: leia props.errors do data-page desse
MESMO GET (e onde o Inertia entrega o bag de validacao; pode vir aninhado em
props.errors.default) e notifique ❌ citando cada campo e a mensagem dele,
marcando os que nao existem no payload acima como campo novo do formulario.
Diga que o check-in de hoje precisa ser preenchido na mao e que o campo novo
tem que ser mapeado no script.

Notificar [se Telegram]: sendMessage — ✅ com o resumo enviado (um por
iniciativa) em sucesso; ❌ com a causa provável em falha (se for o cookie
expirado, diga: "logue no Lab, exporte o config.json na extensão e rode
/setup-checkin de novo").
```

## 7. Pós-setup (passos manuais do dev — itens 1 e 2 só no modo nuvem)

1. **Allowlist de egress** do environment da rotina (só pela UI do claude.ai:
   ícone do environment → engrenagem): liberar `lab.idealtrends.io`,
   `api.telegram.org`, `*.atlassian.net` e `api.bitbucket.org`. No modo A,
   no modo MCP, `*.atlassian.net` só é necessário se algo ainda chamar a API do
   Jira direto — e confira na UI da rotina que os conectores Atlassian e Ideal
   Lab estão habilitados para ela (conector desabilitado = rotina sem o Jira).
2. **Teste real**: dispare uma execução manual da rotina (UI de routines) num
   dia em que o check-in ainda não foi preenchido; confira o form no Lab e a
   notificação. Alternativa sem esperar: rode agora os checks da etapa 4 de
   novo e um dry-run (gerar o texto sem POST) mostrando ao dev o que seria
   enviado. Pergunte se **o texto soou como ele** — se soou genérico, o
   conserto é acrescentar exemplos no bloco `Estilo` (etapa 5.1) e atualizar
   a rotina, não mexer em credencial.
3. Lembre o dev: cookie expirou → ❌ no Telegram → logar no Lab → re-exportar
   na extensão → rodar `/setup-checkin` de novo (a skill atualiza a rotina).
4. Grave a versão mais recente do `CHANGELOG.md` em `.checkin-version` (arquivo
   local, gitignored) — é o que faz o Claude avisar, no próximo `git pull`, que
   saiu mudança que exige atualizar a rotina.
