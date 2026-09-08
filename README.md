# Naples / Campi Flegrei — Ground Motion Visualizer

An interactive 3D map that shows how the ground is moving around Naples, Italy — built entirely from free, open satellite and map data.

### 🔗 View it live: **https://nellchris.github.io/naples-hazard-visualizer/**

*(Works best on a desktop browser. The first press of “Animate” takes a few seconds to load five years of data.)*

---

## What this shows

Just west of Naples sits **Campi Flegrei**, an active volcanic caldera underneath the town of Pozzuoli and one of the most densely populated volcanic areas in Europe. The ground there is slowly rising — a phenomenon called **bradyseism**, driven by pressure from fluids and magma deep underground. Between 2020 and 2024 the centre of the caldera rose by roughly **700 mm**, and it is still rising, faster each year.

This map lets you *see* that movement. It combines three layers into one 3D scene in your browser:

- **Ground motion** — satellite radar measurements of how fast each spot is rising or sinking. Around Pozzuoli the ground is going up by as much as **145 mm per year**.
- **Terrain** — the real shape of the land, including Vesuvius and the surrounding hills.
- **Buildings** — the city’s footprints, for context, so you can see the urban area sitting on top of the moving ground.

## How to use it

Once the map loads, an intro panel explains what you’re looking at (you can reopen it any time with the **?** button). The main things you can do:

- **Drag** to move, **scroll** to zoom, **right-click-drag** to tilt into 3D.
- **Vertical / East–West toggle** — switch between two kinds of movement: up-and-down (the caldera bulging upward) and sideways (the ground spreading outward from the centre).
- **Animate** — press play to watch the ground inflate across 2020–2024. The rise visibly speeds up toward the end — that acceleration is the real signal, not an effect.
- **Zoom in** to bring in the buildings — they only appear once you’re close enough to see individual streets, so an empty city at wide zoom is intentional.
- **Click any point** to see its full history — how much that exact spot moved, month by month.
- **Light / Dark** basemap toggle — the terrain relief reads best on the light map.

## How it’s built

Everything uses **free and open-source data and tools**, and the whole thing runs as a static website — no server, no database.

The three data layers come from public sources:

| Layer | Source |
|---|---|
| Ground motion | **EGMS** — the European Ground Motion Service, which publishes ready-made satellite radar (InSAR) measurements for all of Europe |
| Terrain | **Copernicus DEM** — a free global elevation model |
| Buildings | **OpenStreetMap** building footprints |

The project has two clean halves. A **data pipeline** (Python) downloads the raw data, trims it to the Naples area, and converts it into web-ready files — this runs once, on my machine. The **web app** (built with MapLibre GL JS and deck.gl for WebGL rendering) then just reads those prepared files in the browser. Full setup and reproduction steps are in [`pipeline/README.md`](pipeline/README.md).

### The one thing that made it possible

Getting satellite radar ground-motion data normally means processing raw radar images yourself — a heavy, specialist job. The key move here was using **EGMS**, which has already done that processing and publishes the finished measurements for free. That single substitution turned the hardest part of the project into a straightforward download, and it’s what let the whole thing be built on open data.

## Data sources & credit

- **EGMS** © European Union, Copernicus Land Monitoring Service / European Environment Agency.
- **Copernicus WorldDEM-30** © DLR e.V. 2010–2014 and © Airbus DS GmbH 2014–2018, provided under COPERNICUS by the EU and ESA.
- **Building data** © OpenStreetMap contributors (ODbL).

---

*Exploring how open geospatial data can make environmental hazards visible and understandable.*
