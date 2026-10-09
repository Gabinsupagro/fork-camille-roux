#!/usr/bin/env python3
"""Probabilité d'aller faire ses courses en voiture, pour pondérer les comptes de points.

Deux sources publiques, combinées :

1. Le comportement, tiré de l'Enquête Ménages Déplacements de 2014 (EDGT34, Montpellier Méditerranée Métropole,
   ODbL) : pour les déplacements du domicile vers un commerce (motifs 32 grande surface, 33 petit et moyen commerce,
   34 marché) des habitants des 31 communes de la Métropole, une régression logistique pondérée donne la probabilité
   de prendre la voiture (conducteur ou passager) selon la distance à vol d'oiseau, le nombre de voitures du ménage et
   le type de commerce. Elle est ajustée sur les ménages motorisés : pour un ménage sans voiture, la probabilité est
   nulle (ses rares trajets en voiture, comme passager, sont négligés).

2. La motorisation actuelle, tirée du recensement 2022 (INSEE, base infracommunale Logement, géographie 2024) :
   pour chaque IRIS de la Métropole, la part des ménages sans voiture, avec une voiture, avec deux ou plus. Les
   contours des IRIS viennent de l'IGN (CONTOURS-IRIS, édition 2024).

Pour un point situé dans un IRIS et à une distance d (km) d'une référence de type t :

    p = part_1 × logistique(a + b·ln d + c_t) + part_2 × logistique(a + b·ln d + c_2voitures + c_t)

Sortie : site/data/voiture.json (coefficients, qualité de l'ajustement, IRIS avec leurs parts et leurs contours dans
le repère de la carte), lu par la page. Usage :

  python tools/modele_voiture.py --edgt data/edgt/MMM_MMM_EDGT_DataBrutes.zip \\
      --decoupage data/edgt/MMM_MMM_EDGT_DecoupagesGeo.zip \\
      --insee data/insee/base-ic-logement-2022_csv.zip \\
      --iris data/insee/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01.7z
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build_data  # noqa: E402  (repère de la carte, communes de la Métropole)

OUTPUT = ROOT / "site" / "data" / "voiture.json"
SHOP_TYPES = {"32": "grande surface", "33": "petit ou moyen commerce", "34": "marché"}

# Positions (début à 1, longueur) des champs utiles, d'après la feuille « Dessin de Fichier » du dictionnaire
# « EDGT 34 - TOTAL - Dico - 17112014.xls ». Une correction : dans le fichier des personnes, COE1 commence en
# position 56 (le dessin indique 63) ; vérifié sur les 14 530 lignes, toutes numériques à cette position.
LAYOUT = {
    "MENAGES": {"TIRA": (2, 3), "ZR": (5, 3), "ECH": (8, 3), "M6": (12, 1), "COE0": (44, 8)},
    "PERSONNES": {"TIRA": (2, 3), "ZR": (5, 3), "ECH": (8, 3), "PER": (11, 2), "COE1": (56, 8)},
    "DEPLACEMENTS": {"TIRA": (2, 3), "ZR": (5, 3), "ECH": (8, 3), "PER": (11, 2), "D2": (15, 2), "D5": (29, 2),
                     "MODP": (50, 2), "DOIB": (54, 8)},
}


def read_edgt(archive: Path, table: str) -> pd.DataFrame:
    with zipfile.ZipFile(archive) as zf:
        name = next(n for n in zf.namelist() if n.upper().endswith(f"EDGT34_TOTAL_{table}.TXT"))
        lines = zf.read(name).decode("latin-1").splitlines()
    fields = LAYOUT[table]
    return pd.DataFrame([{k: line[p - 1:p - 1 + n].strip() for k, (p, n) in fields.items()} for line in lines if line.strip()])


def metropole_sectors(archive: Path) -> set[str]:
    """Secteurs de tirage de l'enquête situés dans l'agglomération de Montpellier (les 31 communes de la Métropole)."""
    with zipfile.ZipFile(archive) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith("interne.csv"))
        table = pd.read_csv(io.BytesIO(zf.read(name)), sep=";", encoding="latin-1", dtype=str)
    return set(table[table.EPCI.str.contains("Montpellier", na=False)].NUM_SECTEUR.str.zfill(3))


def logistic_fit(X: np.ndarray, y: np.ndarray, w: np.ndarray):
    """Régression logistique pondérée (moindres carrés repondérés). Renvoie coefficients et écarts-types."""
    b = np.zeros(X.shape[1])
    for _ in range(100):
        p = 1 / (1 + np.exp(-X @ b))
        W = w * p * (1 - p)
        step = np.linalg.solve(X.T @ (W[:, None] * X), X.T @ (w * (y - p)))
        b += step
        if np.abs(step).max() < 1e-10:
            break
    p = 1 / (1 + np.exp(-X @ b))
    W = w * p * (1 - p)
    return b, np.sqrt(np.diag(np.linalg.inv(X.T @ (W[:, None] * X)))), p


def fit_model(edgt: Path, decoupage: Path) -> dict:
    sectors = metropole_sectors(decoupage)
    households = read_edgt(edgt, "MENAGES")
    persons = read_edgt(edgt, "PERSONNES")
    trips = read_edgt(edgt, "DEPLACEMENTS")
    persons["COE1"] = persons.COE1.astype(float)
    households["M6"] = pd.to_numeric(households.M6, errors="coerce")
    # Un ménage est repéré par secteur, zone de résidence et numéro d'échantillon (les numéros se répètent entre
    # l'enquête en face à face et l'enquête téléphonique).
    trips = trips.merge(persons, on=["TIRA", "ZR", "ECH", "PER"], how="left", validate="many_to_one")
    trips = trips.merge(households[["TIRA", "ZR", "ECH", "M6"]], on=["TIRA", "ZR", "ECH"], how="left", validate="many_to_one")
    trips["DOIB"] = pd.to_numeric(trips.DOIB, errors="coerce")
    shopping = trips[trips.TIRA.isin(sectors) & (trips.D2 == "01") & trips.D5.isin(list(SHOP_TYPES)) & (trips.DOIB > 0)].copy()
    shopping["car"] = shopping.MODP.isin(["21", "22"]).astype(float)

    without_car = shopping[shopping.M6 == 0]
    motorised = shopping[shopping.M6 >= 1]
    X = np.column_stack([
        np.ones(len(motorised)),
        np.log(motorised.DOIB / 1000),
        (motorised.M6 >= 2).astype(float),
        (motorised.D5 == "32").astype(float),
        (motorised.D5 == "34").astype(float),
    ])
    weights = (motorised.COE1 / motorised.COE1.mean()).to_numpy()
    b, se, predicted = logistic_fit(X, motorised.car.to_numpy(), weights)
    names = ["constante", "ln_distance_km", "deux_voitures_ou_plus", "grande_surface", "marche"]

    # Qualité : parts observées et prédites par motorisation et classe de distance.
    motorised = motorised.assign(pred=predicted)
    bins = [0, 500, 1000, 2000, 5000, math.inf]
    labels = ["< 0,5 km", "0,5-1 km", "1-2 km", "2-5 km", "> 5 km"]
    motorised["distance"] = pd.cut(motorised.DOIB, bins, labels=labels, right=False)
    motorised["voitures"] = np.where(motorised.M6 >= 2, "2 ou +", "1")
    table = []
    for (cars, distance), group in motorised.groupby(["voitures", "distance"], observed=True):
        w = group.COE1
        table.append({"voitures": cars, "distance": str(distance), "deplacements": int(len(group)),
                      "observe": round(float((group.car * w).sum() / w.sum()), 3),
                      "predit": round(float((group.pred * w).sum() / w.sum()), 3)})
    gap = sum(abs(r["observe"] - r["predit"]) * r["deplacements"] for r in table) / sum(r["deplacements"] for r in table)

    return {
        "source": "Enquête Ménages Déplacements 2014 (EDGT34), Montpellier Méditerranée Métropole, ODbL",
        "champ": "déplacements domicile → commerce (motifs 32, 33, 34) des habitants des 31 communes de la Métropole",
        "deplacements": {"menages_motorises": int(len(motorised)), "menages_sans_voiture": int(len(without_car)),
                         "part_voiture_sans_voiture": round(float((without_car.car * without_car.COE1).sum() / without_car.COE1.sum()), 3)},
        "regle_sans_voiture": "probabilité nulle pour un ménage sans voiture (ses rares trajets, comme passager, sont négligés)",
        "coefficients": {n: round(float(c), 4) for n, c in zip(names, b)},
        "ecarts_types": {n: round(float(s), 4) for n, s in zip(names, se)},
        "type_reference": {"petit ou moyen commerce": None, "marché": "marche", "grande surface": "grande_surface"},
        "ajustement": {"ecart_absolu_moyen": round(gap, 3), "par_classe": table},
    }


def read_motorisation(insee: Path, communes: set[str]) -> pd.DataFrame:
    with zipfile.ZipFile(insee) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv") and "meta" not in n.lower())
        table = pd.read_csv(zf.open(name), sep=";", dtype={"IRIS": str, "COM": str}, low_memory=False)
    year = next(c.split("_")[0] for c in table.columns if c.endswith("_RP_VOIT1P"))   # « P22 »
    table = table[table.COM.isin(communes)].copy()
    households = table[f"{year}_RP"].astype(float)
    one = table[f"{year}_RP_VOIT1"].astype(float)
    two = table[f"{year}_RP_VOIT2P"].astype(float)
    none = households - table[f"{year}_RP_VOIT1P"].astype(float)
    # Les noms des IRIS et des communes ne sont pas dans ce fichier : ils viennent des contours de l'IGN.
    # TYP_IRIS : habitat (H), activité (A), divers (D) ; un IRIS d'activité ou divers compte peu de ménages.
    out = pd.DataFrame({"code": table.IRIS, "type": table.TYP_IRIS, "menages": households.round().astype(int)})
    safe = households.where(households > 0)
    out["part0"], out["part1"], out["part2"] = (none / safe).round(4), (one / safe).round(4), (two / safe).round(4)
    out.attrs["annee"] = "20" + year[1:]
    return out


def read_iris_shapes(path: Path, communes: set[str]):
    import geopandas as gpd

    if path.suffix == ".7z":
        import tempfile

        import py7zr

        folder = Path(tempfile.mkdtemp(prefix="iris_"))
        with py7zr.SevenZipFile(path) as archive:
            archive.extractall(folder)
        path = next(folder.rglob("*.gpkg"))
    shapes = gpd.read_file(path)
    shapes.columns = [c.lower() for c in shapes.columns]
    code = next(c for c in ("code_iris", "iris") if c in shapes.columns)
    com = next(c for c in ("code_insee", "insee_com", "insee_comm") if c in shapes.columns)
    names = {c: n for c, n in (("nom_iris", "nom"), ("nom_commune", "commune"), ("nom_com", "commune")) if c in shapes.columns}
    shapes = shapes[shapes[com].isin(communes)].rename(columns={code: "code", **names})
    shapes = shapes[["code", *sorted(set(names.values())), "geometry"]]
    return shapes.to_crs(4326)


def to_site_polygons(geometry, tolerance_m: float = 15.0) -> list:
    """Polygones de l'IRIS dans le repère de la carte (mètres, build_data.lonlat_to_xy), simplifiés."""
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.ops import transform

    projected = transform(lambda x, y, z=None: build_data.lonlat_to_xy(x, y), geometry).simplify(tolerance_m)
    parts = list(projected.geoms) if isinstance(projected, MultiPolygon) else [projected]
    return [[[[round(x, 1), round(y, 1)] for x, y in ring.coords] for ring in [part.exterior, *part.interiors]]
            for part in parts if isinstance(part, Polygon) and not part.is_empty]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--edgt", type=Path, required=True, help="MMM_MMM_EDGT_DataBrutes.zip")
    parser.add_argument("--decoupage", type=Path, required=True, help="MMM_MMM_EDGT_DecoupagesGeo.zip")
    parser.add_argument("--insee", type=Path, help="base-ic-logement-2022_csv.zip (motorisation par IRIS)")
    parser.add_argument("--iris", type=Path, help="CONTOURS-IRIS (.7z ou .gpkg), édition de la géographie de --insee")
    parser.add_argument("--sortie", type=Path, default=OUTPUT)
    args = parser.parse_args()

    model = fit_model(args.edgt, args.decoupage)
    print("Modèle (ménages motorisés, déplacements domicile → commerce) :")
    for name, value in model["coefficients"].items():
        print(f"  {name:24} {value:+.3f} (± {1.96 * model['ecarts_types'][name]:.3f})")
    print(f"  écart absolu moyen observé / prédit : {model['ajustement']['ecart_absolu_moyen'] * 100:.1f} points")
    output = {"modele": model}

    if args.insee and args.iris:
        communes = {f["properties"]["code"] for f in build_data.load_json(build_data.DATA_DIR / "communes_3m.geojson")["features"]}
        motorisation = read_motorisation(args.insee, communes)
        shapes = read_iris_shapes(args.iris, communes)
        merged = shapes.merge(motorisation, on="code", how="inner")
        missing = sorted(set(motorisation.code) - set(merged.code))
        print(f"IRIS : {len(merged)} avec contours et motorisation ({len(missing)} sans contour)")
        output["motorisation"] = {
            "source": f"INSEE, recensement {motorisation.attrs['annee']}, base infracommunale Logement ; IGN, CONTOURS-IRIS",
            "iris": [{"code": row.code, "nom": getattr(row, "nom", ""), "commune": getattr(row, "commune", ""),
                      "type": row.type, "menages": int(row.menages),
                      "parts": [None if pd.isna(v) else float(v) for v in (row.part0, row.part1, row.part2)],
                      "polygones": to_site_polygons(row.geometry)}
                     for row in merged.itertuples()],
        }
        totals = motorisation.menages.sum()
        print("Ménages de la Métropole :", int(totals), "| sans voiture",
              f"{(motorisation.part0 * motorisation.menages).sum() / totals:.1%}", "| une",
              f"{(motorisation.part1 * motorisation.menages).sum() / totals:.1%}", "| deux ou plus",
              f"{(motorisation.part2 * motorisation.menages).sum() / totals:.1%}")

    args.sortie.parent.mkdir(parents=True, exist_ok=True)
    args.sortie.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Écrit {args.sortie} ({args.sortie.stat().st_size / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
