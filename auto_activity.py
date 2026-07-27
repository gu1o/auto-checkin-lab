#!/usr/bin/env python3
import os
import sys
import json
import re
import urllib.request
import urllib.parse
import base64
import datetime

# Padrao de chave de issue do Jira em texto livre (branch/commit), ex: AUD-123.
PROJECT_KEY_RE = re.compile(r'\b([A-Z][A-Z0-9]+)-\d+\b')

def log(msg):
    print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr)

def get_last_business_day():
    today = datetime.date.today()
    # 0 = Monday, ..., 6 = Sunday
    weekday = today.weekday()
    if weekday == 0:  # Monday
        days = 3
    elif weekday == 6:  # Sunday
        days = 2
    else:
        days = 1
    return today - datetime.timedelta(days=days)

def calculate_easter(year):
    # Algoritmo de Meeus/Jones/Butcher para calcular a Pascoa
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return datetime.date(year, month, day)

def get_sp_and_national_holidays(year):
    holidays = set()
    
    # Feriados estaticos (Nacionais, Estaduais de SP e Municipais da Capital)
    static_dates = [
        "01-01",  # Confraternizacao Universal
        "01-25",  # Aniversario de Sao Paulo
        "04-21",  # Tiradentes
        "05-01",  # Dia do Trabalho
        "07-09",  # Revolucao Constitucionalista (SP)
        "09-07",  # Independencia do Brasil
        "10-12",  # Nossa Senhora Aparecida
        "11-02",  # Finados
        "11-15",  # Proclamacao da Republica
        "11-20",  # Consciencia Negra
        "12-25",  # Natal
    ]
    for d in static_dates:
        month, day = map(int, d.split("-"))
        holidays.add(datetime.date(year, month, day))
        
    # Feriados moveis baseados no cálculo da Pascoa
    easter = calculate_easter(year)
    carnaval = easter - datetime.timedelta(days=47)
    sexta_santa = easter - datetime.timedelta(days=2)
    corpus_christi = easter + datetime.timedelta(days=60)
    
    holidays.add(carnaval)
    holidays.add(sexta_santa)
    holidays.add(corpus_christi)
    
    # Consulta a BrasilAPI como redundancia para feriados nacionais
    try:
        url = f"https://brasilapi.com.br/api/feriados/v1/{year}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as res:
            api_holidays = json.loads(res.read().decode("utf-8"))
            for h in api_holidays:
                parts = list(map(int, h.get("date").split("-")))
                holidays.add(datetime.date(parts[0], parts[1], parts[2]))
    except Exception:
        pass
        
    return holidays

def is_holiday(date_to_check):
    holidays = get_sp_and_national_holidays(date_to_check.year)
    return date_to_check in holidays

def make_request(url, headers=None, method="GET", data=None):
    if headers is None:
        headers = {}
    
    req_data = None
    if data is not None:
        if isinstance(data, (dict, list)):
            req_data = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif isinstance(data, str):
            req_data = data.encode("utf-8")
        else:
            req_data = data

    req = urllib.request.Request(url, headers=headers, method=method, data=req_data)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.read().decode("utf-8")
    except Exception as e:
        log(f"Request failed to {url}: {e}")
        return None


def _repo_matches(pattern, repo):
    """Casa `pattern` contra o slug `repo`: exato (case-insensitive) ou regex
    (re.search, case-insensitive). Padrao invalido como regex cai para
    comparacao de substring, para nunca quebrar a coleta por um regex ruim."""
    if not pattern:
        return False
    p, r = pattern.strip(), repo.strip()
    if p.lower() == r.lower():
        return True
    try:
        return re.search(p, r, re.IGNORECASE) is not None
    except re.error:
        return p.lower() in r.lower()


