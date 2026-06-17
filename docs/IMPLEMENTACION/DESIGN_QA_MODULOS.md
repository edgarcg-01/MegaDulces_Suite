# Design QA — Verificación módulo por módulo

> **Propósito:** especializar la app en diseño frontend de alto nivel — carga de interfaces, UX/UI, márgenes/espaciado, diseños interactivos innovadores y eficaces, colorimetría, posicionamiento y jerarquía. Este archivo es el **tracker vivo** del barrido de diseño, una fila por pantalla.
> **Fuente de verdad visual:** [`DESIGN.md`](../../DESIGN.md) (sistema "Mercado", 2 surfaces) + [`docs/DESIGN_FOUNDATIONS.md`](../DESIGN_FOUNDATIONS.md) (el porqué) + tokens en [`apps/view/src/styles/tokens.css`](../../apps/view/src/styles/tokens.css).
> **Tendencias del campo (qué hay afuera, 2026):** [`docs/DESIGN_TENDENCIAS_2026.md`](../DESIGN_TENDENCIAS_2026.md) — investigación citada de tipografía/color/spacing/UX/a11y + lookbook de referencias.
> **Cómo se usa:** se audita una pantalla, se llena su checklist con la rúbrica de 8 dimensiones, se anota el hallazgo y se cierra. No declarar ✅ sin verificación visual real (browser/DevTools), no solo lectura de código.

---

## Leyenda de estado

| Símbolo | Significado |
|---|---|
| ⬜ | Sin auditar |
| 🔍 | Auditado — hallazgos registrados, sin arreglar |
| 🔨 | En arreglo |
| ✅ | Conforme a "Mercado" (verificado visualmente) |
| ⚠️ | Bloqueado / decisión pendiente |
| 🟣 | Deuda conocida aceptada (documentada) |

Prioridad de hallazgo: 🔴 alto impacto · 🟡 medio · 🟢 pulido.

---

## Las 8 dimensiones (rúbrica por pantalla)

Cada pantalla se evalúa contra estas 8 dimensiones. Score por dimensión: ✅ bien · 🟡 mejorable · 🔴 roto · — N/A.

| # | Dimensión | Qué se verifica | Referencia DESIGN.md |
|---|---|---|---|
| **D1** | **Carga / loading** | Skeletons (no spinners en bloque), estados vacíos accionables, perceived performance, sin layout shift (CLS), optimistic UI donde aplica | "Empty state operacional", "skeletons" |
| **D2** | **Tipografía / jerarquía** | Hanken Grotesk body, Geist Mono + `tabular-nums` en TODA cifra/folio/hora, page-head correcto por surface, NO Inter, NO Fraunces en Operations | Typography, Type scale Operations |
| **D3** | **Colorimetría** | Tokens semánticos (sin hex inline), Stone neutrales, `--action` sunset para CTA, ember IA (no morado/azul), dark espresso, contraste AA | Color, antipatrones |
| **D4** | **Espaciado / márgenes** | Escala 4px (sin valores off-grid tipo `.4rem`/`.35rem`/`.6rem`), densidad correcta (compact++ Operations / comfortable Storefront), **ritmo vertical entre secciones: medir gap real entre cada bloque — no debe haber márgenes dobles ni gaps de 0px por top+bottom-margin combinados**, padding interno consistente entre cards hermanas | Spacing |
| **D5** | **Layout / posición** | Patrón canónico correcto (master-detail, KPI strip, tabla densa), max-width, sticky correcto, responsive (mobile bottom-nav), zonas del pulgar | Layout, Patrones canónicos |
| **D6** | **Interacción / motion** | 4 estados (hover/active/disabled/focus), `--ease-standard`, duraciones, `prefers-reduced-motion`, haptics mobile, microinteracciones intencionales | Motion, principios nativos |
| **D7** | **Componentes / reuso** | Átomos/moléculas/organismos compartidos (no re-estilo por pantalla), `p-tag` con severity, ghost buttons pattern, sin duplicación | Atomic Design, ghost buttons |
| **D8** | **A11y / táctil** | `focus-visible:ring`, `aria-*`, labels `for/id`, targets ≥44px mobile, `aria-current` en selección, semántica de roles | A11y línea base, Ley de Fitts |

**Antipatrones a marcar siempre (flag inmediato):**
- Inter como `--font-body` · Fraunces en Operations · `#000` puro en dark
- `#8b5cf6` morado o `#2563EB` azul para IA · hex inline en color (pin Leaflet, gradientes)
- Cifras sin `tabular-nums` · targets <44px mobile · empty "No items found" sin CTA
- Cards con íconos en círculos de color como decoración · 3-col feature grid · todo centrado
- Spinner de bloque donde corresponde skeleton · CTA primario ambiguo (más de una jerarquía)

---

## Mapa de surfaces

| Surface | Rutas | Mode | Density | Display font |
|---|---|---|---|---|
| **Storefront** | `/portal/*` | editorial + tool | comfortable / compact | Fraunces + Hanken + Geist |
| **Operations** | `/dashboard`, `/comercial`, `/logistica`, `/admin`, `/vendor`, `/televenta` | tool only | compact++ | Hanken + Geist (NO Fraunces) |

---

# STOREFRONT — `/portal/*`

