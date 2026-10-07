# Fase CT — Cierre Compras + Thot (post-mapa operativo)

> **Estado:** 🔨 EN CURSO 2026-07-24. **Track A COMPLETO en código** — `/comercial/razonamiento` es ahora un cockpit de 5 pestañas (Hallazgos · Diagnósticos · Acciones co-piloto · Autonomía · Aprendizaje) sobre `commercial-intelligence.service.ts`; build view verde. **CT-C.3 en código** (feature store al nightly). **CT-C.4 en código** (momentum). **CT-C.1 diagnosticado + fuente RFM encontrada** (ver abajo). Surge del mapa operativo de Compras + Thot. Tres tracks: **A** = superficie de razonamiento/autonomía (era API-only, ya expuesta), **B** = diferidos de Compras, **C** = datos que alimentan a Thot.
>
> **Verificación:** todo lo shippeado compila (view + api verdes). **Pendiente transversal:** validación visual del cockpit + **datos** (las tablas de razonamiento se llenan cuando CT-C.1b puebla customer_360 y el feature store corre) + **redeploy**.
>
> **HALLAZGO CLAVE (bloquea A):** las tablas de razonamiento (`commercial_findings/_diagnoses/_actions`) están **vacías en prod** — y su fuente lo está también: `customer_360` computa desde `commercial.orders` (**9 pedidos**, los de la app B2B/vendedor), NO de la venta real del ERP. Hay 3,110 clientes y 1,248 `erp_customers` pero **no existe un fact de venta por-cliente del ERP**. Conclusión: **Track A depende de Track C**, y CT-C.1 no es "correr el cron" sino **construir la fuente de venta por-cliente desde el ERP** (sub-proyecto). La UI de A.1 ya está lista y se encenderá en cuanto fluya la data.
>
> **Tesis heredada (no se toca):** el motor decide de forma determinista, el humano aprueba (HITL), el LLM comunica y nunca toca el camino del dinero (ADR-016 / 018 / 020 / 023 / 026 / 030).
>
> **No es rewrite.** Ambos motores cumplen su ADR. Lo que falta es (A) exponer capacidad ya construida que vive sólo en la API, (B) tapar huecos conocidos del reabasto, (C) despertar datos que están vacíos/manuales y que dejan señales dormidas.

---

## 0. Línea base (mapa 2026-07-24, datos vivos de prod)

**Compras (RA)** — 28,323 políticas (25,467 computed / 2,856 kepler) · $18.2M sugerido a máximo ($16.6M accionable) · 8,728 agotados · 20,517 hallazgos · 9 requisiciones · 1.90M unidades en tránsito · 1,283 proveedores (0 con lead time real capturado) · 8 almacenes.

**Thot** — 3,109 canastas sugeridas · 73 conversaciones de chat (con 👍/👎) · 35 tools · Haiku 4.5 / Sonnet think.
Gaps visibles: **`customer_360` vacía** (0 filas), **`commerce_signals` vacía**, **`thot_chat_examples` = 0** (golden set sin promover), la **pista de razonamiento (findings → diagnoses → actions → autonomy → learning) es API-only** (sin pantalla en `apps/view`), y **momentum** figura en ADR-018 pero no es un término propio del score (proxy vía rotación + ventas 30d).

---

## 1. Diagnóstico por track

### Track A — Thot: la inteligencia está construida pero invisible
La lógica de razonamiento existe y funciona por API: `commercial-findings.service`, `commercial-diagnoses`, `commercial-actions`, `autonomy.service` (dial ADR-023), `commercial-calibration.service` (L2). El negocio **no puede usarla** porque no hay pantalla — sólo el chat y las directivas tienen UI. Es el mismo patrón que Maat ya resolvió en `/finanzas/hallazgos` (bandeja + evidencia + confirmar/descartar + reglas) y que Compras tiene en `/compras/hallazgos`. Portar ese patrón desbloquea capacidad ya pagada.

### Track B — Compras: huecos conocidos del reabasto
Diferidos declarados en el tracker RA + operacionales del último sprint:
- **Topología de red sin configurar** (`warehouses.source_warehouse_id` arranca NULL) → el DRP del CEDIS no corre con datos reales.
- **Lead time real por proveedor = 0 capturados** → el reorden usa el default de 7d en todo el catálogo.
- **Fill rate (RA.13b) sin cerrar** → recibimos contra la OC pero no medimos cumplimiento del proveedor.
- **Demanda intermitente (23,677 SKU clase C·Z)** modelada con promedio-90d, no con Croston/SBA → sobre/sub-estima el lumpy.
- **Sin estacionalidad** (dulce de temporada: globos, fechas) → picos previsibles llegan como agotados.
- **Sin scorecard de proveedor** (puntualidad, fill rate, lead real vs prometido).

