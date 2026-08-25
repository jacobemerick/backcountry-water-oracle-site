"""
WSGI wrapper around the forecast engine.

Deliberately a bare WSGI callable with no framework: the engine is stdlib-only
and dependency-free by rule, and there is no reason for its HTTP shell to be
otherwise. Vercel loads a top-level `application` for WSGI apps, so the only
dependency here is the engine itself.

Contract, mirroring the engine's own:

    POST /  {"csv": "<engine CSV>", "asof": "...", "harmonics": N,
             "pool": bool, "pool_radius_km": N,
             "precip": {"34.08587,-111.49097": {"start": "2007-01-01", "values": [...]}}}
    ->      the engine's --json object, verbatim

`precip` keys are raw coordinates, not rounded ones -- the rounding happens
here, in one language, for the reason spelled out in _supplied_precip_provider.

`precip` is optional. When present it is installed as the engine's
PRECIP_PROVIDER, so the caller's shared cache is used instead of a per-instance
one. Anything not supplied falls back to the engine's own Open-Meteo provider,
which keeps this service correct standalone and means one failed coordinate
upstream costs that source its speed rather than its forecast.

The CSV is built by the site (src/lib/engine-csv.ts) straight from the
sources+reports join, so nothing here needs to know about water reports.
"""

import io
import json
import os
import sys
import tempfile
from datetime import date, timedelta

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

# The radar cross-check is off here, and only here.
#
# 0.2.0 added an MRMS cross-check that runs by default and is genuinely useful:
# recent radar rain beside the model's own figure, reported next to the verdict
# and never inside it. It is also the wrong shape for this host. Our cache is
# /tmp -- per-instance and ephemeral -- so a cold instance pays ~20 extra IEM
# requests per coordinate, year-chunked with a politeness delay, to produce a
# 60-day number. That is a function timeout on the request path, not a slow
# page. Measured locally: the engine test suite went from ~3s to ~72s with it
# enabled.
#
# RADAR_PROVIDER is the seam the engine exposes for exactly this. When the
# shared Postgres-backed store lands (site #8) this should point at it rather
# than be None, which is the same trajectory as PRECIP_PROVIDER.
engine.RADAR_PROVIDER = None

# Generous: a source with 5000 reports is ~250KB of CSV, and a supplied precip
# series is ~7000 floats per coordinate.
MAX_BODY = 32 * 1024 * 1024


def _supplied_precip_provider(supplied):
    """Serve precipitation from series the caller already has.

    The site keeps these in Postgres, shared across instances, and gathers the
    coordinates a request needs in parallel -- both things this service cannot
    do without a database driver, which it deliberately does not have.

    Series arrive as {start, values} rather than the engine's {"daily":
    {"time", "precipitation_sum"}} because dates are implied by position: a
    dense daily array plus a start date is the same information at roughly half
    the payload, and a route's worth of coordinates is not small.
    """
    # Explicitly the engine's own default, NOT the currently-installed provider:
    # this function assigns to engine.PRECIP_PROVIDER, so capturing that would
    # make each request's closure wrap the previous request's.
    fallback = engine.open_meteo_provider

    # Re-key everything here so exactly one language decides how a coordinate
    # rounds. JavaScript's Math.round goes away from zero at the half-way point
    # and Python's round goes to even, so 34.125 is 34.13 there and 34.12 here.
    # Since a lookup miss falls back to fetching, disagreement would not fail --
    # it would silently disable the cache for those coordinates. Keys arrive at
    # full precision precisely so this can be the only place it happens.
    table = {}
    for raw, entry in supplied.items():
        try:
            lat_s, lon_s = str(raw).split(",")
            table[(round(float(lat_s), 2), round(float(lon_s), 2))] = entry
        except (ValueError, TypeError):
            continue  # a malformed key costs one fetch, not the request

    def provider(lat, lon, end_date, use_cache=True):
        entry = table.get((round(lat, 2), round(lon, 2)))
        if not entry or not use_cache:
            # Missing coordinate, or the caller explicitly wants fresh data.
            return fallback(lat, lon, end_date, use_cache)

        start = date.fromisoformat(entry["start"])
        values = entry["values"]
        times = [(start + timedelta(days=i)).isoformat() for i in range(len(values))]
        # Returning more than end_date is explicitly allowed -- the engine trims.
        return {"daily": {"time": times, "precipitation_sum": values}}

    return provider


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

    # PRECIP_PROVIDER is a module global, which is the seam the engine offers,
    # so this is a per-request assignment to shared state. Concurrent requests on
    # one instance could see each other's provider. That is harmless rather than
    # merely unlikely: series are keyed by rounded coordinate and both requests
    # would be reading the same shared cache, so a crossed provider returns the
    # same numbers. Only which request paid for the fetch can differ.
    supplied = params.get("precip")
    engine.PRECIP_PROVIDER = (
        _supplied_precip_provider(supplied)
        if isinstance(supplied, dict) and supplied
        else engine.open_meteo_provider
    )

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
