# Check-in Automático — Saúde da Entrega (Ideal Lab)

Script e Extensão do Chrome para preencher e auditar o check-in diário de **Saúde da Entrega** no Ideal Lab (`https://lab.idealtrends.io/saude-entrega/daily`).

> **É novo por aqui?** Comece pelo **[guia de setup para devs](docs/guia-setup-dev.md)** — ele compara os três modos de usar (extensão, rotina no Claude Code ou CLI+cron), lista as credenciais necessárias e traz o passo a passo de cada um. A escolha do modo é sua.

---

## 📂 Estrutura de Arquivos

| Arquivo/Diretório | Descrição |
|---|---|
| `checkin.sh` | CLI principal (subcomandos `status`, `submit` e `auto`) |
| `auto_activity.py` | Script auxiliar que busca tarefas no Jira, commits no Bitbucket e sintetiza textos usando Gemini |
| `config.json.example` | Template de configuração para as integrações do Jira, Bitbucket, Gemini/Claude e Telegram |
| `extension/` | Código fonte da Extensão do Chrome (auditoria/envio manual + modo automático via `chrome.alarms`; `lib.js` compartilhado entre `popup.js` e `background.js`) |
| `cookies.txt.example` | Template do cookie jar para uso exclusivo via CLI |
| `worker/` | Cloudflare Worker do bot do Telegram (@CheckInLabBot), **multi-usuário**: auto-registro `/start` + aprovação do admin (Workers KV), `/pular`, `/retomar`, `/pulos`, `/testar` (valida as credenciais salvas contra Jira, Bitbucket, Lab e IA — somente leitura, nada é enviado ao Lab) e `/config` (formulário one-time-link para credenciais, criptografadas com AES-GCM; após salvar, a página oferece um botão **🧪 Testar credenciais**) |
| `telegram_poller.py` | Alternativa local ao worker (long-polling via systemd) — desativado enquanto o webhook estiver ativo |
| `docs/telegram-integration.md` | Arquitetura da integração com o Telegram (notificações + bot) |
| `docs/plano-compartilhamento.md` | Plano para abrir a automação para o time (multi-usuário, extensão como hub, motor Gemini/Claude, modo automático) |
| `docs/plano-rollout-time.md` | Escopo consolidado do rollout para o time: skill `/setup-checkin`, tool MCP `submit-daily-checkin` no Lab, `project_key` do Bitbucket, roteamento multi-iniciativa e canais de notificação |
| `docs/guia-setup-dev.md` | **Guia de setup para o dev**: tabela de decisão entre os modos (extensão / rotina Claude Code / CLI), credenciais, prompt template da rotina e troubleshooting |

---

## 💻 Opção 1: Extensão do Chrome (Interface Gráfica + Auditoria)

Esta é a opção recomendada caso você prefira **revisar e auditar** os textos gerados antes de enviá-los ao Ideal Lab, eliminando totalmente a necessidade de copiar cookies manualmente.

### 🔧 Instalação:
1. Abra o Google Chrome e navegue até `chrome://extensions/`.
2. No canto superior direito, ative a opção **Modo do desenvolvedor** (Developer mode).
3. Clique em **Carregar sem compactação** (Load unpacked) no canto superior esquerdo.
4. Selecione a pasta `extension` deste projeto (`/Users/marcone/Downloads/lab-checkin/extension`).

### 🚀 Como usar:
1. Clique no ícone da extensão na barra de ferramentas do Chrome.
2. Acesse a aba **Configurações** e preencha suas credenciais do Jira, Bitbucket e da IA. As credenciais ficam salvas de forma segura no storage local do seu próprio navegador.
   - **Motor de Geração (IA)**: escolha o provider — **Gemini** (free tier, default) ou **Claude** (API da Anthropic; cada dev usa a própria API key, chamada direta do browser).
   - **Telegram** (opcional): token do bot (compartilhado no time) + seu `chat_id` (mande `/start` pro **@CheckInLabBot** — ele te responde já registrado, após aprovação do admin). Habilita notificações e o `/pular`. Use o botão **🧪 Enviar mensagem de teste** para validar o token/chat_id na hora (ou mande `/testar` no chat do bot).
   - **Iniciativa padrão** e **horário** do modo automático.
