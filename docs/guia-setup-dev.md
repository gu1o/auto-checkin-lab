# Guia de setup — check-in automático do Ideal Lab

Este guia é para o dev que vai configurar o check-in automático da **Saúde da
Entrega** (`https://lab.idealtrends.io/saude-entrega/daily`). Existem três
modos de usar a automação — **a escolha é sua**, e dá para trocar depois (as
credenciais são as mesmas, só muda onde o fluxo roda):

| Modo | Onde roda | Melhor para quem... | Precisa de |
|---|---|---|---|
| **A. Extensão do Chrome** | No seu navegador | Quer **revisar/editar** o texto antes de enviar, ou quer o automático sem mexer em terminal (basta o Chrome aberto) | Tokens Jira/Bitbucket, key de IA; sessão do Lab vem do próprio navegador (sem cookie manual) |
| **B. Rotina no Claude Code** | Na nuvem (claude.ai), na **sua** conta corporativa | Quer 100% automático, sem depender de máquina ligada ou navegador aberto | Tokens Jira/Bitbucket, cookie `remember_web`, assento corporativo do Claude |
| **C. CLI + cron local** | Na sua máquina (WSL/Linux) | Já vive no terminal e a máquina fica ligada no horário | Tokens Jira/Bitbucket, key de IA, cookie `remember_web` |

> Os modos não conflitam: todos respeitam as mesmas guardas (fim de semana,
> feriado, `/pular`, já preenchido), então rodar mais de um não duplica nada.

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
de ninguém e não precisa de máquina ligada.

> ✅ **Este modo tem setup guiado**: abra o Claude Code na pasta do repo e
> rode **`/setup-checkin`** — a skill importa o config.json exportado pela
> extensão, valida todas as credenciais, monta a rotina (inclusive com
> roteamento multi-iniciativa, se você configurou o mapa na extensão) e te
> orienta nos passos manuais. Os passos abaixo documentam o que ela faz, caso
> prefira o caminho manual:

1. **Credenciais em mãos**: preencha tudo na extensão e use **Exportar
   config.json** (Modo A, passo 6) — o cookie do Lab já vem incluído. Senão,
   copie `config.json.example` e preencha (aí sim o cookie sai do DevTools,
   Passo 0.2).
2. **Criar a rotina**: no Claude Code, rode `/schedule` e crie uma rotina
   diária (ex.: 09:30, seg–sex) com um prompt que siga este roteiro:

   ```text
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
   config; vazio = todos do workspace, filtrando por autor).

   Gerar: resuma em 1ª pessoa "Ontem" (o que fiz) e "Hoje" (o que farei),
   objetivo, sem inventar nada. Último dia útil foi feriado/fds → "Ontem"
   em branco.

   Enviar: POST em /saude-entrega/daily (Inertia: renove a sessão com um
   GET, extraia o XSRF-TOKEN do cookie e mande no header x-xsrf-token;
   sucesso = HTTP 302). Campos: initiative_id=<MINHA_INICIATIVA>,
   checkin_date=hoje, yesterday_text, today_text, confidence_score=5,
   blockers_text="".

   Notificar (se Telegram configurado): sendMessage com ✅ + resumo em
   sucesso, ❌ + causa provável em falha (ex.: cookie expirado).
   ```

   Substitua `<MINHA_INICIATIVA>` e informe onde estão as credenciais (cole o
   config.json/cookie nos secrets ou no ambiente da rotina — **nunca** no
   texto do prompt se a rotina for compartilhada).
3. **Allowlist de egress** (passo manual, só via UI do claude.ai): no ícone do
   environment da rotina → engrenagem → liberar `lab.idealtrends.io`,
   `api.telegram.org`, `*.atlassian.net` e `api.bitbucket.org`.
4. **Testar**: rode a rotina manualmente uma vez (pela UI de routines) num
   dia em que o check-in ainda não foi preenchido, e confira o resultado no
   Lab e no Telegram. Com o bot configurado, `/testar` valida as credenciais
   guardadas no `/config` a qualquer momento.

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

## Validação e problemas comuns

| Sintoma | Causa provável | Correção |
|---|---|---|
| `/testar` mostra ❌ Ideal Lab | Cookie `remember_web` expirado | Logar no Lab no navegador → **Exportar config.json** na extensão (cookie novo incluído) → rodar `/setup-checkin` ou atualizar via `/config` |
| ❌ Jira/Bitbucket no `/testar` | Token inválido ou sem permissão | Regerar token; Bitbucket precisa de `Repositories: Read` |
| Rascunho vazio | Sem issues/commits no período, ou username do Bitbucket não bate com o autor dos commits | Confira o campo username / deixe vazio para auto-detectar |
| Nada chega no Telegram | chat_id errado ou cadastro não aprovado | `/start` de novo; use o botão 🧪 da extensão para validar token+chat_id |
| Workspace com muitos repos ficou lento | Auto-descoberta varre repo a repo (e trunca em 100) | Liste os repos no config (melhoria `project_key` no roadmap) |
| Trabalho em 2+ projetos misturado num form só | Roteamento multi-iniciativa ainda não implementado | Roadmap (Fase 4) — por ora use a iniciativa do projeto atual |
