# Anexo CANON.7 — La existencia y todo lo que puede salir del ODS (medido el 2026-11-18)

> **Pedido, literal (Edgar, 2026-11-18):** «los imports no deben de existir» · «revisa qué puede salir del ODS que hoy
> no está saliendo» · «resolvamos existencia y todo lo que pueda salir del ODS».
>
> **Estado:** C0 medido (este documento). Nada construido todavía. Se cuelga de la excepción de cupo que Edgar firmó para
> CANON (anexo `FASE_CANON_ANEXO_RETIRO_IMPORTERS_2026-11-05.md` §8); items `[CANON.7.N]`.
>
> **Cómo se midió:** horario vivo del pod `feeds-cron` (igual al del repo) y el loop `feeds-livefast`; código con `git grep`;
> prod en sólo lectura (`system_identifier` 7688376744939610156), una parte como `postgres` y la que importa como un rol
> **sin** superusuario ni `BYPASSRLS` (el que pinta lo que vive la app); el consolidado por el túnel del 5433 (`system_identifier`
> 7644631598664073265, con venta de hoy).

---

## 1. Lo que hoy NO sale del ODS y podría

46 pasos activos en la ingesta (8 carriles + 9 sueltos). Los que leen OTRA fuente aunque el dato ya está en el ODS:

| Frente | Hoy sale de | Lo medido | Destino |
|---|---|---|---|
| **Venta** — `import-sales-fact` (loop de 60 s + nocturno) → `analytics.sales_daily`, raíz de Pedido | `mart.ventas_enriched` | 30 días: **92.8 %** del importe es venta de las 8 sucursales de Kepler y **7.2 %** el push de las camionetas (`ruta_*`). Control 7 días contra `analytics.v_kepler_sales_lines`: 8 Esquinas, Canindo y Morelia Abastos **idénticas al centavo** (21/21 sucursal-días, mismos renglones); Padre Hidalgo difiere exactamente por sus almacenes de ruta `01-001`…`01-006` (17-nov: $123,254 vs $123,255), que **sí están en `kepler_ods.kdm1`** (202 documentos ese día) pero la vista los excluye (`btrim(h.c1) = btrim(h.sucursal)`) | vista/tabla por evento que una por `warehouses.kepler_code` (las rutas `RUTA-NN` ya tienen `01-00N`) — es `[PQ.61]` (venta diaria de Kepler por evento, migración sin versionar) más el push (D4) |
| Mismos datos del mart: `rotation-from-consolidado`, `top-sellers-from-consolidado`, `customer-sales` | `mart.ventas` | = la venta de arriba | se derivan de la misma venta |
| **ContPAQi** — `contpaqi-polizas`, `-bank-movements`, `-ledger`, `-suppliers`, `-cfdis` (×2 agendas), `derivar-reglas` | SQL Server directo | `contpaqi_ods` vivo desde `[CANON.6.21]`/D15 (202 tablas, 5 GB, escrito hoy) con `ct_polizas`, `ct_movimientospoliza`, `ct_saldoscuentas`, `ct_proveedores`, `ct_bancos`, `add_comprobante`… | repuntar a `contpaqi_ods` (de la sesión de CANON) |
| **Existencia** — `import-branch-stock-live` (cada 15 min) → `commercial.stock` | réplica directa `md.kdil` | §2 | §3 |
| Mixtos: `product-sales-daily`, `expenses-polizas`, `ledger-chain`, `reconcile-route-provenance` | ODS **y** réplica directa `md.*` | — | quitar la mitad `md.*` |

**No está en el ODS:** sólo el push de las camionetas (`route-push-lines`, `route-push-monthly`, `canindo-routes-monthly`,
`reconcile-route-provenance`) → D4 (Edgar, 2026-11-17: «sí, hagamos lo del ODS»).

---

## 2. Existencia: el dato sale entero del ODS (C0)

`commercial.stock` vs `analytics.v_erp_stock_on_hand` (vista sobre `kepler_ods.kdil`), celda por (almacén, producto):

| Caso | Celdas | Con existencia |
|---|---:|---:|
| Igual | 31,714 | 22,070 |
| Sólo en la copia | 27,100 | **3,347** |
| Sólo en el ODS | 1,458 | 241 |
| Distinto | 302 | 302 |

La vista: 0 duplicados, 0 negativos, una sola fuente (`kepler_ods`, 9 sucursales).

**Las 3,347 que sólo tiene la copia, una por una:**
- **2,823** — «Almacén Morelia Madero (32)» (`MD-32`), almacén **borrado**, congelado desde el 2026-09-10: fantasma.
- **424** — productos activos que Kepler NO tiene en `kdil` de esa sucursal, congelados desde la migración de cada una
  (Morelia Madero 2026-09-18, Canindo 2026-08-18, CEDIS ago–oct): fantasma que la copia (delta) nunca borró.
