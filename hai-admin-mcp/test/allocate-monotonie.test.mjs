/**
 * Test de CARACTÉRISATION du levier « plafond de prix » (C1).
 *
 * Il ne certifie pas un bon comportement : il fige un comportement MESURÉ, pour qu'une
 * affirmation de monotonie ne puisse pas revenir dans le code ou dans la documentation
 * sans qu'une mesure la contredise.
 *
 * Mesure : liste générée seed 42 (324 passagers), vivier contraint de 8 hôtels de 55 à
 * 200 EUR, seul `policy.cabins.Y.price_cap_eur` varie. Monter le plafond Y de 50 à 70 EUR
 * fait TOMBER le nombre de dossiers logés (87 → 83), à nombre de chambres constant :
 * `rankedFor()` trie par niveau de conformité, qui dépend du plafond, et un plafond plus
 * haut fait entrer d'autres hôtels en tête de liste, ce qui redéplace les prises.
 *
 * Tant que ce test passe, le levier n'est PAS sûr : un exploitant qui monte le plafond
 * en séance pour « loger plus de monde » peut en loger moins. Le jour où l'ordre de
 * `rankedFor()` sera rendu indépendant du plafond, ce test échouera — c'est voulu :
 * il faudra alors le remplacer par une vraie assertion de monotonie.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePassengers } from "../lib/passagers.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { allocate } from "../lib/allocate.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { STATION_BKK, mkHotel, mkRoom } from "./helpers.mjs";

function mesurerGrille() {
  const { rows } = generatePassengers({ seed: 42 });
  const dossiers = buildDossiers(rows, DEFAULT_POLICY);
  const inventories = [55, 70, 85, 100, 120, 145, 175, 200].map((p, i) =>
    mkHotel(`h${i}`, {}, [
      mkRoom({ room_type: "Twin Room", price_per_night: p, quantity_available: 9, cap_reached: false }),
      mkRoom({
        room_type: "Family Room", price_per_night: p + 30, quantity_available: 4,
        occupancy_adults: 2, occupancy_children: 2, family_capable: true, cap_reached: false,
      }),
    ]),
  );
  const serie = [];
  for (let cap = 50; cap <= 320; cap += 10) {
    const policy = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
    policy.cabins.Y.price_cap_eur = cap;
    const r = allocate({ dossiers, inventories, policy, station: STATION_BKK, nights: 1 });
    serie.push({ cap, ok: r.summary.ok, chambres: r.summary.chambres });
  }
  return serie;
}

test("allocation : le levier « plafond » n'est PAS monotone — mesure de référence, pas une garantie", () => {
  const serie = mesurerGrille();
  const chutes = serie.filter((p, i) => i > 0 && p.ok < serie[i - 1].ok);
  assert.ok(
    chutes.length > 0,
    "monter le plafond ne fait plus perdre de dossier : le levier est peut-être devenu monotone — " +
      "remplacer ce test de caractérisation par une vraie assertion de monotonie, et corriger " +
      "les commentaires et la documentation qui décrivent le levier.",
  );
  // la falaise que les DEUX PASSES ont supprimée ne doit pas revenir : entre le plafond
  // le plus bas et le plus haut, on ne perd pas la moitié du plan
  const premier = serie[0];
  const dernier = serie[serie.length - 1];
  assert.ok(
    dernier.ok >= premier.ok * 0.9,
    `falaise de plafond revenue : ${premier.ok} dossiers à ${premier.cap} EUR → ${dernier.ok} à ${dernier.cap} EUR`,
  );
});
