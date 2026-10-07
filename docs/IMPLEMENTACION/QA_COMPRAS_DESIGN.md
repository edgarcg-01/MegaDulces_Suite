# QA DESIGN.md — Módulo `/compras/*` (Compras / Reabastecimiento, Fase RA)

> Revisión pantalla-por-pantalla contra las 14 reglas del [checklist pre-vuelo de DESIGN.md](../../DESIGN.md#️-checklist-pre-vuelo-leer-antes-de-tocar-frontend).
> Las 14 en CADA pantalla, cierre con grep (0 hex crudo, 0 controles no-PrimeNG). Ver [`QA_TIENDA_DESIGN.md`](QA_TIENDA_DESIGN.md) (mismo método).

## Surface + sector
- **Surface:** Operations (sin Fraunces/Poppins display, quiet-luxury, dark first-class).
- **Sector §14:** **Almacén/Compras** → full-width grid + primera columna congelada en grids anchas + frescura prominente + tablas densas paginadas. Motor decide / humano aprueba (HITL, ADR-030).

## Inventario (9 pantallas + service)

| Ruta | Componente | Estado |
|---|---|---|
| `/compras/existencia-critica` | `compras-existencia-critica` (flagship) | ✅ fixes aplicados |
| `/compras/que-toca` | `compras-que-toca` | ✅ fixes aplicados |
| `/compras/requisiciones` | `compras-requisiciones` | ✅ §6 |
| `/compras/requisiciones/:id` | `compras-requisicion-detalle` | ✅ ya cumplía |
| `/compras/ordenes` | `compras-ordenes` | ✅ §6 |
| `/compras/ordenes/:id` | `compras-orden-detalle` | ✅ token |
| `/compras/hallazgos` | `compras-hallazgos` | ✅ ya cumplía |
| `/compras/proveedores` | `compras-proveedores` | ✅ fixes aplicados |
| `/compras/red` | `compras-red` | ✅ ya cumplía |

## Cambios aplicados

**existencia-critica** (flagship):
- **§3**: `.p-input-icon-left` (removido en PrimeNG 18 → el ícono no renderiza) → `p-iconfield` + `p-inputicon`; clear del search → `p-inputicon` clickeable.
- **§3**: 2 `<input type="checkbox">` raw → `p-checkbox [binary]`.
- **§7**: tabla de 18 columnas → **primera columna (checkbox + SKU) congelada** (`pFrozenColumn`).
- **§13**: botón "Crear requisición" `[disabled]="saving()"` (síncrono) + guard re-entry en `create()`.
- **§14**: `app-freshness-pill` en el header (frescura prominente, sector Almacén).

**que-toca**:
- **§7b/ADR-033**: 4 stat-cards custom `.qt-kpi` → `MetricStrip` (el filtro "Vencidos" ya existe redundante en el select de estado).
- **control-flow**: `*ngFor`/`*ngIf` → `@for`/`@if`.
- **§2**: hex fallback `var(--action, #b45309)` → `var(--action)`.
- **§14**: `app-freshness-pill`.

**requisiciones · ordenes**:
- **§6**: el handler de error tragaba el fallo (`error: () => loading.set(false)`) → mostraba "empty". Ahora `error` signal + empty-message **error-aware con Reintentar** (empty ≠ error de red).

**orden-detalle**: token no-canónico `var(--good-fg, …)` → `var(--ok-fg)` (§5, memoria de tokens canónicos).

**proveedores**: `.p-input-icon-left` (deprecado, sin ícono) + botón búsqueda redundante → `p-iconfield` con lupa; check de guardado `--action` → `--ok-fg`.

**requisicion-detalle · hallazgos · red**: ya cumplían las 14 (p-table, p-select, p-tag, MetricStrip, tokens, tabular-nums, mono, empty states, error via toast; botones que mutan usan `[loading]` que en PrimeNG **deshabilita** el botón → anti doble-click §13).

## Matriz de seguimiento

| Regla | exist-crit | que-toca | requis | req-det | ordenes | ord-det | hallazgos | proveed | red |
|---|---|---|---|---|---|---|---|---|---|
| 1 Surface | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 Cero hex | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 PrimeNG-first | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 Tipografía/tabular | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 Color/p-tag | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 6 Estados (empty≠error) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 7 Datos densos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 7b Cards repertorio | ✅ | ✅ | ➖ | ✅ | ➖ | ✅ | ➖ | ➖ | ✅ |
| 8 Motion techo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 9 libs/@container | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| 10 Dominio+seguridad | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 11 a11y AA | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 12 Build+QA 3 vistas | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 |
| 12b Dark | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 | 🔨 |
| 13 Resiliente | ✅ | ➖ | ➖ | ✅ | ➖ | ✅ | ✅ | ✅ | ✅ |
| 14 Sector+help | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`🔨` en 12/12b: **build prod verde**; falta **QA visual light+dark+móvil** (Edgar). Casos extremos: la columna congelada (checkbox+SKU) en la tabla ancha de existencia-critica en ambos temas + móvil; el clear del search (p-inputicon clickeable); MetricStrip de que-toca.

## Verificación grep (al cierre)
- [x] `#[0-9a-fA-F]{3,6}` en `apps/view/src/app/modules/compras` → **0**.
- [x] `type="checkbox" | p-input-icon | <table | <textarea` (raw) → **0**.
- [x] Resto de `<input>`/`<button>` = `pInputText`/`pButton` (directivas PrimeNG).
- [x] `nx build view --skip-nx-cache` — **verde (EXIT=0)**.
- [ ] QA visual light + dark + móvil (Edgar).

## Pendiente / seguimiento
- **que-toca** fue expandido en paralelo (otro hilo) a cockpit RA-PRO.8/9 con **drill-down**; ese drill-down introdujo un **`<table class="qt-det-table">` raw** (§3) que NO es de esta pasada — dejarlo a ese hilo o convertir a `p-table` anidada en una siguiente iteración.