### Track C — Thot: datos dormidos
- `customer_360` vacía → churn findings y NBA no tienen base viva (el cron existe, 2 AM MX, pero la tabla está en 0 → hay que operacionalizarlo + backfill).
- `commerce_signals` vacía → el lazo de feedback (ofrecimiento → conversión por razón) no captura nada; el `?log=` de `suggest` no se está ejerciendo.
- Feature store (`intelligence.product_affinity` / `zone_demand` / `pdv_presence`) se construye con **scripts manuales**, no cron → afinidad/zona/whitespace envejecen.

---

## 2. Sprints

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED

### TRACK A — Superficie de razonamiento & autonomía de Thot
Frontend nuevo bajo `apps/view/src/app/modules/comercial/` reusando el patrón de `/compras/hallazgos` y `/finanzas/hallazgos` (Maat). Cliente en `comercial-intelligence.service.ts`. Nav bajo el proyecto Comercial. Respetar DESIGN.md (Operations: tabla densa, master-detail, chips de severidad, sin morado/azul).

- 🔨 **CT-A.1 — Bandeja de Hallazgos comerciales** (`/comercial/razonamiento`) — EN CÓDIGO 2026-07-24
  Nuevo `commercial-intelligence.service.ts` (findings/diagnoses/actions/learning/autonomy) + `comercial-razonamiento.component.ts` + ruta gate `COMMERCIAL_THOT_VER` + nav "Razonamiento (Thot)". Tabla densa por severidad, KPIs por tipo (togglean filtro), fila expandible con evidencia JSON, triage confirmar/descartar/reabrir, botón Recalcular. Build view verde.
  *Pendiente:* datos (findings vacíos hasta CT-C) + validación visual claro/oscuro. El triage llama `POST /findings/:id/review`; el 403 por falta de permiso de gestión se muestra como toast honesto.

- ⬜ **CT-A.2 — Diagnósticos (causa raíz)** (tab en la misma pantalla)
  `GET /diagnoses` + `/compute` + `/:id/review`. Muestra el diagnóstico (≥2 findings correlacionados sobre el mismo sujeto) con sus findings hijos enlazados.
  *Aceptación:* un diagnóstico abre la lista de findings que lo sustentan; review persiste.

- ⬜ **CT-A.3 — Acciones co-piloto** (`/comercial/acciones`)
  `GET /actions` (default pending_approval, priorizadas) + `/:id/explain` + `/approve` + `/reject`. El botón Explicar muestra la **cadena determinista** + la narración del agente (T.R3). Aprobar una `push_product` **crea un push_directive real**.
  *Aceptación:* aprobar genera el efecto real (directiva) y queda en auditoría; rechazar cierra; explicar no inventa números (los cita del motor).

- ⬜ **CT-A.4 — Dial de autonomía** (`/comercial/autonomia`, ADR-023)
  `GET /autonomy/policies` + `PATCH /:actionType` + `POST /run` + `GET /log`. Pantalla por action_type (off / dry_run / auto + min_confidence + daily_cap + value_cap) + **kill-switch global** (`__global__`) + bitácora "Thot actuó solo".
  *Aceptación:* cambiar el dial se refleja en `/run`; el kill-switch global corta todo; el log muestra lo auto-ejecutado con su gate.

- ⬜ **CT-A.5 — Scorecard de aprendizaje (L2)** (tab en autonomía o pantalla propia)
  `GET /learning/rules` + `/recompute` + `/rules/:findingType/override`. Precisión por regla (confirmados/descartados) + pin humano (enabled/suppressed/null).
  *Aceptación:* una regla con baja precisión aparece candidata a supresión; el override humano la fija y sobrevive al recompute.

- ⬜ **CT-A.6 — Nav + permisos + QA visual**
  Item de nav bajo Comercial gateado por `COMMERCIAL_CUSTOMERS_GESTIONAR` (mutación) / `_VER` (lectura). Verificación visual claro/oscuro, contraste AA, PrimeNG-first. Checklist DESIGN.md por pantalla.

### TRACK B — Cerrar diferidos de Compras (RA)

