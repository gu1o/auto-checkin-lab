#!/usr/bin/env python3
import os
import sys
import json
import urllib.request
import urllib.parse
import base64
import datetime

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
    password = bb_cfg.get("app_password")
    token = bb_cfg.get("api_token")
    workspace = bb_cfg.get("workspace")
    repos = bb_cfg.get("repositories", [])
    
    if not workspace:
        log("Bitbucket workspace not configured. Skipping Bitbucket.")
        return []
        
    headers = {
        "Accept": "application/json"
    }
    if token:
        if token.startswith("ATATT"):
            email = config.get("jira", {}).get("email")
            if not email:
                log("Bitbucket api_token is an Atlassian token, but no Jira email was found in configuration. Skipping Bitbucket.")
                return []
            auth_str = f"{email}:{token}"
            auth_b64 = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
            headers["Authorization"] = f"Basic {auth_b64}"
        else:
            headers["Authorization"] = f"Bearer {token}"
    elif username and password:
        auth_str = f"{username}:{password}"
        auth_b64 = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")
        headers["Authorization"] = f"Basic {auth_b64}"
    else:
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
                
    # If no repositories specified, auto-discover them
    if not repos:
        log(f"No repositories specified. Fetching repo list for workspace '{workspace}'...")
        repos_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=100"
        res_text = make_request(repos_url, headers)
        if res_text:
            try:
                data = json.loads(res_text)
                repos = [r.get("slug") for r in data.get("values", []) if r.get("slug")]
            except Exception as e:
                log(f"Error parsing Bitbucket repos: {e}")
    
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

def main():
    dir_path = os.path.dirname(os.path.realpath(__file__))
    config_path = os.path.join(dir_path, "config.json")
    
    if not os.path.exists(config_path):
        log(f"config.json not found in {dir_path}. Please copy config.json.example to config.json and configure it.")
        sys.exit(1)
        
    with open(config_path, "r") as f:
        config = json.load(f)
        
    since_date = get_last_business_day()
    yesterday_is_holiday = is_holiday(since_date)
    
    jira_act = get_jira_activity(config, since_date)
    bb_act = get_bitbucket_activity(config, since_date)
    
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
        
    output = {
        "yesterday": yesterday_txt,
        "today": today_txt
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
