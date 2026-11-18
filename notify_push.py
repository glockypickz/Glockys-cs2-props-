"""After the lines job commits: tell the Worker to push 'new lines' / 'new grades' notifications to beta users.
   python notify_push.py PREV_LINES.json PREV_HISTORY.json
Compares the files from before this run with the new ones; sends nothing if nothing is new.
Needs the GitHub secret GP_ADMIN_KEY (the site's admin key); without it, it just prints and exits 0. Never fails the job.
The Worker also debounces: at most one notification per type per 30 minutes."""
import json, os, sys, urllib.request, urllib.error
from datetime import datetime, timezone

SITE = os.environ.get("SITE_URL", "https://glockys-cs2-props.dpe364.workers.dev").rstrip("/")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def prop_key(x):
    return "|".join(str(x.get(k) or "").lower() for k in ("book", "player", "stat", "period", "starts_at"))


def lock_key(e):
    return "|".join(str(e.get(k) or "").lower() for k in ("book", "player", "stat", "start"))


def parse(t):
    try:
        return datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except Exception:
        return None


def new_lines(prev, cur, now):
    old = {prop_key(x) for x in (prev.get("lines") or [])}
    out = []
    for x in cur.get("lines") or []:
        st = parse(x.get("starts_at"))
        if prop_key(x) not in old and (st is None or st > now):
            out.append(x)
    return out


def new_grades(prev, cur, now):
    old = {lock_key(e) for e in (prev.get("entries") or []) if (e.get("lock") or {}).get("grade")}
    out = []
    for e in cur.get("entries") or []:
        lk = e.get("lock") or {}
        st = parse(e.get("start"))
        if lk.get("grade") and lock_key(e) not in old and (st is None or st > now):
            out.append(e)
    return out


def messages(lines, grades):
    msgs = []
    if lines:
        n = len(lines)
        msgs.append({"type": "lines", "title": "New lines are up",
                     "body": "%d new prop%s on the board. Tap to grade them." % (n, "" if n == 1 else "s"), "url": "/"})
    if grades:
        aplus = sum(1 for e in grades if e["lock"]["grade"] == "A+")
        n = len(grades)
        body = ("%d A+ pick%s · " % (aplus, "" if aplus == 1 else "s") if aplus else "") + "%d new grade%s" % (n, "" if n == 1 else "s")
        msgs.append({"type": "grades", "title": "New grades posted", "body": body, "url": "/"})
    return msgs


def send(key, m):
    first = True
    data, total = dict(m), 0
    while True:
        req = urllib.request.Request(SITE + "/auth/admin/notify", data=json.dumps(data).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Admin-Key": key,
                                              "User-Agent": "glockys-prop-grader-actions"})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        if first and d.get("skipped"):
            print(m["type"], "skipped:", d.get("skipped"))
            return
        first = False
        total += d.get("sent", 0)
        if not d.get("cursor"):
            print(m["type"], "sent to", total, "device(s):", m["body"])
            return
        data = {"job": d["job"], "cursor": d["cursor"]}


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return
    now = datetime.now(timezone.utc)
    msgs = messages(new_lines(load(sys.argv[1]), load("lines.json"), now),
                    new_grades(load(sys.argv[2]), load("lines_history.json"), now))
    if not msgs:
        print("nothing new, no notification")
        return
    key = os.environ.get("GP_ADMIN_KEY", "").strip()
    if not key:
        print("GP_ADMIN_KEY secret not set, would have sent:", [m["body"] for m in msgs])
        return
    for m in msgs:
        try:
            send(key, m)
        except urllib.error.HTTPError as e:
            print(m["type"], "notify failed: HTTP", e.code)
        except Exception as e:
            print(m["type"], "notify failed:", type(e).__name__)


if __name__ == "__main__":
    main()
