#!/usr/bin/env python3
"""Check do filtro de autor dos commits (_commit_is_mine/_author_identities).

Regressao que motivou o filtro por e-mail: commits assinados como "Guio" /
"guio bola" eram descartados quando o username detectado era o display name
da conta Atlassian ("Guilherme Ribeiro").

    python3 test_author_filter.py
"""
from auto_activity import _author_identities, _commit_is_mine

EMAIL = "guilherme.ribeiro@solucoesindustriais.com.br"
MEUS = [f"Guio <{EMAIL}>", f"guio bola <{EMAIL}>", f"Guilherme Ribeiro <{EMAIL}>"]
OUTROS = ["Marcos Peres <marcos.peres@idealtrends.com.br>", "Devops GIT <devops@idealtrends.com.br>"]

emails = _author_identities({"jira": {"email": EMAIL}})
assert emails == [EMAIL], emails

# Com o display name como username, o e-mail salva todas as assinaturas.
for raw in MEUS:
    assert _commit_is_mine(raw, "Guilherme Ribeiro", emails), raw
for raw in OUTROS:
    assert not _commit_is_mine(raw, "Guilherme Ribeiro", emails), raw

# author_emails explicito tem precedencia sobre o e-mail do Jira.
cfg = {"jira": {"email": EMAIL}, "bitbucket": {"author_emails": ["outro@x.com"]}}
assert _author_identities(cfg) == ["outro@x.com"]

# Sem e-mail, cai no username (comportamento antigo).
assert _commit_is_mine(MEUS[0], "guio", [])
assert not _commit_is_mine(MEUS[0], "Guilherme Ribeiro", [])

# Sem username e sem e-mail: coleta aberta.
assert _commit_is_mine(OUTROS[0], "", [])

print("ok")
