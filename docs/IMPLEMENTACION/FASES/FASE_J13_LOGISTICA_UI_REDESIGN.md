# Fase J13 — Rediseño UI de Logística (PrimeNG + Tailwind, surface Operations)

> Objetivo: rediseñar **las ~15 pantallas de `/logistica`** elevando la calidad visual y la
> consistencia, con el **mismo stack** (PrimeNG + Tailwind) pero **mejor**. No se inventa un
> sistema nuevo: se **aplica con disciplina** el design system **Operations** que ya existe en
> `DESIGN.md` + `apps/view/src/styles/tokens.css`, se cierra la deuda de estilos y se eleva con
> los organismos compartidos. Stitch ("Commercial Operations" DS) como acelerador de mockups.

## Punto de partida (lo que YA tenemos — reusar, no recrear)
- **Tokens Operations aplicados** en `tokens.css` (Hanken Grotesk + Geist Mono, Stone, sunset acción, IA ember, dark zinc `#111`, radios `--r-*`, densidades `--row-h-sm/md/lg`).
- **Spec canónica** en `DESIGN.md` → sección "Mercado / Operations" (type scale, **tabla densa** `p-datatable-sm` row 40px sticky header + 1ª col pegada, page-head, filter bar, KPIs, status pills) + **10 reglas** destiladas en `docs/DESIGN_BENCHMARK_CRM_INVENTORY.md`.
- **Organismos compartidos** en `apps/view/src/app/shared/components/`: `side-peek`, `customer-360-panel`, `page-tabs`, `map`, `offline-status`, `ui/`.
- **Pantallas vivas** (15): dashboard · shipments · shipment-detail · guides · costs · reports · fleet · staff · payroll · config · my-assignments · live · planner + componentes `shipment-form-dialog`, `delivery-wizard` + checklist/photos.

## Deuda detectada (a cerrar en el rediseño)
- **Hex crudos** en ~10 archivos de logística (reports 6, fleet 4, planner 4, costs/guides/payroll/dialog 3…) → deben ser tokens. (Codemod previo quedó incompleto — memoria.)
- Estilos `shd-*`/inline duplicados por pantalla en vez de organismos compartidos.
- PrimeNG con overrides ad-hoc en vez de un **preset** alineado a tokens.

---