def _select_repos(universe, patterns, exclude):
    """Seleciona repos do `universe` (slugs do workspace) casando `patterns`
    (regex/substring). Sem patterns => todos. Aplica `exclude` por fim.

    Retorna (selected, unmatched): unmatched = padroes que nao casaram com nada
    (viram warning para o dev ajustar o mapeamento).
    """
    if patterns:
        selected = [r for r in universe if any(_repo_matches(p, r) for p in patterns)]
        unmatched = [p for p in patterns if not any(_repo_matches(p, r) for r in universe)]
    else:
        selected, unmatched = list(universe), []
    if exclude:
        selected = [r for r in selected if not any(_repo_matches(e, r) for e in exclude)]
    return selected, unmatched


def _bitbucket_auth_headers(config):
    """Monta os headers autenticados do Bitbucket a partir do config. Aceita
    token Atlassian (ATATT... => Basic com o e-mail do Jira), access token
    (=> Bearer) ou username+app_password (=> Basic). Retorna None se faltar
    credencial (o chamador loga e aborta a coleta do Bitbucket)."""
    bb_cfg = config.get("bitbucket", {})
    token = bb_cfg.get("api_token")
    username = bb_cfg.get("username")
    password = bb_cfg.get("app_password")
    headers = {"Accept": "application/json"}
    if token:
        if token.startswith("ATATT"):
            email = config.get("jira", {}).get("email")
            if not email:
                log("Bitbucket api_token is an Atlassian token, but no Jira email was found in configuration.")
                return None
            auth_b64 = base64.b64encode(f"{email}:{token}".encode("utf-8")).decode("utf-8")
            headers["Authorization"] = f"Basic {auth_b64}"
        else:
            headers["Authorization"] = f"Bearer {token}"
    elif username and password:
        auth_b64 = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("utf-8")
        headers["Authorization"] = f"Basic {auth_b64}"
    else:
        return None
    return headers


def _list_workspace_repos(headers, workspace, project_key=None):
    """Lista (paginado) os slugs de repositorio do workspace; filtra por
    `project_key` se informado. Retorna [] em erro/sem permissao de listagem."""
    if project_key:
        q = urllib.parse.quote(f'project.key="{project_key}"')
        repos_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=100&q={q}"
    else:
        repos_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=100"
    # Bitbucket devolve `next` (URL completa) enquanto ha mais paginas; sem
    # paginar, workspaces com >100 repos eram truncados silenciosamente.
    repos = []
    page = 0
    while repos_url and page < 50:  # teto de seguranca contra loop
        res_text = make_request(repos_url, headers)
        if not res_text:
            break
        try:
            data = json.loads(res_text)
            repos.extend(r.get("slug") for r in data.get("values", []) if r.get("slug"))
            repos_url = data.get("next")
            page += 1
        except Exception as e:
            log(f"Error parsing Bitbucket repos: {e}")
            break
    log(f"Discovered {len(repos)} repositories in workspace '{workspace}'.")
    return repos


def get_jira_activity(config, since_date):
    jira_cfg = config.get("jira", {})
    url = jira_cfg.get("url")
    email = jira_cfg.get("email")
    token = jira_cfg.get("api_token")
    
    if not (url and email and token):
        log("Jira credentials not fully configured. Skipping Jira.")
        return []
    
    url = url.rstrip("/")
    since_str = since_date.strftime("%Y-%m-%d")
    jql = f'assignee = currentUser() AND updated >= "{since_str}"'
    
    search_url = f"{url}/rest/api/3/search/jql"
    
    auth_str = f"{email}:{token}"
    auth_b64 = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
    headers = {
        "Authorization": f"Basic {auth_b64}",
        "Accept": "application/json"
    }
    
    payload = {
        "jql": jql,
        "fields": ["summary", "status", "updated", "key"]
    }
    
    log(f"Fetching Jira issues updated since {since_str}...")
    res_text = make_request(search_url, headers, method="POST", data=payload)
    if not res_text:
        return []
        
    try:
        data = json.loads(res_text)
        issues = data.get("issues", [])
        activity = []
        for issue in issues:
            fields = issue.get("fields", {})
            activity.append({
                "key": issue.get("key"),
                "summary": fields.get("summary"),
                "status": fields.get("status", {}).get("name", "Unknown"),
                "updated": fields.get("updated")
            })
        return activity
    except Exception as e:
        log(f"Error parsing Jira response: {e}")
        return []

