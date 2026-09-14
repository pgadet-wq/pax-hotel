/**
 * Tests scenario (CDC §5.4) : défauts, bornes, station connue, dates locales.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, resolveDates, DEFAULT_AVION, DEFAULT_SCENARIO } from "../lib/scenario.mjs";

test("scenario : défauts — A350 34/24/266, BKK, 1 nuit, seed 42, next_update 30", () => {
  assert.deepEqual(DEFAULT_AVION.seats, { J: 34, W: 24, Y: 266 });
  const cfg = mergeConfig();
  assert.equal(cfg.scenario.station, "BKK");
  assert.equal(cfg.scenario.nights, 1);
  assert.equal(cfg.scenario.seed, 42);
  assert.equal(cfg.scenario.next_update_minutes, 30);
  assert.equal(cfg.scenario.simulate, false);
  assert.equal(DEFAULT_SCENARIO.force_discovery, false);
});

test("scenario : bornes et station — nights hors 1-7 ou escale inconnue rejetés, simulate racine accepté", () => {
  assert.throws(() => mergeConfig({ scenario: { nights: 0 } }));
  assert.throws(() => mergeConfig({ scenario: { nights: 8 } }));
  assert.throws(() => mergeConfig({ scenario: { seed: 1.5 } }));
  assert.throws(() => mergeConfig({ scenario: { station: "XXX" } }));
  assert.equal(mergeConfig({ scenario: { station: "NOU", nights: 7 } }).scenario.station, "NOU");
  assert.equal(mergeConfig({ simulate: true }).scenario.simulate, true);
});

test("scenario : resolveDates — défaut aujourd'hui en heure LOCALE, checkout = checkin + nights", () => {
  const now = new Date(2026, 9, 4, 23, 30); // 4 octobre 2026 23:30 locale (UTC basculerait au 5)
  const { checkin, checkout } = resolveDates({ checkin: null, nights: 2 }, now);
  assert.equal(checkin, "2026-10-04");
  assert.equal(checkout, "2026-10-06");
  const fixed = resolveDates({ checkin: "2026-12-31", nights: 1 }, now);
  assert.deepEqual(fixed, { checkin: "2026-12-31", checkout: "2027-01-01" });
});
