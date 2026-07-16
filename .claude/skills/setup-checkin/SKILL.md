---
name: setup-checkin
description: Configura o check-in automático diário da Saúde da Entrega (Ideal Lab) para o dev atual — importa o config.json exportado pela extensão, valida todas as credenciais e cria a rotina agendada na conta do próprio dev. Use quando o dev quiser ativar, reconfigurar ou renovar credenciais do check-in automático.
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

## 1. Obter o config.json

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
credenciais na nuvem).

## 4. Validar credenciais e descobrir iniciativas

Execute os checks abaixo (via curl/fetch) e mostre um relatório ✅/❌. Todos
são somente-leitura.

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

## 5. Definir agenda e iniciativas

Pergunte ao dev (com defaults):

- **Horário** do check-in (default 09:30, seg–sex; a rotina pula fim de
  semana/feriado sozinha de qualquer forma).
- **Iniciativa(s)**: mostre as encontradas no Lab. Uma só → essa é a padrão.
  Mais de uma em que ele trabalha → monte o mapa por iniciativa
  (`initiative_config` do export já pode trazer repos/projetos Jira por
  iniciativa — confirme com o dev) e defina uma default para atividade não
  mapeada.

## 6. Criar a rotina

Monte o prompt da rotina a partir do template abaixo, preenchendo os
placeholders com os dados do config (as credenciais entram no corpo da rotina,
que é privada da conta do dev). Em seguida crie a rotina com a skill
`schedule`: diária, seg–sex, no horário escolhido, timezone
`America/Sao_Paulo`, nome `lab-checkin`.

```text
Você preenche meu check-in diário de Saúde da Entrega no Ideal Lab.

Credenciais: Jira {URL} (email {EMAIL}, token {JIRA_TOKEN}); Bitbucket
workspace {WORKSPACE} (token {BB_TOKEN}); cookie do Lab
{COOKIE_NAME}={COOKIE_VALUE}; Telegram bot {BOT_TOKEN}, chat {CHAT_ID}.
[omitir a linha do Telegram se não configurado]

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
(repositórios: {REPOS_OU_TODOS}; filtre commits pelo meu usuário).

Gerar: em 1ª pessoa, objetivo, sem inventar: "Ontem" (o que fiz) e "Hoje"
(o que farei). Se o último dia útil foi feriado/fim de semana, "Ontem" vai
em branco.

[SE MULTI-INICIATIVA] Roteamento: agrupe a atividade pelo project key do
Jira presente na issue e no nome do branch/mensagem do commit (padrão
KEY-123), usando o mapa: {MAPA id -> jira_projects/repos}. Gere e envie um
check-in POR iniciativa com atividade; iniciativas sem atividade hoje não
recebem envio; atividade sem mapeamento vai para a iniciativa {DEFAULT} —
mencione isso na notificação.

Enviar (por iniciativa): POST em /saude-entrega/daily — renove a sessão com
um GET (o Set-Cookie devolve XSRF-TOKEN), mande o XSRF url-decodificado no
header x-xsrf-token, headers x-inertia: true e x-requested-with:
XMLHttpRequest; sucesso = HTTP 302. Body JSON: initiative_id, checkin_date
(hoje, YYYY-MM-DD), yesterday_text, today_text, confidence_score: 5,
blockers_text: "", yesterday_artifact_url: "".

Notificar [se Telegram]: sendMessage — ✅ com o resumo enviado (um por
iniciativa) em sucesso; ❌ com a causa provável em falha (se for o cookie
expirado, diga: "logue no Lab, exporte o config.json na extensão e rode
/setup-checkin de novo").
```

## 7. Pós-setup (passos manuais do dev)

1. **Allowlist de egress** do environment da rotina (só pela UI do claude.ai:
   ícone do environment → engrenagem): liberar `lab.idealtrends.io`,
   `api.telegram.org`, `*.atlassian.net` e `api.bitbucket.org`.
2. **Teste real**: dispare uma execução manual da rotina (UI de routines) num
   dia em que o check-in ainda não foi preenchido; confira o form no Lab e a
   notificação. Alternativa sem esperar: rode agora os checks da etapa 4 de
   novo e um dry-run (gerar o texto sem POST) mostrando ao dev o que seria
   enviado.
3. Lembre o dev: cookie expirou → ❌ no Telegram → logar no Lab → re-exportar
   na extensão → rodar `/setup-checkin` de novo (a skill atualiza a rotina).
