"""
Leaderboard API – reads the Google Sheet with a service account.

pip install flask flask-cors gspread
python server.py   ->  http://localhost:5000/api/leaderboard
"""
import time
import gspread
from flask import Flask, jsonify
from flask_cors import CORS

SHEET_ID = "1EBoTv168l52h7geL02ZmXwyx02vpEM4Aj61p4NBh2kM"
SHEET_NAME = "HOURLY"
SERVICE_ACCOUNT_FILE = "service_account.json"   # keep this file OUT of git and OUT of React
EXCLUDE = {"", "total"}
CACHE_SECONDS = 30

# header text in the sheet -> field name sent to React
COLS = {
    "agent": "agent",
    "today target": "target",
    "orders": "won",
    "order from leads": "fromLeads",
    "qty": "qty",
    "remaining target": "remaining",
    "backlog": "totalBacklog",
}

app = Flask(__name__)
CORS(app)  # in production, restrict to your dashboard's origin

gc = gspread.service_account(filename=SERVICE_ACCOUNT_FILE)
_cache = {"t": 0, "data": []}


def num(v):
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def read_sheet():
    print(f"\n[{time.strftime('%H:%M:%S')}] Fetching sheet '{SHEET_NAME}' from Google...")
    values = gc.open_by_key(SHEET_ID).worksheet(SHEET_NAME).get_all_values()
    print(f"[OK] Got {len(values)} raw rows from the sheet")
    h = next(
        (i for i, r in enumerate(values) if any(c.strip().lower() == "agent" for c in r)),
        None,
    )
    if h is None:
        raise ValueError("Header row with 'AGENT' not found")
    head = [" ".join(c.split()).lower() for c in values[h]]
    print(f"[OK] Header found at sheet row {h + 1}")
    idx = {field: head.index(name) for name, field in COLS.items() if name in head}

    rows = []
    for r in values[h + 1:]:
        get = lambda f: r[idx[f]] if f in idx and idx[f] < len(r) else ""
        agent = get("agent").strip()
        if not agent or agent.lower() in EXCLUDE:
            continue
        row = {"agent": agent}
        for f in ("target", "won", "fromLeads", "qty", "remaining", "totalBacklog"):
            row[f] = num(get(f))
        if row["target"] >= 0:
            rows.append(row)
    print(f"[OK] Parsed {len(rows)} agents:")
    for r in rows:
        print(
            f"   {r['agent']:<20} target={r['target']:<5.0f} won={r['won']:<4.0f} "
            f"leads={r['fromLeads']:<4.0f} qty={r['qty']:<4.0f} "
            f"remaining={r['remaining']:<5.0f} backlog={r['totalBacklog']:.0f}"
        )
    return rows


@app.get("/api/leaderboard")
def leaderboard():
    if time.time() - _cache["t"] > CACHE_SECONDS:
        try:
            _cache.update(t=time.time(), data=read_sheet())
        except Exception as e:
            print(f"[ERROR] {type(e).__name__}: {e}")
            return jsonify(error=str(e)), 500
    else:
        print(f"[{time.strftime('%H:%M:%S')}] Served from cache ({len(_cache['data'])} agents)")
    return jsonify(rows=_cache["data"], updated=_cache["t"])


if __name__ == "__main__":
    app.run(port=5000)