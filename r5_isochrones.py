#!/usr/bin/env python3
"""Temps de trajet porte à porte (marche + tram/bus TaM) avec r5py, en local.

Pour chaque adresse de référence :
  - le temps de trajet vers chaque point (matrice) et le nombre de points sous chaque seuil ;
  - une grille fine de temps sur toute la Métropole, alignée sur le repère de la carte du site,
    pour dessiner l'isochrone ;
  - les isochrones en GeoJSON (union des cases de la grille), pour QGIS.

Le temps est un temps « moyen » : la médiane des temps porte à porte pour des départs étalés sur la plage
horaire (7 h–20 h par défaut), attente comprise, comme la carte du site.

Rien ne quitte la machine : les adresses sont géocodées avec le fichier de la Base Adresse Nationale
téléchargé une fois (ou données directement en lat/lon), et tous les calculs sont locaux.

Usage :
  python r5_isochrones.py --osm data/languedoc-roussillon-latest.osm.pbf \\
      --references prive/references.csv --points prive/points.csv --ban data/adresses-34.csv.gz

Fichiers d'entrée (CSV, séparateur « ; » ou « , ») : une colonne « id » (facultative), et soit une colonne
« adresse » (texte libre : « 12 rue de la Loge 34000 Montpellier »), soit deux colonnes « lat » et « lon ».
Sorties dans --sortie (par défaut sortie/, non versionné) :
  geocodage.csv, matrice.csv, comptes.csv, isochrones.geojson, grilles/<id>.json
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import re
import sys
import time
import unicodedata
import zipfile
from difflib import get_close_matches
from pathlib import Path

import build_data

ROOT = Path(__file__).resolve().parent
THRESHOLDS = [5, 10, 15, 20, 30, 45, 60]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--osm", required=True, type=Path, help="extrait OpenStreetMap .osm.pbf couvrant la Métropole")
    parser.add_argument("--gtfs", type=Path, default=ROOT / "data" / "gtfs_tam.zip", help="GTFS TaM (défaut : data/gtfs_tam.zip)")
    parser.add_argument("--references", required=True, type=Path, help="CSV des adresses de référence")
    parser.add_argument("--points", type=Path, help="CSV des points à compter (facultatif)")
    parser.add_argument("--ban", type=Path, help="fichier BAN du département (adresses-34.csv.gz), pour les colonnes « adresse »")
    parser.add_argument("--sortie", type=Path, default=ROOT / "sortie", help="dossier de sortie (défaut : sortie/)")
    parser.add_argument("--date", help="jour de référence AAAAMMJJ (défaut : un mardi ou jeudi ordinaire du GTFS, comme le site)")
    parser.add_argument("--plage", default="7:00-20:00", help="plage des départs (défaut : 7:00-20:00)")
    parser.add_argument("--vitesse-marche", type=float, default=build_data.WALK_METERS_PER_MINUTE * 60 / 1000,
                        help="km/h (défaut : 4,5, comme le site)")
    parser.add_argument("--pas", type=float, default=50.0, help="pas de la grille en mètres (défaut : 50)")
    parser.add_argument("--max-minutes", type=int, default=90, help="au-delà, un point est jugé inaccessible (défaut : 90)")
    parser.add_argument("--sans-grille", action="store_true", help="matrice et comptes seulement, sans grille ni isochrones")
    parser.add_argument("--tout-recalculer", action="store_true",
                        help="ignore le cache (sortie/cache/) et recalcule tout, géocodage compris")
    parser.add_argument("--r5-classpath", help="fichier .jar de R5 déjà téléchargé (sinon r5py le télécharge)")
    parser.add_argument("--memoire", default="4G", help="mémoire maximale de Java (défaut : 4G)")
    return parser.parse_args()


# --- Lecture des CSV ---------------------------------------------------------


def read_table(path: Path) -> list[dict]:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    # Fins de ligne Windows (\r\n), Unix (\n) ou anciennes Mac / certains exports Excel (\r) : toutes ramenées à \n.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    dialect = csv.Sniffer().sniff(text.split("\n", 1)[0], delimiters=";,\t")
    rows = list(csv.DictReader(io.StringIO(text, newline=""), dialect=dialect))
    rows = [row for row in rows if any((value or "").strip() for value in row.values())]  # lignes vides
    return [{(key or "").strip().lower(): (value or "").strip() for key, value in row.items()} for row in rows]


def read_places(path: Path, geocoder: "BanGeocoder | None", kind: str) -> tuple[list[dict], list[dict]]:
    """Lieux (id, label, lat, lon) et compte rendu du géocodage."""
    places, report = [], []
    for index, row in enumerate(read_table(path), start=1):
        place_id = row.get("id") or f"{kind}{index}"
        lat = row.get("lat") or row.get("latitude")
        lon = row.get("lon") or row.get("lng") or row.get("longitude")
        address = row.get("adresse") or row.get("address") or ""
        if lat and lon:
            found = {"lat": float(lat.replace(",", ".")), "lon": float(lon.replace(",", ".")), "qualite": "coordonnées fournies", "trouve": ""}
        elif address:
            if geocoder is None:
                sys.exit(f"{path.name} : colonne « adresse » sans --ban (fichier BAN) pour la géocoder.")
            found = geocoder.geocode(address)
        else:
            sys.exit(f"{path.name}, ligne {index} : ni « adresse » ni « lat »/« lon ».")
        report.append({"fichier": kind, "id": place_id, "adresse": address, **found})
        if found["lat"] is not None:
            places.append({"id": place_id, "label": address or place_id, "lat": found["lat"], "lon": found["lon"]})
    return places, report


# --- Géocodage local avec la Base Adresse Nationale ---------------------------


ABBREVIATIONS = {
    "av": "avenue", "ave": "avenue", "bd": "boulevard", "bld": "boulevard", "blvd": "boulevard", "r": "rue",
    "pl": "place", "pce": "place", "imp": "impasse", "all": "allee", "ch": "chemin", "che": "chemin", "rte": "route",
    "crs": "cours", "qu": "quai", "sq": "square", "res": "residence", "st": "saint", "ste": "sainte", "fbg": "faubourg",
}
REPETITIONS = {"bis": "b", "ter": "t", "quater": "q", "b": "b", "t": "t", "q": "q", "a": "a", "c": "c"}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    words = re.sub(r"[^a-z0-9]+", " ", text).split()
    return " ".join(ABBREVIATIONS.get(word, word) for word in words)


class BanGeocoder:
    """Recherche locale dans le fichier BAN d'un département (aucune requête réseau)."""

    def __init__(self, path: Path):
        opener = gzip.open if path.suffix == ".gz" else open
        self.numbers: dict[tuple[str, str], dict[str, tuple[float, float]]] = {}
        self.streets_by_postcode: dict[str, set[str]] = {}
        self.streets_by_town: dict[str, set[str]] = {}
        self.postcodes_by_town: dict[str, set[str]] = {}
        with opener(path, "rt", encoding="utf-8") as handle:
            for row in csv.DictReader(handle, delimiter=";"):
                street = normalize(row["nom_voie"])
                postcode = row["code_postal"]
                town = normalize(row["nom_commune"])
                number = (row["numero"] or "") + REPETITIONS.get((row.get("rep") or "").lower(), (row.get("rep") or "").lower())
                self.numbers.setdefault((postcode, street), {})[number] = (float(row["lat"]), float(row["lon"]))
                self.streets_by_postcode.setdefault(postcode, set()).add(street)
                self.streets_by_town.setdefault(town, set()).add(street)
                self.postcodes_by_town.setdefault(town, set()).add(postcode)
        count = sum(len(numbers) for numbers in self.numbers.values())
        print(f"BAN : {count} adresses, {len(self.numbers)} voies")

    def geocode(self, address: str) -> dict:
        text = normalize(address)
        missing = {"lat": None, "lon": None, "qualite": "non trouvée", "trouve": ""}
        match = re.match(r"^(\d+)\s*(bis|ter|quater|b|t|q|a|c)?\b\s*(.*)$", text)
        number, repetition, rest = (match.group(1), REPETITIONS.get(match.group(2) or "", ""), match.group(3)) if match else ("", "", text)
        postcode_match = re.search(r"\b(\d{5})\b", rest)
        if postcode_match:
            postcode = postcode_match.group(1)
            street_text, town = rest[: postcode_match.start()].strip(), rest[postcode_match.end():].strip()
            candidates = [(postcode, street) for street in self.streets_by_postcode.get(postcode, ())]
        else:
            # Sans code postal : la commune est à la fin, on essaie les plus longues d'abord.
            town = next((t for t in sorted(self.streets_by_town, key=len, reverse=True) if rest.endswith(" " + t)), "")
            if not town:
                return missing
            street_text = rest[: -len(town)].strip()
            candidates = [(code, street) for code in self.postcodes_by_town[town] for street in self.streets_by_town[town]
                          if (code, street) in self.numbers]
        if not candidates:
            return missing
        streets = {street: (code, street) for code, street in candidates}
        if street_text in streets:
            key, quality = streets[street_text], "voie exacte"
        else:
            close = get_close_matches(street_text, list(streets), n=1, cutoff=0.8)
            if not close:
                return missing
            key, quality = streets[close[0]], "voie approchée"
        numbers = self.numbers[key]
        wanted = number + repetition
        if wanted in numbers:
            lat, lon = numbers[wanted]
            quality += ", numéro exact"
        elif number in numbers:
            lat, lon = numbers[number]
            quality += ", numéro sans indice de répétition"
        else:
            # Numéro absent : le plus proche sur la même voie (ou le milieu de la voie, sans numéro).
            numeric = [(abs(int(re.match(r"\d+", n).group()) - int(number or 0)), n) for n in numbers if re.match(r"\d+", n)]
            nearest = min(numeric)[1] if numeric and number else None
            lat, lon = numbers[nearest] if nearest else numbers[next(iter(numbers))]
            quality += f", numéro le plus proche ({nearest})" if nearest else ", voie sans numéro"
        return {"lat": lat, "lon": lon, "qualite": quality, "trouve": f"{key[1]} {key[0]}"}


