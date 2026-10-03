# Montpellier selon le temps qu'il faut pour y aller

Carte interactive des temps de trajet en **tram** (et, en option, en **bus**) sur le réseau TaM de Montpellier.

Idée originale : le [NYC Transit Time Cartogram](https://castrio.me/nyc/) d'Anthony Castrio, puis sa
[déclinaison parisienne](https://github.com/JulesGrandin/paris-temps-transport) par Jules Grandin.

Fonctionnalités : heatmap et isochrones depuis un départ déplaçable, arrivée au clic avec itinéraire détaillé
(lignes, correspondances, marche), recherche d'adresse (Base Adresse Nationale) ou de station, tram seul ou
tram + bus, déplacement et zoom de la carte, lien de partage.

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
- Recherche d'adresse côté navigateur : [api-adresse.data.gouv.fr](https://adresse.data.gouv.fr/)

## Modèle

Les temps viennent des horaires GTFS d'un mardi ou jeudi ordinaire, entre 7 h et 20 h :

- durée de chaque inter-station = médiane des durées planifiées ;
- attente = moitié de l'intervalle moyen entre deux passages à l'arrêt (bornée entre 1 et 15 min) ;
- correspondance = 1,5 min de marche + attente de la ligne suivante ; marche possible entre arrêts proches (< 450 m) ;
- marche à pied à 75 m/min (4,5 km/h) à vol d'oiseau, sans pénalité d'accès (arrêts en surface).

Pas de temps réel ni de perturbations. Les trajets à la demande (TaD) sont exclus.
