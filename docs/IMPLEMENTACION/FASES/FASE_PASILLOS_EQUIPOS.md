# Fase PA — Pasillos 2D + equipos de conteo

> **Estado: 🔨 PA.0 + PA.1 (a+b) + PA.2 + PA.3 EN CÓDIGO — 2026-06-19.** Layout de pasillos (schema + backend + editor 2D) + generador + **tablero de asignación por folio** (persiste supervisor/contadores por pasillo). Siguiente: PA.4 (scoping del conteo por pasillo). **⚠️ Divergencia de generador:** PA.2 (`/aisles/plan`) reparte **proporcional a unidades** (compute, mío); PA.3 (`/counts/:id/generate-teams`) reparte **parejo** y **persiste** (decisión del usuario). El tablero usa el parejo; el proporcional queda como preview alternativo — reconciliar (ver Riesgos). Extensión de la Fase I (conteo físico) y de la Fase ABC (conteo cíclico). Organiza el conteo por **pasillos** (zonas 2D del almacén), con **1 supervisor por pasillo** y un **equipo de contadores proporcional** a cada uno. Decisión en [ADR-024](../02_DECISIONES_ARQUITECTURA.md).

## Objetivo

Pasar del conteo con **lista plana de personas por folio** (lo que hay hoy) a un conteo **zonificado**: el almacén se divide en pasillos dispuestos en una **grilla 2D**; cada pasillo tiene **un supervisor** (valida + concilia su zona) y un **equipo de contadores** dimensionado **proporcional a las unidades físicas** de la zona. Es la práctica estándar de cycle/physical counting (zona → líder → equipo, staffing balanceado por carga).

## Decisiones (confirmadas con el usuario 2026-06-19)

1. **Dominio:** conteo de inventario (almacén), no auditoría de tienda.
2. **Data de pasillos:** **alta manual por almacén** (el ERP no la trae — `location` = `Z000` en los 11,109 productos). El sistema gestiona el concepto.
3. **Proporcional a:** **unidades físicas** (`Σ stock.quantity` por pasillo). *Caveat:* el esfuerzo real es más `#SKUs` que unidades; la carga se implementa como **fórmula tuneable** (`unidades`, o `α·SKUs + β·unidades`) para corregir sin re-armar.
4. **Layout 2D:** **grilla** (filas × columnas, celda = pasillo; CSS grid, sin librería de mapas). No lienzo libre.
5. **Asignación de contadores:** **híbrida** — botón "auto-generar" pre-llena un plan proporcional, y se ajusta manualmente arrastrando en el 2D.

### Distinción clave: LAYOUT vs TABLERO
- **Layout (permanente):** qué pasillos hay, su posición 2D, y qué SKUs viven en cada uno. Se define una vez y se reusa.
- **Tablero (por folio):** sobre ese layout, para *este conteo*, se pone supervisor + contadores en cada pasillo. **Cambia en cada conteo** (no viene la misma gente). Por eso el **supervisor NO se hornea en el pasillo** — vive en la asignación del folio.

## Jerarquía

```
Pasillo (zona 2D)  →  1 supervisor  →  equipo de N contadores
                       (valida/concilia      (cuentan a ciegas,
                        SU pasillo)           doble conteo)
```
El contador ve SOLo los SKUs de su pasillo; el supervisor ve el avance/discrepancias de SU pasillo.

## Modelo de datos

```
commercial.warehouse_aisles                 -- LAYOUT (permanente)
  id, tenant_id, warehouse_id, code, name,
  grid_row, grid_col, span_rows, span_cols  -- posición 2D en la grilla
  active, created_at, updated_at, updated_by
  UNIQUE (tenant_id, warehouse_id, code) ;  RLS forzado

commercial.stock.aisle_id                   -- mapeo SKU→pasillo (grano warehouse×product)
  FK → warehouse_aisles(id) ON DELETE SET NULL ; nullable (NULL = "Sin pasillo")

commercial.inventory_count_assignments      -- TABLERO por folio (extiende lo existente)
  + aisle_id (FK SET NULL)
  unique → (tenant_id, count_id, aisle_id, user_id, assignment_role) NULLS NOT DISTINCT
  (permite mismo supervisor en varios pasillos)

commercial.inventory_count_items.aisle_id   -- foto al abrir → particiona el conteo
  FK → warehouse_aisles(id) ON DELETE SET NULL ; nullable
```

FK de `aisle_id` es **de columna simple** a `warehouse_aisles.id` (PK), para permitir `ON DELETE SET NULL` (un FK compuesto con `tenant_id` no puede nullear porque `tenant_id` es NOT NULL). RLS + el flujo de alta garantizan que el pasillo sea del mismo tenant.

## Algoritmo de equipos proporcional (unidades)

```
w_i = Σ stock.quantity de los SKUs del pasillo i        (carga tuneable)
W   = Σ w_i ;  pool del día: S supervisores, C contadores
SUPERVISOR: S ≥ n → 1 por pasillo ; S < n → clusters balanceados (bin-packing LPT)
CONTADORES: c_i = max(min, round(C · w_i / W)) ; ajustar redondeo → Σ c_i = C
            min = 2 si doble-conteo ciego, si no 1
EDGE: C < n·min → conteo por olas o avisar "faltan contadores"
```

