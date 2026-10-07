# Fase DENUE — Prospección de PdV con INEGI DENUE

> Descubrir, deduplicar y priorizar tiendas reales (dulcerías, abarrotes, minisúper) que **aún no son clientes**, y mostrarlas como **capa de oportunidad** en `dashboard/commercial-map`. Fuente: INEGI DENUE (dato abierto → almacenable con atribución, a diferencia de Mapbox/Google).

Decisión: **ADR-025** (DENUE como fuente primaria de prospección).

## Cómo se le saca el máximo a la API DENUE
4 modos, cada uno para algo distinto:
- **Cuantificar** (`/Cuantificar/{SCIAN}/{area}/{estrato}`) → planeación: contar el universo antes de cosechar.
- **BuscarAreaAct** (`/BuscarAreaAct/.../{clase}/.../{ini}/{fin}/...`) → cosecha sistemática por SCIAN+área, paginada.
- **Buscar** (`/Buscar/{condición}/{lat},{lng}/{metros≤5000}`) → prospección en vivo alrededor de un punto.
- **Ficha** (`/Ficha/{id}`) → enriquecimiento de una unidad.

SCIAN objetivo (configurable por tenant): `461160` dulcerías, `461110` abarrotes/misceláneas, `462112` minisúper/conveniencia.

## Geocerca de Mega Dulces (2026-06-24)
Config sembrada para el tenant Mega Dulces: **entidad 16 (Michoacán)** + **geocerca de 100 km alrededor de La Piedad de Cabadas** (`20.3450, -102.0367`). El servicio filtra cada prospecto por (a) entidad — código en los 2 primeros díg del CLEE — y (b) distancia ≤ `max_radius_km` del centro (haversine). Importa porque **La Piedad colinda con Guanajuato (11)**: sin el filtro de entidad, una cosecha en vivo a 5 km arrastra PdV de Guanajuato. Universo DENUE confirmado: **1,933 dulcerías (461160) en Michoacán**. Columnas `center_lat/center_lng/max_radius_km` en `prospect_sources`, editables por `/prospects/config`.

## Estado de sprints

| Sprint | Tema | Estado |
|---|---|---|
| DENUE.0 | Schema (`commercial.prospect_sources` + `prospect_stores`, RLS) + `DenueClientService` + permisos (`COMMERCIAL_MAP_PROSPECTS_VER/_GESTIONAR`) | ✅ EN CÓDIGO (build verde) |
| DENUE.1 | `ProspectsService` ingest (nearby/area) + cron de re-dedup nocturno | ✅ EN CÓDIGO |
| DENUE.2 | Dedup JS (haversine + Dice bigrams) vs `stores` + `commercial.customers` | ✅ EN CÓDIGO |
| DENUE.3 | Whitespace score (distancia al cliente más cercano + peso SCIAN) | ✅ EN CÓDIGO |
| DENUE.4 | Capa "Tiendas de oportunidad" en el mapa (toggle MapLegend + dialog + cosecha) | ✅ EN CÓDIGO |
| DENUE.5 | Ciclo de conversión + métricas de prospección | ⬜ TODO |
| DENUE.6 | Inteligencia DENUE (opción A): penetración por SCIAN/municipio + densidad + enriquecimiento de clientes + score por estrato | ✅ EN CÓDIGO (builds verdes) |

## Inteligencia DENUE (opción A — exprimir el token sin integrar nada nuevo)
- **Penetración de mercado** `GET /prospects/penetration`: clientes (covered+converted) ÷ universo cosechado, por **giro SCIAN** y por **municipio** (= densidad por territorio). Suma el universo REAL de la entidad por SCIAN vía `Cuantificar`. Cero llamadas extra salvo los 3 Cuantificar.
- **Enriquecimiento de clientes** `POST /prospects/enrich-customers`: reusa el `matched_customer_id` del dedup → copia teléfono/email de DENUE a `commercial.customers` SOLO si están vacíos (nunca sobrescribe). Cero llamadas extra a DENUE.
- **Score por tamaño**: `whitespace_score` = distancia (0..50) + SCIAN (0..30) + `estrato`/tamaño del negocio (0..20).
- Frontend: dialog "Penetración" (tablas por SCIAN y municipio + total) + botón "Enriquecer clientes" en el mapa.

## Aplicado a PROD (2026-06-24)
Verificado contra la DB de prod: las 2 migraciones corrieron en el deploy, tablas creadas, config Mega Dulces sembrada (entidad 16 / La Piedad / 100 km), permisos en superadmin·admin·supervisor. `Cuantificar` confirma **1,933 dulcerías en Michoacán**. Pendiente: `DENUE_TOKEN` en Railway + re-login → cosechar.

## Arquitectura
- **Backend** en `libs/trade/src/lib/commercial-map/`: `denue-client.service.ts`, `prospects.service.ts`, `prospects.controller.ts`, `prospects-refresh.service.ts`. Conexión `KNEX_CONNECTION` (superuser) + `tenant_id` explícito, igual que `CommercialMapService` (el dedup cruza `stores` por search_path legacy + `commercial.customers`).
- **Dedup** 100% en JS (sin extensiones): haversine + similitud Dice sobre bigramas de nombre normalizado. `covered` si hay registro propio a <60 m con nombre similar (o <25 m sin importar nombre).
- **Frontend**: capa aditiva en `commercial-map` reusando `MapLayer` + `MapLegend` (mismo patrón que "Personal en vivo"). Marcador `--action` con `ring`. Click → dialog con detalle + descartar. Botón "Buscar oportunidades aquí" cosecha alrededor del centroide de tiendas visibles.

## Endpoints
`/api/commercial-map/prospects` (GET list · GET counts · GET/PUT config · GET quantify · POST ingest-nearby · POST ingest-area · POST dedup · POST :id/dismiss · POST :id/convert).

## Pendientes operacionales
- [ ] **Aplicar migraciones** newdb: `20260624120000_denue_prospects` + `20260624120100_backfill_prospects_perms_to_roles`.
- [ ] **Re-login** para que los permisos entren al JWT.
- [ ] **`DENUE_TOKEN`** en el entorno (registro gratuito en INEGI). Sin token, `DenueClientService.enabled=false` → la capa funciona pero no cosecha.
- [ ] Configurar `entidad`/SCIAN del tenant (default: dulcerías+abarrotes+minisúper, Sinaloa pendiente de setear).
- [ ] Validación visual + prueba real de cosecha en un municipio piloto.

## Deferred (post-MVP)
- DENUE.5 dashboard de métricas (descubiertos/convertidos/descartados, tasa de conversión).
- Clustering de marcadores (Leaflet markercluster) — crítico al cosechar municipios completos.
- Cron de cosecha trimestral automática (hoy la cosecha es on-demand).
- Fuente secundaria OSM/Overpass para huecos de DENUE.
- CTA "Dar de alta" que cree el cliente inline (hoy el alta es vía módulo de clientes).
