// Montpellier porte à porte
// Carte des temps de trajet : tram et bus (réseau TaM), vélo et voiture (réseau de rues OpenStreetMap).

import { createBasemap, DEFAULT_PROVIDER, PROVIDERS } from "./basemap.js?v=2";
import { loadRoads, ROAD_MODES } from "./roads.js?v=1";
import { loadAddresses } from "./adresses.js?v=1";
import { loadTransit } from "./transit.js?v=2";

const DATA_URL = new URL("./data/commute_map_data.json?v=7", import.meta.url);
const ROADS_URL = new URL("./data/routes.bin?v=1", import.meta.url);
const ROAD_LIMIT_MINUTES = 100; // le calcul voiture et vélo s'arrête au-delà (curseur Échelle : 90 au plus)
const ADDRESSES_URL = new URL("./data/adresses.bin?v=1", import.meta.url);
// Tout changement des données ou des méthodes de calcul de la page change cette version : les temps gardés en
// mémoire dans le navigateur sont alors recalculés.
const HORAIRES_URL = new URL("./data/horaires.bin?v=1", import.meta.url);
const TOOL_MODEL = "page-2|horaires-1|routes-1";
const TOOL_MAX_MINUTES = 90; // au-delà, un foyer est jugé inaccessible (comme r5_isochrones.py)
const MODE_LABELS = { tc: "marche + transports en commun", velo: "vélo", voiture: "voiture" };

const DEFAULT_FROM = { lat: 43.60853, lon: 3.8799, label: "Place de la Comédie" };
const DEFAULT_MAX = 45;
const MIN_MAX = 5; // borne basse du curseur « Échelle » (doit correspondre au min de #maxRange)
const ISOCHRONE_OPTIONS = [5, 15, 30, 60]; // cases proposées ; d'autres valeurs s'ajoutent avec « Autre »
const ISO_MIN = 1;
const ISO_MAX = 90;
const DEFAULT_ISOCHRONES = [15, 30];
const SEED_STATIONS = 8;
// Au doigt, on vise moins précisément et un tap bouge souvent de quelques pixels.
const MARKER_HIT_RADIUS = { mouse: 18, touch: 30 };
const STOP_HOVER_RADIUS = 9; // pixels : distance de survol d'un arrêt
const CLICK_SLOP = { mouse: 5, touch: 12 };
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 14;
const STOP_LABEL_SCALE = 0.13; // pixels par mètre au-delà desquels on grossit les arrêts de tram et nomme les points r5py
const TRAM_NAME_RADIUS = 400; // mètres : en deçà, un lieu est nommé d'après la station de tram proche

// Du plus proche (vert) au plus lointain (rouge) ; au-delà du max : gris.
const PALETTE = [
  [0, [47, 150, 18]],
  [0.25, [126, 200, 80]],
  [0.5, [226, 228, 120]],
  [0.75, [244, 182, 112]],
  [1, [226, 120, 120]],
];
// Au-delà du max, la couleur s'efface progressivement jusqu'à laisser voir le fond.
const BEYOND_FADE = 0.15;
const HEAT_ALPHA = 0.78;
// Sur un vrai fond de carte, la heatmap est plus transparente pour laisser voir les rues.
const HEAT_ALPHA_BASEMAP = 0.6;
const HEAT_UPSAMPLE = 3;
const LUT_SIZE = 512;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const WATER_BRIDGE_CELLS = 4; // cases de 200 m : de quoi enjamber un étang pour les isochrones

const COLORS = {
  background: "#f1efe9",
  land: "#e4e2dc",
  water: "#bcd7e8",
  park: "rgba(120, 180, 90, 0.18)",
  communeLine: "rgba(255, 255, 255, 0.9)",
  communeLineOnBasemap: "rgba(70, 70, 70, 0.45)",
  contour: "#111111",
  from: "#3aa70b",
  to: "#111111",
};

const $ = (id) => document.getElementById(id);
const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");
const stage = $("mapStage");

const app = {
  data: null,
  graph: null,
  paths: null,
  offset: [0, 0],
  view: { cx: 0, cy: 0, scale: 1, fitScale: 1 },
  size: { width: 0, height: 0, dpr: 1 },
  from: null, // { point, label }
  to: null, // { point, label }
  includeBus: true, // bus inclus par défaut (décochable : ?bus=0)
  maxMinutes: DEFAULT_MAX,
  isochrones: [...DEFAULT_ISOCHRONES],
  heatFrom: "from", // la heatmap part du départ ou de l'arrivée
  // Mode de déplacement : tc (marche + transports en commun), velo ou voiture. Il vaut pour la carte du site
  // (calcul simplifié) comme pour les résultats r5py.
  mode: "tc",
  roads: null, // réseau de rues (voiture, vélo), chargé au premier choix de l'un de ces modes
  roadsLoading: null,
  roadSolution: null, // temps en voiture ou à vélo depuis le départ (panneau)
  solution: null, // plus courts chemins depuis le départ (panneau, itinéraire)
  heatSolution: null, // plus courts chemins depuis le point d'où part la heatmap
  grid: null,
  heatCanvas: document.createElement("canvas"),
  basemap: null, // couche de tuiles, créée une fois les données chargées
  provider: DEFAULT_PROVIDER,
  showBasemap: true,
  showNetwork: true, // lignes, arrêts et noms d'arrêts (affichage seulement : le calcul n'en dépend pas)
  heatOpacity: null, // null = valeur automatique selon la présence du fond de carte
  // Résultats r5py chargés depuis des fichiers locaux : grilles par référence, points, matrice.
  // grids : clé « référence|mode » (mode tc = marche + transports en commun, voiture, velo) ; refs : une entrée par référence.
  r5: { grids: new Map(), refs: new Map(), points: [], matrix: new Map(), active: null, grid: null },
  hoverStop: null, // arrêt survolé (indice dans data.stations)
  addresses: null, // index des adresses de la Métropole (géocodage local)
  addressesLoading: null,
  // Données importées par l'utilisateur (lues dans le navigateur, jamais envoyées) et temps calculés :
  // times : clé « id du point de vente|mode » → minutes vers chaque foyer (NaN : inaccessible).
  // grids : clé « id du point de vente|tc » → minutes vers chaque case de la carte (isochrones transports en commun).
  // live : minutes vers chaque foyer depuis le départ (ou l'arrivée) de la carte affichée, recalculées à chaque calcul.
  // hover, selected : lieu survolé, lieux cliqués (« f3 » : foyers[3], « v2 » : ventes[2]) : seuls ceux-là ont leur étiquette.
  tool: { foyers: [], ventes: [], report: [], times: new Map(), grids: new Map(), active: null, busy: false, targets: null,
          live: null, hover: null, selected: new Set(), focus: null },
  // focus : foyer cliqué (indice), devenu le départ ; le panneau liste les points de vente dans ses isochrones.
  heatVersion: 0, // augmente à chaque calcul de la carte : les temps des foyers sont alors à refaire
  heatRoad: null, // calcul voiture ou vélo d'où vient la carte (départ, ou arrivée prise à rebours)
  transit: null, // horaires et calcul transports en commun (transit.js), chargés au premier calcul
  drag: null,
  pointers: new Map(),
  frameRequested: false,
};

// --- Petites fonctions utilitaires ------------------------------------------

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hypot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  return `${hours} h ${String(rest).padStart(2, "0")}`;
}

function paletteColor(t) {
  for (let i = 1; i < PALETTE.length; i += 1) {
    const [stop, color] = PALETTE[i];
    if (t <= stop) {
      const [prevStop, prevColor] = PALETTE[i - 1];
      const mix = (t - prevStop) / (stop - prevStop);
      return prevColor.map((channel, c) => Math.round(channel + (color[c] - channel) * mix));
    }
  }
  return PALETTE[PALETTE.length - 1][1];
}

function metersPerDegree() {
  const lat = 111320;
  return { lat, lon: lat * Math.cos((app.data.meta.lat0 * Math.PI) / 180) };
}

function toWorld(lat, lon) {
  const m = metersPerDegree();
  return [lon * m.lon, lat * m.lat];
}

function toLatLon(point) {
  const m = metersPerDegree();
  return { lat: point[1] / m.lat, lon: point[0] / m.lon };
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function isOnLand(point) {
  if (app.data.water.some((polygon) => pointInPolygon(point, polygon))) return false;
  return app.data.boroughs.some((commune) => commune.polygons.some((polygon) => pointInPolygon(point, polygon)));
}

function communeAt(point) {
  return app.data.boroughs.find((commune) => commune.polygons.some((polygon) => pointInPolygon(point, polygon)))?.name;
}

// --- Graphe du réseau ---------------------------------------------------------

class MinHeap {
  constructor() {
    this.keys = [];
    this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
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

  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop();
    const lastValue = values.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

function prepareGraph(data) {
  const count = data.routeStates.length;
  const offsets = new Int32Array(count + 1);
  data.adjacency.forEach((edges, i) => {
    offsets[i + 1] = offsets[i] + edges.length;
  });
  const targets = new Int32Array(offsets[count]);
  const weights = new Float32Array(offsets[count]);
  data.adjacency.forEach((edges, i) => {
    edges.forEach(([target, weight], k) => {
      targets[offsets[i] + k] = target;
      weights[offsets[i] + k] = weight;
    });
  });
  return {
    count,
    offsets,
    targets,
    weights,
    station: Int32Array.from(data.routeStates, (state) => state.stationIndex),
    wait: Float32Array.from(data.routeStates, (state) => state.wait),
    route: data.routeStates.map((state) => state.routeId),
    isBus: Uint8Array.from(data.routeStates, (state) => (data.routeInfo[state.routeId]?.mode === "tram" ? 0 : 1)),
  };
}

function walkMinutes(meters) {
  return meters / app.data.meta.walkMetersPerMinute;
}

function stationUsable(index) {
  return app.includeBus || app.data.stations[index].tram;
}

/** Plus courts chemins depuis un point : temps d'arrivée à chaque arrêt + prédécesseurs. */
function solveFrom(point, includeBus = app.includeBus) {
  const { graph, data } = app;
  const access = data.meta.stationAccessPenalty;
  const dist = new Float64Array(graph.count).fill(Infinity);
  const prev = new Int32Array(graph.count).fill(-1);
  const seedWalk = new Float64Array(graph.count);
  const heap = new MinHeap();

  // Arrêts de départ : les plus proches stations de tram, plus (bus cochés) les plus proches arrêts de bus.
  // Pris ensemble, les nombreux arrêts de bus évinceraient les stations de tram : ajouter le bus rallongerait
  // alors certains trajets.
  const nearest = (keep) =>
    data.stations
      .map((station, index) => ({ index, walk: walkMinutes(hypot(point, station.point)) + access }))
      .filter((seed) => keep(data.stations[seed.index]))
      .sort((a, b) => a.walk - b.walk)
      .slice(0, SEED_STATIONS);
  const seeds = [...nearest((station) => station.tram), ...(includeBus ? nearest((station) => !station.tram) : [])];

  for (const seed of seeds) {
    for (const state of data.stationStates[seed.index]) {
      if (!includeBus && graph.isBus[state]) continue;
      const time = seed.walk + graph.wait[state];
      if (time < dist[state]) {
        dist[state] = time;
        seedWalk[state] = seed.walk;
        heap.push(time, state);
      }
    }
  }

  while (heap.size) {
    const state = heap.pop();
    const base = dist[state];
    for (let e = graph.offsets[state]; e < graph.offsets[state + 1]; e += 1) {
      const next = graph.targets[e];
      if (!includeBus && graph.isBus[next]) continue;
      const time = base + graph.weights[e];
      if (time < dist[next]) {
        dist[next] = time;
        prev[next] = state;
        heap.push(time, next);
      }
    }
  }

  const stationTime = new Float64Array(data.stations.length).fill(Infinity);
  const stationBest = new Int32Array(data.stations.length).fill(-1);
  for (let state = 0; state < graph.count; state += 1) {
    const station = graph.station[state];
    if (dist[state] < stationTime[station]) {
      stationTime[station] = dist[state];
      stationBest[station] = state;
    }
  }
  return { point, dist, prev, seedWalk, stationTime, stationBest };
}

/** Meilleur temps vers un point quelconque : à pied direct, ou via l'arrêt le plus favorable. */
function travelTo(solution, point) {
  const access = app.data.meta.stationAccessPenalty;
  let best = { minutes: walkMinutes(hypot(solution.point, point)), station: -1, walk: 0 };
  best.walk = best.minutes;
  app.data.stations.forEach((station, index) => {
    const arrival = solution.stationTime[index];
    if (!Number.isFinite(arrival)) return;
    const walk = walkMinutes(hypot(station.point, point)) + access;
    if (arrival + walk < best.minutes) best = { minutes: arrival + walk, station: index, walk };
  });
  return best;
}

function routeLabel(routeId) {
  const info = app.data.routeInfo[routeId];
  return `${info.mode === "tram" ? "Tram" : "Bus"} ${info.name}`;
}

/** Reconstitue l'itinéraire (marche, lignes, correspondances) vers un point. */
function buildItinerary(solution, point) {
  const { graph, data } = app;
  const result = travelTo(solution, point);
  if (result.station === -1) {
    return { minutes: result.minutes, steps: [{ kind: "walk", text: "Tout à pied", minutes: result.minutes }] };
  }

  const chain = [];
  for (let state = solution.stationBest[result.station]; state !== -1; state = solution.prev[state]) chain.push(state);
  chain.reverse();

  const name = (state) => data.stations[graph.station[state]].name;
  const steps = [{ kind: "walk", text: `À pied jusqu'à ${name(chain[0])}`, minutes: solution.seedWalk[chain[0]] }];
  let legStart = chain[0];
  const closeLeg = (legEnd) => {
    steps.push({
      kind: "ride",
      route: graph.route[legStart],
      text: `${name(legStart)} → ${name(legEnd)}`,
      wait: graph.wait[legStart],
      minutes: solution.dist[legEnd] - solution.dist[legStart],
    });
  };
  for (let i = 1; i < chain.length; i += 1) {
    const from = chain[i - 1];
    const to = chain[i];
    if (graph.route[from] === graph.route[to] && graph.station[from] !== graph.station[to]) continue;
    closeLeg(from);
    // Marche et quai : tout le temps de la correspondance, sauf l'attente de la ligne suivante (affichée avec elle).
    const minutes = solution.dist[to] - solution.dist[from] - graph.wait[to];
    const text = graph.station[from] === graph.station[to] ? `Correspondance à ${name(to)}` : `Correspondance à pied vers ${name(to)}`;
    steps.push({ kind: "walk", text, minutes });
    legStart = to;
  }
  closeLeg(chain[chain.length - 1]);
  steps.push({ kind: "walk", text: "À pied jusqu'à l'arrivée", minutes: result.walk });
  return { minutes: result.minutes, steps };
}

// --- Grille des temps ---------------------------------------------------------

/** Comble les cases sans valeur (eau, hors carte) avec la moyenne de leurs voisines, `passes` fois. */
function fillGaps(values, cols, rows, passes) {
  const filled = Float32Array.from(values);
  for (let pass = 0; pass < passes; pass += 1) {
    const source = Float32Array.from(filled);
    for (let index = 0; index < source.length; index += 1) {
      if (!Number.isNaN(source[index])) continue;
      const row = Math.floor(index / cols);
      const col = index % cols;
      let sum = 0;
      let count = 0;
      for (const [dr, dc] of NEIGHBOURS) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const value = source[r * cols + c];
        if (!Number.isNaN(value)) {
          sum += value;
          count += 1;
        }
      }
      if (count) filled[index] = sum / count;
    }
  }
  return filled;
}

function computeGrid(solution) {
  const { cells, meta } = app.data;
  const { gridCols: cols, gridRows: rows, stationAccessPenalty: access } = meta;
  const times = new Float32Array(cols * rows).fill(NaN);
  for (const cell of cells) {
    let best = walkMinutes(hypot(solution.point, cell.point));
    for (const [station, meters] of cell.access) {
      const time = solution.stationTime[station] + walkMinutes(meters) + access;
      if (time < best) best = time;
    }
    times[cell.row * cols + cell.col] = best;
  }
  // Les isochrones enjambent les étangs (comblés avec les valeurs des rives) au lieu d'en faire le tour ;
  // elles sont ensuite découpées sur la terre ferme au dessin.
  const bridged = fillGaps(times, cols, rows, WATER_BRIDGE_CELLS);
  return { times, smooth: smoothGrid(bridged, cols, rows), cols, rows, contours: {} };
}

/** Grille de la carte à partir des minutes par case (voiture, vélo). */
function roadGrid(minutes) {
  const { cells, meta } = app.data;
  const { gridCols: cols, gridRows: rows } = meta;
  const times = new Float32Array(cols * rows).fill(NaN);
  cells.forEach((cell, index) => {
    times[cell.row * cols + cell.col] = minutes[index];
  });
  const bridged = fillGaps(times, cols, rows, WATER_BRIDGE_CELLS);
  return { times, smooth: smoothGrid(bridged, cols, rows), cols, rows, contours: {} };
}

function ensureRoads() {
  if (app.roads) return Promise.resolve(app.roads);
  if (!app.roadsLoading) {
    toast("Chargement du réseau de rues…", 6000);
    app.roadsLoading = loadRoads(ROADS_URL, app.data.cells)
      .then((roads) => {
        app.roads = roads;
        $("toast").hidden = true;
        return roads;
      })
      .catch((error) => {
        console.error(error);
        app.roadsLoading = null;
        toast(`Réseau de rues indisponible : ${error.message}`, 7000);
        throw error;
      });
  }
  return app.roadsLoading;
}

/** Moyenne 3×3 limitée à la terre ferme, pour des isochrones moins crénelées. */
function smoothGrid(times, cols, rows) {
  const out = new Float32Array(times.length).fill(NaN);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (Number.isNaN(times[index])) continue;
      let sum = 0;
      let weight = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = col + dx;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const value = times[r * cols + c];
          if (Number.isNaN(value)) continue;
          const w = dx === 0 && dy === 0 ? 2 : 1;
          sum += value * w;
          weight += w;
        }
      }
      out[index] = sum / weight;
    }
  }
  return out;
}

