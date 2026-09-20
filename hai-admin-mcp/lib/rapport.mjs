/**
 * Livrables du run (CDC §8) : plan CSV (colonnes §5.7), rapport Markdown,
 * messages CSV. Retourne des chaînes, l'appelant (CLI ou serveur) décide où écrire.
 */
import { toCsvBom } from "./csv.mjs";
import { effectiveCaps } from "./policy.mjs";

/** Colonnes §5.7 : colonnes v1 + `conformite` + ajouts v2. */
export const PLAN_COLS = [
  "pnr", "occupants", "pax", "cabine", "overlays", "categorie",
  "hotel", "hotel_url", "room_type", "chambres", "prix_total", "devise",
  "conformite", "mode_reglement", "hotel_source", "provisoire",
  "session_ref", "transfert", "escalade", "hors_plan", "sous_reserve", "statut", "notes",
];

export function buildPlanCsv(plan) {
  return toCsvBom(PLAN_COLS, plan);
}

export const MESSAGES_COLS = ["pnr", "lang", "subject", "body"];

/** Liste d'appel PAR HÔTEL (§8) : ce que l'escale lit au téléphone, hôtel par hôtel. */
export const ROOMING_COLS = [
  "hotel", "hotel_url", "chambres_hotel", "personnes_hotel", "mode_reglement",
  "pnr", "titulaire", "occupants", "pax", "cabine", "overlays", "room_type", "chambres",
  "prix_total", "devise", "conformite", "notes",
];

/**
 * Le plan est trié par dossier : inexploitable pour appeler un hôtel. Cette sortie
 * le regroupe par établissement, avec le total de chambres et de personnes en tête
 * de chaque bloc — c'est la forme dont le comptoir a besoin pour négocier et pour
 * appeler les passagers à la porte du bus.
 */
