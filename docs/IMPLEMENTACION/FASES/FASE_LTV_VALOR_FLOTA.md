# Fase LTV — Valor sobre la flota (lo que MagniTracking no da)

> **Estado:** 🟢 LTV.0 + LTV.1 + LTV.3 + LTV.5 + LTV.7 CONSTRUIDOS (beta) local 2026-07-28 ·
> LTV.2/4/6 🔨 diseñados (planeación, gated por data). Depende de Fase LT (rastreo ✅).
>
> **LTV.5 productividad** (commit 96d0b81d): `FleetProductivityService` deriva de LTV.0 —
> tiempos muertos (paradas ≥20min sin cliente), productivas vs muertas, km/entrega.
> `GET /logistics/tracking/productivity?date`. Smoke 3/3.
> **LTV.7 alertas de negocio** (commit 1c1dd9ef): regla `stopped_with_pending` en el
> scanner de `fleet_alerts` (detenida + su embarque de hoy con recipients pendientes).
> Mig `20260728160000` amplía el CHECK de kind. Smoke 3/3. Diferidos (gated por coords/
> config): off_route_zone, late_dispatch, returned_incomplete.
>
> **Construido (2026-07-28):** LTV.0 keystone (`logistics.vehicle_stops` +
> `vehicle_day_summary`, mig `20260728120000`, `TripBuilderService` + cron nocturno +
> endpoints; smoke 8/8) · LTV.1 cumplimiento (`RouteAdherenceService`, endpoint
> `GET /logistics/tracking/adherence` + panel en `/logistica/rastreo`; smoke 7/7) ·
> LTV.3 POD georef (`PodGeoAuditService` en libs/trade → `supervisor_findings`
> `pod_far_from_customer`/`pod_no_gps`, cron nocturno, ADR-020 bandeja-only; smoke 5/5).
> Commits ff0d1d7d/b71f90b2/a3219a03/733333d9. **Pendiente prod:** aplicar mig
> `20260728120000` a Railway (las de LT ya están). **Bloqueo de valor #1:** solo
> 5/2970 clientes tienen coords → geocodificar la cartera de reparto activa el match.
> **Tesis:** el GPS crudo es commodity (MagniTracking lo vende igual a todos). Nuestro moat
> es **fusionar la posición con el cerebro comercial/logístico** — pedidos, clientes, rutas
> planeadas, POD, costos, ventas. Ellos saben *dónde está la unidad*; nosotros *qué lleva, a
> quién debía visitar, si cumplió y cuánto costó*. Hereda ADR-016 (motor decide / LLM fuera)
> y ADR-020 (fraude → bandeja, nunca acción automática).

---

## Restricciones de datos que ordenan TODO el diseño (leer primero)

Descubierto en recon 2026-07-28 (contratos exactos abajo). Estas 4 restricciones aplican a
todos los puntos:

1. **El GPS se ata a la operación SOLO por `vehicle_id` + ventana de tiempo.** `logistics.trackers`
   y `logistics.vehicle_positions` NO tienen `shipment_id`/`order_id`. El puente es
   `vehicle_id` (común a `shipments`, `fuel_transactions`, `vehicle_usage_logs`, `home_deliveries`,
   `trackers`, `positions`) cruzado por fecha/hora. Todo join "GPS ↔ entrega" es por `vehicle_id`
   + `captured_at ∈ [departure_at, arrival_at]`.
2. **Geocercas = haversine en JS**, no PostGIS ni las funciones earthdistance (esas existen solo
   como índices, cero queries las usan). Reusar el patrón vivo: `map-matching.service.ts`
   (`STOP_RADIUS_M=40`, `STOP_MIN_MINUTES=5`, `GEOFENCE_M=90`) y `reports.service.ts` haversine.
3. **Cobertura de coordenadas dispar.** `public.stores.latitud/longitud` (7dp, **español**) están
   **poco pobladas**; `commercial.customers.latitude/longitude` (6dp) sí se geocodifican
   (`geocode-mapbox.js`). ⇒ para "¿entregó donde debía?" el punto esperado sale de
   `customers`, no de `stores`. Coord faltante = punto no evaluable (marcar, no inventar).
