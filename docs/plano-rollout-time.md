# Plano: rollout do lab-checkin para o time

> Escopo consolidado em 2026-07-16 a partir das validações feitas (multi-repo,
> multi-iniciativa, autenticação Anthropic, canais de notificação). Objetivo:
> qualquer dev do time configura o check-in automático sozinho, com o mínimo
> de credenciais e fricção, usando o próprio Claude Code corporativo.

## Princípios do desenho

- **Cada dev usa o próprio assento**: a rotina agendada roda no Claude Code do
  dev (assinatura corporativa). Ninguém consome a conta de outra pessoa; a
  extensão e o CLI continuam como modos alternativos.
- **O worker é o hub de estado, não de notificação**: notificações saem direto
  do runner para o canal; o worker guarda registro, skips, credenciais e
  responde comandos do bot.
- **Telegram é o canal recomendado** (único com comandos remotos + skips), mas
  não obrigatório.

---

## Fase 0 — Concluída (2026-07-16)

- `/testar` no bot: valida credenciais salvas (Jira, Bitbucket, sessão do Lab,
  API keys de IA) — somente leitura, nada é enviado ao Lab.
- Botão **🧪 Testar credenciais** na página pós-salvar do `/config`.
- Botão de teste do Telegram na extensão (valida token + chat_id digitados).

## Fase 1 — Tool `submit-daily-checkin` no MCP do Ideal Lab

**Onde:** repositório da plataforma Lab (não neste repo).
**Por quê primeiro:** elimina o cookie `remember_web` — a credencial mais
frágil (expira, falha silenciosa nº 1) — e destrava o cenário zero-credencial
da Fase 2.

- Tool de escrita com os campos do form: `initiative_id`, `yesterday_text`,
  `today_text`, `confidence_score`, `blockers_text`, `artifact_url`,
  `checkin_date` (default hoje). Mesmas validações/auditoria do app web;
  upsert como o POST atual; exige token com escopo read-write.
- Tool (ou extensão de uma existente) para as guardas: consultar se o check-in
  do dia já foi preenchido e listar as iniciativas vinculadas do usuário.

## Fase 2 — Skill `/setup-checkin`

**Onde:** este repo (`.claude/skills/setup-checkin/`). O dev clona, abre o
Claude Code e roda a skill.

Fluxo da skill:

1. Pergunta o **modo** (rotina cloud / extensão / CLI+cron) e o **canal de
   notificação** (Telegram / e-mail / navegador / nenhum).
2. Registro no bot (se Telegram): `/start` no @CheckInLabBot → aprovação do
   admin → chat_id.
3. **Credenciais, dois cenários:**
   - **A — importar da extensão:** o dev preenche o form visual da extensão
     (que já valida com os botões de teste) e usa **Exportar config.json**; a
     skill detecta o arquivo e não pede nada de novo.
   - **B — MCPs (preferido pós-Fase 1):** Atlassian MCP cobre o Jira (sem
     token); Ideal Lab MCP cobre o check-in (sem cookie). Bitbucket não é
     coberto pelo conector Atlassian → token `ATATT` ou resumo só do Jira.
4. **Teste de validação** antes de agendar (mesmos checks do `/testar`).
5. Cria a **rotina agendada** via `/schedule` com o prompt template do
   check-in (guardas → coleta → geração → envio → notificação).
6. Instrui o passo manual: allowlist de egress do environment da rotina
   (api.telegram.org, lab.idealtrends.io, Atlassian) — só via UI do claude.ai.

**Entregáveis:** `SKILL.md` + template do prompt da rotina + seção no README.
A skill pode ser lançada só com o cenário A antes da Fase 1 ficar pronta.

## Fase 3 — `project_key` no Bitbucket + paginação

**Onde:** `auto_activity.py`, `extension/lib.js`, `config.json.example`,
form `/setup` do worker.

- Novo campo `bitbucket.project_key`: filtra repos por project do Bitbucket
  (`/2.0/repositories/{ws}?q=project.key="X"`) — um campo em vez de enumerar
  N repos (caso idealplus).
- Corrigir a auto-descoberta: paginar além do `pagelen=100` (hoje trunca
  workspaces com >100 repos silenciosamente).
- Precedência: `repositories` explícito > `project_key` > todos (paginado).

## Fase 4 — Roteamento multi-iniciativa

**Onde:** `auto_activity.py`/`checkin.sh`, espelho na extensão e no template
da rotina.

- Mapa no config (configuração única por projeto, não por sprint):

  ```json
  "initiatives": [
    { "id": 6,  "jira_projects": ["AUD"], "bb_project_key": "IDEALPLUS" },
    { "id": 17, "jira_projects": ["SI"],  "repos": ["solucoesindustriais.com.br"] }
  ]
  ```

- Roteamento: extrai o project key do Jira da issue e do branch/mensagem de
  commit (padrão `KEY-123`); fallback pelo repo. Gera resumo e faz **um submit
  por iniciativa com atividade**; um ✅ no canal por form enviado.
- Iniciativa sem atividade no dia: **pula** (fica pendente no Lab).
- Atividade não mapeada: iniciativa default + aviso no canal.
- Mapa vazio = comportamento atual (uma iniciativa padrão) — quem tem um
  projeto só não configura nada.
- **4b (UX):** ao detectar project key desconhecido, o bot cruza por nome com
  as iniciativas vinculadas do dev (cards da página diária) e propõe o
  mapeamento por botão inline no Telegram — entrar em projeto novo vira
  confirmar um toque.

## Fase 5 — Canais de notificação alternativos

- **5a (zero infra):** `chrome.notifications` na extensão + botão "Pular
  amanhã" local (storage); subcomando `checkin.sh pular DD/MM` (arquivo
  local) para o CLI; rotina cloud envia e-mail pelo conector Gmail do próprio
  dev.
- **5b (se houver demanda real de e-mail no cron local):** endpoint
  `POST /notify` autenticado no worker — runner manda o texto, worker resolve
  o canal do dev (Telegram ou e-mail via API tipo Resend/SendGrid, conta
  dedicada apenas como remetente). **Um segredo, num lugar só**; bônus: tira o
  `bot_token` de circulação dos configs dos devs.
  - Decisão registrada: **não** distribuir credencial SMTP nos runners; o mix
    Gmail/Outlook dos destinatários é irrelevante para o envio.

---

## Dependências e ordem

```
F1 (MCP Lab) ──────────┐
                       ├──> F2 cenário B (zero-credencial)
F2 cenário A ──────────┘         │
F3 (project_key) ──> F4 (multi-iniciativa) ──> F4b (mapeamento via bot)
F5a (independente)   F5b (após adoção, se necessário)
```

- F1 corre em paralelo no repo do Lab; F2 pode lançar antes só com cenário A.
- F3 antes de F4 (o roteamento reusa o filtro por project).
- **Rollout:** piloto com 1–2 devs (incluindo o que já testou o Telegram) →
  ajustes → anúncio para o time com a skill como porta de entrada.
