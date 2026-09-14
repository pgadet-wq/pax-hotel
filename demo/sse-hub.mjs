/**
 * Bus SSE du serveur de démo (CDC §9) : tampon circulaire de 1000 événements,
 * `id:` monotone, reprise par `Last-Event-ID` quand l'événement demandé est
 * encore dans le tampon, sinon `snapshot` complet re-rendable, ping toutes
 * les 15 s. Aucune dépendance : le hub écrit directement sur les réponses
 * `node:http` abonnées.
 */

const DEFAULT_BUFFER = 1000;
const DEFAULT_PING_MS = 15_000;

/** Sérialise un événement au format SSE (data JSON sur une seule ligne). */
export function formatSse(id, type, data) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.bufferSize] taille du tampon circulaire (défaut 1000)
 * @param {number} [opts.pingMs] période du ping (défaut 15 s ; 0 = désactivé, tests)
 */
export function createHub({ bufferSize = DEFAULT_BUFFER, pingMs = DEFAULT_PING_MS } = {}) {
  let lastId = 0;
  const buffer = []; // [{id, type, data}] — éviction FIFO au-delà de bufferSize
  const clients = new Set(); // réponses http ouvertes

  const pingTimer = pingMs > 0
    ? setInterval(() => {
        for (const res of clients) res.write(": ping\n\n");
      }, pingMs)
    : null;
  if (pingTimer) pingTimer.unref();

  /** Publie un événement à tous les abonnés et l'archive dans le tampon. */
  function publish(type, data) {
    lastId += 1;
    const entry = { id: lastId, type, data };
    buffer.push(entry);
    if (buffer.length > bufferSize) buffer.shift();
    const payload = formatSse(entry.id, type, data);
    for (const res of clients) res.write(payload);
    return entry.id;
  }

  /**
   * Attache une réponse HTTP au flux : reprise `Last-Event-ID` si possible,
   * sinon `snapshot` complet (fourni par l'appelant), puis événements en direct.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {() => object} snapshot état complet re-rendable (manager.snapshot())
   */
  function handle(req, res, snapshot) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connecté\n\n");

    const sinceRaw = req.headers["last-event-id"];
    const since = sinceRaw !== undefined && /^\d+$/.test(String(sinceRaw)) ? Number(sinceRaw) : null;
    const oldest = buffer.length ? buffer[0].id : lastId + 1;
    // reprise possible : l'id demandé est ≤ dernier connu et le suivant est encore dans le tampon
    if (since !== null && since <= lastId && since + 1 >= oldest) {
      for (const entry of buffer) {
        if (entry.id > since) res.write(formatSse(entry.id, entry.type, entry.data));
      }
    } else {
      res.write(formatSse(lastId, "snapshot", snapshot()));
    }

    clients.add(res);
    const detach = () => {
      clients.delete(res);
    };
    req.on("close", detach);
    res.on("close", detach);
  }

  /** Ferme le hub : plus de ping, connexions terminées. */
  function close() {
    if (pingTimer) clearInterval(pingTimer);
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* déjà fermée */
      }
    }
    clients.clear();
  }

  return {
    publish,
    handle,
    close,
    get lastId() {
      return lastId;
    },
    get clientCount() {
      return clients.size;
    },
    get bufferedIds() {
      return buffer.map((e) => e.id);
    },
  };
}
