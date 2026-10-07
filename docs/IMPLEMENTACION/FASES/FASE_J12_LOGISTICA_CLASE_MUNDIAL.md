# Fase J12 — Logística de clase mundial

> Plan de implementación para cerrar la brecha contra Samsara / Onfleet / Fleetio / project44,
> respetando el caso real de Mega Dulces (flota propia, ~34 unidades, reparto local MX).
> Origen: benchmark 2026-06-22 + análisis de samsara.com.

---

## Tesis estratégica (ADR-025 propuesto)

**"Compra el commodity, construye la ventaja."**

- **Comprar / integrar** lo que es infraestructura estandarizada y no es diferenciador:
  timbrado fiscal (PAC), hardware GPS/OBD, motor de optimización de ruta (API).
- **Construir** lo que ya es tu foso vertical y nadie global cubre:
  integración pedido→entrega→cobro, nómina de cuadrilla MX, costeo por viaje, dominio MX.

Lección de Samsara: ellos apilan cámaras + telemetría + ruteo sobre **un hardware en la unidad**.
No intentamos *ser* Samsara; usamos su modelo y conservamos nuestra integración de negocio,
que es lo que ellos NO tienen (no tocan tu inventario ni tu cobro).

Nivel de ambición: NO replicar telematics enterprise. Alcanzar "lo que un operador de flota
propia espera hoy, y lo que su cliente B2B puede exigir".

---

## Orden por retorno (no por dificultad)

| # | Sprint | Brecha que cierra | Estrategia | Estado | Esfuerzo |
|---|---|---|---|---|---|
| 1 | **J12.0** Carta Porte vía PAC | Cumplimiento fiscal (LEGAL) | Integrar | ⬜ | 2–3 sem |
| 2 | **J12.1** Rastreo en vivo (puente web) | Rastreo en tiempo real | Construir (reuso) | ⬜ | 2 sem |
| 3 | **J12.2** Avisos de entrega + POD al cliente | Rastreo/avisos al cliente | Construir + BSP | ⬜ | 2–3 sem |
| 4 | **J12.3** Optimización de ruta del día | Planeación de ruta | Integrar API + UI | ⬜ | 3–4 sem |
| 5 | **J12.4** ETA (heurístico → histórico) | ETA predictivo | Construir | ⬜ | 1–2 sem |
| 6 | **J12.5** Telemetría hardware | Telemetría / IoT | Comprar hardware | ⬜ | capital |
| 7 | **J12.6** Mantenimiento + combustible (Fleetio-level) | Mantenimiento / fuel | Construir s/telemetría | ⬜ | 2–3 sem |
| 8 | **J12.7** Dashboard de ROI + API pública | Plataforma / GTM | Construir | ⬜ | 1–2 sem |

Dependencias: J12.4 requiere J12.1 + J12.3 · J12.6 requiere J12.5 · J12.2 requiere decisión BSP (ADR-006, ver `FASE_F_WHATSAPP_BOT.md`).

---

## Reglas técnicas aplicables a TODO sprint
(de la memoria del proyecto — no re-aprender a golpes)

- Tablas nuevas: `tenant_id UUID NOT NULL` + FK a `public.tenants` + composite unique `(tenant_id, id)` + **RLS forzado** + grants `app_runtime`. Schema `logistics.*`. Migraciones en `database/migrations-newdb/`, idempotentes (`hasTable`/`hasColumn`).
- Handlers de request: **`TenantKnexService.run()` obligatorio** (SET LOCAL app.tenant_id) o `app_runtime` ve 0 rows. `KNEX_NEW_DB_ADMIN` solo para cron cross-tenant.
- Permiso nuevo ⇒ (1) enum back + front, (2) **mapear en `ability.factory` + `ability.types`** (si no → 403), (3) seed roles, (4) **migración backfill** `KEY IS NULL`, (5) **re-login obligatorio** (permiso vive en el JWT).
- Prod: **nunca** insertar en `knex_migrations` a mano. Reiniciar API tras cambios de módulo. Avisar antes de levantar dev servers.
- Cero comentarios largos. snake_case EN para columnas/rutas nuevas.

