# Check-in Automático — Saúde da Entrega (Ideal Lab)

Script e Extensão do Chrome para preencher e auditar o check-in diário de **Saúde da Entrega** no Ideal Lab (`https://lab.idealtrends.io/saude-entrega/daily`).

---

## 📂 Estrutura de Arquivos

| Arquivo/Diretório | Descrição |
|---|---|
| `checkin.sh` | CLI principal (subcomandos `status`, `submit` e `auto`) |
| `auto_activity.py` | Script auxiliar que busca tarefas no Jira, commits no Bitbucket e sintetiza textos usando Gemini |
| `config.json.example` | Template de configuração para as integrações do Jira, Bitbucket e Gemini |
| `extension/` | Código fonte da Extensão do Chrome (Interface Gráfica com Auditoria) |
| `cookies.txt.example` | Template do cookie jar para uso exclusivo via CLI |
| `worker/` | Cloudflare Worker do bot do Telegram (@CheckInLabBot): comandos `/pular`, `/retomar`, `/pulos` via webhook |
| `telegram_poller.py` | Alternativa local ao worker (long-polling via systemd) — desativado enquanto o webhook estiver ativo |
| `docs/telegram-integration.md` | Arquitetura da integração com o Telegram (notificações + bot) |
| `docs/plano-compartilhamento.md` | Plano para abrir a automação para o time (multi-usuário, extensão como hub, motor Gemini/Claude, modo automático) |

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
2. Acesse a aba **Configurações** e preencha suas credenciais do Jira, Bitbucket e Gemini API Key. As credenciais ficam salvas de forma segura no storage local do seu próprio navegador.
3. Na aba **Check-in**, selecione a iniciativa e clique em **Gerar Rascunho**. O rascunho de *Ontem* e *Hoje* será carregado automaticamente com base nas APIs.
4. Revise os textos e clique em **Enviar Check-in**!
5. **Autenticação automática**: A extensão lê a sessão ativa diretamente do seu navegador, dispensando qualquer configuração de arquivo `cookies.txt`.

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
