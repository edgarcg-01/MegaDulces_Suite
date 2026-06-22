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

### Deuda hex restante (F0.3 / F2) — 34 ocurrencias en 11 archivos
- reports 6 · fleet 4 · planner 4 · live 3 · costs 3 · guides 3 · payroll 3 · staff 2 · dashboard 2 · shipment-form-dialog 3 · delivery-wizard 1. Se limpian en el barrido por pantalla (F2). El piloto (shipments lista+detalle) queda en 0 hex de deuda.

### Pendiente piloto
- QA visual con API arriba + smoke del endpoint `/shipments/counts`.

### Próximo
- Seguir orden de ejecución: dashboard + reports → fleet/staff → guides/costs/payroll/config → live/planner → mobile.
