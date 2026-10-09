"""Réseau de rues compact pour le calcul simplifié en voiture et à vélo dans le navigateur.

Lit un extrait OpenStreetMap (celui que r5_isochrones.py découpe à la Métropole, par exemple
sortie/languedoc-roussillon-261004_metropole.osm.pbf) et écrit site/data/routes.bin : les intersections
et les tronçons de rue entre elles, avec ce qu'il faut pour un plus court chemin.

Les règles imitent celles de R5 (le moteur de r5py), pour que la carte dynamique reste proche des
résultats r5py :

- voiture : vitesse du tag maxspeed, sinon vitesse par défaut selon le type de route (table de R5),
  sens uniques respectés ;
- vélo : rues ouvertes aux vélos, sens uniques respectés sauf contresens cyclable ; sur une rue de
  stress 4 (grand axe sans bande cyclable) ou interdite aux vélos mais ouverte aux piétons, le vélo
  est poussé à pied.

Format (little endian, compressé zlib) :
  en-tête : "RTE1", nombre de nœuds n, nombre de tronçons m (uint32), origine x, y (float64, repère
            build_data.lonlat_to_xy) ;
  nœuds   : x[n], y[n] en mètres depuis l'origine (uint16), drapeaux[n] (uint8 : 1 = réseau voiture
            principal, 2 = réseau vélo principal, 4 = intersection, 8 / 16 = une adresse peut
            s'y rattacher en voiture / à vélo) ;
  tronçons: a[m], b[m] (uint32), longueur[m] en décimètres (uint16), vitesse voiture[m] en km/h
            (uint8, 0 = interdit), drapeaux[m] (uint8 : 1 voiture a→b, 2 voiture b→a, 4 vélo a→b,
            8 vélo b→a, 16 piétons, 32 stress 4 a→b, 64 stress 4 b→a).
  Ordre dans le fichier : a, b, x, y, longueur, vitesse, drapeaux des tronçons, drapeaux des nœuds.

Usage :
  python tools/reseau_routier.py sortie/languedoc-roussillon-261004_metropole.osm.pbf
"""

from __future__ import annotations

import argparse
import math
import re
import struct
import sys
import zlib
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build_data  # noqa: E402

OUTPUT = ROOT / "site" / "data" / "routes.bin"
MAX_EDGE_METERS = 150  # tronçons plus longs coupés : les cases de la carte se rattachent à un nœud proche

MPH = 1.609344
# Vitesses par défaut de R5 (SpeedConfig), en km/h, quand maxspeed manque ou n'est pas un nombre.
DEFAULT_SPEED_KMH = {
    "motorway": 65, "motorway_link": 35, "trunk": 55, "trunk_link": 35, "primary": 45, "primary_link": 25,
    "secondary": 35, "secondary_link": 25, "tertiary": 25, "tertiary_link": 25, "living_street": 5,
}
FALLBACK_SPEED_KMH = 25

# Accès par défaut selon le type de voie : (voiture, vélo, piéton), ceux de R5 (USTraversalPermissionLabeler,
# celui qu'utilise r5py).
DEFAULT_ACCESS = {
    "motorway": (1, 0, 0), "motorway_link": (1, 0, 0),
    "trunk": (1, 1, 1), "trunk_link": (1, 1, 1),
    "primary": (1, 1, 1), "primary_link": (1, 1, 1), "secondary": (1, 1, 1), "secondary_link": (1, 1, 1),
    "tertiary": (1, 1, 1), "tertiary_link": (1, 1, 1), "unclassified": (1, 1, 1), "residential": (1, 1, 1),
    "living_street": (1, 1, 1), "service": (1, 1, 1), "road": (1, 1, 1), "track": (1, 1, 1),
    "cycleway": (0, 1, 1), "path": (0, 1, 1), "bridleway": (0, 1, 1), "pedestrian": (0, 1, 1),
    "footway": (0, 0, 1), "steps": (0, 0, 1), "corridor": (0, 0, 1), "platform": (0, 0, 1),
}
LOW_STRESS = {"service", "residential", "living_street", "unclassified", "tertiary", "tertiary_link"}
NO = {"no", "private"}
YES = {"yes", "designated", "permissive", "destination", "official"}
SPEED_RE = re.compile(r"^\s*([0-9.]+)\s*(km/h|kmh|kph|kmph|mph|knots)?\s*$")


def parse_speed(value: str | None) -> float | None:
    """km/h, comme R5 : un nombre éventuellement suivi d'une unité ; « FR:urban » et autres sont ignorés."""
    if not value:
        return None
    match = SPEED_RE.match(value)
    if not match:
        return None
    speed = float(match.group(1))
    unit = match.group(2)
    if unit == "mph":
        speed *= MPH
    elif unit == "knots":
        speed *= 1.852
    return speed if speed > 0.1 else None


