"""Collect player photos from the lines feed and cache them same-origin.

The kashrock player_image URLs often omit CORS, so the card export cannot
draw them directly. This script (run from the lines job) writes
player_photos.json and downloads files under assets/players/.
Existing entries are kept so coverage grows as new boards appear.
"""
import json, os, re, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(ROOT, "player_photos.json")
OUT_DIR = os.path.join(ROOT, "assets", "players")
LINES = os.path.join(ROOT, "lines.json")
UA = "Mozilla/5.0 (compatible; GlockyPicks/1.0)"


def key(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def load_json(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def ext_for(url, content_type):
    u = (url or "").lower().split("?", 1)[0]
    for e in (".webp", ".png", ".jpg", ".jpeg"):
        if u.endswith(e):
            return ".jpg" if e == ".jpeg" else e
    ct = (content_type or "").lower()
    if "webp" in ct:
        return ".webp"
    if "png" in ct:
        return ".png"
    return ".jpg"


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/webp,image/*,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        return data, r.headers.get("Content-Type") or ""


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    prev = load_json(OUT_JSON, {})
    photos = dict(prev.get("photos") or {})
    miss = dict(prev.get("miss") or {})
    lines = (load_json(LINES, {}) or {}).get("lines") or []
    # latest image URL per player key (board wins over older cache URL, file kept if same url)
    found = {}
    no_img = {}
    for l in lines:
        name = (l.get("player") or "").strip()
        k = key(name)
        if not k:
            continue
        url = (l.get("image") or "").strip()
        if url.startswith("https://"):
            found[k] = {"name": name, "url": url}
            miss.pop(k, None)
        else:
            no_img.setdefault(k, name)
    for k, name in no_img.items():
        if k not in photos and k not in found:
            miss[k] = name

    todo = []
    for k, meta in found.items():
        cur = photos.get(k) or {}
        dest = cur.get("file") or ""
        path = os.path.join(ROOT, dest) if dest else ""
        if cur.get("url") == meta["url"] and dest and os.path.isfile(path) and os.path.getsize(path) > 0:
            photos[k] = {"name": meta["name"], "url": meta["url"], "file": dest}
            continue
        todo.append((k, meta, cur))

    ok = fail = 0
    for k, meta, cur in todo:
        url = meta["url"]
        try:
            data, ct = fetch(url)
            if not data or len(data) < 32:
                raise ValueError("empty image")
            ext = ext_for(url, ct)
            rel = "assets/players/" + k + ext
            path = os.path.join(ROOT, rel)
            # drop a stale file with a different extension
            for old_ext in (".webp", ".png", ".jpg", ".jpeg"):
                other = os.path.join(OUT_DIR, k + old_ext)
                if other != path and os.path.isfile(other):
                    os.remove(other)
            open(path, "wb").write(data)
            photos[k] = {"name": meta["name"], "url": url, "file": rel}
            ok += 1
            time.sleep(0.05)
        except Exception as e:
            fail += 1
            print("photo fail", meta["name"], e)
            if cur.get("file") and os.path.isfile(os.path.join(ROOT, cur["file"])):
                photos[k] = cur  # keep last good cache
            else:
                miss[k] = meta["name"]

    # drop miss entries that now have a photo
    for k in list(miss):
        if k in photos:
            miss.pop(k, None)

    out = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "photos": dict(sorted(photos.items())),
        "miss": dict(sorted(miss.items())),
    }
    json.dump(out, open(OUT_JSON, "w"), separators=(",", ":"), ensure_ascii=False)
    board = len({key(l.get("player")) for l in lines if l.get("player")})
    board_img = len({key(l.get("player")) for l in lines if l.get("image")})
    print(
        "player photos: %d cached (%d downloaded this run, %d failed), "
        "board %d/%d players have a feed image, %d still missing"
        % (len(photos), ok, fail, board_img, board, len(miss))
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("player photo refresh failed, keeping the old file:", e)
