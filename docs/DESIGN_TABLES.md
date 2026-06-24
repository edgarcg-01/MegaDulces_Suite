# Tablas profesionales — guía del DS "Mercado" (Operations)

> Compañero de [`DESIGN.md`](../DESIGN.md). La tabla densa es el **organismo primario** de la superficie Operations
> (`/dashboard`, `/comercial`, `/logistica`, `/admin`, `/vendor`, `/televenta`). Este documento define cómo se
> construye una tabla bien hecha en este proyecto: investigado contra las design systems de referencia y aterrizado
> a nuestros tokens y clases reales (`surf-table`, `comm-num`, `comm-pill`, `p-table`).
>
> **Regla de oro (NN/g):** una tabla existe para que el usuario haga 4 cosas — **buscar, comparar, actuar y entender**.
> Cada decisión visual se justifica por una de esas tareas. Si no ayuda a ninguna, sobra.

---

## 0. Cómo lo hacen las grandes (síntesis de la investigación)

| Tema | Consenso de la industria | Fuente |
|---|---|---|
| **Alineación** | Texto a la **izquierda** (incl. su header). Números **variables** (precio, %, cantidad) a la **derecha** con su header. IDs/códigos discretos (folios, puerto, SKU) van a la izquierda. | Carbon, UX Movement |
| **Números** | Fuente **monoespaciada + `tabular-nums`** para que las columnas se alineen dígito a dígito y se puedan comparar de un vistazo. Misma cantidad de decimales por columna. | Carbon, NN/g |
| **Header** | Títulos de **1–2 palabras**, sticky al hacer scroll vertical. Header `600`/uppercase sutil, ~11–12px, muteado. | Carbon, NN/g |
| **Scanning** | Header congelado + **primera columna congelada** + **divisor inferior 1px fino** + hover-highlight = el ojo no pierde la fila. **SIN zebra** (directiva quiet-luxury 2026-06-23: el zebra striping se ve anticuado en una herramienta densa — Linear/Stripe/Vercel no lo usan). | Linear · Stripe · Vercel |
| **Densidad** | Filas compactas por defecto con **toggle de densidad** (cómoda ↔ compacta). Solo subir altura si hay 2 líneas reales por celda. | Carbon |
| **Selección masiva** | Checkbox por fila; al seleccionar ≥1, **sube una barra de acciones contextual** (no ocupa espacio si no hay selección). | Pencil&Paper, Stripe |
| **Edición** | **Inline edit** para cambios de 1 campo (typo, cantidad, status) — mantiene contexto. Modal solo para edición rica. | Linear, Pencil&Paper |
| **Frozen column** | En scroll horizontal, congelar la **columna identificadora** (nombre/ID) es tan importante como el header sticky. | Stephanie Walter |
| **A11y** | `<table>` semántico nativo > roles ARIA. `<th scope="col/row">`, `caption`/`aria-label`, `aria-sort` en columnas ordenables, anunciar cambios a SR, operables por teclado. | W3C ARIA APG, WCAG |
| **Referencias vivas** | **Linear** = denso pero calmo, teclado-first, inline edit instantáneo. **Stripe** = celdas de moneda/estado de referencia + filter-chips que dejan obvio el filtro activo. | Pencil&Paper |

Detalle de fuentes al final.

---

## 1. Anatomía de una tabla pro

```
┌─ TOOLBAR ────────────────────────────────────────────────┐
│  [search]   [filter-chips]   ·······   [densidad] [export]│   ← acciones de la vista
├─ BULK-BAR (oculta hasta seleccionar ≥1) ──────────────────┤
│  ☑ 3 seleccionados      [Acción A] [Acción B]   [✕]       │
├─ HEADER (sticky) ─────────────────────────────────────────┤
│ ☐ │ Producto ▲ │ SKU │ Marca │      Costo │  Disp. │  ···  │   ← th scope=col, sort+aria-sort
├─ BODY ────────────────────────────────────────────────────┤
│ ☐ │ Paleta…    │ A12 │ Vero  │     $12.50 │    240 │  ⋯    │   ← divisor fino + hover + row-click (sin zebra)
│ ☐ │ Bombón…    │ B07 │ Ricolino│   $ 8.00 │     12 │  ⋯    │
│   │ (skeleton shimmer mientras carga · empty-state si 0)   │
├─ FOOTER ──────────────────────────────────────────────────┤
│  1–25 de 11,398          ‹ 1 2 3 … ›        [25 ▾] por pág │   ← paginación server-side
└───────────────────────────────────────────────────────────┘
```