- ⬜ **CT-B.1 — Topología de red + DRP del CEDIS** (operacional + UI)
  Configurar `warehouses.source_warehouse_id` (hoy NULL) desde `/compras/red`; correr `import-network-reorder --apply` para que el CEDIS se planee por demanda dependiente (Σ sucursales, risk pooling).
  *Aceptación:* el CEDIS tiene política computada; `/compras/red` muestra el árbol CEDIS→sucursal; `test-newdb-ra-network` verde.

- ⬜ **CT-B.2 — Lead time real por proveedor**
  Capturar/derivar lead time (Kepler no lo codifica — verificado). UI de captura ya existe en `/compras/proveedores`; falta poblar los prioritarios y, opcional, un derivador estadístico (percentil OC→entrada) como sugerencia.
  *Aceptación:* los top-20 proveedores por sugerido tienen lead capturado; el reorden deja de usar el default 7d en ellos.

- ⬜ **CT-B.3 — Fill rate (RA.13b)**
  Cerrar el ciclo recibido-vs-pedido: en `markReceived`/OE calcular fill rate por línea y agregarlo por proveedor. Columna + KPI en `/compras/ordenes` y en el scorecard.
  *Aceptación:* una OC parcialmente recibida muestra su fill rate; el agregado por proveedor es consultable.

- ⬜ **CT-B.4 — Scorecard de proveedor (RA-PRO.5)**
  Vista `/compras/proveedores` enriquecida: lead real vs capturado, fill rate (CT-B.3), puntualidad (next_due vs entrega), % del sugerido que se convierte en OC. Ranking.
  *Aceptación:* el comprador ve un ranking accionable de confiabilidad por proveedor.

- ⬜ **CT-B.5 — Croston / SBA para demanda intermitente (RA-PRO.4)**
  Para clase XYZ = Z (23,677 SKU lumpy), estimar demanda con Croston/SBA en `import-computed-reorder` en vez del promedio-90d. Gate por clase (Z), fallback al método actual.
  *Aceptación:* los C·Z muestran un reorden más estable (menos sobre-pedido por picos); comparativa antes/después documentada.

- ⬜ **CT-B.6 — Estacionalidad (RA-PRO.7)** *(nice-to-have)*
  Índice estacional por categoría/mes sobre venta histórica; ajustar el objetivo en temporadas conocidas (globos, fechas).
  *Aceptación:* un SKU estacional eleva su objetivo antes del pico, no después.

- ⬜ **CT-B.7 — Write-back a Kepler** *(diferido, gate explícito)*
  Empujar la OC aprobada hacia Kepler (no al revés). Requiere decisión de integración; queda documentado, sin código hasta gate del negocio.

### TRACK C — Datos vivos de Thot

- 🔨 **CT-C.1 — Operacionalizar customer_360** — DIAGNOSTICADO 2026-07-24, reclasificado a sub-proyecto
  **Causa raíz:** el cron corre bien y el tenant está activo; `customer_360` computa desde `commercial.orders` (9 pedidos de la app) → sale vacío.
  **BREAKTHROUGH 2026-07-24:** la fuente RFM del ERP **YA EXISTE** — `analytics.customer_product_sales` (feed `import-customer-sales.js`, en el nightly) está **poblada: 33,408 filas, 1,734 clientes, fresca (23-jul)** con `revenue_90d/180d`, `units_90d/180d`, `last_purchase_date`. Mapea a `commercial.customers` por `code = erp_code` → **301 clientes con match** (tienditas reales con venta). Deja de ser "archaeology": **es un sprint acotado** = reescribir `customer_360.runUpsert()` para derivar de `customer_product_sales` (monetary_90d = Σrevenue_90d; recency/last_order = last_purchase_date; lifecycle por recency — la rama ELSE ya funciona sin cadencia). Limitación: cps agrega sin fecha por-pedido → `frequency/cadence/orders_count` quedan nulos (aceptable; churn_risk es por recencia). **No blind-shippeado:** toca servicio core y necesita verificación en runtime (view build bloqueado por otro thread) + decisión orders-vs-cps-vs-both para no regresar un tenant que sí use la app.
  **2026-07-24 — código arreglado + 2º blocker encontrado:** (a) `customer-360.service` tenía un **BUG LATENTE** — las CTEs seguían al `INSERT (cols)` sin `WITH` → SQL inválido → erraba cada noche (por eso 0 filas, pase lo que pase). Reescrito a `WITH ctes INSERT … SELECT` + fuente `cps_agg` (customer_product_sales). Verificado vs prod: corre (187 filas). (b) **DATA BLOCKER:** los 301 clientes con venta ERP están **TODOS soft-deleted** (2,923/3,110 borrados; 187 vivos = app/demo). customer_360 se llena de verdad al **reactivar/reimportar los clientes ERP** (sprint aparte — investigar por qué se borraron; NO reactivar a ciegas).
  *Aceptación:* `customer_360` poblada desde `customer_product_sales`; `churn_risk` + NBA con data real (bloqueado por clientes ERP soft-deleted).