/** Peint la grille dans une image (HEAT_UPSAMPLE² pixels par cellule, interpolation bilinéaire). */
function paintHeat(grid, { fast = false } = {}) {
  const { cols, rows, times } = grid;
  const upsample = fast ? 1 : HEAT_UPSAMPLE;
  const heat = app.heatCanvas;
  heat.width = cols * upsample;
  heat.height = rows * upsample;
  const heatCtx = heat.getContext("2d");
  const image = heatCtx.createImageData(heat.width, heat.height);

  // Étend les valeurs d'un cran hors de la terre pour que le lissage ne fonce pas les côtes.
  const filled = fillGaps(times, cols, rows, 2);

  // Table de couleurs précalculée : t ∈ [0, 1 + BEYOND_FADE] découpé en LUT_SIZE pas.
  const lutMax = 1 + BEYOND_FADE;
  const lut = new Uint32Array(LUT_SIZE);
  const lutBytes = new Uint8Array(lut.buffer);
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = (i / (LUT_SIZE - 1)) * lutMax;
    const [r, g, b] = paletteColor(Math.min(t, 1));
    const alpha = t <= 1 ? 255 : Math.round(clamp(1 - (t - 1) / BEYOND_FADE, 0, 1) * 255);
    lutBytes.set([r, g, b, alpha], i * 4);
  }
  const pixels = new Uint32Array(image.data.buffer);
  const toLut = (LUT_SIZE - 1) / (app.maxMinutes * lutMax);
  const step = 1 / upsample;
  const width = heat.width;
  for (let y = 0; y < heat.height; y += 1) {
    const gy = (y + 0.5) * step - 0.5;
    const row0 = clamp(Math.floor(gy), 0, rows - 1);
    const row1 = Math.min(row0 + 1, rows - 1);
    const ty = clamp(gy - row0, 0, 1);
    for (let x = 0; x < width; x += 1) {
      const gx = (x + 0.5) * step - 0.5;
      const col0 = clamp(Math.floor(gx), 0, cols - 1);
      const col1 = Math.min(col0 + 1, cols - 1);
      const tx = clamp(gx - col0, 0, 1);
      const v00 = filled[row0 * cols + col0];
      const v01 = filled[row0 * cols + col1];
      const v10 = filled[row1 * cols + col0];
      const v11 = filled[row1 * cols + col1];
      let sum = 0;
      let weight = 0;
      let w = (1 - tx) * (1 - ty);
      if (v00 === v00) { sum += v00 * w; weight += w; }
      w = tx * (1 - ty);
      if (v01 === v01) { sum += v01 * w; weight += w; }
      w = (1 - tx) * ty;
      if (v10 === v10) { sum += v10 * w; weight += w; }
      w = tx * ty;
      if (v11 === v11) { sum += v11 * w; weight += w; }
      if (weight < 0.25) continue;
      const index = Math.round((sum / weight) * toLut);
      if (index < LUT_SIZE) pixels[y * width + x] = lut[index];
    }
  }
  heatCtx.putImageData(image, 0, 0);
}

/** Marching squares sur les centres de cellules ; renvoie des segments en coordonnées monde. */
function contourSegments(grid, threshold) {
  const { cols, rows, smooth } = grid;
  // Une grille r5py a sa propre emprise ; celle du site, l'emprise des données.
  const [minX, minY, maxX, maxY] = grid.bounds ?? app.data.meta.bounds;
  const cellW = (maxX - minX) / cols;
  const cellH = (maxY - minY) / rows;
  const value = (row, col) => {
    const v = smooth[row * cols + col];
    return Number.isNaN(v) ? Infinity : v;
  };
  const center = (row, col) => [minX + (col + 0.5) * cellW, minY + (row + 0.5) * cellH];
  const between = (pa, va, pb, vb) => {
    const t = Number.isFinite(va) && Number.isFinite(vb) ? clamp((threshold - va) / (vb - va), 0, 1) : 0.5;
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };

  const segments = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let col = 0; col < cols - 1; col += 1) {
      // Coins dans le sens trigonométrique : bas-gauche, bas-droite, haut-droite, haut-gauche.
      const corners = [
        [center(row, col), value(row, col)],
        [center(row, col + 1), value(row, col + 1)],
        [center(row + 1, col + 1), value(row + 1, col + 1)],
        [center(row + 1, col), value(row + 1, col)],
      ];
      const inside = corners.map(([, v]) => v <= threshold);
      const crossings = [];
      for (let k = 0; k < 4; k += 1) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        if (inside[k] !== inside[(k + 1) % 4]) crossings.push(between(a[0], a[1], b[0], b[1]));
      }
      if (crossings.length === 2) segments.push(crossings);
      else if (crossings.length === 4) segments.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
    }
  }
  return segments;
}

// --- Vue et rendu -------------------------------------------------------------

function buildPaths(data) {
  const [ox, oy] = app.offset;
  const ringPath = (path, ring) => {
    ring.forEach(([x, y], i) => (i ? path.lineTo(x - ox, y - oy) : path.moveTo(x - ox, y - oy)));
    path.closePath();
  };
  const polygonsPath = (polygons) => {
    const path = new Path2D();
    for (const polygon of polygons) for (const ring of polygon) ringPath(path, ring);
    return path;
  };
  const communeLines = new Path2D();
  for (const commune of data.boroughs) for (const ring of commune.outline) ringPath(communeLines, ring);

  const routes = new Map();
  for (const route of data.routes) {
    if (!routes.has(route.id)) routes.set(route.id, { color: route.color, path: new Path2D() });
    const { path } = routes.get(route.id);
    route.points.forEach(([x, y], i) => (i ? path.lineTo(x - ox, y - oy) : path.moveTo(x - ox, y - oy)));
  }
  return {
    land: polygonsPath(data.boroughs.flatMap((commune) => commune.polygons)),
    // Terres voisines de la Métropole : ce qui reste découvert autour est la mer.
    context: polygonsPath(data.context ?? []),
    // Un chemin par polygone, rempli en « evenodd » : les îles (trous) restent de la terre ferme,
    // sans que deux plans d'eau qui se chevauchent s'annulent.
    water: data.water.map((polygon) => polygonsPath([polygon])),
    parks: data.parks.map((polygon) => polygonsPath([polygon])),
    // Tous les plans d'eau en un seul chemin, pour y remettre le fond de carte (découpe « evenodd » : îles exclues).
    waterClip: polygonsPath(data.water),
    communeLines,
    routes: [...routes.values()].reverse(),
    // Lignes de bus : un chemin par ligne, dessiné en trait fin sous le tram quand les bus sont cochés.
    busRoutes: [...(data.busRoutes ?? []).reduce((byLine, route) => {
      if (!byLine.has(route.id)) byLine.set(route.id, { color: route.color, path: new Path2D() });
      const { path } = byLine.get(route.id);
      route.points.forEach(([x, y], i) => (i ? path.lineTo(x - ox, y - oy) : path.moveTo(x - ox, y - oy)));
      return byLine;
    }, new Map()).values()],
  };
}

function project(point) {
  const { cx, cy, scale } = app.view;
  return [app.size.width / 2 + (point[0] - cx) * scale, app.size.height / 2 - (point[1] - cy) * scale];
}

function unproject(x, y) {
  const { cx, cy, scale } = app.view;
  return [cx + (x - app.size.width / 2) / scale, cy - (y - app.size.height / 2) / scale];
}

function fitView() {
  const [minX, minY, maxX, maxY] = app.data.meta.viewBounds;
  const { width, height } = app.size;
  const pad = width < 720 ? 12 : 40;
  const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  app.view = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, fitScale: scale };
}

function zoomAt(factor, screenX, screenY) {
  const before = unproject(screenX, screenY);
  const { fitScale } = app.view;
  app.view.scale = clamp(app.view.scale * factor, fitScale * MIN_ZOOM_FACTOR, fitScale * MAX_ZOOM_FACTOR);
  const after = unproject(screenX, screenY);
  app.view.cx += before[0] - after[0];
  app.view.cy += before[1] - after[1];
  requestRender();
}

/** Passe le contexte en coordonnées monde (mètres, origine décalée, axe y vers le nord). */
function useWorldTransform() {
  const { cx, cy, scale } = app.view;
  const { width, height, dpr } = app.size;
  const [ox, oy] = app.offset;
  ctx.setTransform(
    dpr * scale,
    0,
    0,
    -dpr * scale,
    dpr * (width / 2 + (ox - cx) * scale),
    dpr * (height / 2 - (oy - cy) * scale),
  );
}

