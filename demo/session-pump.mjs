/**
 * Pompe d'événements d'une session H vers un émetteur §5.8 (côté démo).
 *
 * Séquence imposée par l'API (même curseur côté plateforme) : d'abord le flux
 * `for await (ev of handle.stream({until: "settled"}))` traduit et émis, PUIS
 * `waitForCompletion` — jamais les deux en parallèle. Le handle est fourni par
 * l'appelant (câblage réel en phase 5) : ce module n'importe pas le SDK
 * (INV-7), seulement la traduction pure de `lib/events.mjs`.
 */
import { translateSessionEvent } from "../hai-admin-mcp/lib/events.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out", "expired", "terminated"]);

/**
 * @param {object} handle SessionHandle du SDK (stream, waitForCompletion, cancel, id)
 * @param {(type: string, data: object) => void} emit émetteur §5.8 (déjà scopé run/hôtel)
 * @param {object} [opts] {timeoutMs, signal}
 * @returns {Promise<{id, status, answer, outcome, error}>} résultat final ; une réponse
 *   absente ou non conforme au schéma est un échec de RÉPONSE (answer null), pas une exception.
 *
 * Annulation RÉELLE (phase 5) : l'abandon du signal appelle `handle.cancel()` — la
 * session s'arrête côté plateforme, `waitForCompletion` rend son statut terminal.
 */
export async function pumpSession(handle, emit, { timeoutMs = 40 * 60 * 1000, signal } = {}) {
  const onAbort = () => {
    Promise.resolve(handle.cancel?.()).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      for await (const ev of handle.stream({ until: "settled", timeoutMs })) {
        if (signal?.aborted) break;
        for (const e of translateSessionEvent(ev)) emit(e.type, e.data);
      }
    } catch (err) {
      // le flux est un confort d'affichage : une coupure ne condamne pas la session (§6.6)
      emit("warning", { message: `flux d'événements interrompu (${err?.message ?? err}) — attente du résultat` });
    }

    try {
      const result = await handle.waitForCompletion({ timeoutMs });
      // session encore ouverte après réponse : fermée pour libérer le slot de concurrence
      if (!TERMINAL.has(result?.status)) {
        Promise.resolve(handle.cancel?.()).catch(() => {});
      }
      return result;
    } catch (err) {
      // détection par nom : le SDK (AnswerValidationError) ne s'importe pas sous demo/ (INV-7)
      if (err?.name === "AnswerValidationError") {
        emit("warning", { message: "réponse finale absente ou non conforme au schéma" });
        return { id: handle.id, status: "completed", answer: null, outcome: null, error: "réponse non conforme au schéma" };
      }
      throw err;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