def get_bitbucket_activity(config, since_date):
    bb_cfg = config.get("bitbucket", {})
    username = bb_cfg.get("username")
    workspace = bb_cfg.get("workspace")

    if not workspace:
        log("Bitbucket workspace not configured. Skipping Bitbucket.")
        return []

    headers = _bitbucket_auth_headers(config)
    if headers is None:
        log("Bitbucket credentials not fully configured. Skipping Bitbucket.")
        return []
    if not username:
        # Auto-detect username/nickname
        user_url = "https://api.bitbucket.org/2.0/user"
        res_text = make_request(user_url, headers)
        if res_text:
            try:
                user_data = json.loads(res_text)
                username = user_data.get("username") or user_data.get("nickname") or user_data.get("display_name")
                log(f"Auto-detected Bitbucket username: {username}")
            except Exception as e:
                log(f"Could not auto-detect Bitbucket user info: {e}")
                
    # Resolucao de repositorios. As entradas de `repositories` sao tratadas como
    # PADROES (regex/substring, case-insensitive) e casadas contra os repos do
    # workspace: assim "auditoriaideal" pega os 3 repos do projeto (e futuros)
    # sem listar slug a slug; um slug exato continua valendo (casa consigo).
    # `repositories_exclude` remove padroes (ex.: o repo antigo "...-old").
    # Sem `repositories`, mantem o comportamento anterior (project_key > todos).
    patterns = bb_cfg.get("repositories", []) or []
    exclude = bb_cfg.get("repositories_exclude", []) or []
    project_key = bb_cfg.get("project_key")
    universe = _list_workspace_repos(headers, workspace, project_key)

    if universe:
        repos, unmatched = _select_repos(universe, patterns, exclude)
        for p in unmatched:
            log(f"Warning: no repo in workspace matches pattern '{p}'. Adjust `repositories`.")
    else:
        # Nao consegui listar o workspace (permissao/erro): usa os padroes como
        # slugs literais para nao zerar a coleta (menos os do exclude).
        repos = [p for p in patterns if not any(_repo_matches(e, p) for e in exclude)]
        if repos:
            log("Could not list workspace; falling back to literal repository entries.")
    log(f"Selected {len(repos)} repositories: {', '.join(repos) if repos else '(none)'}")

    commits = []
    since_iso = since_date.isoformat()
    
    for repo in repos:
        log(f"Fetching commits for {workspace}/{repo}...")
        # Get commits for author
        commits_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}/commits?pagelen=30"
        res_text = make_request(commits_url, headers)
        if not res_text:
            continue
            
        try:
            data = json.loads(res_text)
            values = data.get("values", [])
            for c in values:
                author_raw = c.get("author", {}).get("raw", "")
                # Check author name/username matches or is blank/none (we check if username is in raw or if we just filter by since_date)
                date_str = c.get("date")
                if date_str and date_str >= since_iso:
                    # Filter by username in raw author field
                    if username.lower() in author_raw.lower() or not username:
                        commits.append({
                            "repo": repo,
                            "hash": c.get("hash")[:7] if c.get("hash") else "",
                            "message": c.get("message", "").strip().split("\n")[0],
                            "date": date_str
                        })
        except Exception as e:
            log(f"Error parsing commits for repo {repo}: {e}")
            
    return commits