function useScreenTransform() {
  const { dpr } = app.size;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawHaloText(text, x, y, { font, color, halo = "rgba(255,255,255,0.92)", width = 3.5 }) {
  ctx.font = font;
  ctx.lineJoin = "round";
  ctx.strokeStyle = halo;
  ctx.lineWidth = width;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function heatAlpha() {
  return app.heatOpacity ?? (app.showBasemap ? HEAT_ALPHA_BASEMAP : HEAT_ALPHA);
}

/** Dessine une couche de tuiles (le contexte doit être en coordonnées écran). */
function drawTiles(layer) {
  const { width, height, dpr } = app.size;
  return app.basemap.draw(ctx, layer, { project, unproject, width, height, dpr, scale: app.view.scale });
}

function drawAttribution() {
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  drawHaloText(app.basemap.attribution, app.size.width - 8, app.size.height - 7, {
    font: "500 10px Inter, sans-serif",
    color: "#444",
    halo: "rgba(255,255,255,0.85)",
    width: 3,
  });
}

function drawIsochrones() {
  if (!app.grid || !app.isochrones.length) return;
  const px = 1 / app.view.scale;
  const [ox, oy] = app.offset;
  const labels = [];
  for (const threshold of [...app.isochrones].sort((a, b) => a - b)) {
    app.grid.contours[threshold] ??= contourSegments(app.grid, threshold);
    const segments = app.grid.contours[threshold];
    if (!segments.length) continue;
    useWorldTransform();
    const path = new Path2D();
    for (const [a, b] of segments) {
      path.moveTo(a[0] - ox, a[1] - oy);
      path.lineTo(b[0] - ox, b[1] - oy);
    }
    // Les courbes enjambent les étangs : on ne trace que ce qui est sur la terre ferme de la Métropole.
    ctx.save();
    ctx.clip(app.paths.land, "evenodd");
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 4.5 * px;
    ctx.stroke(path);
    ctx.strokeStyle = COLORS.contour;
    ctx.lineWidth = (threshold >= 30 ? 2 : 1.4) * px;
    ctx.stroke(path);
    ctx.restore();

    // Étiquette sur le point le plus au nord de la courbe encore visible, à l'écart des marqueurs
    // et des étiquettes déjà posées, et sur la terre ferme.
    const avoid = [app.from, app.to].filter(Boolean).map((place) => project(place.point));
    avoid.push(...labels.map((label) => label.at));
    const candidates = [];
    for (const [a, b] of segments) {
      const world = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [x, y] = project(world);
      if (x < 60 || x > app.size.width - 60 || y < 24 || y > app.size.height - 24) continue;
      if (avoid.some(([ax, ay]) => Math.abs(x - ax) < 70 && y - ay > -60 && y - ay < 40)) continue;
      candidates.push({ world, at: [x, y] });
    }
    candidates.sort((p, q) => p.at[1] - q.at[1]);
    const best = candidates.find((candidate) => isOnLand(candidate.world));
    if (best) labels.push({ text: `${threshold} min`, at: best.at });
  }
  useScreenTransform();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { text, at } of labels) {
    drawHaloText(text, at[0], at[1], { font: "700 12px Inter, sans-serif", color: COLORS.contour, width: 5 });
  }
}

/** Arrêt visible le plus proche d'un point de l'écran (tram, et bus s'ils sont affichés), ou null. */
function stopAt(screen) {
  if (!app.showNetwork) return null;
  let best = null;
  let bestDistance = STOP_HOVER_RADIUS;
  app.data.stations.forEach((station, index) => {
    if (!station.tram && !app.includeBus) return;
    const distance = hypot(screen, project(station.point));
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function stopLines(station) {
  const names = (mode) =>
    station.routes
      .map((id) => app.data.routeInfo[id])
      .filter((info) => info?.mode === mode)
      .map((info) => info.name)
      .sort((x, y) => x.localeCompare(y, "fr", { numeric: true }));
  const parts = [];
  const tram = names("tram");
  if (tram.length) parts.push(`Tram ${tram.join(", ")}`);
  const bus = app.includeBus ? names("bus") : [];
  if (bus.length) parts.push(`Bus ${bus.join(", ")}`);
  return parts.join(" · ");
}

/** Points des arrêts (petits pour le bus, moyens pour le tram) ; nom et lignes seulement au survol. */
function drawStops() {
  if (!app.showNetwork) return;
  const { stations } = app.data;
  const visible = ([x, y]) => x > -10 && y > -10 && x < app.size.width + 10 && y < app.size.height + 10;
  if (app.includeBus) {
    ctx.fillStyle = "rgba(50, 50, 50, 0.6)";
    ctx.beginPath();
    for (const station of stations) {
      if (station.tram) continue;
      const [x, y] = project(station.point);
      if (!visible([x, y])) continue;
      ctx.moveTo(x + 1.6, y);
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  const radius = app.view.scale > STOP_LABEL_SCALE ? 3.4 : 2.6;
  ctx.beginPath();
  for (const station of stations) {
    if (!station.tram) continue;
    const [x, y] = project(station.point);
    if (!visible([x, y])) continue;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "#333";
  ctx.stroke();
  drawHoveredStop();
}

function drawHoveredStop() {
  const index = app.hoverStop;
  if (index === null || index === undefined) return;
  const station = app.data.stations[index];
  if (!station || (!station.tram && !app.includeBus)) return;
  const [x, y] = project(station.point);
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#333";
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const lines = stopLines(station);
  drawHaloText(station.name, x + 9, lines ? y - 7 : y, { font: "600 12px Inter, sans-serif", color: "#222" });
  if (lines) drawHaloText(lines, x + 9, y + 8, { font: "500 11px Inter, sans-serif", color: "#555" });
}

function drawCommuneNames() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const font = `600 ${app.view.scale > app.view.fitScale * 2 ? 13 : 10.5}px Inter, sans-serif`;
  for (const commune of app.data.boroughs) {
    const [x, y] = project(commune.label);
    if (x < 0 || y < 0 || x > app.size.width || y > app.size.height) continue;
    drawHaloText(commune.name.toUpperCase(), x, y, { font, color: "rgba(40, 40, 40, 0.55)", halo: "rgba(255,255,255,0.6)" });
  }
}

/** Marqueur rond ; carré pour un point de vente choisi (comme les carrés des points de vente). */
function drawMarker(point, color, label, square = false) {
  const [x, y] = project(point);
  ctx.beginPath();
  if (square) ctx.roundRect(x - 14, y - 14, 28, 28, 5);
  else ctx.arc(x, y, 15, 0, Math.PI * 2);
  ctx.fillStyle = `${color}2e`;
  ctx.fill();
  ctx.beginPath();
  if (square) ctx.rect(x - 7.5, y - 7.5, 15, 15);
  else ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  if (!label) return;
  ctx.font = "700 12px Inter, sans-serif";
  const width = ctx.measureText(label).width + 16;
  const left = clamp(x - width / 2, 6, app.size.width - width - 6);
  const top = y - 42;
  ctx.beginPath();
  ctx.roundRect(left, top, width, 22, 7);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + width / 2, top + 11.5);
}

function render() {
  app.frameRequested = false;
  if (!app.data) return;
  const { width, height, dpr } = app.size;
  const px = 1 / app.view.scale;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Côte : le fond est la mer, et les terres voisines de la Métropole sont dessinées par-dessus.
  const sea = app.data.meta.sea;
  ctx.fillStyle = sea ? COLORS.water : COLORS.background;
  ctx.fillRect(0, 0, width, height);

  // Le fond plat (terre grise) reste dessiné d'abord : il sert de repli tant que les tuiles arrivent,
  // ou si elles sont bloquées.
  useWorldTransform();
  if (sea) {
    ctx.fillStyle = COLORS.background;
    ctx.fill(app.paths.context);
  }
  ctx.fillStyle = COLORS.land;
  ctx.fill(app.paths.land, "evenodd");

  let tilesShown = false;
  if (app.showBasemap && app.basemap) {
    useScreenTransform();
    tilesShown = drawTiles("base") > 0;
    useWorldTransform();
  }

  if (app.grid) {
    const [minX, minY, maxX, maxY] = app.grid.bounds ?? app.data.meta.bounds;
    const [ox, oy] = app.offset;
    ctx.save();
    ctx.clip(app.paths.land, "evenodd");
    ctx.globalAlpha = heatAlpha();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // L'image a sa ligne 0 au sud : avec l'axe y inversé, elle se dessine dans le bon sens.
    ctx.drawImage(app.heatCanvas, minX - ox, minY - oy, maxX - minX, maxY - minY);
    ctx.restore();
  }

  if (tilesShown) {
    // La carte des contours déborde sur les étangs : on y remet le fond de carte, sans couleur par-dessus.
    ctx.save();
    ctx.clip(app.paths.waterClip, "evenodd");
    useScreenTransform();
    drawTiles("base");
    ctx.restore();
    ctx.strokeStyle = COLORS.communeLineOnBasemap;
    ctx.setLineDash([6 * px, 4 * px]);
  } else {
    ctx.fillStyle = COLORS.park;
    for (const park of app.paths.parks) ctx.fill(park, "evenodd");
    ctx.fillStyle = COLORS.water;
    for (const water of app.paths.water) ctx.fill(water, "evenodd");
    ctx.strokeStyle = COLORS.communeLine;
  }
  ctx.lineWidth = 1.1 * px;
  ctx.stroke(app.paths.communeLines);
  ctx.setLineDash([]);

  if (tilesShown && app.basemap.hasLabels) {
    // Noms de rues et de quartiers par-dessus la heatmap pour rester lisibles.
    useScreenTransform();
    drawTiles("labels");
    useWorldTransform();
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (app.showNetwork && app.includeBus) {
    // Bus : trait fin et un peu transparent, pour rester lisible sous le tram et sur la heatmap.
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.6 * px;
    for (const route of app.paths.busRoutes) {
      ctx.strokeStyle = route.color;
      ctx.stroke(route.path);
    }
    ctx.globalAlpha = 1;
  }
  if (app.showNetwork) {
    for (const route of app.paths.routes) {
      ctx.strokeStyle = route.color;
      ctx.lineWidth = 3 * px;
      ctx.stroke(route.path);
    }
  }

  drawIsochrones();
  useScreenTransform();
  // Avec les noms du fond de carte, ceux des communes feraient doublon.
  if (!(tilesShown && app.basemap.hasLabels)) drawCommuneNames();
  drawR5Points();
  drawFoyers();
  drawVentes();
  drawStops();
  if (app.to) {
    let minutes = app.solution ? formatMinutes(travelTo(app.solution, app.to.point).minutes) : null;
    if (app.roadSolution) {
      const road = roadMinutesTo(app.to.point);
      minutes = road === null ? "—" : formatMinutes(road);
    } else if (toolTransitShown()) {
      const transit = toolArrivalMinutes();
      minutes = transit === null ? "—" : formatMinutes(transit);
    }
    if (app.r5.active) {
      const r5 = r5TimeAt(app.to.point);
      minutes = r5 === null ? "> max" : formatMinutes(r5);
    }
    drawMarker(app.to.point, COLORS.to, app.heatFrom === "to" ? `Arrivée · ${minutes}` : minutes);
  }
  if (app.from) {
    const vente = activeVente();
    const focus = app.tool.foyers[app.tool.focus];
    const label = vente ? (noParkingShown() ? `${vente.id} · sans parking` : vente.id) : focus ? focus.id : "Départ";
    drawMarker(app.from.point, COLORS.from, label, Boolean(vente));
  }
  if (tilesShown) drawAttribution();
}

function requestRender() {
  if (app.frameRequested) return;
  app.frameRequested = true;
  requestAnimationFrame(render);
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const first = !app.size.width;
  const ratio = app.size.width ? rect.width / app.size.width : 1;
  app.size = { width: rect.width, height: rect.height, dpr };
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  if (!app.data) return;
  if (first) {
    fitView();
  } else {
    app.view.scale *= ratio;
    app.view.fitScale *= ratio;
  }
  requestRender();
}

// --- État, panneau et URL -------------------------------------------------------

/** Nom de lieu : la station de tram proche si elle existe (plus parlante qu'un arrêt de bus), sinon l'arrêt le plus proche. */
function nearestStopName(point) {
  let best = null;
  let bestDistance = Infinity;
  let tram = null;
  let tramDistance = Infinity;
  for (const station of app.data.stations) {
    const d = hypot(point, station.point);
    if (d < bestDistance) {
      bestDistance = d;
      best = station.name;
    }
    if (station.tram && d < tramDistance) {
      tramDistance = d;
      tram = station.name;
    }
  }
  return tramDistance <= TRAM_NAME_RADIUS ? tram : best;
}

function describePlace(point) {
  const stop = nearestStopName(point);
  const commune = communeAt(point);
  return commune && commune !== "Montpellier" ? `Près de ${stop} (${commune})` : `Près de ${stop}`;
}

function heatSource() {
  return app.heatFrom === "to" && app.to ? app.to : app.from;
}

function recompute({ fast = false } = {}) {
  app.heatVersion += 1;
  app.heatRoad = null;
  if (app.r5.active) {
    // La carte vient de la grille r5py de la référence : rien à recalculer.
    app.grid = app.r5.grid;
    if (app.grid) paintHeat(app.grid, { fast });
    updatePanel();
    requestRender();
    return;
  }
  if (!app.from) return;
  const toolGrid =
    app.tool.active && app.mode === "tc" && heatSource() === app.from ? app.tool.grids.get(`${app.tool.active}|tc`) : null;
  if (toolGrid) {
    // Point de vente choisi, transports en commun : isochrones du calcul porte à porte (celui des comptes).
    app.solution = solveFrom(app.from.point);
    app.heatSolution = app.solution;
    app.roadSolution = null;
    app.grid = roadGrid(toolGrid);
    paintHeat(app.grid, { fast });
    updatePanel();
    requestRender();
    return;
  }
  if (app.mode !== "tc") {
    if (!app.roads) {
      ensureRoads().then(() => recompute(), () => {});
      return;
    }
    const options = { maxMinutes: ROAD_LIMIT_MINUTES };
    app.solution = null;
    app.heatSolution = null;
    app.roadSolution = app.roads.solve(app.mode, app.from.point, options);
    // Carte depuis l'arrivée : temps de chaque lieu vers l'arrivée (sens uniques pris à rebours).
    const heat = heatSource() === app.from ? app.roadSolution : app.roads.solve(app.mode, app.to.point, { ...options, reverse: true });
    app.heatRoad = heat;
    app.grid = roadGrid(app.roads.cellMinutes(heat));
    paintHeat(app.grid, { fast });
    updatePanel();
    requestRender();
    return;
  }
  app.roadSolution = null;
  app.solution = solveFrom(app.from.point);
  app.heatSolution = heatSource() === app.from ? app.solution : solveFrom(app.to.point);
  app.grid = computeGrid(app.heatSolution);
  paintHeat(app.grid, { fast });
  updatePanel();
  requestRender();
}

function setFrom(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  // Déplacer le départ quitte les résultats r5py et le point de vente choisi, calculés pour eux seulement.
  if (app.r5.active) leaveR5();
  if (app.tool.active) leaveTool();
  app.tool.focus = null; // départ déplacé : il n'est plus sur le foyer choisi
  app.from = { point, label: label || describePlace(point) };
  recompute({ fast });
  if (!quiet) syncUrl();
  return true;
}

function setTo(point, label = null, { quiet = false, fast = false } = {}) {
  if (!isOnLand(point)) return false;
  app.to = { point, label: label || describePlace(point) };
  if (app.heatFrom === "to") {
    recompute({ fast });
  } else {
    updatePanel();
    requestRender();
  }
  if (!quiet) syncUrl();
  return true;
}

function removeTo() {
  app.to = null;
  setHeatFrom("from");
  syncUrl();
}

function setHeatFrom(source) {
  // En mode r5py, la carte part toujours de la référence (pas de grille r5py depuis un point quelconque).
  app.heatFrom = source === "to" && app.to && !app.r5.active ? "to" : "from";
  for (const button of $("heatFrom").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.source === app.heatFrom));
  }
  recompute();
}

function updatePanel() {
  $("tripFrom").textContent = app.from?.label ?? "—";
  const foyersShown = app.tool.foyers.length > 0 || Boolean(app.tool.active);
  $("r5Info").hidden = !app.r5.active && !foyersShown;
  if (foyersShown && !app.r5.active) updateToolPanel(); // comptes de foyers, sous l'itinéraire habituel
  if (app.r5.active) {
    updateR5Panel();
    return;
  }
  if (app.mode !== "tc") {
    updateRoadPanel();
    return;
  }
  const result = $("tripResult");
  if (app.to && toolTransitShown()) {
    // Même calcul que les comptes et les isochrones : porte à porte, médiane des départs de 7 h à 20 h.
    const minutes = toolArrivalMinutes();
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = app.to.label;
    $("tripDuration").textContent = minutes === null ? "Inaccessible" : formatMinutes(minutes);
    const item = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge walk";
    badge.textContent = "🚶";
    const text = document.createElement("span");
    text.textContent = "Marche par les rues et transports en commun : temps médian pour des départs de 7 h à 20 h.";
    item.append(badge, text);
    $("tripSteps").replaceChildren(item);
  } else if (!app.to || !app.solution) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    const itinerary = buildItinerary(app.solution, app.to.point);
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = app.to.label;
    $("tripDuration").textContent = formatMinutes(itinerary.minutes);
    $("tripSteps").replaceChildren(
      ...itinerary.steps
        .filter((step) => step.kind === "ride" || step.minutes >= 0.5)
        .map((step) => {
          const item = document.createElement("li");
          const badge = document.createElement("span");
          badge.className = "badge";
          if (step.kind === "ride") {
            const info = app.data.routeInfo[step.route];
            badge.textContent = info.name;
            badge.style.background = info.color;
            badge.style.color = contrastText(info.color);
            badge.title = routeLabel(step.route);
          } else {
            badge.classList.add("walk");
            badge.textContent = "🚶";
          }
          const text = document.createElement("span");
          text.textContent = step.kind === "ride" ? `${step.text} · attente ~${Math.round(step.wait)} min` : step.text;
          const minutes = document.createElement("span");
          minutes.className = "minutes";
          minutes.textContent = formatMinutes(step.minutes);
          item.append(badge, text, minutes);
          return item;
        }),
    );
  }
}

/** Minutes en voiture ou à vélo du départ vers un point (null si inaccessible). */
function roadMinutesTo(point) {
  if (!app.roads || !app.roadSolution) return null;
  return app.roads.minutesTo(app.roadSolution, point);
}

function updateRoadPanel() {
  const settings = ROAD_MODES[app.mode];
  const result = $("tripResult");
  if (!app.to || !app.roadSolution) {
    result.hidden = true;
    $("tripHint").hidden = false;
  } else {
    const minutes = roadMinutesTo(app.to.point);
    result.hidden = false;
    $("tripHint").hidden = true;
    $("tripTo").textContent = app.to.label;
    $("tripDuration").textContent = minutes === null ? "Inaccessible" : formatMinutes(minutes);
    const item = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge walk";
    badge.textContent = app.mode === "velo" ? "🚲" : "🚗";
    const text = document.createElement("span");
    text.textContent = `${settings.label} : ${settings.describe}.`;
    item.append(badge, text);
    $("tripSteps").replaceChildren(item);
  }
}

function contrastText(hex) {
  const value = parseInt(hex.slice(1), 16);
  const luminance = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255);
  return luminance > 150 ? "#111" : "#fff";
}

function updateLegend() {
  const stops = PALETTE.map(([t, [r, g, b]]) => `rgb(${r}, ${g}, ${b}) ${Math.round(t * 100)}%`);
  $("legendBar").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  $("legendMid").textContent = `${Math.round(app.maxMinutes / 2)} min`;
  $("legendMax").textContent = `${app.maxMinutes} min`;
  $("maxValue").textContent = `${app.maxMinutes} min`;
}

function formatPair(point) {
  const { lat, lon } = toLatLon(point);
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function parsePair(value) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value || "");
  return match ? toWorld(Number(match[1]), Number(match[2])) : null;
}

function syncUrl() {
  const params = new URLSearchParams();
  // Résultats r5py : les adresses (confidentielles) restent hors de l'URL et de l'historique.
  // Foyer choisi : sa position (confidentielle) reste aussi hors de l'URL.
  if (app.from && !app.r5.active && app.tool.focus === null) params.set("from", formatPair(app.from.point));
  if (app.to && !app.r5.active) params.set("to", formatPair(app.to.point));
  if (app.to && app.heatFrom === "to") params.set("carte", "arrivee");
  if (app.mode !== "tc") params.set("mode", app.mode);
  if (!app.includeBus) params.set("bus", "0");
  if (app.maxMinutes !== DEFAULT_MAX) params.set("max", String(app.maxMinutes));
  const iso = [...app.isochrones].sort((a, b) => a - b).join(",");
  if (iso !== DEFAULT_ISOCHRONES.join(",")) params.set("iso", iso || "0");
  if (!app.showNetwork) params.set("lignes", "0");
  if (!app.showBasemap) params.set("fond", "0");
  else if (app.provider !== DEFAULT_PROVIDER) params.set("fond", app.provider);
  if (app.heatOpacity !== null) params.set("opacite", String(Math.round(app.heatOpacity * 100)));
  const query = params.toString().replaceAll("%2C", ",");
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  app.includeBus = params.get("bus") !== "0"; // par défaut avec les bus ; les anciens liens « bus=1 » restent valables
  $("busToggle").checked = app.includeBus;
  const mode = params.get("mode");
  setModeControls(mode in ROAD_MODES ? mode : "tc");
  const max = Number(params.get("max"));
  if (max >= MIN_MAX && max <= 90) app.maxMinutes = max;
  $("maxRange").value = String(app.maxMinutes);
  if (params.has("iso")) {
    app.isochrones = params
      .get("iso")
      .split(",")
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= ISO_MIN && value <= ISO_MAX);
  }
  for (const value of app.isochrones) addIsochrone(value, { quiet: true });
  for (const input of $("isoToggles").querySelectorAll("input[type=checkbox]")) input.checked = app.isochrones.includes(Number(input.value));
  const background = params.get("fond");
  app.showBasemap = background !== "0";
  if (background in PROVIDERS) app.provider = background;
  const opacity = Number(params.get("opacite"));
  if (params.has("opacite") && opacity >= 20 && opacity <= 100) app.heatOpacity = opacity / 100;
  $("basemapToggle").checked = app.showBasemap;
  app.showNetwork = params.get("lignes") !== "0";
  $("networkToggle").checked = app.showNetwork;
  syncOpacityControl();
  updateLegend();

  const from = parsePair(params.get("from"));
  if (!from || !setFrom(from, null, { quiet: true })) {
    setFrom(toWorld(DEFAULT_FROM.lat, DEFAULT_FROM.lon), DEFAULT_FROM.label, { quiet: true });
  }
  const to = parsePair(params.get("to"));
  if (to && setTo(to, null, { quiet: true }) && params.get("carte") === "arrivee") setHeatFrom("to");
}

