# CLAUDE.md

Repo do check-in diário de **Saúde da Entrega** (Ideal Lab). Quando o dev pedir
algo em linguagem natural ("pula meu check-in de sexta", "já enviei hoje?"),
traduza para os comandos abaixo e **rode** — não mande ele digitar.

## Comandos do dia a dia (`./checkin.sh`)

| O dev pede | Comando |
|---|---|
| "pula meu check-in de sexta" / "não vou trabalhar dia 5" | `./checkin.sh pular 05/09` (aceita `hoje`, `amanha`, `DD/MM`, `YYYY-MM-DD`) |
| "voltei, desfaz o pulo" | `./checkin.sh retomar 05/09` |
| "quais dias estão pulados?" | `./checkin.sh pulos` |
| "já preencheram o check-in de hoje?" | `./checkin.sh status` |
| "manda meu check-in" (texto escrito por ele) | `./checkin.sh submit --yesterday "..." --today "..." [--confidence 1-5] [--initiative ID]` |
| "gera e manda sozinho" | `./checkin.sh auto [--initiative ID]` — use `--dry-run` primeiro e mostre o preview |
| "meu filtro de repositório está pegando o quê?" | `./checkin.sh repos [PADRAO]` (só leitura) |

`./checkin.sh` sem argumento imprime o help completo com todas as flags.

### Pular dias: sempre confirme o espelho na nuvem

`pular`/`retomar`/`pulos` gravam em `.skips.json` (lido pelo cron local) **e**
espelham no worker (`POST /skips` → `skips:<e-mail>`), que é de onde a **rotina
da nuvem** lê antes de rodar. O espelho só acontece com `notify.url` +
`notify.secret` + `notify.email` no `config.json`; sem os três o comando grava
local e fica **calado** sobre a nuvem.

Por isso: depois de rodar, procure a linha `Skips na nuvem: ...` na saída e
repita-a ao dev. **Se ela não aparecer, diga explicitamente que a rotina vai
rodar naquele dia mesmo assim** e ofereça `./checkin.sh pulos` para reenviar.
Fim de semana e datas passadas são descartados pelo worker — a lista de volta é
o que vale de fato.

Isso só funciona com o repo clonado e o `config.json` presente. Numa sessão do
claude.ai (Claude Code na web) o `config.json` não existe — está no
`.gitignore` — então o skip **não** sobe: avise o dev em vez de tentar.

## Bot do Telegram (@CheckInLabBot)

Quem tem Telegram usa o bot; são comandos que **o dev manda no chat**, não algo
que você roda: `/pular`, `/retomar`, `/pulos` (calendário Mini App), `/testar`,
`/config`, `/repos`, `/painel`, `/agora`, `/dryrun`, `/aprovar`, `/runner`,
`/cancelar`. Código em `worker/worker.js` (deploy é do admin).

## Setup e atualização

- Configurar/reconfigurar/renovar cookie → skill `/setup-checkin`.
- Depois de um `git pull`, o hook `SessionStart` compara `CHANGELOG.md` com
  `.checkin-version` e avisa o que mudou. Tags: `[rotina]` = a rotina do
  claude.ai precisa ser reescrita; `[local]` = o `config.json` ou o `crontab` do
  dev precisa de ajuste — ambas resolvidas pela skill em modo atualização;
  `[cli]`/`[extensão]` = o pull já resolveu; `[worker]` = deploy do admin, o dev
  não faz nada.
- Os três modos de uso (extensão / rotina na nuvem / cron local) estão em
  `docs/guia-setup-dev.md`.

## Regras

- **Nunca imprima** tokens, cookies ou o conteúdo de `config.json`/`cookies.txt`
  no chat — refira-se a "o token do Jira", "o cookie do Lab".
- `config.json`, `cookies.txt` e `.skips.json` são gitignorados. Não commite.
- Testes: `node worker/test_pular.mjs`, `test_notify.mjs`, `test_draft.mjs` e
  `python3 test_author_filter.py`.