def generate_text_template(jira_act, bb_act):
    # Yesterday Text
    yesterday_lines = []
    if jira_act:
        yesterday_lines.append("Tasks atualizadas:")
        for item in jira_act:
            yesterday_lines.append(f"  - [{item['key']}] {item['summary']} (Status: {item['status']})")
    if bb_act:
        yesterday_lines.append("Commits realizados:")
        for item in bb_act:
            yesterday_lines.append(f"  - [{item['repo']}] {item['message']}")
            
    if not yesterday_lines:
        yesterday_text = "Sem atividades registradas no Jira/Bitbucket."
    else:
        yesterday_text = "\n".join(yesterday_lines)
        
    # Today Text
    today_lines = []
    in_progress = [item for item in jira_act if item['status'].lower() in ["in progress", "em andamento", "doing"]]
    if in_progress:
        today_lines.append("Continuar trabalhando em:")
        for item in in_progress:
            today_lines.append(f"  - [{item['key']}] {item['summary']}")
    else:
        # Fallback to general tasks
        todo = [item for item in jira_act if item['status'].lower() not in ["done", "concluído", "closed"]]
        if todo:
            today_lines.append("Trabalhar em:")
            for item in todo[:3]:
                today_lines.append(f"  - [{item['key']}] {item['summary']}")
                
    if not today_lines:
        today_text = "Continuar as atividades pendentes e atuar em novas demandas do board."
    else:
        today_text = "\n".join(today_lines)
        
    return yesterday_text, today_text

def generate_text_gemini(api_key, jira_act, bb_act):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    context = {
        "jira_issues_updated": jira_act,
        "bitbucket_commits": bb_act
    }
    
    prompt = f"""
Você é um desenvolvedor preenchendo o check-in diário de atividades.
Com base nas seguintes informações de atividades brutas coletadas do Jira e Bitbucket, gere dois blocos de texto em português (um para "yesterday" e outro para "today").

Regras importantes:
1. Escreva em português, de forma profissional, direta e natural, no estilo de atualização diária (daily).
2. Não cite os códigos das tasks do Jira (ex: evite escrever "PROJ-123" ou "Ideal-456"). Fale apenas do assunto de forma natural.
3. Sintetize as informações. Não liste apenas commits de forma literal, agrupe-os em realizações lógicas.
4. Para a parte "today", deduza o que deve ser feito com base nas tarefas que ainda não estão concluídas (ex: status "In Progress" ou pendentes), ou indique continuação/refinamento das tarefas recentes.
5. Retorne a resposta estritamente no formato JSON abaixo, sem blocos de código markdown adicionais:
{{
  "yesterday": "texto sintetizado do que foi feito ontem",
  "today": "texto sintetizado do que será feito hoje"
}}

Dados de atividade:
{json.dumps(context, indent=2, ensure_ascii=False)}
"""
    
    payload = {
        "contents": [{
            "parts": [{
                "text": prompt
            }]
        }],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    }
    
    log("Calling Gemini API to synthesize activity...")
    res_text = make_request(url, method="POST", data=payload)
    if not res_text:
        log("Gemini API call failed. Falling back to template.")
        return None
        
    try:
        res_data = json.loads(res_text)
        content_text = res_data["candidates"][0]["content"]["parts"][0]["text"].strip()
        parsed = json.loads(content_text)
        return parsed.get("yesterday"), parsed.get("today")
    except Exception as e:
        log(f"Error parsing Gemini API response: {e}")
        return None

def build_checkin_text(config, jira_act, bb_act, yesterday_is_holiday):
    """Gera (yesterday, today) para um conjunto de atividades (Gemini -> template)."""
    yesterday_txt, today_txt = None, None

    gemini_key = config.get("gemini", {}).get("api_key")
    if gemini_key:
        result = generate_text_gemini(gemini_key, jira_act, bb_act)
        if result:
            yesterday_txt, today_txt = result

    if not yesterday_txt or not today_txt:
        log("Using template-based generation.")
        yesterday_txt_tpl, today_txt_tpl = generate_text_template(jira_act, bb_act)
        if not yesterday_txt:
            yesterday_txt = yesterday_txt_tpl
        if not today_txt:
            today_txt = today_txt_tpl

    if yesterday_is_holiday:
        log("Yesterday was a holiday/weekend. Overriding yesterday text to empty.")
        yesterday_txt = ""

    return yesterday_txt, today_txt

