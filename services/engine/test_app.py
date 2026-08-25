"""
The service must agree with the CLI, byte for byte.

This mattered enormously when app.py reimplemented the engine's three passes:
that copy drifted on the first upstream sync and returned 500 on input the CLI
handled fine, and the site's TypeScript fixtures missed it because they are
recorded from the CLI while production runs the service.

Since engine v0.1.0 the wrapper calls the public run(), which shares its
internals with the CLI, so divergence is now structurally impossible rather
than merely tested against. These stay as a regression guard on the wiring --
they would catch the wrapper passing the wrong argument, or a future engine
release changing the payload shape.

Requires the engine installed: `npm run engine:install`.

    npm test                     (runs this)
    services/engine/.venv/bin/python services/engine/test_app.py
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from app import application  # noqa: E402
import backcountry_water_oracle as engine  # noqa: E402

# The installed console script, from the same venv running this file.
ENGINE_CLI = os.path.join(os.path.dirname(sys.executable), "water-forecast")

# Two sources: one usable, one whose reports all predate the precipitation
# record. The second is the case that broke -- it must be skipped with an
# explanation, not crash and not vanish.
CSV_WITH_EXCLUSIONS = """source,lat,lon,date,score,status
Chilson Spring,34.08587,-111.49097,2025-10-24,1.0,Gallon+ per minute
Chilson Spring,34.08587,-111.49097,2024-06-30,0.2,Box full no flow
Chilson Spring,34.08587,-111.49097,2001-05-01,0.4,Pre-record report
Ancient Tank,34.09,-111.46,1998-04-01,0.5,Old report
Ancient Tank,34.09,-111.46,1999-05-01,0.0,Dry
"""

CSV_ALL_USABLE = """source,lat,lon,date,score,status
Chilson Spring,34.08587,-111.49097,2025-10-24,1.0,Gallon+ per minute
Chilson Spring,34.08587,-111.49097,2024-06-30,0.2,Box full no flow
"""


def via_service(csv_text, **params):
    body = json.dumps({"csv": csv_text, **params}).encode("utf-8")
    env = {
        "REQUEST_METHOD": "POST",
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
    }
    captured = {}
    out = b"".join(application(env, lambda s, h: captured.update(status=s)))
    return captured["status"], json.loads(out)


def via_cli(csv_text, *args):
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as fh:
        fh.write(csv_text)
        path = fh.name
    try:
        proc = subprocess.run(
            [ENGINE_CLI, path, "--json", *args],
            capture_output=True,
            text=True,
            timeout=180,
        )
        return json.loads(proc.stdout)
    finally:
        os.unlink(path)


class ServiceMatchesCli(unittest.TestCase):
    def assert_same(self, csv_text, asof="2026-08-01"):
        status, service = via_service(csv_text, asof=asof)
        self.assertEqual(status, "200 OK")
        # --radar none matches app.py's RADAR_PROVIDER = None. The service is
        # deliberately configured differently from the CLI's defaults here, so
        # the CLI is given the same configuration rather than the assertion
        # being loosened -- the point of this test is that identical input and
        # identical configuration produce identical output.
        cli = via_cli(csv_text, f"--asof={asof}", "--radar=none")

        # `params.cache` can differ harmlessly; everything else must match.
        for key in ("asof", "notes", "sources"):
            self.assertEqual(
                json.dumps(service[key], sort_keys=True),
                json.dumps(cli[key], sort_keys=True),
                f"service and CLI disagree on {key!r}",
            )

    def test_all_reports_usable(self):
        self.assert_same(CSV_ALL_USABLE)

    def test_source_with_no_usable_reports_is_skipped_not_fatal(self):
        # The regression: this returned 500 KeyError('ctrl').
        self.assert_same(CSV_WITH_EXCLUSIONS)

    def test_skip_note_explains_why(self):
        _, result = via_service(CSV_WITH_EXCLUSIONS, asof="2026-08-01")
        notes = result["notes"]
        self.assertEqual(len(notes), 1, notes)
        self.assertEqual(notes[0]["kind"], "skip")
        self.assertEqual(notes[0]["source"], "Ancient Tank")
        # "no reports within precip range" is not good enough -- say what happened.
        self.assertIn("usable", notes[0]["message"])
        self.assertIn("predate", notes[0]["message"])

    def test_partial_exclusions_are_reported_per_source(self):
        _, result = via_service(CSV_WITH_EXCLUSIONS, asof="2026-08-01")
        chilson = next(s for s in result["sources"] if s["name"] == "Chilson Spring")
        self.assertEqual(chilson["reports"]["total"], 3)
        self.assertEqual(chilson["reports"]["used"], 2)
        self.assertEqual(chilson["reports"]["excluded_before_precip"], 1)


class RequestHandling(unittest.TestCase):
    def test_health(self):
        env = {"REQUEST_METHOD": "GET", "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b"")}
        captured = {}
        out = b"".join(application(env, lambda s, h: captured.update(status=s)))
        self.assertEqual(captured["status"], "200 OK")
        health = json.loads(out)
        self.assertTrue(health["ok"])
        # The version is how a deployment is identified now that there is no
        # vendored file to inspect.
        self.assertEqual(health["engine_version"], engine.__version__)

    def test_cache_dir_is_writable(self):
        # The engine picks a cache directory at import. Its default is right for
        # a checkout and wrong inside a read-only deployment bundle, which is
        # what produced "[Errno 30] Read-only file system: '/var/task/.cache'"
        # in production. app.py sets WATER_ORACLE_CACHE before importing.
        os.makedirs(engine.CACHE_DIR, exist_ok=True)
        probe = os.path.join(engine.CACHE_DIR, ".write-test")
        with open(probe, "w") as fh:
            fh.write("")
        os.unlink(probe)

    def test_rejects_bad_input(self):
        cases = [
            ("empty csv", {"csv": ""}),
            ("missing csv key", {"nonsense": 1}),
            ("malformed asof", {"csv": CSV_ALL_USABLE, "asof": "tomorrow"}),
        ]
        for label, payload in cases:
            with self.subTest(label):
                body = json.dumps(payload).encode("utf-8")
                env = {
                    "REQUEST_METHOD": "POST",
                    "CONTENT_LENGTH": str(len(body)),
                    "wsgi.input": io.BytesIO(body),
                }
                captured = {}
                b"".join(application(env, lambda s, h: captured.update(status=s)))
                self.assertTrue(
                    captured["status"].startswith("400"),
                    f"{label} -> {captured['status']}",
                )

    def test_rejects_wrong_method(self):
        env = {"REQUEST_METHOD": "DELETE", "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b"")}
        captured = {}
        b"".join(application(env, lambda s, h: captured.update(status=s)))
        self.assertTrue(captured["status"].startswith("405"))


class HostConfiguration(unittest.TestCase):
    """
    Settings this host deliberately differs from the engine's defaults on.

    Each one is a decision with a reason, so each gets a test -- otherwise the
    next engine bump quietly re-enables it and the failure shows up as a
    timeout in production rather than a red suite here.
    """

    def test_radar_is_disabled(self):
        # The MRMS cross-check fetches from IEM per coordinate. Our cache is
        # /tmp, per-instance and ephemeral, so a cold instance would pay ~20
        # extra upstream requests to produce a 60-day number and blow the
        # function timeout. Re-enable when it can read from the shared store.
        self.assertIsNone(engine.RADAR_PROVIDER)

    def test_radar_check_is_absent_from_the_payload(self):
        # Not merely configured off -- actually absent from what we serve, so a
        # future default that ignores RADAR_PROVIDER still fails here.
        _, result = via_service(CSV_ALL_USABLE, asof="2026-08-01")
        for source in result["sources"]:
            self.assertIsNone(source["radar_check"], source["name"])

    def test_cache_dir_is_under_tmp(self):
        # The bundle is read-only on Vercel; this produced
        # "[Errno 30] Read-only file system: '/var/task/.cache'" in production.
        self.assertTrue(str(engine.CACHE_DIR).startswith(tempfile.gettempdir()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
