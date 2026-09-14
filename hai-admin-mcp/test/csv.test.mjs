/**
 * Tests csv : BOM, aller-retour, colonnes obligatoires, échappement des champs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePassagersCsv, toCsvBom, PAX_COLS } from "../lib/csv.mjs";

test("csv : toCsvBom écrit BOM + en-tête + lignes, parsePassagersCsv fait l'aller-retour", () => {
  const rows = [
    { pnr: "SB001AAA", nom: "MARTIN", prenom: "Jean", type_pax: "ADT", age: "42", cabine: "J", flying_blue: "GOLD", assistance: "", remarque: "" },
    { pnr: "SB002BBB", nom: "PETIT", prenom: "Lea", type_pax: "CHD", age: "8", cabine: "Y", flying_blue: "NONE", assistance: "", remarque: "" },
  ];
  const csv = toCsvBom(PAX_COLS, rows);
  assert.ok(csv.startsWith("﻿" + PAX_COLS.join(";")));
  assert.ok(csv.endsWith("\n"));
  const back = parsePassagersCsv(csv);
  assert.deepEqual(back, rows);
});

test("csv : colonne obligatoire manquante → erreur explicite", () => {
  assert.throws(() => parsePassagersCsv("pnr;nom\nX;Y\n"), /Colonne manquante/);
  assert.throws(() => parsePassagersCsv(""), /CSV vide/);
});

test("csv : champ avec ; guillemets ou saut de ligne échappé (corps de messages)", () => {
  const csv = toCsvBom(["a", "b"], [{ a: "x;y", b: 'ligne 1\nligne "2"' }]);
  assert.ok(csv.includes('"x;y"'));
  assert.ok(csv.includes('"ligne 1\nligne ""2"""'));
  // un champ sans caractère spécial reste nu
  assert.ok(!toCsvBom(["a"], [{ a: "simple" }]).includes('"'));
});