4. **Dos modelos de ruta en paralelo** — no unificar, elegir por caso:
   - **Trade:** `stores.ruta_id`→`catalogs('rutas')` + `daily_assignments` (plantilla semanal por
     `day_of_week`, sin fecha).
   - **Comercial/logística:** `customers.route_id`→`logistics.routes`, `customers.sales_route`
     (texto), `customers.visit_days[]`, `customers.visit_sequence`; snapshot en `orders.route_id`.
   - **Dos stacks de entrega:** ruta/camión = `logistics.shipments` + `delivery_guides` +
     `guide_recipients`; última milla/moto = `commercial.home_deliveries` (Fase LM lo movió acá).
     Los trackers de hardware están en los **camiones de ruta** ⇒ POD relevante = `guide_recipients`.

TZ siempre `America/Mexico_City` (offset fijo -06:00 desde 2022). Tablas de telemetría sin RLS
⇒ filtrar `tenant_id` a mano.

---

## LTV.0 — Fundación: reconstrucción de viajes y paradas (keystone)

**Por qué primero:** los puntos 1, 2, 5 y 6 necesitan lo mismo — segmentar el rastro crudo
(`vehicle_positions`) en **paradas** (dónde estuvo detenido y cuánto) y un **resumen diario por
vehículo** (km recorridos, tiempo en movimiento/detenido, primera salida, última parada). Se
construye una vez y todos consumen.

**Fuentes:** `logistics.vehicle_positions` (lat/lng/captured_at/vehicle_id/speed_kmh/odometer/ignition).

**Schema nuevo (2 tablas, RLS estándar, mig `2026072819xxxx`):**
- `logistics.vehicle_stops` — `id, tenant_id, vehicle_id, arrived_at, left_at, lat, lng, minutes,
  matched_customer_id (nullable), matched_store_id (nullable), match_distance_m, is_customer bool`.
  UNIQUE `(tenant_id, vehicle_id, arrived_at)`.
- `logistics.vehicle_day_summary` — `id, tenant_id, vehicle_id, day date, km_driven numeric,
  moving_min int, stopped_min int, offline_min int, stops_count int, customer_stops int,
  first_move_at, last_stop_at, max_speed_kmh int`. UNIQUE `(tenant_id, vehicle_id, day)`.

**Backend** (`libs/logistics/logistics-tracking/`):
- `TripBuilderService.buildForDay(vehicleId, day)` — lee positions del día ordenadas por
  `captured_at`; **paradas** = corridas de puntos dentro de `STOP_RADIUS_M=40` por ≥
  `STOP_MIN_MINUTES=5` (adaptar `map-matching.computeStops`); **km** = suma de haversine entre
  fixes consecutivos (o `odometer` fin−inicio si viene confiable, con fallback a haversine);
  **matched_customer** = cliente más cercano con coords dentro de `GEOFENCE_M=90` (haversine sobre
  `commercial.customers` con `latitude` no nula, del tenant). UPSERT idempotente.
- `TripBuilderScannerService` `@Cron('0 30 3 * * *')` (3:30 AM MX) reconstruye el día anterior de
  todos los vehículos con actividad. Reusa `KNEX_NEW_DB` + `SET LOCAL app.tenant_id` por tenant.
- Endpoint `POST /logistics/tracking/trips/rebuild?vehicle_id&date` (GESTIONAR) para recomputar.

**Verificación:** smoke que corre `buildForDay` sobre la data real ya cargada (50 trackers) y
asserta stops_count>0, km_driven>0, y que ≥1 parada matchea un cliente con coords.

**Esfuerzo:** M. **Riesgo:** cobertura de coords (muchas paradas quedarán sin `matched_customer`;
es esperado, se reporta como "parada no identificada").

---

## LTV.1 — Cumplimiento de ruta: plan vs real

**Objetivo:** por unidad/día, *¿visitó los clientes que le tocaban? ¿en qué orden? ¿cuáles saltó?
¿hubo paradas fuera de ruta?* — auditoría de ejecución de reparto (ADN del proyecto).

**Fuentes:** `logistics.vehicle_stops` (LTV.0) · plan del día: por **ruta comercial** =
`commercial.customers` con `route_id` = `shipments.route_id` de la unidad ese día (o
`sales_route` + `visit_days @> [hoy]` + orden `visit_sequence`) · coords cliente
`customers.latitude/longitude`.

