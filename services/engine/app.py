"""
WSGI wrapper around the forecast engine.

Deliberately a bare WSGI callable with no framework: the engine is stdlib-only
and dependency-free by rule, and there is no reason for its HTTP shell to be
otherwise. Vercel loads a top-level `application` for WSGI apps, so the only
dependency here is the engine itself.

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
import tempfile
from datetime import date

# Where the engine keeps downloaded precipitation. Must be set before importing
# the package, which resolves CACHE_DIR at import time.
#
# The engine's own default is sensible everywhere else: an explicit
# WATER_ORACLE_CACHE, else a source checkout's .cache/, else the platform user
# cache. On a serverless function none of those are reliably writable -- the
# deployment bundle is read-only, which is what produced
# "[Errno 30] Read-only file system: '/var/task/.cache'" in production before.
# /tmp always is.
#
# Per-instance and ephemeral, so it warms a hot instance and does nothing for a
# cold one. The durable fix is the shared Postgres-backed provider (site #8),
# which plugs into PRECIP_PROVIDER and replaces this line.
os.environ.setdefault("WATER_ORACLE_CACHE", os.path.join(tempfile.gettempdir(), "bwo-precip-cache"))

import backcountry_water_oracle as engine  # noqa: E402  (must follow the env default)

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

    # engine.run() is the supported entry point: it is what the CLI does minus
    # argument parsing, sharing the same internals, so the service and
    # `water-forecast` cannot answer differently for the same input.
    #
    # This wrapper used to reimplement those passes and reach into a private
    # loader, because neither had a public equivalent. That copy drifted on the
    # first upstream sync after it was written and returned 500 on input the
    # CLI handled fine. Do not reintroduce it.
    sources = engine.load_sources_from([io.StringIO(csv_text)], labels=["<request>"])

    return engine.run(
        sources,
        asof,
        harmonics=int(params.get("harmonics", 1)),
        pool=params.get("pool", True) is not False,
        pool_radius_km=float(params.get("pool_radius_km", engine.POOL_RADIUS_KM)),
        use_cache=params.get("cache", True) is not False,
    )


def application(environ, start_response):
    if environ.get("REQUEST_METHOD") == "GET":
        # Liveness probe: interpreter, engine import and engine version in one
        # call. /api/diag on the web service proxies this, which is the only way
        # to observe a service that has no public route of its own.
        return _json(
            start_response,
            "200 OK",
            {
                "ok": True,
                "python": sys.version.split()[0],
                "engine_version": engine.__version__,
                "cache_dir": engine.CACHE_DIR,
                "windows": engine.WINDOWS,
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