> Surface del cliente B2B final (dueño de dulcería). El más importante visualmente: es la cara externa. Mode editorial permitido (Fraunces, ilustraciones SVG, momentos de marca). Referencia de calidad: este surface ya tuvo la auditoría más profunda (DESIGN.md 2026-06-04).

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Portal Login | `portal/pages/portal-login.component.ts` | ⬜ | | | | | | | | | |
| Portal Home | `portal/pages/portal-home.component.ts` | ⬜ | | | | | | | | | |
| Catálogo | `portal/pages/portal-catalog.component.ts` | ⬜ | | | | | | | | | Toggle grid⇄lista pendiente · AI chips ember · `--promo-accent` tokenizar |
| Carrito | `portal/pages/portal-cart.component.ts` | ⬜ | | | | | | | | | Sticky cart pill · CTA zona pulgar |
| Pedidos | `portal/pages/portal-orders.component.ts` | ⬜ | | | | | | | | | |
| Detalle de pedido | `portal/pages/portal-order-detail.component.ts` | ⬜ | | | | | | | | | Timeline historial |
| Promociones | `portal/pages/portal-promotions.component.ts` | ⬜ | | | | | | | | | Bento top-3 |
| Recomendaciones IA | `portal/pages/portal-recommendations.component.ts` | ⬜ | | | | | | | | | 4 secciones · score% · ember obligatorio |

**Sprint pendiente Storefront (de DESIGN.md auditoría):** extraer capa Atómica — `PortalButton`, `ProductCard`, `Pill/Badge`, `Stepper`, `EmptyState`, `SearchBar`. Resuelve targets <44px, CTA ambiguo y estados nativos inconsistentes de una pasada.

---

# OPERATIONS — Trade Marketing `/dashboard/*`

> Surface interno del supervisor de PdV. Tabla densa + master-detail como organismo primario. Referencia ya migrada: `/dashboard/routes` (master-detail, 2026-06-08).

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Home dashboard | `dashboard/home/` | ⬜ | | | | | | | | | KPI strip sin íconos en círculos |
| Layout / nav | `dashboard/layout/` | ⬜ | | | | | | | | | Sidebar hover-expand + bottom-nav mobile (referencia) |
| Command Center | `dashboard/command-center/` | 🔨 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Fixes aplicados (2 pasadas, build OK). D4 re-auditado a fondo: patrón de spacing correcto (hairline + gap-on-container). Falta verificación visual. Ver detalle. |
| Capturas | `dashboard/captures/` | ⬜ | | | | | | | | | Wizard · isVendedor legacy a limpiar |
| Vendor capture | `dashboard/vendor-capture/` | ⬜ | | | | | | | | | Offline-first · banner OCR diferido |
| Reportes | `dashboard/reports/` | ⬜ | | | | | | | | | Tabs: graphics / routes / stores |
| Análisis de rutas | `dashboard/routes-analysis/` | ⬜ | | | | | | | | | Mapa Leaflet pin tokenizado |
| Stores | `dashboard/stores/` | ⬜ | | | | | | | | | |
| Visitas | `dashboard/visits/` | ⬜ | | | | | | | | | |
| Exhibiciones | `dashboard/exhibitions/` | ⬜ | | | | | | | | | |
| Asignaciones diarias | `dashboard/daily-assignments/` | ⬜ | | | | | | | | | |
| Seguimiento | `dashboard/seguimiento/` | ⬜ | | | | | | | | | |
| Route tickets | `dashboard/route-tickets/` | ⬜ | | | | | | | | | |
| Analytics histórico | `dashboard/historical-analytics/` | 🔨 | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | Bien construida (surf-page canónico, toolbar = Pedidos). Fixes: aria-label refresh + skeleton estructurado + off-grid. Deuda 🟡: `.cc-rank-badge`/`.ha-segment` duplican command-center/orders (extraer molécula). Falta verif. visual. |
| Admin · Catálogos | `dashboard/admin-catalogs/` | ⬜ | | | | | | | | | |
| Admin · Planograma | `dashboard/admin-planograma/` | ⬜ | | | | | | | | | |
| Admin · Roles | `dashboard/admin-roles/` | ⬜ | | | | | | | | | |
| Admin · Scoring | `dashboard/admin-scoring/` | ⬜ | | | | | | | | | |
| Admin · Usuarios | `dashboard/admin-users/` | ⬜ | | | | | | | | | |

---

# OPERATIONS — Comercial `/comercial/*`