function toast(message, duration = 2200) {
  const element = $("toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, duration);
}

// --- Interactions sur la carte ----------------------------------------------

function eventPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function pointerKind(event) {
  return event.pointerType === "mouse" ? "mouse" : "touch";
}

function markerAt(screen, kind = "mouse") {
  for (const key of ["to", "from"]) {
    if (app[key] && hypot(screen, project(app[key].point)) <= MARKER_HIT_RADIUS[kind]) return key;
  }
  return null;
}

canvas.addEventListener("pointerdown", (event) => {
  const screen = eventPoint(event);
  app.pointers.set(event.pointerId, screen);
  canvas.setPointerCapture(event.pointerId);
  if (app.pointers.size === 2) {
    const [a, b] = [...app.pointers.values()];
    app.drag = { kind: "pinch", distance: hypot(a, b) };
    return;
  }
  const pointer = pointerKind(event);
  const marker = markerAt(screen, pointer);
  app.drag = marker
    ? { kind: "marker", marker, start: screen, moved: false, slop: CLICK_SLOP[pointer] }
    : { kind: "pan", start: screen, last: screen, moved: false, slop: CLICK_SLOP[pointer] };
  // Saisir un marqueur recentre la heatmap sur lui, comme sur la version parisienne.
  if (marker && marker !== app.heatFrom) setHeatFrom(marker);
});

canvas.addEventListener("pointermove", (event) => {
  const screen = eventPoint(event);
  if (app.pointers.has(event.pointerId)) app.pointers.set(event.pointerId, screen);
  const drag = app.drag;

  if (!drag) {
    const place = event.pointerType === "mouse" && !markerAt(screen) ? placeAt(screen) : null;
    canvas.classList.toggle("over-marker", Boolean(markerAt(screen)));
    canvas.classList.toggle("over-foyer", place !== null);
    setHoverPlace(place);
    if (event.pointerType === "mouse") setHoverStop(place === null ? stopAt(screen) : null);
    return;
  }
  setHoverStop(null);
  setHoverPlace(null);
  if (drag.kind === "pinch" && app.pointers.size === 2) {
    const [a, b] = [...app.pointers.values()];
    const distance = hypot(a, b);
    zoomAt(distance / drag.distance, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    drag.distance = distance;
  } else if (drag.kind === "marker") {
    // Petit tremblement pendant un clic : le marqueur ne bouge pas.
    if (!drag.moved && hypot(screen, drag.start) < drag.slop) return;
    drag.moved = true;
    const world = unproject(...screen);
    if (drag.marker === "from") setFrom(world, null, { quiet: true, fast: true });
    else setTo(world, null, { quiet: true, fast: true });
  } else if (drag.kind === "pan") {
    if (!drag.moved && hypot(screen, drag.start) < drag.slop) return;
    drag.moved = true;
    canvas.classList.add("panning");
    app.view.cx -= (screen[0] - drag.last[0]) / app.view.scale;
    app.view.cy += (screen[1] - drag.last[1]) / app.view.scale;
    drag.last = screen;
    requestRender();
  }
});

function setHoverStop(index) {
  if (index === app.hoverStop) return;
  app.hoverStop = index;
  requestRender();
}

function setHoverPlace(key) {
  if (key === app.tool.hover) return;
  app.tool.hover = key;
  requestRender();
}

canvas.addEventListener("pointerleave", () => {
  setHoverStop(null);
  setHoverPlace(null);
});

function endPointer(event) {
  app.pointers.delete(event.pointerId);
  const drag = app.drag;
  if (!drag) return;
  if (drag.kind === "pinch") {
    if (!app.pointers.size) app.drag = null;
    return;
  }
  app.drag = null;
  canvas.classList.remove("panning");
  if (event.type === "pointercancel") return;
  if (drag.kind === "pan" && !drag.moved) {
    // Un clic sur un foyer ou un point de vente affiche (ou retire) son étiquette, sans poser d'arrivée.
    const place = placeAt(eventPoint(event), pointerKind(event));
    if (place?.startsWith("v")) {
      // Point de vente : choisi dans le menu (carte et comptes depuis lui) ; il devient le carré vert du départ,
      // et les autres reprennent leur taille normale.
      for (const key of [...app.tool.selected]) if (key.startsWith("v")) app.tool.selected.delete(key);
      activateVente(app.tool.ventes[Number(place.slice(1))].id);
      return;
    }
    if (place !== null) {
      // Foyer : la carte part de lui (un second clic le quitte, le départ reste à sa place).
      const index = Number(place.slice(1));
      if (app.tool.focus === index) {
        app.tool.focus = null;
        updatePanel();
        requestRender();
      } else {
        focusFoyer(index);
      }
      return;
    }
    if (!setTo(unproject(...eventPoint(event)))) toast("Ce point est hors de la Métropole ou sur l'eau.");
  } else if (drag.kind === "marker" && !drag.moved) {
    // Clic sur le départ posé sur un foyer choisi : on quitte ce foyer (le départ reste à sa place).
    if (drag.marker === "from" && app.tool.focus !== null) {
      app.tool.focus = null;
      updatePanel();
      requestRender();
    }
  } else if (drag.kind === "marker") {
    recompute();
    syncUrl();
  }
}

canvas.addEventListener("dblclick", (event) => {
  if (markerAt(eventPoint(event)) === "to") removeTo();
});

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const [x, y] = eventPoint(event);
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018)), x, y);
  },
  { passive: false },
);

