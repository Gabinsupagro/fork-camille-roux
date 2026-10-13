"""Index compact des adresses de la Métropole, pour géocoder dans le navigateur sans service en ligne.

Lit le fichier de la Base Adresse Nationale de l'Hérault (adresses-34.csv.gz, adresse.data.gouv.fr, Licence
Ouverte) et écrit site/data/adresses.bin : les voies des 31 communes de la Métropole, avec pour chacune ses
numéros et leurs positions dans le repère de la carte (build_data.lonlat_to_xy, au mètre).

Format : JSON compressé zlib,
  {"origine": [x0, y0], "communes": [nom, …],
   "voies": [[nom de la voie, code postal, indice de commune, "n1|n2|…", [dx…], [dy…]], …]}
où chaque numéro (avec son indice de répétition : « 12bis » devient « 12b ») a sa position
(x0 + dx, y0 + dy) en mètres.

Usage :
  python tools/adresses_site.py data/adresses-34.csv.gz
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build_data  # noqa: E402

OUTPUT = ROOT / "site" / "data" / "adresses.bin"
REPETITIONS = {"bis": "b", "ter": "t", "quater": "q", "b": "b", "t": "t", "q": "q", "a": "a", "c": "c"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ban", type=Path, help="adresses-34.csv.gz (Base Adresse Nationale de l'Hérault)")
    parser.add_argument("--sortie", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if not args.ban.exists():
        sys.exit(f"Fichier introuvable : {args.ban}")

    communes_3m = json.loads((build_data.DATA_DIR / "communes_3m.geojson").read_text(encoding="utf-8"))
    codes = {f["properties"]["code"]: f["properties"]["nom"] for f in communes_3m["features"]}
    names = sorted(set(codes.values()))
    commune_index = {name: i for i, name in enumerate(names)}

    streets = {}  # (code postal, code insee, nom) → {numéro: (x, y)}
    opener = gzip.open if args.ban.suffix == ".gz" else open
    with opener(args.ban, "rt", encoding="utf-8") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            if row["code_insee"] not in codes or not row["nom_voie"]:
                continue
            rep = (row.get("rep") or "").lower()
            number = (row["numero"] or "") + REPETITIONS.get(rep, rep)
            if number in ("", "99999"):
                continue
            x, y = build_data.lonlat_to_xy(float(row["lon"]), float(row["lat"]))
            streets.setdefault((row["code_postal"], row["code_insee"], row["nom_voie"]), {})[number] = (x, y)

    xs = [x for numbers in streets.values() for x, _ in numbers.values()]
    ys = [y for numbers in streets.values() for _, y in numbers.values()]
    x0, y0 = math.floor(min(xs)), math.floor(min(ys))
    voies = []
    for (postcode, insee, name), numbers in sorted(streets.items()):
        keys = list(numbers)
        voies.append([
            name, postcode, commune_index[codes[insee]], "|".join(keys),
            [round(numbers[k][0] - x0) for k in keys], [round(numbers[k][1] - y0) for k in keys],
        ])
    body = json.dumps({"origine": [x0, y0], "communes": names, "voies": voies}, ensure_ascii=False, separators=(",", ":"))
    data = zlib.compress(body.encode("utf-8"), 9)
    args.sortie.write_bytes(data)
    count = sum(len(numbers) for numbers in streets.values())
    print(f"{count} adresses, {len(voies)} voies, {len(names)} communes → {args.sortie} ({len(data) / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
