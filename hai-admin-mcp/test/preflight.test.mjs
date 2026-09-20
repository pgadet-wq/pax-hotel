/**
 * Pré-vol des fiches (contrôle HTTP gratuit, aucun agent) : verdicts fermes
 * uniquement sur 404/410 et redirection vers un AUTRE établissement ; tout le
 * reste reste « indéterminé » et la fiche est conservée (Booking répond souvent
 * 403 ou 429 à une IP de centre de données — conclure « morte » supprimerait des
 * hôtels vivants le jour du déroutement).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightUrls, resumePreflight, hotelSlug } from "../lib/preflight.mjs";

const URL_HYATT = "https://www.booking.com/hotel/th/hyatt-regency-bangkok-suvarnabhumi-airport.html";
const URL_NOVOTEL = "https://www.booking.com/hotel/th/novotel-bangkok-suvarnabhumi-airport.html";
const page = (n = 40000) => "x".repeat(n);

/** fetch simulé : réponse par URL, jamais de réseau. */
const stub = (parUrl) => async (url) => {
  const r = parUrl[url];
  if (r instanceof Error) throw r;
  return {
    status: r.status,
    url: r.finalUrl ?? url,
    text: async () => r.body ?? page(),
  };
};

test("preflight : 404 → morte ; redirection vers un autre hôtel → redirigée", async () => {
  const res = await preflightUrls(
    [{ id: "divalux", name: "Divalux", url: "https://www.booking.com/hotel/th/divalux-resort-spa.html" },
     { id: "novotel", name: "Novotel", url: URL_NOVOTEL }],
    {
      fetchImpl: stub({
        "https://www.booking.com/hotel/th/divalux-resort-spa.html": { status: 404 },
        [URL_NOVOTEL]: { status: 200, finalUrl: URL_HYATT },
      }),
    },
  );
  assert.equal(res.find((r) => r.id === "divalux").verdict, "morte");
  const redir = res.find((r) => r.id === "novotel");
  assert.equal(redir.verdict, "redirigee");
  assert.match(redir.detail, /hyatt/);
  const bilan = resumePreflight(res);
  assert.equal(bilan.mortes.length, 1);
  assert.equal(bilan.redirigees.length, 1);
  assert.ok(bilan.aEcarter.has("divalux"));
});

test("preflight : jamais de verdict ferme sur 403, 429, 202 ou absence de réponse", async () => {
  const cas = [
    { code: 403, url: `${URL_HYATT}?a` },
    { code: 429, url: `${URL_HYATT}?b` },
    { code: 202, url: `${URL_HYATT}?c` },
    { code: 500, url: `${URL_HYATT}?d` },
  ];
  const parUrl = Object.fromEntries(cas.map((c) => [c.url, { status: c.code }]));
  const res = await preflightUrls(cas.map((c, i) => ({ id: `h${i}`, name: "H", url: c.url })), { fetchImpl: stub(parUrl) });
  assert.ok(res.every((r) => r.verdict === "indeterminee"), "aucune fiche écartée sur un blocage anti-robot");

  const boom = Object.assign(new Error("socket hang up"), { name: "TypeError" });
  const ko = await preflightUrls([{ id: "z", name: "Z", url: URL_HYATT }], { fetchImpl: stub({ [URL_HYATT]: boom }) });
  assert.equal(ko[0].verdict, "indeterminee");
  assert.match(ko[0].detail, /conservée/);
});

test("preflight : une réponse 200 trop courte n'est pas une fiche (mur anti-robot, proxy)", async () => {
  const res = await preflightUrls([{ id: "h", name: "H", url: URL_HYATT }], {
    fetchImpl: stub({ [URL_HYATT]: { status: 200, body: "<html>captcha</html>" } }),
  });
  assert.equal(res[0].verdict, "indeterminee");
  const vivante = await preflightUrls([{ id: "h", name: "H", url: URL_HYATT }], {
    fetchImpl: stub({ [URL_HYATT]: { status: 200, body: page(50000) } }),
  });
  assert.equal(vivante[0].verdict, "vivante");
});

test("preflight : slug d'une fiche Booking", () => {
  assert.equal(hotelSlug(URL_HYATT), "hyatt-regency-bangkok-suvarnabhumi-airport");
  assert.equal(hotelSlug("https://www.booking.com/hotel/th/le-meridien.fr.html?x=1"), "le-meridien");
  assert.equal(hotelSlug("https://example.test/rien"), null);
});
