# Fase CT — Cierre Compras + Thot (post-mapa operativo)

> **Estado:** ⬜ PLANEADO 2026-07-24. Surge del mapa operativo de Compras + Thot (datos vivos de prod ese día). Tres tracks paralelos: **A** = superficie de razonamiento/autonomía de Thot (hoy API-only), **B** = cerrar los diferidos de Compras (RA), **C** = poner al día los datos que alimentan a Thot.
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

- ⬜ **CT-A.1 — Bandeja de Hallazgos comerciales** (`/comercial/hallazgos`)
  Consume `GET /commercial/intelligence/findings` (filtros status/severity/subject_type) + `POST /findings/compute` + `POST /findings/:id/review`.
  Tabla densa por severidad (dead-stock, margin_laggard, distribution_gap, churn_risk) + panel de evidencia + confirmar/descartar. KPIs por tipo.
  *Aceptación:* la bandeja lista los findings vivos, el triage persiste y se refleja en el scorecard L2; botón "recalcular" dispara compute.

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

- ⬜ **CT-C.1 — Operacionalizar customer_360**
  Correr `customer-360-refresh` (cron 2 AM MX ya existe) + backfill inicial en prod; verificar que alimenta churn findings y NBA. Investigar por qué la tabla está en 0 (¿cron no corre en Railway? ¿scope de tenant?).
  *Aceptación:* `customer_360` poblada; `/nba` y `churn_risk` findings devuelven data real.

- ⬜ **CT-C.2 — Lazo de feedback (commerce_signals)**
  Asegurar que `suggest?log=<channel>` registra el ofrecimiento y que la conversión se atribuye por razón (`/signals/conversion-by-reason`). Hoy la tabla está vacía → verificar el wiring en portal/vendedor.
  *Aceptación:* ofrecer y luego comprar deja rastro; el reporte de conversión por razón (afinidad/zona/margen) devuelve números.

- ⬜ **CT-C.3 — Feature store como cron**
  Agendar `thot-build-features.js` (afinidad + zona) y `thot-build-pdv-presence.js` en `run-prod-feeds` (nightly) en vez de scripts manuales, para que whitespace/afinidad no envejezcan.
  *Aceptación:* las features se recomputan solas cada noche; fecha de cómputo fresca.

- ⬜ **CT-C.4 — Señal momentum real**
  Implementar momentum como término propio del score (tendencia ventas 30d vs 90d, normalizada) en `thot.service.suggest()`, con su `reason='momentum'`. Cierra el gap "documentado-no-implementado" del ADR-018.
  *Aceptación:* un producto en aceleración sube en el ranking con razón "momentum"; documentado en el score.

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