---

## J12.0 — Carta Porte vía PAC  ⬜  [LEGAL · prioridad #1]

**Por qué primero:** obligatorio desde 17-jul-2024, multa hasta **$97,330 MXN/documento**, hoy emitimos cero. Riesgo activo. Y el modelo de datos ya tiene ~80% de lo necesario.

**Decisión a tomar (ADR-026):** elegir PAC. Candidatos con API REST: **Facturama**, Prodigia, Contpaqi. Criterio: API limpia, soporte Carta Porte 3.1, sandbox. → recomendado arrancar con Facturama (API documentada).

### Schema (`logistics.*` + `catalog`)
```
catalog.sat_product_keys     -- clave ClaveProdServ SAT por producto (o columna en catalog.products)
logistics.cartaporte_documents
  id, tenant_id, shipment_id FK, guide_id FK NULL,
  uuid_fiscal (folio SAT), status (borrador|timbrado|cancelado|error),
  xml_url (Cloudinary/S3), pdf_url, pac_provider, pac_response JSONB,
  total_distance_km, sct_permit_type, sct_permit_number,
  stamped_at, error_message, audit fields
  RLS forzado
```
ALTER existentes (idempotente):
- `logistics.vehicles`: `config_vehicular` (clave SAT CveConfigAutotransporte), `seguro_aseguradora`, `seguro_poliza`.
- `logistics.drivers`: ya tiene `rfc`, `federal_license` → mapear a Figura Transporte.
- `catalog.products` o tabla puente: `clave_prod_serv_sat`, `clave_unidad_sat`.

### Backend — módulo `libs/logistics/.../logistics-cartaporte`
- `PacService` (puerto): `stamp(payload)`, `cancel(uuid)`, contra Facturama.
- `CartaPorteService`: arma el complemento desde shipment + guide + recipients + vehicle + drivers; valida campos obligatorios antes de timbrar; persiste XML/PDF en Cloudinary.
- Endpoints:
  - `POST /logistics/cartaporte/from-shipment/:id` — genera y timbra.
  - `GET  /logistics/cartaporte/:id` — estado + links XML/PDF.
  - `POST /logistics/cartaporte/:id/cancel` — cancela ante SAT.
  - `GET  /logistics/cartaporte` — listado/auditoría.
- Permiso: `LOGISTICS_CARTAPORTE_GESTIONAR`, `LOGISTICS_CARTAPORTE_VER`.

### Frontend
- En el detalle de embarque: tab/botón "Carta Porte" → validar datos faltantes (clave SAT, permiso SCT) → timbrar → mostrar XML/PDF descargable.
- Catálogo: capturar clave ProdServ SAT por producto (one-time backfill + UI).

### Riesgos / done
- Datos faltantes hoy: clave ProdServ SAT por producto, permiso SCT, config vehicular. → tarea de captura previa.
- **Done:** timbrar un embarque real en sandbox PAC, descargar XML/PDF válidos, cancelar OK.

