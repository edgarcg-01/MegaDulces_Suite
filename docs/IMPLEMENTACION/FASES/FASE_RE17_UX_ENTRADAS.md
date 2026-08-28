# Fase RE.17 — Las 6 pantallas de órdenes de entrada, contra DESIGN.md

> **Estado:** 🧪 **RE.17.0 → 17.7 EN CÓDIGO (local), builds `view` + `api` verdes** — 2026-08-28.
> **Falta:** verificación visual (dev servers prohibidos y los MCP de navegador no conectaron) y
> redeploy. **Sin migraciones nuevas y sin permisos nuevos** → no requiere re-login.
> **Depende de:** [RE.13](FASE_RE13_TRES_VISTAS_ENTRADAS.md) (las 4 pantallas por oficio) ·
> [RE.16](FASE_RE16_TRES_PANTALLAS.md) (Centro de control en pestañas) · CC ext (evidencia) ·
> [`DESIGN.md`](../../../DESIGN.md) (checklist de 18 puntos, §O.2 Compras, §Q comprensión, §datos densos).
> **Tesis:** RE.13/RE.16 partieron el proceso por **trabajo** y eso quedó bien. Lo que faltó fue
> cerrar el sistema visual: cada pantalla se construyó con lo que había a mano ese día, así que el
> mismo dato —una orden de entrada— se ve de dos maneras, el expediente se lee en un modal de 72rem
> y **el documento no está en la pantalla donde se decide**. Esta fase no agrega features: pone las
> 6 pantallas sobre los mismos organismos.

---

## 1. Diagnóstico (auditoría de código 2026-08-28, 6 pantallas × 18 puntos)

### 1.1 Los tres problemas de fondo

**A.1 — Dos sistemas de tabla en el mismo proceso.**

| Pantalla | Tabla |
|---|---|
| Pendientes · Control · Gemelas | `<table class="surf-table surf-table--plain">` — `--row-h-md` tokenizada, header sticky, frozen-first |
| Revisión · Órdenes | `p-datatable-sm` + clase propia, **sin `surf-table`** |

Órdenes es la **única tabla de todo `/compras`** sin `surf-table`: `compras-360`, `costo-neto` y
`cuadre-proveedor` sí lo llevan. Misma entidad, dos alturas de fila, dos headers, dos hovers.

