// Temps porte à porte en marche + transports en commun, dans le navigateur, avec la méthode de r5py (R5) :
// - marche par les rues (réseau de routes.bin) jusqu'aux arrêts, entre arrêts pour les correspondances
//   (1 000 m au plus) et depuis le dernier arrêt (2 000 m au plus), à 4,5 km/h ;
// - horaires TaM d'un jour ordinaire (horaires.bin), au moins 60 s entre l'arrivée à un arrêt et le départ
//   du véhicule, 8 véhicules au plus ;
// - un départ par minute de 7 h à 20 h (calcul « par plage », RAPTOR) : le temps retenu est la médiane ;
// - la marche seule compte aussi quand elle est plus rapide ; au-delà de 90 min, le lieu est inaccessible.
// Comparé à r5py sur 2 500 trajets tirés au hasard (départs en ville, arrivées dans toute la Métropole) :
// écart moyen de 1,4 min en valeur absolue, 90 % des écarts sous 3 min, à peine plus lent (+0,4 min).

const BOARD_SLACK = 60; // secondes, MINIMUM_BOARD_WAIT_SEC de R5
const TRANSFER_METERS = 1000; // TRANSFER_DISTANCE_LIMIT_METERS de R5
const EGRESS_METERS = 2000; // WALK_DISTANCE_LIMIT_METERS de R5
const MAX_RIDES = 8; // max_public_transport_rides de r5py
const UNREACHED = 65535; // dans les tableaux de secondes sur 16 bits

export const TRANSIT_SETTINGS = {
  from: 7 * 3600,
  to: 20 * 3600,
  maxSeconds: 90 * 60,
};