### Ejecución (log)
- **2026-06-22 — gap analysis cerrado** contra schema real de prod. 6 huecos: emisor fiscal, claves SAT en productos, datos fiscales de vehículo, domicilios estructurados, permiso SCT, itemización de mercancías.
- **2026-06-22 — schema escrito** (NO aplicado a prod): `migrations-newdb/20260622120000_logistics_cartaporte.js`. Crea `carrier_fiscal_profile` + `cartaporte_documents`; ALTER vehicles (config/seguros), products (claves SAT), warehouses/guide_recipients (`fiscal_address` jsonb).
- **2026-06-22 — decisiones (ADR-026):** PAC = **Facturama** · CFDI = **Traslado** (mercancía propia, emisor=receptor) · nivel = **por embarque**.
- **2026-06-22 — migración aplicada a LOCAL** (`localhost:5433`, batch 124). Fix: FK a `identity.tenants` (no `public.tenants` que es vista passthrough). Verificado: 2 tablas + 9 columnas + RLS forzado. **Prod aún sin aplicar.**
- **2026-06-22 — módulo backend scaffolded** `libs/logistics/.../logistics-cartaporte/`: `PacService` (puerto Facturama vía fetch+env), `LogisticsCartaporteService` (emisor CRUD + `validateShipment` que devuelve gaps + `buildComplement` + `stampShipment` + persistencia), controller (`/logistics/cartaporte/*`), module. Wireado en AppModule. **`nx build api` verde.**
- Endpoints: `GET/PUT /logistics/cartaporte/emisor`, `GET /logistics/cartaporte/shipment/:id/validate`, `POST /logistics/cartaporte/shipment/:id/stamp`, `GET /logistics/cartaporte/shipment/:id`, `GET /logistics/cartaporte/:id`.
- **2026-06-22 — frontend (opción A) hecho:** `LogisticaService` +5 métodos cartaporte. `LogisticaShipmentDetailComponent` con 4ª pestaña **"Carta Porte"**: tabla de documentos timbrados, botón "Revisar datos" (lista los gaps de `/validate`), botón "Timbrar" (gateado a `cpReady`), confirm dialog. **`nx build view` verde.** Validación visual en browser pendiente (no se levantan dev servers).
- **2026-06-22 — B (permisos + modelado) hecho:**
  - Permisos `LOGISTICS_CARTAPORTE_VER/_GESTIONAR` en los 6 lugares: enum back (`permissions.ts`) + front, `ability.factory` (subject `logistics_cartaporte` + actions), `ability.types` (AppSubject), `permission-meta` (front), seed `ALL_PERMS` (superadmin/admin).
  - **Controller gateado** `@UseGuards(RolesGuard)` + `@RequirePermissions` (VER lectura, GESTIONAR timbrar/emisor) — cierra el hueco de seguridad detectado (los controllers logísticos viejos siguen sin gating: deuda separada).
  - Backfill migration `20260622130000` (superadmin/admin, idempotente IS NULL) — **aplicada a local**, 2 roles. **Requiere RE-LOGIN en prod.**
  - **J12.0.x:** `guide_recipients.order_id` (migración `20260622140000`, composite FK → commercial.orders, **aplicada a local**) + service itemiza mercancías multi-drop (unión de órdenes de destinatarios, fallback a shipment.order_id).
  - `nx build api` + `nx build view` verdes.
- **2026-06-22 — C (datos) hecho:**
  - `database/scripts/cartaporte-backfill-sat-keys.js`: claves SAT por department (fallback dulces `50181900`) + ClaveUnidad por unit_sale (PZA→H87, CJA→XBX, KGS→KGM). Idempotente, dry-run default. **Aplicado a local: 11,398 productos** (todos estaban sin clave). ⚠️ códigos ClaveProdServ son aproximación por categoría — el contador valida los finales.
  - `database/scripts/cartaporte-seed-fiscal.js`: plantilla de captura del emisor + domicilio de almacenes origen + datos fiscales de unidades (por placa). Dry-run default + guard que rechaza `--apply` con placeholders. **Falta llenar con datos reales de Mega Dulces.**
- **2026-06-22 — D (integración Facturama) preparada:**
  - Shape exacto obtenido de la guía Facturama. **Service corregido**: `NameId:'36'`, `Complemento.CartaPorte31` (no `CartaPorte`), sin `Issuer` (single-emisor = la cuenta), `Domicilio` mapeado (Calle/Colonia/Municipio/Estado/Pais/CodigoPostal), fechas ISO.
  - `database/scripts/cartaporte-test-stamp.js`: arma un CFDI Traslado + CartaPorte31 de muestra (mismo shape que el service) y timbra contra `apisandbox.facturama.mx/3/cfdis`. Modo impresión por default; `--stamp` para timbrar. `nx build api` verde.
