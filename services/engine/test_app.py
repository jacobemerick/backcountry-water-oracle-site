"""
The service must agree with the CLI, byte for byte.

app.py reimplements forecast.main()'s three passes, because main() is welded to
argv, files and stdout. That duplication is a standing liability, and it has
already bitten once: when analyze_base() gained the ability to return a base
with n == 0 instead of None, this service fed that into finalize() and returned
500 KeyError('ctrl') for a case the CLI handled fine.

The site's TypeScript fixtures did not catch it, because they are recorded from
the CLI while production runs the service. That gap is exactly what this file
closes: run the same CSV through both and demand identical JSON.

    python3 services/engine/test_app.py       (or `npm test`, which runs it)
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

ENGINE = os.path.join(HERE, "forecast.py")

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
            [sys.executable, ENGINE, path, "--json", *args],
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
        cli = via_cli(csv_text, f"--asof={asof}")

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
        self.assertTrue(json.loads(out)["ok"])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