**Partes y su responsable:**
1. **Toolbar** — búsqueda (debounce 250ms), filtros (chips que muestran el filtro activo), densidad, export. Va en una `.sheet.cols-12 > .cell.is-flush` para coherencia con el resto.
2. **Bulk-bar** — solo aparece con ≥1 fila seleccionada. Cuenta + acciones + cerrar.
3. **Header** — sticky, `<th scope="col">`, sort con `aria-sort`, números alineados a la derecha.
4. **Body** — filas con divisor fino + hover, click→side-peek/detalle, inline-edit donde aplique (sin zebra).
5. **Footer** — rango + total + paginación + tamaño de página.

---

## 2. Reglas duras del DS Mercado para tablas

Estas son **vinculantes** (extienden las de `DESIGN.md §Operations`). En QA, marcar lo que no las cumpla.

### 2.1 Tipografía y alineación
- **Texto** (nombre, marca, status) → izquierda. Header de esas columnas → izquierda.
- **Números variables** (costo, disponible, %, total) → **derecha**, clase **`comm-num`** (Geist Mono + `tabular-nums`). Su `<th>` también a la derecha.
- **Códigos/IDs** (SKU, folio, ubicación) → izquierda, `comm-code` (mono, chip sutil). No son "números a comparar".
- **Decimales constantes por columna**: moneda siempre `1.2-2`, conteos `1.0-0`. Nunca mezclar dentro de una columna.
- **Header**: 1–2 palabras, sin frases. `Disp.` mejor que `Cantidad disponible` si el contexto lo permite.

> ⚠️ **Deuda actual:** conviven `comm-num` (comercial), `.num` (logística/command-center). **Canónico = `comm-num`.** `.num` queda como alias a deprecar.

### 2.2 Densidad
- Default **compacto** (`p-datatable-sm`, fila ~36–40px). Es Operations, no Storefront.
- Subir a 2 líneas por celda **solo** cuando hay metadato real (nombre + barcode, nombre + código). Patrón: `comm-cell-strong` + `comm-muted is-small`.
- (Backlog) **Toggle de densidad** cómoda/compacta a nivel de toolbar.

### 2.3 Scanning: bordes, sticky, frozen (SIN zebra)
- **Divisor inferior fino** (1px `--table-border`) en cada fila, no boxes pesados. Es lo que separa filas — basta para no perder el renglón (Linear/Stripe).
- **NADA de zebra striping** (directiva 2026-06-23). El modificador `surf-table--zebra` quedó **neutralizado (no-op)**; no re-introducir filas con bg intercalado.
- **Header sticky** obligatorio en tablas con scroll vertical.
- **Primera columna congelada** en grids anchas (scroll horizontal) — la columna identificadora (nombre/folio) siempre visible.
- **Hover** con tint (`--table-hover`) + **row-click** → side-peek/detalle (`comm-row-clickable` con `:focus-visible`).
- **Row-tint semántico** (border-left de color) para estado crítico de la fila (ej. stock 0 / vencido), NO bg de fila completa — patrón ya usado en inventory (`in-row-zero`).

### 2.4 Color y estado
- Estado → **`comm-pill`** con punto semántico (`is-active/is-warn/is-bad/is-neutral`). Nunca solo color (daltonismo): pill = color + texto + punto.
- 0 hex en componentes: todo vía tokens (`--ok-fg`, `--warn-fg`, `--bad-fg`, `--info-fg`, `--chart-*`). Letterbox de imágenes → `--neutral-900`, nunca `#000`.

### 2.5 Footer / paginación
- **Server-side** salvo datasets chicos garantizados (<200 filas). Default **25**, opciones **25/50/100/200**.
- Mostrar **rango + total** ("1–25 de 11,398"). Nunca tamaño de página fijo escondido (la deuda de `logistica-costs` con `[rows]="15"` fijo se corrige a las opciones estándar).

