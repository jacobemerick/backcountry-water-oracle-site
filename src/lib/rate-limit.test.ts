import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, __test, clientIp, rateLimitHeaders, tooManyRequests } from "./rate-limit.ts";

const headers = (h: Record<string, string>) => new Headers(h);

test("prefers the header a proxy in front of Vercel cannot clobber", () => {
  // Vercel overwrites x-forwarded-for with the real client and refuses to
  // forward external ones, so all three are trustworthy on Vercel — but
  // x-vercel-forwarded-for survives a proxy layered on top, so it wins.
  assert.equal(
    clientIp(headers({
      "x-vercel-forwarded-for": "203.0.113.9",
      "x-real-ip": "198.51.100.4",
      "x-forwarded-for": "192.0.2.1",
    })),
    "203.0.113.9",
  );
  assert.equal(clientIp(headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  assert.equal(clientIp(headers({ "x-forwarded-for": "192.0.2.1" })), "192.0.2.1");
});

test("takes the leftmost entry of a forwarded list", () => {
  assert.equal(clientIp(headers({ "x-forwarded-for": "192.0.2.1, 10.0.0.1, 10.0.0.2" })), "192.0.2.1");
  assert.equal(clientIp(headers({ "x-forwarded-for": "  192.0.2.1  ,10.0.0.1" })), "192.0.2.1");
});

test("falls back to a single local bucket when no headers are present", () => {
  // Correct rather than a compromise: locally there is exactly one client.
  assert.equal(clientIp(headers({})), "local");
  assert.equal(clientIp(headers({ "x-forwarded-for": "" })), "local");
  assert.equal(clientIp(headers({ "x-forwarded-for": "   " })), "local");
});

test("windows are aligned to the clock, not to first use", () => {
  const { windowStart } = __test;
  // Alignment is what makes the counter shareable across instances: two
  // serverless invocations must agree on which window they are in without
  // coordinating.
  const t = Date.UTC(2026, 7, 5, 12, 34, 56, 789);
  assert.equal(windowStart(60, t).toISOString(), "2026-08-05T12:34:00.000Z");
  assert.equal(windowStart(3600, t).toISOString(), "2026-08-05T12:00:00.000Z");

  // Everything inside one window maps to the same start.
  const a = windowStart(60, Date.UTC(2026, 7, 5, 12, 34, 0));
  const b = windowStart(60, Date.UTC(2026, 7, 5, 12, 34, 59, 999));
  assert.equal(a.getTime(), b.getTime());

  // And the next second rolls over.
  const c = windowStart(60, Date.UTC(2026, 7, 5, 12, 35, 0));
  assert.equal(c.getTime() - a.getTime(), 60_000);
});

test("the stored subject is a digest, never the address", () => {
  const { subjectDigest } = __test;
  const ip = "203.0.113.9";
  const digest = subjectDigest(ip);

  assert.ok(!digest.includes(ip), "must not embed the address");
  assert.match(digest, /^[0-9a-f]{32}$/);
  assert.equal(subjectDigest(ip), digest, "stable for the same input");
  assert.notEqual(subjectDigest("203.0.113.10"), digest, "distinct for a different address");
});

test("every rule is a sane, finite window", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    assert.ok(rule.limit > 0, `${name} limit`);
    assert.ok(rule.windowSeconds > 0, `${name} window`);
  }
  // The global engine ceiling has to exceed the per-client one, or one client
  // could trip the ceiling for everybody.
  assert.ok(
    RULES.forecastGlobal.limit > RULES.forecast.limit,
    "global ceiling must sit above the per-client limit",
  );
});

test("a 429 tells the client when to come back", async () => {
  const result = {
    allowed: false,
    limit: 10,
    remaining: 0,
    resetAt: Math.floor(Date.now() / 1000) + 42,
  };
  const res = tooManyRequests(result, "Slow down.");

  assert.equal(res.status, 429);
  const retry = Number(res.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 42, `retry-after was ${retry}`);
  assert.equal(res.headers.get("ratelimit-limit"), "10");
  assert.equal(res.headers.get("ratelimit-remaining"), "0");

  const body = await res.json();
  assert.equal(body.error, "Slow down.");
  assert.ok(body.retry_after_seconds > 0);
});

test("headers never go negative once the window has passed", () => {
  const stale = { allowed: true, limit: 5, remaining: 5, resetAt: Math.floor(Date.now() / 1000) - 600 };
  assert.equal(rateLimitHeaders(stale)["ratelimit-reset"], "0");
});