- **Para timbrar de verdad** (solo datos/creds, ya no código): en `.env` → `FACTURAMA_BASE_URL=https://apisandbox.facturama.mx`, `FACTURAMA_USER`, `FACTURAMA_PASSWORD`, `CP_TEST_RFC=<RFC cuenta sandbox>`. Correr `node database/scripts/cartaporte-test-stamp.js --stamp`.
- **2026-06-22 — DEPLOY A PROD ✅** (commits `09cea6e` + `cae4b04` a origin/main): las 4 migraciones J12 aplicadas en prod vía boot `start.sh`/`migrate:latest` (verificado: tablas cartaporte_documents+carrier_fiscal_profile, columnas SAT en products, order_id/sequence_order/fiscal_address en guide_recipients, lat/lng/fiscal_address en warehouses, permiso Carta Porte en admin+superadmin). J12.0.x también deployado.
- **Pendiente J12.0 (insumos/decisiones, NO código):** (1) **creds Facturama** en `.env` → `--stamp`, (2) **datos reales** emisor + unidades (`cartaporte-seed-fiscal.js`), (3) **backfill SAT en prod** — NO corrido: el clasificador lo frenó correctamente porque los códigos ClaveProdServ son aproximados; **correr `cartaporte-backfill-sat-keys.js --apply` (DATABASE_URL_NEW→prod) SOLO tras validar códigos con el contador**, (4) **re-login** admin/superadmin (permiso vive en JWT), (5) geolocalizar clientes + CEDIS para ruteo/ETA. ✅ schema en prod, ✅ frontend, ✅ permisos, ✅ modelado, ✅ integración PAC.

### Mapeo del complemento (Traslado · por embarque · SAT 3.1)
- **Comprobante:** TipoDeComprobante=`T`; Emisor/Receptor = Mega Dulces (`carrier_fiscal_profile`); UsoCFDI=`S01`; concepto único ValorUnitario 0.
- **CartaPorte:** `TranspInternac="No"`, `TotalDistRec` = Σ `shipments.actual_km`.
- **Ubicaciones:** Origen = warehouse (`fiscal_address`, `FechaHoraSalida`=departure_at); 1 Destino por `guide_recipient` (`fiscal_address`/`customers.billing_address`, RFC = customer.rfc ó `XAXX010101000`, `DistanciaRecorrida`).
- **Mercancias:** `PesoBrutoTotal`=total_weight_kg, `UnidadPeso="KGM"`; por ítem desde `order_lines`→`products`: `BienesTransp`=sat_clave_prod_serv, `Descripcion`=nombre, `Cantidad`, `ClaveUnidad`=sat_clave_unidad, `MaterialPeligroso`.
- **Autotransporte:** PermSCT/NumPermisoSCT (perfil); IdentificacionVehicular = vehicle.plate/year/sat_config_vehicular; Seguros = insurance_carrier/policy.
- **FiguraTransporte:** TipoFigura=`01`, RFCFigura/NombreFigura/NumLicencia desde `drivers`.

### Hueco de modelado pendiente (J12.0.x)
Para itemizar mercancías por destino en multi-drop, `guide_recipients` necesita `order_id` (hoy solo guarda value/weight/boxes agregados). Sin esto, la itemización sale solo del `shipments.order_id` (1:1). Añadir `guide_recipients.order_id` FK a `commercial.orders`.

### Estrategia de claves SAT (evitar capturar miles a mano)
Backfill por **departamento/línea** de `catalog.products` (dulces ≈ `50181900`/`50202200` según tipo) + `ClaveUnidad` default `H87` (pieza) ó `XBX` (caja) + override puntual por producto. Tabla puente opcional `catalog.sat_keys_by_department`.

---

## J12.1 — Rastreo en vivo del chofer (puente web)  ✅  [cero hardware]

**Por qué:** lo primero que pedirá oficina. Reusa lo que ya existe: `RoutePingService` (legacy `/reports/route-pings`) que hoy trackea al **vendedor** vía GPS web + Wake Lock (ver `project_vendor_tracking_web`).

### Backend
- Reapuntar/duplicar el patrón de ping a `logistics`: tabla `logistics.shipment_pings (tenant_id, shipment_id, driver_id, lat, lng, accuracy, captured_at)` RLS.
- `POST /logistics/shipments/:id/ping` — el chofer (app "Mis entregas") envía posición en jornada activa.
- `GET  /logistics/shipments/live` — última posición de embarques `en_ruta` (para el mapa de despacho).