- **64** — productos borrados en el catálogo: la vista los excluye a propósito.
- **32** — CEDIS sin movimiento desde su corte a Kepler: la vista los excluye a propósito
  (`20261001190000_cedis_arbitrado_por_corte`).
- 3 en cero en Kepler.

**Dato propio de la Suite en la copia:** 59,116 filas, **1** con `reserved_quantity > 0`, **0** con `aisle_id`. Los lotes viven
en `commercial.stock_lots`. Movimientos que la app escribió en 30 días: **19** (12 liberaciones, 7 ventas, de pedidos);
recepciones, conteos y devoluciones de ruta: **0**.

⭐ Pasar los lectores al ODS **corrige ~3,800 celdas** y no pierde ninguna real.

### 2.1 Pero la vista NO aguanta como fuente de lectura de la app

Medido con un rol sin superusuario ni `BYPASSRLS` (como corre la app; tres corridas):

| Consulta | `postgres` | Con RLS |
|---|---:|---:|
| Toda la red | 357 ms | 1.2–2.0 s |
| **Una sucursal (`warehouse_code = '08'`)** | 44 ms | **10.5–11 s** |
| `reorder_policy` ⟕ existencia, toda la red | — | ~500 ms (con la copia: 5 ms) |

⛔ Cambiar los lectores a la vista directa vuelve lentas pantallas que hoy son instantáneas (Existencia crítica, catálogo del
portal, detalle de pedido). La nota de `stock-state.ts` («sin filtro más de un minuto; con una sucursal ~0.5 s», 2026-10-27)
sigue siendo la advertencia correcta; con `postgres` no se ve.

---

## 3. El diseño: existencia mantenida por cambio, en la pieza que YA existe

`[CANON.6.21]` puso en prod (2026-11-17) la cola por SKU `analytics.llaves_sucias`, disparadores por sentencia en 13 fuentes
y `analytics.drenar_existencia()` (ADR-104: nunca frenan la ingesta). **`kepler_ods.kdil` no es una de sus fuentes** (cubre
precio, factores de caja y costo). ADR-056: no se inventa otra cola.

1. **`[CANON.7.1]` C0→C1** — `kdil` como fuente 14 (columnas que la regla lee: `c4`, `c8`, `c9`; clave `sucursal`+`c3`) y una
   regla más en `recalcular_existencia(skus)`: la existencia por (almacén, producto) **idéntica** a `v_erp_stock_on_hand`
   (misma plantilla letra por letra, como hicieron con los factores), en una tabla con índice por (tenant, almacén, producto).
   Prueba: idéntica completa y por llave; mutantes.
2. **`[CANON.7.2]` C2** — los **13** lectores clase A (analytics ×4, rentabilidad ×2, ficha de producto, monitoreo, Thot,
   existencia crítica / resumen / excedente de red, scanner de reorden) leen la tabla.
3. **`[CANON.7.3]` C2** — los **11** clase B (catálogo, facetas, precios y más vendidos del portal; detalle de pedido; bot de
   WhatsApp; Command Center; Reparto › Faltantes; Thot del portal y del vendedor) por `stock-state.ts`, que pasa a leer la tabla.
4. **`[CANON.7.4]` C1** — escritores (clase C, 18 sitios): el apartado valida contra el ODS (`reserve`/`consume`), `quantity` deja
   de escribirse; conteos, ajustes y recepción se revisan uno por uno (hoy 0 movimientos en 30 días). Prueba contra base real
   con el payload de la pantalla (regla 13).
5. **`[CANON.7.5]`** — `import-branch-stock-live` sale del carril `stock`; `commercial.stock.quantity` queda congelada (la tabla
   NO se borra, regla 5); el sensor `stock` de db-health se retira o se repunta (clase D).

**Clasificación completa de los 47 sitios** (archivo:línea, llamador, columnas, riesgo): hecha el 2026-11-18 por lectura de
código; los más calientes son el catálogo del portal y el detalle de pedido. ⚠️ `findById` del pedido no se mueve sin decidir
`reserve()` (valida contra la copia con candado). Los Thot del portal y del vendedor usan la sucursal por defecto `'MD-10'`
(código Wincaja viejo de Padre Hidalgo): no verificado que case con `warehouses.code = '01'`.

**Pruebas que copian la consulta en su propio SQL** (no se rompen, pero describen la forma vieja):
`test-newdb-replenishment.js`, `test-newdb-critical-stock-count.js`.

---

## 4. Decisiones

- **D-EX1 (Edgar):** quién construye `[CANON.7.1]` — la sesión dueña de `[CANON.6.21]` (la cola es suya) o ésta, coordinadas.
- **D-EX2 (Edgar):** `[PQ.61]` (venta diaria por evento): aplicar su migración fuera de horario. Es la base del frente Venta.
