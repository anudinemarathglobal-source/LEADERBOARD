"""Vercel serverless function: GET /api/leaderboard"""
import json, os, time
from http.server import BaseHTTPRequestHandler

SHEET_ID = "1EBoTv168l52h7geL02ZmXwyx02vpEM4Aj61p4NBh2kM"
SHEET_NAME = "HOURLY"
EXCLUDE = {"AGENT","NIGHT SHIFT", "total"}

# field -> (exact header names to try in order, optional "contains" fallback)
FIELDS = {
    "agent": (["agent"], None),
    "targetLeads": (["target leads"], "target lead"),
    "todayLeads": (["today leads", "today lead", "lead", "leads"], None),
    "target": (["today target"], None),
    "won": (["orders"], None),
    "fromLeads": (["order from leads"], None),
    "qty": (["qty"], None),
    "remaining": (["remaining target"], None),
    "oudAlSalam": (["oud al salam count", "oud al salam"], "oud"),
    "bahrain": (["bahrain count", "bahrain"], "bahrain"),
    "totalBacklog": (["backlog"], None),
}


def num(v):
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def find_col(head, exact, contains):
    for n in exact:
        if n in head:
            return head.index(n)
    if contains:
        for i, h in enumerate(head):
            if contains in h:
                return i
    return None


def read_sheet():
    import gspread  # imported here so a missing package shows as a JSON error, not a crash
    creds = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
    gc = gspread.service_account_from_dict(creds)
    values = gc.open_by_key(SHEET_ID).worksheet(SHEET_NAME).get_all_values()
    h = next((i for i, r in enumerate(values)
              if any(c.strip().lower() == "agent" for c in r)), None)
    if h is None:
        raise ValueError("Header row with 'AGENT' not found")
    head = [" ".join(c.split()).lower() for c in values[h]]
    idx, missing = {}, []
    for field, (exact, contains) in FIELDS.items():
        i = find_col(head, exact, contains)
        if i is None:
            missing.append(field)
        else:
            idx[field] = i
    rows = []
    for r in values[h + 1:]:
        get = lambda f: r[idx[f]] if f in idx and idx[f] < len(r) else ""
        agent = get("agent").strip()
        if not agent or agent.lower() in EXCLUDE:
            continue
        row = {"agent": agent}
        for f in FIELDS:
            if f != "agent":
                row[f] = num(get(f))
        if row["target"] >= 0:  # keep agents whose target is 0
            rows.append(row)
    return rows, missing


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            rows, missing = read_sheet()
            body, code = {"rows": rows, "missing": missing, "updated": time.time()}, 200
        except Exception as e:
            body, code = {"error": str(e)}, 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "s-maxage=10, stale-while-revalidate=5")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