**Schema:** ninguno nuevo — se computa sobre `vehicle_stops` + `customers`. Opcional cachear en
`vehicle_day_summary.plan_json` (planned/visited/skipped) para lectura rápida.

**Backend:**
- `RouteAdherenceService.forVehicleDay(vehicleId, day)`:
  1. Resolver el **plan**: clientes esperados = los de la(s) ruta(s) que la unidad sirvió ese día
     (`shipments.vehicle_id=? AND shipment_date=? → route_id → customers.route_id`), ordenados por
     `visit_sequence`.
  2. Resolver lo **real**: `vehicle_stops.matched_customer_id` del día.
  3. Cruce → `visited[]`, `skipped[]` (plan − real), `off_route[]` (paradas ≥5min sin cliente
     matcheado), `coverage_pct`, `sequence_adherence` (orden real vs `visit_sequence`, Kendall-tau
     o simple % en-orden).
- Endpoint `GET /logistics/tracking/adherence?vehicle_id&date` y
  `GET /logistics/tracking/adherence/route?route_id&date`.

**Frontend:** pestaña/sección en `/logistica/rastreo` (o nueva `/logistica/cumplimiento`):
tabla densa Operations por unidad — `coverage_pct` (barra), visitados/plan, saltados (chips
clickeables → cliente), paradas fuera de ruta; y en el mapa, el recorrido + pins verdes
(visitado) / rojos (saltado) / ámbar (fuera de ruta). Reusa `app-map` `[path]`+`[markers]`.

**Verificación:** smoke con un vehículo que tenga shipment+route+clientes con coords; asserta
coverage y que un cliente sin parada aparece en `skipped`.

**Dependencias:** LTV.0. **Riesgo:** depende de coords de clientes + de que el shipment ligue
vehículo↔ruta↔día. Donde falte, degradar a "plan por `stores.ruta_id`" o marcar no-evaluable.
**Esfuerzo:** M.

---

## LTV.2 — Costo real y ROI por entrega / ruta / cliente

**Objetivo:** $/entrega, costo-por-km, margen por ruta y **clientes que cuestan más de lo que
dejan**. El argumento de dirección.

**Fuentes:** km = `vehicle_day_summary.km_driven` (LTV.0) · combustible = `logistics.fuel_transactions`
(`liters`, `amount`, `odometer_km`) + `vehicles.fuel_efficiency_km_l` · entregas =
`guide_recipients` (status='entregado', count) / `home_deliveries` · ingreso =
`analytics.sales_by_route_monthly.revenue` (por ruta) o `commercial.orders.total` (fulfilled, vía
`shipments.order_id`) · costos operativos de `logistics.config_finance` (costo_km, viáticos) y
`delivery_guides` (comisiones chofer/ayudante, `per_diem_total`).

**Schema nuevo (1 tabla resumen, mig):** `analytics.delivery_cost_daily` —
`tenant_id, vehicle_id, route_id (nullable), day, km_driven, fuel_cost, driver_cost, other_cost,
total_cost, deliveries, revenue, margin GENERATED (revenue-total_cost), cost_per_delivery
GENERATED`. UNIQUE `(tenant_id, vehicle_id, route_id, day)`. Sin RLS (patrón analytics) o RLS —
decidir; alineamos con `sales_daily` (tiene tenant_id explícito).

**Backend:**
- `DeliveryCostService` (nuevo, en `commercial-analytics` o `logistics-analytics`) que arma
  `delivery_cost_daily` desde las fuentes; `@Cron` nocturno tras LTV.0.
  - `fuel_cost` del día: prorratear `fuel_transactions.amount` o estimar `km_driven /
    fuel_efficiency_km_l × precio_litro` (parámetro en `config_finance`).
  - `driver_cost` = comisiones de las `delivery_guides` de esa unidad/día + prorrateo de viáticos.
