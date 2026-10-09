// Calcul simplifié en voiture et à vélo, dans le navigateur, sur le réseau de rues de data/routes.bin
// (fabriqué par tools/reseau_routier.py à partir d'OpenStreetMap, avec les règles de R5).
//
// Un plus court chemin (Dijkstra) part du nœud de rue le plus proche du départ et donne le temps vers
// chaque intersection ; chaque case de la carte prend le temps de son nœud le plus proche. Les réglages
// sont ceux de r5_isochrones.py, et deux corrections rapprochent les temps de ceux de r5py :
// - voiture : 1,5 s par intersection traversée, pour les virages que R5 fait payer ;
// - vélo : temps × 1,03, pour les arrondis de R5 à la seconde par tronçon.
// Sur 6 000 trajets tirés au hasard dans la Métropole, l'écart moyen avec r5py est d'environ 2 min
// (voiture et vélo, trajets de moins de 30 min), sans biais notable.

export const ROAD_MODES = {
  voiture: {
    label: "Voiture",
    extremites: 5, // minutes : rejoindre sa voiture, se garer, marcher (comme --voiture-extremites)
    junctionSeconds: 1.5,
    accessMetersPerSecond: 4.5 / 3.6, // depuis l'adresse jusqu'à la rue : à pied
    describe: "circulation fluide, vitesses d'OpenStreetMap, + 5 min pour rejoindre sa voiture, se garer et marcher",
  },
  velo: {
    label: "Vélo",
    extremites: 3, // minutes : sortir et garer son vélo, marcher (comme --velo-extremites)
    cyclingKmh: 12,
    walkingKmh: 4.5,
    factor: 1.03,
    describe: "12 km/h, vélo poussé à pied sur les axes les plus stressants, + 3 min pour sortir et garer son vélo",
  },
};

const BUCKET = 250; // mètres : maille de la recherche du nœud le plus proche
const MAX_SNAP = 2000; // mètres : au-delà, pas de rue utilisable

class Heap {
  constructor(capacity) {
    this.keys = new Float64Array(capacity);
    this.values = new Int32Array(capacity);
    this.size = 0;
  }

  push(key, value) {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2);
      const values = new Int32Array(this.size * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    const { keys, values } = this;
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** Retire le plus petit ; sa clé est dans this.top. */
  pop() {
    const { keys, values } = this;
    const value = values[0];
    this.top = keys[0];
    this.size -= 1;
    const lastKey = keys[this.size];
    const lastValue = values[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && keys[child + 1] < keys[child]) child += 1;
      if (keys[child] >= lastKey) break;
      keys[i] = keys[child];
      values[i] = values[child];
      i = child;
    }
    keys[i] = lastKey;
    values[i] = lastValue;
    return value;
  }
}

/** Graphe orienté compact (CSR) : pour chaque nœud, ses successeurs et le coût en secondes. */
function buildCsr(count, arcs) {
  const offsets = new Int32Array(count + 1);
  for (const [from] of arcs) offsets[from + 1] += 1;
  for (let i = 0; i < count; i += 1) offsets[i + 1] += offsets[i];
  const fill = offsets.slice(0, count);
  const targets = new Int32Array(arcs.length);
  const costs = new Float32Array(arcs.length);
  for (const [from, to, cost] of arcs) {
    const k = fill[from];
    fill[from] += 1;
    targets[k] = to;
    costs[k] = cost;
  }
  return { offsets, targets, costs };
}

function parse(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== "RTE1") throw new Error("routes.bin : format inconnu");
  const n = view.getUint32(4, true);
  const m = view.getUint32(8, true);
  const originX = view.getFloat64(12, true);
  const originY = view.getFloat64(20, true);
  let offset = 28;
  const take = (Type, count) => {
    const bytes = buffer.slice(offset, offset + count * Type.BYTES_PER_ELEMENT);
    offset += count * Type.BYTES_PER_ELEMENT;
    return new Type(bytes);
  };
  const a = take(Uint32Array, m);
  const b = take(Uint32Array, m);
  const x = take(Uint16Array, n);
  const y = take(Uint16Array, n);
  const length = take(Uint16Array, m);
  const speed = take(Uint8Array, m);
  const flags = take(Uint8Array, m);
  const nodeFlags = take(Uint8Array, n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    xs[i] = x[i] + originX;
    ys[i] = y[i] + originY;
  }
  return { n, m, a, b, xs, ys, length, speed, flags, nodeFlags };
}

