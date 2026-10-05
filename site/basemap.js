// Fond de carte OpenStreetMap : tuiles raster en Web Mercator, reprojetées à la volée dans le repère
// local du site (équirectangulaire centré sur lat0, en mètres).
//
// Dans ce repère x ne dépend que de la longitude et y que de la latitude : une tuile reste donc un
// rectangle aligné sur les axes. Il suffit de projeter ses deux coins (calculés en Mercator inverse)
// pour la dessiner au bon endroit, sans aucune approximation affine globale. Seule la variation de
// l'échelle verticale à l'intérieur d'une tuile est négligée (moins d'un quart de pixel).

const TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE = 40075016.686; // mètres, à l'équateur
const MAX_CACHED_TILES = 400;
const RETRY_AFTER_MS = 15000;
const MAX_TILES_PER_LAYER = 200;
const MAX_FALLBACK_LEVELS = 3;

// "base" se dessine sous la heatmap, "labels" (noms de rues, de quartiers) par-dessus.
// Un fournisseur sans couche "labels" garde ses noms dans "base".
export const PROVIDERS = {
  carto: {
    // Fond de style Voyager (données OpenStreetMap, rendu CARTO), noms séparés pour rester lisibles.
    // ATTENTION : CARTO exige désormais une clé d'API, sans elle les tuiles affichent « API key required ».
    base: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
    labels: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
    subdomains: "abcd",
    retina: true,
    minZoom: 9,
    maxZoom: 19,
    attribution: "© OpenStreetMap · © CARTO",
  },
  osm: {
    // Serveur de tuiles officiel d'OpenStreetMap : style standard, sans clé. Usage raisonnable seulement
    // (https://operations.osmfoundation.org/policies/tiles/) : pour un site très fréquenté, prévoir un
    // fournisseur dédié ou ses propres tuiles.
    base: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    labels: null,
    subdomains: "",
    retina: false,
    minZoom: 9,
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  },
};

export const DEFAULT_PROVIDER = "osm";

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/** Longitude du bord gauche de la colonne x au niveau de zoom z. */
export function tileLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}

/** Latitude du bord haut de la ligne y au niveau de zoom z (Mercator inverse). */
export function tileLat(y, z) {
  return toDegrees(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))));
}

/** Colonne de tuile (fractionnaire) d'une longitude. */
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Ligne de tuile (fractionnaire) d'une latitude (Mercator). */
export function latToTileY(lat, z) {
  const phi = toRadians(lat);
  return ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * 2 ** z;
}

/**
 * @param {object} options
 * @param {string} options.provider    clé de PROVIDERS
 * @param {number} options.lat0        latitude de référence du repère local
 * @param {(lat: number, lon: number) => number[]} options.toWorld   degrés -> mètres du repère local
 * @param {(point: number[]) => {lat: number, lon: number}} options.toLatLon  mètres -> degrés
 * @param {() => void} options.onLoad  appelé quand une tuile vient d'arriver (pour redessiner)
 */
