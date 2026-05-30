# /comercial — Design System actual

Módulo admin B2B para operación comercial: clientes, pedidos, inventario, almacenes, listas de precios, promociones. Shell compartido con admin general (`LayoutComponent`), diferenciado de `/portal/*` (customer-facing).

**Filosofía**: layout denso, table-heavy, form-heavy. Optimizado para gerente/vendedor que opera 8h/día. Prioriza información sobre estética.

---

## 1. Estructura de rutas

```
/comercial
├── command-center          → dashboard analytics (módulo dashboard)
├── customers               → CRUD clientes B2B + linkeo a tiendas/rutas
├── orders                  → lista de pedidos
├── orders/:id              → detalle pedido + timeline + transiciones
├── inventory               → stock por almacén
├── warehouses              → CRUD almacenes
├── pricing                 → listas de precios + productos por lista
└── promotions              → CRUD promociones (6 tipos de mecánica)
```

Definidas en [`apps/view/src/app/app.routes.ts:55-105`](apps/view/src/app/app.routes.ts#L55-L105) bajo `LayoutComponent + authGuard + permissionGuard`.

---

## 2. Design tokens

Las utilidades viven en `apps/view/src/styles.css` bajo el header **COMMERCIAL UI PRIMITIVES**. Toda página de `/comercial/*` las usa.

### 2.1 Page header

```html
<div class="comm-page-head">
  <div class="comm-page-head-text">
    <h2>Pedidos</h2>
    <p class="comm-page-sub">{{ count }} registros · contexto</p>
  </div>
  <button pButton icon="pi pi-plus" label="Acción"></button>
</div>
```

- Flex `space-between`, `align-items: flex-end`, gap 1rem, margin-bottom 1rem.
- `h2`: 1.25rem / 700 / letter-spacing -0.005em.
- `.comm-page-sub`: 0.85rem / `--text-color-secondary`.
- Acción derecha es opcional (CTA primaria de la página).

### 2.2 Filtros sobre tabla

```html
<div class="comm-filters">
  <label>Estado<p-select…/></label>
  <label>Almacén<p-select…/></label>
</div>
```

Flex con gap 1rem, `align-items: flex-end`, `flex-wrap`. Labels en columna con span (uppercase muted) + control. **No** se usa este patrón en `/comercial/orders` que usa chips (ver §3.1).

### 2.3 Tabla — celdas standard

| Clase | Uso |
|---|---|
| `.comm-num` | Right-align + `tabular-nums` para columnas numéricas |
| `.comm-num.is-strong` | Numérica con peso 600 (totales) |
| `.comm-strong` / `.comm-cell-strong` | Texto principal de celda en peso 600 |
| `.comm-muted` | Texto secundario gris (0.85rem) |
| `.comm-muted.is-small` | Variante 0.75rem (subtítulos en celda) |
| `.comm-actions` | Wrapper de botones icon-only al final de la fila |
| `.comm-row-clickable` | `cursor: pointer` para filas que navegan |
| `code.comm-code` | Chip monoespaciado para códigos/folios/IDs |

### 2.4 Formularios (dentro de `p-dialog`)

```html
<form class="comm-form">           <!-- vertical, gap 1rem -->
  <label><span>Campo *</span><input/></label>
</form>

<form class="comm-form-grid">      <!-- 2 columnas -->
  <label><span>Campo</span><input/></label>
  <label class="full"><span>Span 2</span><input/></label>
</form>

<div class="comm-form-hint full">  <!-- banner info azul soft -->
  <i class="pi pi-info-circle"></i>
  Texto contextual.
</div>
```

- `em` dentro del label → asterisco rojo (`--bad-fg`) sin estilo itálico.
- `.full` extiende a `grid-column: span 2`.
- `.checkbox-line` invierte a dirección row.

### 2.5 Status pills

`/comercial/orders` usa **`.portal-status-pill`** (utilidad global compartida con `/portal`) con modifiers:

| Modificador | Color |
|---|---|
| `.is-draft` | warn (amarillo) |
| `.is-pending_approval` | warn |
| `.is-confirmed` | info (azul) |
| `.is-fulfilled` | ok (verde) |
| `.is-cancelled` | bad (rojo) |

Pill rounded 999px, soft bg + colored fg + dot pseudo-element. Reemplazó el `<p-tag>` para diferenciar visualmente del pill de `delivery_type`.

El resto de páginas usa `<p-tag severity="…">` de PrimeNG por simplicidad (Activo/Inactivo, Default, Default).

---

## 3. Páginas

### 3.1 `/comercial/orders` — Lista de pedidos

[`comercial-orders.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-orders.component.ts)

**Estructura**:

```
[Page header: H2 "Pedidos" + sub-contexto] [Refresh ghost]

[KPI strip: 4 tiles con border-left semántico]
  - En la ventana (brand)   - Pendientes (warn)
  - Confirmados (info)      - Entregados (ok)

[Filters card]
  [Status chips: Todos · Borradores · Pendientes · Confirmados · Entregados · Cancelados]
  (con count fetcheado en paralelo via forkJoin)
  ─────────────────────────────────────────────
  [Date presets segment: Hoy · 7d · 30d · Todos]
  [Desde: p-datepicker]  [Hasta: p-datepicker]
  [Buscar folio: input con debounce 180ms]

[Table card]
  Folio · Cliente (strong) · Ruta · Almacén · Estado (portal-status-pill)
  · Entrega (co-delivery pill custom) · Total · Fecha (día + hora) · Vendedor · Eye
  [Empty state contextual con ícono + título + mensaje + CTA "Limpiar filtros"]
```

**Decisiones clave**:
- Chips en lugar de select (1-click vs 2-click + counts visibles).
- Date range presets + manual (custom mode al editar manual).
- Búsqueda client-side por folio (backend no soporta `search`).
- KPIs derivados de `rows()` (sumas locales) + counts vía 6 requests paralelos `pageSize:1`.
- Cell "Fecha": día/mes prominente arriba, hora muted abajo.

### 3.2 `/comercial/orders/:id` — Detalle de pedido

[`comercial-order-detail.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-order-detail.component.ts)

```
[← Volver (ghost button)]

[Page head: H2 <code>{folio}</code> + creado por] [hero-tags: route + delivery + status]

[Grid 3 cols: Cliente | Almacén | Total]   (info-cards con p-card)

[Card "Líneas"]
  p-table: Producto (strong + brand muted) · Cantidad · Precio unit · Desc% · Total línea

[Action bar contextual]
  - draft        → "Confirmar pedido" (primary)
  - pending      → "Aprobar pedido" (info)
  - confirmed    → "Marcar entregado" (success)
  - + Cancelar pedido (danger outlined, siempre visible si no es fulfilled/cancelled)

[Card "Embarques de logística"] (solo con permission LOGISTICS_SHIPMENTS_VER)
  Header con icon + count + botón "Crear embarque"
  p-table de shipments asociados

[Card "Historial de cambios"]
  p-timeline con eventos: tag de status + from→to + user + fecha + razón
```

**Decisiones clave**:
- Hero tags apilados verticalmente derecha: ruta + delivery + status (orden de granularidad).
- Cards `info-card` con padding ajustado para densidad.
- Action bar contextual: solo muestra transiciones válidas del estado actual.
- Logística embebida (cross-module) solo si permisos.

### 3.3 `/comercial/customers` — Clientes B2B

[`comercial-customers.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-customers.component.ts)

```
[Page head + "Nuevo cliente"]

[Card]
  [Filters: Search (icon-field debounced) + InputSwitch "Solo activos"]
  
  [Table]
    Código · Nombre (strong + razón social muted) · Tienda enlazada (inline p-select)
    · Ruta (inline p-select) · RFC · Email/Tel · Crédito · Días pago · Estado (p-tag) · Actions

[Dialog "Nuevo/Editar cliente"]   comm-form-grid 2 cols
  Código · Nombre · Razón social (full) · RFC · Email · Teléfono
  Crédito · Días pago · Tienda enlazada (full) · Notas (full)

[Dialog "Acceso Portal B2B creado"]
  warn-banner "Copialo ahora"
  Usuario + Password temporal (con botones copy)
```

**Decisiones clave**:
- **Inline editors** en columnas Tienda/Ruta: p-select dentro de la celda con save instant on change + spinner.
- **Cross-module**: linkea con `LogisticaService` (rutas) y `Store` (Trade Marketing).
- **Acción especial**: "Crear acceso Portal B2B" genera password único, dialog muestra una vez.
- Search en `searchTerm()` debounced 300ms vía Subject.

### 3.4 `/comercial/inventory` — Stock

[`comercial-inventory.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-inventory.component.ts)

```
[Page head: "Inventario" + count líneas de stock]

[Card]
  [Filters: Almacén p-select]
  [Table]
    Almacén · Producto (strong + brand) · On hand · Reservado · Disponible · Adjust
    + rows con tint warn si available < 20, danger si <= 0
    + tags inline "Sin stock" / "Bajo" en columna Disponible

[Dialog "Ajustar saldo de stock"]
  Info card: warehouse · product · saldo actual · reservado
  Input "Nuevo saldo" + Input "Notas (auditoría)"
  Delta preview con color (up=verde / down=rojo)
```

**Decisiones clave**:
- Row tinting visual para alertar low/zero stock (rgba 0.08-0.12).
- Ajuste manual con audit trail forzado (notas).

### 3.5 `/comercial/warehouses` — Almacenes

[`comercial-warehouses.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-warehouses.component.ts)

```
[Page head + "Nuevo almacén"]
[Card][Table: Código · Nombre · Dirección · Default (p-tag) · Estado · Edit/Delete]
[Dialog form: Código · Nombre · Dirección · Switch is_default + hint si activa]
```

CRUD simple. La hint informa que activar default desactiva el anterior.

### 3.6 `/comercial/pricing` — Listas de precios

[`comercial-pricing.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-pricing.component.ts)

```
[Page head + "Nueva lista"]
[Card][Table de listas: Código · Nombre · Moneda · Default · Estado · View/Edit/Delete]
[Card "Precios — {nombre}" condicional]
  Tabla de productos: Producto (strong + brand) · Precio · Min qty · Delete

[Dialog form: Código · Nombre · Moneda (default MXN) · Switch default]
```

**Decisiones clave**:
- Click en "Ver precios" expone segunda tabla debajo (master-detail vertical).
- Empty state de precios sugiere CLI importer para bulk load.

### 3.7 `/comercial/promotions` — Promociones

[`comercial-promotions.component.ts`](apps/view/src/app/modules/comercial/pages/comercial-promotions.component.ts)

```
[Page head + "Nueva promoción"]
[Card]
  [Filters: Tipo p-select + InputSwitch "Solo vigentes"]
  [Table: Código · Nombre (strong + desc muted) · Tipo (colored p-tag con icon)
          · Mecánica (resumen) · Vigencia · Prioridad · Active (switch) · Edit/Delete]

[Dialog wizard 2-step]
  Step 1 "choose-type": grid 2x3 de type-cards con icon + label + desc + ejemplo
  Step 2 "configure": comm-form-grid con campos según tipo elegido
    - percent_off_product: producto + percent
    - percent_off_basket: percent + min_amount
    - nxm: producto + n_buy + m_pay + comm-form-hint con cálculo en vivo
    - volume_discount: producto + tiers dinámicos (min_qty + percent por tier)
    - bundle_fixed_price: items dinámicos (producto + qty) + total fijo
    - cross_sell_discount: trigger + target + percent
```

**Decisiones clave**:
- **Wizard 2-pasos**: elegir tipo (cards visuales) antes de configurar (form contextual al tipo).
- **Tipo p-tag con color hardcoded por type** (única excepción al monocromático — diferenciación crítica entre 6 tipos).
- **Type-cards con `:host-context(body.theme-monochrome)`** para fallback en tema dark.

---

## 4. Convenciones técnicas

### 4.1 PrimeNG components usados

`p-card`, `p-table` (lazy + paginator), `p-select`, `p-datepicker`, `p-dialog`, `p-tag`, `p-inputswitch`, `p-inputnumber`, `p-inputtext`, `p-iconfield + p-inputicon`, `p-toast`, `p-confirmdialog`, `p-tooltip`, `p-timeline`.

### 4.2 Estado y signals

- Cada componente `inject`ea su `ComercialService` (HTTP).
- `signal<T[]>([])` para `rows`, `total`, `page`, `pageSize`, `loading`.
- `computed` para derivados: `visibleRows`, `kpis`, `dateRangeLabel`.
- Lazy load via `p-table (onLazyLoad)` → recalcula page y vuelve a fetchear.
- `forkJoin` para fetches paralelos de counts.

### 4.3 Confirmations destructivas

`ConfirmationService.confirm({ message, accept })` antes de delete/cancel. Toast en éxito/error con `MessageService`.

### 4.4 Permisos

Cada ruta gateada por `permissionGuard(Permission.COMMERCIAL_*_VER)`. Acciones específicas (crear shipment, generar password B2B) checkean perms inline con `auth.user()?.permissions`.

### 4.5 Layout

`LayoutComponent` provee:
- Sidebar nav (item activo por URL prefix `/comercial/*`)
- Topbar
- Content slot con padding

Las páginas de `/comercial/*` renderizan **sin** wrapper extra — el `:host { display: block }` es suficiente.

---

## 5. Anti-patrones a evitar

- ❌ Redefinir `.header-row`, `.muted`, `.filters`, `.num`, `.actions`, `.strong`, `.form*` en estilos locales. Usar utilidades globales `comm-*`.
- ❌ Usar `<p-tag>` para el estado de pedido (`order.status`) — usar `.portal-status-pill.is-{status}` para coherencia con `/portal`.
- ❌ Empty states inline con `class="muted"` solamente. Usar el patrón con icon-container + título + mensaje + CTA opcional (ver `co-empty` en orders).
- ❌ Importar `TagModule`/`ButtonModule` sin usar — chequear imports antes de commit.
- ❌ `severity` hardcoded inválido en `p-tag` (los válidos: `success | info | warn | danger | secondary | contrast`).
- ❌ Inline editors sin spinner ni estado de saving — siempre `[disabled]="linkingId() === c.id"` + `<i class="pi pi-spin pi-spinner">`.

---

## 6. Próximas mejoras potenciales

- **Export CSV/XLSX** en `/comercial/orders` y `/comercial/inventory` (operativo).
- **Bulk actions** en customers (linkear ruta a N customers de una vez).
- **Filtro por vendedor** en orders (backend ya tiene `user_id`, falta exponerlo).
- **Búsqueda backend** por folio (actualmente client-side).
- **Snapshot history** en pricing — quién cambió qué precio y cuándo.
- **Mobile layout** — `/comercial/*` actualmente solo responsive horizontal scroll, no card-view mobile.