def _split_csv(value):
    return [x.strip() for x in str(value or "").split(",") if x.strip()]

def route_activity(jira_act, bb_act, initiative_config, default_initiative):
    """Particiona a atividade por iniciativa segundo o initiative_config da extensao
    ({"repos": {id: "repoA, repoB"}, "projects": {id: "AUD, SI"}}).

    Roteamento: issue do Jira pela project key (prefixo de KEY-123); commit pelo
    repo, com fallback para a project key achada na mensagem do commit. Atividade
    sem mapeamento cai na iniciativa padrao com aviso.

    Retorna (buckets, warnings): buckets = {init_id(int): {"jira": [...], "bb": [...]}}.
    """
    initiative_config = initiative_config or {}
    repos_map = initiative_config.get("repos") or {}
    projects_map = initiative_config.get("projects") or {}

    proj_to_init = {}
    for init_id, val in projects_map.items():
        for pk in _split_csv(val):
            proj_to_init[pk.upper()] = int(init_id)
    repo_to_init = {}
    for init_id, val in repos_map.items():
        for repo in _split_csv(val):
            repo_to_init[repo.lower()] = int(init_id)

    buckets = {}
    def bucket(init_id):
        return buckets.setdefault(int(init_id), {"jira": [], "bb": []})

    unmapped_jira, unmapped_bb = [], []

    for item in jira_act:
        key = item.get("key") or ""
        pk = key.split("-")[0].upper() if "-" in key else ""
        init_id = proj_to_init.get(pk)
        if init_id is not None:
            bucket(init_id)["jira"].append(item)
        else:
            unmapped_jira.append(item)

    for c in bb_act:
        init_id = repo_to_init.get((c.get("repo") or "").lower())
        if init_id is None:
            m = PROJECT_KEY_RE.search(c.get("message") or "")
            if m:
                init_id = proj_to_init.get(m.group(1).upper())
        if init_id is not None:
            bucket(init_id)["bb"].append(c)
        else:
            unmapped_bb.append(c)

    warnings = []
    if unmapped_jira or unmapped_bb:
        b = bucket(default_initiative)
        b["jira"].extend(unmapped_jira)
        b["bb"].extend(unmapped_bb)
        unk_projects = sorted({
            (i.get("key") or "").split("-")[0].upper()
            for i in unmapped_jira if "-" in (i.get("key") or "")
        })
        unk_repos = sorted({(c.get("repo") or "") for c in unmapped_bb if c.get("repo")})
        parts = []
        if unk_projects:
            parts.append("projetos " + ", ".join(unk_projects))
        if unk_repos:
            parts.append("repos " + ", ".join(unk_repos))
        detail = f" ({'; '.join(parts)})" if parts else ""
        warnings.append(
            f"Atividade nao mapeada{detail} roteada para a iniciativa padrao "
            f"{default_initiative}. Ajuste o mapeamento em initiative_config."
        )

    return buckets, warnings

