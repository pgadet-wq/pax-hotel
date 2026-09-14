/**
 * Coût du plan d'hébergement (CDC §8.1) — fonction PURE.
 *
 * EX-COU-1 : aucun montant n'est estimé. Un poste dont la politique ne renseigne
 * pas le montant (H-7 : repas, transport) est listé dans `not_determinable` et
 * affiché « non renseigné » — jamais un zéro qui ressemblerait à une gratuité.
 */
import { effectiveCaps } from "./policy.mjs";
import { DEFAULT_AVION } from "./scenario.mjs";

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {Array} plan lignes du plan (sortie d'allocate)
 * @param {object} policy politique validée (plafonds, allowances)
 * @param {object} scenario scénario validé (nights)
 * @param {object} [opts] {avion (défaut A350-900 34/24/266), station (facteur de plafond)}
 * @returns {object} forme §8.1
 */
export function computeCost(plan, policy, scenario, { avion = DEFAULT_AVION, station = null } = {}) {
  const nights = scenario?.nights ?? 1;
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`computeCost : nights invalide (${nights})`);

  const per_night = { J: 0, W: 0, Y: 0, total: 0 };
  const escalated_rooms = { J: 0, W: 0, Y: 0 };
  let pax = 0;
  for (const row of plan) {
    const tier = row.cabine;
    if (!(tier in per_night)) throw new Error(`computeCost : cabine inconnue sur la ligne ${row.pnr} (${tier})`);
    pax += Number(row.pax) || 0;
    if (row.statut === "OK" && row.prix_total !== "") {
      per_night[tier] += Number(row.prix_total) / nights;
    } else if (row.statut !== "OK") {
      escalated_rooms[tier] += Number(row.chambres) || 0;
    }
  }
  for (const t of ["J", "W", "Y"]) per_night[t] = round2(per_night[t]);
  per_night.total = round2(per_night.J + per_night.W + per_night.Y);

  // borne haute : Σ sièges × plafond effectif, une chambre par passager
  const caps = effectiveCaps(policy, station);
  const seats = avion.seats ?? avion;
  const upper_bound_at_caps = ["J", "W", "Y"].reduce((s, t) => s + (Number(seats[t]) || 0) * caps[t], 0);

  const mealRate = policy.allowances.meal_eur_per_pax_per_day;
  const transportRate = policy.allowances.transport_eur_per_pax;
  const not_determinable = [];
  const allowances = { meal: null, transport: null };
  if (mealRate === null) not_determinable.push("repas");
  else allowances.meal = round2(mealRate * pax * nights);
  if (transportRate === null) not_determinable.push("transport");
  else allowances.transport = round2(transportRate * pax);

  return {
    per_night,
    nights,
    projection_total: round2(per_night.total * nights),
    upper_bound_at_caps,
    allowances,
    not_determinable,
    escalated_rooms,
  };
}
