/**
 * Tests stations (CDC §5.2, §12.2) : 3 fiches valides et ordonnées, fiche invalide
 * rejetée, cohérence EX-STA-2 ; et hai-urls : buildNflt sans distance= pour NOU
 * (EX-DIS-3), URLs de recherche/fiche/sonde.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadStation, listStations, StationSchema, DEFAULT_STATION } from "../lib/stations.mjs";
import { buildNflt, buildSearchUrl, buildHotelUrl, buildProbeUrl } from "../lib/hai-urls.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { effectiveCaps } from "../lib/policy.mjs";

test("stations : les 3 fiches livrées sont valides, listées par demo_priority, BKK par défaut (EX-STA-1)", () => {
  const stations = listStations();
  assert.deepEqual(stations.map((s) => s.code), ["BKK", "CDG", "NOU"]);
  assert.equal(DEFAULT_STATION, "BKK");
  const bkk = loadStation("bkk"); // casse tolérée
  assert.equal(bkk.search.zone_query, "Suvarnabhumi Airport Bangkok");
  assert.equal(bkk.fallback_hotels.length, 4); // liste v1 du POC
  const nou = loadStation("NOU");
  assert.equal(nou.search.distance_ref, "zone_center");
  assert.equal(nou.search.use_distance_filter, false);
  assert.equal(nou.transfer.max_transfer_min, 75); // H-5, valeur de départ
});

test("stations : fiche invalide rejetée avec message explicite (EX-STA-4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stations-"));
  try {
    fs.writeFileSync(path.join(dir, "XXX.json"), JSON.stringify({ code: "XXX", name: "X" }), "utf8");
    assert.throws(() => loadStation("XXX", { dir }), /invalide.*country/s);
    fs.writeFileSync(path.join(dir, "YYY.json"), "{pas du json", "utf8");
    assert.throws(() => loadStation("YYY", { dir }), /illisible/);
    assert.throws(() => loadStation("ZZZ", { dir }), /introuvable/);
    // EX-STA-2 : zone_center + use_distance_filter=true est incohérent
    const bad = structuredClone(loadStation("NOU"));
    bad.search.use_distance_filter = true;
    assert.equal(StationSchema.safeParse(bad).success, false);
    // code ≠ nom de fichier
    const bkk = structuredClone(loadStation("BKK"));
    bkk.code = "CDG";
    fs.writeFileSync(path.join(dir, "BKK.json"), JSON.stringify(bkk), "utf8");
    assert.throws(() => loadStation("BKK", { dir }), /ne correspond pas/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hai-urls : buildNflt — distance présent pour BKK, ABSENT pour NOU (EX-DIS-3), extra_nflt ajouté", () => {
  const bkk = loadStation("BKK");
  const nou = loadStation("NOU");
  const nfltBkk = buildNflt(DEFAULT_POLICY, bkk);
  assert.ok(nfltBkk.socle.includes("distance=5000"), nfltBkk.socle);
  assert.ok(nfltBkk.socle.includes("class=3;class=4;class=5"));
  assert.ok(nfltBkk.socle.includes("hotelfacility=107")); // wifi
  assert.ok(nfltBkk.socle.includes("review_score=70"));
  assert.ok(nfltBkk.socle.includes("ht_id=204"));
  assert.equal(nfltBkk.premium, "class=4;class=5;hotelfacility=5;ht_id=204");

  const nfltNou = buildNflt(DEFAULT_POLICY, nou);
  assert.ok(!nfltNou.socle.includes("distance="), nfltNou.socle);
  assert.ok(!nfltNou.premium.includes("distance="));

  const extra = structuredClone(bkk);
  extra.search.extra_nflt = ["fc=2"];
  const nfltExtra = buildNflt(DEFAULT_POLICY, extra);
  assert.ok(nfltExtra.socle.endsWith(";fc=2"));
  assert.ok(nfltExtra.premium.endsWith(";fc=2"));
});

test("hai-urls : buildSearchUrl porte la zone de la fiche, les dates et l'EUR", () => {
  const nou = loadStation("NOU");
  const url = buildSearchUrl({ station: nou, checkin: "2026-10-04", checkout: "2026-10-05", nflt: buildNflt(DEFAULT_POLICY, nou).socle });
  assert.ok(url.startsWith("https://www.booking.com/searchresults.fr.html?"));
  assert.ok(url.includes("ss=Noum%C3%A9a"));
  assert.ok(url.includes("checkin=2026-10-04") && url.includes("checkout=2026-10-05"));
  assert.ok(url.includes("selected_currency=EUR"));
  assert.ok(!url.includes("distance="));
});

test("hai-urls : buildHotelUrl nettoie l'URL et pose dates/devise ; buildProbeUrl pose no_rooms et group_adults (H-3)", () => {
  const hotel = buildHotelUrl("https://www.booking.com/hotel/th/divalux-resort-spa.html?utm=x#map", { checkin: "2026-10-04", checkout: "2026-10-05" });
  assert.ok(hotel.startsWith("https://www.booking.com/hotel/th/divalux-resort-spa.html?"));
  assert.ok(!hotel.includes("utm=") && !hotel.includes("#"));
  assert.ok(hotel.includes("group_adults=2") && hotel.includes("no_rooms=1"));

  const probe = buildProbeUrl("https://www.booking.com/hotel/th/divalux-resort-spa.html", { checkin: "2026-10-04", checkout: "2026-10-05", noRooms: 12 });
  assert.ok(probe.includes("no_rooms=12") && probe.includes("group_adults=24"));
  assert.throws(() => buildProbeUrl("https://x.test/h", { checkin: "a", checkout: "b", noRooms: 0 }), /noRooms invalide/);
  assert.throws(() => buildProbeUrl("pas une url", { checkin: "a", checkout: "b", noRooms: 2 }), /URL hôtel invalide/);
});

test("stations : le facteur de plafond de la fiche s'applique via effectiveCaps (EX-POL-1)", () => {
  const cdg = loadStation("CDG");
  assert.deepEqual(effectiveCaps(DEFAULT_POLICY, cdg), { J: 250, W: 130, Y: 80 }); // facteur 1.0 (H-5)
  const cher = structuredClone(cdg);
  cher.pricing.price_cap_factor = 1.2;
  assert.deepEqual(effectiveCaps(DEFAULT_POLICY, cher), { J: 300, W: 156, Y: 96 });
});