---

## 3. Estados (los 4 que toda tabla debe resolver)

| Estado | Qué mostrar | Patrón |
|---|---|---|
| **Cargando (1ª vez)** | **Shimmer** de filas (no spinner suelto), conserva el layout. | skeleton rows / `p-skeleton` |
| **Cargando (refresh)** | Mantener data previa + indicador sutil; **no** colapsar a skeleton. | `loading` sin borrar `rows()` |
| **Vacío — sin datos** | Icono + título + **copy accionable** (qué hacer para que haya datos). | `comm-empty` |
| **Vacío — sin resultados** | Distinto del anterior: "Sin resultados para «term»" + botón limpiar filtro. | `comm-empty` con branch por `search` |
| **Error** | Mensaje + reintentar. No dejar la tabla en blanco silencioso. | toast + estado inline |
| **Página fuera de rango** | Tras borrar/filtrar, si la página queda vacía → volver a pág. 1. | guard en `load()` |

> ⚠️ **Deuda actual:** cada módulo reimplementa el empty-state (`pp-empty`, `sh-empty`, `cc-table-empty`). **Unificar en un `comm-empty` global** (o `<app-empty-state>`).

---

## 4. Interacción

### 4.1 Orden (sort)
- Header ordenable = afinidad visual (flecha) + **`aria-sort="ascending|descending|none"`** + operable por teclado (Enter/Space).
- Con server-side: el `sortField`/`sortOrder` viaja al backend; anunciar el cambio.
- No todas las columnas ordenan: las de acción/visual no.

### 4.2 Filtros y búsqueda
- Búsqueda **debounced 250ms** (`makeDebouncedSearch`), en vivo, sin botón "buscar".
- **Filter-chips**: el filtro activo se ve y se quita con un click (modelo Stripe). Evitar selects mudos donde no se note que hay filtro puesto.
- Filtros = **signals** para que `computed()` reaccione (lección registrada: leer prop plana en un computed no reacciona).

### 4.3 Selección + acciones masivas
- Checkbox por fila + checkbox "todas". Al seleccionar ≥1 → **bulk-bar** con conteo + acciones + cerrar.
- La bulk-bar no ocupa espacio cuando no hay selección.

### 4.4 Inline edit
- Cambios de **1 campo** (cantidad, status, ubicación) → editable in situ: hover muestra que es editable, **Enter** confirma / **Esc** cancela.
- Modal solo para edición rica/multi-campo (ej. dialog de producto con form completo).

### 4.5 Row-click / drill-down
- Fila clickeable → **side-peek** (`SidePeekComponent`) o detalle. Acciones por fila como **ghost buttons** que aparecen al hover (`icon-btn-ghost-*`), con `stopPropagation`.

### 4.6 Export
- (Backlog) Export CSV de la vista filtrada para tablas analíticas. Útil, no obligatorio.

---

## 5. Accesibilidad (no negociable)

1. **HTML semántico**: `<table><thead><tbody>` reales (lo que da PrimeNG y las raw tables). Preferir nativo sobre roles ARIA.
2. **`<th scope="col">`** en todos los headers; `scope="row"` en la celda identificadora si aplica. (Las raw tables de command-center hoy **no** lo tienen → fix.)
3. **`caption` o `aria-label`** describiendo la tabla.
4. **`aria-sort`** en columnas ordenables; anunciar el cambio a lectores de pantalla.
5. **Foco visible** 2px ≥3:1 en fila clickeable y controles (`:focus-visible`).
6. **Teclado**: toda acción de mouse tiene equivalente (Enter en fila, Space en checkbox, flechas en grid si se vuelve grid editable).
7. **Touch targets** ≥44×44px en los botones de acción de fila (auditar los icon-buttons `sm`).
8. **Estado no solo por color**: el `comm-pill` lleva texto + punto, no solo tinte; añadir `aria-label` al punto si el texto no basta.

---

