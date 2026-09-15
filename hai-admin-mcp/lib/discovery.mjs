/**
 * Étage A — Découverte dynamique par zone (CDC §6.2).
 * Une session unique, deux passes de recherche (socle puis premium) par édition
 * d'URL `nflt` ; lecture des cartes de résultats uniquement ; retry × 1 ; repli
 * sur les `fallback_hotels` de la fiche escale (déjà servis par candidatesFrom).
 *
 * NB méthode : les probes du 11/09 ont montré qu'une URL de résultats ouverte à
 * froid est rejetée (errorc_searchstring_not_found, dest_id de session manquant).
 * La méthode fiable — recherche manuelle PUIS ajout de `&nflt=` sur l'URL de
 * résultats — remplace donc le `start_url` par overrides évoqué au CDC §6.2
 * (écart documenté dans ETAT.md).
 */
import {
  agentNameV2, ensureAgentV2, buildNflt, buildSearchUrl, discoverySchema,
  toDiscoveryCandidates, promptDiscovery, pumpToCompletion,
} from "./hai.mjs";
import { isStale, candidatesFrom, slugify } from "./inventaire.mjs";

/**
 * EX-DIS-1 : la découverte ne s'exécute que si `force_discovery`, ou si
 * l'inventaire est absent/périmé, ou si un tier ayant des besoins compte moins
 * de `inventory.min_candidates_per_tier` candidats compatibles. Fonction pure.
 * @returns {{run: boolean, reason: string}}
 */
export function discoveryNeeded({ inv, policy, station, needs, force = false, now = new Date() }) {
  if (force) return { run: true, reason: "force_discovery" };
  if (isStale(inv, policy, now)) return { run: true, reason: inv ? "inventaire périmé" : "inventaire absent" };
  const cands = candidatesFrom(inv, policy, { station, needs });
  const min = policy.inventory.min_candidates_per_tier;
  for (const tier of ["J", "W", "Y"]) {
    if ((needs?.[tier]?.chambres ?? 0) <= 0) continue;
    const n = cands.filter((c) => c.tiers.includes(tier)).length;
    if (n < min) return { run: true, reason: `tier ${tier} : ${n} candidat(s) compatible(s) < ${min}` };
  }
  return { run: false, reason: "inventaire frais et suffisant" };
}

/** Candidat de découverte → entrée d'inventaire minimale (fusion EN MÉMOIRE, EX-DIS-2). */
export function candidateToEntry(candidate, { observedAt = null } = {}) {
  return {
    id: slugify(candidate.name),
    name: candidate.name,
    url: candidate.url || "",
    source: "agent",
    contracted: false, preferred: false, excluded: false,
    stars: candidate.stars ?? null,
    review_score: candidate.review_score ?? null,
    review_count: candidate.review_count ?? null,
    distance_km: candidate.distance_km ?? null,
    distance_ref: null,
    amenities: {}, // badges de carte non confirmés : rien n'est affirmé avant relevé
    payment: { prepayment_online: "non_precise", pay_at_property_only: null },
    indicative_price_from_eur: candidate.price_from_per_night ?? null,
    capacity_hint: null,
    contact: { phone: null, email: null },
    notes: candidate.amenities_seen?.length ? `badges vus : ${candidate.amenities_seen.join(", ")}${candidate.premium_pass ? " ; passe premium" : ""}` : "",
    last_survey_at: observedAt,
  };
}

/**
 * Lance la session de découverte (1 session, 2 passes). Retourne les candidats ;
 * en échec après retry, liste vide avec warning (le repli `fallback_hotels` est
 * assuré par candidatesFrom).
 */
export async function runDiscovery({ client, policy, station, checkin, checkout, groupId, emit, signal, attempt = 1 }) {
  await ensureAgentV2(client, station, policy);
  const nflt = buildNflt(policy, station);
  const urls = {
    socle: buildSearchUrl({ station, checkin, checkout, nflt: nflt.socle }),
    premium: buildSearchUrl({ station, checkin, checkout, nflt: nflt.premium }),
  };
  emit("phase", { phase: "discovery", urls, attempt });

  let handle;
  try {
    handle = await client.startSession({
      agent: agentNameV2(station),
      messages: promptDiscovery({
        station, checkin, checkout, nflt,
        nSocle: policy.global.discovery.n_socle,
        maxCandidates: policy.global.discovery.max_candidates,
      }),
      maxSteps: 35,
      maxTimeS: 800,
      // idleTimeoutS par défaut : null clôturait la session au moindre passage idle (constaté aux probes)
      groupId,
      answerSchema: discoverySchema,
    });
  } catch (err) {
    if (attempt < 2 && !signal?.aborted) {
      emit("warning", { message: `découverte : échec de lancement (${err?.message ?? err}), nouvelle tentative` });
      return runDiscovery({ client, policy, station, checkin, checkout, groupId, emit, signal, attempt: attempt + 1 });
    }
    emit("warning", { message: `découverte abandonnée (${err?.message ?? err}) — repli sur l'inventaire et les hôtels de secours` });
    return { candidates: [], sessionId: null, status: "error", outcome: null, notes: String(err?.message ?? err) };
  }
  const usage = { steps: 0, costUsd: 0 };
  const scoped = (type, data) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      usage.costUsd = data.cost_usd ?? usage.costUsd;
    }
    return emit(type, data, { session_id: handle.id, hotel_key: "_discovery" });
  };
  scoped("agent_status", { status: "running" });

  const result = await pumpToCompletion(handle, scoped, { signal });
  let answer = result.answer;
  if (typeof answer === "string") {
    try { answer = JSON.parse(answer); } catch { answer = null; }
  }
  const candidates = toDiscoveryCandidates(answer);
  const failed = !answer || result.status === "failed" || result.outcome === "blocked" || !candidates.length;
  if (failed && attempt < 2 && !signal?.aborted) {
    emit("warning", { message: "découverte sans résultat exploitable, nouvelle tentative" });
    return runDiscovery({ client, policy, station, checkin, checkout, groupId, emit, signal, attempt: attempt + 1 });
  }
  for (const c of candidates) emit("candidate", c);
  emit("phase", { phase: "discovery", done: true, count: candidates.length, outcome: result.outcome ?? null, notes: answer?.notes ?? result.error ?? "" });
  return {
    candidates,
    currency: answer?.currency ?? "EUR",
    sessionId: handle.id,
    status: result.status,
    outcome: result.outcome ?? null,
    notes: answer?.notes ?? "",
    flat: answer, // réponse plate (discoverySchema) — archivée par --probe-discovery (phase 5)
    steps: usage.steps,
    costUsd: usage.costUsd,
  };
}
