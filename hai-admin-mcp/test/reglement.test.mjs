/**
 * Tests reglement (CDC §12.2) : règle company_payment_possible (EX-INV-4, H-1),
 * 3 modes de règlement, carte désactivée + paiement impossible → escalade (EX-ALL-6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { companyPaymentPossible, modeReglement } from "../lib/reglement.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";

test("reglement : company_payment_possible — oui si contracté ou prépaiement en ligne (EX-INV-4)", () => {
  assert.equal(companyPaymentPossible({ contracted: true, payment: { prepayment_online: "non", pay_at_property_only: true } }), "oui");
  assert.equal(companyPaymentPossible({ payment: { prepayment_online: "oui" } }), "oui");
  assert.equal(companyPaymentPossible({ payment: { prepayment_online: "non", pay_at_property_only: true } }), "non");
  assert.equal(companyPaymentPossible({ payment: { prepayment_online: "non_precise", pay_at_property_only: null } }), "a_confirmer");
  assert.equal(companyPaymentPossible({}), "a_confirmer"); // rien de connu → à confirmer, jamais un défaut silencieux
  // valeur déjà calculée : reprise telle quelle ; valeur invalide : erreur explicite
  assert.equal(companyPaymentPossible({ payment: { company_payment_possible: "non" } }), "non");
  assert.throws(() => companyPaymentPossible({ payment: { company_payment_possible: "peut-etre" } }), /invalide/);
});

/* modeReglement rend désormais deux champs ADDITIFS en plus de `mode`/`escalade` :
 * `company_payment_possible` (la règle EX-INV-4 telle qu'elle a été lue) et `source`
 * (la branche de décision : paiement_compagnie, repli_carte, mode_nominal,
 * prepaiement_en_ligne_contracte, politique_incoherente, aucun_moyen). Ils tracent
 * POURQUOI une ligne du plan est réglée comme elle l'est — c'est ce que le validateur
 * humain doit pouvoir relire (C6/C7), et docs/matrice-affectation.md les documente.
 * Les tests passent donc d'un `deepEqual` exhaustif — qui interdisait tout champ neuf —
 * à des assertions champ par champ, `source` comprise : rien n'est relâché, la décision
 * ET sa cause sont verrouillées. */

test("reglement : mode compagnie quand le paiement compagnie est possible", () => {
  const r = modeReglement({ payment: { prepayment_online: "oui" } }, DEFAULT_POLICY);
  assert.equal(r.mode, "compagnie");
  assert.equal(r.escalade, false);
  assert.equal(r.company_payment_possible, "oui");
  assert.equal(r.source, "paiement_compagnie");
});

test("reglement : mode carte_prepayee quand paiement impossible et carte activée", () => {
  const r = modeReglement({ payment: { prepayment_online: "non", pay_at_property_only: true } }, DEFAULT_POLICY);
  assert.equal(r.mode, "carte_prepayee");
  assert.equal(r.escalade, false);
  assert.equal(r.company_payment_possible, "non");
  assert.equal(r.source, "repli_carte"); // DEFAULT_POLICY.payment.default_mode = "compagnie"
});

test("reglement : mode compagnie_a_confirmer quand la plateforme ne précise pas", () => {
  const r = modeReglement({ payment: { prepayment_online: "non_precise", pay_at_property_only: null } }, DEFAULT_POLICY);
  assert.equal(r.mode, "compagnie_a_confirmer");
  assert.equal(r.escalade, false);
  assert.equal(r.company_payment_possible, "a_confirmer");
  assert.equal(r.source, "paiement_compagnie");
});

test("reglement : carte désactivée + paiement impossible → escalade DESK motif règlement (EX-ALL-6)", () => {
  const policy = structuredClone(DEFAULT_POLICY);
  policy.payment.prepaid_card.enabled = false;
  const r = modeReglement({ payment: { prepayment_online: "non", pay_at_property_only: true } }, policy);
  assert.equal(r.escalade, true);
  assert.equal(r.mode, null);
  assert.equal(r.motif, "règlement");
});
