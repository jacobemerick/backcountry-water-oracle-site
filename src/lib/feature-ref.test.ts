import { test } from "node:test";
import assert from "node:assert/strict";
import { featurePath, featureRef, parseFeatureRef } from "./feature-ref.ts";

const gnis = {
  feed: "USGS GNIS DomesticNames",
  external_id: "1938702",
  name: "Willow Spring",
  feature_class: "spring",
};
const osm = {
  feed: "OpenStreetMap",
  external_id: "node/4471029",
  name: null,
  feature_class: "spring",
};

test("a feature path is readable and resolvable", () => {
  assert.equal(featurePath(gnis), "/features/willow-spring-gnis-1938702");
  // 55% of OSM's water nodes are unnamed; the class keeps the URL from being a
  // bare number.
  assert.equal(featurePath(osm), "/features/spring-osm-node-4471029");
  assert.equal(featureRef("USGS GNIS DomesticNames", "1938702"), "gnis-1938702");
  assert.equal(featurePath({ ...gnis, feed: "Some Other Feed" }), null);
});

test("the slug is decorative — only the identifier resolves", () => {
  const ref = parseFeatureRef("willow-spring-gnis-1938702");
  assert.deepEqual(ref, {
    marker: "gnis",
    feed: "USGS GNIS DomesticNames",
    externalId: "1938702",
  });

  // GNIS restates names as features are re-surveyed. A link already pasted into
  // a group text has to keep working, so a stale or absent slug resolves the
  // same row.
  for (const stale of ["old-willow-spring-gnis-1938702", "gnis-1938702", "x-gnis-1938702"]) {
    assert.equal(parseFeatureRef(stale)?.externalId, "1938702", stale);
  }
});

test("a slug that looks like a ref does not shadow the real one", () => {
  // Parsed from the right, so a spring actually named "Osm Spring" or one whose
  // name carries digits cannot capture the match.
  assert.equal(parseFeatureRef("osm-spring-gnis-55")?.externalId, "55");
  assert.equal(parseFeatureRef("spring-4-gnis-77")?.externalId, "77");
});

test("OSM ids survive the round trip through a path segment", () => {
  const ref = parseFeatureRef("spring-osm-node-4471029");
  // The slash would open a path segment of its own, so it travels as a hyphen.
  assert.equal(ref?.externalId, "node/4471029");
  assert.equal(ref?.feed, "OpenStreetMap");
  assert.equal(parseFeatureRef("x-osm-way-99")?.externalId, "way/99");
});

test("a hand-edited ref is refused rather than resolved loosely", () => {
  // Serving one spring at another spring's address is the failure this guards.
  assert.equal(parseFeatureRef("willow-spring"), null);
  assert.equal(parseFeatureRef("gnis-abc"), null);
  assert.equal(parseFeatureRef("osm-4471029"), null);
  assert.equal(parseFeatureRef("osm-node-abc"), null);
  assert.equal(parseFeatureRef(""), null);
});