function buildMode(net, mode) {
  const forward = [];
  const backward = [];
  const add = (from, to, cost) => {
    forward.push([from, to, cost]);
    backward.push([to, from, cost]);
  };
  if (mode === "voiture") {
    for (let e = 0; e < net.m; e += 1) {
      const f = net.flags[e];
      if (!(f & 3)) continue;
      const cost = net.length[e] / 10 / (net.speed[e] / 3.6);
      if (f & 1) add(net.a[e], net.b[e], cost);
      if (f & 2) add(net.b[e], net.a[e], cost);
    }
  } else {
    const { cyclingKmh, walkingKmh, factor } = ROAD_MODES.velo;
    const ride = factor / (cyclingKmh / 3.6);
    const push = factor / (walkingKmh / 3.6);
    for (let e = 0; e < net.m; e += 1) {
      const f = net.flags[e];
      const meters = net.length[e] / 10;
      // À vélo si permis et pas trop stressant, sinon vélo poussé à pied si les piétons passent.
      if (f & 4 && !(f & 32)) add(net.a[e], net.b[e], meters * ride);
      else if (f & 16) add(net.a[e], net.b[e], meters * push);
      if (f & 8 && !(f & 64)) add(net.b[e], net.a[e], meters * ride);
      else if (f & 16) add(net.b[e], net.a[e], meters * push);
    }
  }
  // Nœuds rattachables : ceux du réseau principal de ce mode, rangés par maille pour la recherche.
  // Comme R5 : pas de rattachement à une autoroute, un tunnel ou une voie couverte.
  const main = mode === "voiture" ? 1 : 2;
  const linkable = mode === "voiture" ? 8 : 16;
  const buckets = new Map();
  for (let i = 0; i < net.n; i += 1) {
    if (!(net.nodeFlags[i] & main) || !(net.nodeFlags[i] & linkable)) continue;
    const key = `${Math.floor(net.xs[i] / BUCKET)},${Math.floor(net.ys[i] / BUCKET)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  const penalty = new Float32Array(net.n);
  if (mode === "voiture") {
    for (let i = 0; i < net.n; i += 1) if (net.nodeFlags[i] & 4) penalty[i] = ROAD_MODES.voiture.junctionSeconds;
  }
  const accessSpeed = mode === "voiture" ? ROAD_MODES.voiture.accessMetersPerSecond : ROAD_MODES.velo.cyclingKmh / 3.6;
  return {
    mode,
    forward: buildCsr(net.n, forward),
    backward: buildCsr(net.n, backward),
    buckets,
    penalty,
    accessSpeed,
  };
}

/** Nœud rattachable le plus proche d'un point [x, y], et la distance ; null au-delà de MAX_SNAP. */
function snap(net, graph, point) {
  const [px, py] = point;
  const bx = Math.floor(px / BUCKET);
  const by = Math.floor(py / BUCKET);
  let best = -1;
  let bestDistance = Infinity;
  for (let ring = 0; ring * BUCKET <= MAX_SNAP + BUCKET; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const nodes = graph.buckets.get(`${bx + dx},${by + dy}`);
        if (!nodes) continue;
        for (const node of nodes) {
          const distance = Math.hypot(net.xs[node] - px, net.ys[node] - py);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = node;
          }
        }
      }
    }
    // Tout nœud d'un anneau plus lointain est à plus de ring × BUCKET mètres.
    if (best >= 0 && bestDistance <= ring * BUCKET) break;
  }
  return best >= 0 && bestDistance <= MAX_SNAP ? { node: best, meters: bestDistance } : null;
}

/** Charge et prépare le réseau ; `cells` : cases de la carte du site, rattachées une fois pour toutes. */
export async function loadRoads(url, cells) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`routes.bin : ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("deflate"));
  const net = parse(await new Response(stream).arrayBuffer());
  const graphs = {};
  for (const mode of Object.keys(ROAD_MODES)) {
    const graph = buildMode(net, mode);
    graph.cellNode = new Int32Array(cells.length).fill(-1);
    graph.cellAccess = new Float32Array(cells.length);
    cells.forEach((cell, index) => {
      const found = snap(net, graph, cell.point);
      if (!found) return;
      graph.cellNode[index] = found.node;
      graph.cellAccess[index] = found.meters / graph.accessSpeed;
    });
    graphs[mode] = graph;
  }

  /**
   * Temps (secondes) depuis un point vers chaque nœud, ou depuis chaque nœud vers ce point (reverse),
   * sans les minutes aux extrémités ni le rattachement de l'autre bout.
   */
  function solve(mode, point, { reverse = false, maxMinutes = 120 } = {}) {
    const graph = graphs[mode];
    const start = snap(net, graph, point);
    const seconds = new Float32Array(net.n).fill(Infinity);
    if (!start) return { mode, seconds, reachable: false };
    const { offsets, targets, costs } = reverse ? graph.backward : graph.forward;
    const { penalty } = graph;
    const limit = maxMinutes * 60;
    // Clés arrondies en float32, comme le tableau des temps : sinon un nœud se croirait déjà dépassé.
    const startSeconds = Math.fround(start.meters / graph.accessSpeed);
    const heap = new Heap(4096);
    seconds[start.node] = startSeconds;
    heap.push(startSeconds, start.node);
    while (heap.size) {
      const node = heap.pop();
      const time = heap.top;
      if (time > seconds[node]) continue;
      if (time > limit) break;
      for (let k = offsets[node]; k < offsets[node + 1]; k += 1) {
        const next = targets[k];
        const arrival = Math.fround(time + costs[k] + penalty[next]);
        if (arrival < seconds[next]) {
          seconds[next] = arrival;
          heap.push(arrival, next);
        }
      }
    }
    return { mode, seconds, reachable: true };
  }

  /** Minutes porte à porte vers chaque case de la carte (NaN si inaccessible), extrémités comprises. */
  function cellMinutes(solution) {
    const graph = graphs[solution.mode];
    const extra = ROAD_MODES[solution.mode].extremites;
    const out = new Float32Array(cells.length).fill(NaN);
    for (let i = 0; i < cells.length; i += 1) {
      const node = graph.cellNode[i];
      if (node < 0) continue;
      const time = solution.seconds[node];
      if (Number.isFinite(time)) out[i] = (time + graph.cellAccess[i]) / 60 + extra;
    }
    return out;
  }

  /** Minutes porte à porte vers un point quelconque, ou null. */
  function minutesTo(solution, point) {
    const graph = graphs[solution.mode];
    const end = snap(net, graph, point);
    if (!end) return null;
    const time = solution.seconds[end.node];
    return Number.isFinite(time) ? (time + end.meters / graph.accessSpeed) / 60 + ROAD_MODES[solution.mode].extremites : null;
  }

  return { solve, cellMinutes, minutesTo, nodeCount: net.n };
}