class CachedGeocoder:
    """Géocodage avec mémoire : une adresse déjà trouvée n'est pas recherchée à nouveau, et le fichier BAN
    (long à lire) n'est chargé qu'à la première adresse inconnue. Le cache est oublié si le fichier BAN change."""

    def __init__(self, ban: Path | None, cache_path: Path, reset: bool):
        self.ban, self.path, self.geocoder = ban, cache_path, None
        self.stamp = f"{ban.stat().st_size}-{int(ban.stat().st_mtime)}" if ban else None
        saved = {} if reset or not cache_path.exists() else json.loads(cache_path.read_text(encoding="utf-8"))
        self.known = saved.get("adresses", {}) if saved.get("ban") in (self.stamp, None) or ban is None else {}
        self.hits = self.misses = 0

    def geocode(self, address: str) -> dict:
        if address in self.known:
            self.hits += 1
            return dict(self.known[address])
        if self.ban is None:
            sys.exit(f"Adresse jamais géocodée et pas de --ban (fichier BAN) pour la chercher : « {address} »")
        if self.geocoder is None:
            self.geocoder = BanGeocoder(self.ban)
        self.misses += 1
        found = self.geocoder.geocode(address)
        self.known[address] = found
        return dict(found)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"ban": self.stamp, "adresses": self.known}, ensure_ascii=False), encoding="utf-8")


