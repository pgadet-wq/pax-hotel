/**
 * Générateur de liste passagers (CDC §5.5) — fonction pure, seedée, rejouable.
 * PRNG mulberry32 et compteur PNR LOCAUX à l'appel : deux appels identiques
 * produisent le même CSV.
 *
 * Deux modes de remplissage :
 *  - "legacy" : reproduit exactement l'algorithme du POC v1 (même séquence de tirages,
 *    léger dépassement de capacité possible) — garantit que seed 42 + A330 22/20/236
 *    redonne data/passagers-test.csv à l'octet près (non-régression) ;
 *  - "exact"  : avion plein à capacité exacte (un dossier qui déborde est remplacé par
 *    des solos) — mode utilisé par l'UI de démo (A350-900 plein, 324 passagers).
 */
import { PAX_COLS, toCsvBom } from "./csv.mjs";

const NOMS = [
  "MARTIN","BERNARD","DUBOIS","THOMAS","ROBERT","PETIT","DURAND","LEROY","MOREAU","SIMON",
  "LAURENT","LEFEBVRE","MICHEL","GARCIA","DAVID","BERTRAND","ROUX","VINCENT","FOURNIER","MOREL",
  "GIRARD","ANDRE","MERCIER","BLANC","GUERIN","BOYER","GARNIER","CHEVALIER","FRANCOIS","LEGRAND",
  "WAMYTAN","TJIBAOU","GOPE","POADJA","NAISSELINE","WASHETINE","KASARHEROU","POUYE","HNAWIA","WAHEO",
  "NGUYEN","TRAN","LE","PHAM","HOANG","CHANE","AH-SCHA","LOUEckHOTE".toUpperCase(),
];
const PRENOMS_A = [
  "Jean","Marie","Pierre","Sophie","Luc","Claire","Paul","Julie","Marc","Anne","Nicolas","Laure",
  "Thomas","Emma","Hugo","Camille","Louis","Lea","Antoine","Chloe","Waia","Dewe","Kaloi","Marama",
  "Teiva","Moana","Hina","Manu","Linh","Thi","Duc","Mai",
];
const PRENOMS_C = ["Lucas","Lina","Noah","Jade","Gabriel","Louise","Raphaël","Alice","Nathan","Rose","Timo","Maeva"];

export const DEFAULT_MIX = {
  J: { solo: 0.65, couple: 0.35, famille: 0 },
  W: { solo: 0.45, couple: 0.4, famille: 0.15 },
  Y: { solo: 0.38, couple: 0.32, famille: 0.3 },
};

/** Sièges du jeu de test v1 (A330-900 rempli à ~95 %) — défaut CLI inchangé. */
export const LEGACY_A330_SEATS = { J: 22, W: 20, Y: 236 };

/**
 * @param {object} opts
 * @param {{J:number,W:number,Y:number}} opts.seats sièges par cabine
 * @param {number} opts.seed graine PRNG (déterministe)
 * @param {object} opts.mix proportions solo/couple/famille par cabine
 * @param {number} opts.pmrCount passagers WCHR à marquer (dossiers distincts)
 * @param {"exact"|"legacy"} opts.fill mode de remplissage
 * @returns {{rows: object[], csv: string, stats: object}}
 */