### Frontend
- Nuevo `/logistica/live` — mapa Leaflet con todas las unidades `en_ruta` (reusar organismo de mapa de `project_mapa_comercial`).
- En `DeliveryWizardComponent` / "Mis entregas": iniciar ping al pasar a `en_ruta`, soltar Wake Lock al cerrar (igual que el shift del vendedor).

### Done
- Despachador ve la unidad moverse en el mapa sin llamar al chofer. Reproducción básica del recorrido del día.

### Ejecución (log)
- **2026-06-22 — J12.1 hecho (cero infra nueva, todo reuso):**
  - **Decisión:** NO crear `logistics.shipment_pings`. Reusar `public.route_location_pings` (ya lo alimenta `RoutePingService`) + el `MapComponent` Leaflet compartido.
  - Backend: `LogisticsShipmentsService.livePositions()` (embarques `en_ruta` → guía → chofer → último ping <12h vía `DISTINCT ON`, tenant explícito porque la tabla no tiene RLS) + `GET /logistics/shipments/live` (antes de `:id`).
  - Frontend: `LogisticaService.liveShipments()` + página `/logistica/live` (`LogisticaLiveComponent`) con mapa de camiones + lista + auto-refresh 30s; nav item "Flota en vivo" (`LOGISTICS_FLEET_VER`); ruta lazy.
  - Ping del chofer: `RoutePingService.startShift()` en constructor de `LogisticaDriverAssignmentsComponent` + `endShift()` en `ngOnDestroy` → emite GPS mientras está en "Mis entregas".
  - `nx build api` + `nx build view` verdes. Validación visual + prueba con GPS real pendientes.
  - Deferred: reproducción del recorrido histórico (reusar `field_routes`/consolidación), y migrar a telemetría hardware (J12.5) como fuente de verdad.

---

## J12.2 — Avisos de entrega + POD al cliente  ⬜  [arranca Fase F]

**Por qué:** diferenciación comercial pura (no costo). Primer caso de uso natural del WhatsApp Bot.

**Dependencia:** decidir BSP (ADR-006). Ver `FASE_F_WHATSAPP_BOT.md`. Mientras tanto, fallback SMS o email.

### Backend
- Hooks en la máquina de estados de shipments/guides:
  - `en_ruta` → "Tu pedido salió" + link de seguimiento público.
  - próximo en secuencia (de J12.4) → "Está por llegar".
  - `guide_recipients.deliver` → POD (foto + firma + sello) al cliente.
- `GET /track/:token` — página pública de seguimiento (token firmado por recipient, sin auth), muestra estado + (cuando exista J12.1) posición + ETA.
- Reusar `proof_photo_url` + `gps_lat/lng` que ya captura `guide_recipients`.

### Frontend
- Página pública `/track/:token` (mobile-first, sin login).
- En portal B2B: badge "En camino" + link, cuando el pedido tiene embarque `en_ruta`.

### Done
- Cliente recibe aviso al salir su pedido y ve POD al entregarse.

---

## J12.3 — Optimización de ruta del día (VRP)  ✅  [planner hecho · capacidad/ventanas diferidas]

**Por qué:** menos km, menos combustible, más entregas/unidad. `routes` ya tiene `estimated_km`; falta el solver que secuencie las paradas.

**Estrategia:** NO escribir un VRP propio. Integrar:
- Opción A (rápida): **Google Routes API** (Route Optimization) o **Mapbox Optimization** — hosted, paga por uso.
- Opción B (sin costo recurrente): microservicio **OR-Tools** (Python) desplegado aparte, llamado por NestJS.
- Recomendado: A para validar valor, B si el volumen lo justifica.

### Backend — `logistics-routing`
- `POST /logistics/routing/optimize` — entrada: lista de destinatarios del día + capacidad de unidades + ventanas horarias → salida: secuencia óptima por unidad.
- Persistir secuencia en `delivery_guides` / nuevo `guide_recipients.sequence_order`.
- Considerar: capacidad (`vehicles.capacity_boxes/kg`), ventanas del cliente, regreso a CEDIS.

### Frontend
- `/logistica/planner` — armar el reparto del día: arrastrar pedidos pendientes a unidades, botón "Optimizar", ver mapa + orden + km/tiempo estimado.