# --- Réseau ----------------------------------------------------------------


def crop_osm(osm: Path, out_dir: Path) -> Path:
    """Ne garde de l'extrait OSM (toute une région) que les rues de l'emprise de la carte (build_data.OSM_BBOX) :
    R5 construit alors son réseau en quelques secondes et avec peu de mémoire. Fait une fois, puis gardé."""
    import osmium

    target = out_dir / f"{osm.name.split('.')[0]}_metropole.osm.pbf"
    if target.exists() and target.stat().st_mtime >= osm.stat().st_mtime:
        return target
    south, west, north, east = build_data.OSM_BBOX
    started = time.time()
    print("Découpe de l'extrait OSM à la Métropole (une seule fois)…")
    inside: set[int] = set()
    for node in osmium.FileProcessor(str(osm), osmium.osm.NODE):
        if node.location.valid() and south <= node.location.lat <= north and west <= node.location.lon <= east:
            inside.add(node.id)
    # Chaque voie qui entre dans l'emprise est gardée entière, avec tous ses nœuds.
    ways, needed = [], set()
    for way in osmium.FileProcessor(str(osm), osmium.osm.WAY):
        if "highway" in way.tags and any(ref.ref in inside for ref in way.nodes):
            ways.append(osmium.osm.mutable.Way(id=way.id, nodes=[ref.ref for ref in way.nodes], tags=dict(way.tags),
                                               version=max(way.version, 1), visible=True))
            needed.update(ref.ref for ref in way.nodes)
    if target.exists():
        target.unlink()
    writer = osmium.SimpleWriter(str(target))
    for node in osmium.FileProcessor(str(osm), osmium.osm.NODE):
        if node.id in needed:
            writer.add_node(osmium.osm.mutable.Node(id=node.id, location=(node.location.lon, node.location.lat),
                                                    tags=dict(node.tags), version=max(node.version, 1), visible=True))
    for way in ways:
        writer.add_way(way)
    writer.close()
    print(f"  {len(ways)} voies gardées en {time.time() - started:.0f} s")
    return target