export function generatePassengers({
  seats = { J: 34, W: 24, Y: 266 },
  seed = 42,
  mix = DEFAULT_MIX,
  pmrCount = 4,
  fill = "exact",
} = {}) {
  /* PRNG mulberry32 et compteur PNR — locaux à l'appel (rejouable) */
  let s = seed >>> 0;
  const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (Math.imul(s ^ (s >>> 15), 1 | s) >>> 16) / 65536 % 1);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;

  let pnrSeq = 0;
  const newPnr = () => {
    pnrSeq += 1;
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    let tag = "";
    for (let i = 0; i < 3; i += 1) tag += letters[Math.floor(rnd() * letters.length)];
    return `SB${String(pnrSeq).padStart(3, "0")}${tag}`;
  };

  const rows = [];
  const addPax = (pnr, cabine, type, age, fb, assistance, remarque) =>
    rows.push({
      pnr,
      nom: pick(NOMS),
      prenom: type === "CHD" || type === "INF" ? pick(PRENOMS_C) : pick(PRENOMS_A),
      type_pax: type,
      age,
      cabine,
      flying_blue: fb,
      assistance,
      remarque,
    });

  const fbAdult = (premium) => {
    const r = rnd();
    if (premium) return r < 0.25 ? "PLATINUM" : r < 0.55 ? "GOLD" : r < 0.8 ? "SILVER" : "NONE";
    return r < 0.02 ? "PLATINUM" : r < 0.07 ? "GOLD" : r < 0.2 ? "SILVER" : "NONE";
  };
  const adultAge = () => 20 + Math.floor(rnd() * 55);

  /** Un dossier (PNR) : solo, couple ou famille. Retourne le nombre de sièges consommés. */
  function makeBooking(cabine, kind) {
    const pnr = newPnr();
    const premium = cabine !== "Y";
    if (kind === "solo") {
      addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
      return 1;
    }
    if (kind === "couple") {
      addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
      addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
      return 2;
    }
    const adults = chance(0.8) ? 2 : 1;
    const children = 1 + Math.floor(rnd() * 3);
    const infant = chance(0.2) ? 1 : 0;
    for (let i = 0; i < adults; i += 1) addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
    for (let i = 0; i < children; i += 1) addPax(pnr, cabine, "CHD", 2 + Math.floor(rnd() * 10), "NONE", "", "");
    if (infant) addPax(pnr, cabine, "INF", chance(0.5) ? 0 : 1, "NONE", "", "bébé - berceau");
    return adults + children + infant;
  }

  function fillCabinLegacy(cabine, seatCount, m) {
    let used = 0;
    while (used < seatCount - 4) {
      const r = rnd();
      const kind = r < m.solo ? "solo" : r < m.solo + m.couple ? "couple" : "famille";
      used += makeBooking(cabine, kind);
    }
    while (used < seatCount) used += makeBooking(cabine, "solo");
  }

  function fillCabinExact(cabine, seatCount, m) {
    let used = 0;
    while (used < seatCount) {
      const remaining = seatCount - used;
      let kind;
      if (remaining === 1) kind = "solo";
      else {
        const r = rnd();
        kind = r < m.solo ? "solo" : r < m.solo + m.couple ? "couple" : "famille";
        if (kind === "famille" && remaining < 3) kind = remaining >= 2 ? "couple" : "solo";
      }
      // un dossier qui déborderait la cabine est retiré et remplacé par des solos
      const before = rows.length;
      const taken = makeBooking(cabine, kind);
      if (used + taken > seatCount) {
        rows.length = before;
        while (used < seatCount) used += makeBooking(cabine, "solo");
        break;
      }
      used += taken;
    }
  }

  const fillCabin = fill === "legacy" ? fillCabinLegacy : fillCabinExact;
  for (const cab of ["J", "W", "Y"]) {
    if (seats[cab] > 0) fillCabin(cab, seats[cab], mix[cab] ?? DEFAULT_MIX[cab]);
  }

  /* PMR : adultes marqués WCHR sur des dossiers distincts */
  const adults = rows.filter((r) => r.type_pax === "ADT");
  const marked = new Set();
  let guard = 0;
  while (marked.size < Math.min(pmrCount, adults.length) && guard < 10_000) {
    guard += 1;
    const r = pick(adults);
    if (marked.has(r.pnr)) continue;
    marked.add(r.pnr);
    r.assistance = "WCHR";
    r.remarque = [r.remarque, "fauteuil roulant - chambre accessible requise"].filter(Boolean).join(" ; ");
  }

  const count = (fn) => rows.filter(fn).length;
  const stats = {
    passagers: rows.length,
    dossiers: new Set(rows.map((r) => r.pnr)).size,
    parCabine: { J: count((r) => r.cabine === "J"), W: count((r) => r.cabine === "W"), Y: count((r) => r.cabine === "Y") },
    parType: { ADT: count((r) => r.type_pax === "ADT"), CHD: count((r) => r.type_pax === "CHD"), INF: count((r) => r.type_pax === "INF") },
    pmr: count((r) => r.assistance === "WCHR"),
    seed,
    fill,
  };
  return { rows, csv: toCsvBom(PAX_COLS, rows), stats };
}