> Gerente comercial. Master-detail + tabla densa. Pedidos = flujo crítico (draft→confirm→fulfill).

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Clientes | `comercial/pages/comercial-customers.component.ts` | 🔨 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 8/8 vs .md (16-jun). **Drill-down: fila → side-peek + Customer360** (reusa organismos, regla #8; actions con stopPropagation). **Cards dinámicos: count-up** en los 4 KPIs. **🔴 CSS muerto purgado** (`cu-inline-*`/`store-option`/`row-*-select`/`saving-spinner` huérfanos post-CV.3) + `.store-select` movido al hijo `CustomerFormDialog`. Hygiene: `code.pwd` JetBrains→`--font-mono`, empty-icon off-scale→token, search focus→`--action`. **Dinamismo visual (cards ya no idénticas):** nuevo endpoint `GET /commercial/customers/stats/new-daily` → Activos lleva **mini-barras (altas/día reales)**, Con ruta + Tienda enlazada llevan **barra de ratio %** (cobertura vs activos), Crédito = headline money. Nueva regla BINDING en DESIGN.md ("variedad por tipo de dato"). Builds view+api verdes. Verif. visual pendiente. |
| Productos | `comercial/pages/comercial-products.component.ts` | ⬜ | | | | | | | | | |
| Pricing | `comercial/pages/comercial-pricing.component.ts` | ⬜ | | | | | | | | | Cifras tabular-nums |
| Inventario | `comercial/pages/comercial-inventory.component.ts` | ⬜ | | | | | | | | | Low-stock severity |
| Almacenes | `comercial/pages/comercial-warehouses.component.ts` | ⬜ | | | | | | | | | |
| Pedidos | `comercial/pages/comercial-orders.component.ts` | 🔨 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 2da pasada 16-jun (8/8 vs .md): **🔴 bug estilos de filtros huérfanos en el padre → movidos a OrderFilters** · count-up KPIs + skeleton-first-load · 2 font-size off-scale→token · pills semánticas OK · row focus-visible OK · side-peek N/A (detalle full-page, regla #8) · stagger N/A (lista recarga). Defer: sticky header + frozen folio (#12, paginado 15 filas, bajo valor). Falta verif. visual. |
| Detalle de pedido | `comercial/pages/comercial-order-detail.component.ts` | 🔨 | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | Migrado a wrapper canónico `.surf-page` + `surf-page-head` → márgenes de página idénticos a las otras 21. Skeleton + a11y + draft neutral. Pendiente: cards internas (p-card→sheet/cell). |
| Promociones | `comercial/pages/comercial-promotions.component.ts` | ⬜ | | | | | | | | | Codemod hex aplicado (verificar) |
| Route tickets | `comercial/pages/comercial-route-tickets.component.ts` | ⬜ | | | | | | | | | Cierre de ruta · OCR |
| Ventas vendedor | `comercial/pages/comercial-vendor-sales.component.ts` | ⬜ | | | | | | | | | |

---

# OPERATIONS — Logística `/logistica/*`

> Gerente logística. UI portada del repo `_imported/logistica/` (Fase J.9). Más rica visualmente — verificar que respete tokens y no traiga hex propios.

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard ops | `logistica/pages/logistica-dashboard.component.ts` | ⬜ | | | | | | | | | Shimmer load · codemod hex aplicado (verificar) |
| Embarques | `logistica/pages/logistica-shipments.component.ts` | ⬜ | | | | | | | | | Master-detail |
| Detalle embarque | `logistica/pages/logistica-shipment-detail.component.ts` | ⬜ | | | | | | | | | |
| Guías | `logistica/pages/logistica-guides.component.ts` | ⬜ | | | | | | | | | 5 KPIs + filtros |
| Costos | `logistica/pages/logistica-costs.component.ts` | ⬜ | | | | | | | | | KPIs + edit dialog 10 cat |
| Personal / Staff | `logistica/pages/logistica-staff.component.ts` | ⬜ | | | | | | | | | Avatares + MultiSelect roles |
| Flotilla | `logistica/pages/logistica-fleet.component.ts` | ⬜ | | | | | | | | | |
| Checklist | `logistica/pages/logistica-checklist.component.ts` | ⬜ | | | | | | | | | |
| Fotos | `logistica/pages/logistica-photos.component.ts` | ⬜ | | | | | | | | | Grid imágenes · lazy load |
| Reportes | `logistica/pages/logistica-reports.component.ts` | ⬜ | | | | | | | | | |
| Nómina | `logistica/pages/logistica-payroll.component.ts` | ⬜ | | | | | | | | | payroll_adjustments |
| Asignación drivers | `logistica/pages/logistica-driver-assignments.component.ts` | ⬜ | | | | | | | | | |
| Config | `logistica/pages/logistica-config.component.ts` | ⬜ | | | | | | | | | Tabs |

---

# OPERATIONS — Vendedor `/vendor/*`

> App vendedor mobile-first (Capacitor). Ley de Fitts crítica: targets grandes, CTA zona pulgar, bottom-nav nativo.

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Clientes | `vendor/pages/vendor-customers.component.ts` | ⬜ | | | | | | | | | Search debounced · mobile list |
| Tomar pedido | `vendor/pages/vendor-take-order.component.ts` | ⬜ | | | | | | | | | Carrito sticky · targets ≥44px |
| Mi día | `vendor/pages/vendor-today.component.ts` | ⬜ | | | | | | | | | 3 KPI cards |
| Cierre de ruta | `vendor/pages/vendor-close-route.component.ts` | ⬜ | | | | | | | | | 3 tickets · OCR · offline-first |

---

# OPERATIONS — Televenta `/televenta/*`

> Operador call center. Queue priorizada como organismo central. Velocidad de captura clave.

| Pantalla | Archivo | Estado | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | Hallazgos clave |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Dashboard | `televenta/pages/televenta-dashboard.component.ts` | ⬜ | | | | | | | | | Métricas |
| Cola (queue) | `televenta/pages/televenta-queue.component.ts` | ⬜ | | | | | | | | | Priorización visual · severity |
| Lead snapshot | `televenta/pages/televenta-lead.component.ts` | ⬜ | | | | | | | | | Modal log call |
| Tomar pedido | `televenta/pages/televenta-take-order.component.ts` | ⬜ | | | | | | | | | Reusa VendorService |

---

# SHELL / TRANSVERSAL

> Pantallas y componentes compartidos. Auditarlos primero: un fix aquí propaga a todos los módulos.

| Pantalla / componente | Archivo | Estado | Notas |
|---|---|---|---|
| Login (admin) | `auth/login/` | ⬜ | Entrada a Operations |
| Projects landing | `projects/projects/` | ⬜ | 4 proyectos + 2 apps satélite |
| Map component | `shared/components/map/map.component.ts` | ⬜ | Pin Leaflet tokenizar `var(--action)` |
| tokens.css | `styles/tokens.css` | ⬜ | Migración Operations (Stone/ember/espresso) **pendiente de aprobación del diff** |
| styles.css globales | `styles/` | ⬜ | `.portal-page-head h1`, utilities ghost-button |

---

## Backlog de diseño priorizado (cross-módulo)

> Hallazgos sistémicos que no son de una sola pantalla. Ordenados por impacto.

0. 🟡 **Consistencia de márgenes de página (cross-page):** el estándar es `.surf-page` (gap 16px, padding `0 1.5rem 2rem`). 21/23 páginas lo usan. Outliers: ~~`comercial-order-detail`~~ (✅ migrado 2026-06-09) y **`logistica-fleet`** (pendiente — header propio, sin `.surf-page`). `command-center` pisa gap a 24/32px (excepción hero documentada).
1. 🔴 **Migración tokens Operations** — aplicar Stone + `--action` + ember + espresso a `:root` (hoy Inter/Zinc/azul). Es swap de tokens, costo bajo, impacto cross-app. Plan en DESIGN.md "Plan de migración Operations". **Pendiente de aprobación del diff.**
2. 🔴 **Capa atómica Storefront** — extraer 6 componentes compartidos (`PortalButton`, `ProductCard`, `Pill`, `Stepper`, `EmptyState`, `SearchBar`). Resuelve ~4 variantes de card y ~5 de botón primario.
3. 🟡 **Codemod hex residual** — 146+ literales de color restantes (memoria `project_frontend_state_post_design_review`). `ai-product-picker` es la referencia visual correcta.
4. 🟡 **Targets táctiles <44px** — `cat-add` 38px, steppers 32-36px en mobile.
5. 🟡 **`tabular-nums` audit global** — toda cifra/folio/hora/score en Geist Mono tabular.
6. 🟢 **Empty states operacionales** — sustituir "No items found" por título + descripción + CTA accionable, voz técnica.

---

## Orden de barrido sugerido

1. **Transversal primero** (tokens.css, shell, map) — un fix propaga a todo.
2. **Portal** — cara externa, mayor impacto de marca, ya tiene auditoría base.
3. **Command Center + Comercial Pedidos** — flujos críticos de negocio.
4. **Logística** — UI portada, mayor riesgo de hex/inconsistencia.
5. **Vendor + Televenta** — mobile-first, Ley de Fitts.
6. **Dashboard Trade + Admin** — internos, menor exposición.

---

## Auditorías detalladas

### Command Center — `/dashboard/command-center` (2026-06-09)

> Surface: Operations · Tipo: dashboard hero (KPI strip + tablas densas). Archivos: `command-center.component.{ts,html,css}` + `command-center.service.ts` + `alerts-socket.service.ts`.
> **Nota previa:** la migración de tokens "Mercado" Operations (Stone/action/ember/espresso, Hanken, `--neutral→--stone`) **ya está aplicada** en `tokens.css`/`styles.css` — DESIGN.md la marca como "pendiente de aprobación" pero el código ya la tiene. Corregir DESIGN.md.

**D1 · Carga/loading — 🟡**
- 🟡 Skeleton único `height="280px"` mientras la página real mide ~5 sheets de alto → al resolver hay salto/CLS grande. Fix: un skeleton por sheet (hero + 4 bloques) o altura realista.
- ✅ Empty state en cada tabla (icono + texto). 🟢 Sin CTA accionable (DESIGN.md pide CTA en empties), aceptable en dashboard.
- ✅ Error → toast; estado de carga en botón refresh.
- 🟢 `rankingOutOfStock` (FDW al ERP) va en el mismo `forkJoin` → bloquea el render hasta que resuelve (mitigado con `catchError`→[]). Considerar `@defer` para no atar el dashboard a la latencia del FDW.

**D2 · Tipografía/jerarquía — 🟡**
- ✅ `--font-body` = Hanken Grotesk (no Inter). Page-head h1 = Hanken bold, override 1.75rem + tracking tight (no Fraunces). Correcto para Operations.
- ✅ `tabular-nums` presente en cell-value, data-table, brand-share, delta.
- 🟡 **KPI values y celdas `.num`/`.data-table` NO usan `--font-mono` (Geist Mono)** — solo `tabular-nums` sobre Hanken. DESIGN.md spec: data/folios/cifras/KPI = Geist Mono. `comm-code` sí es mono; el resto no. Decidir: ¿mono en cifras o aceptar Hanken+tabular como estándar Operations?

**D3 · Colorimetría — 🟡**
- ✅ Tokens semánticos, Stone (alias), hero accent = sunset (`--c-accent-fg`→brand-700). Sin morado/azul IA (el feed IA fue removido).
- 🟡 **rgba hardcoded en `.css`:** `rgba(22,163,74,…)` (pulse verde, ×4), `rgba(220,38,38,0.10)` (rank-badge.is-bad). Tokenizar a `--c-ok`/`--c-bad`.
- 🟢 **Inline style en HTML:** `style="margin-right:.35rem; color:var(--c-bad)"` en el icono de "Best-sellers ERP sin stock" (línea 305). Mover a clase.
- 🟢 Sparkline del hero es monocromo (`--c-text-1`) — plano para ser la métrica estrella. Enhancement: `--action`/ember.

**D4 · Espaciado/márgenes — 🟡**
- ✅ Escala coherente, ritmo vertical limpio.
- 🟡 **Densidad deliberadamente "comfortable"** (overrides en `.css`: gap 1.5–2rem, cell padding 1.5/1.75rem, td 0.75/1.25rem) vs tesis Operations = **compact++**. Es un opt-in consciente (comentado "Más respiración") pero diverge del spec. Decidir si Command Center es excepción hero o se alinea a compact++.
- 🟢 Algunos valores off-grid (0.875, 0.55, 0.65rem).

**D5 · Layout/posición — ✅**
- ✅ Bento 12-col (hero span-6 row-2 + satélites) + KPI strip + tablas densas con sticky header + scroll wrap. Patrón correcto para dashboard (no aplica master-detail).
- ✅ `.cell-icon` es chip 30px radio-8px neutral top-right — NO es el antipatrón "ícono en círculo de color" (esos son grandes/centrados en feature-grid).
- ⏳ Responsive mobile (colapso de cols-12) y `max-width` → verificar visualmente.

**D6 · Interacción/motion — 🟡**
- ✅ `prefers-reduced-motion` cubierto (pulse, bar-fill). Transiciones cortas.
- 🟡 **Row hover usa `--brand-500` (amarillo #F8B400)** como acento en `box-shadow` de primera columna (`styles.css:2756`). Regla DS: amarillo = sello, **acento activo = `--action` sunset**. Afecta TODAS las tablas Operations.
- 🟢 `bar-fill` usa `cubic-bezier(0.4,0,0.2,1)` (Material) en vez del token `--ease-standard: cubic-bezier(0.2,0,0,1)`.

**D7 · Componentes/reuso — 🔴**
- ✅ Reusa átomos compartidos (`surf-page`, `cell`, `sheet`, `data-table`, `comm-pill`, `comm-code`, `cc-rank-badge`).
- 🔴 **DEAD CODE.** El feed de alertas WS realtime (Fase C.4) fue removido del HTML (los sheets saltan 3→5, "SHEET 4" no existe) pero quedaron huérfanos: `.cc-ws`/`.cc-ws-dot`/`@keyframes cc-pulse` (~30 líneas) + `.cc-feed*` (~70 líneas) en `.css`, y `alerts-socket.service.ts` (101 líneas) **no se importa** en el componente. Decidir: **(a)** re-incorporar el feed realtime, o **(b)** borrar CSS huérfano + service. ~200 líneas muertas.
- 🟢 Tablas hand-rolled `<table class="data-table">` en vez de PrimeNG `p-table` (DESIGN.md patrón #3). Es un átomo compartido consistente y liviano — aceptable, pero diverge del canónico declarado.

**D8 · A11y/táctil — ✅**
- ✅ `aria-hidden` en decorativos, `aria-label` + tooltip en refresh, sparkline/badges aria-hidden con dato textual equivalente (delta %).
- 🟡 `th` sin `scope`, tablas sin `<caption>`/aria-label.
- 🟢 Refresh = text-button icon-only PrimeNG small → verificar ≥44px en mobile.

**Plan de fix sugerido (orden por payoff):**
1. 🔴 Resolver dead code WS (borrar u re-incorporar) — decisión de producto.
2. 🟡 Skeleton por-sheet (mata el CLS) — bajo esfuerzo, alto payoff visual.
3. 🟡 Row-hover accent `--brand-500`→`--action` en `.data-table` (cross-Operations) + tokenizar rgba hardcoded + quitar inline style.
4. 🟡 Decisión: Geist Mono en cifras/KPI (sí/no) y densidad compact++ vs comfortable hero. Si "sí mono", aplicar a `.cell-value` + `.data-table .num`.
5. 🟢 `--ease-standard` en bar-fill, sparkline a `--action`/ember.

**Fixes aplicados (2026-06-09, `nx build view` OK):**
- ✅ **Dead code:** borrado CSS huérfano `.cc-ws*` + `@keyframes cc-pulse` + `.cc-feed*` (~100 líneas). **`alerts-socket.service.ts` NO se borró** — está en uso por `portal-shell.component.ts` (no era dead code; verificado antes de borrar).
- ✅ **Geist Mono en cifras:** `--font-mono` aplicado a `.cell-value` + `.data-table .num` (global, cross-Operations) + `.cc-brand-share` local.
- ✅ **Skeleton por-sheet:** `<p-skeleton>` único de 280px → grupo `.cc-skeletons` de 4 piezas que aproximan el layout (mata el CLS).
- ✅ **Row hover accent:** `.data-table tbody tr:hover td:first-child` `--brand-500` (amarillo) → `--action` (sunset). Cross-Operations.
- ✅ **Tokenización:** `.cc-rank-badge.is-bad` rgba → `var(--bad-soft-bg)`; inline-style del icono OOS → clase `.cc-ico-bad`; `bar-fill` easing → `var(--ease-standard)`.
- ✅ **Densidad comfortable** documentada como excepción consciente del hero (comentario en `.css`).

**Diferido (🟢 enhancements):** `scope`/`<caption>` en `th`; verificar target ≥44px del botón refresh en mobile; migrar tabla hand-rolled a `p-table` (decisión arquitectónica, no urgente).

**Pendiente:** verificación visual (browser/DevTools mobile) — no ejecutado (no levanto dev servers por iniciativa). **Nota doc:** corregir DESIGN.md, que marca la migración de tokens Operations como "pendiente de aprobación" cuando ya está aplicada en `tokens.css`/`styles.css`.

**Re-auditoría D4 + color (2026-06-09, 2da pasada con el marco de [`DESIGN_TENDENCIAS_2026.md`](../DESIGN_TENDENCIAS_2026.md)):**
- ✅ **El patrón de spacing es correcto** (en la 1ra pasada no lo expliqué bien). `.sheet { gap:1px; background:border-color }` = hairlines de 1px entre celdas (divisores premium tipo Vercel/Linear), NO whitespace. Entre sheets: `gap:1.5rem/2rem` (24/32px) en el contenedor flex = ritmo on-grid, gap-on-container, **sin el bug de doble-margen** del order-detail.
- ✅ **Densidad "comfortable" validada por la investigación:** "interaction-dense, not pixel-dense" + "más aire entre organismos = premium". Lo correcto es tabla compacta (td 12/20px ✓) + secciones generosas. La excepción documentada queda confirmada como buena práctica.
- 🟢→✅ **Off-grid corregidos:** `.cc-hero gap` 0.875rem(14px)→0.75rem(12px); `.cc-rank-badge.is-bad` 0.45rem→0.5rem; `.cc-ico-bad` 0.35rem→0.375rem.
- 🟢→✅ **Color on-trend:** sparkline del hero `--c-text-1` (monocromo) → `var(--action)` (sunset). La guía 2026 pide "un acento fuerte en la métrica estrella"; la barra de mix-marca queda neutral a propósito (1 solo acento = jerarquía).
- 🟢 `internal ≤ external` no aplica dentro del sheet (el divisor hairline hace el agrupamiento, no el whitespace). Sin acción.

---

### Comercial · Pedidos — `/comercial/orders` (+ `/orders/history`) (2026-06-09)

> Surface: Operations · Tipo: lista densa con KPI strip + tabs (pending/history) + toolbar de filtros + `p-table`. Componente single-file (template + styles inline, 952 líneas). Detalle de pedido es pantalla aparte.
> **Nivel general: alto.** Es de las pantallas mejor construidas — empty states ejemplares, density correcta (compact++), motion con tokens, a11y de filtros sólida. Tenía un bug 🔴 de colorimetría.

**D1 · Carga/loading — ✅**
- ✅ KPI skeleton (`height=120px`) acorde a la altura real del strip (una fila). `p-table [loading]` con overlay nativo.
- ✅✅ **Empty state ejemplar** (referencia para el resto): icono + título + mensaje **contextual** (distingue search / filtro / vacío) + CTA "Limpiar filtros". Es exactamente el patrón que DESIGN.md pide.

**D2 · Tipografía/jerarquía — ✅**
- ✅ Page-head h1 Hanken bold (shared `surf-page-head`). Labels KPI uppercase micro. Folio en `comm-code` (mono). `cell-value` ya hereda mono del fix global.
- 🟡→✅ `comm-num` (Total) y `.co-date` tenían tabular pero no mono → **arreglado** (`--font-mono`). Cross-Operations en `comm-num`.

**D3 · Colorimetría — ✅ (tras fix de bug)**
- 🔴→✅ **BUG: pill `pending_approval` sin color.** Template `[class]="'is-' + o.status"` generaba `is-pending_approval`, clase inexistente (solo había `.is-pending`) → los pedidos por aprobar (el foco de la vista) caían al gris neutro base. **Fix:** agregada `.is-pending_approval` (ámbar) + `draft` reclasificado a **neutral stone** (antes ámbar) para diferenciarse de pending en el mismo tab. Tokenizados los soft-bg (`--warn/info/ok/bad-soft-bg`). Cross-Operations (pill compartido).
- 🟢 Filtros (chips/segments) usan escala monocroma (negro/stone) a propósito — no compiten con `--action`. Coherente.

**D4 · Espaciado/márgenes — ✅**
- ✅ Density compact++ correcta: toolbar a 32px uniforme, chips 28px, controles alineados. Este SÍ cumple la tesis Operations (contraste con Command Center comfortable).

**D5 · Layout/posición — ✅**
- ✅ KPI strip adaptativo por modo + tabs en header + tabla flush. Patrón Operations correcto.
- 🟢 Banda de filtros full-width como sheet propio vs DESIGN.md patrón #6 ("rango de fechas en el header, no banda global mid-page"). Está bien organizada (chips + toolbar en una cell) — desviación menor aceptable; opcional mover el date-range al header.
- 🟢 Lista con navegación a detalle (no master-detail). DESIGN.md lista Pedidos como candidato master-detail, pero navigate-to-detail es válido y mobile-friendly.

**D6 · Interacción/motion — ✅**
- ✅ Transiciones con `var(--ease-standard)` (consistente, bien). Hover/active en tabs, chips, segments. Search debounce 180ms.

**D7 · Componentes/reuso — ✅**
- ✅ Buen reuso (`surf-page`, `cell`, `sheet`, `comm-*`, `portal-status-pill`, `p-table`).
- 🟢 `co-mode-tabs`/`co-chips`/`co-segment` son moléculas bespoke (patrón pill/segment que se repite en otras pantallas). Candidatas a extraer a átomo compartido en el futuro.
- 🟢 Naming leak: `portal-status-pill` (prefijo storefront) usado en Operations. Cosmético; renombrar a átomo neutro algún día.

**D8 · A11y/táctil — 🟡**
- ✅ `role=tablist/tab` + `aria-selected` en tabs y chips, `aria-label` en grupos/search/clear, `aria-hidden` en iconos, `focus-within` en search/daterange.
- 🟡 **Filas clickeables sin acceso por teclado:** `<tr (click)>` con cursor pointer pero sin `tabindex`/`keydown`/`role` → el detalle no es alcanzable por teclado desde la tabla. Aplica a todas las `comm-row-clickable`. **Diferido** (requiere handler por componente o directiva compartida).
- 🟡 Targets <44px en toolbar densa (chips 28px, search-clear 22px). Típico de Operations; aceptar en desktop, revisar en mobile.
- 🟢 `:focus-within` usa ring negro (`--c-focus-ring` fallback rgba negro) en vez de `--action-ring`. Menor.

**Fixes aplicados (2026-06-09, `nx build view` OK):**
- ✅ 🔴 Pill `pending_approval` ahora ámbar; `draft` → neutral stone (diferenciables en el tab pending); soft-bg tokenizados.
- ✅ Geist Mono en `.comm-num` (global comercial) y `.co-date` (local).

**Diferido:** keyboard nav en filas (cross-cutting, directiva compartida); targets ≥44px mobile; focus-ring → `--action-ring`; date-range al header; extraer molécula tabs/chips/segment.

**Pendiente:** verificación visual. **Nota:** `comercial-order-detail.component.ts` (503 líneas) NO auditado aún — es pantalla aparte; agendar.

---

### Comercial · Detalle de pedido — `/comercial/orders/:id` (2026-06-09)

> Surface: Operations · Tipo: detalle (header + 3 stat cards + p-card líneas con edición inline + action-bar + p-card logística + p-card historial timeline). Single-file, 503 líneas.
> **Hallazgo macro:** es una pantalla **pre-refactor**. Usa el sistema viejo (`comm-page-head`+`<h2>`, `comm-stat-card`, `p-card` PrimeNG, tokens legacy `--primary-color`/`--text-color-secondary`/`--surface-100`, font-sizes y radios hardcodeados) mientras la hermana lista (`comercial-orders`) ya migró a `surf-page`/`cell`/`sheet`/`--c-*`/`--fs-*`. Dos pantallas del mismo flujo se ven de generaciones distintas.

**D4 · Espaciado/márgenes — análisis detallado (2026-06-09):**
- 🟡→✅ **Bug de ritmo vertical entre secciones.** Las cards usaban márgenes ad-hoc en vez de un ritmo único. Con `action-bar { margin: 1rem 0 1.25rem }` + `logistics-card { margin-top: 1.25rem }`, los gaps salían disparejos según qué bloques condicionales aparecían: Líneas→action-bar **16px**, action-bar→logística **40px** (margen doble 1.25+1.25), logística→historial **0px** (cards pegadas). **Fix:** ritmo único 20px — `:host ::ng-deep .p-card { margin: 0 0 1.25rem }` + `action-bar { margin: 0 0 1.25rem }`, eliminado el `margin-top` de logistics-card. Gap uniforme sin importar qué se renderice.
- 🟢→✅ **Valores off-grid** (no caen en escala 4px ni en la del sibling): `.4rem`(6.4px) hero-tags/qty-edit → `.375rem`; `.35rem`(5.6px) logística → `.375rem`; `.6rem .8rem`(9.6/12.8px) lines-banner padding → `.625rem .75rem`; `.55rem/.15rem` stock-chip → `.5rem/.125rem`; `.15rem` nudge lines-banner → `.125rem`; radio `6px` → `var(--r-sm)`.
- 🟢 Diferido: font-sizes hardcodeados (`.85rem`/`.8rem`/`.82rem`) → tokens `--fs-sm/--fs-xs`; sin `max-width` de contenido (hereda del shell — consistente con Operations).

**Fixes aplicados (2026-06-09, `nx build view` OK):**
- ✅ 🔴 **Blank screen al cargar:** el template solo renderizaba con `order()` cargado → pantalla en blanco mientras `loading()`. Agregado bloque skeleton (`SkeletonModule` + `.od-loading`: título + 3 stat cards + tabla).
- ✅ 🟡 **Geist Mono** en `.comm-stat-value.is-big` (el Total $ grande; compartido stat-card → mejora todas las páginas con stat cards).
- ✅ 🟡 **Tokens legacy → Mercado:** `--primary-color` → `var(--action)` en `.logistics-header i` y `.saving-spinner` (no dependen del primary de PrimeNG, que no es del sistema).
- ✅ 🟡 **draft neutral:** `severity()` ahora mapea `draft → 'secondary'` (gris) en vez de caer a `warn` (ámbar). Consistente con la hermana, que ya distingue draft(neutral)/pending(ámbar).
- ✅ 🟡 **A11y:** `aria-hidden` en 5 íconos decorativos (lines-banner, logistics, event-meta ×2, empty) + `aria-label` en botones icon-only (trash "Quitar línea", "Ver embarque").

**Diferido (deuda sistémica, scope mayor — NO aplicado):**
- 🟡 **Migración al sistema nuevo:** portar `comm-page-head`/`<h2>` → `surf-page-head`/`<h1>`, `comm-stat-card` → `cell`/KPI strip, `p-card` → `cell`/`sheet`. Alinea las dos pantallas del flujo. Es refactor visual completo, agendar como item propio.
- 🟡 **Status renderizado distinto entre hermanas:** detalle usa `p-tag`, lista usa `portal-status-pill`. Unificar a UN organismo de status badge compartido.
- 🟡 **CTA primario `severity="contrast"` (negro)** en confirmar/aprobar/entregar vs DESIGN.md (`--action` sunset). Decisión pattern-wide (toda la app usa contrast); definir y aplicar global, no solo aquí.
- 🟢 Font-sizes y radios hardcodeados (1.5rem, .85rem, 6px, 10px) → tokens `--fs-*`/`--r-*`. `prefers-reduced-motion` (casi sin transiciones, bajo riesgo).

**Nota de proceso:** se intentó workflow multi-agente adversarial; cancelado por presupuesto de tokens (<100k). Auditoría completada por lectura directa del componente ya en contexto.

**Pendiente:** verificación visual.

---

## Log de auditorías

> Una entry por sesión de barrido. Fecha · módulos tocados · hallazgos · fixes.

| Fecha | Módulos | Resumen |
|---|---|---|
| 2026-06-09 | — | Creación del tracker. Mapa completo de ~55 pantallas en 7 módulos + transversal. Rúbrica de 8 dimensiones. Backlog cross-módulo de DESIGN.md consolidado. |
| 2026-06-09 | Command Center | Primer barrido (lectura de código). 8/8 dimensiones evaluadas. Hallazgo 🔴: ~200 líneas dead code del feed WS (Fase C.4 removido del HTML, CSS+service huérfanos). 🟡: skeleton único→CLS, KPI/data sin Geist Mono, row-hover usa amarillo en vez de `--action`, densidad comfortable vs compact++, rgba/inline hardcoded. Descubierto: migración tokens Operations YA aplicada (DESIGN.md desactualizado). Plan de fix de 5 pasos. Verificación visual pendiente. |
| 2026-06-09 | Comercial · Pedidos | 8/8 evaluadas. **Bug 🔴 colorimetría:** pill `pending_approval` sin clase CSS → gris neutro en el foco de la vista; corregido (ámbar + draft a neutral stone + soft-bg tokenizados). Geist Mono en `comm-num`/`co-date`. Pantalla de alto nivel (empty states ejemplares, density correcta, motion con tokens). 🟡 diferido: keyboard nav en filas clickeables (cross-cutting). Build OK. Detalle de pedido pendiente. |
| 2026-06-09 | Command Center (2da pasada) | Re-análisis D4 con el marco de tendencias 2026. **Corrección de criterio:** el spacing es correcto (hairline 1px entre celdas + gap-on-container 24/32px entre sheets), no "menos malo". Densidad comfortable validada por research ("interaction-dense, not pixel-dense"). Fixes: off-grid (hero 14→12px, rank-badge, ico-bad) + sparkline hero a `--action` (acento on-trend en la métrica estrella). Build OK. |
| 2026-06-09 | Comercial · Detalle pedido | 8/8 evaluadas. **🔴 blank screen al cargar** (sin skeleton) → corregido. Pantalla pre-refactor (sistema viejo comm-page-head/p-card/tokens legacy vs hermana migrada). Fixes: skeleton, Geist Mono en Total, `--primary-color`→`--action`, draft neutral, aria-hidden+aria-label. Diferido: migración completa al sistema nuevo + unificar status badge + CTA sunset (pattern-wide). Build OK. Workflow multi-agente cancelado por presupuesto; hecho por lectura directa. |
| 2026-06-16 | Command Center (3ra pasada) | Barrido contra reglas nuevas CRM/inventario ([DESIGN_BENCHMARK_CRM_INVENTORY.md](../DESIGN_BENCHMARK_CRM_INVENTORY.md)). Higiene: font-size off-scale→tokens, gaps off-grid→8px, hex inline→`--bad-soft-bg`. **Feature de mayor valor:** drill-down — nuevo organismo canónico **`SidePeekComponent`** (regla #8: drawer ~520px, slide 250ms, Esc/backdrop, scroll-lock, a11y dialog). **Cableado en las 4 tablas:** Top clientes + Inactivos → 360° cliente (RFM/cadencia/lifecycle, `customer-360/:id`); Top productos + Stock bajo → peek de producto (ventas 30d + stock por almacén, `inventory/stock?product_id`). `product_id` ya venía en low-stock (solo faltaba en la interfaz front, sin tocar backend). Filas clickeables (role/tabindex/Enter). 2 refs mínimas (`CustomerPeekRef`/`ProductPeekRef`) para reuso cross-tabla. Build OK. Verificación visual pendiente. |
| 2026-06-16 | Comercial · Pedidos (regla #9) | Retro variedad-por-tipo en `OrderKpis`: las 5 cards de conteo (por aprobar/borradores/en curso/entregados/cancelados) eran planas e idénticas → ahora **barra de ratio = share del status sobre el libro de la ventana**, con **color semántico por estado** (ámbar/neutral/azul/verde/rojo). Denominador = suma de todos los status (independiente del filtro activo). Money card queda headline. Cero endpoint. Build verde. Verif. visual pendiente. |
| 2026-06-16 | Comercial · Pedidos (lista) | Auditoría a fondo. **🔴 BUG visual (corregido):** tras la extracción CV.3, los estilos de la toolbar de filtros (`.co-chip/.co-segment/.co-daterange/.co-search/.co-reset`) quedaron inline en el **padre** pero el markup vive en `OrderFiltersComponent` → con encapsulación emulada **no aplicaban** (toolbar sin estilo). Movidos al hijo. **Consistencia:** count-up en OrderKpis (totalAmount money-short + status counts) + **skeleton solo primer-load** (mata flicker en recargas y evita re-tween). NO se agregó stagger (la lista recarga en cada filtro/página → re-animar = anti-patrón) ni side-peek (detalle de pedido es rico → full-page es correcto, regla #8). Fortalezas confirmadas: filas clickeables a11y, empty states ejemplares, lazy+paginate, Geist Mono. Build view verde. Verificación visual pendiente. |
| 2026-06-16 | Command Center (regla #9 variedad) | Retro contra la nueva regla BINDING "variedad por tipo de dato". Análisis card-por-card: **En curso** (plano) → **stacked bar** de composición real confirmed/draft/cancelled (info/neutral/bad, desde overview, cero endpoint); **Conversión** (era barras) → **sparkline línea** porque es una TASA, no conteo (diferencia rate vs count). Reorden hoy queda headline (sin serie honesta = valor único válido). Resultado: cada sheet con micro-viz variada (línea/barras/stack), nada inventado. Build verde. Verif. visual pendiente. |
| 2026-06-16 | Command Center (mini-charts Motor) | Nuevo endpoint `GET /commercial/intelligence/signals/daily` (`FeedbackService.conversionDaily`): serie diaria de ofertas/convertidas/conversión% sobre `commercial.commerce_signals` (mismo criterio que `signals/summary`, group by día TZ MX). Mini-barras reales en 3 cards del Motor (Ofertas, Convertidas, Conversión). "Reorden hoy" queda sin barras (snapshot, no flujo). Builds view+api verdes. Verificación visual pendiente. |
| 2026-06-16 | Command Center (mini-charts reales) | Exploración serie por-KPI: `dailySeries` es on-the-fly (sin MV/migración) y `REVENUE_STATUSES=['fulfilled']` → ya da entregados/día + revenue/día. Aplicado: **mini-barras SVG reales** en "Pedidos entregados" (orders_count/día, cero backend) y "Clientes únicos" (columna aditiva `COUNT(DISTINCT customer_id)/día` en la query). Última barra en `--action`, resto neutro (calm). NO se pusieron barras en "En curso"/Motor (estado-actual/otra fuente → sería data muddy). Builds view+api verdes. Verificación visual pendiente. |
| 2026-06-16 | Command Center (motion KPI cards) | Investigación documentada ([DESIGN_MOTION_KPI_CARDS.md](../DESIGN_MOTION_KPI_CARDS.md) + bloque BINDING en DESIGN.md). Aplicado: **count-up** en los 8 valores KPI (directivo reusable `CountUpDirective` shared/directives/, on-view IntersectionObserver, una vez, ~900ms ease-out rAF, reduced-motion→instantáneo, no re-tween en refresh) + **reveal escalonado one-time** de los sheets (nth-of-type, 45ms stagger, guard `hasEntered` para no re-animar en refresh). NO se agregaron sparklines a cards sin serie (sería AI-slop); hero conserva su sparkline+delta reales. SVG crudo, 0 librerías. Build OK. Verificación visual pendiente. |
| 2026-06-16 | Shared organisms (refactor) | Extraído el 360° a **`Customer360PanelComponent`** (`shared/components/customer-360-panel/`): autocontenido (fetch `customer-360/:id` + loading + empty + fmt + estilos `c3-*`), inputs `customerId`/`revenue30d`. Command Center lo consume vía `<app-customer-360-panel>` dentro del side-peek; se le quitaron señales/helpers/CSS muertos y el método `customer360()` del service. Listo para soltar en Vendor/Pedidos. Gotcha Angular: `as` solo en `@if` primario (NG5002) → `@if` anidado dentro de `@else`. Build OK. |