## 6. Responsive
- Default **`responsiveLayout="scroll"`** + **primera columna congelada** → en móvil/estrecho la columna identificadora no se pierde.
- Evaluar vista "card/stack" por fila solo en pantallas muy chicas si el scroll horizontal se vuelve ilegible (no obligatorio por spec).

---

## 7. Estado actual vs estándar (gaps priorizados)

De la auditoría (145 `p-table` en comercial/logística/dashboard + 4 raw tables en command-center). Fundamentos ya sanos: lazy-load server-side (`makeLazyLoad`), búsqueda debounced, `comm-num`/`comm-pill`/`comm-code`, hover + row-click, empty-states accionables.

| # | Gap | Prioridad | Regla |
|---|---|---|---|
| 1 | **Header no sticky** en ninguna tabla | 🔴 Alta | §2.3 |
| 2 | **Primera columna no congelada** en grids anchas | 🔴 Alta | §2.3 |
| 3 | **Sin sort visible + `aria-sort`** | 🔴 Alta | §4.1 / §5 |
| 4 | **Empty-state reimplementado** por módulo (`pp-/sh-/cc-`) | 🟡 Media | §3 |
| 5 | **`comm-num` vs `.num`** (dos clases para lo mismo) | 🟡 Media | §2.1 |
| 6 | **Sin selección + bulk-bar** | 🟡 Media | §4.3 |
| 7 | ~~Sin zebra~~ **resuelto al revés**: directiva quiet-luxury elimina el zebra; basta divisor fino + hover | ✅ | §2.3 |
| 8 | **Edición siempre por modal** (sin inline edit) | 🟢 Baja | §4.4 |
| 9 | **`logistica-costs` page-size fijo 15** | 🟢 Baja | §2.5 |
| 10 | **Raw tables sin `scope`/`caption`** (command-center) | 🟡 Media | §5 |
| 11 | **Skeleton global, no por fila** | 🟢 Baja | §3 |
| 12 | **`<input type=date>` crudo** en algunos filtros | 🟢 Baja | §4.2 |

---

## 8. Plan de adopción (incremental, sin big-bang)

La táctica: **subir el piso en CSS compartido una vez** (sticky + frozen + zebra + densidad como utilidades opt-in sobre `surf-table`), y luego ir aplicando por tabla — igual que venimos haciendo con `MetricCard`. No reescribir las 145 tablas de golpe.

**Fase T.1 — Fundamento CSS (1 pasada, alto impacto):**
- `surf-table` gana modificadores: `surf-table--sticky` (header sticky), `surf-table--frozen-first` (1ª col congelada), `surf-table--zebra` (zebra 5–10%), `surf-table--comfy/--compact` (densidad).
- Unificar `.num` → alias de `comm-num`.
- `comm-empty` global (extraer el patrón repetido) — o `<app-empty-state [icon] [title] [hint] [action]>`.

**Fase T.2 — Aplicar a las tablas de mayor tráfico** (products, orders, inventory, customers, shipments): activar sticky + frozen-first + zebra + sort donde el backend ya ordena.

**Fase T.3 — Patrones avanzados donde aporten:** selección + bulk-bar (ej. activar/desactivar productos en lote, cancelar pedidos), inline edit (cantidad/status), `scope`/`caption` en raw tables.

**Helpers que ya existen y se reusan:** `makeLazyLoad`, `makeDebouncedSearch` (`shared/util`), `PageTabsComponent`, `SidePeekComponent`. **Falta** un `<app-empty-state>` y (a evaluar) un wrapper `<app-table>` con schema de columnas — pero el wrapper es opcional: las utilidades CSS sobre `p-table`/`surf-table` cubren el 90% sin abstracción nueva.

### Estado de implementación

> **⚠️ Nota 2026-06-23 (directiva quiet-luxury Linear/Stripe/Vercel):** se **eliminó el zebra striping** de todo el sistema. `surf-table--zebra` quedó **neutralizado (no-op)** en `styles.css` + se borró el zebra global de dark-mode. Las entradas de abajo que dicen "zebra" son históricas: la clase sigue en el markup pero **no pinta nada** — la separación de filas la dan el divisor fino 1px + hover. No hace falta editar los ~40 archivos. La directiva completa quedó en [`DESIGN.md`](../DESIGN.md).

