"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fmt = require("../lib/format");

test("formatSpeed auto-scales bits per second", () => {
  assert.equal(fmt.formatSpeed(0).text, "0.0 bps");
  assert.equal(fmt.formatSpeed(950).text, "950.0 bps");
  assert.equal(fmt.formatSpeed(1500).text, "1.5 kbps");
  assert.equal(fmt.formatSpeed(94_800_000).text, "94.8 Mbps");
  assert.equal(fmt.formatSpeed(2_400_000_000).text, "2.4 Gbps");
});

test("formatSpeed honours explicit units", () => {
  assert.equal(fmt.formatSpeed(94_800_000, { unit: "Mbps" }).text, "94.8 Mbps");
  assert.equal(fmt.formatSpeed(94_800_000, { unit: "Gbps", decimals: 2 }).text, "0.09 Gbps");
  assert.equal(fmt.formatSpeed(80_000_000, { unit: "MB/s" }).text, "10.0 MB/s");
  assert.equal(fmt.formatSpeed(80_000_000, { unit: "bytes" }).text, "10.0 MB/s");
});

test("formatSpeed guards against invalid input", () => {
  assert.equal(fmt.formatSpeed(null).text, "0.0 bps");
  assert.equal(fmt.formatSpeed(Number.NaN).text, "0.0 bps");
  assert.equal(fmt.formatSpeed(-5).text, "0.0 bps");
});

test("formatPing rounds and handles unknown values", () => {
  assert.equal(fmt.formatPing(12.6).text, "13 ms");
  assert.equal(fmt.formatPing(12.64, { decimals: 1 }).text, "12.6 ms");
  assert.equal(fmt.formatPing(null).text, "-- ms");
});

test("severity works in both directions", () => {
  const ping = { warn: 80, bad: 200 };
  assert.equal(fmt.severity(20, ping, "lower-is-better"), "good");
  assert.equal(fmt.severity(120, ping, "lower-is-better"), "warn");
  assert.equal(fmt.severity(400, ping, "lower-is-better"), "bad");

  const download = { warn: 20, bad: 5 };
  assert.equal(fmt.severity(100, download, "higher-is-better"), "good");
  assert.equal(fmt.severity(15, download, "higher-is-better"), "warn");
  assert.equal(fmt.severity(1, download, "higher-is-better"), "bad");

  assert.equal(fmt.severity(1, null, "higher-is-better"), null);
  assert.equal(fmt.severity(Number.NaN, download, "higher-is-better"), null);
});

test("relativeAge buckets the age correctly", () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(fmt.relativeAge(now - 5_000, now), { unit: "SECONDS", amount: 5 });
  assert.deepEqual(fmt.relativeAge(now - 120_000, now), { unit: "MINUTES", amount: 2 });
  assert.deepEqual(fmt.relativeAge(now - 7_200_000, now), { unit: "HOURS", amount: 2 });
  assert.deepEqual(fmt.relativeAge(now - 172_800_000, now), { unit: "DAYS", amount: 2 });
  assert.deepEqual(fmt.relativeAge(now + 5_000, now), { unit: "SECONDS", amount: 0 });
});

test("easeOutCubic stays inside [0,1]", () => {
  assert.equal(fmt.easeOutCubic(0), 0);
  assert.equal(fmt.easeOutCubic(1), 1);
  assert.equal(fmt.easeOutCubic(-1), 0);
  assert.equal(fmt.easeOutCubic(2), 1);
  assert.ok(fmt.easeOutCubic(0.5) > 0.5, "should ease out");
});

test("clamp and toFixed behave", () => {
  assert.equal(fmt.clamp(5, 0, 3), 3);
  assert.equal(fmt.clamp(Number.NaN, 1, 3), 1);
  assert.equal(fmt.toFixed(1.2345, 2), "1.23");
  assert.equal(fmt.toFixed(null, 1), "0.0");
});
