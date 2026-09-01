# GeoLibre

GeoLibre (github.com/opengeos/GeoLibre) is a **client-side, browser-first GIS
application** (Tauri v2 + React + MapLibre GL + DuckDB-WASM Spatial + deck.gl) —
not a backend service. It is provisioned in `docker-compose.extended.yml` as the
**official published web image** `ghcr.io/opengeos/geolibre:latest` (nginx +
bundled Python conversion sidecar), configured entirely via environment
variables (`GEOLIBRE_SHARE_URL=off`, `GEOLIBRE_CONVERSION_ROOTS=/data`), so this
directory intentionally contains no config files.

- Runs at http://localhost:8180
- Mount geodata into the `geolibre-data` volume (`/data`) for the raster/conversion tools
- No server-side metrics endpoint exists; nothing is scraped (see extended/README.md §4)
