/**
 * Mode de règlement par hôtel (EX-ALL-6) et règle `company_payment_possible`
 * (EX-INV-4, hypothèse H-1 validée le 14/09 — signalée dans ETAT.md).
 * Modules purs : aucune estimation, aucun défaut silencieux au-delà des règles CDC.
 */

/**
 * Règle EX-INV-4 : `"oui"` si `contracted` ou `prepayment_online = "oui"` ;
 * `"non"` si `pay_at_property_only = true` et non contracté ; sinon `"a_confirmer"`.
 * Accepte une valeur déjà calculée (`payment.company_payment_possible`) sans la recalculer.
 *
 * @param {object} hotel {contracted?, payment?: {prepayment_online?, pay_at_property_only?, company_payment_possible?}}
 * @returns {"oui"|"non"|"a_confirmer"}
 */
export function companyPaymentPossible(hotel = {}) {
  const pay = hotel.payment ?? {};
  if (pay.company_payment_possible) {
    if (!["oui", "non", "a_confirmer"].includes(pay.company_payment_possible)) {
      throw new Error(`company_payment_possible invalide : ${pay.company_payment_possible}`);
    }
    return pay.company_payment_possible;
  }
  const contracted = hotel.contracted === true;
  if (contracted || pay.prepayment_online === "oui") return "oui";
  if (pay.pay_at_property_only === true && !contracted) return "non";
  return "a_confirmer";
}

/**
 * Mode de règlement d'une ligne du plan (EX-ALL-6) :
 * `compagnie` si `company_payment_possible = "oui"` ; `carte_prepayee` si `"non"` et
 * carte activée ; `compagnie_a_confirmer` si `"a_confirmer"`. Carte désactivée et
 * paiement impossible → escalade DESK motif « règlement ».
 *
 * @param {object} hotel voir companyPaymentPossible()
 * @param {object} policy politique validée (policy.payment)
 * @returns {{mode: "compagnie"|"carte_prepayee"|"compagnie_a_confirmer"|null, escalade: boolean, motif?: string}}
 */
export function modeReglement(hotel, policy) {
  const cpp = companyPaymentPossible(hotel);
  if (cpp === "oui") return { mode: "compagnie", escalade: false };
  if (cpp === "a_confirmer") return { mode: "compagnie_a_confirmer", escalade: false };
  if (policy.payment.prepaid_card.enabled) return { mode: "carte_prepayee", escalade: false };
  return { mode: null, escalade: true, motif: "règlement" };
}
