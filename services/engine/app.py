"""
WSGI wrapper around the forecast engine.

Deliberately a bare WSGI callable with no framework: the engine itself is
stdlib-only and dependency-free, and there is no reason for its HTTP shell to
be otherwise. Vercel loads a top-level `application` for WSGI apps, so this
needs no requirements.txt at all.

Contract, mirroring the engine's own:

    POST /  {"csv": "<engine CSV>", "asof": "...", "harmonics": N,
             "pool": bool, "pool_radius_km": N}
    ->      the engine's --json object, verbatim

The CSV is built by the site (src/lib/engine-csv.ts) straight from the
sources+reports join, so nothing here needs to know about water reports.
"""

import io
import json
import os
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import forecast  # noqa: E402  (must follow the sys.path insert)

MAX_BODY = 8 * 1024 * 1024  # generous: a source with 5000 reports is ~250KB


def _json(start_response, status, payload):
    body = json.dumps(payload).encode("utf-8")
    start_response(
        status,
        [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
        ],
    )
    return [body]


def _run(params):
    csv_text = params.get("csv")
    if not isinstance(csv_text, str) or not csv_text.strip():
        raise ValueError("csv is required and must be a non-empty string")

    asof = date.today()
    if params.get("asof"):
        asof = date.fromisoformat(str(params["asof"])[:10])

    n_harm = int(params.get("harmonics", 1))
    radius_km = float(params.get("pool_radius_km", forecast.POOL_RADIUS_KM))
    do_pool = params.get("pool", True) is not False
    use_cache = params.get("cache", True) is not False

    notes = []

    def note(kind, msg, name=None):
        notes.append({"kind": kind, "source": name, "message": msg})

    # The engine's public loader, load_sources(), only takes paths or "-" for
    # stdin -- neither of which fits a request body. _read_csv() is the piece
    # that actually accepts a file object, so use it and then replicate the
    # sort load_sources() does afterwards. Private-API use is the one wart
    # here; upstream issue filed to expose a supported entry point.
    sources_by_name = {}
    forecast._read_csv(io.StringIO(csv_text), "<request>", sources_by_name)
    for src in sources_by_name.values():
        src["reports"].sort()
    sources = list(sources_by_name.values())

    bases = []
    for src in sources:
        try:
            base = forecast.analyze_base(src, asof, use_cache, n_harm)
            if base is None:
                note("skip", "no reports within precip range", src["name"])
                continue
            bases.append(base)
        except Exception as exc:  # one bad source must not sink the request
            note("error", str(exc), src["name"])

    if do_pool and len(bases) > 1:
        forecast.pool_controlled(bases, radius_km)

    rows = [forecast.finalize(b) for b in bases]
    return forecast.run_json(rows, notes, asof, do_pool, radius_km, n_harm, use_cache)


def application(environ, start_response):
    if environ.get("REQUEST_METHOD") == "GET":
        # Liveness probe: confirms the interpreter, the engine import and the
        # pinned commit in one call.
        pinned = "unknown"
        try:
            with open(os.path.join(HERE, "PINNED_COMMIT")) as fh:
                pinned = fh.read().strip()
        except OSError:
            pass
        return _json(
            start_response,
            "200 OK",
            {
                "ok": True,
                "python": sys.version.split()[0],
                "engine_pinned_commit": pinned,
                "windows": forecast.WINDOWS,
            },
        )

    if environ.get("REQUEST_METHOD") != "POST":
        return _json(start_response, "405 Method Not Allowed", {"error": "POST or GET only"})

    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        return _json(start_response, "400 Bad Request", {"error": "empty body"})
    if length > MAX_BODY:
        return _json(start_response, "413 Payload Too Large", {"error": "body too large"})

    try:
        params = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
    except Exception as exc:
        return _json(start_response, "400 Bad Request", {"error": f"invalid JSON: {exc}"})

    try:
        return _json(start_response, "200 OK", _run(params))
    except ValueError as exc:
        return _json(start_response, "400 Bad Request", {"error": str(exc)})
    except Exception as exc:
        return _json(start_response, "500 Internal Server Error", {"error": str(exc)})