- ⬜ **CT-C.2 — Lazo de feedback (commerce_signals)**
  Asegurar que `suggest?log=<channel>` registra el ofrecimiento y que la conversión se atribuye por razón (`/signals/conversion-by-reason`). Hoy la tabla está vacía → verificar el wiring en portal/vendedor.
  *Aceptación:* ofrecer y luego comprar deja rastro; el reporte de conversión por razón (afinidad/zona/margen) devuelve números.

- 🔨 **CT-C.3 — Feature store como cron** — EN CÓDIGO 2026-07-24
  `thot-build-features.js` (afinidad + zona) y `thot-build-pdv-presence.js` agregados al `nightly` de `run-prod-feeds.js` (const `SCRIPTS`). Se recomputan solos cada noche → whitespace/afinidad/gap de distribución no envejecen. Syntax OK.
  *Pendiente:* que el nightly corra (ya está wireado).

- 🔨 **CT-C.4 — Señal momentum real** — EN CÓDIGO 2026-07-24 (commit c173ea3a)
  CTE `mom` sobre `analytics.sales_daily` en CAJAS (`units_base`): `momentum = clamp(r30/r90 − 1, 0..1)` sólo con baseline real. `score += 0.4·momentum`; `reason='momentum'` ("En aceleración"). Sanity vs prod: 1,213/5,868 aceleran ≥0.3 (tops estacionales reales). Build api verde. **Landable sin bloqueo** (opera sobre data poblada). Pendiente: redeploy.

- ⬜ **CT-C.5 — Curación del golden set (arranque)**
  Promover las mejores respuestas 👍 del `thot_chat_log` (73 convs) a `thot_chat_examples` (hoy 0) vía `/thot/examples/from-log/:logId` + reindex pgvector. Arranca el few-shot dinámico.
  *Aceptación:* ≥N ejemplos dorados indexados; el retrieval los inyecta en respuestas nuevas.

---

## 3. Orden recomendado (impacto ÷ esfuerzo, con dependencias)

1. **CT-C.1 + CT-C.3** primero (datos): sin `customer_360` y feature store frescos, la bandeja de razonamiento (Track A) mostraría hallazgos pobres. Barato y desbloquea todo.
2. **CT-A.1 → A.3** (hallazgos → acciones): el mayor salto de valor percibido — expone capacidad ya construida. A.4/A.5 (autonomía/aprendizaje) después.
3. **CT-B.1 + CT-B.3** (Compras): operacional y de cierre de ciclo, independientes de Thot; se pueden hacer en paralelo por ser otro dominio.
4. **CT-C.2 / C.4 / C.5** y **CT-B.4/B.5**: refinamientos una vez que lo anterior está vivo.
5. **CT-B.6 / B.7 / CT-A**-pulido: nice-to-have y gated.

**Paralelizable:** Track B es dominio Compras (otro equipo mental) y no depende de A/C. Track A depende de C para lucir. Track C es la base.

---

## 4. Riesgos & no-goals

- **No** meter LLM en el camino del dinero: Track A aprueba efectos deterministas; el `/explain` narra, no calcula.
- **customer_360 vacía** puede ser un cron que no corre en Railway (no sólo "aún no computa") → CT-C.1 incluye diagnóstico de causa, no sólo "correrlo".
- **Croston (CT-B.5)** es marginal si la data de demanda sigue siendo ruidosa; medir antes/después, no asumir mejora.
- **Write-back Kepler (CT-B.7)** es integración con el ERP → gate de negocio, no se toca sin decisión explícita (nunca escribir a Kepler sin autorización).
- Migraciones nuevas: idempotentes; nada de filas en `knex_migrations` sin archivo. Tablas nuevas con `tenant_id` + RLS.

---

## 5. Pendiente al arrancar
- Registrar esta fase en [`01_TRACKER_PROGRESO.md`](../01_TRACKER_PROGRESO.md) y en la tabla de roadmap de `CLAUDE.md`.
- Definir permisos finales de Track A (¿reusar `COMMERCIAL_CUSTOMERS_*` o crear `COMMERCIAL_THOT_REASONING_*`?).
- Confirmar con Edgar el orden real (¿prioridad a la UI de Thot o a cerrar Compras primero?).
