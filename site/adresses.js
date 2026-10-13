// Géocodage dans le navigateur, sans service en ligne : index des adresses de la Métropole
// (data/adresses.bin, fabriqué par tools/adresses_site.py à partir de la Base Adresse Nationale).
// Même méthode que le géocodeur de r5_isochrones.py : voie exacte ou approchée (ressemblance ≥ 0,8)
// dans le code postal ou la commune, puis numéro exact, sans indice de répétition, ou le plus proche.

const ABBREVIATIONS = {
  av: "avenue", ave: "avenue", bd: "boulevard", bld: "boulevard", blvd: "boulevard", r: "rue",
  pl: "place", pce: "place", imp: "impasse", all: "allee", ch: "chemin", che: "chemin", rte: "route",
  crs: "cours", qu: "quai", sq: "square", res: "residence", st: "saint", ste: "sainte", fbg: "faubourg",
};
const REPETITIONS = { bis: "b", ter: "t", quater: "q", b: "b", t: "t", q: "q", a: "a", c: "c" };

export function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => ABBREVIATIONS[word] ?? word)
    .join(" ");
}

/** Ressemblance de Ratcliff et Obershelp (celle de difflib en Python) : 2 × caractères communs / longueur totale. */
function similarity(a, b) {
  const matches = (s, t) => {
    if (!s.length || !t.length) return 0;
    let best = 0;
    let bi = 0;
    let bj = 0;
    const previous = new Uint16Array(t.length + 1);
    const current = new Uint16Array(t.length + 1);
    for (let i = 1; i <= s.length; i += 1) {
      for (let j = 1; j <= t.length; j += 1) {
        current[j] = s[i - 1] === t[j - 1] ? previous[j - 1] + 1 : 0;
        if (current[j] > best) {
          best = current[j];
          bi = i - best;
          bj = j - best;
        }
      }
      previous.set(current);
    }
    if (!best) return 0;
    return best + matches(s.slice(0, bi), t.slice(0, bj)) + matches(s.slice(bi + best), t.slice(bj + best));
  };
  return a.length + b.length ? (2 * matches(a, b)) / (a.length + b.length) : 1;
}

export async function loadAddresses(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`adresses.bin : ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("deflate"));
  const raw = JSON.parse(await new Response(stream).text());
  const [x0, y0] = raw.origine;
  const communes = raw.communes.map((name) => ({ name, key: normalize(name) }));
  const voies = raw.voies.map(([name, postcode, commune, numbers, dx, dy]) => {
    const keys = numbers.split("|");
    const points = new Map(keys.map((key, i) => [key, [x0 + dx[i], y0 + dy[i]]]));
    return { name, key: normalize(name), postcode, commune, points };
  });
  const byPostcode = new Map();
  const byCommune = new Map();
  voies.forEach((voie, index) => {
    if (!byPostcode.has(voie.postcode)) byPostcode.set(voie.postcode, []);
    byPostcode.get(voie.postcode).push(index);
    const commune = communes[voie.commune].key;
    if (!byCommune.has(commune)) byCommune.set(commune, []);
    byCommune.get(commune).push(index);
  });
  const communesByLength = [...byCommune.keys()].sort((a, b) => b.length - a.length);

  /** { point: [x, y], qualite, trouve } ; point null si l'adresse n'est pas trouvée. */
  function geocode(address) {
    const missing = { point: null, qualite: "non trouvée", trouve: "" };
    const text = normalize(address);
    const match = text.match(/^(\d+)\s*(bis|ter|quater|b|t|q|a|c)?\b\s*(.*)$/);
    const [number, repetition, rest] = match ? [match[1], REPETITIONS[match[2] ?? ""] ?? "", match[3]] : ["", "", text];
    let candidates;
    let streetText;
    const postcode = rest.match(/\b(\d{5})\b/);
    if (postcode) {
      streetText = rest.slice(0, postcode.index).trim();
      candidates = byPostcode.get(postcode[1]) ?? [];
      // Un code postal couvre parfois plusieurs communes, avec des voies de même nom : la commune tranche.
      const town = rest.slice(postcode.index + 5).trim();
      const inTown = candidates.filter((i) => communes[voies[i].commune].key === town);
      if (inTown.length) candidates = inTown;
    } else {
      // Sans code postal : la commune est à la fin, les noms les plus longs d'abord.
      const town = communesByLength.find((name) => rest.endsWith(` ${name}`));
      if (!town) return missing;
      streetText = rest.slice(0, -town.length).trim();
      candidates = byCommune.get(town);
    }
    if (!candidates.length) return missing;
    let voie = candidates.map((i) => voies[i]).find((v) => v.key === streetText);
    let quality = "voie exacte";
    if (!voie) {
      let best = 0.8;
      for (const i of candidates) {
        const score = similarity(streetText, voies[i].key);
        if (score >= best) {
          best = score;
          voie = voies[i];
        }
      }
      if (!voie) return missing;
      quality = "voie approchée";
    }
    let point = voie.points.get(number + repetition);
    if (point) {
      quality += ", numéro exact";
    } else if ((point = voie.points.get(number))) {
      quality += ", numéro sans indice de répétition";
    } else {
      // Numéro absent : le plus proche sur la même voie, ou le premier si l'adresse n'a pas de numéro.
      let nearest = null;
      if (number) {
        let gap = Infinity;
        for (const key of voie.points.keys()) {
          const value = parseInt(key, 10);
          if (Number.isFinite(value) && Math.abs(value - Number(number)) < gap) {
            gap = Math.abs(value - Number(number));
            nearest = key;
          }
        }
      }
      point = voie.points.get(nearest ?? voie.points.keys().next().value);
      quality += nearest ? `, numéro le plus proche (${nearest})` : ", voie sans numéro";
    }
    return { point, qualite: quality, trouve: `${voie.key} ${voie.postcode}` };
  }

  /** Suggestions pour la recherche : « 12 rue de la Loge », « rue de la Loge Montpellier »… */
  function search(query, limit = 6) {
    const text = normalize(query);
    if (text.length < 3) return [];
    const match = text.match(/^(\d+)\s*(bis|ter|quater|b|t|q|a|c)?\b\s*(.*)$/);
    const number = match ? match[1] + (REPETITIONS[match[2] ?? ""] ?? "") : "";
    const words = (match ? match[3] : text).split(" ").filter(Boolean);
    if (!words.length) return [];
    const results = [];
    for (const voie of voies) {
      const haystack = `${voie.key} ${voie.postcode} ${communes[voie.commune].key}`;
      if (!words.every((word) => haystack.includes(word))) continue;
      const point = (number && (voie.points.get(number) ?? voie.points.get(match[1]))) || voie.points.values().next().value;
      const exact = number && voie.points.has(number);
      results.push({
        label: `${exact ? `${number.replace(/b$/, " bis").replace(/t$/, " ter")} ` : ""}${voie.name}`,
        context: `${voie.postcode} ${communes[voie.commune].name}`,
        point,
        score: (voie.key.startsWith(words[0]) ? 0 : 1) + voie.key.length / 100,
      });
    }
    return results.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  return { geocode, search, count: voies.length };
}