### Done
- Generar la ruta del día de N pedidos en M unidades, optimizada, en un clic. Comparar km vs. ruta manual (medir ahorro para el dashboard de ROI).

### Ejecución (log)
- **2026-06-22 — J12.3 núcleo hecho (solver propio, cero dependencias):**
  - **Decisión:** solver heurístico propio (TSP abierto: nearest-neighbor + 2-opt, distancia haversine) en `libs/logistics/.../logistics-routing/route-solver.ts` — sin Google/Mapbox/OR-Tools. Validado: 3 paradas en línea → 114 km vs 248 ingenuo.
  - Migración `20260622150000`: `guide_recipients.sequence_order` + `commercial.warehouses.latitude/longitude` (origen del solver). Aplicada a local.
  - Backend `logistics-routing` (gateado): `POST /logistics/routing/optimize` (stateless, para planner) + `POST /logistics/routing/optimize-shipment/:id` (resuelve coords vía `commercial.customers.lat/lng`, persiste `sequence_order`, origen = almacén default o centroide fallback). Wireado en AppModule.
  - Frontend: `LogisticaService.optimizeShipmentRoute()` + botón **"Optimizar ruta"** en tab Guías del detalle de embarque (toast con paradas + km + cuántas sin ubicación).
  - `nx build api` + `nx build view` verdes.
  - **Deferred (J12.3.x):** planner `/logistica/planner` (drag pedidos→unidades, mapa con la secuencia), capacidad dura (`vehicles.capacity_boxes/kg`) y ventanas horarias; mostrar `sequence_order` en la tabla de destinatarios.
- **2026-06-22 — J12.3.x planner hecho:**
  - Backend `LogisticsRoutingService.shipmentPlan()` + `GET /logistics/routing/shipment/:id/plan`: origen (almacén) + destinatarios con coords ordenados por `sequence_order` (lee lo persistido, no recalcula).
  - Frontend: página **`/logistica/planner`** (`LogisticaPlannerComponent`) — selector de embarque + `MapComponent` con paradas numeradas (`seq`) + polilínea origen→paradas + botón "Optimizar ruta" + lista ordenada. Nav item "Planeador". Ruta lazy `LOGISTICS_SHIPMENTS_VER`.
  - `sequence_order` ahora visible como columna "#" en la tabla de destinatarios del detalle de embarque.
  - `nx build api` + `nx build view` verdes.
  - **Sigue diferido:** drag pedidos→unidades (armar embarques desde pendientes), capacidad dura y ventanas horarias en el solver.
- **2026-06-22 — J12.3 armar reparto hecho:**
  - Backend `LogisticsRoutingService.buildShipmentFromOrders()` + `POST /logistics/routing/build-shipment`: atómico — crea shipment (programado) + guía + un destinatario por pedido (ligado a `order_id`, domicilio fiscal auto, valor=`orders.total`, unidades est. de `order_lines`), corre el solver y persiste `sequence_order`. Folios EMB/GUIA vía `nextFolio` (current_tenant_id). **Capacidad suave**: compara unidades estimadas vs `vehicles.capacity_boxes` → flag `over_capacity` (avisa, no bloquea).
  - Frontend: sección **"Armar reparto del día"** en `/logistica/planner` — select de unidad + multiselect de pedidos pendientes + "Crear embarque optimizado" → toast con paradas/km/aviso de capacidad, y carga el plan del embarque nuevo.
  - `nx build api` + `nx build view` verdes.
  - **Sigue diferido:** drag-and-drop real (UI), capacidad **dura** por peso (orders no traen kg) y **ventanas horarias** (orders no traen horario, solo `requested_delivery_date`).

---

## J12.4 — ETA (heurístico → histórico)  ✅  [V1+V2 · alerta-vs-ventana data-bloqueada]

> **2026-06-22 — V2 hecho:** la velocidad del ETA se calibra del histórico real (Σkm/Σhoras de embarques cerrados 90d, acotada 5–90 km/h; fallback config→30), reporta `speed_source`. Pendiente (data-bloqueado): alerta de retraso vs ventana del cliente — los pedidos no tienen ventana horaria.