export function buildRoomingCsv(plan) {
  const parHotel = new Map();
  for (const row of plan) {
    if (row.statut !== "OK" || !row.hotel) continue;
    if (!parHotel.has(row.hotel)) parHotel.set(row.hotel, []);
    parHotel.get(row.hotel).push(row);
  }
  const rows = [];
  for (const [hotel, lignes] of [...parHotel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const chambres = lignes.reduce((s2, r) => s2 + (Number(r.chambres) || 0), 0);
    const personnes = lignes.reduce((s2, r) => s2 + (Number(r.pax) || 0), 0);
    for (const r of lignes) {
      rows.push({
        hotel,
        hotel_url: r.hotel_url ?? "",
        chambres_hotel: chambres,
        personnes_hotel: personnes,
        mode_reglement: r.mode_reglement ?? "",
        pnr: r.pnr,
        titulaire: String(r.occupants ?? "").split(",")[0].trim(),
        occupants: r.occupants ?? "",
        pax: r.pax ?? "",
        cabine: r.cabine ?? "",
        overlays: r.overlays ?? "",
        room_type: r.room_type ?? "",
        chambres: r.chambres ?? "",
        prix_total: r.prix_total ?? "",
        devise: r.devise ?? "",
        conformite: r.conformite ?? "",
        notes: r.notes ?? "",
      });
    }
  }
  return toCsvBom(ROOMING_COLS, rows);
}

export function buildMessagesCsv(messages) {
  return toCsvBom(MESSAGES_COLS, messages);
}

const fmtMoney = (v) => Number(v).toLocaleString("fr-FR");
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "?";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/**
 * Rapport Markdown : scénario, escale, politique, relevés horodatés (EX-REL-2),
 * plan par tier, escalades, extension et coût si fournis, avertissements.
 * @param {{plan, summary, gaps}} alloc sortie d'allocate
 * @param {Array} inventories relevés
 * @param {object} ctx {station, scenario?, policy, checkin, checkout, nights?, runId?, cost?, extension?, warnings?}
 */
export function buildRapportMd(alloc, inventories, ctx) {
  const { plan, summary, gaps } = alloc;
  const { station, policy, checkin, checkout, runId, cost, extension, warnings, ingestion } = ctx;
  const nights = ctx.nights ?? Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
  const caps = effectiveCaps(policy, station);
  const lines = [];

  lines.push(`# Plan d'hébergement — ${station?.name ?? "escale"} (démo v2)`);
  lines.push("");
  lines.push(`**Arrivée du vol : ${checkin}** · hébergement du **${checkin}** au **${checkout}** (${nights} nuit${nights > 1 ? "s" : ""})`);
  if (runId) lines.push(`Run \`${runId}\``);
  if (station) {
    lines.push(
      `Escale ${station.code} · transfert par défaut : ${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min` +
        (station.pricing?.price_cap_factor && station.pricing.price_cap_factor !== 1
          ? ` · facteur de plafond ${station.pricing.price_cap_factor}`
          : ""),
    );
  }
  lines.push("");
  lines.push(`## Synthèse`);
  lines.push("");
  const chambresOk = plan.filter((p) => p.statut === "OK").reduce((s, p) => s + p.chambres, 0);
  const couts = Object.entries(summary.coutParDevise).map(([d, v]) => `${fmtMoney(v)} ${d}`).join(" + ") || "0";
  lines.push(`- Dossiers hébergés en ligne : **${summary.ok}** (${chambresOk} chambres, ${summary.paxLoges ?? "?"} personnes)`);
  lines.push(`- Dossiers à escalader au desk : **${summary.escalade}** — **${summary.paxNonLoges ?? "?"} personnes non logées**`);
  if (summary.motifs && Object.keys(summary.motifs).length) {
    lines.push(`  - motifs : ${Object.entries(summary.motifs).map(([m, n]) => `${m} ${n}`).join(" · ")}`);
    if (summary.horsPlan) lines.push(`  - dont **${summary.horsPlan} hors plan hôtel** (traitement nominatif au desk) : relever plus d'hôtels ne les logera pas`);
  }
  lines.push(`- Coût total relevé : **${couts}**`);
  lines.push("");
  lines.push(`| Cabine | OK | Escalade | Chambres | Plafond effectif |`);
  lines.push(`|---|---|---|---|---|`);
  for (const tier of ["J", "W", "Y"]) {
    const s = summary.parTier[tier] ?? { ok: 0, escalade: 0, chambres: 0 };
    lines.push(`| ${tier} | ${s.ok} | ${s.escalade} | ${s.chambres} | ${caps[tier]} EUR/nuit |`);
  }
  lines.push("");

  if (ingestion) {
    const c = ingestion.compteurs ?? {};
    lines.push(`## Liste passagers (ingestion)`);
    lines.push("");
    if (ingestion.fichier) {
      lines.push(`- fichier : ${ingestion.fichier.encodage}, séparateur « ${ingestion.fichier.separateur} », ${ingestion.fichier.colonnes_lues?.length ?? "?"} colonnes lues`);
      if (ingestion.fichier.alias_appliques?.length) lines.push(`- en-têtes traduits : ${ingestion.fichier.alias_appliques.join(", ")}`);
      if (ingestion.fichier.colonnes_ignorees?.length) lines.push(`- colonnes ignorées : ${ingestion.fichier.colonnes_ignorees.join(", ")}`);
      if (ingestion.fichier.lignes_ignorees?.length) {
        lines.push(`- **${ingestion.fichier.lignes_ignorees.length} ligne(s) écartée(s) à la lecture** : ${ingestion.fichier.lignes_ignorees.slice(0, 10).map((l) => `ligne ${l.ligne} (${l.motif})`).join(" ; ")}`);
      }
    }
    lines.push(`- lignes : ${ingestion.lignes?.lues ?? "?"} lues · ${ingestion.lignes?.retenues ?? "?"} retenues · ${ingestion.lignes?.refusees ?? 0} refusées`);
    lines.push(`- à loger : ${c.a_loger ?? "?"} passagers · ${c.dossiers ?? "?"} dossiers — J ${c.parCabine?.J ?? 0} / W ${c.parCabine?.W ?? 0} / Y ${c.parCabine?.Y ?? 0}`);
    lines.push(`- types : ${c.parType?.ADT ?? 0} ADT, ${c.parType?.CHD ?? 0} CHD, ${c.parType?.INF ?? 0} INF · PMR ${c.pmr ?? 0} · animaux ${c.animaux ?? 0} · groupes ${c.groupes?.length ?? 0}`);
    lines.push(`- hors plan hôtel : ${c.escalades?.nominative ?? 0} nominative(s) · ${c.escalades?.droit_entree ?? 0} sur droit d'entrée · équipage ${c.equipage ?? 0}`);
    const exclus = Object.entries(c.exclus ?? {}).map(([k, n]) => `${k} ${n}`).join(", ");
    if (exclus) lines.push(`- exclus du plan (non logés) : ${exclus}`);
    if (ingestion.alias_valeurs?.length) lines.push(`- valeurs traduites : ${ingestion.alias_valeurs.join(" · ")}`);
    lines.push("");
  }

  lines.push(`## Relevés par hôtel`);
  lines.push("");
  for (const inv of inventories) {
    const a = inv.answer;
    lines.push(`### ${a?.hotel || inv.name || inv.hotelKey || inv.hotel}`);
    lines.push("");
    lines.push(`- session : \`${inv.sessionId ?? "-"}\` · statut ${inv.status ?? "-"} · outcome ${inv.outcome ?? "-"}`);
    if (inv.error) lines.push(`- erreur : ${inv.error}`);
    if (a?.found) {
      if (a.observed_at) lines.push(`- **prix relevé le ${fmtDateTime(a.observed_at)}** — prix affiché, non garanti`);
      const am = a.amenities ?? {};
      const dist = a.distance_km ?? a.distance_to_airport_km;
      lines.push(
        `- ${a.stars || "?"}★ · note ${a.review_score ?? "?"}/10 (${a.review_count ?? "?"} avis) · ` +
          `${dist >= 0 ? `${dist} km (réf. ${a.distance_ref ?? "airport"})` : "distance non affichée"} · devise ${a.currency}`,
      );
      lines.push(
        `- équipements déclarés par la plateforme : wifi ${am.wifi_free ? "oui" : "non"} · room service ${am.room_service ?? "?"} · ` +
          `espace travail ${am.workspace === true || am.workspace === "oui" ? "oui" : am.workspace === "non_precise" ? "non précisé" : "non"} · ` +
          `navette ${am.airport_shuttle ?? "?"} · resto tardif ${am.restaurant_late ? "oui" : "non"} · PMR ${am.accessible ? "oui" : "non"}`,
      );
      if (a.payment) {
        lines.push(`- paiement : prépaiement en ligne ${a.payment.prepayment_online ?? "non précisé"} · paiement sur place uniquement ${a.payment.pay_at_property_only === true ? "oui" : a.payment.pay_at_property_only === false ? "non" : "non précisé"}`);
      }
      if (a.notes) lines.push(`- notes agent : ${a.notes}`);
      lines.push("");
      lines.push(`| Type de chambre | Capacité | Famille | Dispo affichée | Plafond atteint | Prix/nuit | Annul. gratuite | Petit-déj |`);
      lines.push(`|---|---|---|---|---|---|---|---|`);
      for (const r of a.rooms ?? []) {
        const displayed = r.quantity_available ?? r.quantity_displayed_max ?? "?";
        lines.push(
          `| ${r.room_type} | ${r.occupancy_adults}A+${r.occupancy_children ?? 0}C | ${r.family_capable ? "oui" : "-"} | ` +
            `${displayed} | ${r.cap_reached ? "oui (borne basse)" : "-"} | ${fmtMoney(r.price_per_night)} | ` +
            `${r.free_cancellation ? "oui" : "non"} | ${r.breakfast_included ? "oui" : "non"} |`,
        );
      }
    } else if (a) {
      lines.push(`- found=false : ${a.notes || "sans détail"}`);
    }
    lines.push("");
  }

  const parHotel = new Map();
  for (const row of plan) {
    if (row.statut !== "OK" || !row.hotel) continue;
    const e = parHotel.get(row.hotel) ?? { chambres: 0, personnes: 0, dossiers: 0, url: row.hotel_url, reglement: row.mode_reglement };
    e.chambres += Number(row.chambres) || 0;
    e.personnes += Number(row.pax) || 0;
    e.dossiers += 1;
    parHotel.set(row.hotel, e);
  }
  if (parHotel.size) {
    lines.push(`## À appeler — totaux par hôtel`);
    lines.push("");
    lines.push(`| Hôtel | Dossiers | Chambres | Personnes | Règlement |`);
    lines.push(`|---|---|---|---|---|`);
    for (const [hotel, e] of [...parHotel.entries()].sort((a, b) => b[1].chambres - a[1].chambres)) {
      lines.push(`| ${hotel} | ${e.dossiers} | **${e.chambres}** | ${e.personnes} | ${e.reglement || "?"} |`);
    }
    lines.push("");
    lines.push(`Détail nominatif par établissement : \`rooming-<runId>.csv\`. Aucune réservation n'est faite par l'outil (INV-1) : ces totaux sont ce qu'il faut demander à chaque hôtel.`);
    lines.push("");
  }

  if (Object.keys(gaps.chambresManquantes).length) {
    lines.push(`## Manques (escalade desk)`);
    lines.push("");
    for (const [tier, n] of Object.entries(gaps.chambresManquantes)) {
      lines.push(`- cabine ${tier} : ${n} chambre(s) non couvertes par l'inventaire en ligne`);
    }
    lines.push("");
  }

  if (extension) {
    lines.push(`## Extension`);
    lines.push("");
    lines.push(`- vagues exécutées : ${extension.waves ?? 0} · sondes : ${extension.probes ?? 0} · relevés supplémentaires : ${extension.surveys ?? 0}`);
    if (extension.limits) {
      lines.push(`- bornes : ${extension.limits.sessions_used ?? "?"}/${extension.limits.sessions_max ?? "?"} sessions · ${extension.limits.cost_usd ?? "?"}/${extension.limits.cost_max ?? "?"} USD`);
    }
    lines.push("");
  }

  if (cost) {
    lines.push(`## Coût`);
    lines.push("");
    lines.push(`- par nuit : J ${fmtMoney(cost.per_night.J)} + W ${fmtMoney(cost.per_night.W)} + Y ${fmtMoney(cost.per_night.Y)} = **${fmtMoney(cost.per_night.total)} EUR**`);
    lines.push(`- projection ${cost.nights} nuit${cost.nights > 1 ? "s" : ""} : **${fmtMoney(cost.projection_total)} EUR**`);
    lines.push(`- borne haute aux plafonds (une chambre par passager) : ${fmtMoney(cost.upper_bound_at_caps)} EUR`);
    lines.push(`- repas : ${cost.allowances.meal === null ? "non renseigné" : `${fmtMoney(cost.allowances.meal)} EUR`} · transport : ${cost.allowances.transport === null ? "non renseigné" : `${fmtMoney(cost.allowances.transport)} EUR`}`);
    if (cost.not_determinable.length) lines.push(`- postes non déterminables : ${cost.not_determinable.join(", ")}`);
    lines.push("");
  }

  const avertIngestion = (ingestion?.avertissements ?? []).map((a) => `liste passagers : ${a.message ?? a}`);
  const tousAvert = [...avertIngestion, ...(warnings ?? [])];
  if (tousAvert.length) {
    lines.push(`## Avertissements`);
    lines.push("");
    for (const w of tousAvert) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push(`## Limites`);
  lines.push("");
  lines.push(
    `Les quantités sont celles affichées en ligne (borne basse : le sélecteur plafonne à ~9 chambres par type). ` +
      `Les prix sont ceux relevés à l'horodatage indiqué — un prix relevé n'est pas un prix garanti. ` +
      `Les équipements sont **déclarés par la plateforme**, non audités ; les mentions « à confirmer » du plan pointent ` +
      `les exigences que la fiche ne précise pas. Les dossiers en escalade relèvent du desk groupe des hôtels. ` +
      `Aucune réservation n'a été effectuée ; prix publics uniquement, sans accord ni tarif négocié.`,
  );
  return lines.join("\n") + "\n";
}