3. Na aba **Check-in**, selecione a iniciativa e clique em **Gerar Rascunho**. O rascunho de *Ontem* e *Hoje* será carregado automaticamente com base nas APIs.
4. Revise os textos e clique em **Enviar Check-in**!
5. **Autenticação automática**: A extensão lê a sessão ativa diretamente do seu navegador, dispensando qualquer configuração de arquivo `cookies.txt`.
6. **Modo automático** (opcional): com o toggle ligado, um alarme diário (`chrome.alarms`) roda o check-in sozinho no horário configurado — mesmas guardas do CLI (fim de semana → feriado → `/pular` → já preenchido) — usando a sessão viva do navegador. Só precisa do Chrome aberto; se a sessão do Lab expirar, você é avisado no Telegram (❌).
7. **Exportar config.json**: gera e baixa o arquivo no formato do `config.json.example` com o que está configurado na extensão — a ponte para quem também roda o CLI/cron.

---

## 🐚 Opção 2: CLI principal (`checkin.sh`)

Permite a automação total via terminal ou tarefas agendadas (Cron).

### ⚙️ Configuração Única (Autenticação do Lab):
O CLI autentica utilizando o cookie `remember_web_*` do Laravel.

1. Faça login em `https://lab.idealtrends.io` no navegador.
2. Abra o DevTools (F12) → **Application/Storage** → **Cookies** → `https://lab.idealtrends.io`.
3. Copie o nome completo do cookie `remember_web_*` e seu valor.
4. Copie o template e preencha:
   ```bash
   cp cookies.txt.example cookies.txt
   # Edite cookies.txt e substitua NOME_DO_COOKIE e VALOR_DO_COOKIE
   chmod 600 cookies.txt
   ```
5. Teste o status:
   ```bash
   ./checkin.sh status
   ```

### ⚙️ Configuração do Jira / Bitbucket / Gemini:
1. Crie o arquivo de configurações:
   ```bash
   cp config.json.example config.json
   ```
2. Abra o `config.json` e insira suas credenciais:
   - **Jira**: Insira a URL, seu e-mail e seu API Token do Atlassian.
   - **Bitbucket**: Insira seu Workspace, o repositório, o seu nome de usuário (para filtro) e o API Token da Atlassian (com a permissão `Repositories: Read`).
   - **Gemini**: Insira sua chave de API gerada no Google AI Studio.
   - **Telegram** (opcional): bot token (via @BotFather) e chat ID para receber notificações do modo `auto` — ✅ quando o check-in for enviado (com o resumo gerado) e ❌ quando falhar (ex.: cookie `remember_web` expirado). Deixe em branco para desativar; os pulos (fim de semana, feriado, já preenchido) não notificam. Detalhes em `docs/telegram-integration.md`.

### 🚀 Uso da CLI:

#### Modo Automático (Consulta APIs + IA):
O subcomando `auto` coleta seus dados das APIs, resume usando IA e realiza a postagem:
```bash
# Simula a geração automática sem postar (mostra o preview)
./checkin.sh auto --initiative 17 --dry-run

# Executa e envia de verdade
./checkin.sh auto --initiative 6
```

* **Inteligência de Feriados**: O modo automático ignora finais de semana e feriados (incluindo cálculo dinâmico de feriados móveis como Carnaval, Sexta-feira Santa e Corpus Christi, além de feriados federais e de SP). 
* **Respeita o `/pular`**: se o dia foi cancelado via `/pular` no @CheckInLabBot (mensagem fixada no chat, lida via `getChat` com o `telegram` do `config.json`), o script não preenche e avisa no Telegram (🚫). Sem Telegram configurado, a checagem é pulada; falha na chamada não bloqueia o check-in.
* **Ontem Vazio**: Se o dia anterior foi um feriado ou fim de semana, a seção `ONTEM` será automaticamente enviada em branco.
* **Sem Duplicidade**: Se o check-in do dia já foi preenchido, o script pula a execução para evitar sobrescrever dados manuais.

#### Modo Manual (Envio Direto):
```bash
./checkin.sh submit \
  --yesterday "Implementei a tela de relatórios" \
  --today "Ajustes de bugs e deploy" \
  --confidence 5 \
  --initiative 6
```
