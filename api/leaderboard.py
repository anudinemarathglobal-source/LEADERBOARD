"""Vercel serverless function: GET /api/leaderboard"""
import json, os, time
from http.server import BaseHTTPRequestHandler

SHEET_ID = "1EBoTv168l52h7geL02ZmXwyx02vpEM4Aj61p4NBh2kM"
SHEET_NAME = "HOURLY"
EXCLUDE = {"", "total"}
COLS = {
    "agent": "agent", "today target": "target", "orders": "won",
    "order from leads": "fromLeads", "qty": "qty",
    "remaining target": "remaining", "backlog": "totalBacklog",
}


def num(v):
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


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
    idx = {f: head.index(n) for n, f in COLS.items() if n in head}
    rows = []
    for r in values[h + 1:]:
        get = lambda f: r[idx[f]] if f in idx and idx[f] < len(r) else ""
        agent = get("agent").strip()
        if not agent or agent.lower() in EXCLUDE:
            continue
        row = {"agent": agent}
        for f in ("target", "won", "fromLeads", "qty", "remaining", "totalBacklog"):
            row[f] = num(get(f))
        if row["target"] >= 0:  # keep agents whose target is 0
            rows.append(row)
    return rows


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            body, code = {"rows": read_sheet(), "updated": time.time()}, 200
        except Exception as e:
            body, code = {"error": str(e)}, 500
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "s-maxage=30, stale-while-revalidate")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())