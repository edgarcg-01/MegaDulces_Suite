# Changelog

> Cambios notables del repo Trade Marketing. Vivo como complemento de
> [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) (detalle de sprints) y
> [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) (kanban). Este archivo es para "¿qué cambió las últimas N semanas?" sin abrir git log.
>
> Convención: secciones por fecha (más reciente arriba). Cada release agrupa por **Added / Changed / Fixed / Deprecated / Removed / Internal**. Actualizar al cerrar sprint o feature relevante.

---

## [Unreleased]

### Added — Supervisor de Movimientos: cuándo/circunstancia + plan de prevención (SM.7b/SM.8) (2026-07-08)
- **Deducción sobre 2178 cortes:** el descuadre no es aleatorio — máximo riesgo en **lunes/sábado, turno >10h (12% vs 6%), cierre en cambio de turno (15/18h), caja que cambió de manos** (82% de cortes, $320k de $379k del faltante). Cajas calientes suc02-caja1/2, suc05-caja4/5. Tendencia al alza en 2026.
- **Ingesta horaria:** `hora_apertura`/`hora_cierre`/`duracion_horas`/`handoff` en `cash_cuts` (mig `20260708160000` + importer lee c6/c11). Regla `corte_riesgo_circunstancia` (cambio de cajero + turno ≥10h + cuadre exacto + ≥$5k → **154 cortes** de $50-65k a auditar). Detalle del corte muestra horario + circunstancia.
- **Plan de prevención (SM.8)** en el doc de fase: P0 confirmar (piloto arqueo ciego) → P1 forzar arqueo ciego en nuestra capa (palanca #1) → P2 arqueo de relevo → P3 límite de jornada → P4 foco puntos calientes → P5 loop HITL + diff-in-diff → P6 cruce independiente vs tickets POS.

### Added — Supervisor de Movimientos: nombres de cajero (SM.7) (2026-07-08)
- Catálogo `analytics.pos_cashiers` + importer `import-pos-cashiers` (une Kepler `kdpv_gerentes` códigos prefijados + `kdpv_kdku` cortos, escopeado por sucursal): **742 cajeros, 100% de cortes resueltos**. Los códigos (`54TYSL`, `40VMC`) ahora muestran nombre en cortes, resumen y en los 4 detectores de caja → los hallazgos nombran al culpable (ej. TANIA YAZMIN SÁNCHEZ LEAL, $57k faltante en 9 cortes). Codes basura caen a fallback.

### Added — Supervisor de Movimientos: desglose completo del corte (SM.7) (2026-07-08)
- **Por qué cuadra o no un corte**, descifrado en vivo de `md.kdpv_folio_caja` (2178 cortes red completa). Un corte = **esperado (sistema) vs contado (arqueo)** por forma de pago (efectivo/tarjeta/transferencia) + desglose del arqueo (billetes/monedas/otros) + efectivo retirado.
- **Regla `arqueo_no_ciego`** (nueva): 1456 de 1993 cortes de monto alto (**73%**) cierran con contado idéntico al esperado al centavo — imposible en conteo físico real. El descuadre bajo NO garantiza caja sana; el arqueo no es ciego. Detecta cajero×mes ≥90% exacto (**49 hallazgos** en data real).
- **Regla `descuadre_no_efectivo`** (nueva): descuadres de tarjeta/transferencia (c36/c37), antes 100% invisibles — **73 cortes** afectados.
- **Consola** `/almacen/cuadre`: Resumen con KPI arqueo-no-ciego + nota; Cortes master-detail (3 formas de pago esperado/contado/diff + desglose arqueo) con filtros de fecha; Movimientos con **nombre de producto** (join `public.products`) + filtros de fecha; nombre de sucursal.

### Fixed — Corte: `total_venta` subestimaba la venta (2026-07-08)
- `total_venta` mapeaba `c49` (≈ solo efectivo). La venta real del turno = efectivo+tarjeta+transferencia esperados. Nueva columna `venta_total`: **$61.3M** real vs $54.2M viejo (−$7.1M). Migración `20260708120000_cash_cuts_desglose` (+7 columnas idempotentes + backfill). Importer `import-cash-cuts` lee c36/c37/c43/c44/c45/c48 y SSL condicional por host.

### Fixed — Maat chat: "No pude generar una respuesta" en respuestas largas (2026-07-07)
- **Causa** (reproducida contra la API): `MAX_TOKENS=1500` cortaba las respuestas detalladas (análisis por sucursal, tablas) → el tool-call `render_response` quedaba truncado (`stop_reason=max_tokens`) y `narrative` volvía vacío. Solo pasaba en respuestas largas → intermitente.
- **Fix en 3 niveles**: (1) `MAX_TOKENS` 1500→4096 cubre respuestas ricas; (2) `retryConcise` reintenta una vez con nudge de concisión + 8192 tokens si aún trunca (recuperó 6959 chars en la prueba); (3) mensaje accionable ("acota la pregunta…") en vez del genérico. `THINK_MAX_TOKENS` 4096→8192. Commit `9382918`.

### Added — Maat: grafo de colusión de proveedores en Neo4j (MAAT.10) (2026-07-07)
- `maat_red_proveedores` ahora prefiere un **grafo Neo4j** para el recorrido multi-hop de la red de proveedores (anillos de colusión), con **fallback automático al CTE recursivo en Postgres** si Neo4j no está configurado. Cero cambio de comportamiento en prod hasta provisionar la instancia.
- **`Neo4jModule`** en platform-core (token `NEO4J_DRIVER`, `@Global`, degrada a `null` sin `NEO4J_URI`) + **`MaatProviderGraphService`** en libs/finance: modelo bipartito `(:Beneficiario)-[:USA_RFC]->(:Rfc)` (fan-in/fan-out/anillos), `sync`/`network`/`rings`. Aristas forenses futuras (cuenta bancaria / rep legal / domicilio) ya modeladas, pendientes de ingesta (el 201 de Kepler es plano).
- **Decisión** (Edgar): poner las tuberías ahora aunque la data forense no exista aún — cuando llegue, es solo agregar aristas al mismo grafo. `neo4j-driver@6` agregado.
- **Backfill**: `POST /finance/maat/findings/graph-sync` + script on-prem `database/scripts/sync-maat-provider-graph.js`. **Verificado** el Cypher en vivo (Neo4j 5.26): anillo sintético → multi-hop a 2 saltos + fan-in/fan-out correctos. **Pendiente prod**: provisionar Neo4j + `NEO4J_*` en Railway + sync.

### Added — Maat RAG: retrieval semántico de conocimiento (MAAT.9) (2026-07-07)
- El tool `maat_conocimiento` ahora busca por **similitud coseno** (Voyage voyage-3 + pgvector) en vez de ILIKE → entiende parafraseo/sinónimos ("centro de costos por departamento" encuentra la entrada aunque no compartan palabras).
- **No agrega tecnología nueva**: reusa `EmbeddingsService` + la DB vector dedicada de Fase K (`VECTOR_DATABASE_URL`), ambos en `platform-core`. Nuevo `MaatKnowledgeVectorService` (tabla `maat_knowledge_embeddings`, HNSW coseno, PK `(tenant_id,kind,title)`). **Degrada solo**: sin vector DB / VOYAGE_API_KEY / ante error → fallback a ILIKE (el chat nunca se rompe).
- **Sync automático**: guardar/retirar conocimiento (chat REST) embebe/quita la entrada al vuelo. Backfill vía `POST /finance/maat/knowledge/reindex` o script on-prem `database/scripts/embed-maat-knowledge.js`.
- **Verificado contra la DB RAG de prod**: 28/28 entradas embebidas; queries parafraseadas devuelven la entrada correcta (señal 0.44–0.59 vs ruido 0.33–0.40, umbral 0.42). Corpus-RAG de documentos contables (PDFs) diferido — no hay corpus cargado.

### Added — Geocercas indexadas para tracking GPS de campo (Track GPS.B) (2026-07-03)
- **Contexto:** análisis de la arquitectura de tracking GPS del vendedor (foreground service nativo + Dexie batching + REST-batch + WS live-map) confirmó que está ~90% construida. **Única brecha técnica real: sin índice espacial** — las geocercas ("¿entró a la tienda?", clientes cercanos) se calculaban con haversine en JS/SQL sin índice.
- **Decisión:** PostGIS **NO disponible** en la instancia (`postgres_platform`, PG 18.4 — ni instalada ni en `pg_available_extensions`). `cube` + `earthdistance` **sí** → alternativa liviana elegida (misma capacidad de radio indexado con GiST, sin instalar paquetes de OS). Documentado como plan B en el análisis previo.
- **Migración `20260703140000_gps_earthdistance_geofence`** (idempotente + **defensiva**: si las extensiones no están o el rol no es superuser, NO crea nada y NO tira error → no crashea boot en Railway; los índices solo se crean si la extensión quedó instalada). `CREATE EXTENSION ... SCHEMA public` explícito (sin esto se instalaban en `identity`, primer schema del search_path). Índices GiST funcionales: `idx_route_pings_earth` sobre `route_location_pings(ll_to_earth(lat,lng))` + `idx_customers_earth` sobre `commercial.customers(ll_to_earth(latitude,longitude))` parcial.
- **Verificado (DB local):** extensiones instaladas, ambos índices creados, `earth_distance` da 1574m (correcto vs ~1500m), y `EXPLAIN` de una geocerca por radio confirma **Index Scan using idx_route_pings_earth** (usa el índice, no seq scan).
- **Pendiente:** aplicar la migración a Railway al cutover (confirmar que el rol tenga superuser o que `cube`/`earthdistance` estén pre-creados — si no, la migración skipea graciosamente). Tracks GPS.A (deploy+prueba en device: patch nativo ✅ ya aplicado en node_modules, falta APK+prueba pantalla apagada), GPS.C (verificar live-map E2E con app arriba) y GPS.D (provisionar `REDIS_URL` en Railway — el `ReportsIoAdapter` ya está codeado) quedan como trabajo operacional/de device.

### Added — Proyecto "Tienda": monitor de tickets de venta EN VIVO (Fase TDA) (2026-07-02)
- Nuevo proyecto `/tienda` (card en /projects) que muestra los **tickets POS de cada sucursal en tiempo real**. Builds api+view verdes; sin deploy.
- **Habilitador:** Kepler guarda la hora del ticket **al minuto** en `kdm1.c62` (100% poblado) + `c9` fecha. Datos en vivo (verificado: tickets a la hora actual).
- **Arquitectura (WS ≠ sin polling):** el WebSocket empuja al navegador (sin polling del navegador), pero Kepler no notifica altas (poner trigger/LISTEN al ERP = invasivo, descartado) → **único punto de polling** = `poller on-prem cada ~25s → POST /store/live/ingest → Socket.IO namespace /store → navegador`. Reusa patrón AlertsGateway (JWT handshake, rooms por tenant, path /reports/socket.io).
- **Backend** `apps/api/src/modules/store/`: gateway `/store`, `StoreService` (ingest idempotente + emite; snapshot KPIs día/curva horaria TZ MX/últimos tickets; alerta ticket grande), controller (`POST /store/live/ingest` @Public + guard `x-store-ingest-key`; `GET /store/live/snapshot` gate `STORE_LIVE_VER`), migración `20260702180000_analytics_store_live_tickets`, permiso `STORE_LIVE_VER`.
- **Poller** `database/importers/kepler/live-tickets-poller.js` (proceso continuo, ventana deslizante 5min/25s, lee kdm1⋈kdm2 c4=10 con canasta, push a prod).
- **Frontend** proyecto `/tienda`: `TiendaLiveComponent` (ticker con flash + expandir canasta del ticket, KPIs del día en vivo, barras de horas pico 6-22h, feed de alertas, indicador EN VIVO) + `StoreSocketService` (Socket.IO /store) + card + ruta + nav.
- **Pendiente prod:** migración + env `STORE_INGEST_KEY`/`STORE_INGEST_URL` + correr el poller on-prem + deploy. `STORE_LIVE_VER` lo tienen admin/superadmin (manage:all); otros roles requieren backfill + re-login.

### Added — Apartado de Traspasos (movimientos que NO son venta) (Fase T) (2026-07-02)
- **Contexto:** los "traspasos"/consolidación interna de Kepler ya estaban FUERA de los reportes de venta (efecto del fix ×2 `c4=10`), pero eran **invisibles** y la exclusión era implícita. Se les hace apartado propio + se blinda la exclusión. Builds api+view verdes; sin deploy.
- **Análisis (datos):** el bloque `c4=6` (serie `UD06`, ~$46M/año, 1 doc/día CONTADO, ≈90% de la venta en cada sucursal) = **consolidación interna** (confirmado por el usuario), NO venta — era el causante del ×2. Los N-traspasos (`N/D/6`, `N/D/25`) = 0 en la práctica; sí hay `U/A/50` "Recepción Traspaso" (~$11M/año). Verificado: `sales_daily` en prod solo trae canales `tienda`+`credito` (sin traspaso).
- **T.2/T.3:** migración `analytics.transfers_monthly` (kind: consolidacion/recepcion/traspaso_salida/traspaso_entrada) · feed `import-transfers-monthly.js` (6 sucursales vivas, UPSERT-acumulativo GREATEST) · `transfersReport()` + endpoints `/commercial/analytics/transfers` (+`.xlsx`).
- **T.4:** página `/logistica/traspasos` (matriz sucursal×tipo mes a mes, KPIs, desglose por tipo, XLSX) + item de nav en Logística + link "Traspasos (no venta)" en el tab Reportes de Comercial.
- **T.1 (blindaje):** test `database/tests/verify-no-transfer-leak.js` — invariante "ningún canal de traspaso en `sales_daily`" (la única defensa real es `c4=10` en el origen; `UD06` es CONTADO → se disfrazaría de canal `tienda`, un filtro por canal NO lo atrapa). PASS en prod.
- **T.6 — CEDIS incluido (a partir de "¿y cedis?"):** CEDIS (md_00) NO era $0 — es el hub. Su distribución vive en **`U/D/13` = $320M/año** (SALIDA por traspaso), con destino en `kdm1.c10` decodificado vía catálogo `kdud` (P.V./TLMKT/RUTA — incluye Morelia y Canindo, NO consolidadas). Se agregó `kind='salida_cedis'` + columna `dest_label` (destino real) al feed/tabla/reporte/UI. **Fix de valor:** el importe de `U/D/13` está en el **header `kdm1.c16`**, no en las líneas `kdm2` (c13≈0) → el feed ahora suma valor+docs del header y unidades de kdm2. Poblado en prod: 267 filas, salida_cedis $320M + consolidación $47M + recepción $12M. Builds verdes, regresión PASS.
- **Pendiente prod:** aplicar migración `20260702170000` + agendar `import-transfers-monthly.js` (nightly) + re-login no requerido (reusa `COMMERCIAL_ORDERS_VER`). Nota: los valores de `consolidacion`/`recepcion` traen un ~2-3% residual de la 1ª corrida (base línea) por el UPSERT-GREATEST; un reset de la tabla los deja 100% base-header (requiere autorización de DROP en prod).

### Added — Feed de logística/embarques de Kepler (Fase KV.8) (2026-07-01)
- Explota la logística REAL del ERP Kepler (`md.kdpord` embarques + dims `kdm_rutas`/`kdm_chofer`/`kdm_transporte`), mismo patrón que ventas: on-prem lee, bulk a prod, **separado** del módulo Fase J (`analytics.erp_shipments`, no pisa `logistics.*` de la app). Build api verde.
- **Hallazgo:** Kepler sí tiene logística; la plataforma ya tenía el módulo Fase J completo (22 tablas) pero **capturado a mano**; las dims se habían importado una vez con un script one-off; los **embarques (`kdpord`) no se traían** — ese era el gap.
- Migración `analytics.erp_shipments` (fact grano-línea) · `import-erp-shipments.js` (multi-sucursal, full refresh, dry-run vuelca muestra cruda para calibrar columnas + `KDPORD_DATE_COL`) · `import-logistics-dims.js` (idempotente) · modo `logistics` + nightly en `run-prod-feeds.js` · crons @05:15/05:20 · `erpShipments()` + endpoint `/commercial/analytics/erp-shipments` + tool `thot_shipments` (Thot ya responde "embarques por ruta/estado/día").
- **Pendiente prod:** aplicar migración + calibrar `KDPORD_DATE_COL` con dry-run on-prem + correr feed.

### Added — Thot "aprende del uso": few-shot + feedback loop 👍/👎 (Fase TC.4a/5a / ADR-026) (2026-07-01)
- **No es fine-tuning ni hornear cifras** (eso quedaría stale + alucinaría): Thot aprende del USO con una **biblioteca de ejemplos verificados** (pregunta → tools → respuesta) inyectados como **few-shot** según similitud. Patrón verified-queries (Snowflake) / few-shot RAG (Uber). Determinista y auditable (ADR-021).
- **TC.4a**: migración `commercial.thot_chat_examples` (RLS, por perfil) + 14 ejemplos **semilla** en código (valor desde el deploy, incl. la lección "ventas en ruta") + injection por solape de tokens. Endpoints `/thot/examples` (GET/POST/PATCH + `from-log`).
- **TC.5a feedback loop**: migración `thot_chat_log` +`feedback`/+`promoted`; el chat devuelve `log_id`; `POST /thot/feedback` (👍/👎); cola `GET /thot/examples/candidates` (👍 sin promover) → promover a ejemplo. **Botones 👍/👎** en chat de portal y vendedor + **pantalla de curaduría** `/comercial/thot-curation` (revisar cola, promover 1-clic, alta manual, enable/disable).
- **Mejoras de comportamiento** (vistas en prod con "% de ventas en ruta"): regla **"investigá antes de preguntar"** (probá la dimensión obvia en vez de pedir aclaración) + `flexible_aggregate` devuelve **`share_pct` determinista** (el LLM ya no calcula % de cabeza ni se equivoca).
- **Pendiente prod:** aplicar migraciones `thot_chat_examples` + `thot_chat_log_feedback`. Diferido TC.4b (embeddings; pgvector es Docker local, falta resolver en Railway).

### Added / Security — Thot Chat en Portal y Vendor con perfiles scoped (Fase TC-S/P/V / ADR-026) (2026-06-30)
- Lleva el asistente conversacional a las apps de **cliente** y **vendedor**. Builds api+portal+vendor verdes. Sin deploy.
- **Security (TC-S):** se detectó y cerró un leak — `customer_b2b` y `vendedor` tienen `COMMERCIAL_ORDERS_VER`, así que con el gate original podían pegarle al chat **admin** y ver TODO el tenant (márgenes, todos los clientes). Fix: el endpoint admin `/thot/chat` rechaza esos roles; cada audiencia tiene su endpoint scoped.
- **Refactor a perfiles:** `ThotChatService` agnóstico (recibe `ToolProvider` + `ThotScope`); el scope se deriva del JWT y se **impone server-side** (el LLM nunca elige cliente/almacén fuera de alcance).
- **TC-P Portal** (`customer_b2b`): `PortalThotToolsService` scoped a `customer_id`, **sin márgenes ni datos de terceros** (mis pedidos / recomendaciones / lo habitual / catálogo+mi precio / disponibilidad / promos) + `/portal/thot/chat` + UI Storefront `/portal/assistant`.
- **TC-V Vendor:** `VendorThotToolsService` scoped a la **cartera** (rutas asignadas), márgenes OK (interno): buscar cliente / 360 / historial / sugeridos / mi día / inactivos / stock + `/vendor/thot/chat` + UI mobile con **voz Web Speech es-MX** `/vendor/assistant`.
- **Surtido PH:** disponibilidad/stock de portal y vendor sale del almacén **MD-10** (`THOT_FULFILLMENT_WAREHOUSE`), alineado con el feed `import-ph-stock-live.js`.
- **TC-E:** `http-thot-chat-scoped-test.js` (red-team de fuga: admin rechaza al cliente, superficie de tools acotada por perfil, no entrega márgenes).
- **Pendiente:** reiniciar API (build nuevo) + correr el red-team. `apps/view` quedó rojo por WIP ajeno (`ThotAiInputComponent`), no de esta fase.

### Added — Thot Chat: analítica conversacional sobre ventas (Fase TC / ADR-026) (2026-06-30)
- **Qué:** "Pregúntale a Thot" — un chat que responde preguntas complejas de ventas/inventario/clientes/márgenes en lenguaje natural, orquestando vía **tool-use de Claude** los métodos deterministas que ya existen. Builds api+view verdes. Sin deploy.
- **Decisión (ADR-026):** capa conversacional sobre el motor, **NO RAG sobre la DB**. Validado contra cómo lo hacen Uber/LinkedIn/Snowflake/Databricks/Anthropic: capa semántica curada + tools deterministas + RAG solo para entidades + evals. El LLM **nunca calcula ni genera SQL**; los números salen de tools tenant-scoped (RLS). Read-only.
- **TC.0 — Tool registry + capa semántica** (`libs/commercial/.../thot-chat/`): `thot-semantic.ts` (glosario de negocio ES + reglas duras) y `thot-tools.service.ts` (~20 tools `thot_*` envolviendo `CommercialAnalyticsService` + `ThotService`, con distinción venta real ERP vs pipeline B2B) + `resolve_entity` (RAG ligero ILIKE) + `flexible_aggregate` (escape hatch con whitelist, sin SQL libre) + `list_warehouses`.
- **TC.1 — `ThotChatService`:** bucle tool-use (máx 6 iteraciones, timeout 30s) con self-correction (errores de tool vuelven como texto accionable). Modelo Haiku 4.5 por defecto, env `THOT_CHAT_MODEL` para Sonnet. Degrada limpio sin `ANTHROPIC_API_KEY`.
- **TC.2 — Endpoint** `POST /commercial/intelligence/thot/chat` (gated `COMMERCIAL_ORDERS_VER`, sin permiso nuevo → sin re-login) + persistencia auditable `commercial.thot_chat_log` (migración `20260630200000`, RLS forzado, append-only).
- **TC.3 — Frontend** `/comercial/thot-chat` (Operations): hilo de chat, prompts sugeridos, **render estructurado** de las tablas que devolvieron las tools (transparencia) + tab "Pregúntale a Thot" en la barra de analytics.
- **Evals:** `database/tests/http-thot-chat-test.js` (golden-questions: verifica el ruteo a la tool correcta, estilo LinkedIn SQL Bot).
- **Pendiente prod:** aplicar migración + `ANTHROPIC_API_KEY` + correr evals live.

### Added — Subida GPS nativa en background (app Vendedor, patch al plugin) (2026-06-29)
- Diagnóstico por logcat (teléfono Honor): el foreground service **sobrevive** al bloqueo, pero la subida vivía
  en el WebView (que se congela al bloquear) → los fixes capturados con pantalla bloqueada no se subían.
- **Patch nativo** (`@capacitor-community/background-geolocation` vía patch-package): el `BackgroundGeolocationService`
  ahora **POSTea los fixes directo** a `/reports/route-pings` con `HttpURLConnection` en un executor (cola in-memory
  con retry, token Bearer cacheado — el JWT dura 12h). Nuevo método `setUploadConfig` y opciones `uploadUrl/authToken/routeId`.
- **Aditivo**: el path JS (Dexie + drain) queda de respaldo cuando la app está viva; el server deduplica por `client_uuid`.
- Cierra el gap "capturado pero no subido al bloquear". **El Java se compila solo al armar el APK** (no en `nx build`).
- Sigue pendiente del lado device: probar **al aire libre** (el GPS no engancha indoor bloqueado) + whitelist Honor.
  `POST_NOTIFICATIONS` (notif invisible en Android 13+) no resuelto pero no bloquea el tracking.

### Added / Fixed — Auditoría del take-order del vendedor: offline-first + robustez (2026-06-29)
- Origen: auditoría del apartado "tomar pedido" de `apps/vendor` (8 hallazgos). 6 altos/medios corregidos, **builds api+vendor verdes**. Sin deploy.
- **Added — Offline-first** (`#1`, híbrido por conectividad para no regresionar el flujo online): el vendedor ahora puede **abrir, armar y confirmar** un pedido **sin señal**; se sincroniza solo al reconectar.
  - Dexie **v8**: `vendorCatalogCache` (catálogo por price-list, dedup) + `vendorCustomerCache` (cliente + habituales) → abrir sin red; `pedidosPendientes` (draft local con `serverOrderId` como guard de idempotencia).
  - Nuevos `ConnectivityService` (signal online/offline) y `OfflineOrderService` (draft local + totales client-side). `take-order` ramifica por conectividad (banner "Sin conexión", mic de voz oculto offline). `order-success` muestra "Se enviará al reconectar".
  - Replay en `OfflineSyncService.sincronizarPedidosPendientes` (createDraft → PUT lines → POST place), best-effort, idempotente. Límite: un cliente creado offline no se puede pedir offline (sin contexto cacheado).
  - **Visibilidad** (para que un replay fallido no sea un pedido perdido en silencio): sección **"Pedidos sin enviar"** en *Mi día* (chip "En cola" / "No se pudo enviar"; los muertos tras 5 reintentos tienen **Reintentar** y **Descartar**) + badge con el conteo en el header "Mi día".
- **Added — `POST /commercial/orders/:id/place`** (`#4`): toma un pedido **draft → confirmed en 1 transacción atómica e idempotente** (reemplaza el encadenado `updateDraftHeader→confirm→approve`, que ante un fallo de red dejaba el pedido en `pending_approval` y el reintento atascado en "solo desde draft"). Preventa no reserva stock (igual que `confirm`).
- **Fixed — Chattiness de red** (`#2`): cantidad **optimista** + debounce (los `+/−` ya no pegan al backend por cada tap → 1 update por ráfaga); sugerencias Thot fuera del camino caliente.
- **Fixed — Carga inicial** (`#3`): eliminado el doble `getCustomer` y el doble `draftForCustomer` al abrir un cliente (2 rondas en vez de ~8-11 requests).
- **Changed — Pedido sugerido** (`#6`): pasa de auto-armarse (riesgo de agendar de más) a **opt-in** (banner "¿Cargar pedido sugerido?").
- **Fixed — Mensaje de stock** (`#5`): ya no promete un "backorder" inexistente; en preventa avisa "stock actual bajo, se surte al repartir".
- **Internal**: borrado `updateDraftHeader` (huérfano tras `place`); eliminado `setQty`. **Pendiente**: verificación en device real + test http de `/place` en la regression.

### Fixed — Auditoría del inventario físico (Fase I): integridad + reconcile cíclico + endurecimiento (2026-06-27)
- Origen: auditoría multi-agente de `/comercial/inventory` (38 hallazgos verificados, 4 refutados). 6 bloques aplicados, **regression verde en vivo**. Detalle en `inventory-count.service.ts` + 5 migraciones `20260627*`.
- **Integridad / SoD**: el doble conteo ciego ya no se puede colapsar (nadie pisa el `count_1`/`count_2` de otra persona); el reconciliador no puede ser quien **resolvió** ítems (nueva col `resolved_by` + set de segregación); `cancel()` con `FOR UPDATE` (cierra carrera cancel↔reconcile); `submitCount`/`reconcile` **fail-closed** si no hay usuario.
- **Reconcile cíclico (reestructura, ADR-pendiente)**: los folios **no congelados** ya no se bloquean por movimientos — reconcilian con **delta relativo** contra el libro al momento del conteo (`book_at_count`), preservando las ventas ocurridas durante el conteo en vez de borrarlas con un set absoluto. Lock antes de calcular (cierra TOCTOU). El set absoluto + freeze guard se mantiene para conteos **congelados**.
- **Contabilidad de varianza**: la varianza/IRA se calcula contra `book_at_count` en cíclicos (ya no infla la merma con ventas del período); **costo congelado al reconciliar** (`unit_cost` + `net_variance_value`/`variance_value_abs` por folio) → el valor de merma no deriva si cambia `cost_base`; `reason_code` exigible en varianzas materiales (opt-in por umbral).
- **Operabilidad del día de conteo**: endpoint blind-safe `GET /commercial/inventory/counts/:id/catalog` + pre-cache offline al iniciar jornada (1er scan offline ya reconoce); escaneos rechazados (409) visibles + flush periódico + reintento; badge "Estancado" en folios y aviso anticipado de almacén congelado en Existencias.
- **Robustez**: guards del path inventory-source (CHECK `quantity>=0`/`>=reserved` + reserva en reconcile); folio de 0 ítems rechazado; año del folio en TZ MX; `statement_timeout` + logging en reconcile; kepler-export arreglado para folios inventory-source (ya no emite SKU null/$0).
- **Diferido**: aprobación por valor (#12), tolerancia/IRA por clase ABC (#17), hook GL/COGS, limpieza del CHECK de estados muertos. **Pendiente prod**: aplicar las 5 migraciones en el deploy.

### Added — Tiendas de oportunidad: prospección con INEGI DENUE (Fase DENUE) (2026-06-24)
- Nueva capa **"Tiendas de oportunidad"** en `dashboard/commercial-map`: descubre PdV reales (dulcerías,
  abarrotes, minisúper) que **aún no son clientes** vía **INEGI DENUE** (dato abierto → almacenable con atribución).
- Backend en `libs/trade/commercial-map`: `DenueClientService` (Buscar/BuscarAreaAct/Cuantificar/Ficha),
  `ProspectsService` (ingesta + **dedup** JS por haversine + Dice-bigrams contra `stores` + `commercial.customers`
  + whitespace score), `ProspectsController` (9 endpoints), cron nocturno de re-dedup. Tablas
  `commercial.prospect_sources` + `prospect_stores` (RLS forzado). Permisos `COMMERCIAL_MAP_PROSPECTS_VER/_GESTIONAR`.
- Frontend: capa aditiva reusando `MapLayer`/`MapLegend` (patrón "Personal en vivo") + dialog de prospecto +
  botón "Cosechar oportunidades (DENUE)" (cosecha por área Michoacán, geocercada). ADR-025.
- Scoping Mega Dulces: **Michoacán (entidad 16) + geocerca 100 km de La Piedad** (centro/radio en config,
  triple filtro: ingesta `passesGeo` + purga en `dedup` + filtro SQL en `list`). Cosecha robusta vía
  `BuscarAreaAct` (el endpoint `Buscar` lo rate-limitea INEGI por IP).
- **Inteligencia DENUE (opción A)**: `GET /prospects/penetration` (clientes ÷ universo por SCIAN y municipio
  + densidad por territorio + total real vía `Cuantificar`), `POST /prospects/enrich-customers` (completa
  teléfono/email vacíos de clientes desde su match DENUE), y `whitespace_score` ahora pondera el tamaño del
  negocio (`estrato`). Dialog "Penetración" + botón "Enriquecer clientes" en el mapa.
- **Aplicado a PROD**: migraciones corrieron en el deploy (tablas + config Michoacán/La Piedad sembrada +
  permisos en roles). Pendiente: `DENUE_TOKEN` en Railway + re-login para cosechar.

### Added — Salud del tracking en segundo plano + guía de ubicación (app Vendedor) (2026-06-24)
- Cuando el GPS deja de registrarse con la pantalla bloqueada, el problema #1 es operativo (permiso de
  ubicación que no es "todo el tiempo" + optimización de batería que mata el foreground service).
- `RoutePingService` ahora expone `trackingHealth()` ('ok'|'web'|'permission'|'inactive'): captura el error
  `NOT_AUTHORIZED` del watcher nativo y si el watcher quedó activo. `openSettings()` lleva a los ajustes de la app.
- **Banner** en el shell del vendedor cuando el tracking está degradado + **guía de 3 pasos** (permiso "Permitir
  todo el tiempo" / batería "Sin restricciones" / Autostart en Xiaomi-Huawei-Oppo-Vivo) + **onboarding one-time**.
- Diagnóstico pendiente (test de la notificación con pantalla bloqueada) para decidir si hace falta el plugin
  nativo de pago (`@transistorsoft/...`, HTTP nativo + heartbeat) — el actual es solo-por-movimiento y sube vía WebView.

### Changed — Basemap Mapbox (tiles) en vez de OSM, theme-aware + switcher Satélite (2026-06-23)
- El átomo de mapa compartido (`app-map`) ahora pinta con **tiles de Mapbox** (reusa el token del backend,
  expuesto como `pk.` en `environment.ts`) en vez del tile server público de OSM (que no es apto para producción:
  política de uso, sin SLA). **Una línea, un archivo** → las 4 superficies (live/rutas/comercial/field) lo heredan.
- **Theme-aware con estilos propios "Mercado"** (Mapbox Studio): claro = "Streets", oscuro = "Dark 2D" según
  el tema de la app (respeta DESIGN.md). Verificado end-to-end (tiles 200 image/png). Slots configurables.
- **Switcher Mapa/Satélite** (`satellite-streets-v12`, útil para ver la fachada del PdV) + tiles **@2x retina**.
- Centro inicial (cuando no hay datos que encuadrar) cambiado de Morelia → **La Piedad, Mich.** (`[20.2984, -101.9884]`),
  ahora input `fallbackCenter`/`fallbackZoom` overridable por pantalla. Con datos, `fitBounds` lo pisa; en Mapa en Vivo,
  seleccionar a una persona ya centra en su última posición (`panTo`).
- Fallback a OSM si falta el token (no rompe dev). El basemap NO depende de la env de Railway (token en el bundle);
  las capacidades de backend (ETA/optimize/matching) sí siguen necesitando `MAPBOX_TOKEN` en Railway.
- Pendiente: restringir el token `pk.` por URL en el panel de Mapbox (Account → Tokens) para proteger la cuota.

### Fixed — Inteligencia comercial resurfaceada tras la fusión Mapa de Campo (2026-06-23)
- La fusión MF.1 enterró el Mapa Comercial como 4ª pestaña ("Exhibición") y **rompió el acceso**: la ruta
  `field-map` solo pedía `RUTAS_VER`, así que un rol con **solo `COMMERCIAL_MAP_VER`** ya no podía llegar
  (nav sin entrada directa + guard de ruta lo bloqueaba). No se perdió data — `commercial-map` estaba intacto.
- **Restaurado**: ítem de nav directo **"Mapa Comercial"** (gateado `COMMERCIAL_MAP_VER`) bajo el grupo "Mapas".
- **Guard OR** (`anyPermissionGuard`): `field-map` ahora admite `RUTAS_VER` **o** `COMMERCIAL_MAP_VER`.
- **Default inteligente**: un rol solo-comercial aterriza directo en la pestaña Comercial (no en "Equipo" vacía);
  las pestañas de tracking solo se muestran con `RUTAS_VER`. Pestaña "Exhibición" renombrada → **"Comercial"**.

### Added — Capacidades Mapbox: geocoding, ETA, optimización, imagen (backend) (2026-06-23)
- **Geocoding** (`database/scripts/geocode-mapbox.js`): geocodifica `commercial.customers` (dirección → lat/lng)
  vía Mapbox con score de relevancia — mejor que Nominatim; mejores coords → mejor geofence/cobertura/visitas.
- **`MapboxService`** + endpoints: `GET /reports/eta` (Directions con tráfico → minutos al próximo cliente),
  `POST /reports/optimize-stops` (Optimization, orden óptimo de visita ≤12 paradas), y `map_image_url` en
  `vendor-day` (Static Images — imagen del recorrido para PDF/WhatsApp). Verificado contra Mapbox con datos reales.
- Pendiente: wiring UI (ETA/optimizar en app vendedor) + `MAPBOX_TOKEN` en Railway.

### Added — Resumen del equipo (Mapa de Campo → Equipo) (2026-06-23)
- Nueva pestaña **Equipo** (vista por defecto de Mapa de Campo): tabla del personal de campo activo hoy con
  estado en vivo, jornada, km aprox, visitas detectadas por GPS y **cuántas sin captura** (ordenada por gap).
  Clic en una fila → salta a "Por vendedor" de ese vendedor/día. Endpoint `GET /reports/team-day` (barato,
  sin map-matching: pings crudos + paradas + geofence + capturas por ventana de tiempo).

### Added — Detección automática de visitas (GPS) (2026-06-23)
- En **Mapa de Campo → Por vendedor**, las paradas geofenceadas a una tienda (≥5 min, ≤90 m) se listan como
  **visitas detectadas**, cruzadas con las capturas reales por **ventana de tiempo** (confiable, no depende del
  `store_id` ralo de capturas) → badge **capturó / sin captura**. KPI con conteo + "sin captura". Resuelve el gap
  de cobertura real: "estuvo en la tienda pero no registró visita". Sin esquema nuevo (reusa `getVendorDay`).

### Added — Mapa de Campo: superficie unificada (consolida Rutas + Historial + Comercial) (2026-06-23)
- Nuevo `/dashboard/field-map` con selector de vista **Por ruta / Por vendedor / Exhibición** (refleja `?view=`).
  Consolida 3 superficies de mapa en 1 entrada de nav (MF.1: cada vista monta su componente existente, sin
  regresión). Nav de "Mapas" baja de 4 a 2 ítems (Mapa en Vivo + Mapa de Campo). Tab Exhibición gateada
  `COMMERCIAL_MAP_VER`. Rutas viejas siguen vivas para deep-links. Pendiente MF.2+: unificar mapa + drill-down.

### Changed — Tracking: tag de plataforma + APK con fixes (2026-06-23)
- Pings ahora llevan `platform` (web/android/ios) — migración `route_location_pings.platform` + DTO + ingest +
  ambos clientes. Zanja "¿web o nativo?" en el diagnóstico de por qué un vendedor no aparece.
- APK nativo reconstruido con todos los fixes de tracking (anti-loop, heartbeat detenido, background). **Lo
  desplegado estaba viejo**: requiere redeploy + reinstalar APK + en el teléfono "Permitir todo el tiempo" +
  quitar optimización de batería para rastrear con pantalla bloqueada.

### Added — Mapa en Vivo: alertas en vivo (detenido / sin señal) (2026-06-23)
- **`FieldAlertsScannerService`** (`@Cron */4 min`, read-only sobre `route_location_pings`): detecta
  **offline** (dejó de reportar hace 20–180 min) e **idle** (≥15 min detenido dentro de 70 m). Cooldown 1 h
  por (tenant, usuario, tipo). Emite `field_alert` por el WS `/reports` (room global + equipo del supervisor).
- Cockpit: **feed de alertas** arriba de la lista (clic → enfoca a la persona) + ⚠ en las filas marcadas;
  upsert por usuario+tipo, expiran a los 20 min.

### Added — Mapa en Vivo: cockpit de supervisión (2026-06-23)
- **Clic en una persona → SidePeek** con estado, última señal, velocidad, KPIs GPS de hoy
  (km/paradas/movimiento) y botón "Ver recorrido del día" (deep-link a Historial con prefill por queryParams).
- **Trail del seleccionado**: al elegir a alguien dibuja su recorrido del día (por calles) + paradas
  sobre el mapa, junto al cursor en vivo.
- **Capa de Tiendas** (toggle): contexto del personal vs tiendas. Endpoint liviano `GET /reports/stores-geo`.
- **Estado por persona** (en traslado / en {tienda} por geofence / detenido) + **búsqueda** en la lista
  + leyenda con toggles de capa (Personal / Tiendas).

### Added — Rutas R.4: playback del recorrido (2026-06-23)
- En **Historial de vendedor**, barra de reproducción: play/pausa + slider (scrub) + velocidad 1×/2×/4×
  + reloj aproximado. Un cursor recorre la geometría pegada a calles (modo `persistent` del átomo
  app-map); la ruta completa se ve tenue y el tramo ya recorrido se resalta. Sin backend nuevo.

### Added — Rutas R.3/R.5: Historial de vendedor (día por calles + KPIs) (2026-06-23)
- Nueva vista **"Historial"** (`/dashboard/vendor-history`, nav bajo grupo "Mapas", gate `RUTAS_VER`):
  elegís **vendedor + fecha** y ves su día completo — recorrido pegado a calles, paradas y métricas.
- **KPIs (R.5)**: distancia real (km), # de paradas, tiempo en paradas, tiempo en movimiento,
  velocidad media (km/h), jornada (primer–último movimiento).
- Backend: `GET /reports/field-users?date` (vendedores con actividad GPS ese día) +
  `GET /reports/vendor-day?user_id&date` (recorrido snapped + paradas + KPIs). Enforce de scope
  (own → solo a sí mismo; team → solo su equipo). Reusa `MapMatchingService` (caché por user+día).

### Added — Rutas R.1/R.2: historial "por calles" (map-matching) + paradas (2026-06-23)
- **Recorrido pegado a la red de calles** (antes líneas rectas entre breadcrumbs): map-matching con
  **Mapbox** (`MAPBOX_TOKEN`), arquitectura matcher+caché — el recorrido de un día pasado se calcula
  una vez y se guarda en `public.route_snapped_tracks` (mig 20260623120000). El día de hoy no se cachea.
- **`MapMatchingService`** (libs/trade/reports): pings → downsample → chunks ≤100 → `/matching/v5` →
  geometría GeoJSON + distancia real. Chunk fallido cae a línea cruda. Proveedor intercambiable.
- **Paradas automáticas** (R.2): dwell ≥5 min dentro de 40 m → marcador con duración + **geofence ≤90 m**
  contra `stores` para nombrar la tienda. Llegada/salida derivadas del GPS.
- Endpoint `GET /reports/routes/:id/snapped?date=` (gate `RUTAS_VER`, scope own/team).
- Frontend **Rutas**: toggle "Por calles" → dibuja la geometría snapped + paradas + "X km reales".
- Requiere en deploy: aplicar la migración + setear `MAPBOX_TOKEN` en Railway (sin token degrada a línea cruda).

### Added — MapKit: núcleo de mapa compartido + cruce de contexto en vivo (2026-06-23)
- **Átomo `app-map` ampliado (aditivo)**: input `layers: MapLayer[]` (cada capa en su `L.LayerGroup`,
  conmutable sin redibujar las demás), modo `persistent` (mueve marcadores con `setLatLng` para tracking
  fluido), `MapMarker.kind:'user'` + `ring`, `autoFit:'always'|'once'|'off'`, métodos `recenter()/panTo()/invalidate()`.
  Defaults = comportamiento legacy byte-por-byte (routes/commercial/logística intactos).
- Nuevos shared: `map-legend/` (toggles de capa + conteo), `core/services/map-live-layer.service.ts`
  (capa de posiciones en vivo reutilizable: seed `/reports/live-positions` + stream WS `route_ping`),
  `shared/util/relative-age.ts` (frescura + edad relativa tokenizada).
- **Capa "Personal en vivo"** opcional en **Mapa Comercial** y **Rutas** (gateada `RUTAS_VER`): superpone
  vendedores en tiempo real sobre las tiendas / sobre el recorrido histórico — el cruce de contexto del supervisor.
- Nav: las 3 superficies de mapa agrupadas bajo sección **"Mapas"**.

### Changed — live-map migrado al átomo MapKit
- `live-map` consume `app-map` (modo `persistent`) + `MapLiveLayerService`; se borró su Leaflet inline propio
  y `live-tracking.service.ts`. Sin cambio funcional visible.

### Fixed — off-by-one de fecha en TZ México
- `routes-analysis` (`isoOffset`) y `commercial-map` (`fmtDate`) ahora formatean la fecha en
  `America/Mexico_City`, no en la TZ del browser (evita cargar el día equivocado fuera de MX).

### Internal — diferido (con razón)
- `logistica-live → WS`: consume `liveShipments()` (agregado por embarque, no pings de usuario) → requiere
  emisión WS por embarque en backend; no es swap limpio.
- Migración de drill-down de `commercial-map` a SidePeek+Customer360 (regla #8 DESIGN.md): pendiente de QA visual.

### Added — PA.4a: conteo particionado por pasillo (foundation + avance por pasillo)
- `openCount` ahora **stampa `items.aisle_id`** desde `commercial.stock.aisle_id` al abrir el folio (modo
  commercial) → el conteo queda particionado por pasillo. (Modo inventory/SKU: aisle_id null, fase posterior.)
- `aisleProgress(countId)` + **`GET /commercial/inventory/counts/:id/aisle-progress`** (gate SUPERVISAR):
  por pasillo → total / contados / sin contar / discrepancias / resueltos, + bucket "sin pasillo".
- Build api verde + checks en el smoke PA.3+PA.4 (2 pasillos × 2 items stampeados, 0 sin pasillo). ⏳ reinicio.
  Siguiente PA.4b: el contador cuenta SOLO su pasillo (submitCount enforce) + freeze por pasillo.

### Changed — reparto de equipos = PAREJO (se eliminó el generador proporcional PA.2)
- Decisión del usuario 2026-06-19: el reparto de contadores por pasillo es **parejo** (contadores ÷ pasillos),
  no proporcional-a-unidades. Se **eliminó** el generador proporcional de PA.2 (`WarehouseAislesService.generateTeamPlan`,
  `POST /commercial/inventory/aisles/plan`, y su smoke `http-inventory-team-plan-test.js`). El generador
  vive en el tablero por folio (PA.3 `generate-teams`, parejo). Addendum en ADR-024. Reintroducir proporcional
  como `mode` si se necesita.

### Added — PA.3: tablero de equipos por folio (staffing por pasillo) + smoke
- `InventoryTeamService` + `InventoryTeamController`: `GET/POST /commercial/inventory/counts/:id/aisle-teams`
  (board + set manual) y `POST .../generate-teams` (auto-generar). Persiste supervisor + contadores **por
  pasillo** en `inventory_count_assignments.aisle_id`. **Generador parejo** (contadores ÷ pasillos, resto de
  a 1). Frontend `/comercial/inventory/sessions/:id/teams` (grilla 2D, pool del día, auto + ajuste manual)
  + botón "Equipos por pasillo" en el detalle del folio. Build view+api verde + **smoke PA.3** agregado.
- **⚠️ Divergencia de generador (pendiente de reconciliar):** PA.3 usa reparto **parejo** (decisión del
  usuario, override del proporcional de ADR-024). El `/aisles/plan` proporcional-por-unidades (PA.2) queda
  como preview alternativo, no usado por el tablero. ⏳ reinicio + QA visual.

### Added — PA.2: generador de equipos proporcional (1 supervisor/pasillo + contadores por unidades)
- `WarehouseAislesService.generateTeamPlan` + **`POST /commercial/inventory/aisles/plan`** (gate `ASIGNAR`):
  dado un almacén + pool del día (supervisor_ids / counter_ids; default = todos los asignables por permiso),
  arma el plan — **1 supervisor por pasillo** si hay suficientes, o **clusters balanceados (LPT)** si hay
  menos supervisores que pasillos; **contadores proporcionales a las unidades** de cada pasillo
  (`c_i = max(min, round(C·w_i/W))`, con ajuste de redondeo para repartir exactamente C). Warnings de
  faltantes (supervisores/contadores). **No persiste** (la asignación a un folio es PA.3).
- Build api verde + smoke PA.2 (`http-inventory-team-plan-test.js`, registrado): 1:1 supervisor, Σ
  contadores = pool, mín por pasillo, pasillo más pesado ≥ contadores, cluster con 1 supervisor. ⏳ reinicio.

### Added — PA.1b: editor 2D de pasillos (UI) + endpoint de marcas
- Página **`/comercial/inventory/aisles`** (tab "Pasillos" en el strip de inventario, gate `ASIGNAR`).
  Surface Operations (DESIGN.md): **grilla CSS 2D** — cada pasillo en su `grid_row/col`+span, con
  código/nombre/carga (unidades + #SKUs) + barra de carga; **panel lateral** al seleccionar (editar
  nombre/posición · borrar con confirm · **asignación bulk** SKU→pasillo en 4 modos: **marca / clase ABC /
  rango SKU / sin-asignar**); tile "Sin pasillo"; dialog "Nuevo pasillo". `tabular-nums`, in-page hairline.
- Backend: **`GET /commercial/inventory/aisles/brands`** (marcas con stock en el almacén, para el dropdown
  de asignación) + `ComercialService` { listAisles, aisleBrands, createAisle, updateAisle, deleteAisle, assignSkusToAisle }.
- **Layout de pasillos completo** (PA.0 schema + PA.1a backend + PA.1b UI). Build view+api verde.
  ⏳ QA visual + reinicio. Siguiente: PA.2 (generador de equipos proporcional).

### Added — PA.1a: backend de pasillos (CRUD + mapeo bulk SKU→pasillo + carga)
- `WarehouseAislesService` + **`/commercial/inventory/aisles`** (gate `COMMERCIAL_INVENTORY_ASIGNAR`):
  CRUD de pasillos (posición 2D `grid_row/col` + `span`); `GET ?warehouse_id=` devuelve cada pasillo con su
  **carga** (unidades = `Σ quantity` + `#SKUs`) + el bucket **"Sin pasillo"**; **`POST .../assign`** mapea
  SKUs→pasillo en **bulk** por filtro (`product_ids` / `brand_id` / `abc_class` / rango SKU / `only_unassigned`;
  `aisle_id=null` des-asigna).
- Guards: código único por almacén (409), borrar pasillo **bloqueado si un folio abierto lo usa**, `assign`
  exige al menos un filtro (anti assign-all accidental). Setear `stock.aisle_id` NO dispara el trigger FEFO.
- Build api verde + smoke PA.1 (`http-inventory-aisles-test.js`, registrado). ⏳ requiere **reinicio**.

### Added — PA.0: schema de pasillos 2D + dimensión de pasillo en el conteo (ADR-024)
- Arranca la **Fase PA** (conteo zonificado): el almacén se divide en **pasillos 2D**, 1 supervisor/pasillo,
  equipo de contadores proporcional. Diseño en `FASES/FASE_PASILLOS_EQUIPOS.md` + **ADR-024**.
- **`commercial.warehouse_aisles`** (mig `20260619140000`, RLS forzado): layout permanente — `code`, `name`,
  posición 2D (`grid_row/col` + `span`), por almacén. + **`commercial.stock.aisle_id`** (mapeo SKU→pasillo,
  grano warehouse×product) + **`inventory_count_assignments.aisle_id`** (tablero por folio; unique recreado a
  `(tenant,count,aisle,user,role)` NULLS NOT DISTINCT para permitir supervisor en varios pasillos) +
  **`inventory_count_items.aisle_id`** (foto al abrir → particiona el conteo).
- FK de `aisle_id` = columna simple a `warehouse_aisles.id` con **`ON DELETE SET NULL`** (borrar un pasillo
  NO borra stock/items; el order flow ignora `aisle_id`). Verificado DB-direct (alta, mapeo, carga en
  unidades, SET NULL). Decisiones: dominio inventario · alta manual · proporcional a unidades · grilla · híbrido.

### Added — ABC.3b: UI de conteo cíclico (cierra la fase ABC)
- Página **`/comercial/inventory/abc`** (tab "Cíclico" en el strip de inventario, gate SUPERVISAR).
  Superficie **Operations** (DESIGN.md): page-head Hanken bold, **KPI strip** (Por contar ahora · Valor
  clasificado · barra de Distribución ABC) + **tabla densa** con dos vistas (`p-selectButton`): **Agenda
  de conteo** (cycle-due, accionable) y **Clasificación ABC** (por valor de consumo).
- Acciones: **Recalcular ABC** (ghost → `/abc/refresh`) y **Generar folios** (sunset → `/abc/generate-cycle-folios`,
  habilitado al elegir almacén + confirm dialog). `p-tag [severity]` mapeado (A=success/B=warn/C=secondary;
  due=danger/warn/secondary), `tabular-nums` en cifras, empty states con CTA, in-page hairline sin sombra.
- Backend: nuevo **`GET /commercial/inventory/abc/summary`** (conteo+valor por clase para KPIs exactos sin
  cargar todas las filas) + `ComercialService` { abcSummary, listAbc, cycleDue, refreshAbc, generateCycleFolios }.
- **Fase ABC completa en código** (clasificar → due → contar acotado → automatizar → UI). Build view+api
  verde + summary en smoke I.6. ⏳ QA visual + reinicio.

### Added — ABC.3a: scheduler de conteo cíclico (cron + disparo manual)
- `CycleCountSchedulerService` — `@Cron('0 0 8 * * *')` (gateado por `ENABLE_CYCLE_COUNT_CRON=true`):
  itera tenants en `tenantCtx.run({tenantId})` (CLS sintético, patrón recommendations-refresh) → por
  almacén toma lo que está due (ABC.1, prioriza A, cap 50) y abre un folio cíclico acotado (ABC.2).
  Anti-duplicado: si el almacén ya tiene folio abierto → `skipped` (no re-crea).
- **`POST /commercial/inventory/abc/generate-cycle-folios`** (gate SUPERVISAR, scoped al tenant del JWT,
  opcional `warehouse_id`/`max_items`): disparo manual del scheduler (para QA / on-demand).
- Backend del control continuo **completo** (clasificar → ver due → contar acotado → automatizar). Solo
  resta ABC.3b (UI). Smoke I.7 §5 (genera 1 folio + anti-duplicado). Build verde. ⏳ requiere reinicio.

### Added — ABC.1: due/agenda de conteo cíclico (cycle-due)
- `InventoryAbcService.cycleDue()` cruza `commercial.abc_classification` × historial reconciliado
  (`MAX(inventory_counts.reconciled_at)` por (almacén,producto) de folios `reconciled`) → calcula
  `next_due = last_counted_at + cadencia(clase)` (A=30 / B=90 / C=365 días); nunca contado = due ya.
- **`GET /commercial/inventory/abc/cycle-due`** (?warehouse_id=&abc_class=&only_due=, gate SUPERVISAR):
  lista lo que toca contar, orden A-primero / más-vencido-primero, con `is_due`, `next_due`, `days_overdue`
  y summary `by_class`. Con ABC.0+ABC.1+ABC.2 el flujo manual está completo (clasificar → ver qué toca →
  contar solo eso).
- Verificado DB-direct (`database/scripts/verify-abc-cycle-due.js`: orden A→C, cadencia 30/365,
  nunca-contado → due + next_due null) + smoke I.6 §5. Build verde. ⏳ requiere reinicio para verde live.

### Added — ABC.2: conteo cíclico acotado (open-cycle)
- El corazón del conteo cíclico: hoy `openCount` sembraba **todo** el almacén (`type='cycle'` no acotaba
  nada). Ahora `openCount` acepta `product_ids?` → siembra solo ese subset (commercial por `product_id`;
  inventory mapea a `sku` vía catalog). Nuevo `openCycleCount` + **`POST /commercial/inventory/counts/open-cycle`**
  (gate SUPERVISAR): genera un folio `type='cycle'` por **clase ABC** (toma los productos de esa clase del
  almacén desde `abc_classification`) o por **lista explícita**, capeado, con **freeze=false** por default
  (un cíclico no congela el almacén; el full sigue congelando).
- **Freeze-integrity guard scopeado a los productos del folio**: un movimiento de un SKU que el folio NO
  está contando ya no bloquea el reconcile. Para un full count el comportamiento es idéntico (items =
  snapshot completo); habilita el cíclico en caliente. (La I.5 A1 sigue válida: el movimiento del producto
  contado sí bloquea.)
- Smoke I.7 (`http-inventory-cycle-count-test.js`, registrado): open-cycle por clase → 3 items; por lista →
  exactamente el subset; sin clase/lista → 400. Build api verde. ⏳ requiere **reinicio** para verde live.

### Added — ABC.0: clasificación ABC por (almacén, producto)
- Primer paso de **conteo cíclico programado** (ver `FASES/FASE_ABC_CYCLE_COUNT.md`). Clasifica cada
  (almacén, producto) por **valor de consumo anualizado** (unidades vendidas en pedidos `fulfilled`,
  ventana 90d → anualizada × `catalog.cost_base`), vía **Pareto por almacén** (share acumulado
  **exclusivo**: el top mover siempre cae en A — el inclusivo mandaba a C al único mover de un almacén).
- **`commercial.abc_classification`** (mig `20260619100000`, RLS forzado, FKs compuestas, unique natural
  por (tenant,wh,product)). Recompute full atómico (DELETE+INSERT en una trx).
- **`InventoryAbcService`** + **`GET /commercial/inventory/abc`** (?warehouse_id=&abc_class=) y
  **`POST /commercial/inventory/abc/refresh`** (?window_days=), ambos gate `SUPERVISAR` (como IRA).
- Verificado DB-direct (`database/scripts/verify-abc-compute.js`: 32 849 clasificados, SQL válido,
  toda fila clase ∈ {A,B,C} + value_share ∈ [0,1]). Smoke I.6 (`http-inventory-abc-test.js`, registrado
  en run-all-tests). Build api verde. ⏳ requiere **reinicio** para verde live (endpoints nuevos).

### Added — P2.3 FEFO: trazabilidad del lote consumido por cada venta
- **`commercial.stock_lot_movements`** (mig `20260618230000`, RLS forzado, append-only, FKs compuestas a
  tablas reales): ledger por lote de qué se consumió, cuánto, y por qué referencia (pedido).
- **`OrderStockService.consume`** ahora hace **diff before/after** de `stock_lots` (el trigger ya hace el
  decremento FEFO; acá se **observa** el resultado real, sin re-simular) y registra una fila por lote
  consumido, ligada al `order_id`. Misma trx; sin cambios de comportamiento ni montos.
- **`GET /commercial/inventory/lot-movements`** (gate `AJUSTAR`, como `/movements`): filtros `lot_code`
  (recall "¿qué pedidos consumieron el lote X?"), `reference_id` ("¿de qué lotes salió el pedido Y?"),
  `product_id`/`warehouse_id`.
- Build api verde + check en smoke alerts (pedido que despacha lote vencido → lot-movement qty 5 ligado
  al pedido). ⏳ requiere **reinicio** (es código de API). Deferred: trazar ajustes/reconcile a nivel lote.

### Added — P2.2c FEFO: dashboard "Por vencer" (cierra P2.2)
- **Página `/comercial/inventory/expiring`** (gate `COMMERCIAL_INVENTORY_VER`, tab "Por vencer" en el strip
  de inventario): consume `GET /commercial/inventory/expiring`. KPIs (valor en riesgo al costo / # lotes /
  # ya vencidos), tabla con tag de días-a-caducar (vencido + ≤7d = `danger`, ≤15d = `warn`), filtro de
  ventana (7/15/30/60/90 días) + almacén. Fila resaltada si está vencida.
- `ComercialService.listExpiringLots()` + interfaz `ExpiringLot`. Build view verde. ⏳ verificación visual manual.
- **P2.2 (caducidad/FEFO) = completa** beta scope: captura → endpoint → alerta cron → gate warn → dashboard.
  Verificado live: I.5 26/26, alerts WS 25/25, trigger expired-last (script + J.6.1 19/0). Siguiente: P2.3.

### Added — P2.2d FEFO: no despachar vencido primero + aviso `sold_expired` (warn, NO block)
- **Decisión** (addendum ADR-022): la política de venta de vencidos es **avisar, no bloquear** — para
  no meter el motor en el camino del dinero (reserva). Reversible a block configurable si el negocio lo pide.
- **Trigger expired-last** (mig `20260618220000`, `CREATE OR REPLACE` de `fn_rebalance_stock_lots`): el
  decremento FEFO ahora consume **lotes no-vencidos primero** (`ORDER BY (expiry<hoy) ASC, expiry ASC`),
  vencidos solo como último recurso. La venta normal ya no despacha producto caducado. Invariante intacto.
  **Verificado** (`database/scripts/verify-fefo-expired-last.js`: bueno baja 10→5, vencido queda 10) +
  order flow **J.6.1 19/0** sin cambios.
- **Aviso `sold_expired`**: `OrderStockService.consume` devuelve `expiredConsumed` (= `qty − bueno_no_vencido`);
  `OrdersService.fulfillInTransaction` acumula los hits y emite alerta WS `warn` (`AlertsService.emitSoldExpired`)
  cuando un despacho tocó lote vencido. Cambio **no-bloqueante** y sin alterar montos. Nuevo tipo `sold_expired`.
- Build api verde + check WS en smoke alerts (almacén con solo lote vencido → fulfill → recibe `sold_expired`).
  ⏳ la parte de aviso requiere **reinicio** para probar live (el trigger ya está activo, es DB-level).

### Added — P2.2b FEFO: cron de alerta de lotes por vencer
- **`AlertsScannerService` scan #3** (`expiring_lots`): detecta lotes de `commercial.stock_lots` con
  `expiry_date <= hoy+30d` y `quantity > 0` (incluye **vencidos**) → emite alerta WS vía nuevo
  `AlertsService.emitExpiringLots` con severidad `critical` (≤7 días o vencido) o `warn`. Reusa el
  patrón de `low_stock` (scoping por `SET LOCAL app.tenant_id`, cooldown 1h anti-spam). Cron global
  sigue gateado por `ENABLE_COMMERCIAL_ALERTS`; `POST /commercial/alerts/scan-now` lo dispara manual.
- Nuevo tipo `expiring_lots` en `AlertType` + umbrales `EXPIRING_LOTS_DAYS=30` / `EXPIRING_LOTS_CRITICAL_DAYS=7`.
- Build api verde + check WS en el smoke de alerts (almacén dedicado + lote a +3d → recibe alerta `critical`;
  almacén soft-deleteado queda inactive y no se re-escanea). ⏳ requiere **reinicio** para probar live.
- P2.1b + P2.2a ✅ **verificados LIVE** (smoke I.5 26/26 tras reinicio): captura de lote, `/lots`, `/expiring`.
- Roadmap actualizado: P2.2b dividido → P2.2b alerta (✅ código) / P2.2c dashboard "Por vencer" / P2.2d
  gate de venta de vencidos (diseño primero — conflige con el invariante del trigger).

### Added — P2.2a FEFO: endpoint de lotes por vencer (base de alertas de caducidad)
- **`GET /commercial/inventory/expiring?days=30&warehouse_id=`** (gate VER): lotes con caducidad
  ≤ hoy+`days` y stock > 0 (incluye **vencidos** — `days_to_expiry` puede ser ≤0), con
  producto/almacén/`value_at_cost`, orden por caducidad ASC. Base del dashboard/cron de caducidad
  (P2.2b). Build api verde + checks en smoke I.5 (ventana 90 incluye el lote a +60d, ventana 30 no).
- Endurecido el smoke I.5: un endpoint ausente ya no tumba la suite (guard array-or-not).
- ⏳ P2.1b + P2.2a son código de API → requieren **reinicio** para probar live.

### Added — P2.1b FEFO: captura de lote/caducidad en recepción + lectura de lotes
- **`POST /commercial/inventory/movements`** (`recordMovement`) acepta `lot_code` + `expiry_date`
  (YYYY-MM-DD) en movimientos `'in'` (recepción): upserta el **lote real** en `commercial.stock_lots`
  **antes** del update de stock, y el trigger `trg_rebalance_stock_lots` mantiene el lote `NA`
  balanceado (SUM(lotes)=stock sigue valiendo).
- **`GET /commercial/inventory/stock/:warehouse_id/:product_id/lots`** (gate VER): lotes de un
  producto en un almacén, **orden FEFO** (caducidad ASC, NULLS al final). Habilita P2.2 (alertas
  "por vencer") y P2.5 (mostrar caducidad al vender).
- Build api verde + check en smoke I.5. ⏳ Requiere **reinicio de API** para probar live (código de API).

### Added — P2.1a FEFO: trigger del invariante stock↔stock_lots (+ FEFO-decrement)
- **Trigger `trg_rebalance_stock_lots`** (mig `20260618210000`) `AFTER INSERT OR UPDATE OF quantity ON
  commercial.stock`: mantiene `SUM(stock_lots.quantity) = stock.quantity` para **todos** los writers
  (order flow, ajustes, reconcile, route) **sin tocar código de servicio**. El lote `NA` balancea; una
  baja que excede el buffer NA **decrementa lotes reales FEFO** (caducidad ASC) → ya cubre el grueso
  del consumo FEFO (P2.3).
- Reserved a nivel de lote **diferido** (P2.3): se ponen en 0 los `reserved_quantity` de lotes; el
  reserved sigue intacto en `commercial.stock`. La fase 1 mantiene el invariante de **quantity**.
- **Verificado**: lógica del trigger (aumento / recepción de lote real / baja con decremento FEFO, en
  trx con rollback) + **order flow real** (`http-shipment-hook-fulfill-test` 19/0, el consume escribe
  stock y dispara el trigger) + inventario 22/0. Cambio DB-only (no requiere reinicio de API).
- Siguiente **P2.1b**: captura `lot_code`+`expiry_date` en recepción (`recordMovement('in')`) — sin
  ella todos los lotes son `NA`. Ver `FASES/FASE_FEFO_CADUCIDAD.md`.

### Added — P2.0 Caducidad/FEFO: sub-ledger de lotes `commercial.stock_lots` (ADR-022)
- **Nueva tabla `commercial.stock_lots`** (mig `20260618200000`): descompone `commercial.stock` por
  `(lote, fecha_caducidad)`. `commercial.stock` sigue siendo el **total autoritativo**; invariante
  `SUM(stock_lots.quantity) por (tenant,wh,product) = stock.quantity`. Base para FEFO sin reescribir
  el order flow. RLS forzado, FKs compuestas a tablas reales (`identity.tenants`,
  `commercial.warehouses`, `catalog.products`), unique natural `NULLS NOT DISTINCT`, índice FEFO.
- **Backfill**: 1 lote `NA` (sin caducidad) por cada fila de `stock` (32 835 local) → invariante OK
  desde el día 1, verificado (0 desbalances).
- **Gate del ERP resuelto**: la data sincronizada **no trae caducidad** → P2.1 será **captura en
  recepción** (no sync). Plan P2.0–P2.5 en `FASES/FASE_FEFO_CADUCIDAD.md`. Sin cambios de runtime aún.

### Added — Inventario físico: tolerancia + count-back (P1, cierra fase)
- **Umbral de recuento por folio** (`recount_threshold_pct`, mig `20260618190000`, default 0 = off):
  en `computeDiscrepancies`, items cuyos conteos **coinciden** pero cuya |varianza vs teórico| excede
  `expected·pct/100` **no se auto-resuelven** → quedan en `discrepancy` para forzar recuento/revisión
  antes de mover el saldo (control estándar: out-of-tolerance ⇒ count-back).
- **Frontend**: input "Umbral de recuento %" en el dialog de abrir folio (`/comercial/inventory/sessions`).
- Smoke I.5 cubre el caso fuera-de-tolerancia. **Cierra P1** (A3 ledger + reason-codes + IRA + tolerancia).

### Added — Inventario físico: KPI de exactitud (IRA) + shrinkage por causa (P1)
- **Endpoint `GET /commercial/inventory/counts/ira`** (gate SUPERVISAR): sobre folios
  **reconciliados** (filtros `warehouse_id`/`from`/`to`/`tolerance_pct`) computa **IRA por piezas**
  (items dentro de tolerancia / total), **exactitud por valor** (1 − Σ|Δ|·costo / Σ teórico·costo),
  **variación neta** (merma/sobrante en $), **shrinkage por causa** (desglose por `reason_code`) y
  **IRA por folio**. Tolerancia configurable (default 0 = exacto; benchmark industria meta >97%).
- **Frontend** nueva página `/comercial/inventory/ira` ("Exactitud (IRA)", nav gate SUPERVISAR):
  KPI cards (IRA / exactitud valor / variación neta / folios), filtro por almacén + tolerancia,
  tabla de shrinkage por causa y folios recientes con IRA y merma. Smoke I.5 verifica el shape.

### Added — Inventario físico: reason-codes de varianza (P1)
- **Clasificación estructurada del motivo de varianza** al resolver un item (merma / caducado /
  dañado / robo / error_conteo / error_sistema / devolución / transferencia / encontrado / otro)
  en vez de solo `notes` libre. `caducado` es clave para dulcería. Taxonomía validada a nivel
  servicio (`VARIANCE_REASONS`), extensible sin migración.
- **Migración `20260618180000`**: columna `reason_code` en `inventory_count_items` y propagada al
  **ledger** (`commercial.stock_movements` + `inventory.warehouse_stock_movements`) → analytics/IRA
  podrán agregar shrinkage por causa sin re-joinear los items del folio.
- **Endpoint** `GET /commercial/inventory/counts/variance-reasons` (gate SUPERVISAR) para el dropdown.
- **Frontend**: el dialog "Resolver item" (`/comercial/inventory/sessions/:id`) ahora tiene un
  selector de motivo (`p-select`) + nota de detalle; la clasificación persiste y sobrevive a
  re-computar discrepancias. Smoke I.5 extendido (catálogo + persistencia de `merma`).
- Habilita el siguiente P1 (KPI de IRA + dashboard de shrinkage por causa).

### Added — Inventario físico: ledger auditable + costo en modo `inventory` (P1/A3)
- **Nueva tabla `inventory.warehouse_stock_movements`** (mig `20260618170000`): bitácora append-only
  por SKU, espejo de `commercial.stock_movements` para el mundo `inventory.*` (RLS forzado, grant
  `app_runtime`). La reconciliación de folios en **modo inventory** ya **deja rastro** (`adjust` con
  before/after, `reference_type=inventory_count`) — antes ajustaba `inventory.warehouse_stock` sin
  auditoría.
- **`getProgress.value_at_variance` deja de salir $0 en modo inventory**: costo proxy derivado de
  `inventory.products` (`venta_valor_costo_anual / venta_unidad_anual`), con fallback a
  `catalog.products.cost_base`. El supervisor ya ve el $ en riesgo en folios inventory-source.
- Pendiente: test E2E del modo inventory (el smoke I.5 cubre modo commercial). Ver `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Inventario físico (conteo): endurecimiento de correctness (P0)
- **Freeze integrity guard en `reconcile`**: si el almacén no quedó congelado y hubo movimientos
  de stock desde que se abrió el folio, la reconciliación (set absoluto al físico) **borraba esas
  ventas**. Ahora `reconcile` **bloquea** con error claro si detecta `stock_movements` (ref ≠
  `inventory_count`) desde `started_at` (modo `commercial`).
- **`computeDiscrepancies` ya no revierte resoluciones manuales**: re-correr "calcular
  discrepancias" devolvía items `resolved`→`discrepancy` (bloqueando el reconcile) y pisaba
  overrides del supervisor. Ahora salta los `resolved`.
- **Segregación en el 3er conteo (desempate)**: `submitCount` rechaza `count_3` de quien ya hizo
  `count_1`/`count_2` de ese SKU (antes solo `count_2` tenía segregación).
- Verificado en LOCAL que `inventory_count_items.product_id` es nullable + FK dropeada (modo
  `inventory`). **Pendiente confirmar en prod**. Roadmap P1/P2 en `FASE_I_INVENTARIO.md` §I.5.

### Fixed — Stock: freeze guard en `release` + error claro al entregar sin físico
- **`OrderStockService.release` ahora respeta el freeze guard** (`assertNotFrozen`), igual que
  `reserve`/`consume`. Antes, con un conteo físico congelado (`freeze_movements`), cancelar /
  borrar / reducir-línea de un pedido **sí movía `reserved_quantity`** a media cuenta y falseaba
  la varianza. **Cambio de comportamiento:** esas acciones ahora devuelven **409** mientras el
  almacén tenga un folio de inventario abierto (intencional — el conteo es breve, se reintenta al cerrar).
- **`OrderStockService.consume`**: si el físico no alcanza al entregar (caso preventa, que no
  reserva al confirmar por diseño), rebota con **409 claro** en vez de la violación cruda de
  `CHECK quantity>=0`. No cambia el diseño de preventa.

### Removed — Scanners de alertas huérfanos (split L.7 abortado)
- Borrados `commercial-alerts/low-stock-scanner.service.ts` y `vip-inactive-scanner.service.ts`:
  nunca se registraron como providers (sus `@Cron` jamás corrieron). `AlertsScannerService` queda
  como única fuente de `low_stock` + `vip_inactive` (gateado por `ENABLE_COMMERCIAL_ALERTS`).
  Elimina el footgun de doble emisión. Ver `FASE_L_SCHEMA_REORG.md` §L.7.

### Added — CM.6 · "Productos más frecuentes" por tienda en el Mapa Comercial
- En el detalle de tienda (`/dashboard/commercial-map`), nueva sección con los **productos que más
  aparecen en las capturas de esa tienda** (`daily_captures.exhibiciones[].productosMarcados`):
  ranking por **en cuántas visitas apareció** (+ veces marcado). Backend
  `GET /commercial-map/stores/:id/top-products` (gate `COMMERCIAL_MAP_VER`, store-céntrico
  tenant+zona). Smoke extendido.
- **Decisión de fuente:** se evaluó el ERP Kepler (`ventas.tercero_id`) pero las tiendas auditadas
  **no cruzan** con los clientes de venta del ERP (0/35 por código, ~7/35 por nombre — universos
  distintos: PdV de trade vs terceros-persona del ERP). Por eso la fuente son las **capturas** (sí
  ligadas a la tienda por `store_id`). Se revirtió la maquinaria ERP/Thot explorada (feature
  `customer_product_history` + señal de historial en `thot.suggest`): con 3.4% de linkage no
  aportaba. Thot queda igual.

### Added — CM.5 · Superbuscador de productos en el Mapa Comercial + ruta de la tienda
- **Endpoint `GET /commercial-map/product-presence`** (gate `COMMERCIAL_MAP_VER`): dado `q`
  (contains ILIKE sobre nombre/sku/barcode) **o** `product_ids` (CSV, ej. del matcher IA),
  devuelve las **tiendas y las visitas** donde esos productos aparecen en
  `exhibiciones[].productosMarcados` (contención JSONB `@>`, GIN-friendly). Store-céntrico
  (tenant + zona, sin filtro own/team); cada visita trae `matchedProducts`. Coord híbrida.
- **Frontend**: superbuscador en `/dashboard/commercial-map` con toggle **"Inteligente"** —
  ON interpreta el texto vía matcher IA Fase K (`/api/ai/products/match-ai`, Voyage) → product_ids
  → presencia, con **fallback automático a contains** si la IA no da match o no está disponible.
  Al buscar, el **mapa se filtra** a las tiendas con el producto (resaltadas) y un **panel de
  resultados** lista cada tienda (con su ruta) → visitas donde apareció (folio/fecha/vendedor +
  productos que matchearon); clic en tienda abre su historial; botón "Limpiar".
- **Ruta de la tienda** ahora en la info: `getStoreHistory` devuelve `store.ruta` (join a
  `catalogs`), mostrada en el detalle de la tienda y en el header del dialog de visita.
- Smoke `http-commercial-map-test.js` extendido (product-presence por ids y por `q` + ruta).
  **Requiere reinicio de la API** para registrar la ruta nueva (HMR no re-registra rutas).

### Added — Fase I.4 · Asignación de personas a un folio de inventario
- **Permiso `COMMERCIAL_INVENTORY_ASIGNAR`** (enum BE+FE, ability.factory, permission-meta, seed + backfill a superadmin/admin/supervisor). Quién puede asignar contadores/supervisores a un folio.
- **Migración `20260615160000`**: `commercial.inventory_count_assignments` (count_id, user_id, assignment_role counter|supervisor, assigned_by; RLS; FK cascade al folio).
- **Backend** (endpoints en `/commercial/inventory/counts`): `GET assignable-users?role=` (usuarios cuyo rol tiene CONTAR/SUPERVISAR), `GET :id/assignments`, `POST :id/assignments` (reemplaza la lista de un rol), `GET mine` (folios que el contador puede contar). **Opt-in por folio**: si un folio tiene contadores asignados, `submitCount` solo deja contar a ellos; si no tiene ninguno, queda abierto (compat). El contador ahora ve solo sus folios (o los abiertos).
- **Frontend**: en el detalle del folio (`/comercial/inventory/sessions/:id`), panel con dos MultiSelect — **Contadores** y **Supervisores** asignados (guarda al cerrar el panel). Visible solo con permiso ASIGNAR. La página de Conteo usa `mine` (cada contador ve lo que le toca).

### Added — Reporte de stock muerto (capital parado)
- **Backend** `GET /commercial/analytics/dead-stock?warehouse_id=&limit=` (gate ORDERS_VER): existencia > 0 sin venta en **90 días** (`sales_units_90d = 0` estricto — NULL = rotación no computada, no se reporta) → capital parado al costo, items + resumen por almacén. Usa `catalog.products` (la vista public no expone rotación). Migración `20260615150000` agrega `sales_units_90d`; el feed de rotación Kepler ahora lo persiste (ventana 90d evita falsos positivos estacionales como el aguinaldo navideño que 30d marcaba). KEPLER-03: **473 SKUs / $1.22M parado**.
- **Frontend** página `/comercial/dead-stock` ("Stock muerto", nav, icono alerta): KPIs (capital parado / SKUs), resumen por almacén, tabla densa (almacén/SKU/producto/marca/rotación/existencia/costo/capital) con filtro por almacén y paginación. Accionable para compras (liquidar / dejar de surtir).

### Added — Write-back de Fase I → formato de ajuste Kepler (export)
- Endpoint `GET /commercial/inventory/counts/:id/kepler-export` (gate RECONCILIAR): toma un folio de inventario **reconciliado** y emite el ajuste en formato Kepler — sucursal (de `KEPLER-NN`), y por cada varianza: `InvOut` (merma, variance<0) / `InvIn` (sobrante, variance>0) con cantidad, unidad, costo y valor; summary merma/sobrante/neto. Mapeo descifrado de `doctype`: PhysInv (ND3001) / InvIn (NA2002) / InvOut (ND0502). **No escribe en el ERP** (producción, header 200 cols, import desconocido) — produce el documento para importar/capturar. Validado: AGUA −4→InvOut $9.93, CHURRO +5→InvIn $22.68.

### Added — Proveedores reales de Kepler → suppliers + products.supplier_id
- **Migración `20260615140000`**: tabla `catalog.suppliers` (code/name, RLS, FK tenant) + `catalog.products.supplier_id` (FK `ON DELETE SET NULL (supplier_id)` PG15+). El `category_id` previo era inconsistente (a veces proveedor real, a veces depto genérico) → queda deprecado, no se toca (usado en thot/pricing/analytics); la taxonomía real ya vive en department/product_line.
- **Importer** `import-kepler-suppliers.js`: siembra **542 proveedores** desde `kdig` y enlaza **7,221 productos** a su proveedor real vía `kdii.c3`. Top: MONDELEZ 297 / FÁBRICAS SELECTAS 294 / DE LA ROSA 246. Verificado: AGUA→NUEVA WALT MART (antes mal como "ABARROTES"), KINDER→FERRERO, CHURRO→JUANA AYALA. (Costo de compra disponible en `kdpv_prov_prod` si se requiere; cost_base ya está poblado.)

### Added — UoM real + taxonomía de categorías de Kepler → products
- **Mapeo descifrado** de catálogos de dimensión Kepler: `kdid`=unidad (PZA/PAQ/CJA/KG), `kdie`=departamento (DULCES/BEBIDAS/BOTANAS), `kdif`=línea (CHOCOLATE PASTELITO…), `kdig`=proveedor. Columnas: `kdii.c11`=unidad, `c4`=depto, `c5`=línea, `c3`=proveedor.
- **Migración `20260615130000`**: + `catalog.products.department` + `product_line` (no toca `category_id`, que en realidad = proveedor).
- **Importer** `import-kepler-uom-categories.js`: corrige `unit_sale`/`unit_purchase` desde Kepler (**7,795 productos** — el sync previo había defaulteado casi todo a PZA; ahora PAQ 5,848/PZA 4,831/KG 189, realista → **cierra el hueco de UoM de Fase I**) y puebla department/product_line (**2,210** con taxonomía real; el resto es "NO APLICA" en Kepler). Verificado: GALL ANIMALITOS=KG, Kinder=DULCES/CHOCOLATE PASTELITO, Agua=BEBIDAS/AGUA EMBOTELLADA.

### Added — Rotación real de Kepler → Thot (catalog.products)
- **Análisis** `database/scripts/kepler-rotation-analysis.js` (read-only): descifra ventas en `kdm1`/`kdm2` (doc venta c2='U' c3='D' c4=10, 149k tickets POS). Top movers, **stock muerto** (existencia sin ventas → capital parado al costo) y slow movers por días de inventario. Suc 03 90d: **503 SKUs muertos = $567,877 parados**.
- **Feed a Thot** `database/importers/kepler/import-kepler-rotation.js` (dry-run/apply): puebla `catalog.products.rotation_tier` (alta/media/baja por percentil de unidades 90d; **dead=null** → peso mínimo) + `sales_units_30d` con venta real. **3,855 productos** (alta 856 / media 1215 / baja 1307 / dead 477). Thot usa estos campos sin cambio de código → la rotación real y el stock muerto entran al score; verificado AGUA/CHURRO/Kinder=alta. (Branch 03 como referencia; sync vivo pendiente.)

### Added — Precios de venta reales de Kepler → product_prices
- **Importer** `database/importers/kepler/import-kepler-prices.js` (dry-run/apply): fuente `md.kdpv_prod_util` (9,036 SKUs con precio escalonado por presentación + tiers de volumen). Decisión: el gradiente de precio por cliente son los **tiers de volumen** (no la presentación). Por SKU se toma su presentación principal (PZA>PAQ>CJA>KG>BTO) y sus tiers ordenados caro→barato se mapean **tier 0 → P1 (público) … → P4 (mayorista)**, rellenando listas faltantes con el mejor precio. **7,617 SKUs match, 30,468 upserts P1-P4**. Verificado: CHURRO P1 $5.35(min3)/P2 $5.08(min5)/P3-P4 $4.99(min10). tax_rate=0.16 asumido (verificar si Kepler ya incluye IVA).

### Fixed — FKs compuestas ON DELETE SET NULL anulaban tenant_id (bug sistémico)
- Migración `20260615120000`: **31 FKs** en commercial/logistics/trade tenían `FOREIGN KEY (tenant_id, X) REFERENCES ... ON DELETE SET NULL`, que al borrar el padre intentaba poner NULL en `tenant_id` (NOT NULL) → crash (vivido al borrar pedidos: `shipments`). Recreadas con la forma de Postgres 15+ `ON DELETE SET NULL (X)` que anula **solo** las columnas no-tenant. Migración dinámica + idempotente (no toca las ya corregidas). 0 FKs buggy restantes.

### Changed — Limpieza de datos inventados (deja solo data real) + import logística Kepler
- **Comercial** (`database/scripts/cleanup-invented-data.js`, transaccional dry-run/apply): borradas 1,397 filas inventadas — 354 pedidos dev (PD-*) + líneas/historial, 22 clientes TST-/DEMO- + refs (recommended_baskets/customer_360/commerce_signals), 26 productos + 5 marcas testdata (B.3.2), almacenes `INV-TEST-WH` y `TRUCK-*`, stock seed de MD-CENTRAL, 2 folios smoke. Conserva catálogo real, 2,925 clientes reales, listas de precio reales, **MD-10/30/50/CEDIS** (stock real) y **KEPLER-03**. Desliga `shipments.order_id` (FK compuesta ON DELETE SET NULL anularía `tenant_id` NOT NULL — bug de schema esquivado).
- **Logística** (`database/scripts/logistics-clean-and-import-kepler.js`): wipe de data de prueba (241 embarques EMB-* + cascade guías/gastos/checklists/fotos, 37 choferes TEST, 39 vehículos TEST, 27 periodos de nómina, "Ruta Local Demo") + **import real de Kepler**: 8 choferes (nombres reales), 11 vehículos (placas reales), 27 rutas nuevas (25 de las 52 ya existían del import del Excel → confirma que son las rutas reales). Conserva rutas reales del Excel + config_finance. Resultado: 8 choferes / 11 unidades / 123 rutas / 0 embarques.

### Added — ERP Kepler: dump restaurado + descifrado + importer de stock real
- **`database/BACKUP.sql`** (228 MB, pg_dump custom-format de la DB `md_03` schema `md`) restaurado a Postgres local (`localhost:5433`, DB `md_03`). Es el ERP **Kepler** de Mega Dulces, **esquema ofuscado** (tablas `kdXX`, columnas `c1..cN` sin nombres). Mapeo inferido desde datos documentado en [`docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md`](docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md): `kdii`=maestro productos (c1=SKU, c2=nombre, c7=barcode), `kdil`=existencia por sucursal (c9), `kdik`=valuación (costo=c9/c6), `kdm1/kdm2`=documentos (incl. ajustes de inventario — no hay tabla de conteo físico dedicada). 2 sucursales: 02 (vieja) y 03 (viva).
- **Importer** `database/importers/kepler/import-kepler-stock.js` (dry-run por defecto, `--apply` escribe, idempotente): join `kdii.c1 == public.products.sku` (97% overlap), existencia `kdil.c9`, costo `kdik`. **Aplicado**: sucursal 03 → almacén nuevo **KEPLER-03**, **3,936 SKUs / 1,127,490 unidades** de stock real. La Fase I ya puede contar contra cifras verdaderas. Costos validados como realistas (Agua $2.52, Kinder Delice $11.28).

### Added — Fase I · Inventario físico (I.0 + I.1 backend): conteo cíclico/total por almacén
- **Digitaliza "hacer inventario"** (marbeteo + doble conteo + recaptura del checador) como sesión con **conteo ciego**, **doble conteo** por contadores distintos y **reconciliación auditable**. Jerarquía: contador (cuenta a ciegas) → supervisor (analiza/resuelve) → reconciliador/jefe (autoriza el ajuste del saldo = del dinero).
- **Schema** (mig `20260613100000`, `commercial.*`): `inventory_counts` (folio INV-YYYY-NNNNN, state machine open→counting→review→ready_to_reconcile→reconciled|cancelled, índice parcial único **un folio abierto por almacén**), `inventory_count_items` (`expected_qty` = snapshot del teórico **oculto al contador**, `count_1/2/3`+`counted_by_*`, `final_qty`, `variance`, status), `inventory_count_sequences`. RLS forzado + grants `app_runtime`. FK tenant→`identity.tenants`, producto→`catalog.products` (los `public.*` son vistas tras la reorg).
- **Permisos** `COMMERCIAL_INVENTORY_{CONTAR,SUPERVISAR,RECONCILIAR}` (enum BE+FE, `ability.factory` subject `commercial_inventory`, seed de roles + backfill idempotente `20260613110000`). **Requiere re-login**.
- **Backend** `InventoryCountService`+`InventoryCountController` (`/commercial/inventory/counts`): open+snapshot, count (ciego, barcode o product_id, segregación count_2≠count_1, sobrantes), progress (cobertura %, discrepancias, **valor $ en riesgo**, productividad por contador), items, compute (discrepancias + count_3 rompe empate), resolve, reconcile (ajusta stock + movimientos `adjust` reference_type=`inventory_count` en una trx), cancel.
- **3 controles críticos**: (1) **coverage guard** — reconcile rechaza SKUs con `count_1 IS NULL` (un no-contado nunca se trata como cero → no se destruye stock real); (2) **freeze guard cross-module** — `assertWarehouseNotFrozen` en `orders.reserveStockInline/consumeStockInline` + `adjustStock/recordMovement`: con folio abierto y `freeze_movements`, se bloquea mover stock (el teórico no deriva); (3) varianza contra `quantity` (on-hand) respetando el CHECK `quantity >= reserved`.
- **Smoke** `test-newdb-inventory-count.js` (DB-direct, `app_runtime`, RLS) **13/13 ✓**, en `run-all-tests.js`.
- **I.2 frontend contador** — página `/comercial/inventory/count` (mobile-first para handheld HID): selector de folio, barra de progreso **ciega** (`GET /count-progress`, sin teórico/varianza), captura código→cantidad→Enter de un gesto, feed de últimos conteos con badge de slot. Nav "Conteo físico". Backend: endpoint count-progress ciego (gate CONTAR), submit devuelve sku/nombre para confirmar el SKU escaneado, y corrección same-counter (re-escaneo del mismo contador sobreescribe su count_1; solo otro contador dispara count_2).
- **I.3 frontend supervisor** — `/comercial/inventory/sessions` (lista + dialog abrir folio: almacén, tipo, toggles congelar/doble-ciego) y `/comercial/inventory/sessions/:id` (KPIs cobertura/sin-contar/discrepancias/**valor $ en riesgo**, calcular discrepancias, **reconciliar** con confirmación gate RECONCILIAR, cancelar, filtro Todos/Discrepancias/Pendientes, tabla de items teórico/C1/C2/C3/final/varianza, dialog resolver item con motivo). Nav "Folios inventario". **Fase I frontend+backend completos (beta scope)**; falta validación visual.

### Fixed — /dashboard/routes responsive en móvil
- La tabla densa "Visitas y tiempos" (8 columnas) no contenía su overflow → empujaba el ancho de **toda** la página en teléfono (KPIs/mapa/header se renderizaban a ~660px, cortados y con scroll horizontal global). Ahora las tablas tienen **scroll horizontal propio** (`overflow-x:auto` + `min-width` solo en la tabla ancha), así la página vuelve al ancho del viewport y la tabla se navega con swipe.

### Added — Mapa Comercial (CM): exhibidores Mega Dulces vs competencia en mapa + historial por tienda
- **Módulo `commercial-map`** (`libs/trade`, 2 endpoints read-only sobre `daily_captures.exhibiciones` JSONB — la fuente VIVA; las tablas `visits`/`exhibitions` son código muerto): `GET /commercial-map/stores` (tiendas con **coord híbrida** `COALESCE(stores.lat, última GPS de captura)` + conteo propio/competencia/sin-clasificar derivado del flag `perteneceMegaDulces` + `presence` + `unlocatedCount`) y `GET /commercial-map/stores/:id/history` (historial de visitas con exhibiciones separadas **Mega Dulces vs Competencia**: foto, concepto, ubicación, nivel, score, productos). Connection legacy + filtro `tenant_id` explícito (**no** `TenantKnexService`). Scoping **store-céntrico**: el historial y los conteos traen **todas las visitas de la tienda** (acotado por tenant + zona del requester, que ya controla qué tiendas ve) — sin filtro own/team de usuario, que ocultaría visitas de otros reps en la misma tienda.
- **Permiso `COMMERCIAL_MAP_VER`** (enum BE+FE, `ability.factory` subject `commercial_map`+action `read`, `AppSubject`). Seed de roles (superadmin/admin/supervisor/jefe_marketing) + backfill idempotente `20260613100000` (`-> 'KEY' IS NULL`). **Requiere re-login** (el permiso vive en el JWT).
- **Página `/dashboard/commercial-map`** ("Mapa Comercial", nav Trade, icono `pi-map-marker`): superficie Operations (densa, master-detail). Mapa Leaflet con marcadores coloreados por presencia (🟢 Mega Dulces · 🔴 competencia · 🟠 ambas · 🔵 sin clasificar · ⚪ sin visitar), leyenda con conteos + badge "N sin ubicar", filtros de presencia/zona/búsqueda (client-side) + **selector de período** (Todo/Hoy/Semana/Mes/Personalizado con datepicker, estilo /reports — recarga del server). Click en tienda → panel con KPIs + **lista de visitas**; clic en una visita → **ventana (`p-dialog`) con su descripción completa** (exhibiciones con foto, chips propio/competencia, productos, ubicación/nivel, score — estilo Seguimiento); clic en la foto → **lightbox ampliado**. El mapa Leaflet va aislado (`isolation`) para no pisar el sidebar.
- **`MapComponent`** (`shared/components/map`): nuevo `output markerClick` + campo opcional `id` en `MapMarker` (no-breaking; routes-analysis sin cambios).
- **Smoke `http-commercial-map-test.js`** registrado en `run-all-tests.js`.

### Added — Modo Vendedor v2 · V.0: cartera del vendedor + orden de visita
- **`commercial.vendor_sales_routes`** (mig `20260610100000`): qué rutas de venta (`sales_route`) cubre cada vendedor — el `supervisor_ventas` asigna. La cartera del vendedor = clientes de esas rutas. + **`customers.visit_sequence`**: orden de visita del cliente dentro de su ruta. FK a `identity.*` (las tablas reales; `public.users/tenants` son vistas), RLS, idempotente.
- **Módulo `commercial-vendor-routes`** (7 endpoints): rutas+conteo+asignados, vendedores asignables, clientes-por-ruta, asignar/quitar (idempotente), "mi cartera" (vendedor), ordenar (`visit_sequence` 1..N). Gestión gateada por `USUARIOS_ASIGNAR_RUTA` (lo tiene `supervisor_ventas`), lectura por `COMMERCIAL_CUSTOMERS_VER` — sin permiso nuevo (evita el riesgo de ability.factory).
- **Página `/comercial/cartera`** ("Cartera de ventas"): el supervisor asigna/quita rutas a vendedores y **ordena la secuencia de visita** de los clientes de cada ruta con botones subir/bajar (PrimeNG 18 no expone `reorderableRows`). Ítem en el nav comercial.

### Added — Modo Vendedor v2 · V.1: backend de pedidos por cartera + ciclo de vida del vendedor
- **`GET /commercial/orders` con filtros nuevos**: `?statuses=pending_approval,confirmed` (multi-status CSV), `?mine=true` (restringe a clientes de la cartera del vendedor del JWT vía `vendor_sales_routes`) y columna calculada **`is_preventa`** (`true` si el pedido lo originó el cliente desde el Portal B2B — su user es `customer_b2b`; `false` si lo tomó un vendedor en campo). Base de "Por entregar".
- **`GET /commercial/customers?mine=true`**: cartera del vendedor (clientes de sus rutas) ordenada por `visit_sequence` (nulls al final). Base de "Clientes por ver" / "Pedido nuevo".
- **`VendorService`**: métodos `myCartera()`, `pendingDeliveries()`, `approve()` (pending_approval→confirmed), `fulfill()` (confirmed→fulfilled) + tipo `VendorOrder` (Order enriquecida con `is_preventa`/`customer_name`/`route_name`).
- **Ciclo de pedido para roles de campo**: el vendedor ahora gestiona su cartera de punta a punta. Seed `FIELD_PERMS` + backfill `20260610110000` activan `COMMERCIAL_ORDERS_CONFIRMAR` / `FULFILL` / `CANCELAR` en `colaborador` / `ejecutivo` / `vendedor` (idempotente, merge guardado por `@>`). Las 3 keys ya estaban mapeadas en `ability.factory`. **Requiere re-login** (el permiso vive en el JWT).

### Changed — Modo Vendedor v2 · V.2: el modo vendedor reorganizado en 4 apartados
- **Nuevo bottom nav del modo vendedor**: **Pedido** · **Por entregar** · **Por visitar** · **Buscar** (antes Clientes / Mi día / Cierre). "Mi día" y "Cierre de ruta" pasan a accesos en el header (no pierden alcance). Default de `/vendor` → `new-order`. Entradas a Modo Vendedor (nav admin, landing de proyectos, links internos) repuntadas a `/vendor/new-order`; `/vendor/customers` queda como redirect a `search`.
- **Pedido nuevo** (`/vendor/new-order`): la cartera del vendedor (clientes de sus rutas asignadas) **en orden de visita** (`visit_sequence`, badge numerado), con filtro y tag de ruta. Tocar un cliente abre la toma de pedido. Empty state guía a pedir cartera al supervisor + fallback a Buscar.
- **Buscar** (`/vendor/search`): búsqueda sobre **todo** el catálogo de clientes (esté o no en la cartera) — es el `vendor-customers` previo, retitulado.
- **Por entregar** (`/vendor/pending`, V.3) y **Por visitar** (`/vendor/visits`, V.4): apartados creados con placeholder "Disponible pronto" — el backend de Por entregar (`pendingDeliveries`/`approve`/`fulfill`) ya existe (V.1).

### Added — Modo Vendedor v2 · V.3: apartado "Por entregar" operativo
- **`/vendor/pending`** ya no es placeholder: lista los pedidos pendientes de la cartera del vendedor (preventa del Portal B2B + de campo), en dos secciones — **Por aprobar** (`pending_approval`) y **Listos para entregar** (`confirmed`). Cada pedido muestra cliente, folio, total, hora, tag de origen (**Preventa**/**Campo** según `is_preventa`) y expande sus líneas bajo demanda (`orderById`).
- **Acciones con confirmación**: **Aprobar** (`pending_approval → confirmed`) y **Marcar entregado** (`confirmed → fulfilled`, descuenta inventario), cada una con `ConfirmDialog` + toast de resultado y recarga de la lista. Botón con `loading` mientras la operación está en vuelo; errores del backend se muestran en el toast.

### Added — Modo Vendedor v2 · V.4: apartado "Por visitar" + check-in (cierra v2)
- **`commercial.vendor_visits`** (mig `20260610120000`): cada fila = un check-in explícito del vendedor a un cliente (`visited_at`, `notes`, `latitude`/`longitude` nullable para geo-check-in futuro). FK a `identity.*` (tablas reales) + a `commercial.customers (tenant_id, id)`, RLS forzado, grants `app_runtime`, idempotente.
- **Backend** (`commercial-vendor-routes`): `GET /coverage` (cobertura del día — la cartera anotada con `visited_today` calculado en **TZ MX** + última visita; gateado por `COMMERCIAL_CUSTOMERS_VER`) y `POST /check-in` (registra la visita; gateado por `VISITAS_REGISTRAR`, que los roles de campo ya tienen). Smoke RLS E2E OK (cartera → check-in voltea el flag).
- **`/vendor/visits`** ya no es placeholder: la cartera en orden de visita con barra de progreso ("X de N visitados hoy"), check-in por cliente (optimista + toast) que pinta el cliente como visitado, y atajo a tomar pedido. `VendorService.coverage()`/`checkIn()` + tipo `CoverageCustomer`.

### Added — Modo Vendedor v2 · V.5.0: backend para "Mi ruta" (interfaz única client-centric)
- **`commercial.orders.requested_delivery_date`** (date, nullable; mig `20260610130000` + índice parcial): fecha de entrega agendada para el "pedido futuro". `createDraft`/`updateDraft` la aceptan (validan `YYYY-MM-DD`); `list()` la devuelve.
- **`POST /commercial/orders/:id/deliver-now`** (autoventa — "pedido al instante"): fast-forward a `fulfilled` en **una transacción** desde `draft`/`pending_approval`/`confirmed` (reserva + congela + confirma + consume stock, reusando `fulfillInTransaction`). Gateado por `COMMERCIAL_ORDERS_FULFILL`. Consume del almacén central (beta); la conciliación del camión vive en los tickets del cierre.
- **`GET /commercial/vendor-routes/home`**: feed del home "Mi ruta" — la cartera del vendedor (orden de visita) anotada de **un solo fetch** con `visited_today`, `ordered_today` (TZ MX), `last_visit_at` y `pending_orders[]` (total + `is_preventa` + fecha de entrega) + `pending_count`/`pending_total`/`has_preventa_pending`. Smoke RLS E2E OK (campo vs preventa distinguidos).
- **`VendorService`**: `home()`, `deliverNow()` + `updateDraftHeader` acepta `requested_delivery_date` + tipos `HomeCustomer`/`HomePendingOrder`.

### Changed — Modo Vendedor v2 · V.5.1: home "Mi ruta" client-centric (una sola pantalla)
- **El modo vendedor es ahora una sola pantalla**: `/vendor/route-home` ("Mi ruta") = la cartera en orden de visita; cada cliente abre un **bottom-sheet** con todas sus acciones sin salir de la lista — **Ver pedido pendiente · Pedido al instante · Pedido futuro · Marcar visita · Registrar ticket · Capturar exhibición · Llamar/WhatsApp**. Consume `home()` de un fetch. Chips por cliente (preventa pendiente · N por entregar · pedido hoy · visitado), barra de progreso de visitas y filtro client-side.
- **Check-in en el sheet** (reusa `checkIn`, optimista). Contacto directo (tel / wa.me). "Capturar exhibición" enlaza a `/dashboard/vendor-capture` (fusión profunda en V.5.3).
- **Nav colapsado**: bottom nav a **2** (Mi ruta · Cierre) + **Buscar** y **Mi día** como íconos en el header. Las pestañas Pedido/Por entregar/Por visitar se vuelven el home + sus rutas siguen vivas (las usa el sheet). `/vendor` y `/vendor/new-order` redirigen a `route-home`; se eliminó el componente `vendor-new-order` (superado).

### Changed — Modo Vendedor v2 · Rediseño móvil "Mercado" (R.1: Mi ruta)
- **`/vendor/route-home` rediseñada** mobile-first sobre el design system Mercado (preview en `designs/vendor-redesign-20260610/`): **hero full-bleed** con gradiente cálido (sangra el gutter del shell), **anillo de progreso** (visitados/total) y **KPIs del día** (pedidos · vendido · por entregar, mono tabular). El banner de reorden NBA pasa a **identidad ember** (✦). Las cards de cliente ganan **riel de estado** a la izquierda (verde visitado · ámbar preventa · sunset reordenar · stone pendiente), chips tokenizados (se eliminó el hex inline), y **FAB sunset "Pedido"** en la zona del pulgar que abre el próximo cliente. El bottom-sheet ahora destaca la acción primaria ("Pedido al instante") como botón sunset; sheet entra con `--spring`. `prefers-reduced-motion` respetado.
- **Motion tokens** en `tokens.css`: `--ease-standard`, `--ease`, `--spring` (reuso global). Toda la lógica NBA (`nbaDue`/`recordSignal`/dueIds/onlyDue) + check-in + sheet preservada.
- **R.2 · Tomar pedido** rediseñado + modos cableados: header con chip de modo, catálogo en filas livianas con **"+" de 44px** (badge de cantidad en carrito), sección de carrito con **steppers** + totales, y **cart pill flotante** (zona del pulgar) como CTA único. **Instante** (autoventa) → `POST /orders/:id/deliver-now` ("Cobrar y entregar", descuenta stock); **futuro** → date-picker + `requested_delivery_date` y confirma ("Agendar pedido"). Háptico en add/stepper/confirm. Se quitaron `p-table`/`p-inputNumber`/`p-card`/`p-selectButton` (markup propio liviano).
- **R.3 · Pedido confirmado** (`/vendor/order-success`): pantalla de éxito que celebra al instante (datos por queryParams, sin fetch) — **check dibujado** (SVG stroke) + pop spring + **confetti** amarillo (sello) + háptico de éxito. Verde "¡Entregado!" (instante) / info "¡Pedido agendado!" (futuro, con fecha). CTA en zona del pulgar: **enviar ticket por WhatsApp** (mensaje pre-armado) + volver a la ruta. `take-order` navega acá tras cobrar/agendar. `prefers-reduced-motion` desactiva confetti/animación.
- **R.4 · Notificaciones** (`/vendor/notifications`) + **bell en el header**: inbox derivado (sin backend persistente todavía) que agrega lo accionable de endpoints existentes — **preventa pendiente** (→ aprobar), **clientes para reordenar hoy** (NBA, → tomar pedido) y **pedidos de hoy** — agrupado, con íconos de tipo (warn/ember/ok) y tap-to-act. Badge en vivo diferido (requiere conteo liviano / backend de notificaciones).
- **R.5 · re-skin de pantallas secundarias**: **Mi día** ahora con mini-hero + KPIs (mono tabular) y filas de pedido con chip de estado tokenizado (Spanish labels). **Buscar** con search pill + filas livianas con avatar de iniciales (sin `p-card`). *Por entregar* / *Por visitar* ya usaban el lenguaje de chips/riel (V.3/V.4); *Cierre de ruta* conserva su diseño propio. Cierra el rediseño móvil del Modo Vendedor (R.1–R.5).
- **R.6 · pulido: esquinas + colorimetría de /vendor-capture**: el shell del vendedor sube los radios (`--r-sm..2xl`) vía override scopeado → **todas las esquinas con token quedan más redondeadas** (look moderno) en cascada a todo el módulo; + bump de los radios hardcodeados (badges/avatares/botones). **Colorimetría golden** tomada de `/vendor-capture` (fusionado al shell como "Capturar"): los heroes pasan de sunset rojo a **golden-orange** (`#F68F1E`, vía `--v-hero-grad`), el seq badge a tinte marca/ámbar (`--v-seq-bg/fg`). Sunset `--action` se conserva solo en CTAs sólidos (contraste de texto blanco).

### Fixed — Supervisor de ventas asignable a vendedores (no solo colaboradores)
- **`/admin/users`**: el selector "Jefe / Supervisor de Ventas" solo aparecía (y solo se conservaba) para el rol `colaborador`; al elegir `vendedor` o `ejecutivo` se ocultaba y el `supervisor_id` se forzaba a `null`. Ahora aplica a todos los roles de campo (`colaborador`, `ejecutivo`, `vendedor`) — vía `isSupervisedRole()` — tanto en el form como en el listado (desktop + mobile).
- **Efecto colateral resuelto en Asignación diaria**: esa pantalla arma el equipo con `users WHERE supervisor_id = <supervisor logueado>`. Como los vendedores nunca podían tener `supervisor_id`, no aparecían en el equipo de su supervisor de ventas. Con el supervisor ya asignable, el vendedor aparece y el supervisor puede asignarle su ruta diaria. (Backend ya soportaba `supervisor_id` + `/users/supervisors` + `findBySupervisor`; el hueco era solo de UI.)

### Fixed — Ventas (comercial): sesión de corrección de bugs
- **Televenta dashboard 100% roto** (`dashboardMetrics`): consultaba columnas inexistentes en `commercial.lead_reservations` (`status`, `user_id` → 500 siempre) y filtraba `call_logs.outcome` por valores en español (`pedido_tomado`…) que el CHECK prohíbe (métricas en 0). Alineado al schema real (`released_at IS NULL`, `reserved_by_user_id`) y al enum canónico (`sale`/`no_answer`/`callback_scheduled`/`no_sale`).
- **`adjustStock` no atómico**: se partía en 3 transacciones (read → recordMovement → overwrite) → saldo corrupto ante crash y lost-update concurrente. Ahora un único `tk.run` con `forUpdate`, valida `new_quantity >= reserved` y registra `quantity_before/after` correctos.
- **`reserveLead` 409 espurio**: no pre-liberaba reservas vencidas antes del INSERT → chocaba el UNIQUE parcial sobre leads que la cola sí ofrece. Ahora pre-libera (`released_reason='expired'`) en el mismo trx.
- **`bulkUpsertPrices` no avanzaba `updated_at`**: el `.merge()` lo referenciaba pero las rows no lo seteaban. Ahora cada row setea `updated_at: now()`.
- **Fechas por defecto en UTC, no MX** (route-tickets + vendor-sales): `toISOString().slice(0,10)` ocultaba capturas de 18:00–23:59 MX. Ahora usan `todayMx()`/`toMxDateKey()`.
- **Desvincular tienda de cliente no persistía**: tanto el `linkStore` inline como el dialog de edición (`save()`) mandaban `store_id: undefined` (backend lo trata como "sin cambio"). Ahora ambos mandan `null`, consistente con `linkRoute`. Quitado de paso el método muerto `onToggleActive()`.
- **KPIs de pedidos sobre la página visible**: hero "Ventas en la ventana" y counts de history reflejaban solo la página. El backend `list` ahora devuelve `total_amount` agregado del filtro y el front usa `statusCounts()` reales.
- **Fugas RxJS**: 25 `.subscribe()` en 6 componentes de `/comercial` sin `takeUntilDestroyed` (incl. streams permanentes `route.data` y `search$`). Todas envueltas.

### Changed — Alertas realtime desactivadas
- **Apagadas todas las alertas realtime del Command Center** (decisión de producto): el scanner cron `AlertsScannerService` (emitía `low_stock_critical` + `vip_inactive` cada 5 min) queda gateado por `ENABLE_COMMERCIAL_ALERTS` (default off); el Command Center ya no abre el socket de alertas ni muestra el feed/toasts en vivo (se limpió el feed, el tag "En vivo" y los helpers huérfanos). Se mantienen el panel informativo "Stock bajo" del dashboard (endpoint analytics) y el resto del dashboard. Reactivable con `ENABLE_COMMERCIAL_ALERTS=true`.

### Added — Cliente comercial: WhatsApp + ruta de venta estructurada
- **Columna `whatsapp`** en `commercial.customers` (normalizada a E.164, índice único parcial por tenant) — migración `20260609140000` idempotente (local+prod). El backend normaliza a `+52…` en create/update y mapea colisiones (23505) a 409; el front la expone en el dialog y en la ficha del cliente, en lugar del viejo selector de tienda.
- **Columna `sales_route`** (ruta de venta): la ruta que el ERP traía como texto en `notes` ("Ruta: RUTA 21") se migró a un campo estructurado. Script `backfill-customer-sales-route.js` pobló **2.859 clientes** (12 rutas). La columna "Ruta" de `/comercial/customers` ahora muestra `sales_route`. (`route_id` sigue apuntando a logística, hoy vacía — son rutas distintas.)

### Changed — /comercial/customers alineado al vínculo tienda↔cliente
- **Vínculo de tienda ahora es de solo lectura**: se quitó el selector inline "Vincular tienda" de la tabla y el campo editable del dialog (cada tienda nace como cliente al alta; el vínculo no se edita a mano). Se muestra como chip read-only. Eliminados los métodos/signals huérfanos (`linkStore`, `linkRoute`, `routeName`, etc.).
- **Backend blindado**: `store_id` es inmutable vía PATCH (no se puede cambiar ni quitar un vínculo existente — `BadRequestException`); violaciones de unicidad devuelven **409** con mensaje claro en vez de 500.
- **Hallazgo (workflow de análisis)**: el modelo NO es 1:1 en los datos — hay **2.941 clientes del ERP** vs **36 tiendas** de Trade. Los 19 STR- del bulk previo no duplican clientes ERP (tiendas piloto distintas); quedan 5 homónimos internos del ERP para revisión manual.

### Added — Modelo 1:1 tienda↔cliente (Ventas)
- **Cada tienda de Trade Marketing es un cliente comercial.** `database/scripts/promote-all-stores-to-customers.js` (dry-run default, `--apply` para escribir): promueve en bulk todas las tiendas activas sin cliente a `commercial.customers`, idempotente, reusando la lógica de `createFromStore` (code `STR-…`, name = nombre de la tienda, price_list default). Poblado inicial: **36/36 tiendas activas ↔ clientes**.
- **Auto-provisión al alta**: al crear una tienda en Trade (`StoresService.create`) se crea automáticamente su cliente comercial, vía el nuevo Port `CUSTOMER_PROVISIONING_PORT` (inversión de dependencia trade→commercial en el composition root, `@Optional` para no acoplar la app legacy, best-effort post-commit — si falla no rompe el alta de la tienda).
- Migración `20260609120000`: índice único parcial `commercial.customers (tenant_id, store_id) WHERE store_id IS NOT NULL AND deleted_at IS NULL` — garantiza el 1:1 (un store, un cliente activo).

### Added
- `database/scripts/README.md` — mapa de 92 archivos agrupado en 11 familias con estado 🟢🟡🔵⚫.
- `.env.example` — +18 vars que estaban undocumentadas (cutover, vector, tests E2E, S3, etc.).
- `package.json` — npm scripts `regression`, `import:commercial`, `seed:testdata` (loop completo), `cutover:preflight`, `cutover:smoke`, `embeddings:backfill`, `embeddings:sync`, `migrate:new`, `seed:new`.
- `DESIGN.md` — sección **"Mercado / Operations"** extendiendo el design system a `/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`. Mismo sistema, 2 surfaces (Storefront + Operations).
- `CHANGELOG.md` — este archivo.

### Changed
- `CLAUDE.md` — Design System ahora cubre 2 surfaces (era solo `/portal`).
- **Rutas — tienda↔ruta "última gana"**: el hook `maybeAssignStoreRoute` ahora reasigna `stores.ruta_id` a la ruta de CADA captura (antes solo asignaba si la tienda no tenía ruta). Así el apartado Rutas agrupa cada tienda bajo la ruta que la capturó por última vez. Cambio en `libs/trade/.../daily-captures.service.ts`.

### Added
- `database/scripts/backfill-store-route-from-captures.js` — backfill idempotente (dry-run por default) que aplica "última gana" a la data histórica: cada tienda hereda la ruta de su captura más reciente con `route_id`.

### Fixed
- **Rutas — ruta duplicada por zona del store**: `getRoutesData` sacaba la zona de cada tienda (`stores.zona_id`) y la metía en el `GROUP BY`, fragmentando una ruta en una fila por cada zona distinta de sus tiendas (ej. "RUTA 23 / LA PIEDAD RD" + "RUTA 23 / —" para tiendas sin zona). Ahora la zona viene de la **ruta** (`catalogs.parent_id → zones`) y el filtro de zona usa `c.parent_id` → una fila por ruta. Complemento: el hook `maybeAssignStoreRoute` ahora también alinea `stores.zona_id` a la zona de la ruta en cada captura, y `database/scripts/backfill-store-zone-from-route.js` corrige la data histórica (dry-run por default).
- **Rutas — timezone mismatch maestro vs detalle**: la lista de rutas (`getRoutesData`) filtraba por `DATE(hora_inicio)` en UTC mientras el detalle (`getRouteVisits`/`getRouteStores`) usaba `AT TIME ZONE 'America/Mexico_City'`. Las capturas de la tarde-noche MX caían en el día UTC siguiente → el conteo "N vis" del maestro no cuadraba con el detalle y rutas con actividad real desaparecían con el rango default = hoy. Alineado todo a MX.
- **vendor-capture**: selector de ruta ahora usa `p-select` (igual que captura diaria) en vez de `<select>` nativo.

### Added — Tiempos muertos (detección)
- **Fase 1 (derivado, sin captar data nueva)**: `GET /reports/routes/:id/idle` y `GET /reports/idle/summary`. Detecta tiempo muerto entre visitas consecutivas del mismo vendedor: `idle = max(0, gap − traslado_estimado)`, traslado = haversine(tiendas)/25 km/h, umbral muerto 20 min. UI en /routes: KPI "Tiempo muerto" + columna "Muerto antes" por visita. Resumen agregado por vendedor para dashboard. `computeIdleSegments` corta por (vendedor, día MX).
- **Fase 2 (breadcrumbs GPS)**: tabla `public.route_location_pings` (mig 20260609100000, sin RLS patrón push_subscriptions). Dexie v5 `routePings` + `RoutePingService` (ping cada 3 min en foreground con ruta activa, cola offline, sync bulk idempotente a `POST /reports/route-pings`). Refinamiento: `getRouteIdle` separa estacionado vs traslado con los pings (idle real = tiempo estacionado), con indicador GPS en la UI. Fallback al estimado por haversine si no hay breadcrumbs.

### Pending
- **Plan migración tokens.css** documentado en DESIGN.md → no aplicado (riesgo de regresión visual cross-app).
- **T1** scripts hardening (`--dry-run` uniforme + `assertEnvVars()`).
- **T2** hints contextuales en tests al fallar (TenantKnex, ability.factory).
- **T3** `docker-compose.dev.yml` + `npm run dev:up`.

---

## 2026-06-08 — Apartado Rutas + Cierre Ruta UI + DX hardening

### Added
- **`/dashboard/routes`** — apartado completo con master-detail (lista rutas + KPIs + mapa Leaflet recorrido + tabla visitas + tabla tiendas). Permiso `RUTAS_VER`. Backend reusa `/reports` (cero schema nuevo). Fases 0-3 (permiso → backend → frontend → backfill).
- **`/comercial` cierre-ruta** — vista admin "Ventas de vendedor" (ticket OCR).
- **Customers Kepler import** — `customers-from-excel.js` + `link-customers-to-stores.js` para combinar maestro Kepler con `commercial.customers`.

### Fixed
- **PWA overflow-x** — `<main>` con `overflow-y-auto` forzaba `overflow-x: auto` → pantalla se deslizaba lateral. Fix: `overflow-x: hidden` en main + body + html, sin romper tablas anchas.
- **Reports** — chromium del SO en Docker + `executablePath` puppeteer, templates `hbs` en webpack assets.
- **PWA service worker** — catalogs/zones/customers a estrategia **freshness** (no cache-first, evita data stale post-merge).

### Internal
- DX review aplicada (F1+F2+F5 del review `/plan-devex-review`): scripts README, .env.example, npm aliases.

---

## 2026-06-07 a 2026-06-05 — Vendor capture + tickets + auth

### Added
- **Vendor capture** — ticket multi-foto, OCR mejorado, visita siempre primero + link `daily_capture_id` + `product_id` via aliases.
- **Catalog aliases** — sistema `trade.catalog_aliases` para mapear UUIDs viejos de conceptos a vigentes. Reporte y resolver de capturas consultan aliases. Migración faltante 20260606100000 agregada en remediation.

### Fixed
- **Auth JWT** — JWT >4KB no entraba en cookie → persistir en localStorage.
- **Auth-trigger** — `auto_populate_tenant_id` no sobrevivió `SET SCHEMA` en prod → mig 20260606000000 dinámica recrea trigger en 57 tablas multi-tenant.
- **Captures** — ticket vendedor acumula varias fotos del MISMO ticket; remap `sku→product_id`; bloquear visita vendedor sin productos.
- **Touch targets ≥44px** en sidebar nav + topbar user menu (F010 design audit).

---

## 2026-06-04 — Portal B2B standalone deploy + Design audit codemods

### Added
- **Portal B2B en repo aparte** — `Portal_MegaDulces` con `API_UPSTREAM` + nginx resolver. `customer_b2b` permisos scoped (mig 20260605120000).
- **Telemetría endpoint** — `commercial-portal-telemetry` con ingesta + resumen.

### Changed
- **Design audit codemods** — sweep monocromo `comercial/*`, `logistica/*`, `portal/catalog`. Codemod hex pass 2 (cart, televenta). AI accent purple `#8b5cf6` → token `--ai-accent` semantic (G1). Tipografía 10-12px + font-weight hierarchy + shadow decorativa fuera (F4/F6/F9).

---

## 2026-06-03 — Module Isolation Sprint (iso.0–iso.6)

### Internal
- **Monolito modular endurecido** — 41 módulos NestJS reorganizados en libs Nx por dominio (`platform-core`, `contracts`, `commercial`, `logistics`, `trade`). Fronteras enforced con `enforce-module-boundaries: error`. Port DI-invertido logistics→commercial. 1 deployable. Ver memoria `project_module_isolation`.

### Fixed
- **FDW boot migrations** — migraciones que ejecutan query contra FDW mega_dulces_srv (.245) crasheaban boot en Railway. Mig 110000 ajustada. Ver memoria `feedback_fdw_boot_migrations`.

---

## 2026-06-02 — Cierre formal Comercial Fases B+C+D+E

### Added
- **ADR-013** — `pending_approval` order status (cliente confirm → `/approve` vendedor → confirmed).
- **Regression suite ampliada** — 19/19 verde, ~155 sub-assertions en ~10.6s.

### Fixed
- **28 mappings ability.factory** — permisos COMMERCIAL_* y LOGISTICS_* sin map a subject/action causaban 403 "permisos dinámicos" para todo rol sin `manage:all`. Ver memoria `feedback_ability_factory_mapping`.

### Internal
- **Fases B+C+D+E cerradas** (beta scope) con regression suite como fuente de verdad. Ver memoria `project_comercial_cierre_formal`.

---

## 2026-05-27 — Fase E Televenta + Fase J Logística + Fase K AI

### Added
- **Fase E Televenta** (CERRADA beta) — workflow call center sin telefonía. Rol `tele_operator`, pool autoservicio, cron @5min libera leads expirados. Smoke 29/29. Endpoints `/api/commercial/televenta/*`. Frontend `/televenta/*` con 4 páginas.
- **Fase J Logística** (CERRADA beta) — embarques, flotilla, costos, guías, liquidaciones, reports. 7 backend modules + 5 admin pages + analytics + hooks cross-project Comercial↔Logística. UI port desde `_imported/logistica/` (Dashboard ops, Personal/Staff con MultiSelect roles, Guides global con 5 KPIs, Costs con KPIs + dialog 10 categorías).
- **Fase K AI product match** (CERRADA beta) — Docker `pgvector-md` (pg18 + vector 0.8.2) + Voyage AI `voyage-3` (1024 dims) + Claude Haiku 4.5 en wizard captures paso 5. 1278 SKUs embedded. Endpoint `/api/ai/products/match-ai`, threshold 0.40, throttle tier `long`. EmbeddingSyncService @Cron cada 15min + endpoint manual. Script `sync-from-remote.js` Docker↔.245.

### Internal
- **K-debt cerrado** — refactor `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts` para no escribir a columna virtual `activo BOOLEAN GENERATED`.

---

## 2026-05-26 — Sprint A.0-multitenant + Fases B+C+D (todo en un día)

### Added
- **A.0 Multitenant** (CERRADA beta) — nueva DB Postgres 18.4 multi-tenant en `192.168.0.245:5432/postgres_platform`. Schema completo 19 tablas + 95 índices + 18 RLS + rol `app_runtime` + seeds. `TenantContextService` (AsyncLocalStorage) + Interceptor + auth-mt. 1804/1830 rows migrados desde legacy (98.6%).
- **Fase B Core Comercial** (CERRADA beta) — 9 tablas en schema `commercial.*` (customers, warehouses, price_lists, product_prices, stock, stock_movements, orders, order_lines, payments). State machine orders `draft → confirmed → fulfilled`. Generator `PD-YYYY-NNNNN`. CLI importer + test data realista (5 brands + 25 products + 25 prices + 20 customers + 25 stock).
- **Fase C Sales Intelligence** (CERRADA beta) — 7 endpoints `/commercial/analytics/*` (overview, top-customers, top-products, sales-by-brand, low-stock, etc.) + 3 materialized views + `AnalyticsRefreshService` @Cron('*/15min'). Frontend Command Center con 4 KPIs + 4 tablas + alertas WS realtime (low_stock_critical, vip_inactive).
- **Fase D Catálogo + Portal B2B** (CERRADA beta) — `customer_id` UUID + composite FK + `commercial.order_status_history`. Rol `customer_b2b`. Portal Web B2B en `/portal/*` (PortalLogin, PortalCatalog, PortalCart, PortalOrders, PortalOrderDetail). Vendor app mobile-first `/vendor/*` (ADR-005: extender `apps/view` no app RN separada). Canasta estratégica v1 (base/focus/exploration/innovation con score 0..1).
- **ADRs 010, 011, 012** — multi-tenancy shared DB + tenant_id, Voyage AI embeddings, pgvector en DB legacy.

### Internal
- **A.0bis hardening** — Helmet + Throttler 3-tier + body limits 2mb, nginx security headers, console→Logger, Zod schemas para JSONBs.

---

## Pre-2026-05 — Auditoría base + decisiones iniciales

### Added
- **Auditoría base** (60 findings) en [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md).
- **Stack inicial** — NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary; Angular 18 standalone + PrimeNG + Tailwind + Spartan UI; Capacitor + Dexie mobile; Nx monorepo + Docker + Railway.
- **Auditoría visitas + scoring + reports** funcional. No tomaba pedidos, no catálogo comercial, no multi-tenant.

---

## Convención de updates

1. **Al cerrar feature o sprint** — agregar entry bajo la fecha actual.
2. **Una sección `[Unreleased]`** al tope agrega los cambios sin tag formal.
3. **Categorías estándar:** Added · Changed · Fixed · Deprecated · Removed · Internal · Pending.
4. **No duplicar lo de `03_LOG_REVISIONES.md`** — ese tiene el detalle de lessons learned + diff de archivos. CHANGELOG es la vista "scan en 30 segundos".
5. **Referenciar memoria cuando aplique** — `project_*` o `feedback_*` para más contexto.