## Principios del rediseño (el "mejorándolo")
1. **Tokens o nada:** cero hex/valores mágicos; todo vía `var(--token)` o utility de Tailwind mapeada al token.
2. **Organismos compartidos > estilos por pantalla:** una sola implementación de page-head, filter-bar, tabla densa, KPI card, status pill, empty state, side-peek.
3. **PrimeNG temizado, no parcheado:** un preset (`definePreset`) que mapea PrimeNG a los tokens; quitar overrides sueltos.
4. **Densidad Operations (compact++):** tabla 40px (`--row-h-md`), header sticky, 1ª columna pegada, sort visible, paginación abajo, números tabulares.
5. **Master-detail canónico:** lista densa → `side-peek` para el detalle (regla DESIGN.md #8), sin perder el contexto.
6. **A11y + responsive de fábrica:** focus visible, `prefers-reduced-motion`, contraste APCA, touch targets 44px en mobile, scroll horizontal contenido.

---

## Plan por fases

### Fase 0 — Fundación compartida (antes de tocar pantallas)
- **F0.1 Preset PrimeNG ↔ tokens:** un `definePreset` que mapea primary/surface/text/borders a `--c-*`/`--action`/`--ember`. Verificar que no rompe otras surfaces (scope o tokens compartidos).
- **F0.2 Tailwind theme.extend:** exponer tokens semánticos (colors, `--r-*`, `--row-h-*`, spacing) como utilities → permite borrar hex.
- **F0.3 Codemod hex→token** en los ~10 archivos de logística (dry-run + revisión, por el incidente previo de estilos extraídos).
- **F0.4 Organismos faltantes** en `shared/components/ui/`: `PageHead`, `FilterBar`, `DataTable` (wrapper denso con las reglas), `KpiCard`, `StatusPill`, `EmptyState`. (side-peek/page-tabs/customer-360/map ya existen.)
- **Done F0:** build verde + una pantalla piloto migrada a los organismos sin regresión.

### Fase 1 — Auditoría visual por pantalla (design-review)
- 1 línea por pantalla (skill `design-review`): organismo que usa hoy, deuda (hex/inline), gaps vs DESIGN.md Operations + 10 reglas. Registro terso en `DESIGN_QA_MODULOS.md`.

### Fase 2 — Rediseño por arquetipo (reusa organismos de F0)
- **A · Listas master-detail** (shipments, guides, fleet, staff, payroll, config): FilterBar + DataTable densa + StatusPill + EmptyState + **side-peek** para el detalle. **Mayor volumen.**
- **B · Dashboards / analytics** (dashboard, costs, reports): KpiCard grid + charts PrimeNG + tablas densas; el **ROI** y el **semáforo** entran como cards canónicas.
- **C · Detalle de embarque** (shipment-detail): `page-tabs` + readiness card + cada tab con organismos (guías=tabla, costos=form-grid, carta porte=panel validate).
- **D · Mobile chofer** (my-assignments, delivery-wizard): mobile-first, tab bar, touch targets, skeletons, GPS/Wake Lock ya integrados.
- **E · Mapa** (live, planner): organismo `map` + panel lateral (lista de unidades / paradas con secuencia).

### Fase 3 — QA visual + a11y
- `design-review` por pantalla: contraste APCA, focus, motion-safe, responsive, densidad consistente (nunca 2 densidades en un card). Builds verdes.

---

## Stitch como acelerador (opcional pero recomendado)
- Por cada arquetipo (A–E), generar **1 mockup** con `generate_screen_from_text` aplicando el DS **"Commercial Operations"** (proyecto `3444172923552984488`) → fija el target visual antes de codear; `generate_variants` para comparar.
- Mantener `DESIGN.md` ↔ Stitch sincronizados (`upload_design_md` / `create_design_system_from_design_md`) para que los mockups salgan ya con nuestros tokens.

## Orden de ejecución (por valor/uso)
1. **shipments + shipment-detail** (núcleo operativo) → valida F0 a fondo.
2. dashboard + reports (lo que mira el jefe).
3. fleet + staff.
4. guides + costs + payroll + config.
5. live + planner (mapa).
6. my-assignments + delivery-wizard (mobile).

## Criterios de "done" por pantalla
- 0 hex (solo tokens) · organismos compartidos (no estilos ad-hoc) · tabla con reglas Operations · status pills + empty states canónicos · responsive + a11y · **funcionalidad intacta** · `nx build view` verde · QA visual OK.

## Riesgos
- **PrimeNG global:** el preset afecta todas las surfaces → migrar con cuidado, validar comercial/admin/portal no regresan.
- **Codemod hex:** encapsulación emulada — al extraer markup a organismos, mover sus estilos no-globales al hijo (incidente conocido).
- **No romper lógica:** el rediseño es visual; respetar signals/flows existentes (readiness, máquina de estados, autorelleno).

## Estado

### Mockups (objetivo visual) ✅ 2026-06-22
- DS de Stitch "Commercial Operations" re-alineado a tokens reales (Stone + sunset `#F05A28`, Hanken/Geist). 4 mockups generados + galería artifact: Dashboard, Flota en vivo, Planeador, App chofer. (A lista master-detail + C detalle con tabs dieron timeout en Stitch — el lenguaje queda fijado por estos 4 + DESIGN.md.)

### F0.1 — Preset PrimeNG ✅ 2026-06-22
- `apps/view/src/app/core/theme/operations-preset.ts`: `definePreset(Aura)` mapea `primary → sunset` (rampa naranja centrada en `--action`) + `surface (light) → Stone` + focusRing/highlight sunset. Wireado en `app.config.ts`. **Mata el azul/esmeralda de Aura** en botones/selects/paginador/datepicker/checkbox de las 15 pantallas de golpe. Build view verde.

### Hallazgo: organismos ya existen como CSS
- `styles.css` ya tiene el sistema Operations maduro: `surf-page-head`, `sheet/cell` (KPI grid), `data-table`, `comm-pill`/`portal-status-pill`, empty states, ghost buttons, chips, type-scale `--fs-*`. **No se crean organismos Angular redundantes** (revisión del plan F0.4): se aplican estas clases con disciplina + se cierra deuda de hex.

### Piloto shipments (lista) ✅ código 2026-06-22
- Backend: `GET /logistics/shipments/counts` (1 query `GROUP BY status`, sin N+1, patrón `/orders/counts`). Service `counts()` + controller (route antes de `:id`). Frontend `shipmentCounts()` + interface `ShipmentCounts`.
- UI: **tira de status-chips** con conteo por estado (filtro 1-click) reemplaza el dropdown único — matchea el mockup. KPI strip ahora se alimenta del mismo `counts` (1 request en vez de 4 forkJoin). Build api + view verdes.

### Piloto shipment-detail (detalle, arquetipo C) ✅ código 2026-06-22
- **Barra de transiciones de estado** en el head (Marcar en ruta / Marcar entregado / Cerrar / Cancelar) — antes el detalle NO tenía los botones del state-machine (gap funcional). Mismas reglas que la lista, con `refreshReadiness` post-transición.
- **Readiness con % + barra de progreso** (`readinessPct` = checks ok / total) — matchea el ring 87% del mockup.
- **Hex cleanup**: readiness pill/checks (`#fdf6e3`/`#8a6420`/`#2e7d32`/`#d2851b`…) + cp-gaps + cp-ready → tokens semánticos (`--warn-soft-*`, `--ok-*`). Separador `shd-head-sep` entre transiciones y acciones secundarias.

### dashboard + reports (arquetipo B) ✅ código 2026-06-22
- **dashboard**: migrado del patrón viejo (`.kpi-card`/`p-card`/shimmer local/tokens `--surface-*`) a los organismos canónicos — `surf-page` + `surf-grid`/`metric-tile` (KPIs con stripe semántico is-ok/is-bad en margen) + `surf-panel` (pipeline + 2 tablas) + `comm-num`/`comm-code`/`comm-pill`. Shimmer duplicado → `p-skeleton`. 2 hex → 0.
- **reports**: 4 tabs (Overview/Embarque/Unidad/ROI) migrados — KPIs `p-card` → `metric-tile`, detail `p-card` → `surf-panel` con `rep-row`, tablas en `surf-panel` flush, badges → `comm-pill`. Header de los PDF (jsPDF) `[245,166,35]` ámbar → `[240,90,40]` sunset (consistencia de marca en export). 6 hex → 0.
- Imports limpiados (CardModule/TagModule fuera). Build view verde.

### fleet + staff ✅ código 2026-06-22
- **fleet**: `surf-page` + `surf-page-head` (mata el `<h2 class="page-title">` suelto) + tokenización completa de estilos (maint-due → warn tokens, fuel-flag → bad-soft, form em → bad-fg, code/num → mono+tokens). p-card/p-tag conservados (el preset ya los pinta Stone+sunset). 4 hex → 0.
- **staff**: KPIs `.kpi-card` → `metric-tile` (is-ok/is-warn), filtros+tabla `p-card` → `surf-panel` flush, wrap `surf-page`, avatares migrados a paleta canónica `var(--avatar-1..8)` (adapta a dark + AA). 2 hex → 1 (solo `#fff` del texto de avatar, blanco legítimo).
- Imports CardModule fuera en ambos. Build view verde.

### guides + costs + payroll + config ✅ código 2026-06-22
- **guides**: KPIs `.kpi-card` (hex `#0ea5e9/#eab308/#f5a623`) → `metric-tile` (is-info/is-warn/is-brand/is-ok); filtros+tabla `p-card` → `surf-panel` flush; wrap `surf-page`; `comm-code`, currency pipe, `.link` → `--action`. 3 hex → 0.
- **costs**: KPIs → `metric-tile` (is-brand total); `p-card` → `surf-panel` flush; columnas a currency pipe + `comm-code`; total strong → `--c-text-1`. 3 hex → 0.
- **payroll**: master-detail (períodos→liquidaciones) 2 `p-card` → `surf-panel` con head; tokenización (form em → bad-fg, pos/neg → ok/bad, info/adj-summary → c-surface-2); wrap `surf-page`. 3 hex → 0.
- **config**: 5 tabs, `p-card` → `surf-panel` flush; tokens legacy (`--surface-100`/`--text-color-secondary`) → `--c-*`; code mono. 0 hex (ya estaba) + ahora consistente.
- CardModule fuera en las 4. Build view verde.

### live + planner (arquetipo E, mapa) ✅ código 2026-06-22
- Ya usaban el sistema canónico (surf-page, sheet/cell, app-map, `--c-*`, `--action`). Limpieza de hex: live (dot verde `#2e7d32`/rgba → `--ok-fg`/`--ok-soft-bg`, fallbacks de var quitados) 3→0; planner (pill-ok `#dce5dd/#3f5e4e` → ok tokens, pl-seq `#d2521b/#fff` → `--action`/`--action-ink`, `--mono` roto → `--font-mono`) 4→0 en CSS. El color del marcador "entregado" del mapa queda `#16A34A` (literal de dato para Leaflet, no admite CSS var — documentado).

### delivery-wizard + shipment-form-dialog ✅ código 2026-06-22
- **delivery-wizard**: tokenización completa (step-num done `#16a34a` → `--ok-fg`, `--surface-*`/`--primary-color`/`--red-500` → `--c-*`/`--action`/`--bad-fg`). 1 hex → solo `#fff` (texto blanco sobre badge verde).
- **shipment-form-dialog**: link-banner (`#166534`) + margin-summary (`#16a34a`/`#dc2626`) → ok/bad tokens; `--surface-*`/`--text-color*`/`--primary-color` → `--c-*`/`--action`; code mono. 3 hex → 0.
- **driver-assignments** ("Mis entregas", mobile): ya canónico (surf-page + sheet/cell, 0 hex) — sin cambios.

### 🟢 Barrido del módulo COMPLETO
- **Las ~15 pantallas de /logistica** sobre el sistema Operations canónico (surf-page/head, surf-grid/metric-tile, surf-panel, comm-*, tokens `--c-*`/`--action`) + preset PrimeNG sunset.
- **Hex restante en todo el módulo: 4, todos legítimos** — `#fff` (texto blanco ×2), `var(--action-ink,#fff)` (fallback), `#16A34A` (color de dato Leaflet). Cero deuda de tema.
- Builds api + view verdes en cada paso.

### F1 + F3 auditoría estática ✅ 2026-06-22
- Registro 8-dimensiones por pantalla en [`DESIGN_QA_MODULOS.md`](../DESIGN_QA_MODULOS.md) (sección Logística): 11 pantallas 🔍 (auditadas por código), checklist/photos ⬜ (fuera de J13).
- Fixes de a11y aplicados: `:focus-visible` en tabs segmentadas (`.sh-mode-tab`/`.shd-mode-tab`, ya estaba en `.sh-chip`) + header expandible del form-dialog operable por teclado (role/tabindex/keydown.enter/space + focus-visible). Build verde.
- D4 (spacing off-grid) queda 🟡 transversal = deuda heredada de primitivas compartidas, no se ataca por-pantalla. D7 fleet 🟡 = conserva p-card (aceptable).

### Pendiente (no-código)
- **Verificación visual en browser** (las 13 pantallas + dark mode) para pasar 🔍→✅ — no automatizable desde CLI. Smoke del endpoint `/shipments/counts` con API arriba.
