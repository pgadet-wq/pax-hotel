/**
 * Pré-vol des URL de l'inventaire — contrôle HTTP GRATUIT, sans agent (donc hors
 * INV-8), joué avant les relevés payants.
 *
 * Le run réel du 16/09 a perdu 3 fiches sur 12 (404, redirection vers un AUTRE
 * hôtel) : chaque fiche morte a coûté une session d'agent, une substitution en
 * cascade, et in fine des escalades. Une requête HTTP de 2 secondes les détecte.
 *
 * Prudence volontaire : Booking répond souvent 403 ou 429 à une IP de centre de
 * données. Un tel statut ne conclut JAMAIS à une fiche morte — verdict
 * « indéterminée », la fiche reste candidate. Seuls 404/410 et une redirection
 * vers un autre établissement sont des verdicts fermes.
 */

/** Slug d'une fiche Booking : `/hotel/<cc>/<slug>.html`. */
export function hotelSlug(url) {
  const m = /\/hotel\/[a-z]{2}\/([^/?#]+?)(?:\.[a-z]{2,5})?\.html/i.exec(String(url ?? ""));
  return m ? m[1].toLowerCase() : null;
}

const VERDICTS = ["vivante", "morte", "redirigee", "indeterminee"];

/**
 * @param {Array<{id?: string, name?: string, url: string}>} candidats
 * @param {object} [opts] timeoutMs, concurrency, fetchImpl (injectable pour les tests)
 * @returns {Promise<Array<{id, name, url, status, finalUrl, verdict, detail}>>}
 */
export async function preflightUrls(candidats, opts = {}) {
  const { timeoutMs = 8000, concurrency = 6, fetchImpl = globalThis.fetch } = opts;
  const items = candidats.filter((c) => c?.url);
  const out = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await checkOne(items[i], { timeoutMs, fetchImpl });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out.filter(Boolean);
}

async function checkOne(candidat, { timeoutMs, fetchImpl }) {
  const base = { id: candidat.id ?? null, name: candidat.name ?? "", url: candidat.url };
  const attendu = hotelSlug(candidat.url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(candidat.url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pax-hotel-preflight/1.0)", "Accept-Language": "fr,en;q=0.8" },
    });
    const finalUrl = res.url || candidat.url;
    const rendu = hotelSlug(finalUrl);
    if (res.status === 404 || res.status === 410) {
      return { ...base, status: res.status, finalUrl, verdict: "morte", detail: `page absente (HTTP ${res.status})` };
    }
    if (res.status === 200) {
      if (attendu && rendu && rendu !== attendu) {
        return { ...base, status: res.status, finalUrl, verdict: "redirigee", detail: `redirigée vers « ${rendu} » (attendu « ${attendu} »)` };
      }
      // une page d'hôtel fait des centaines de kilo-octets : une réponse 200 minuscule
      // est une page d'attente, un mur anti-robot ou un proxy — pas une fiche
      const corps = await res.text().catch(() => "");
      if (corps.length < 20000) {
        return { ...base, status: res.status, finalUrl, verdict: "indeterminee", detail: `réponse de ${corps.length} octets, trop courte pour une fiche — non concluant` };
      }
      return { ...base, status: res.status, finalUrl, verdict: "vivante", detail: "" };
    }
    if (res.status > 200 && res.status < 400) {
      // 202/204/3xx non suivis : ce n'est pas une fiche servie, on ne conclut pas
      return { ...base, status: res.status, finalUrl, verdict: "indeterminee", detail: `HTTP ${res.status} — réponse intermédiaire, non concluant` };
    }
    return { ...base, status: res.status, finalUrl, verdict: "indeterminee", detail: `HTTP ${res.status} — anti-robot probable, fiche conservée` };
  } catch (err) {
    const raison = err?.name === "AbortError" ? `pas de réponse en ${Math.round(timeoutMs / 1000)} s` : String(err?.message ?? err);
    return { ...base, status: null, finalUrl: candidat.url, verdict: "indeterminee", detail: `${raison} — fiche conservée` };
  } finally {
    clearTimeout(timer);
  }
}

/** Résumé exploitable : quoi écarter, quoi signaler. */
export function resumePreflight(resultats) {
  const par = Object.fromEntries(VERDICTS.map((v) => [v, resultats.filter((r) => r.verdict === v)]));
  return {
    total: resultats.length,
    vivantes: par.vivante.length,
    mortes: par.morte,
    redirigees: par.redirigee,
    indeterminees: par.indeterminee.length,
    aEcarter: new Set(par.morte.map((r) => r.id ?? r.url)),
  };
}
