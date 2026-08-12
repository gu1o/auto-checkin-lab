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