export function createBasemap({ provider = DEFAULT_PROVIDER, lat0, toWorld, toLatLon, onLoad }) {
  const config = PROVIDERS[provider] ?? PROVIDERS[DEFAULT_PROVIDER];
  const cache = new Map(); // ordre d'insertion = ordre d'usage (du moins récent au plus récent)

  function url(template, z, x, y, retina) {
    const subdomain = config.subdomains ? config.subdomains[(x + y) % config.subdomains.length] : "";
    return template
      .replace("{s}", subdomain)
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y))
      .replace("{r}", retina && config.retina ? "@2x" : "");
  }

  function evict() {
    for (const [key, entry] of cache) {
      if (cache.size <= MAX_CACHED_TILES) break;
      if (!entry.ok) entry.image.src = ""; // annule le chargement en cours d'une tuile devenue inutile
      cache.delete(key);
    }
  }

  /** Renvoie la tuile du cache (sans rien demander au réseau) ou undefined. */
  function peek(layer, z, x, y) {
    return cache.get(`${layer}/${z}/${x}/${y}`);
  }

  function request(layer, z, x, y, retina) {
    const key = `${layer}/${z}/${x}/${y}`;
    let entry = cache.get(key);
    if (entry && entry.failedAt && Date.now() - entry.failedAt > RETRY_AFTER_MS) {
      cache.delete(key);
      entry = undefined;
    }
    if (entry) {
      cache.delete(key); // le remet en queue : c'est la plus récemment utilisée
      cache.set(key, entry);
      return entry;
    }
    const image = new Image();
    entry = { image, ok: false, failedAt: 0 };
    // CORS anonyme : le canvas reste « propre » (exportable) même avec des images d'un autre domaine.
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      entry.ok = true;
      onLoad();
    };
    image.onerror = () => {
      entry.failedAt = Date.now();
    };
    image.src = url(config[layer], z, x, y, retina);
    cache.set(key, entry);
    evict();
    return entry;
  }

  /** Niveau de zoom dont les pixels de tuile se rapprochent le plus des pixels d'écran. */
  function zoomFor(scale) {
    const exact = Math.log2((EARTH_CIRCUMFERENCE * Math.cos(toRadians(lat0)) * scale) / TILE_SIZE);
    return Math.min(config.maxZoom, Math.max(config.minZoom, Math.round(exact)));
  }

  /**
   * Dessine une couche. `ctx` doit être en coordonnées écran (pixels CSS) ; `view` fournit
   * { project, unproject, width, height, dpr, scale }. Renvoie le nombre de tuiles dessinées.
   */
  function draw(ctx, layer, view) {
    if (!config[layer]) return 0;
    const { project, unproject, width, height, dpr, scale } = view;
    const retina = dpr >= 1.5;
    // Fournisseur sans tuiles @2x sur écran haute densité : un niveau de zoom de plus pour rester net.
    const z = zoomFor(retina && !config.retina ? scale * 2 : scale);
    const n = 2 ** z;

    const topLeft = toLatLon(unproject(0, 0));
    const bottomRight = toLatLon(unproject(width, height));
    const xMin = Math.max(0, Math.floor(lonToTileX(topLeft.lon, z)));
    const xMax = Math.min(n - 1, Math.floor(lonToTileX(bottomRight.lon, z)));
    const yMin = Math.max(0, Math.floor(latToTileY(topLeft.lat, z)));
    const yMax = Math.min(n - 1, Math.floor(latToTileY(bottomRight.lat, z)));
    if ((xMax - xMin + 1) * (yMax - yMin + 1) > MAX_TILES_PER_LAYER) return 0;

    // Alignement sur les pixels de l'écran : pas de fine ligne entre deux tuiles voisines.
    const floorPx = (value) => Math.floor(value * dpr) / dpr;
    const ceilPx = (value) => Math.ceil(value * dpr) / dpr;

    let painted = 0;
    for (let y = yMin; y <= yMax; y += 1) {
      for (let x = xMin; x <= xMax; x += 1) {
        const [left, top] = project(toWorld(tileLat(y, z), tileLon(x, z)));
        const [right, bottom] = project(toWorld(tileLat(y + 1, z), tileLon(x + 1, z)));
        const dx = floorPx(left);
        const dy = floorPx(top);
        const dw = ceilPx(right) - dx;
        const dh = ceilPx(bottom) - dy;

        const tile = request(layer, z, x, y, retina);
        if (tile.ok) {
          ctx.drawImage(tile.image, dx, dy, dw, dh);
          painted += 1;
          continue;
        }
        // Tuile pas encore là : on étire en attendant un morceau d'une tuile plus large déjà chargée.
        for (let up = 1; up <= MAX_FALLBACK_LEVELS && z - up >= config.minZoom; up += 1) {
          const parent = peek(layer, z - up, x >> up, y >> up);
          if (!parent?.ok) continue;
          const span = 2 ** up;
          const sw = parent.image.naturalWidth / span;
          const sh = parent.image.naturalHeight / span;
          ctx.drawImage(parent.image, (x % span) * sw, (y % span) * sh, sw, sh, dx, dy, dw, dh);
          painted += 1;
          break;
        }
      }
    }
    return painted;
  }

  return { draw, attribution: config.attribution, hasLabels: Boolean(config.labels) };
}