**Por qué:** "¿a qué hora caen?" es la pregunta diaria del cliente. No se necesita ML para empezar.

- **V1 heurístico:** posición actual (J12.1) + orden de parada (J12.3) + km + velocidad promedio config → ETA por destinatario.
- **V2 histórico:** alimentar con tiempos reales `departure_at`/`delivered_at` ya almacenados → ajustar por zona/hora.
- Alerta de retraso: si ETA supera ventana del cliente → aviso (J12.2).
- Endpoint `GET /logistics/shipments/:id/eta`. Mostrar en `/track/:token` y en despacho.

### Ejecución (log)
- **2026-06-22 — J12.4 V1 hecho:**
  - Backend `LogisticsShipmentsService.etaForShipment()` + `GET /logistics/shipments/:id/eta`. Parte del último ping del chofer (J12.1) o, sin GPS, de la 1ª parada; recorre destinatarios `pendiente` con `sequence_order` (J12.3) + coords del cliente; ETA = Σ(legKm/velocidad·60 + minutos_por_parada). Reusa `haversineKm` del solver.
  - Config opcional en `config_finance` (`velocidad_promedio_kmh` default 30, `minutos_por_parada` default 12).
  - Frontend: `LogisticaService.shipmentEta()` + panel **"ETA de ruta"** en tab Guías (botón Calcular → tabla #/cliente/km acum./hora + total km y minutos).
  - `nx build api` + `nx build view` verdes.
  - **Deferred:** V2 calibración con histórico real (`departure_at`/`delivered_at`), alerta de retraso vs ventana del cliente (depende de J12.2), y ETA en la página pública `/track`.

---

## J12.5 — Telemetría hardware  ⬜  [apuesta de capital]

**Por qué:** desbloquea diagnóstico de motor, combustible real, mantenimiento por km y seguridad AI "gratis". Es la pieza de la que cuelga todo lo de Samsara.

**Decisión (ADR-027):** comprar hardware GPS/OBD. Opciones: Samsara/Motive (caro, contrato 3 años) vs. proveedor MX / dispositivos OBD genéricos con API. Para arrancar: dispositivo económico con API de posición + OBD básico.

### Backend
- Pipeline de ingesta: `POST /logistics/telemetry/ingest` (webhook del proveedor) → `logistics.vehicle_telemetry (tenant_id, vehicle_id, ts, lat, lng, speed, fuel_level, engine_on, odometer, dtc_codes JSONB)`.
- Reemplaza el ping web (J12.1) como fuente de verdad de posición cuando esté disponible.
- Alimenta J12.4 (ETA), J12.6 (mantenimiento/combustible) y un futuro scoring de seguridad.

### Done
- Una unidad reportando posición + odómetro + nivel de combustible automáticamente.

---

## J12.6 — Mantenimiento preventivo + combustible (nivel Fleetio)  🔨  [V1 + fuel_transactions]

> **2026-06-22 — combustible hecho:** tabla `logistics.fuel_transactions` (litros/monto/odómetro/estación por unidad) + CRUD (`/fleet/fuel`) + UI en flotilla. **Pendiente:** OT automáticas por cron + alerta WS (requiere wiring de infra de alertas cross-módulo) e inventario de refacciones (sub-módulo propio).


**Por qué:** ya tienes `vehicle_maintenance` con `next_service_km/date` pero manual; y guardas `fuel_efficiency_km_l` pero **no comparas contra el real**.

### Backend
- **Mantenimiento:** cron que dispara órdenes de trabajo cuando `odometer` (de telemetría) cruza `next_service_km`. Alerta WS (reusar `AlertsService`). Inventario de refacciones (nueva tabla `logistics.parts` + consumo en OT).
- **Combustible:** `logistics.fuel_transactions (tenant_id, vehicle_id, liters, amount, odometer, station, ts)`; importación por tarjeta de combustible (CSV o API). Calcular **rendimiento real** = km/litro y comparar vs `vehicles.fuel_efficiency_km_l` → detectar fugas/fraude.

### Frontend
- En `/logistica/fleet`: tab combustible (rendimiento real vs spec, costo/km), OT automáticas en mantenimiento.

### Ejecución (log)
- **2026-06-22 — J12.6 V1 hecho (sobre odómetro MANUAL, sin esperar telemetría):**
  - Backend `LogisticsFleetService.maintenanceDue()` (odómetro actual = MAX de `vehicle_usage_logs` vs `next_service_km` / `next_service_date` del último mantenimiento) + `fuelEfficiency()` (km/litros de usage logs cerrados → real km/l vs spec `fuel_efficiency_km_l`, flag si ≥15% bajo spec). Endpoints `GET /logistics/fleet/maintenance/due` + `GET /logistics/fleet/fuel-efficiency`.
  - Frontend: en el tab Mantenimiento de `/logistica/fleet` → banner de unidades con servicio vencido + tarjeta "Rendimiento de combustible (real vs spec)" con fila marcada en rojo cuando hay desviación.
  - `nx build api` + `nx build view` verdes.
  - **Deferred (a J12.5 con hardware):** OT automáticas vía cron + alerta WS, inventario de refacciones (`logistics.parts`), `logistics.fuel_transactions` + import por tarjeta de combustible, costo/km de combustible.

---

## J12.7 — Dashboard de ROI + API pública  🔨  [dashboard + km ahorrados · API pública diferida]

> **2026-06-22 — km ahorrados hecho:** `logistics.route_optimizations` registra km sin optimizar (orden de captura) vs optimizado por embarque; `roiSummary` suma `km_saved_optimization` del período y el dashboard ROI lo muestra. **Diferido:** API pública + webhooks (superficie sensible: auth/keys/rate-limit/firma/retries → amerita pasada de diseño propia, no meterla a medias a prod).


**Por qué:** Samsara vende "8X ROI" sobre combustible + mantenimiento + seguros. Tú tienes el dato (costeo por viaje) pero **no lo cuentas**. Y tu multi-tenant ya está listo para abrir API.

- **Dashboard de ahorro:** km ahorrados por optimización (J12.3), rendimiento de combustible (J12.6), costo/km tendencia — un número presentable de ahorro.
- **API pública + webhooks:** exponer embarques/guías/tracking para integraciones (modelo plataforma). Apóyate en la arquitectura multi-tenant existente.

### Ejecución (log)
- **2026-06-22 — J12.7 dashboard hecho:**
  - Backend `LogisticsAnalyticsService.roiSummary()` + `GET /logistics/analytics/roi`: flete, costo total, costo/km, margen + %, costo de combustible + % del operativo, gasto de mantenimiento (de `vehicle_maintenance`), y desglose de costo (combustible/casetas/viáticos/maniobras/talachas/otros). Solo `entregado|cerrado`.
  - Frontend: nueva pestaña **"ROI"** en `/logistica/reports` con 4 KPI cards (costo/km, margen, combustible, mantenimiento) + desglose de costo + historia del período. Usa el rango de fechas del filtro existente.
  - `nx build api` + `nx build view` verdes.
  - **Deferred:** API pública + webhooks (esfuerzo arquitectónico aparte: auth/rate-limit/versionado); "km ahorrados" requiere guardar baseline antes/después de optimizar (J12.3) para cuantificar el ahorro real.

---

## Fuera de alcance (deferred, no aplican al caso MX local)
- ELD / Horas de servicio federal (US-céntrico).
- Visibilidad marítima/aérea/multimodal (project44 enterprise).
- Cámaras AI de seguridad como inversión aislada (llega con J12.5 si el hardware las trae).

---

## Secuencia recomendada de ejecución
1. **J12.0 (Carta Porte)** — ya, es legal.
2. **J12.1 (rastreo puente)** en paralelo — cero costo, valor inmediato.
3. **J12.2 (avisos)** cuando se decida BSP.
4. **J12.3 (optimización)** — el ahorro duro.
5. **J12.4 (ETA)** encima de 1+3.
6. **J12.5 (hardware)** cuando el volumen/capital lo justifique.
7. **J12.6 + J12.7** sobre la base de telemetría.

ADRs a abrir: 025 (estrategia compra/construye), 026 (PAC), 027 (proveedor telemetría).