## Fases

| Fase | Tema | Entrega |
|---|---|---|
| **PA.0** | Schema | `warehouse_aisles` (+coords 2D) + `stock.aisle_id` + `assignments.aisle_id` (+unique) + `items.aisle_id`. Permiso (reusa `COMMERCIAL_INVENTORY_ASIGNAR`). |
| **PA.1a** ✅ código | Backend de layout | ✅ 2026-06-19: `WarehouseAislesService` + `/commercial/inventory/aisles` (gate ASIGNAR): CRUD de pasillos (grid_row/col + span), `GET` con **carga por pasillo** (unidades + #SKUs) + bucket "Sin pasillo", **`POST .../assign`** mapeo **bulk** SKU→pasillo por filtro (product_ids / brand_id / abc_class / rango SKU / only_unassigned; `aisle_id=null` des-asigna). Guards: código único (409), borrar bloqueado si folio abierto lo usa, assign exige filtro. Build verde + smoke PA.1. ⏳ reinicio para verde live. |
| **PA.1b** ✅ código | Editor 2D (UI) | ✅ 2026-06-19: página `/comercial/inventory/aisles` (tab "Pasillos", gate ASIGNAR). Surface Operations: **grilla CSS 2D** (celda = pasillo en su `grid_row/col`+span, con código/nombre/carga + barra de carga), select→**panel lateral** (editar nombre/posición + borrar con confirm + **asignación bulk** SKU→pasillo en 4 modos: marca/clase ABC/rango SKU/sin-asignar), tile "Sin pasillo", dialog "Nuevo pasillo". + endpoint backend `GET .../aisles/brands` (marcas con stock en el almacén, para el dropdown). Build view+api verde. ⏳ QA visual + reinicio. |
| **PA.2** ✅ código | Generador proporcional | ✅ 2026-06-19: `WarehouseAislesService.generateTeamPlan` + `POST /commercial/inventory/aisles/plan` (gate ASIGNAR). 1 supervisor/pasillo (S≥n) o **clusters balanceados LPT** (S<n); contadores **proporcionales a unidades** (`c_i = max(min, round(C·w_i/W))`, ajuste de redondeo → Σ=C). Pool = supervisor_ids/counter_ids del día (default: todos los asignables por permiso). **No persiste** (eso es PA.3). Build verde + smoke PA.2 (1:1 sup / proporción / cluster). ⏳ reinicio. |
| **PA.3** ✅ código | Tablero de asignación 2D | ✅ 2026-06-19: `InventoryTeamService` + `InventoryTeamController` (`GET/POST /commercial/inventory/counts/:id/aisle-teams`, `POST .../generate-teams`): tablero por folio que persiste supervisor + contadores **por pasillo** en `inventory_count_assignments.aisle_id`. **Generador PAREJO** (contadores ÷ pasillos, resto de a 1 — decisión del usuario, override del proporcional). Frontend `/comercial/inventory/sessions/:id/teams` (grilla 2D, pool del día, auto-generar + ajuste manual por pasillo) + botón "Equipos por pasillo" en el detalle del folio. Build view+api verde + smoke PA.3. ⏳ reinicio + QA visual. |
| **PA.4** | Scoping del conteo | Contador ve su pasillo / supervisor su avance + freeze-por-pasillo + reportes por pasillo. |

**Orden de valor/riesgo:** el grueso es **PA.1** (alta de pasillos + el editor 2D); el algoritmo (PA.2) son ~50 líneas. Sin data de pasillos poblada, nada de PA.2-4 sirve.

## Riesgos / decisiones abiertas

- **Alta de SKUs masiva:** asignar 11k SKUs a pasillos a mano es impagable → la asignación **bulk** (marca/ABC/rango) es obligatoria en PA.1, no opcional.
- **Carga = unidades** puede sobre-staffear pasillos con poco surtido y mucho volumen → fórmula tuneable.
- **Mundo `inventory.warehouse_stock` (Kepler SKU):** PA arranca sobre `commercial.stock` (UUID). El otro mundo = fase posterior.
- **Supervisores < pasillos:** clustering balanceado (cubre-varios), no bloquear.
- **Generador parejo (PA.3) vs proporcional (PA.2):** el usuario decidió **parejo** para el tablero que persiste (contadores ÷ pasillos). El `/aisles/plan` proporcional-por-unidades (PA.2, ADR-024) queda como **preview/alternativo** y NO lo usa el tablero. Decidir: (a) dejar ambos (parejo persiste, proporcional como preview), (b) que `generate-teams` acepte un `mode` (parejo|proporcional), o (c) eliminar el proporcional. **Pendiente de elección.**

## Relacionado
- [ADR-024](../02_DECISIONES_ARQUITECTURA.md) (decisión).
- [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) (conteo físico; `inventory_count_assignments` base).
- [FASE_ABC_CYCLE_COUNT.md](FASE_ABC_CYCLE_COUNT.md) (folio cíclico acotado — se particiona por pasillo).