// --- Résultats r5py (fichiers locaux) -------------------------------------------
// Les fichiers du dossier sortie/ de r5_isochrones.py sont lus par le navigateur (FileReader) : rien n'est envoyé.

/** CSV écrit par pandas (séparateur « ; » ou « , », champs entre guillemets possibles) → objets. */
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r\n|\n|\r/, 1)[0];
  const sep = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const header = (rows.shift() ?? []).map((name) => name.trim().toLowerCase());
  return rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(header.map((name, i) => [name, (values[i] ?? "").trim()])));
}

/** Grille r5py → grille de la carte (mêmes champs que computeGrid, plus son emprise). */
function r5Grid(raw) {
  const { colonnes: cols, rangs: rows, pas, origine } = raw;
  const times = Float32Array.from(raw.minutes, (value) => (value < 0 ? NaN : value));
  // Même enjambement des étangs que la carte (WATER_BRIDGE_CELLS cases de 200 m), à l'échelle de la grille r5py.
  const passes = Math.max(1, Math.round((WATER_BRIDGE_CELLS * 200) / pas));
  const bridged = fillGaps(times, cols, rows, passes);
  return {
    times,
    smooth: smoothGrid(bridged, cols, rows),
    cols,
    rows,
    contours: {},
    bounds: [origine[0], origine[1], origine[0] + cols * pas, origine[1] + rows * pas],
  };
}

const R5_MODES = { tc: "Marche + transports en commun", voiture: "Voiture", velo: "Vélo" };

/** Grille de la référence active dans le mode choisi (absente en voiture pour une référence sans parking). */
function r5CurrentGrid() {
  return app.r5.grids.get(`${app.r5.active}|${app.mode}`) ?? null;
}

/** Temps r5py (minutes) de la référence active vers un point, d'après sa grille ; null hors grille ou inaccessible. */
function r5TimeAt(point) {
  const raw = r5CurrentGrid();
  if (!raw) return null;
  const col = Math.floor((point[0] - raw.origine[0]) / raw.pas);
  const row = Math.floor((point[1] - raw.origine[1]) / raw.pas);
  if (col < 0 || row < 0 || col >= raw.colonnes || row >= raw.rangs) return null;
  const value = raw.minutes[row * raw.colonnes + col];
  return value < 0 ? null : value;
}

/** Temps vers un point de la base : la matrice si elle est chargée (temps exact au point), sinon la grille. */
function r5PointTime(point) {
  if (!r5CurrentGrid()) return null;
  const key = `${app.r5.active}|${app.mode}|${point.id}`;
  if (app.r5.matrix.has(key)) return app.r5.matrix.get(key);
  return r5TimeAt(point.point);
}

/** Grille compressée par r5_isochrones.py (« u8-zlib-base64 » ou « u16le-zlib-base64 ») → temps par case, -1 = sans temps.
    Décompression par le navigateur lui-même (DecompressionStream), sans bibliothèque ni requête. */
async function decodeMinutes(raw) {
  const packed = Uint8Array.from(atob(raw.minutesZ), (char) => char.charCodeAt(0));
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate"));
  const bytes = new DataView(await new Response(stream).arrayBuffer());
  const wide = raw.codage.startsWith("u16");
  const count = bytes.byteLength / (wide ? 2 : 1);
  const minutes = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const value = wide ? bytes.getUint16(2 * i, true) : bytes.getUint8(i);
    minutes[i] = value === raw.vide ? -1 : value;
  }
  return minutes;
}

async function loadR5Files(files) {
  let grids = 0;
  const notes = [];
  for (const file of files) {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".json")) {
      let raw;
      try {
        raw = JSON.parse(text);
      } catch {
        notes.push(`${file.name} : JSON illisible`);
        continue;
      }
      if (!(Array.isArray(raw.minutes) || typeof raw.minutesZ === "string") || !raw.colonnes || !raw.rangs || !raw.pas || !raw.origine) {
        notes.push(`${file.name} : pas une grille r5py`);
        continue;
      }
      if (raw.minutesZ) {
        try {
          raw.minutes = await decodeMinutes(raw);
        } catch (error) {
          notes.push(`${file.name} : grille compressée illisible (${error.message})`);
          continue;
        }
      }
      if (raw.minutes.length !== raw.colonnes * raw.rangs) {
        notes.push(`${file.name} : grille incomplète`);
        continue;
      }
      if (Math.abs(raw.lat0 - app.data.meta.lat0) > 1e-9) {
        notes.push(`${file.name} : repère différent de la carte`);
        continue;
      }
      // Grilles d'avant le mode voiture : sans champ « mode », ce sont des grilles marche + transports en commun.
      raw.mode = raw.mode ?? "tc";
      const reference = String(raw.reference);
      app.r5.grids.set(`${reference}|${raw.mode}`, raw);
      const known = app.r5.refs.get(reference) ?? { adresse: raw.adresse, lat: raw.lat, lon: raw.lon, modes: new Set() };
      known.modes.add(raw.mode);
      app.r5.refs.set(reference, known);
      grids += 1;
      continue;
    }
    const rows = parseCsv(text);
    const columns = new Set(Object.keys(rows[0] ?? {}));
    if (columns.has("fichier") && columns.has("lat")) {
      // geocodage.csv : les points de la base (fichier « pt ») placés par le géocodage.
      app.r5.points = rows
        .filter((row) => row.fichier === "pt" && row.lat && row.lon)
        .map((row) => ({
          id: row.id,
          label: row.adresse || row.id,
          point: toWorld(Number(row.lat), Number(row.lon)),
          // Colonne personnes (nb_personne de points.csv : personnes du foyer) ; absente des anciens fichiers.
          personnes: row.personnes === undefined || row.personnes === "" ? null : Number(row.personnes.replace(",", ".")),
        }));
      notes.push(`${app.r5.points.length} foyers`);
    } else if (columns.has("reference") && columns.has("point") && columns.has("minutes")) {
      app.r5.matrix = new Map(
        // Colonne « mode » absente (matrice d'avant le mode voiture) : marche + transports en commun.
        rows.map((row) => [`${row.reference}|${row.mode || "tc"}|${row.point}`, row.minutes === "" ? null : Number(row.minutes)]),
      );
      notes.push("matrice");
    } else {
      notes.push(`${file.name} : fichier non reconnu`);
    }
  }
  if (grids) notes.unshift(`${grids} grille${grids > 1 ? "s" : ""}`);
  else if (!app.r5.grids.size) notes.push("aucune grille : ajoutez les fichiers .json de sortie/grilles (ou choisissez le dossier sortie)");
  fillR5Select();
  if (!app.r5.active && app.r5.refs.size) activateR5(app.r5.refs.keys().next().value);
  else if (app.r5.active) {
    updatePanel();
    requestRender();
  }
  toast(`Chargé : ${notes.join(", ") || "rien"}`, 7000);
}

function fillR5Select() {
  const select = $("r5Reference");
  const options = [new Option("Carte du site (sans r5py)", "")];
  for (const [id, ref] of app.r5.refs) {
    const name = ref.adresse && ref.adresse !== id ? `${id} · ${ref.adresse}` : id;
    options.push(new Option(ref.modes.has("voiture") ? `${name} · parking` : name, id));
  }
  select.replaceChildren(...options);
  select.value = app.r5.active ?? "";
  select.hidden = !app.r5.refs.size;
}

/** Recalcule la grille affichée pour la référence et le mode choisis (aucune en voiture sans parking). */
function refreshR5Grid() {
  const raw = r5CurrentGrid();
  app.r5.grid = raw ? r5Grid(raw) : null;
}

function activateR5(id) {
  const ref = app.r5.refs.get(id);
  if (!ref) return;
  if (app.tool.active) leaveTool();
  app.r5.active = id;
  refreshR5Grid();
  app.from = { point: toWorld(ref.lat, ref.lon), label: ref.adresse || id };
  app.to = null;
  app.solution = null;
  app.heatSolution = null;
  app.heatFrom = "from";
  $("r5Reference").value = id;
  recompute();
  syncUrl();
}

function leaveR5() {
  app.r5.active = null;
  app.r5.grid = null;
  $("r5Reference").value = "";
}

function updateR5Panel() {
  const raw = r5CurrentGrid();
  $("tripResult").hidden = true;
  $("tripHint").hidden = true;
  const parts = [];
  const line = (text, className) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    parts.push(p);
  };
  line(R5_MODES[app.mode], "trip-eyebrow");
  if (!raw) {
    line(
      app.mode === "voiture"
        ? "Pas de calcul en voiture pour cette référence : elle n'a pas de parking (colonne parking de references.csv)."
        : `Pas de calcul « ${R5_MODES[app.mode]} » pour cette référence dans les fichiers chargés (relancer r5_isochrones.py).`,
      "r5-source",
    );
    $("r5Info").replaceChildren(...parts);
    return;
  }
  if (app.mode === "voiture") {
    line(`Temps en voiture, circulation fluide, + ${raw.voitureExtremites ?? 0} min pour rejoindre sa voiture, se garer et marcher.`, "r5-source");
  } else if (app.mode === "velo") {
    const stress = raw.stressVelo ? `, rues de stress ≤ ${raw.stressVelo} (sinon vélo poussé à pied)` : "";
    line(`Temps à vélo, ${raw.vitesseVelo ?? 12} km/h${stress}, + ${raw.veloExtremites ?? 0} min pour sortir, garer son vélo et marcher.`, "r5-source");
  } else {
    line(`Temps porte à porte r5py, le ${raw.jour.slice(6)}/${raw.jour.slice(4, 6)}, départs ${raw.plage}.`, "r5-source");
  }
  if (app.to) {
    const minutes = r5TimeAt(app.to.point);
    line("Point cliqué", "trip-eyebrow");
    line(minutes === null ? "Inaccessible" : formatMinutes(minutes), "r5-time");
  } else {
    line("Cliquez sur la carte pour lire un temps.", "trip-hint");
  }
  const points = app.r5.points;
  if (points.length) {
    const thresholds = app.isochrones.length ? [...app.isochrones].sort((a, b) => a - b) : [app.maxMinutes];
    const times = points.map(r5PointTime);
    const list = document.createElement("ul");
    list.className = "r5-counts";
    for (const threshold of thresholds) {
      const inside = points.filter((_, i) => times[i] !== null && times[i] <= threshold);
      const count = inside.length;
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `≤ ${threshold} min`;
      const value = document.createElement("strong");
      value.textContent = `${count} / ${points.length} foyers`;
      if (points.some((point) => point.personnes !== null)) {
        const sum = (list) => list.reduce((total, point) => total + (point.personnes ?? 0), 0);
        const format = (x) => x.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
        value.textContent += ` · ${format(sum(inside))} / ${format(sum(points))} personnes`;
      }
      item.append(label, value);
      list.append(item);
    }
    line("Foyers dans l'isochrone", "trip-eyebrow");
    parts.push(list);
    const exact = points.every((point) => app.r5.matrix.has(`${app.r5.active}|${app.mode}|${point.id}`));
    line(exact ? "D'après matrice.csv (temps exacts aux adresses)." : "D'après la grille (chargez matrice.csv pour les temps exacts).", "r5-source");
  } else {
    line("Chargez geocodage.csv pour afficher et compter les foyers.", "r5-source");
  }
  $("r5Info").replaceChildren(...parts);
}

function drawR5Points() {
  if (!app.r5.active || !app.r5.points.length) return;
  const labels = app.view.scale > STOP_LABEL_SCALE;
  for (const point of app.r5.points) {
    const [x, y] = project(point.point);
    if (x < -20 || y < -20 || x > app.size.width + 20 || y > app.size.height + 20) continue;
    const time = r5PointTime(point);
    const inside = time !== null && time <= app.maxMinutes;
    const [r, g, b] = inside ? paletteColor(time / app.maxMinutes) : [150, 150, 150];
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#111";
    ctx.stroke();
    if (labels) {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const text = time === null ? point.id : `${point.id} · ${formatMinutes(time)}`;
      drawHaloText(text, x + 9, y, { font: "600 11px Inter, sans-serif", color: "#111" });
    }
  }
}

/** Dans un dossier sortie/ choisi en entier, seuls les résultats sont lus (pas l'extrait OSM ni le GTFS en cache). */
function isR5Result(file) {
  const path = (file.webkitRelativePath || file.name).replaceAll("\\", "/").toLowerCase();
  const name = path.split("/").pop();
  return (name.endsWith(".json") && path.includes("grilles/")) || name === "geocodage.csv" || name === "matrice.csv";
}