def permissions(tags) -> tuple | None:
    """(voiture a→b, voiture b→a, vélo a→b, vélo b→a, piéton, vitesse km/h, stress4 a→b, stress4 b→a)."""
    highway = tags.get("highway")
    if highway not in DEFAULT_ACCESS or tags.get("area") == "yes":
        return None
    car, bike, foot = DEFAULT_ACCESS[highway]
    access = tags.get("access")
    if access in NO:
        car = bike = foot = 0
    elif access in YES:
        car, bike, foot = car or highway not in {"footway", "steps", "pedestrian", "path", "cycleway", "corridor"}, 1, 1
    for key in ("vehicle", "motor_vehicle", "motorcar"):
        if tags.get(key) in NO:
            car = 0
        elif tags.get(key) in YES and key != "vehicle":
            car = 1
    if tags.get("vehicle") in NO:
        bike = 0
    bicycle = tags.get("bicycle")
    if bicycle in NO or bicycle == "dismount":
        bike = 0
    elif bicycle in YES:
        bike = 1
    if tags.get("foot") in NO:
        foot = 0
    elif tags.get("foot") in YES:
        foot = 1
    if not (car or bike or foot):
        return None

    oneway = tags.get("oneway")
    if tags.get("junction") in {"roundabout", "circular"} and oneway is None:
        oneway = "yes"
    if highway in {"motorway", "motorway_link"} and oneway is None:
        oneway = "yes"
    forward, backward = True, True
    if oneway in {"yes", "true", "1"}:
        backward = False
    elif oneway == "-1":
        forward = False
    bike_forward, bike_backward = forward, backward
    contraflow = (
        tags.get("oneway:bicycle") == "no"
        or tags.get("cycleway", "").startswith("opposite")
        or tags.get("cycleway:left", "").startswith("opposite")
        or tags.get("cycleway:right", "").startswith("opposite")
    )
    if contraflow:
        bike_forward = bike_backward = True

    speed = parse_speed(tags.get("maxspeed:motorcar")) or parse_speed(tags.get("maxspeed"))
    if speed is None or speed > 150:
        speed = DEFAULT_SPEED_KMH.get(highway, FALLBACK_SPEED_KMH)

    # Stress du trafic pour un cycliste, comme le LevelOfTrafficStressLabeler de R5 : seul le niveau 4 compte
    # avec le seuil par défaut (3). Un grand axe ouvert aux voitures sans bande cyclable est de niveau 4.
    lts4_forward = lts4_backward = False
    explicit = tags.get("lts")
    if explicit:
        try:
            lts4_forward = lts4_backward = float(explicit) >= 4
        except ValueError:
            pass
    elif car and highway not in LOW_STRESS:
        lane_both = tags.get("cycleway") == "lane"
        lane_forward = lane_both or tags.get("cycleway:left") == "opposite" or tags.get("cycleway:right") == "lane"
        lane_backward = (
            lane_both or tags.get("cycleway:left") == "lane" or tags.get("cycleway") == "opposite"
            or tags.get("cycleway:right") == "opposite"
        )
        lts4_forward, lts4_backward = not lane_forward, not lane_backward

    return (
        bool(car and forward), bool(car and backward), bool(bike and bike_forward), bool(bike and bike_backward),
        bool(foot), speed, lts4_forward, lts4_backward,
    )


