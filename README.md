# Check-in automático — Saúde da Entrega (Ideal Lab)

Script em bash que preenche o check-in diário de **Saúde da Entrega** no Ideal Lab
(`https://lab.idealtrends.io/saude-entrega/daily`) via HTTP, sem navegador.

## Arquivos

| Arquivo | Descrição |
|---|---|
| `checkin.sh` | O script (subcomandos `status` e `submit`) |
| `cookies.txt.example` | Template do cookie jar — copie para `cookies.txt` e preencha |
| `README.md` | Este guia |

## Requisitos

- `bash`, `curl` e `python3` (usados para parsear o JSON do Inertia e decodificar o token CSRF)
- Uma conta no Ideal Lab com acesso à página de Saúde da Entrega

## Configuração (uma vez)

O script autentica com o cookie **`remember_web_*`** do Laravel, que é de longa duração.
Para obtê-lo:

1. Faça login normalmente em `https://lab.idealtrends.io` no navegador (marque "lembrar de mim", se houver).
2. Abra o DevTools (F12) → aba **Application/Storage** → **Cookies** → `https://lab.idealtrends.io`.
3. Localize o cookie cujo nome começa com `remember_web_` (o sufixo é um hash fixo da aplicação)
   e copie **nome completo** e **valor** (o valor é longo e termina em `%3D` — copie url-encoded, como está).
4. Copie o template e preencha:

   ```bash
   cp cookies.txt.example cookies.txt
   # edite cookies.txt e substitua NOME_DO_COOKIE e VALOR_DO_COOKIE
   chmod 600 cookies.txt
   ```

   O formato é Netscape, **separado por TAB** (cuidado para o editor não converter em espaços):

   ```
   # Netscape HTTP Cookie File
   lab.idealtrends.io	FALSE	/	TRUE	2082758400	remember_web_XXXX	VALOR
   ```

5. Teste:

   ```bash
   ./checkin.sh status
   ```

   Saída esperada: seu nome, a data de hoje e um card por iniciativa (`[OK]` enviado / `[--]` pendente).

A cada execução o script faz um GET na página para renovar a sessão (`ceo_vision_ia_session`)
e obter um `XSRF-TOKEN` fresco — ambos são gravados de volta no `cookies.txt` automaticamente.
Você só precisa renovar o `remember_web` manualmente se ele expirar ou se fizer logout no navegador.

## Uso

```bash
# Ver o estado dos check-ins de hoje
./checkin.sh status

# Enviar (ou atualizar) o check-in do dia
./checkin.sh submit \
  --yesterday "O que foi feito no último dia útil" \
  --today "O que será feito hoje" \
  [--confidence N]        # 1-5, padrão 5
  [--blockers "TEXTO"]    # padrão "Nenhum"
  [--artifact URL]        # URL de PR/artefato, padrão vazio
  [--initiative ID]       # padrão 6 = Auditoria Ideal
  [--date YYYY-MM-DD]     # padrão hoje
```

O POST faz **upsert**: reenviar no mesmo dia atualiza o registro existente, não duplica.
Sucesso = HTTP 302 (redirect padrão do Inertia).

## Solução de problemas

| Sintoma | Causa provável | Correção |
|---|---|---|
| `ERRO: nao consegui obter XSRF-TOKEN` | Sessão/cookie expirado | Renove o `remember_web` no navegador e atualize o `cookies.txt` (passos 1–4) |
| `curl` falha no GET (exit != 0) | Cookie inválido ou sem rede | Idem acima; confira conectividade com o Lab |
| `POST retornou HTTP 419` | CSRF rejeitado | Rode de novo (o GET renova o token); persiste → renovar cookie |
| `POST retornou HTTP 422` | Payload inválido | Confira os campos obrigatórios `--yesterday` e `--today` |
| Status mostra `[--]` após envio | Enviou para outra iniciativa/data | Confira `--initiative` e `--date` |

## Complemento: rotina agendada na nuvem (opcional)

Além do uso manual, existe uma **rotina do Claude Code** (claude.ai/code → Routines) que roda
em dias úteis às 10h (BRT) e preenche o check-in sozinha: pula feriados de SP, sai sem alterar
nada se o dia já foi preenchido manualmente, coleta a atividade real (commits/PRs no Bitbucket +
tasks no Jira) e compõe os textos no estilo do usuário, sem citar códigos de task.

Pontos de atenção ao replicar essa rotina:

- **Egress**: o sandbox das rotinas bloqueia domínios fora do allowlist. Crie/edite o environment
  com *Network access = Custom* liberando `lab.idealtrends.io`, `brasilapi.com.br`,
  `api.bitbucket.org` e `bitbucket.org` (config apenas pela UI, no ícone do environment).
- **Credenciais**: o cookie `remember_web` e o API token Atlassian (para a API do Bitbucket)
  ficam embutidos no prompt da rotina. Se trocar o token ou renovar o cookie, atualize o prompt.
- **Conectores MCP**: a rotina usa os conectores *Atlassian* e *Ideal Lab* do claude.ai
  (o tráfego MCP não passa pelo proxy de egress).
