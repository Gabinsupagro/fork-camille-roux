# Montpellier à portée de tram

Carte interactive des temps de trajet en **tram** (et, en option, en **bus**) sur le réseau TaM de Montpellier.

👉 **https://tram.camilleroux.com/**

Idée originale : le [NYC Transit Time Cartogram](https://castrio.me/nyc/) d'Anthony Castrio, puis sa
[déclinaison parisienne](https://github.com/JulesGrandin/paris-temps-transport) par Jules Grandin.

Fonctionnalités : heatmap et isochrones depuis un départ déplaçable, arrivée au clic avec itinéraire détaillé
(lignes, correspondances, marche), recherche d'adresse (Base Adresse Nationale) ou de station, tram seul ou
tram + bus, déplacement et zoom de la carte, lien de partage, fond de carte OpenStreetMap (désactivable, avec
opacité des couleurs réglable).

## Lancer

```bash
python3 fetch_data.py   # facultatif : retélécharge les sources dans data/
python3 build_data.py   # régénère site/data/commute_map_data.json
python3 -m http.server 8000 --directory site
```

Puis ouvrir [http://localhost:8000](http://localhost:8000).

## Données

- GTFS théorique du réseau TaM ([transport.data.gouv.fr](https://transport.data.gouv.fr/datasets/reseau-urbain-tam))
- Tracés des lignes de tram, étangs et parcs : © contributeurs OpenStreetMap (ODbL), via Overpass
- Contours des 31 communes de Montpellier Méditerranée Métropole ([geo.api.gouv.fr](https://geo.api.gouv.fr/))
- Communes voisines de l'Hérault et du Gard ([geo.api.gouv.fr](https://geo.api.gouv.fr/)), dessinées en terre autour de la
  Métropole : ce qui reste découvert est la mer, en bleu. Fichier `data/context.geojson`, que
  `python3 fetch_data.py --context-only` télécharge seul (sans lui, la carte se construit sans mer)
- Fond de carte : © contributeurs OpenStreetMap, tuiles du serveur officiel (`tile.openstreetmap.org`, sans clé),
  reprojetées dans le repère local du site (voir `site/basemap.js`). Paramètres d'URL : `fond=0` (sans fond),
  `fond=carto` (CARTO Voyager, nécessite une clé d'API), `opacite=20..100`
- Recherche d'adresse côté navigateur : [api-adresse.data.gouv.fr](https://adresse.data.gouv.fr/)
- Mesure d'audience : Cloudflare Web Analytics (sans cookie)

## Modèle

Les temps viennent des horaires GTFS d'un mardi ou jeudi ordinaire, entre 7 h et 20 h :

- durée de chaque inter-station = médiane des durées planifiées ;
- attente = moitié de l'intervalle moyen entre deux passages à l'arrêt (bornée entre 1 et 15 min) ;
- correspondance = 1,5 min de marche + attente de la ligne suivante ; marche possible entre arrêts proches (< 450 m) ;
- marche à pied à 75 m/min (4,5 km/h) à vol d'oiseau, sans pénalité d'accès (arrêts en surface).

Pas de temps réel ni de perturbations. Les trajets à la demande (TaD) sont exclus.

## Temps porte à porte et isochrones précises (r5py, en local)

`r5_isochrones.py` calcule des temps de trajet porte à porte en suivant les vraies rues (marche + tram et bus
TaM), avec [r5py](https://r5py.readthedocs.io/). Pour chaque adresse de référence, il donne le temps vers chaque
point, le nombre de points sous 5, 10, 15, 20, 30, 45 et 60 min, et une grille fine de temps (50 m) pour dessiner
l'isochrone. Tout tourne sur votre machine : les adresses ne sont envoyées à aucun service.

Le temps est la médiane des temps porte à porte pour des départs étalés sur 7 h–20 h (attente comprise), un mardi
ou jeudi ordinaire du GTFS, à 4,5 km/h à pied : la même logique que la carte.

Installation (une fois) :

```bash
conda env create -f environment-r5.yml
conda activate r5
```

Données (une fois) dans `data/` :

- l'extrait OpenStreetMap de la région, `languedoc-roussillon-latest.osm.pbf`, sur
  [Geofabrik](https://download.geofabrik.de/europe/france/languedoc-roussillon.html) ;
- pour géocoder des adresses sans les envoyer en ligne, le fichier de la Base Adresse Nationale de l'Hérault,
  `adresses-34.csv.gz`, sur [adresse.data.gouv.fr](https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/).

Adresses dans `prive/` (non versionné), en CSV (`;` ou `,`) avec une colonne `id` et soit `adresse`
(« 12 rue de la Loge 34000 Montpellier »), soit `lat` et `lon` :

```bash
python r5_isochrones.py --osm data/languedoc-roussillon-latest.osm.pbf \
    --references prive/references.csv --points prive/points.csv --ban data/adresses-34.csv.gz
```

Résultats dans `sortie/` (non versionné) :

- `geocodage.csv` : où chaque adresse a été placée, avec la qualité du rapprochement (à vérifier) ;
- `matrice.csv` : temps de chaque référence vers chaque point, en minutes (vide si inaccessible en 90 min) ;
- `comptes.csv` : nombre de points sous chaque seuil, par référence ;
- `isochrones.geojson` : isochrones par référence et par seuil (QGIS) ;
- `grilles/<id>.json` : temps par case de 50 m, dans le repère de la carte du site, pour l'afficher.

Pour les voir sur la carte, lancez le site en local (`python -m http.server 8000 --directory site`), puis
« Résultats r5py › Charger… » et sélectionnez ensemble les fichiers de `sortie/grilles/`, `geocodage.csv` et
`matrice.csv`. Les fichiers sont lus par le navigateur et ne sont envoyés nulle part. La liste qui apparaît
choisit l'adresse de référence : la carte affiche alors sa heatmap et ses isochrones r5py, les points colorés
selon leur temps, et le nombre de points sous chaque isochrone cochée. Un clic sur la carte donne le temps porte
à porte depuis la référence ; déplacer le départ, ou choisir « Carte du site », revient au calcul habituel.

Options utiles : `--plage 8:00-9:00` (heure de pointe), `--date AAAAMMJJ`, `--vitesse-marche 5`, `--pas 100`,
`--sans-grille` (matrice et comptes seulement, plus rapide). Le premier lancement découpe l'extrait OSM à
l'emprise de la Métropole et construit le réseau (quelques minutes), puis garde les deux en cache. Le GTFS est
copié sans ses fichiers de tarifs, que R5 refuse (pass de plusieurs jours) ; les temps n'en dépendent pas.
