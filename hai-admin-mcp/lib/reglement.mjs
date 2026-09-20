/**
 * Mode de règlement par hôtel (EX-ALL-6) et règle `company_payment_possible`
 * (EX-INV-4, hypothèse H-1 validée le 14/09 — signalée dans ETAT.md).
 * Modules purs : aucune estimation, aucun défaut silencieux au-delà des règles CDC.
 *
 * C7 : la carte prépayée est un MODE VOULU, pas un repli subi. `policy.payment.default_mode`
 * commande la décision ; `company_payment_possible` ne sert plus qu'à trancher le cas
 * `default_mode = "compagnie"` et à documenter le cas carte.
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
 * Seule exception au mode carte : l'hôtel est CONTRACTÉ **et** le prépaiement en ligne
 * est confirmé — la chambre est alors déjà réglée par la compagnie à la réservation, et
 * charger une carte par-dessus reviendrait à payer deux fois. Les deux conditions sont
 * exigées : `prepayment_online = "oui"` sans contrat dit seulement que la compagnie
 * *pourrait* payer, pas qu'elle l'a fait ; un contrat sans prépaiement laisse le
 * règlement à faire au comptoir, ce que la carte du passager couvre précisément.
 * Un `company_payment_possible` pré-calculé (inventaire.mjs) ne suffit pas : il agrège
 * les deux cas et ne dit pas lequel s'applique.
 *
 * @param {object} hotel voir companyPaymentPossible()
 * @returns {boolean}
 */
function dejaRegleParLaCompagnie(hotel = {}) {
  return hotel.contracted === true && (hotel.payment ?? {}).prepayment_online === "oui";
}

/** Décision historique (`default_mode = "compagnie"`) : le paiement compagnie d'abord. */
function modeCompagnieDabord(cpp, carteActive) {
  if (cpp === "oui") return { mode: "compagnie", escalade: false, source: "paiement_compagnie" };
  if (cpp === "a_confirmer") return { mode: "compagnie_a_confirmer", escalade: false, source: "paiement_compagnie" };
  if (carteActive) return { mode: "carte_prepayee", escalade: false, source: "repli_carte" };
  return { mode: null, escalade: true, motif: "règlement", source: "aucun_moyen" };
}

/**
 * Mode de règlement d'une ligne du plan (EX-ALL-6, C7).
 *
 * `policy.payment.default_mode = "carte_prepayee"` (mode nominal client) : la ligne sort en
 * `carte_prepayee` quel que soit `company_payment_possible`, sauf hôtel contracté déjà
 * prépayé en ligne (voir dejaRegleParLaCompagnie) qui reste en `compagnie`. Carte désactivée
 * alors que la politique la désigne : incohérence signalée par `avertissement`, repli
 * explicite sur la décision `compagnie` — jamais un basculement muet.
 *
 * `default_mode = "compagnie"` : comportement historique inchangé (compagnie si possible,
 * carte en repli, escalade DESK motif « règlement » si la carte est désactivée).
 *
 * @param {object} hotel voir companyPaymentPossible()
 * @param {object} policy politique validée (policy.payment)
 * @returns {{mode: "compagnie"|"carte_prepayee"|"compagnie_a_confirmer"|null, escalade: boolean,
 *            motif?: string, source: string, company_payment_possible: string, avertissement?: string}}
 */
export function modeReglement(hotel, policy) {
  const cpp = companyPaymentPossible(hotel);
  const paiement = policy.payment ?? {};
  const carteActive = paiement.prepaid_card?.enabled === true;
  const base = { company_payment_possible: cpp };

  if (paiement.default_mode === "carte_prepayee") {
    if (!carteActive) {
      return {
        ...base,
        ...modeCompagnieDabord(cpp, false),
        source: "politique_incoherente",
        avertissement:
          "payment.default_mode = carte_prepayee mais payment.prepaid_card.enabled = false — " +
          "repli sur le règlement compagnie, aucune carte ne sera émise",
      };
    }
    if (dejaRegleParLaCompagnie(hotel)) {
      return { ...base, mode: "compagnie", escalade: false, source: "prepaiement_en_ligne_contracte" };
    }
    return { ...base, mode: "carte_prepayee", escalade: false, source: "mode_nominal" };
  }

  return { ...base, ...modeCompagnieDabord(cpp, carteActive) };
}