# Version du GTFS préparé : à changer quand la préparation change, pour ne pas réutiliser un ancien cache.
PREPARED_GTFS_VERSION = 2


def csv_rewrite(data: bytes, keep) -> bytes:
    """Réécrit une table GTFS en ne gardant (et en modifiant éventuellement) que les lignes pour lesquelles keep(row)
    renvoie une ligne."""
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=reader.fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in reader:
        kept = keep(row)
        if kept is not None:
            writer.writerow(kept)
    return out.getvalue().encode("utf-8")


def prepare_gtfs(gtfs: Path, out_dir: Path) -> Path:
    """Copie du GTFS adaptée à R5 :
    - sans les fichiers de tarifs, que R5 refuse (pass de 2 à 7 jours) et dont les temps ne dépendent pas ;
    - sans le transport à la demande (lignes 27, 28, 31, 35 et 42 de la TaM) : les courses marquées « TAD » dans
      trips.txt, ou desservies sur réservation à tous leurs arrêts (pickup_type / drop_off_type 2), sont retirées ;
      un arrêt sur réservation d'une course régulière devient sans montée ni descente (type 1). Comme la carte du
      site, qui écarte aussi ces courses."""
    target = out_dir / f"{gtfs.stem}_r5_v{PREPARED_GTFS_VERSION}.zip"
    if target.exists() and target.stat().st_mtime >= gtfs.stat().st_mtime:
        return target
    with zipfile.ZipFile(gtfs) as source:
        stop_times = list(csv.DictReader(io.StringIO(source.read("stop_times.txt").decode("utf-8-sig"))))
        on_demand = lambda row: "2" in ((row.get("pickup_type") or "").strip(), (row.get("drop_off_type") or "").strip())
        stops_per_trip, demand_per_trip = {}, {}
        for row in stop_times:
            stops_per_trip[row["trip_id"]] = stops_per_trip.get(row["trip_id"], 0) + 1
            demand_per_trip[row["trip_id"]] = demand_per_trip.get(row["trip_id"], 0) + on_demand(row)
        trips = list(csv.DictReader(io.StringIO(source.read("trips.txt").decode("utf-8-sig"))))
        removed = {row["trip_id"] for row in trips if (row.get("TAD") or "").strip()}
        removed |= {trip for trip, count in stops_per_trip.items() if count and demand_per_trip[trip] == count}

        def keep_stop_time(row):
            if row["trip_id"] in removed:
                return None
            if on_demand(row):  # arrêt sur réservation d'une course régulière
                row["pickup_type"] = row["drop_off_type"] = "1"
            return row

        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as copy:
            for name in source.namelist():
                if name.startswith("fare"):
                    continue
                data = source.read(name)
                if name == "trips.txt":
                    data = csv_rewrite(data, lambda row: None if row["trip_id"] in removed else row)
                elif name == "stop_times.txt":
                    data = csv_rewrite(data, keep_stop_time)
                copy.writestr(name, data)
    print(f"GTFS préparé pour R5 : {len(removed)} courses sur réservation retirées")
    return target