class Ways(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []  # (références des nœuds, permissions)
        self.uses = {}

    def way(self, w):
        rules = permissions(w.tags)
        if rules is None or len(w.nodes) < 2:
            return
        refs = [n.ref for n in w.nodes]
        # Comme R5, on ne rattache pas une adresse à une autoroute, un tunnel ou une voie couverte.
        linkable = not (w.tags.get("highway") == "motorway" or w.tags.get("tunnel") == "yes" or w.tags.get("covered") == "yes")
        self.ways.append((refs, rules, linkable))
        for i, ref in enumerate(refs):
            # Extrémités comptées deux fois : ce sont toujours des nœuds du graphe.
            self.uses[ref] = self.uses.get(ref, 0) + (2 if i in (0, len(refs) - 1) else 1)


class Locations(osmium.SimpleHandler):
    def __init__(self, wanted):
        super().__init__()
        self.wanted = wanted
        self.xy = {}
        self.signals = set()

    def node(self, n):
        if n.id in self.wanted:
            self.xy[n.id] = build_data.lonlat_to_xy(n.location.lon, n.location.lat)
            if n.tags.get("highway") == "traffic_signals" or n.tags.get("crossing") == "traffic_signals":
                self.signals.add(n.id)


def main_component(count, edges, usable):
    """Nœuds de la plus grande composante connexe (sans tenir compte du sens) pour un mode."""
    parent = list(range(count))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    touched = [False] * count
    for a, b, flags in edges:
        if usable(flags):
            touched[a] = touched[b] = True
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
    sizes = {}
    for i in range(count):
        if touched[i]:
            root = find(i)
            sizes[root] = sizes.get(root, 0) + 1
    if not sizes:
        return [False] * count
    best = max(sizes, key=sizes.get)
    return [touched[i] and find(i) == best for i in range(count)]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("osm", type=Path, help="extrait OSM découpé à la Métropole (.osm.pbf)")
    parser.add_argument("--sortie", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if not args.osm.exists():
        sys.exit(f"Fichier introuvable : {args.osm}")

    ways = Ways()
    ways.apply_file(str(args.osm))
    locations = Locations(set(ways.uses))
    locations.apply_file(str(args.osm))
    xy = locations.xy

    index = {}
    nodes = []

    def node_index(ref):
        if ref not in index:
            index[ref] = len(nodes)
            nodes.append(xy[ref])
        return index[ref]

    # Tronçons de rue entre deux intersections, comme les arêtes de R5 : (nœud de début, nœud de fin, points).
    segments = []
    for refs, rules, linkable in ways.ways:
        refs = [ref for ref in refs if ref in xy]
        if len(refs) < 2:
            continue
        start = 0
        for i in range(1, len(refs)):
            if i == len(refs) - 1 or ways.uses.get(refs[i], 0) > 1:
                segments.append((refs[start:i + 1], rules, linkable))
                start = i

    # Stress aux intersections sans feux (R5, applyIntersectionCosts) : chaque tronçon qui y aboutit prend le
    # stress le plus élevé des tronçons de l'intersection. Une petite rue qui débouche sans feux sur un grand
    # axe est donc de stress 4 jusqu'à l'intersection suivante, et le cycliste y pousse son vélo.
    stressful = {}
    for points, rules, _ in segments:
        if rules[6] or rules[7]:
            for end in (points[0], points[-1]):
                stressful[end] = True
    edges = []  # (a, b, longueur m, vitesse, drapeaux)
    linkable_nodes = {}  # nœud → bits 8 (rattachable en voiture) et 16 (à vélo)
    for points, rules, linkable in segments:
        car_f, car_b, bike_f, bike_b, foot, speed, lts_f, lts_b = rules
        if any(end not in locations.signals and stressful.get(end) for end in (points[0], points[-1])):
            lts_f = lts_b = True
        flags = (car_f * 1) | (car_b * 2) | (bike_f * 4) | (bike_b * 8) | (foot * 16) | (lts_f * 32) | (lts_b * 64)
        start, length = points[0], 0.0
        for previous, ref in zip(points, points[1:]):
            (x0, y0), (x1, y1) = xy[previous], xy[ref]
            length += math.hypot(x1 - x0, y1 - y0)
            if ref == points[-1] or length >= MAX_EDGE_METERS:
                if length > 0:
                    a, b = node_index(start), node_index(ref)
                    edges.append((a, b, length, speed if (car_f or car_b) else 0, flags))
                    if linkable:
                        bits = (8 if flags & 3 else 0) | (16 if flags & (4 | 8 | 16) else 0)
                        for node in (a, b):
                            linkable_nodes[node] = linkable_nodes.get(node, 0) | bits
                start, length = ref, 0.0

    origin_x = math.floor(min(x for x, _ in nodes)) - 1
    origin_y = math.floor(min(y for _, y in nodes)) - 1
    span = max(max(x for x, _ in nodes) - origin_x, max(y for _, y in nodes) - origin_y)
    if span >= 65535:
        sys.exit(f"Emprise trop grande pour des coordonnées sur 16 bits : {span:.0f} m")

    car_main = main_component(len(nodes), [(a, b, f) for a, b, _, _, f in edges], lambda f: f & 3)
    bike_main = main_component(len(nodes), [(a, b, f) for a, b, _, _, f in edges], lambda f: f & (4 | 8 | 16))
    degree = [0] * len(nodes)
    for a, b, _, _, _ in edges:
        degree[a] += 1
        degree[b] += 1
    # 4 : intersection (trois tronçons ou plus), où la voiture perd du temps à tourner.
    node_flags = [
        int(c) | (int(b) << 1) | (4 if d >= 3 else 0) | linkable_nodes.get(i, 0)
        for i, (c, b, d) in enumerate(zip(car_main, bike_main, degree))
    ]

    n, m = len(nodes), len(edges)
    body = bytearray(b"RTE1")
    body += struct.pack("<II dd", n, m, origin_x, origin_y)
    body += struct.pack(f"<{m}I", *(a for a, _, _, _, _ in edges))
    body += struct.pack(f"<{m}I", *(b for _, b, _, _, _ in edges))
    body += struct.pack(f"<{n}H", *(round(x - origin_x) for x, _ in nodes))
    body += struct.pack(f"<{n}H", *(round(y - origin_y) for _, y in nodes))
    body += struct.pack(f"<{m}H", *(min(65535, max(1, round(length * 10))) for _, _, length, _, _ in edges))
    body += struct.pack(f"<{m}B", *(min(255, round(speed)) for _, _, _, speed, _ in edges))
    body += struct.pack(f"<{m}B", *(flags for _, _, _, _, flags in edges))
    body += struct.pack(f"<{n}B", *node_flags)
    data = zlib.compress(bytes(body), 9)
    args.sortie.parent.mkdir(parents=True, exist_ok=True)
    args.sortie.write_bytes(data)
    print(f"{n} nœuds, {m} tronçons ({sum(car_main)} nœuds voiture, {sum(bike_main)} vélo) → "
          f"{args.sortie} ({len(data) / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