- Endpoints: `GET /commercial/analytics/delivery-cost?from&to&group_by=route|vehicle|customer`.
  Costo-por-cliente = repartir `total_cost` de la parada entre los pedidos de ese cliente
  (heurística: por # de paradas o por valor).

**Frontend:** cards `MetricStrip` (costo/entrega, costo/km, margen ruta) + tabla ranking rutas y
"clientes no rentables" (margen negativo) navegable al cliente. Superficie Operations.

**Verificación:** smoke que arma un día sintético (km + fuel + guías + revenue) y asserta
`cost_per_delivery` y `margin` correctos.

**Dependencias:** LTV.0 (km) + que combustible/costos estén cargados (hoy `fuel_transactions`
puede estar vacía → degradar a estimación por rendimiento). **Esfuerzo:** L. **Nota:** es el punto
de mayor valor ejecutivo pero el más sensible a data faltante (combustible/costos).

---

## LTV.3 — Prueba de entrega georreferenciada (anti-fraude POD)

**Objetivo:** *¿el POD "entregado" se marcó realmente en el domicilio del cliente?* Detecta POD
falsos (marcado entregado lejos del cliente). MagniTracking no tiene POD → no puede.

**Fuentes:** `logistics.guide_recipients` (`gps_lat/gps_lng` capturados al entregar, `delivered_at`,
`status='entregado'`, `customer_id`) · punto esperado `commercial.customers.latitude/longitude` ·
refuerzo con GPS del camión: `vehicle_positions` de esa unidad en `delivered_at ± 5min`.
(Análogo para `commercial.home_deliveries.gps_lat/gps_lng` + `shipment_photos.gps_lat/gps_lng`.)

**Schema:** ninguno nuevo — **reusar Horus**: escribir a `commercial.supervisor_findings`
(`finding_type='pod_gps_mismatch'`, `source='fraud'`, `subject_type='collaborator'` = chofer,
`evidence` con distancia/coords, idempotente por `dedup_key`). Respeta ADR-020: va a la **bandeja**,
no dispara acción.

**Backend:**
- `PodGeoAuditService.auditDay(day)` (en `libs/trade` junto a `FraudEngineService`, o en
  logistics con sink `FINANCE/HORUS_FINDINGS`): para cada `guide_recipient` entregado con
  `gps_lat/lng`: `d1 = haversine(pod, customer_coords)`; `d2 = haversine(pod, truck_pos@delivered_at)`.
  - `d1 > 300m` (cliente tiene coords) → hallazgo `pod_far_from_customer`.
  - `d2 > 500m` (camión lejos del punto POD) → hallazgo `pod_without_truck` (POD marcado sin la
    unidad ahí).
  - POD sin `gps_lat/lng` → hallazgo `pod_no_gps` (data quality).
- Reusa `FraudEngineService` thresholds/haversine (`fraud-engine.service.ts:41-50`) y su UPSERT
  idempotente que preserva decisiones humanas.
- `@Cron` nocturno tras el cierre del día. Aparece en la bandeja Horus existente.

**Frontend:** ya existe la bandeja de `supervisor_findings` (Horus) — los hallazgos POD salen ahí
con evidencia (mapa mini: pin POD vs pin cliente vs pin camión). Opcional: badge en
`/logistica/rastreo`.

**Verificación:** smoke con un recipient entregado a >300m del cliente → asserta 1 finding
`pod_far_from_customer`; y uno correcto → 0.

**Dependencias:** coords de cliente (para d1) — si faltan, d2 (camión) sigue siendo evaluable.
**Esfuerzo:** M. **Alto valor / bajo costo** (reusa Horus casi entero).

---

## LTV.4 — ETA por pedido + aviso proactivo al cliente

**Objetivo:** ETA **a cada cliente** (no a un punto genérico) y disparar WhatsApp *"tu pedido llega
en ~20 min"*. Cierra los TODO ya marcados en `alerts.service.ts:179,203`.

**Fuentes:** posición viva `logistics.trackers.last_lat/last_lng` (camión) o rider en
`home_deliveries` · destino `customers.latitude/longitude` (o `delivery_address`/
`guide_recipients`) · secuencia de paradas restantes (plan LTV.1) · `orders.promised_eta_min`
(existe, hoy sin usar).

**Schema:** ninguno (ETA es efímera, se calcula on-the-fly). Opcional `home_deliveries.eta_at`
para persistir el último ETA notificado + anti-spam.

**Backend:**
- `EtaService.forVehicle(vehicleId)`: distancia restante a cada parada pendiente en orden;
  ETA MVP = `Σ haversine / velocidad_promedio` (parámetro) + dwell estimado por parada. Fase 2:
  Mapbox Directions (ya hay `project_mapbox_capabilities`, gotcha token).
- Endpoint `GET /logistics/tracking/eta?vehicle_id` y `GET /commercial/home-delivery/:orderId/eta`.
- **Aviso WhatsApp:** nuevo builder sobre `WhatsAppQueueService.enqueue({dir:'out'})` (precedente
  `whatsapp-orders.service.ts confirm()`), disparado cuando ETA < umbral (ej. 15 min) con cooldown
  anti-spam. Gated por plantilla Meta aprobada. Llena los TODO de `alerts.service.ts`.

**Frontend:** en `home-delivery-tracking.component` (que ya poll cada 15-30s + WS `route_ping`)
mostrar la columna **ETA** por pedido (hoy solo muestra frescura). Reusa el mapa vivo existente.

**Verificación:** smoke de `EtaService` con posición fija y 2 clientes → asserta ETA monotónico por
orden; test del builder WhatsApp (enqueue out) sin enviar a Meta.

**Dependencias:** coords cliente + (para envío real) creds Meta + plantilla. **Esfuerzo:** M
(MVP haversine) / L (con Mapbox Directions).

---

## LTV.5 — Productividad y tiempos muertos de la flota

**Objetivo:** tiempo en tienda vs traslado, km por entrega, paradas productivas vs improductivas —
lo que ya hacemos para vendedores (`ReportsService.getRouteIdle`), traído a la flota de reparto.

**Fuentes:** `vehicle_stops` + `vehicle_day_summary` (LTV.0) · matched_customer para clasificar
parada productiva (cliente) vs improductiva (sin cliente, >umbral).

**Schema:** ninguno (deriva de LTV.0). Métricas: `moving_min`, `stopped_min`, `dead_min` (paradas
improductivas > `IDLE_DEAD_THRESHOLD_MIN=20` sin cliente), `km_per_delivery`, `stops_productive/total`.

**Backend:** `FleetProductivityService.forVehicleDay/forFleetDay` — reusa la lógica de
`computeIdleSegments`/`refineIdleWithPings` (`reports.service.ts:1621-1815`) adaptada a
`vehicle_stops`. Endpoint `GET /logistics/tracking/productivity?from&to&group_by`.

**Frontend:** sección en `/logistica/rastreo` o en el dashboard de logística — barras
movimiento/detenido/muerto por unidad, ranking de tiempos muertos, drill a las paradas
improductivas en el mapa.

**Verificación:** smoke asserta `moving+stopped == día` y que una parada larga sin cliente cuenta
como `dead_min`.

**Dependencias:** LTV.0. **Esfuerzo:** S-M (reusa mucho). **Solapa con LTV.1** — se pueden
entregar juntas en la misma pantalla.

---

## LTV.6 — Anti-pilferaje de combustible

**Objetivo:** cargas de combustible que no cuadran con el km real → señal de robo de diesel.
Imposible sin cruzar `fuel_transactions` con el GPS.

**Fuentes:** `logistics.fuel_transactions` (`liters`, `odometer_km`, `loaded_at`, `vehicle_id`) ·
km real = `vehicle_day_summary.km_driven` acumulado entre cargas · `vehicles.fuel_efficiency_km_l`
esperado · `vehicle_usage_logs.check_in_km/check_out_km` como cross-check del odómetro.

**Schema:** reusar `commercial.supervisor_findings` (Horus, `source='fraud'`,
`finding_type='fuel_anomaly'`, `subject_type='collaborator'` o `'vehicle'`). ADR-020: bandeja, no
acción.

**Backend:** `FuelAuditService.auditVehicle(vehicleId, window)`:
- Rendimiento observado entre 2 cargas = `km_real(GPS) / litros_cargados`; si
  `< eficiencia_esperada × 0.6` (umbral) o si `odometer_km` de la carga discrepa del GPS acumulado
  más allá de tolerancia → hallazgo con evidencia (litros, km GPS, km odómetro, rendimiento).
- `@Cron` semanal. Idempotente por `dedup_key`.

**Frontend:** bandeja Horus (reusa). Opcional card en costos (LTV.2).

**Verificación:** smoke con una carga cuyo km GPS ≪ litros esperarían → asserta finding.

**Dependencias:** LTV.0 (km) + `fuel_transactions` con data real (hoy probablemente vacía → el
punto queda listo pero inerte hasta que se capturen cargas). **Esfuerzo:** M.

---

## LTV.7 — Alertas de negocio (no técnicas)

**Objetivo:** subir de alertas técnicas (velocidad/offline, ya en Fase LT `fleet_alerts`) a
**alertas que entienden la operación**: *"R-22 lleva 2h detenida con 6 pedidos sin entregar"*,
*"unidad fuera de su zona de ruta"*, *"CEDIS despachó 45 min tarde"*, *"cliente VIP sin visita y
la unidad ya volvió"*.

**Fuentes:** `fleet_alerts` (base LT.6) + cruces: pedidos pendientes de la unidad
(`guide_recipients` status≠entregado del shipment activo), plan LTV.1 (fuera de zona), hora de
salida real (primera salida de geocerca CEDIS vs `shipments.shipment_date`/hora planeada).

**Schema:** extender `logistics.fleet_alerts.kind` (CHECK) con nuevos tipos:
`stopped_with_pending`, `off_route_zone`, `late_dispatch`, `returned_incomplete`.

**Backend:** extender `FleetAlertsScannerService` (LT.6) con estas reglas (todas deterministas):
- `stopped_with_pending`: `last_status='stopped'` > N min **y** el shipment activo de la unidad
  tiene recipients pendientes.
- `off_route_zone`: `last_lat/lng` a > R km del centroide/bbox de la ruta asignada (haversine).
- `late_dispatch`: primera salida de la geocerca del almacén (`warehouses` coords) posterior a la
  hora de corte (parámetro).
- Emitir a la bandeja `fleet_alerts` **y** opcionalmente push por WS reusando `AlertsGateway`
  (`/alerts`, room `tenant:<id>`, event `alert`) — vía el `FLEET_NOTIFIER_PORT` diferido en LT
  (libs/logistics no importa commercial; el port lo implementa el app-shell).

**Frontend:** ya se muestran en `/logistica/rastreo` (strip de alertas de LT.6) — solo aparecen los
tipos nuevos.

**Verificación:** smoke por regla (unidad detenida + recipient pendiente → alerta).

**Dependencias:** LT.6 (hecho) + LTV.1 (para off_route). **Esfuerzo:** M.

---

## Orden sugerido de construcción (por valor × dependencia)

```
LTV.0 (fundación)  ─┬─→ LTV.1 (cumplimiento) ─┬─→ LTV.5 (productividad)  [misma pantalla]
                    │                          └─→ LTV.7 (alertas negocio)
                    ├─→ LTV.2 (costo/ROI)         [gate: combustible/costos cargados]
                    └─→ LTV.6 (anti-pilferaje)    [gate: fuel_transactions con data]
LTV.3 (POD georef)  ── independiente, reusa Horus ── ALTO VALOR / BAJO COSTO
LTV.4 (ETA+WhatsApp) ── independiente, reusa home-delivery UI + WhatsApp queue
```

**Recomendación de arranque:** **LTV.0 + LTV.1 + LTV.3** como primer bloque — convierten el GPS en
*auditoría de ejecución de reparto* (ADN del proyecto), usan data que ya existe (positions +
customers geocodificados + POD en guide_recipients), y LTV.3 reusa Horus casi entero. LTV.2 (ROI)
es el mejor pitch a dirección pero espera a que combustible/costos estén cargados.

## Riesgos transversales
- **Cobertura de coordenadas** (stores vacío, customers parcial): limita LTV.1/3/4. Mitigación:
  degradar a no-evaluable + priorizar geocodificación de clientes de reparto.
- **`fuel_transactions`/costos vacíos:** LTV.2/6 quedan listos pero inertes hasta capturar data.
- **Join solo por `vehicle_id`+tiempo:** un vehículo con doble tracker (GPS+dashcam) ya está
  deduplicado por `vehicle_id` (Fase LT bootstrap); ok.
- **Volumen de `vehicle_positions`:** LTV.0 nocturno + retención/partición cuando crezca.
- **ADR-020:** LTV.3/6 (fraude) SOLO alimentan bandeja con evidencia; nunca acción automática ni
  acusación por el LLM.