def reference_date(gtfs: Path) -> str:
    with zipfile.ZipFile(gtfs) as archive:
        rows = list(build_data.read_gtfs_table(archive, "calendar_dates.txt"))
    return build_data.pick_reference_date(rows)


def parse_window(text: str, day: str) -> tuple[dt.datetime, dt.timedelta]:
    start, end = (dt.datetime.strptime(part.strip(), "%H:%M").time() for part in text.split("-"))
    base = dt.datetime.strptime(day, "%Y%m%d")
    first, last = dt.datetime.combine(base, start), dt.datetime.combine(base, end)
    if last <= first:
        sys.exit("--plage : l'heure de fin doit suivre l'heure de début.")
    return first, last - first


# --- Grille alignée sur la carte du site --------------------------------------


def metropole_grid(step: float):
    """Centres des cases de la grille, dans le repère du site (mètres, voir build_data.lonlat_to_xy), limités à la
    Métropole. Renvoie le cadre de la grille, ses dimensions et, pour chaque case gardée, (rang, colonne, lat, lon)."""
    import numpy as np
    import shapely
    from shapely.geometry import Polygon

    _, polygons = build_data.extract_communes()
    land = shapely.union_all([Polygon(polygon[0], polygon[1:]) for polygon in polygons]).buffer(0)
    min_x, min_y, max_x, max_y = land.bounds
    cols, rows = int((max_x - min_x) // step) + 1, int((max_y - min_y) // step) + 1
    xs = min_x + (np.arange(cols) + 0.5) * step
    ys = min_y + (np.arange(rows) + 0.5) * step
    grid_x, grid_y = np.meshgrid(xs, ys)
    shapely.prepare(land)
    inside = shapely.contains_xy(land, grid_x, grid_y)
    row_index, col_index = np.nonzero(inside)
    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * np.cos(np.radians(build_data.LAT0))
    lat = grid_y[inside] / meters_per_deg_lat
    lon = grid_x[inside] / meters_per_deg_lon
    return (min_x, min_y), cols, rows, row_index, col_index, lat, lon, land


# --- Calcul -----------------------------------------------------------------


# Version du calcul : à changer quand la façon de calculer change, pour que le cache soit refait.
CALCULATION_VERSION = 1


def file_digest(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(*parts) -> str:
    """Empreinte courte de tout ce dont un résultat dépend : si elle change, le résultat en cache ne vaut plus."""
    import hashlib

    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


def place_key(place: dict) -> str:
    """Un lieu est reconnu par sa position, pas par son id : renommer un point ne le fait pas recalculer,
    corriger son adresse si."""
    return f"{place['lat']:.6f},{place['lon']:.6f}"


def main() -> None:
    args = parse_args()
    # Un fichier introuvable fait sinon échouer pyosmium ou Java avec un message peu lisible (voire mal décodé).
    for option, path in (("--osm", args.osm), ("--gtfs", args.gtfs), ("--references", args.references),
                         ("--points", args.points), ("--ban", args.ban)):
        if path is not None and not path.is_file():
            nearby = sorted(p.name for p in path.parent.glob("*")) if path.parent.is_dir() else []
            sys.exit(f"{option} : fichier introuvable : {path.resolve()}"
                     + (f"\n  Fichiers présents dans {path.parent} : {', '.join(nearby) or '(aucun)'}" if path.parent.is_dir() else
                        f"\n  Le dossier {path.parent.resolve()} n'existe pas."))
    args.sortie.mkdir(parents=True, exist_ok=True)
    cache_dir = args.sortie / "cache"
    cache_dir.mkdir(exist_ok=True)

    # r5py lit sa configuration sur la ligne de commande : on lui passe la sienne avant de l'importer.
    r5_args = ["--max-memory", args.memoire]
    if args.r5_classpath:
        r5_args += ["--r5-classpath", args.r5_classpath]
    sys.argv = [sys.argv[0], *r5_args]
    import geopandas as gpd
    import numpy as np
    import pandas as pd
    import r5py
    import shapely

    # --- Lieux (géocodage avec mémoire) ---
    geocoder = CachedGeocoder(args.ban, cache_dir / "geocodage.json", args.tout_recalculer)
    references, report = read_places(args.references, geocoder, "ref")
    points, point_report = read_places(args.points, geocoder, "pt") if args.points else ([], [])
    report += point_report
    geocoder.save()
    pd.DataFrame(report).to_csv(args.sortie / "geocodage.csv", index=False, sep=";", encoding="utf-8-sig")
    missing = [row for row in report if row["lat"] is None]
    print(f"Géocodage : {len(report) - len(missing)}/{len(report)} lieux placés "
          f"({geocoder.hits} déjà connus, {geocoder.misses} cherchés ; détail : geocodage.csv)")
    for row in missing:
        print(f"  non trouvé : {row['fichier']} {row['id']} « {row['adresse']} »")
    if not references:
        sys.exit("Aucune adresse de référence placée.")

    # --- Contexte du calcul : ce dont dépendent tous les temps ---
    day = args.date or reference_date(args.gtfs)
    departure, window = parse_window(args.plage, day)
    print(f"Jour de référence {day}, départs {args.plage}, marche {args.vitesse_marche:.1f} km/h")
    osm, gtfs = crop_osm(args.osm, args.sortie), prepare_gtfs(args.gtfs, args.sortie)
    context = fingerprint(CALCULATION_VERSION, r5py.__version__, file_digest(osm), file_digest(gtfs), day, args.plage,
                          args.vitesse_marche, args.max_minutes)
    grid_context = fingerprint(context, args.pas, file_digest(build_data.DATA_DIR / "communes_3m.geojson"))

    network = None

    def get_network():
        nonlocal network
        if network is None:
            started = time.time()
            network = r5py.TransportNetwork(osm, [gtfs])
            print(f"Réseau prêt en {time.time() - started:.0f} s")
        return network

    options = dict(
        departure=departure,
        departure_time_window=window,
        percentiles=[50],
        max_time=dt.timedelta(minutes=args.max_minutes),
        speed_walking=args.vitesse_marche,
        transport_modes=[r5py.TransportMode.TRANSIT, r5py.TransportMode.WALK],
    )
    as_frame = lambda places, ids: gpd.GeoDataFrame(
        {"id": ids}, geometry=gpd.points_from_xy([p["lon"] for p in places], [p["lat"] for p in places]), crs=4326
    )

    # --- Matrice références × points : seules les paires inconnues sont calculées ---
    if points:
        matrix_cache = cache_dir / "matrice.json"
        saved = {} if args.tout_recalculer or not matrix_cache.exists() else json.loads(matrix_cache.read_text(encoding="utf-8"))
        if saved and saved.get("contexte") != context:
            print("Matrice : données ou réglages changés depuis le dernier calcul, tout est recalculé")
        known = saved.get("temps", {}) if saved.get("contexte") == context else {}
        ref_keys = {place_key(ref) for ref in references}
        point_keys = {place_key(point) for point in points}
        todo = {rk: sorted(pk for pk in point_keys if f"{rk}|{pk}" not in known) for rk in sorted(ref_keys)}
        todo = {rk: pks for rk, pks in todo.items() if pks}
        pairs = sum(len(pks) for pks in todo.values())
        print(f"Matrice {len(references)} × {len(points)} : {len(ref_keys) * len(point_keys) - pairs} paires déjà calculées, {pairs} à calculer")
        if todo:
            started = time.time()
            by_key = {place_key(p): p for p in [*references, *points]}
            origins = sorted(todo)
            destinations = sorted({pk for pks in todo.values() for pk in pks})
            result = r5py.TravelTimeMatrix(get_network(), origins=as_frame([by_key[k] for k in origins], origins),
                                           destinations=as_frame([by_key[k] for k in destinations], destinations), **options)
            for row in result.itertuples(index=False):
                if row.to_id in todo.get(row.from_id, ()):
                    known[f"{row.from_id}|{row.to_id}"] = None if pd.isna(row.travel_time) else float(row.travel_time)
            print(f"  calculées en {time.time() - started:.1f} s")
        # Le cache garde aussi les lieux retirés des fichiers : les remettre ne coûte rien.
        matrix_cache.write_text(json.dumps({"contexte": context, "temps": known}), encoding="utf-8")
        matrix = pd.DataFrame(
            [{"reference": ref["id"], "point": point["id"], "minutes": known.get(f"{place_key(ref)}|{place_key(point)}")}
             for ref in references for point in points]
        )
        matrix["minutes"] = matrix["minutes"].astype(float)
        matrix.to_csv(args.sortie / "matrice.csv", index=False, sep=";", encoding="utf-8-sig")
        counts = pd.DataFrame(
            [{"reference": ref["id"], "adresse": ref["label"],
              **{f"<= {t} min": int((matrix[matrix.reference == ref["id"]].minutes <= t).sum()) for t in THRESHOLDS},
              "inaccessibles": int(matrix[matrix.reference == ref["id"]].minutes.isna().sum())}
             for ref in references]
        )
        counts.to_csv(args.sortie / "comptes.csv", index=False, sep=";", encoding="utf-8-sig")
        print(counts.to_string(index=False))

    if args.sans_grille:
        print(f"Résultats dans {args.sortie}")
        return

    # --- Grilles et isochrones : une par référence, gardées en cache par position ---
    grid_cache = cache_dir / "grilles"
    grid_cache.mkdir(exist_ok=True)
    cached_file = lambda ref: grid_cache / f"{grid_context}_{fingerprint(place_key(ref))}.npz"
    pending = [ref for ref in references if args.tout_recalculer or not cached_file(ref).exists()]
    print(f"Grilles : {len(references) - len(pending)} déjà calculées, {len(pending)} à calculer")
    (min_x, min_y), cols, rows, row_index, col_index, lat, lon, land = metropole_grid(args.pas)
    if pending:
        cells = gpd.GeoDataFrame({"id": np.arange(len(lat))}, geometry=gpd.points_from_xy(lon, lat), crs=4326)
        print(f"Grille de {args.pas:.0f} m : {len(cells)} cases dans la Métropole")
    half = args.pas / 2
    for ref in pending:
        started = time.time()
        times = r5py.TravelTimeMatrix(get_network(), origins=as_frame([ref], [ref["id"]]), destinations=cells, **options)
        minutes = times.set_index("to_id").travel_time.reindex(cells.id).to_numpy()
        flat = np.full(cols * rows, -1, dtype=np.int16)  # -1 : hors Métropole ou inaccessible
        reached = ~np.isnan(minutes)
        flat[row_index[reached] * cols + col_index[reached]] = np.round(minutes[reached]).astype(np.int16)
        # Isochrones : union des cases atteintes sous chaque seuil, découpée sur la Métropole (WKB, en lon/lat).
        shapes, areas = [], []
        for threshold in THRESHOLDS:
            keep = reached & (np.nan_to_num(minutes, nan=1e9) <= threshold)
            if not keep.any():
                shapes.append(b""), areas.append(0.0)
                continue
            cx = min_x + (col_index[keep] + 0.5) * args.pas
            cy = min_y + (row_index[keep] + 0.5) * args.pas
            area = shapely.intersection(shapely.union_all(shapely.box(cx - half, cy - half, cx + half, cy + half)), land)
            shapes.append(shapely.to_wkb(xy_to_lonlat(area))), areas.append(round(area.area / 1e6, 2))
        np.savez_compressed(cached_file(ref), minutes=flat, shapes=np.array(shapes, dtype=object), areas=np.array(areas),
                            frame=np.array([min_x, min_y, cols, rows]))
        print(f"  {ref['id']} : calculée en {time.time() - started:.1f} s, {int(reached.sum())} cases atteintes")

    # Sorties réécrites à partir du cache, avec les ids et adresses actuels ; celles des références retirées partent.
    grid_dir = args.sortie / "grilles"
    grid_dir.mkdir(exist_ok=True)
    written, isochrones = set(), []
    for ref in references:
        stored = np.load(cached_file(ref), allow_pickle=True)
        name = f"{safe_name(ref['id'])}.json"
        written.add(name)
        (grid_dir / name).write_text(json.dumps({
            "reference": ref["id"], "adresse": ref["label"], "lat": ref["lat"], "lon": ref["lon"],
            "jour": day, "plage": args.plage, "vitesseMarche": args.vitesse_marche,
            # Repère de la carte du site (build_data.lonlat_to_xy) : case (r, c) centrée en
            # (origine[0] + (c + 0,5) × pas, origine[1] + (r + 0,5) × pas), rang 0 au sud.
            "lat0": build_data.LAT0, "origine": [round(min_x, 1), round(min_y, 1)], "pas": args.pas,
            "colonnes": cols, "rangs": rows, **encode_minutes(stored["minutes"]),
        }, separators=(",", ":")), encoding="utf-8")
        for threshold, wkb, km2 in zip(THRESHOLDS, stored["shapes"], stored["areas"]):
            if len(wkb):
                isochrones.append({"reference": ref["id"], "minutes": threshold, "km2": float(km2), "geometry": shapely.from_wkb(wkb)})
    for stale in grid_dir.glob("*.json"):
        if stale.name not in written:
            stale.unlink()
    if isochrones:
        gpd.GeoDataFrame(isochrones, crs=4326).to_file(args.sortie / "isochrones.geojson", driver="GeoJSON")
    # Grilles d'un ancien contexte (GTFS, rues ou réglages changés) : plus jamais utiles.
    for old in grid_cache.glob("*.npz"):
        if not old.name.startswith(grid_context):
            old.unlink()
    print(f"Résultats dans {args.sortie}")


def encode_minutes(minutes) -> dict:
    """Temps de la grille, sans perte, en peu de place : un octet par case (deux si la limite dépasse 254 min), la
    valeur maximale du type signalant une case sans temps (hors Métropole ou inaccessible), puis compression zlib
    et base64 pour tenir dans le JSON. Environ 0,05 Mo au lieu de 1,3 Mo pour une grille de 50 m.
    Décodage : base64 → zlib (« deflate » du navigateur) → entiers non signés en petit-boutiste."""
    import base64
    import zlib

    import numpy as np

    wide = int(minutes.max(initial=0)) >= 255
    dtype, empty = (np.dtype("<u2"), 65535) if wide else (np.dtype("u1"), 255)
    values = np.asarray(minutes, dtype=np.int64)
    packed = np.where(values < 0, empty, values).astype(dtype).tobytes()
    return {"codage": f"{'u16le' if wide else 'u8'}-zlib-base64", "vide": empty,
            "minutesZ": base64.b64encode(zlib.compress(packed, 9)).decode("ascii")}


def safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(text)) or "reference"


def xy_to_lonlat(geometry):
    """Du repère du site (mètres) vers lon/lat (WGS 84)."""
    import math
    import shapely

    meters_per_deg_lat = 111_320.0
    meters_per_deg_lon = meters_per_deg_lat * math.cos(math.radians(build_data.LAT0))
    return shapely.transform(geometry, lambda coords: coords / [meters_per_deg_lon, meters_per_deg_lat])


if __name__ == "__main__":
    main()