for (const id of ["r5Files", "r5Folder"]) {
  $(id).addEventListener("change", async (event) => {
    const all = [...event.target.files];
    const files = id === "r5Folder" ? all.filter(isR5Result) : all;
    event.target.value = ""; // pour pouvoir recharger les mêmes fichiers
    if (!files.length) {
      toast(all.length ? "Aucun résultat r5py dans ce dossier (grilles/*.json, geocodage.csv, matrice.csv)." : "Aucun fichier reçu.", 7000);
      return;
    }
    toast(`Lecture de ${files.length} fichier${files.length > 1 ? "s" : ""}…`);
    try {
      await loadR5Files(files);
    } catch (error) {
      console.error(error);
      toast(`Lecture impossible : ${error.message}`, 7000);
    }
  });
}

function setModeControls(mode) {
  app.mode = mode;
  $("modeSelect").value = mode;
  // Tram et bus ne servent qu'au mode marche + transports en commun.
  $("busToggle").disabled = mode !== "tc";
  $("busToggle").closest("label").classList.toggle("is-disabled", mode !== "tc");
  $("tramToggle").closest("label").classList.toggle("is-disabled", mode !== "tc");
}

$("modeSelect").addEventListener("change", (event) => {
  setModeControls(event.target.value);
  if (app.r5.active) refreshR5Grid();
  recompute();
  noParkingNotice();
  syncUrl();
});

$("r5Reference").addEventListener("change", (event) => {
  if (event.target.value) {
    activateR5(event.target.value);
  } else {
    leaveR5();
    recompute();
    syncUrl();
  }
});

// --- Commandes ----------------------------------------------------------------

$("zoomIn").addEventListener("click", () => zoomAt(1.4, app.size.width / 2, app.size.height / 2));
$("zoomOut").addEventListener("click", () => zoomAt(1 / 1.4, app.size.width / 2, app.size.height / 2));
$("recenter").addEventListener("click", () => {
  fitView();
  requestRender();
});
// L'iPhone ne sait pas passer un élément de page en plein écran : on masque le bouton.
$("fullscreen").hidden = !document.fullscreenEnabled;
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.();
});

$("busToggle").addEventListener("change", (event) => {
  app.includeBus = event.target.checked;
  recompute();
  syncUrl();
});

function isochronesChanged() {
  app.isochrones = [...$("isoToggles").querySelectorAll("input[type=checkbox]:checked")].map((input) => Number(input.value));
  if (app.r5.active || app.tool.active || app.tool.foyers.length) updatePanel(); // comptes de foyers par isochrone
  requestRender();
  syncUrl();
}

/** Ajoute (ou coche) l'isochrone `value` minutes ; les valeurs ajoutées ont un bouton pour les retirer. */
function addIsochrone(value, { quiet = false } = {}) {
  const container = $("isoToggles");
  const existing = container.querySelector(`input[type=checkbox][value="${value}"]`);
  if (existing) {
    existing.checked = true;
  } else {
    const label = document.createElement("label");
    label.className = "pill-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = String(value);
    input.checked = true;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pill-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Retirer l'isochrone ${value} min`);
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      label.remove();
      isochronesChanged();
    });
    label.append(input, ` ${value} min`, remove);
    // Rangée dans l'ordre des valeurs, avant le champ « Autre ».
    const next = [...container.querySelectorAll("label.pill-toggle")].find((other) => Number(other.querySelector("input").value) > value);
    container.insertBefore(label, next ?? $("isoCustom"));
  }
  if (!quiet) isochronesChanged();
}

$("isoToggles").addEventListener("change", (event) => {
  if (event.target.type === "checkbox") isochronesChanged();
});

$("isoCustom").addEventListener("submit", (event) => {
  event.preventDefault();
  const field = $("isoCustomValue");
  const value = Number(field.value);
  if (!Number.isInteger(value) || value < ISO_MIN || value > ISO_MAX) {
    toast(`Une isochrone va de ${ISO_MIN} à ${ISO_MAX} minutes, en minutes entières.`);
    return;
  }
  field.value = "";
  addIsochrone(value);
});

$("maxRange").addEventListener("input", (event) => {
  app.maxMinutes = Number(event.target.value);
  updateLegend();
  if (app.grid) paintHeat(app.grid);
  if (app.r5.active) updatePanel();
  requestRender();
  syncUrl();
});

function syncOpacityControl() {
  const percent = Math.round(heatAlpha() * 100);
  $("heatOpacity").value = String(percent);
  $("heatOpacityValue").textContent = `${percent} %`;
}

$("basemapToggle").addEventListener("change", (event) => {
  app.showBasemap = event.target.checked;
  syncOpacityControl();
  requestRender();
  syncUrl();
});

$("networkToggle").addEventListener("change", (event) => {
  app.showNetwork = event.target.checked;
  app.hoverStop = null;
  requestRender();
  syncUrl();
});

$("heatOpacity").addEventListener("input", (event) => {
  app.heatOpacity = Number(event.target.value) / 100;
  syncOpacityControl();
  requestRender();
  syncUrl();
});

$("removeTo").addEventListener("click", removeTo);
$("heatFrom").addEventListener("click", (event) => {
  const source = event.target.closest("button")?.dataset.source;
  if (source && source !== app.heatFrom) {
    setHeatFrom(source);
    syncUrl();
  }
});

// --- Vos données : foyers et points de vente importés, calculés dans la page ---------
// Les fichiers sont lus par le navigateur (rien n'est envoyé) ; les adresses sont géocodées avec l'index local ;
// les temps sont gardés dans le navigateur (IndexedDB), par position : réimporter des fichiers mis à jour ne
// recalcule que les nouveaux lieux.

function ensureAddresses() {
  if (app.addresses) return Promise.resolve(app.addresses);
  app.addressesLoading ??= loadAddresses(ADDRESSES_URL)
    .then((index) => (app.addresses = index))
    .catch((error) => {
      app.addressesLoading = null;
      throw error;
    });
  return app.addressesLoading;
}

/** Texte d'un fichier CSV, en UTF-8 ou, à défaut, en Windows-1252 (CSV enregistrés par Excel en français). */
async function readText(file) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// Noms de colonnes acceptés (minuscules), comme r5_isochrones.py.
const TOOL_COLUMNS = {
  id: ["id", "name", "nom", "identifiant"],
  adresse: ["adresse", "adresses", "address", "result_label", "label"],
  lat: ["lat", "latitude"],
  lon: ["lon", "lng", "longitude"],
  personnes: ["nb_personne", "nb_personnes", "personnes"],
};
const column = (row, name) => TOOL_COLUMNS[name].map((key) => row[key]).find((value) => value) ?? "";
const number = (text) => Number(String(text).replace(",", "."));
const placeKey = (point) => `${point[0].toFixed(1)},${point[1].toFixed(1)}`;

/** Lieux d'un fichier importé, géocodés ; le compte rendu va dans app.tool.report. */
async function readPlaces(file, kind) {
  const rows = parseCsv(await readText(file));
  if (!rows.length) throw new Error(`${file.name} : aucune ligne`);
  const index = await ensureAddresses();
  const places = [];
  const report = [];
  rows.forEach((row, i) => {
    const id = column(row, "id") || `${kind === "foyers" ? "F" : "V"}${i + 1}`;
    const address = column(row, "adresse");
    const lat = column(row, "lat");
    const lon = column(row, "lon");
    let found;
    if (lat && lon && Number.isFinite(number(lat)) && Number.isFinite(number(lon))) {
      found = { point: toWorld(number(lat), number(lon)), qualite: "coordonnées fournies", trouve: "" };
    } else if (address) {
      found = index.geocode(address);
    } else {
      found = { point: null, qualite: "ni adresse ni coordonnées", trouve: "" };
    }
    if (found.point && !isOnLand(found.point)) found = { point: null, qualite: "hors de la Métropole", trouve: found.trouve };
    report.push({ fichier: kind === "foyers" ? "foyer" : "point de vente", id, adresse: address, qualite: found.qualite, trouve: found.trouve });
    if (!found.point) return;
    const people = column(row, "personnes");
    places.push({
      id,
      label: address || id,
      point: found.point,
      key: placeKey(found.point),
      personnes: people === "" ? 1 : number(people),
      parking: ["oui", "o", "yes", "y", "1", "vrai", "true"].includes((row.parking ?? "").toLowerCase()),
    });
  });
  const bad = places.filter((place) => !Number.isFinite(place.personnes));
  if (bad.length) throw new Error(`${file.name} : nombre de personnes illisible (${bad[0].id})`);
  return { places, report };
}

// Mémoire des calculs : une base IndexedDB, clé « modèle|mode|point de vente » → { position du foyer: minutes }.
const toolDb = (() => {
  let opening = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("porte-a-porte", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("temps");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("temps", mode);
      const request = action(transaction.objectStore("temps"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
    });
  };
  return {
    get: (key) => run("readonly", (store) => store.get(key)),
    put: (key, value) => run("readwrite", (store) => store.put(value, key)),
    entries: async () => {
      const keys = await run("readonly", (store) => store.getAllKeys());
      const values = await run("readonly", (store) => store.getAll());
      return keys.map((key, i) => [key, values[i]]);
    },
  };
})();

/** Minutes du point de vente vers chaque foyer, dans un mode (NaN : inaccessible ou au-delà de 90 min). */
function computeTimes(vente, mode, foyers) {
  const out = new Float32Array(foyers.length).fill(NaN);
  if (mode === "tc") {
    // Toutes les destinations préparées d'un coup (foyers puis cases de la carte) : un seul calcul par point de vente.
    const all = app.transit.solve(vente.point, app.tool.targets);
    const index = new Map(app.tool.foyers.map((foyer, i) => [foyer.key, i]));
    foyers.forEach((foyer, i) => {
      out[i] = all[index.get(foyer.key)];
    });
    app.tool.grids.set(`${vente.id}|tc`, all.slice(app.tool.foyers.length));
  } else {
    const solution = app.roads.solve(mode, vente.point, { maxMinutes: TOOL_MAX_MINUTES + 5 });
    foyers.forEach((foyer, i) => {
      out[i] = app.roads.minutesTo(solution, foyer.point) ?? NaN;
    });
  }
  return out.map((minutes) => (minutes <= TOOL_MAX_MINUTES ? minutes : NaN));
}

const toolModes = (vente) => (vente.parking ? ["tc", "velo", "voiture"] : ["tc", "velo"]);
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Calcule ce qui manque (foyers × points de vente × modes), en reprenant la mémoire du navigateur. */
async function runTool({ only = null } = {}) {
  const { foyers } = app.tool;
  const ventes = only ?? app.tool.ventes;
  if (!foyers.length || !ventes.length || app.tool.busy) return;
  app.tool.busy = true;
  try {
    await ensureRoads();
    if (!app.transit) {
      toast("Chargement des horaires…", 30000);
      await nextFrame();
      app.transit = await loadTransit(HORAIRES_URL, app.roads.walk);
    }
    if (!app.tool.targets) {
      toast("Préparation des trajets à pied vers les foyers…", 30000);
      await nextFrame();
      app.tool.targets = app.transit.prepareTargets([...foyers.map((foyer) => foyer.point), ...app.data.cells.map((cell) => cell.point)]);
    }
    const jobs = ventes.flatMap((vente) => toolModes(vente).map((mode) => [vente, mode]));
    let reused = 0;
    let computed = 0;
    for (const [n, [vente, mode]] of jobs.entries()) {
      const key = `${TOOL_MODEL}|${mode}|${vente.key}`;
      const saved = (await toolDb.get(key).catch(() => null)) ?? {};
      const gridKey = `${TOOL_MODEL}|grille|${vente.key}`;
      if (mode === "tc" && !app.tool.grids.has(`${vente.id}|tc`)) {
        const grid = await toolDb.get(gridKey).catch(() => null);
        if (grid) app.tool.grids.set(`${vente.id}|tc`, Float32Array.from(grid, (value) => value ?? NaN));
      }
      // En transports en commun, la grille de la carte se calcule avec les foyers : refaite si elle manque.
      const missing = mode === "tc" && !app.tool.grids.has(`${vente.id}|tc`) ? foyers : foyers.filter((foyer) => !(foyer.key in saved));
      if (missing.length) {
        toast(`Calcul ${n + 1} / ${jobs.length} : ${vente.id}, ${MODE_LABELS[mode]}…`, 60000);
        await nextFrame();
        const minutes = computeTimes(vente, mode, missing);
        missing.forEach((foyer, i) => {
          saved[foyer.key] = Number.isNaN(minutes[i]) ? null : Math.round(minutes[i] * 10) / 10;
        });
        await toolDb.put(key, saved).catch((error) => console.warn("Mémoire du navigateur indisponible", error));
        if (mode === "tc") {
          const grid = Array.from(app.tool.grids.get(`${vente.id}|tc`), (value) => (Number.isNaN(value) ? null : value));
          await toolDb.put(gridKey, grid).catch(() => {});
        }
        computed += missing.length;
      }
      reused += foyers.length - missing.length;
      app.tool.times.set(
        `${vente.id}|${mode}`,
        Float32Array.from(foyers, (foyer) => saved[foyer.key] ?? NaN),
      );
    }
    toast(
      computed
        ? `Calculs terminés : ${computed} temps calculés, ${reused} repris de la mémoire du navigateur.`
        : `Tous les temps (${reused}) étaient déjà en mémoire.`,
      5000,
    );
  } catch (error) {
    console.error(error);
    toast(`Calcul impossible : ${error.message}`, 8000);
  } finally {
    app.tool.busy = false;
    fillVenteSelect();
    updatePanel();
    requestRender();
  }
}