export async function loadTransit(url, walk) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`horaires.bin : ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("deflate"));
  const raw = JSON.parse(await new Response(stream).text());
  const nStops = raw.arrets.length;

  // Arrêts rattachés aux rues.
  const stopNode = new Int32Array(nStops).fill(-1);
  const stopLink = new Float32Array(nStops);
  const stopsAtNode = new Map();
  raw.arrets.forEach((point, s) => {
    const found = walk.snap(point);
    if (!found) return;
    stopNode[s] = found.node;
    stopLink[s] = found.meters / walk.speed;
    if (!stopsAtNode.has(found.node)) stopsAtNode.set(found.node, []);
    stopsAtNode.get(found.node).push(s);
  });

  // Missions : arrêts, montée / descente possibles, horaires (arrivée, départ) de chaque course.
  const missions = raw.missions.map(([route, stops, pickup, dropoff, courses]) => {
    const n = stops.length;
    const times = new Int32Array(courses.length * n * 2);
    courses.forEach((course, t) => times.set(course, t * n * 2));
    return { route, stops: Int32Array.from(stops), pickup: Uint8Array.from(pickup), dropoff: Uint8Array.from(dropoff), times, trips: courses.length, n };
  });
  const missionsAtStop = Array.from({ length: nStops }, () => []);
  missions.forEach((mission, m) => mission.stops.forEach((stop, pos) => missionsAtStop[stop].push([m, pos])));

  // Correspondances à pied entre arrêts proches.
  const transfers = Array.from({ length: nStops }, () => []);
  const transferLimit = TRANSFER_METERS / walk.speed;
  for (let s = 0; s < nStops; s += 1) {
    if (stopNode[s] < 0) continue;
    walk.from(stopNode[s], stopLink[s], transferLimit, (node, seconds) => {
      for (const other of stopsAtNode.get(node) ?? []) {
        if (other !== s && seconds + stopLink[other] <= transferLimit) transfers[s].push([other, seconds + stopLink[other]]);
      }
    });
  }

  /**
   * Prépare des destinations (points [x, y]) : rattachement aux rues, puis, pour chaque arrêt, les destinations à
   * moins de 2 000 m à pied et le temps de marche. Quelques secondes pour quelques milliers de destinations.
   */
  function prepareTargets(points) {
    const node = new Int32Array(points.length).fill(-1);
    const link = new Float32Array(points.length);
    const targetsAtNode = new Map();
    points.forEach((point, i) => {
      const found = walk.snap(point);
      if (!found) return;
      node[i] = found.node;
      link[i] = found.meters / walk.speed;
      if (!targetsAtNode.has(found.node)) targetsAtNode.set(found.node, []);
      targetsAtNode.get(found.node).push(i);
    });
    const egressLimit = EGRESS_METERS / walk.speed;
    const offsets = new Int32Array(nStops + 1);
    const lists = [];
    for (let s = 0; s < nStops; s += 1) {
      const list = [];
      if (stopNode[s] >= 0) {
        walk.from(stopNode[s], stopLink[s], egressLimit, (n, seconds) => {
          for (const target of targetsAtNode.get(n) ?? []) list.push(target, seconds + link[target]);
        });
      }
      lists.push(list);
      offsets[s + 1] = offsets[s] + list.length / 2;
    }
    const egressTarget = new Int32Array(offsets[nStops]);
    const egressSeconds = new Float32Array(offsets[nStops]);
    lists.forEach((list, s) => {
      for (let k = 0; k < list.length; k += 2) {
        egressTarget[offsets[s] + k / 2] = list[k];
        egressSeconds[offsets[s] + k / 2] = list[k + 1];
      }
    });
    return { count: points.length, node, link, targetsAtNode, offsets, egressTarget, egressSeconds };
  }

  /** Premier indice de course dont le départ à la position `pos` est ≥ `time` (courses triées), ou -1. */
  function firstTrip(mission, pos, time) {
    const { times, trips, n } = mission;
    let lo = 0;
    let hi = trips;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[(mid * n + pos) * 2 + 1] >= time) hi = mid;
      else lo = mid + 1;
    }
    return lo < trips ? lo : -1;
  }

  /**
   * Minutes médianes (Float32Array, NaN : inaccessible) d'un point de départ vers les destinations préparées,
   * pour des départs chaque minute de `from` à `to` (exclu).
   */
  function solve(origin, targets, settings = TRANSIT_SETTINGS) {
    const { from, to, maxSeconds } = settings;
    const nTargets = targets.count;
    const result = new Float32Array(nTargets).fill(NaN);
    const start = walk.snap(origin);
    if (!start) return result;

    // Marche depuis le départ : vers les arrêts (accès) et directement vers les destinations.
    const access = new Float64Array(nStops).fill(Infinity);
    const direct = new Float64Array(nTargets).fill(Infinity);
    walk.from(start.node, start.meters / walk.speed, maxSeconds, (node, seconds) => {
      for (const s of stopsAtNode.get(node) ?? []) access[s] = Math.min(access[s], seconds + stopLink[s]);
      for (const t of targets.targetsAtNode.get(node) ?? []) direct[t] = Math.min(direct[t], seconds + targets.link[t]);
    });
    const accessStops = [];
    for (let s = 0; s < nStops; s += 1) if (access[s] <= maxSeconds) accessStops.push(s);

    const minutes = Math.round((to - from) / 60);
    const samples = new Uint16Array(nTargets * minutes).fill(UNREACHED);
    // Meilleures heures d'arrivée par tour (après correspondance à pied) et, tous tours confondus, en descendant
    // d'un véhicule ; gardées d'un départ au suivant (on remonte le temps : elles ne peuvent que s'améliorer).
    const best = Array.from({ length: MAX_RIDES + 1 }, () => new Float64Array(nStops).fill(Infinity));
    const rideBest = Array.from({ length: MAX_RIDES + 1 }, () => new Float64Array(nStops).fill(Infinity));
    const alighted = new Float64Array(nStops).fill(Infinity);
    const arrival = new Float64Array(nTargets).fill(Infinity);
    let marked = new Uint8Array(nStops);
    let nextMarked = new Uint8Array(nStops);
    const missionStart = new Int32Array(missions.length);
    const improved = [];

    for (let i = minutes - 1; i >= 0; i -= 1) {
      const departure = from + i * 60;
      const limit = departure + maxSeconds;
      marked.fill(0);
      for (const s of accessStops) {
        const time = departure + access[s];
        if (time < best[0][s]) {
          best[0][s] = time;
          marked[s] = 1;
        }
      }
      improved.length = 0;
      for (let k = 1; k <= MAX_RIDES; k += 1) {
        const previous = best[k - 1];
        const current = best[k];
        const rides = rideBest[k];
        // Missions passant par un arrêt amélioré au tour précédent, à partir du premier de ces arrêts.
        missionStart.fill(-1);
        let any = false;
        for (let s = 0; s < nStops; s += 1) {
          if (!marked[s]) continue;
          for (const [m, pos] of missionsAtStop[s]) {
            if (missionStart[m] < 0 || pos < missionStart[m]) missionStart[m] = pos;
            any = true;
          }
        }
        if (!any) {
          // Plus rien à améliorer : les tours restants reprennent quand même les meilleurs temps des précédents,
          // dont partira le départ suivant.
          for (let j = k; j <= MAX_RIDES; j += 1) {
            for (let s = 0; s < nStops; s += 1) if (best[j - 1][s] < best[j][s]) best[j][s] = best[j - 1][s];
          }
          break;
        }
        nextMarked.fill(0);
        for (let m = 0; m < missions.length; m += 1) {
          const begin = missionStart[m];
          if (begin < 0) continue;
          const mission = missions[m];
          const { stops, pickup, dropoff, times, n } = mission;
          let trip = -1;
          for (let pos = begin; pos < n; pos += 1) {
            const s = stops[pos];
            if (trip >= 0 && dropoff[pos]) {
              const time = times[(trip * n + pos) * 2];
              if (time < rides[s] && time < current[s] && time <= limit) {
                rides[s] = time;
                current[s] = time;
                nextMarked[s] = 1;
                if (time < alighted[s]) {
                  alighted[s] = time;
                  improved.push(s);
                }
              }
            }
            if (pickup[pos] && previous[s] < Infinity) {
              const ready = previous[s] + BOARD_SLACK;
              if (trip < 0 || times[(trip * n + pos) * 2 + 1] >= ready) {
                // Une course plus matinale est peut-être encore attrapable.
                const earliest = firstTrip(mission, pos, ready);
                if (earliest >= 0 && (trip < 0 || earliest < trip)) trip = earliest;
              }
            }
          }
        }
        // Correspondances à pied depuis les arrêts où l'on vient de descendre.
        for (let s = 0; s < nStops; s += 1) {
          if (!nextMarked[s]) continue;
          for (const [other, seconds] of transfers[s]) {
            const time = rides[s] + seconds;
            if (time < current[other] && time <= limit) {
              current[other] = time;
              nextMarked[other] = 1;
            }
          }
        }
        // Le tour suivant part des meilleurs temps, ce tour ou les précédents.
        for (let s = 0; s < nStops; s += 1) if (previous[s] < current[s]) current[s] = previous[s];
        [marked, nextMarked] = [nextMarked, marked];
      }
      // Marche depuis les arrêts de descente améliorés vers les destinations.
      for (const s of improved) {
        const base = alighted[s];
        for (let e = targets.offsets[s]; e < targets.offsets[s + 1]; e += 1) {
          const t = targets.egressTarget[e];
          const time = base + targets.egressSeconds[e];
          if (time < arrival[t]) arrival[t] = time;
        }
      }
      for (let t = 0; t < nTargets; t += 1) {
        const total = Math.min(arrival[t] - departure, direct[t]);
        if (total <= maxSeconds) samples[t * minutes + i] = Math.round(total);
      }
    }

    // Médiane (comme r5py, percentile 50) : la valeur de rang ⌈n/2⌉ ; inaccessible si plus de la moitié l'est.
    const rank = Math.ceil(minutes / 2) - 1;
    for (let t = 0; t < nTargets; t += 1) {
      const sorted = samples.subarray(t * minutes, (t + 1) * minutes).slice().sort();
      if (sorted[rank] !== UNREACHED) result[t] = Math.floor(sorted[rank] / 60); // minutes entières, comme r5py
    }
    return result;
  }

  return { prepareTargets, solve, stopCount: nStops, missionCount: missions.length };
}