**T.1 — Fundamento CSS ✅ EN CÓDIGO 2026-06-23** (build verde). En `apps/view/src/styles.css` + tokens:
- `surf-table` (antes era un no-op: se usaba en componentes pero no estaba definido) ahora aporta **modificadores opt-in** que se aplican vía `styleClass` de PrimeNG:
  - `surf-table--sticky` → header sticky (top:0; el scroll vive en `<main>`, sin offset).
  - `surf-table--frozen-first` → 1ª columna congelada en scroll-x (bg opaco + zebra/hover override + sombra separadora).
  - `surf-table--zebra` → zebra sutil (token nuevo `--table-zebra`, light + dark).
  - `surf-table--compact` → densidad ~32px.
- `.num` (td/th) unificado como alias de `comm-num` (mono + tabular + derecha).
- **`comm-empty` global** (icon + h3 + p + `comm-empty-cell`) reemplaza los duplicados `pp-/sh-/cc-`.
- **Piloto:** `/comercial/products` ya usa `surf-table--sticky --frozen-first --zebra` + migró su empty-state a `comm-empty` (borrados los `.pp-empty*`). Referencia para la pasada T.2.

**T.2 — Aplicar/revisar por tabla** 🔨 en curso:
- ✅ `/comercial/products` (piloto + completado) — `surf-table--sticky --frozen-first --zebra` (Producto = col congelada) + `comm-empty`. Completado el checklist: `scope="col"` en los 9 `<th>` (acciones con `sr-only`) + fila clickeable ahora con `role=button`+`tabindex`+`aria-label`+**Enter/Space** (antes era mouse-only).
- ✅ `/dashboard/command-center` — 5 raw tables (`data-table`): ya tenían sticky + `.num` canónico + filas `role=button` con `aria-label`+enter. **Review a11y:** `scope="col"` en todos los `<th>` + `aria-label` por `<table>` + activación con **Space** (`preventDefault`) en filas clickeables. Foco visible ya existía; 0 hex. (Frozen/zebra N/A: son top-N cortas, no scrollean.)
- ✅ `/comercial/orders` — set completo: `surf-table--sticky --frozen-first --zebra` (folio = col congelada) + `scope="col"` + **Space** en fila + empty-state → `comm-empty` (borrados `.co-empty*`) + **page-size 15→25 con opciones 25/50/100/200** (§2.5). Filtros ya en PrimeNG DatePicker (no input crudo). 0 hex.
- ✅ `/comercial/customers` — set completo: `surf-table--sticky --frozen-first --zebra` (Código = col congelada) + `scope="col"` (col de acciones con `<span class="sr-only">Acciones</span>`) + **Space** en fila (side-peek 360°) + empty-state → `comm-empty` (borrados `.cu-empty*`) + **page-size 10→25 con opciones**. **Nueva utilidad global `.sr-only`** (visually-hidden) para captions/headers de acción. 0 hex.
- ✅ `/comercial/cartera` — master-detail (2 p-table en paneles, `scrollable`→PrimeNG ya da sticky). Review proporcional: `scope="col"` en ambas (headers de acción/# con `sr-only`), numérico "Clientes" `.ca-num`→**`comm-num`** (mono+tabular), zebra en la lista de orden de visita (puede ser larga), hex de fallback `#c0392b`→`var(--bad-fg)`. Sin frozen (tablas angostas) ni paginación (config tool, scroll 60vh).
- ✅ `/comercial/inventory` (Existencias) — KPIs ya en bento (J16). Tabla (10 cols): `surf-table--sticky --frozen-first --zebra` (Almacén = col congelada; convive con el row-tint left-border de stock crítico/cero) + `scope="col"` (acciones con `sr-only`) + empty-state → `comm-empty` (borrados `.in-empty*`) + **page-size 20→25 con opciones**. Filas no clickeables (solo botón ajustar) → sin Space. 0 hex.
- ✅ `/comercial/warehouses` — tabla chica (no lazy/no paginada, pocos almacenes). Por consistencia de sección: `surf-table--sticky --frozen-first --zebra` (Código congelado) + `scope="col"` (acciones con `sr-only`) + empty-state → `comm-empty` (borrados `.wh-empty*`). Sin paginación (dataset garantizado pequeño, §2.5). 0 hex.
- ✅ `/comercial/pricing` — master-detail. **Master** (listas, corta, con stripe de selección): `surf-table--sticky` + `scope` + fila clickeable ahora con teclado (Enter/Space, role/aria-label) — **sin** frozen/zebra para no chocar con el `.pr-selected` stripe. **Detail** (precios, lazy/paginada, ~6500 SKUs): set completo `--sticky --frozen-first --zebra` (Producto congelado) + `scope`. Ambos empties → `comm-empty` (borrados `.pr-empty*`, conservado `.pr-empty-cmd`). 0 hex.
- ✅ `/comercial/promotions` — tabla lazy/paginada (8 cols, filas no clickeables: switch+botones). Set completo `--sticky --frozen-first --zebra` (Código congelado) + **agregado `responsiveLayout="scroll"`** (faltaba, necesario para frozen) + `scope` (acciones `sr-only`) + page-size 20→25 con opciones + empty → `comm-empty`. **Cleanup:** borrado CSS huérfano del wizard (`.type-*/.step-*/.tiers-*/.promo-banner-preview`, ~120 líneas — markup vive en `app-promotion-form-dialog`), lo que eliminó el único `#fff`. 0 hex.
- ✅ `/comercial/route-tickets` — KPIs ya en MetricCard. Tabla (no paginada, carga ≤100): set completo `--sticky --frozen-first --zebra` + `responsiveLayout="scroll"` + `scope` + **paginación cliente** (`[paginator]` si >25, rows 25, opciones 25/50/100 — la data ya está cargada, sin lazy) + empty inline (1 línea) → **`comm-empty`** (icon+título+mensaje). Unificado: `.num` local borrado (lo cubre el global `td.num` mono+tabular); `.empty` local borrado. 0 hex.
- ✅ `/comercial/vendor-sales` — KPIs ya en bento (sparkline). **Principal** (captures): set completo `--sticky --frozen-first --zebra` + `responsiveLayout="scroll"` + paginación cliente con opciones + `scope` + **fila clickeable → ticket** (role/aria-label/Enter/Space; botón "Ver ticket" con `stopPropagation`) + empty → `comm-empty`. **Detalle** (líneas en dialog): `scope` + zebra (`scrollable`→sticky de PrimeNG), empty queda inline (apropiado en dialog 320px). `.num` local borrado (global `td.num`). 0 hex.

**Batch (7 archivos / ~11 tablas, en paralelo) ✅ 2026-06-23:**
- ✅ `/comercial/dead-stock` — tabla `[scrollable]` → zebra + scope(8) + empty→`comm-empty` + page-size 50→25 con opciones + hex fallbacks (`#dc2626`→`--bad-fg`, etc.) → tokens.
- ✅ `inventory-expiring` (tab Por vencer) — `[scrollable]` → zebra + scope(8) + `.ex-num`→`.num` + empty inline→`comm-empty` + page-size 50→25.
- ✅ `inventory-abc` (tab Cíclico) — 2 tablas `[scrollable]` → zebra + scope(7 c/u) + page-size 50→25 + ambos empties→`comm-empty`. Bento/distribución intactos.
- ✅ `inventory-sessions` (tab Folios) — `[scrollable]` → zebra + scope(6, acciones `sr-only`) + **fila clickeable→folio** (routerLink movido a la fila + Enter/Space + `goToFolio`) + empty→`comm-empty`.
- ✅ `inventory-session-detail` — jornadas (sticky+zebra+`responsiveLayout`) + items (`[scrollable]`→zebra) + scope en ambas + `.num` global.
- ✅ `inventory-ira` — 2 tablas: by_reason (sticky+zebra) + recent_folios (sticky+frozen+zebra) + `responsiveLayout` + scope + `.in-num`→`.num`. KPIs gauge intactos. Empties son `<p>` fuera de tabla (tokens, sin cambio).
- ✅ `order-detail` — order LINES (sticky+frozen+zebra, Producto congelado) + tabla embebida shipments (sticky+zebra, **fila clickeable→embarque**) + scope + empty full-page→`comm-empty`. Timeline de status (p-timeline) intacto.

**Sección `/logistica` ✅ 2026-06-23 (12 archivos / ~26 tablas, 2 oleadas paralelas):**
- ✅ `shipments` (lista wide sticky+frozen+zebra, fila→detalle con teclado; pendientes narrow) · `shipment-detail` (stops/items/cartaporte/recipients) · `costs` (**fix page-size 15→25**, 14 cols, folio frozen) · `guides` (**15→25**) · `staff` (drivers, name frozen; avatar `#fff` intencional) · `driver-assignments` (**page-size 10→25**, fila→embarque con teclado).
- ✅ `fleet` (6 tablas: vehicles/drivers/usage/fuel-eff/fuel-tx/maintenance — fuel-eff con row-stripe → solo sticky; fuel-tx **page-size→25**) · `dashboard` (3 listas embebidas sticky+zebra, empties inline) · `payroll` (periods con `pSelectableRow`→solo sticky; liquidations money frozen+zebra; adjustments in-dialog) · `reports` (por-embarque **15→25** + por-unidad, jsPDF RGB intacto) · `config` (comisiones **15→25** + finance) · `shipment-form-dialog` (per-diem es `<table>` plano → solo `scope`).
- Criterio uniforme: `[scrollable]`/`pSelectableRow`/selected-row-stripe → solo sticky o zebra (sin frozen); tablas money → `comm-num`; empties bespoke → `comm-empty` (inline de 1 línea en panels/dialogs se conservan); KPIs/MetricCards/charts/PDF/forms intactos. Builds verdes, sin hex bare (salvo `#fff` de avatar, intencional).

**T.3** ⬜ pendiente.

> **QA visual pendiente** del piloto (sticky/frozen/zebra en claro+oscuro) — no automatizable desde CLI.

---

## 9. Checklist "tabla pro" (criterio de done por tabla)

- [ ] Header **sticky** + `<th scope="col">`.
- [ ] **1ª columna congelada** si la tabla scrollea horizontal.
- [ ] Números en **`comm-num`** (mono + tabular + decimales constantes); texto a la izquierda.
- [ ] **Divisor inferior fino + hover** (NO zebra — directiva quiet-luxury).
- [ ] **Sort** con flecha + `aria-sort` en columnas ordenables.
- [ ] **Search** debounced + filtros como **signals** + chip de filtro activo.
- [ ] Estados: **shimmer** al cargar · **empty distinto** (sin-datos vs sin-resultados) · error con reintento.
- [ ] Refresh **no** borra la data previa (no parpadea a skeleton).
- [ ] Row-click → side-peek/detalle; acciones de fila como **ghost** al hover con `stopPropagation`.
- [ ] **Paginación** server-side 25/50/100/200 + rango + total.
- [ ] **0 hex** (tokens) · estado con pill (color + texto + punto) · foco visible · touch ≥44px.
- [ ] Verificado en **dark mode**.

---

## Fuentes

- [Data table — Carbon Design System (usage)](https://carbondesignsystem.com/components/data-table/usage/) · [(style)](https://carbondesignsystem.com/components/data-table/style/)
- [Data Tables: Four Major User Tasks — Nielsen Norman Group](https://www.nngroup.com/articles/data-tables/)
- [Mobile Tables — Nielsen Norman Group](https://www.nngroup.com/articles/mobile-tables/)
- [Table Pattern & Example — W3C ARIA Authoring Practices Guide](https://www.w3.org/WAI/ARIA/apg/patterns/table/)
- [Tables Tutorial — W3C Web Accessibility Initiative](https://www.w3.org/WAI/tutorials/tables/)
- [Data Table Design UX Patterns & Best Practices — Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables)
- [Essential resources to design complex data tables — Stéphanie Walter](https://stephaniewalter.design/blog/essential-resources-design-complex-data-tables/)
- [9 Design Techniques for User-Friendly Tables — UX Movement](https://uxmovement.com/content/9-design-techniques-for-user-friendly-tables/)