async function importPlaces(file, kind) {
  try {
    toast(`Lecture de ${file.name}…`, 30000);
    const { places, report } = await readPlaces(file, kind);
    // Les points de vente ajoutés à la main restent, après ceux du fichier (identifiants rendus uniques).
    const manual = kind === "ventes" ? app.tool.ventes.filter((vente) => vente.manual) : [];
    const ids = new Set(places.map((place) => place.id));
    for (const vente of manual) vente.id = uniqueVenteId(vente.name, ids);
    app.tool[kind] = [...places, ...manual];
    if (kind === "foyers") {
      app.tool.targets = null;
      app.tool.live = null;
      app.tool.focus = null;
    }
    // Les indices changent : étiquettes affichées de ce fichier retirées.
    const prefix = kind === "foyers" ? "f" : "v";
    app.tool.hover = null;
    for (const key of [...app.tool.selected]) if (key.startsWith(prefix)) app.tool.selected.delete(key);
    app.tool.grids.clear();
    const label = kind === "foyers" ? "foyers" : "points de vente";
    app.tool.report = [
      ...app.tool.report.filter((row) => row.fichier !== (kind === "foyers" ? "foyer" : "point de vente")),
      ...report,
    ];
    app.tool.times.clear();
    app.tool.active = null;
    const missing = report.length - places.length;
    const placed = `${places.length} ${label} placés${missing ? `, ${missing} non trouvés (voir « Contrôle des adresses »)` : ""}.`;
    fillVenteSelect();
    // Les foyers s'affichent tout de suite, comptés dans les isochrones de la carte en cours.
    updatePanel();
    requestRender();
    if (app.tool.foyers.length && app.tool.ventes.length) {
      toast(placed, 4000);
      await runTool();
    } else {
      toast(`${placed} Importez aussi les ${kind === "foyers" ? "points de vente" : "foyers"}.`, 8000);
    }
  } catch (error) {
    console.error(error);
    toast(`Lecture impossible : ${error.message}`, 8000);
  }
}

/** Identifiant libre, à partir du nom (« Nom », puis « Nom (2) »…). */
function uniqueVenteId(name, taken = new Set(app.tool.ventes.map((vente) => vente.id))) {
  let id = name;
  for (let n = 2; taken.has(id); n += 1) id = `${name} (${n})`;
  taken.add(id);
  return id;
}

/**
 * Point de vente saisi à la main : géocodé dans la page (adresse, ou « latitude, longitude »), ajouté à la liste,
 * puis calculé seul (marche + TC, vélo, voiture s'il a un parking) et affiché avec ses isochrones.
 */
async function addVente(name, address, parking) {
  if (app.tool.busy) {
    toast("Un calcul est déjà en cours : réessayez dans un instant.", 5000);
    return false;
  }
  const pair = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(address);
  let found;
  if (pair) {
    found = { point: toWorld(number(pair[1]), number(pair[2])), qualite: "coordonnées fournies", trouve: "" };
  } else {
    toast("Recherche de l'adresse…", 20000);
    found = (await ensureAddresses()).geocode(address);
  }
  if (!found.point) {
    toast(`Adresse non trouvée (${found.qualite}). Indiquez le numéro, la voie et le code postal ou la commune.`, 8000);
    return false;
  }
  if (!isOnLand(found.point)) {
    toast("Cette adresse est hors de la Métropole ou sur l'eau.", 7000);
    return false;
  }
  const id = uniqueVenteId(name);
  const vente = { id, name, manual: true, label: address, point: found.point, key: placeKey(found.point), personnes: 1, parking };
  app.tool.ventes.push(vente);
  app.tool.report.push({ fichier: "point de vente", id, adresse: address, qualite: `${found.qualite} (saisi à la main)`, trouve: found.trouve });
  fillVenteSelect();
  activateVente(id); // isochrones de la carte tout de suite, depuis le point de vente
  if (app.tool.foyers.length) {
    await runTool({ only: [vente] });
    if (app.tool.active === id) recompute(); // isochrones et comptes du calcul porte à porte
  } else {
    toast(`${id} ajouté${found.trouve ? ` (${found.trouve})` : ""}. Importez des foyers pour les compter dans ses isochrones.`, 7000);
  }
  return true;
}

function fillVenteSelect() {
  const select = $("venteSelect");
  const ready = app.tool.ventes.length && app.tool.foyers.length && app.tool.times.size;
  // Sans foyers, un point de vente se choisit quand même (isochrones seules).
  select.replaceChildren(
    new Option("Choisir un point de vente…", ""),
    ...app.tool.ventes.map((vente) => new Option(vente.parking ? `${vente.id} · parking` : vente.id, vente.id)),
  );
  select.value = app.tool.active ?? "";
  select.hidden = !app.tool.ventes.length;
  $("exportRecap").hidden = !ready;
  $("exportCheck").hidden = !app.tool.report.length;
}

function activateVente(id) {
  const vente = app.tool.ventes.find((item) => item.id === id);
  if (!vente) return;
  if (app.r5.active) leaveR5();
  app.tool.active = id;
  app.from = { point: vente.point, label: vente.label !== vente.id ? `${vente.id} · ${vente.label}` : vente.id };
  app.to = null;
  app.heatFrom = "from";
  $("venteSelect").value = id;
  recompute();
  noParkingNotice();
}

function activeVente() {
  return app.tool.active ? app.tool.ventes.find((item) => item.id === app.tool.active) ?? null : null;
}

/** Point de vente choisi sans parking, en mode voiture : pas de calcul porte à porte. */
function noParkingShown() {
  const vente = activeVente();
  return Boolean(vente && app.mode === "voiture" && !vente.parking);
}

function noParkingNotice() {
  if (noParkingShown()) {
    toast(`${app.tool.active} n'a pas de parking : pas de calcul en voiture. La carte montre les temps en voiture depuis son adresse, à titre indicatif.`, 8000);
  }
}

function leaveTool() {
  app.tool.active = null;
  $("venteSelect").value = "";
}

function toolTimes() {
  return app.tool.active ? app.tool.times.get(`${app.tool.active}|${app.mode}`) ?? null : null;
}

/** Point de vente choisi en transports en commun, carte partant de lui : la carte vient du calcul porte à porte. */
function toolTransitShown() {
  return Boolean(app.tool.active && app.mode === "tc" && heatSource() === app.from && app.tool.grids.get(`${app.tool.active}|tc`));
}

/**
 * Minutes porte à porte du point de vente choisi vers l'arrivée posée, avec le calcul de ses comptes. Pendant
 * qu'on fait glisser l'arrivée : la valeur de la case de la carte ; au lâcher, le calcul exact (gardé).
 */
function toolArrivalMinutes() {
  if (!app.to) return null;
  if (app.drag?.kind === "marker") {
    const { cols, times } = app.grid;
    const [minX, minY, maxX, maxY] = app.data.meta.bounds;
    const col = Math.floor(((app.to.point[0] - minX) / (maxX - minX)) * cols);
    const row = Math.floor(((app.to.point[1] - minY) / (maxY - minY)) * app.grid.rows);
    const value = col >= 0 && row >= 0 && col < cols && row < app.grid.rows ? times[row * cols + col] : NaN;
    return Number.isFinite(value) ? value : null;
  }
  const vente = app.tool.ventes.find((item) => item.id === app.tool.active);
  const key = `${vente.key}|${placeKey(app.to.point)}`;
  if (!app.tool.arrival || app.tool.arrival.key !== key) {
    const [minutes] = app.transit.solve(vente.point, app.transit.prepareTargets([app.to.point]));
    app.tool.arrival = { key, minutes: Number.isFinite(minutes) ? minutes : null };
  }
  return app.tool.arrival.minutes;
}

/** Tableau des foyers et personnes sous chaque seuil, dans le panneau. */
function toolCountsList(times, thresholds) {
  const { foyers } = app.tool;
  const total = foyers.reduce((sum, foyer) => sum + foyer.personnes, 0);
  const list = document.createElement("ul");
  list.className = "r5-counts";
  const format = (x) => x.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  for (const threshold of thresholds) {
    let count = 0;
    let people = 0;
    foyers.forEach((foyer, i) => {
      if (times[i] <= threshold) {
        count += 1;
        people += foyer.personnes;
      }
    });
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `≤ ${threshold} min`;
    const value = document.createElement("strong");
    value.textContent = `${count} / ${foyers.length} foyers · ${format(people)} / ${format(total)} personnes`;
    item.append(label, value);
    list.append(item);
  }
  return list;
}

/**
 * Minutes vers chaque foyer (NaN : inaccessible) pour la carte affichée. Point de vente choisi, carte partant de lui :
 * le calcul porte à porte (celui du récapitulatif). Sinon : depuis le départ vert (ou l'arrivée, si la carte part
 * d'elle), refait à chaque déplacement, avec le même calcul que la carte.
 */
function foyerTimes() {
  const { foyers } = app.tool;
  if (!foyers.length) return null;
  const tool = heatSource() === app.from ? toolTimes() : null;
  if (tool) return tool;
  const key = `${app.heatVersion}|${app.mode}|${foyers.length}`;
  if (app.tool.live?.key === key) return app.tool.live.times;
  const at = heatMinutesFn();
  if (!at) return null;
  const times = Float32Array.from(foyers, (foyer) => at(foyer.point) ?? NaN);
  app.tool.live = { key, times };
  return times;
}

/** Minutes vers un point quelconque pour la carte affichée (même calcul qu'elle), ou null si rien n'est calculé. */
function heatMinutesFn() {
  if (app.r5.active) return (point) => r5TimeAt(point);
  if (app.mode !== "tc") return app.heatRoad ? (point) => app.roads.minutesTo(app.heatRoad, point) : null;
  return app.heatSolution ? (point) => travelTo(app.heatSolution, point).minutes : null;
}

/** La carte part du foyer cliqué ; les autres foyers sont grisés. */
function focusFoyer(index) {
  const foyer = app.tool.foyers[index];
  if (!foyer) return;
  if (app.r5.active) leaveR5();
  app.to = null;
  app.heatFrom = "from";
  for (const button of $("heatFrom").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.source === "from"));
  }
  if (!setFrom(foyer.point, `Foyer ${foyer.id} · ${formatPeople(foyer.personnes)}`, { quiet: true })) return;
  app.tool.focus = index;
  fillVenteSelect();
  updatePanel();
  requestRender();
}

const formatPeople = (n) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pers.`;

/** Minutes du départ (le foyer) vers un point, avec le calcul de la carte ; null si rien n'est calculé. */
function fromMinutesFn() {
  if (app.mode !== "tc") return app.roadSolution ? (point) => roadMinutesTo(point) : null;
  return app.solution ? (point) => travelTo(app.solution, point).minutes : null;
}

/** Panneau du foyer choisi : points de vente dans chaque isochrone, avec leurs temps. */
function updateFocusPanel() {
  const info = $("r5Info");
  info.hidden = false;
  const foyer = app.tool.foyers[app.tool.focus];
  const parts = [];
  const line = (text, className) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    parts.push(p);
  };
  line(`${R5_MODES[app.mode]} · depuis le foyer ${foyer.id} (${formatPeople(foyer.personnes)})`, "trip-eyebrow");
  const at = fromMinutesFn();
  if (!app.tool.ventes.length) {
    line("Importez des points de vente pour voir ceux qui sont dans les isochrones de ce foyer.", "r5-source");
  } else if (!at) {
    line("Calcul en cours…", "r5-source");
  } else {
    // En voiture, seuls les points de vente avec parking comptent.
    const usable = app.mode === "voiture" ? app.tool.ventes.filter((vente) => vente.parking) : app.tool.ventes;
    const reached = usable
      .map((vente) => ({ vente, minutes: at(vente.point) }))
      .filter((item) => Number.isFinite(item.minutes))
      .sort((a, b) => a.minutes - b.minutes);
    const thresholds = app.isochrones.length ? [...app.isochrones].sort((a, b) => a - b) : [app.maxMinutes];
    line("Points de vente dans l'isochrone", "trip-eyebrow");
    const list = document.createElement("ul");
    list.className = "r5-counts focus-ventes";
    for (const threshold of thresholds) {
      const inside = reached.filter((item) => item.minutes <= threshold);
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `≤ ${threshold} min`;
      const value = document.createElement("div");
      const count = document.createElement("strong");
      count.textContent = `${inside.length} / ${usable.length} point${usable.length > 1 ? "s" : ""} de vente`;
      value.append(count);
      if (inside.length) {
        const names = document.createElement("ol");
        for (const { vente, minutes } of inside) {
          const name = document.createElement("li");
          name.textContent = `${vente.id} · ${formatMinutes(minutes)}`;
          names.append(name);
        }
        value.append(names);
      }
      item.append(label, value);
      list.append(item);
    }
    parts.push(list);
    const skipped = app.tool.ventes.length - usable.length;
    if (skipped) line(`${skipped} point${skipped > 1 ? "s" : ""} de vente sans parking non compté${skipped > 1 ? "s" : ""} en voiture.`, "r5-source");
    line("Même calcul que la carte, du foyer vers les points de vente. Cliquez à nouveau le foyer pour le quitter.", "r5-source");
  }
  info.replaceChildren(...parts);
}

function updateToolPanel() {
  if (app.tool.focus !== null && app.tool.foyers[app.tool.focus]) {
    updateFocusPanel();
    return;
  }
  const info = $("r5Info");
  info.hidden = false;
  const parts = [];
  const line = (text, className) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    parts.push(p);
  };
  const vente = app.tool.ventes.find((item) => item.id === app.tool.active);
  const doorToDoor = Boolean(vente && heatSource() === app.from);
  const times = doorToDoor ? toolTimes() : foyerTimes();
  line(
    vente ? `${R5_MODES[app.mode]} · calcul dans la page` : `${R5_MODES[app.mode]} · ${app.tool.foyers.length} foyers importés`,
    "trip-eyebrow",
  );
  if (noParkingShown()) {
    line(
      `🚗 ${vente.id} n'a pas de parking (colonne parking) : pas de calcul porte à porte en voiture, ni de comptes. ` +
        "La carte montre les temps en voiture depuis son adresse, à titre indicatif.",
      "r5-warning",
    );
  }
  if (!app.tool.foyers.length) {
    line("Importez des foyers pour les compter dans les isochrones.", "r5-source");
  } else if (!times) {
    if (!noParkingShown()) line("Calcul en cours…", "r5-source");
  } else {
    const thresholds = app.isochrones.length ? [...app.isochrones].sort((a, b) => a - b) : [app.maxMinutes];
    line(heatSource() === app.from ? "Foyers dans l'isochrone du départ" : "Foyers dans l'isochrone de l'arrivée", "trip-eyebrow");
    parts.push(toolCountsList(times, thresholds));
    if (doorToDoor) {
      line(
        app.mode === "tc"
          ? "Marche par les rues et horaires TaM, médiane des départs de 7 h à 20 h (méthode de r5py)."
          : `${ROAD_MODES[app.mode].label} : ${ROAD_MODES[app.mode].describe}.`,
        "r5-source",
      );
    } else {
      line("Même calcul que la carte, refait à chaque déplacement du point. Survolez ou cliquez un foyer ou un point de vente pour son étiquette.", "r5-source");
    }
  }
  info.replaceChildren(...parts);
}

