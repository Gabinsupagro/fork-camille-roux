# Montpellier porte à porte

Carte interactive des temps de trajet dans la Métropole de Montpellier : en **tram** et **bus** (réseau TaM) dans le
navigateur, et porte à porte à pied et en transports en commun, à **vélo** ou en **voiture** à partir de calculs r5py
faits en local.

Basé sur un fork du projet de Camille Roux,
[Montpellier à portée de tram](https://github.com/camilleroux/montpellier-temps-transport).

Idée originale : le [NYC Transit Time Cartogram](https://castrio.me/nyc/) d'Anthony Castrio, puis sa
[déclinaison parisienne](https://github.com/JulesGrandin/paris-temps-transport) par Jules Grandin.

Fonctionnalités : heatmap et isochrones depuis un départ déplaçable, arrivée au clic avec itinéraire détaillé
(lignes, correspondances, marche), nom et lignes d'un arrêt au survol, recherche d'adresse (Base Adresse Nationale) ou de station, tram seul ou
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
- Tracés des lignes de tram et de bus, étangs et parcs : © contributeurs OpenStreetMap (ODbL), via Overpass ;
  les lignes de bus (relations du réseau « TaM ») sont dessinées en trait fin quand la case Bus est cochée, et
  une ligne sans tracé dans OSM est tracée d'arrêt en arrêt (`python3 fetch_data.py --bus-only` les met à jour)
- Contours des 31 communes de Montpellier Méditerranée Métropole ([geo.api.gouv.fr](https://geo.api.gouv.fr/))
- Communes voisines de l'Hérault et du Gard ([geo.api.gouv.fr](https://geo.api.gouv.fr/)), dessinées en terre autour de la
  Métropole : ce qui reste découvert est la mer, en bleu. Fichier `data/context.geojson`, que
  `python3 fetch_data.py --context-only` télécharge seul (sans lui, la carte se construit sans mer)
- Fond de carte : © contributeurs OpenStreetMap, tuiles du serveur officiel (`tile.openstreetmap.org`, sans clé),
  reprojetées dans le repère local du site (voir `site/basemap.js`). Paramètres d'URL : `fond=0` (sans fond), `lignes=0` (sans lignes ni arrêts, case « Lignes et arrêts »),
  `fond=carto` (CARTO Voyager, nécessite une clé d'API), `opacite=20..100`
- Recherche d'adresse côté navigateur : [api-adresse.data.gouv.fr](https://adresse.data.gouv.fr/)
- Aucun service tiers : ni mesure d'audience, ni police chargée ailleurs (Inter est hébergée dans `site/fonts/`,
  SIL Open Font License). Seules les tuiles du fond de carte viennent de `tile.openstreetmap.org`.

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
- `grilles/<id>.json` : temps par case de 50 m, dans le repère de la carte du site, pour l'afficher ; compressés sans
  perte (un octet par case, zlib, base64 : environ 50 Ko au lieu de 1,3 Mo), la carte lit aussi l'ancien format.

Pour les voir sur la carte, lancez le site en local (`python -m http.server 8000 --directory site`), puis
« Résultats r5py › Dossier sortie… » et choisissez le dossier `sortie` : la page y lit les grilles,
`geocodage.csv` et `matrice.csv` (et rien d'autre). « Fichiers… » permet aussi de les choisir un à un, en
plusieurs fois si besoin : les chargements s'additionnent. Les fichiers sont lus par le navigateur et ne sont
envoyés nulle part. La liste qui apparaît
choisit l'adresse de référence : la carte affiche alors sa heatmap et ses isochrones r5py, les points colorés
selon leur temps, et le nombre de points sous chaque isochrone cochée. Un clic sur la carte donne le temps porte
à porte depuis la référence ; déplacer le départ, ou choisir « Carte du site », revient au calcul habituel.

**Voiture.** Dans `references.csv`, une colonne `parking` (`oui`/`non`) et une colonne `type` (`petit ou moyen
commerce`, `marché` ou `grande surface`). Pour chaque référence avec parking, le script calcule aussi les temps en
voiture (r5py, circulation fluide, vitesses tirées d'OpenStreetMap), plus un temps aux extrémités pour rejoindre sa
voiture, se garer et marcher jusqu'au magasin (`--voiture-extremites`, 5 min par défaut). `matrice.csv`,
`comptes.csv` et `isochrones.geojson` gagnent une colonne `mode` (`tc` ou `voiture`) ; les grilles voiture
s'appellent `grilles/<id>__voiture.json`. Sur la carte, la liste « Marche + transports en commun / Voiture » choisit
le mode affiché.

**Vélo.** Pour toutes les références, le script calcule aussi les temps à vélo (r5py) : plus court chemin sur les
rues ouvertes aux vélos (sens uniques respectés, sauf contresens cyclable indiqué dans OpenStreetMap), à vitesse
constante (`--vitesse-velo`, 12 km/h par défaut, sans pente ni feux), plus un temps aux extrémités pour sortir et
garer son vélo et marcher jusqu'au magasin (`--velo-extremites`, 3 min par défaut). R5 classe chaque rue selon le
stress du trafic pour un cycliste (de 1, piste ou rue résidentielle, à 4, grand axe rapide sans aménagement) ; au-delà
de `--stress-velo` (3 par défaut), le cycliste pousse son vélo à pied, à la vitesse de marche, ou fait un détour, selon
ce qui est le plus rapide. Les grilles vélo s'appellent `grilles/<id>__velo.json` ; mode `velo` dans les CSV ;
« Vélo » dans la liste de la carte.

Le calcul est incrémental : ajoutez des lignes à `references.csv` ou `points.csv` et relancez la même commande,
seuls les nouveaux lieux sont calculés (une nouvelle référence : ses temps vers tous les points et sa grille ; un
nouveau point : ses temps depuis toutes les références). Les adresses déjà géocodées ne sont pas recherchées à
nouveau, et un lieu est reconnu à sa position : renommer un `id` ne coûte rien, corriger une adresse la fait
recalculer. Ce qui est déjà calculé est gardé dans `sortie/cache/`. Tout est refait seulement si le GTFS, les rues ou
un réglage (`--date`, `--plage`, `--vitesse-marche`, `--max-minutes`, `--pas` pour les grilles) changent ;
`--tout-recalculer` force un calcul complet.

Options utiles : `--plage 8:00-9:00` (heure de pointe), `--date AAAAMMJJ`, `--vitesse-marche 5`, `--pas 100`,
`--sans-grille` (matrice et comptes seulement, plus rapide). Le premier lancement découpe l'extrait OSM à
l'emprise de la Métropole et construit le réseau (quelques minutes), puis garde les deux en cache. Le GTFS est
copié sans ses fichiers de tarifs, que R5 refuse (pass de plusieurs jours) ; les temps n'en dépendent pas. Les
courses sur réservation (transport à la demande : lignes 27, 28, 31, 35 et 42) sont retirées, comme sur la carte :
seules les lignes régulières comptent.

## Probabilité de faire ses courses en voiture (`tools/modele_voiture.py`)

Pour pondérer les comptes de points selon l'usage probable de la voiture, `tools/modele_voiture.py` combine :

- le comportement, tiré de l'[Enquête Ménages Déplacements 2014](https://data.montpellier3m.fr/dataset/enquete-menages-deplacements-archive)
  (EDGT34, ODbL) : sur les déplacements domicile → commerce des habitants de la Métropole, une régression
  logistique pondérée donne la probabilité de prendre la voiture selon la distance à vol d'oiseau, le nombre de
  voitures du ménage (une, ou deux et plus) et le type de commerce (petit ou moyen commerce, marché, grande surface) ;
  un ménage sans voiture a une probabilité nulle (ses rares trajets comme passager sont négligés) ;
- la motorisation actuelle par IRIS : [recensement 2022](https://www.insee.fr/fr/statistiques/8647012) (INSEE,
  base infracommunale Logement, géographie 2024) et contours IRIS 2024 de l'IGN.

Sources à placer (non versionnées) dans `data/edgt/` (`MMM_MMM_EDGT_DataBrutes.zip`, `MMM_MMM_EDGT_DecoupagesGeo.zip`)
et `data/insee/` (`base-ic-logement-2022_csv.zip`, `CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01.7z`), puis :

```bash
python tools/modele_voiture.py --edgt data/edgt/MMM_MMM_EDGT_DataBrutes.zip --decoupage data/edgt/MMM_MMM_EDGT_DecoupagesGeo.zip --insee data/insee/base-ic-logement-2022_csv.zip --iris data/insee/CONTOURS-IRIS_3-0__GPKG_LAMB93_FXX_2024-01-01.7z
```

Le résultat, `site/data/voiture.json` (versionné, 0,15 Mo), contient les coefficients, la qualité de l'ajustement et,
pour les 160 IRIS de la Métropole, les parts de ménages sans voiture, avec une voiture, avec deux ou plus, et leurs
contours dans le repère de la carte. Limite : le comportement date de 2014, avant la gratuité des transports pour les
habitants (fin 2023) ; les probabilités sont plutôt hautes.