**A.2 — Falta el organismo canónico de detalle.** `SidePeek` (regla #8 de datos densos) está
adoptado en 10+ pantallas de la app y en **0** de entradas. Órdenes lee el expediente completo
—veredicto, 3 cifras, ficha, N renglones, conciliación por línea RE.11, ajustes del proveedor—
dentro de un `p-dialog` de **72rem maximizable**, y abre un **cuarto diálogo** de 56rem para ver el
documento. Es el antipatrón textual de §O.1: *"prohibido modal superpuesto para LEER documentos
financieros extensos"*.

**A.3 — El documento no está donde se decide.**

| Dónde se decide | ¿Se ve la hoja? |
|---|---|
| **Pendientes** — confirmás que la factura entra al expediente | ❌ sólo la lectura del OCR |
| **Revisión** — aprobás / devolvés | ✅ al lado de las cifras |
| **Gemelas** — decidís si dos capturas son la misma compra | ❌ ni documento ni renglones |
| **Órdenes** — auditás renglón por renglón | ⚠️ en un tercer diálogo sobre el segundo |

Y donde sí está, el visor es un `<iframe>` pelado en 64vh: sin zoom, sin rotar, sin páginas, sin
pantalla completa. Son escaneos de remisiones hechas a mano.

Gemelas es el caso más caro: la evidencia que resuelve la duda **ya existe en el backend** — la
copia de sucursal trae 12–20 renglones de producto y la de oficinas trae **uno** (`VENTAS AL 0 %`,
ver [`reference_double_capture_branch_office`]) — y la pantalla muestra folio, monto, fecha y
proveedor. Se pide dictaminar sin mostrar lo que dictamina.

### 1.2 Matriz de deuda

| Regla DESIGN | Pend | Rev | Ctrl | Gem | Ajus | Órd |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `<app-context-help>` (§P) | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Frescura + refresh local (§9) | ✅ | ❌ | ✅ | ❌ | — | ✅ |
| `CanDeactivate` / `beforeunload` (§8) | ❌ | — | — | — | ❌ | ❌ |
| Bulk-bar por selección (§dd 6) | ❌ | ❌ | — | ❌ | — | ❌ |
| `SidePeek` para detalle (§dd 8) | ❌ | n/a | — | ❌ | — | ❌ |
| `@container` (regla 9) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cero hex crudo (regla 2) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ ×16 |
| PrimeNG-first (regla 3) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ `<select>` |

Además, en las 6: **ningún toggle de densidad** (`surf-table--plain.is-dense` existe en
`styles.css` y nadie lo expone) y ningún camino de teclado para la acción principal de captura.

---

## 2. Decisiones de diseño

1. **Un visor de documento, compartido.** No se resuelve pantalla por pantalla: es un organismo
   nuevo en `shared/components/doc-viewer/`, y las 4 pantallas que muestran evidencia lo consumen.
   **Sin librería nueva** (regla 3 + riesgo de licencia PrimeNG): zoom/página del PDF por
   *fragment params* del visor nativo del navegador (`#zoom=`, `#page=`, `#view=`), rotación e
   imágenes por `transform` CSS. `@container` para que sirva igual en el aside de Revisión (angosto)
   que en el side-peek de Órdenes (ancho).
2. **El expediente sale del modal.** Órdenes pasa a `SidePeek` ancho. Los diálogos que quedan son
   los legítimos de §O.1: **crear** (adjuntar) y **confirmar corto** (devolver).
3. **La tabla de Órdenes se alinea con sus hermanas de `/compras`**: `p-table` + `surf-table
   surf-table--sticky`, igual que `compras-360` / `costo-neto` / `cuadre-proveedor`. No se
   reescribe a `<table>` crudo: PrimeNG-first sigue vigente para lo existente.
4. **La decisión se toma con la evidencia a la vista.** Gemelas muestra los renglones de los dos
   lados (backend nuevo, dato ya existente). Pendientes muestra la hoja antes de enviar.
5. **Nada de esto se esconde tras un colapsable** (Tesler): la densidad se resuelve con el toggle
   de altura de fila, no ocultando columnas vitales.
6. **El vocabulario no cambia.** *Sin factura → Por revisar → Validada*, con *Devuelta* como único
   regreso. El diccionario de ayuda (`compras-entradas`) ya lo documenta y ya cubre gemelas,
   cobertura y documento: las 4 pantallas que faltan sólo tienen que **montar el `?`**, no redactar.

---

## 3. Sprints

| # | Item | Alcance |
|---|---|---|
| **RE.17.0** | Plan | Este documento. |
| **RE.17.1** | `DocViewerComponent` | Organismo compartido: selector de hoja · zoom (`+`/`−`/`0`) · ajuste ancho/página · rotar · páginas · pantalla completa · abrir en pestaña · teclado · `@container` · fondo tokenizado (dark-safe). |
| **RE.17.2** | Plomería | `unsavedChangesGuard` + `beforeunload` en Pendientes y Ajustes · `<app-context-help>` en Revisión, Gemelas, Ajustes y Órdenes · frescura + refresh local en Revisión y Gemelas. |
| **RE.17.3** | Gemelas con evidencia | Backend: renglones de los dos lados en `GET /twins`. UI: fila expandible con los dos detalles enfrentados + selección múltiple + bulk-bar de dictamen. |
| **RE.17.4** | Revisión | Visor nuevo en el aside · selección por fila + bulk-bar (aprobar N elegidas, no sólo "todas las que cuadran") · `@container` en el split. |
| **RE.17.5** | Órdenes | Expediente a `SidePeek` (mata 2 diálogos) · `surf-table` · `<select>`→`p-select` · 16 hex→tokens · honra `?suc` + alcance + carril + pager real. |
| **RE.17.6** | Densidad + detalle fino | Toggle de altura de fila compartido en las 4 tablas · miniatura de la hoja en la bandeja de Pendientes · totales de lo visible. |
| **RE.17.7** | Cierre | Build prod `view` · tracker · CHANGELOG · log de revisiones. |

---

## 4. Verificación (definition of done)

- `nx build view --skip-nx-cache` verde (sin pipe, para no enmascarar el exit code).
- Los 18 puntos del checklist pre-vuelo pasados **por pantalla**, no en muestra.
- Light + dark + móvil en las 6 (el visor es el riesgo: la hoja es blanca, el marco no puede serlo).
- Ningún `#hex` crudo nuevo; ningún `!important` nuevo.
- El guard anti-pérdida probado con navegación interna **y** F5.

## 5. Fuera de alcance (diferido)

- **Tendencia de cobertura por sucursal** (sparkline de 8 semanas en el Centro de control): pide una
  consulta nueva agrupada por semana; vale, pero es feature, no deuda visual.
- Selector de columnas y export en Órdenes — `compras-360` ya cubre el trabajo analítico.
- `⌘K` del módulo.
- Migrar Pendientes/Control/Gemelas de `<table>` crudo a `p-table`: hoy `surf-table--plain` les da
  exactamente lo que necesitan y la decisión de licencia de PrimeNG está abierta.