/** Point de vente (« v2 ») ou foyer (« f3 ») sous le pointeur, ou null ; les points de vente d'abord (dessinés dessus). */
function placeAt(screen, kind = "mouse") {
  const radius = kind === "mouse" ? 8 : 14;
  for (const [prefix, list] of [["v", app.tool.ventes], ["f", app.tool.foyers]]) {
    let best = null;
    let bestDistance = radius;
    list.forEach((place, i) => {
      const distance = hypot(screen, project(place.point));
      if (distance < bestDistance) {
        best = `${prefix}${i}`;
        bestDistance = distance;
      }
    });
    if (best !== null) return best;
  }
  return null;
}

function drawFoyers() {
  const { foyers, hover, selected } = app.tool;
  if (!foyers.length) return;
  const times = foyerTimes();
  const focused = app.tool.focus !== null;
  const shown = (i) => hover === `f${i}` || selected.has(`f${i}`);
  const dot = (foyer, i, big) => {
    const [x, y] = project(foyer.point);
    if (x < -20 || y < -20 || x > app.size.width + 20 || y > app.size.height + 20) return null;
    const time = times ? times[i] : NaN;
    const inside = time <= app.maxMinutes;
    const [r, g, b] = inside ? paletteColor(time / app.maxMinutes) : [150, 150, 150];
    // Foyer choisi : les autres sont gris et en partie transparents (sauf celui survolé).
    const faded = focused && !big;
    ctx.beginPath();
    ctx.arc(x, y, big ? 5.5 : 3.6, 0, Math.PI * 2);
    ctx.fillStyle = faded ? "rgba(150, 150, 150, 0.35)" : `rgb(${r}, ${g}, ${b})`;
    ctx.fill();
    ctx.lineWidth = big ? 1.8 : 1.1;
    ctx.strokeStyle = faded ? "rgba(40, 40, 40, 0.3)" : "#111";
    ctx.stroke();
    return [x, y, time];
  };
  foyers.forEach((foyer, i) => {
    if (!shown(i) && i !== app.tool.focus) dot(foyer, i, false); // le foyer choisi : sous le marqueur du départ
  });
  // Foyers survolés ou cliqués : par-dessus les autres, avec leur étiquette.
  foyers.forEach((foyer, i) => {
    if (!shown(i) || i === app.tool.focus) return;
    const drawn = dot(foyer, i, true);
    if (!drawn) return;
    const [x, y, time] = drawn;
    const people = `${foyer.personnes.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} pers.`;
    const minutes = times ? (Number.isFinite(time) ? formatMinutes(time) : "inaccessible") : null;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    drawHaloText([foyer.id, people, minutes].filter(Boolean).join(" · "), x + 9, y, {
      font: "600 12px Inter, sans-serif",
      color: "#111",
    });
  });
}

/** Points de vente : petits carrés violets, toujours affichés ; étiquette au survol ou au clic (nom, parking, temps). */
function drawVentes() {
  const { ventes, hover, selected } = app.tool;
  if (!ventes.length) return;
  const at = heatMinutesFn();
  const shown = (i) => hover === `v${i}` || selected.has(`v${i}`);
  const square = (vente, big) => {
    const [x, y] = project(vente.point);
    if (x < -20 || y < -20 || x > app.size.width + 20 || y > app.size.height + 20) return null;
    const half = big ? 6.5 : 4.5;
    ctx.beginPath();
    ctx.rect(x - half, y - half, half * 2, half * 2);
    // En voiture, les points de vente sans parking sont grisés (pas de calcul en voiture pour eux).
    ctx.fillStyle = app.mode === "voiture" && !vente.parking ? "#b4b4b4" : vente.id === app.tool.active ? "#2f9e1f" : "#6b3fa0";
    ctx.fill();
    ctx.lineWidth = big ? 2.2 : 1.6;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    return [x, y];
  };
  // Le point de vente choisi est dessiné par le marqueur carré du départ, avec son nom.
  const own = (vente) => vente.id === app.tool.active;
  ventes.forEach((vente, i) => {
    if (!shown(i) && !own(vente)) square(vente, false);
  });
  ventes.forEach((vente, i) => {
    if (!shown(i) || own(vente)) return;
    const drawn = square(vente, true);
    if (!drawn) return;
    const [x, y] = drawn;
    const minutes = vente.id === app.tool.active && heatSource() === app.from ? null : at?.(vente.point);
    const time = minutes === null || minutes === undefined ? null : Number.isFinite(minutes) ? formatMinutes(minutes) : "inaccessible";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const parking = vente.parking ? "parking" : app.mode === "voiture" ? "sans parking" : null;
    drawHaloText([vente.id, parking, time].filter(Boolean).join(" · "), x + 11, y, {
      font: "600 12px Inter, sans-serif",
      color: "#3d1f63",
    });
  });
}

/** Télécharge un CSV (séparateur « ; », UTF-8 avec BOM, virgule décimale : s'ouvre tel quel dans Excel). */
function downloadCsv(name, header, rows) {
  const cell = (value) => {
    const text = value === null || value === undefined || Number.isNaN(value) ? "" : typeof value === "number" ? String(value).replace(".", ",") : String(value);
    return /[;"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const text = "﻿" + [header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportRecap() {
  const { foyers, ventes } = app.tool;
  const thresholds = [...app.isochrones].sort((a, b) => a - b);
  if (!thresholds.length) {
    toast("Cochez au moins une isochrone : le récapitulatif compte les foyers dans les isochrones cochées.", 6000);
    return;
  }
  const rows = [];
  for (const vente of ventes) {
    for (const mode of ["tc", "velo", "voiture"]) {
      const times = app.tool.times.get(`${vente.id}|${mode}`);
      for (const threshold of thresholds) {
        if (!times) {
          rows.push([vente.id, vente.label, MODE_LABELS[mode], threshold, null, null,
            mode === "voiture" ? "pas de parking : voiture non calculée" : "non calculé"]);
          continue;
        }
        let count = 0;
        let people = 0;
        foyers.forEach((foyer, i) => {
          if (times[i] <= threshold) {
            count += 1;
            people += foyer.personnes;
          }
        });
        rows.push([vente.id, vente.label, MODE_LABELS[mode], threshold, count, Math.round(people * 100) / 100, ""]);
      }
    }
  }
  downloadCsv("recapitulatif.csv", ["point de vente", "adresse", "mode", "isochrone (min)", "foyers", "personnes", "remarque"], rows);
}

function exportCheck() {
  downloadCsv(
    "controle_adresses.csv",
    ["fichier", "id", "adresse", "qualité", "voie trouvée"],
    app.tool.report.map((row) => [row.fichier, row.id, row.adresse, row.qualite, row.trouve]),
  );
}

async function saveMemory() {
  const entries = await toolDb.entries();
  const blob = new Blob([JSON.stringify({ format: "porte-a-porte-memoire-1", entries })], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `calculs_porte_a_porte_${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`${entries.length} calculs sauvegardés.`);
}

async function restoreMemory(file) {
  try {
    const saved = JSON.parse(await file.text());
    if (saved.format !== "porte-a-porte-memoire-1") throw new Error("fichier non reconnu");
    for (const [key, value] of saved.entries) {
      const current = (await toolDb.get(key)) ?? {};
      await toolDb.put(key, { ...value, ...current });
    }
    toast(`${saved.entries.length} calculs restaurés.`);
    app.tool.times.clear();
    app.tool.grids.clear();
    await runTool();
  } catch (error) {
    toast(`Restauration impossible : ${error.message}`, 7000);
  }
}

$("foyersFile").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) importPlaces(file, "foyers");
});
$("addVenteToggle").addEventListener("click", () => {
  const form = $("addVente");
  form.hidden = !form.hidden;
  $("addVenteToggle").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) $("addVenteName").focus();
});
$("addVente").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("addVenteName").value.trim();
  const address = $("addVenteAddress").value.trim();
  if (!name || !address) return;
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    if (await addVente(name, address, $("addVenteParking").checked)) {
      $("addVenteName").value = "";
      $("addVenteAddress").value = "";
      $("addVenteParking").checked = false;
    }
  } catch (error) {
    console.error(error);
    toast(`Ajout impossible : ${error.message}`, 8000);
  } finally {
    button.disabled = false;
  }
});
$("ventesFile").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) importPlaces(file, "ventes");
});
$("venteSelect").addEventListener("change", (event) => {
  if (event.target.value) activateVente(event.target.value);
  else {
    leaveTool();
    recompute();
  }
});
$("exportRecap").addEventListener("click", exportRecap);
$("exportCheck").addEventListener("click", exportCheck);
$("saveMemory").addEventListener("click", () => saveMemory().catch((error) => toast(`Sauvegarde impossible : ${error.message}`, 7000)));
$("restoreMemory").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) restoreMemory(file);
});

// --- Recherche d'adresse (index local de la Base Adresse Nationale) ------------

const searchInput = $("searchInput");
const searchResults = $("searchResults");
let searchTimer = null;

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Arrêts de tram dont le nom contient tous les mots tapés. */
function searchStops(query) {
  const words = normalize(query).split(" ");
  return app.data.stations
    .filter((station) => station.tram && words.every((word) => normalize(station.name).includes(word)))
    .slice(0, 3)
    .map((station) => ({
      label: station.name,
      context: `Station de tram · ${station.routes.filter((id) => app.data.routeInfo[id]?.mode === "tram").map((id) => `ligne ${id}`).join(", ")}`,
      point: station.point,
    }));
}

async function searchAddress(query) {
  // Recherche locale (index de la Base Adresse Nationale fourni avec le site) : rien n'est envoyé en ligne.
  const stops = searchStops(query);
  const index = await ensureAddresses().catch(() => null);
  const addresses = index ? index.search(query, 6).filter((result) => isOnLand(result.point)) : [];
  return [...stops, ...addresses].slice(0, 7);
}

function showResults(results) {
  searchResults.replaceChildren(
    ...results.map((result) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = result.label;
      const context = document.createElement("small");
      context.textContent = result.context;
      button.append(context);
      button.addEventListener("click", () => chooseResult(result));
      item.append(button);
      return item;
    }),
  );
  searchResults.hidden = !results.length;
}

function chooseResult(result) {
  searchResults.hidden = true;
  searchInput.value = result.label;
  setFrom(result.point, result.label);
  const [sx, sy] = project(result.point);
  if (sx < 0 || sy < 0 || sx > app.size.width || sy > app.size.height) {
    [app.view.cx, app.view.cy] = result.point;
    requestRender();
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (query.length < 3) {
    searchResults.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      showResults(await searchAddress(query));
    } catch (error) {
      if (error.name !== "AbortError") searchResults.hidden = true;
    }
  }, 250);
});

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query.length < 3) return;
  try {
    const results = await searchAddress(query);
    if (results.length) chooseResult(results[0]);
    else toast("Adresse introuvable dans la Métropole.");
  } catch (error) {
    if (error.name !== "AbortError") toast("La recherche d'adresse ne répond pas.");
  }
});

document.addEventListener("click", (event) => {
  if (!$("searchForm").contains(event.target)) searchResults.hidden = true;
});

// --- Démarrage ----------------------------------------------------------------

async function init() {
  resize();
  const response = await fetch(DATA_URL);
  app.data = await response.json();
  app.offset = [app.data.meta.bounds[0], app.data.meta.bounds[1]];
  app.graph = prepareGraph(app.data);
  app.paths = buildPaths(app.data);
  app.size.width = 0;
  resize();
  restoreFromUrl();
  app.basemap = createBasemap({
    provider: app.provider,
    lat0: app.data.meta.lat0,
    toWorld,
    toLatLon,
    onLoad: requestRender,
  });
  requestRender();
  new ResizeObserver(resize).observe(canvas);
}

init().catch((error) => {
  console.error(error);
  $("tripFrom").textContent = "Impossible de charger le réseau.";
});
