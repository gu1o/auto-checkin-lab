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

## Fase 1 — ~~Tool `submit-daily-checkin` no MCP do Ideal Lab~~ (descartada)

**Decisão (2026-07-16): não haverá mudanças na plataforma Lab.** O envio
continua pelo fluxo HTTP com o cookie `remember_web` (comprovado pela rotina
em produção). Para atacar a dor real do cookie — a coleta manual no DevTools —
a fase foi substituída por:

- **Captura automática do cookie no export da extensão** ✅ *(implementada)*:
  o "Exportar config.json" lê o `remember_web` da sessão viva do navegador e
  inclui em `lab.cookie_name/cookie_value`. O dev loga no Lab e exporta —
  DevTools sai do fluxo. Renovação = relogar + re-exportar + rodar a skill.

## Fase 2 — Skill `/setup-checkin` ✅ *(implementada em 2026-07-16)*

**Onde:** este repo (`.claude/skills/setup-checkin/SKILL.md`). O dev clona,
abre o Claude Code e roda a skill.

Fluxo da skill:

1. Pergunta o **modo** (rotina cloud / extensão / CLI+cron) e o **canal de
   notificação** (Telegram / e-mail / navegador / nenhum).
2. Registro no bot (se Telegram): `/start` no @CheckInLabBot → aprovação do
   admin → chat_id.
3. **Credenciais — via export da extensão:** o dev preenche o form visual da
   extensão (que valida com os botões de teste) e usa **Exportar config.json**
   (já com o cookie do Lab embutido); a skill detecta o arquivo e não pede
   nada de novo. *Nota:* o Atlassian MCP pode dispensar o token do Jira para
   quem tem o conector — açúcar opcional, não pilar (o cenário zero-credencial
   caiu junto com a Fase 1).
4. **Teste de validação** antes de agendar (mesmos checks do `/testar`).
5. Cria a **rotina agendada** via `/schedule` com o prompt template do
   check-in (guardas → coleta → geração → envio → notificação).
6. Instrui o passo manual: allowlist de egress do environment da rotina
   (api.telegram.org, lab.idealtrends.io, Atlassian) — só via UI do claude.ai.

**Entregáveis:** `SKILL.md` (com template do prompt da rotina embutido, já
suportando roteamento multi-iniciativa via `initiative_config` do export) +
seção no README/guia.

## Fase 3 — `project_key` no Bitbucket + paginação ✅ *(implementada em 2026-07-17)*

**Onde:** `auto_activity.py`, `extension/lib.js` (+ `popup.js`/`popup.html`),
`config.json.example`, form `/setup` do worker.

- Novo campo `bitbucket.project_key`: filtra repos por project do Bitbucket
  (`/2.0/repositories/{ws}?q=project.key="X"`) — um campo em vez de enumerar
  N repos (caso idealplus). Presente no config, no export/import da extensão
  (campo "Project key") e no form `/setup`.
- Auto-descoberta agora **pagina** seguindo o campo `next` da resposta (teto de
  50 páginas) — antes `pagelen=100` truncava workspaces com >100 repos em
  silêncio. Helper único `listWorkspaceRepos` na extensão (reusado pela
  sugestão de iniciativas).
- Precedência: `repositories` explícito > `project_key` > todos (paginado).

## Fase 4 — Roteamento multi-iniciativa ✅ *(implementada em 2026-07-17, runner script/extensão)*

**Onde:** `auto_activity.py` (`route_activity`) + `checkin.sh` (`cmd_auto`
itera um submit por iniciativa) e espelho na extensão (`lib.js` `routeActivity`
+ `runAutoCheckin`). Rotina cloud já roteava por lógica de prompt.

- **Schema (reconciliado com o que já existia na extensão):** em vez do array
  `initiatives` proposto, usa-se o `initiative_config` que a extensão já grava
  e exporta — mapas por id de iniciativa:

  ```json
  "initiative_config": {
    "repos":    { "6": "idealplus-api, outra-repo", "17": "solucoesindustriais.com.br" },
    "projects": { "6": "AUD", "17": "SI" }
  }
  ```

- Roteamento: issue do Jira pela project key (prefixo de `KEY-123`); commit
  pelo repo, com **fallback** para a project key achada na mensagem do commit
  (`\bKEY-\d+\b`). Faz **um submit por iniciativa com atividade**; um ✅ no
  canal por form enviado. (Python e extensão validados com paridade de saída.)
- Iniciativa sem atividade no dia: **pula** (fica pendente no Lab).
- Atividade não mapeada: iniciativa default (`--initiative`, padrão 6) + aviso
  ⚠️ no canal.
- Mapa vazio = comportamento atual (uma iniciativa padrão) — quem tem um
  projeto só não configura nada.
- **Refinamento (evita regressão):** dia sem *nenhuma* atividade mapeada ainda
  garante o submit da iniciativa padrão (template "sem atividades"), para quem
  ativa o multi-iniciativa não deixar de bater ponto em dia quieto.
- **4b (UX) ✅ *(implementada em 2026-07-17, na extensão)*:** o roteamento
  agora expõe os project keys / repos **não mapeados** (em `route_activity` e no
  `routeActivity`, e nomeados no aviso ⚠️ dos dois runners). Na extensão, o
  botão **"🔍 Detectar projetos novos"** cruza cada chave desconhecida por nome
  com as iniciativas do dev (cards da página diária) e propõe o vínculo — um
  toque em **Vincular** grava no `initiative_config` e salva. *Nota de escopo:*
  o "toque" vive na UI da extensão (self-contained), não no botão inline do
  Telegram — a versão via bot depende do worker ser o runner (Fase 6, fora
  deste rollout).

## Fase 5 — Canais de notificação alternativos ✅ *(implementada em 2026-07-17)*

- **5a (zero infra) ✅:** `chrome.notifications` na extensão (com botão "Pular
  amanhã" na própria notificação) + botão "Pular amanhã" no popup (storage);
  subcomandos `checkin.sh pular/retomar/pulos DD/MM` (arquivo local
  `.skips.json`, respeitado pelo `cmd_auto`) para o CLI; rotina cloud envia
  e-mail pelo conector Gmail do próprio dev (passo documentado na skill).
- **5b ✅:** endpoint `POST /notify` autenticado (`x-notify-secret` ==
  `NOTIFY_SECRET`) no worker — runner manda `{chatId, text}`, worker entrega por
  Telegram (e por e-mail via Resend se o dev tiver `prefs.email` e o worker
  tiver `RESEND_API_KEY`). **Um segredo, num lugar só**; tira o `bot_token` dos
  configs — `checkin.sh notify()` e o `telegramNotify` da extensão usam o
  `/notify` quando `notify.url`+`notify.secret` estão setados, com fallback
  para envio direto.
  - Decisão mantida: **não** distribuir credencial SMTP nos runners; o mix
    Gmail/Outlook dos destinatários é irrelevante para o envio.

---

## Dependências e ordem

```
F1 descartada (cookie no export ✅ substitui)
F2 skill ✅ ──> piloto com devs
F3 (project_key + paginação) ✅ ──> F4 no script/extensão (multi-iniciativa) ✅ ──> F4b (mapeamento assistido na extensão) ✅
F5a ✅ (independente)   F5b ✅
```

- A rotina criada pela skill **já roteia multi-iniciativa** (é lógica de
  prompt); F4 nos runners script/extensão ✅ concluída.
- F3 antes de F4 (o roteamento reusa o filtro por project).
- **Rollout:** piloto com 1–2 devs (incluindo o que já testou o Telegram) →
  ajustes → anúncio para o time com a skill como porta de entrada.