def list_repos_cli(config, pattern):
    """Confirmacao interativa: lista os repos do workspace que casam com
    `pattern` (ou, sem pattern, com o `repositories` do config), destacando os
    removidos por `repositories_exclude`. So leitura — nada e enviado."""
    bb_cfg = config.get("bitbucket", {})
    workspace = bb_cfg.get("workspace")
    if not workspace:
        print("Bitbucket workspace nao configurado no config.json.")
        return 1
    headers = _bitbucket_auth_headers(config)
    if headers is None:
        print("Credenciais do Bitbucket incompletas no config.json.")
        return 1
    universe = _list_workspace_repos(headers, workspace, bb_cfg.get("project_key"))
    if not universe:
        print("Nao consegui listar os repositorios do workspace (permissao do token? Repositories:Read).")
        return 1

    exclude = bb_cfg.get("repositories_exclude", []) or []
    patterns = [pattern] if pattern else (bb_cfg.get("repositories", []) or [])
    selected, unmatched = _select_repos(universe, patterns, exclude)
    label = f"padrao '{pattern}'" if pattern else "config atual (bitbucket.repositories)"

    print(f"{len(selected)} repositorio(s) batem com {label}:")
    for r in selected:
        print(f"  - {r}")
    if patterns and exclude:
        excluded_hits = [
            r for r in universe
            if any(_repo_matches(p, r) for p in patterns) and any(_repo_matches(e, r) for e in exclude)
        ]
        if excluded_hits:
            print(f"Removidos por repositories_exclude ({', '.join(exclude)}):")
            for r in excluded_hits:
                print(f"  - {r}")
    if unmatched:
        print("Padroes sem nenhum match: " + ", ".join(unmatched))
    return 0


def main():
    dir_path = os.path.dirname(os.path.realpath(__file__))
    config_path = os.path.join(dir_path, "config.json")

    if not os.path.exists(config_path):
        log(f"config.json not found in {dir_path}. Please copy config.json.example to config.json and configure it.")
        sys.exit(1)

    with open(config_path, "r") as f:
        config = json.load(f)

    # Modo confirmacao (so leitura): `--list-repos [padrao]`. Mostra quais repos
    # do workspace casam com o padrao (ou com o config), sem coletar/enviar nada.
    cli_args = sys.argv[1:]
    if "--list-repos" in cli_args:
        idx = cli_args.index("--list-repos")
        pattern = ""
        if idx + 1 < len(cli_args) and not cli_args[idx + 1].startswith("--"):
            pattern = cli_args[idx + 1]
        sys.exit(list_repos_cli(config, pattern))

    # Iniciativa padrao: recebe atividade nao mapeada e o dia sem atividade.
    default_initiative = 6
    args = sys.argv[1:]
    if "--default-initiative" in args:
        try:
            default_initiative = int(args[args.index("--default-initiative") + 1])
        except (IndexError, ValueError):
            log("Ignoring invalid --default-initiative; using 6.")

    since_date = get_last_business_day()
    yesterday_is_holiday = is_holiday(since_date)

    jira_act = get_jira_activity(config, since_date)
    bb_act = get_bitbucket_activity(config, since_date)

    initiative_config = config.get("initiative_config") or {}
    has_map = bool(initiative_config.get("repos")) or bool(initiative_config.get("projects"))

    checkins = []
    warnings = []

    if not has_map:
        # Mapa vazio: comportamento atual — uma iniciativa padrao com toda a atividade.
        y, t = build_checkin_text(config, jira_act, bb_act, yesterday_is_holiday)
        checkins.append({"initiative": default_initiative, "yesterday": y, "today": t})
    else:
        buckets, warnings = route_activity(jira_act, bb_act, initiative_config, default_initiative)
        for init_id in sorted(buckets):
            b = buckets[init_id]
            if not b["jira"] and not b["bb"]:
                continue  # iniciativa sem atividade no dia: pula (fica pendente no Lab)
            y, t = build_checkin_text(config, b["jira"], b["bb"], yesterday_is_holiday)
            checkins.append({"initiative": init_id, "yesterday": y, "today": t})
        # Dia sem nenhuma atividade mapeada: garante o check-in da iniciativa padrao
        # (evita regressao silenciosa de quem ativa o multi-iniciativa).
        if not checkins:
            y, t = build_checkin_text(config, [], [], yesterday_is_holiday)
            checkins.append({"initiative": default_initiative, "yesterday": y, "today": t})

    print(json.dumps({"checkins": checkins, "warnings": warnings}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
