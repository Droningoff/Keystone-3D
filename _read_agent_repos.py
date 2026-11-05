# -*- coding: utf-8 -*-
import sqlite3, json, os
db = os.path.expandvars(r"%APPDATA%\Cursor\User\globalStorage\state.vscdb")
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("SELECT value FROM ItemTable WHERE key=?", (
    "cloudAgentRepository.agents.google-oauth2|user_01M2GEXX3AZ1EN0RHZ5QVV8XG0",
))
row = cur.fetchone()
log = r"d:\AI\Project_OOZ\furniture_constructor\_agent_repos.txt"
out = []
if row:
    raw = row[0]
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    data = json.loads(raw)
    for a in data:
        name = a.get("name")
        repos = a.get("repoUrls") or []
        transport = a.get("transportRepoUrls") or []
        if "wg34" in str(a).lower() or "keystone" in str(a).lower() or name == "WG34":
            out.append(json.dumps({
                "name": name,
                "bcId": a.get("bcId"),
                "repoUrl": a.get("repoUrl"),
                "repoUrls": repos,
                "transportRepoUrls": transport,
                "additional": a.get("additionalRepoUrls"),
                "isProject": a.get("isProject"),
            }, ensure_ascii=False, indent=2))
# also dump githubRepos fully
cur.execute("SELECT value FROM ItemTable WHERE key=?", ("cloudEnvironmentTemplate.githubRepos",))
row = cur.fetchone()
if row:
    raw = row[0]
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    out.append("GITHUB_REPOS=" + raw)
# recent cloud targets
cur.execute("SELECT value FROM ItemTable WHERE key=?", ("cursor/glass.projectSelector.recentCloudTargets",))
row = cur.fetchone()
if row:
    raw = row[0]
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    out.append("RECENT=" + raw)
con.close()
open(log, "w", encoding="utf-8").write("\n\n".join(out))
print("OK")
