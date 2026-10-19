# P-COM-03 — Armar la requisición

> Paso 3 de 9 · botón **Armar requisición** de `/compras/pedido` · [índice](README.md)

## 1. Para qué existe este paso

Convierte lo que una persona editó en pantalla en **documentos con folio**: `RQ-YYYY-NNNNN`. Es el
primer paso del flujo que deja huella en el servidor, y por lo tanto **el primero que se puede
auditar**.

## 2. Quién lo ejecuta

| | |
|---|---|
| Permiso | `COMPRAS_REQUISICIONES_GESTIONAR` (`POST /requisitions` y `/requisitions/batch`) |
| Roles que lo tienen | `auxiliar_compras`, `compras`, `compras_operaciones`, `encargado_tienda`, `finanzas`, `gerente_compras`, `marketing`, `superadmin`, `tesoreria` — **29 personas en 9 roles** (medido 2026-10-08) |
| Quién arma de verdad | `gerente_compras` 350 · `direccion` 184 · `compras` 169 · `auxiliar_compras` 82 · `superadmin` 66 · `compras_operaciones` 39 *(prod, 2026-10-16)* |

## 3. Disparador y entradas

- **Disparador:** el clic de la persona. Alcance: **un producto** (botón del desglose), **un
  proveedor** o **todo lo marcado** (barra global).
- **Entradas:** las cantidades del paso [P-COM-02](P-COM-02_armado_del_pedido.md) —y sólo las
  mayores que cero.

## 4. Qué se hace

El sistema agrupa solo, y la agrupación **no es por quién necesita la mercancía**:

| tipo | se agrupa por | `source_type` |
|---|---|---|
| **Compra** | *(proveedor × dónde ENTREGA el proveedor)* | `supplier` |
| **Traspaso de consolidación** | *(destino × CEDIS)*, apuntando a la compra que lo originó | `branch` |
| **Traspaso puro** | *(destino × origen)* | `branch` |

Todo lo que sale de un mismo clic queda en un **lote** (`batch_id` + `batch_folio`).

## 5. Qué queda registrado

- `commercial.purchase_requisitions`: folio `RQ-YYYY-NNNNN`, estado **`pending_approval`**,
  almacén, proveedor, `source_type`, `total_cost`, `total_units`, `notes`, `created_by`, lote.
- `commercial.purchase_requisition_lines`: por renglón `on_hand`, `suggested_qty`, **`final_qty`**
  (lo que la persona decidió), `unit_cost`, `line_cost`.
- **PDF «Orden de requisición»**, global o por proveedor, y **XLSX** del alcance — se generan
  aparte, **no se archivan**: quedan en la descarga de quien lo pidió.

⚠️ **La línea de compra NO guarda de qué sucursal salió** (`source_warehouse_id` va NULL en las de
compra). Por eso el envío a Kepler consolida por SKU: el desglose ya estaba perdido. Si algún día
la línea registra su destino, ese default **pasa a destruir dato** y hay que invertirlo.

## 6. Controles

| control | qué hace |
|---|---|
| Nada que armar | si no hay cantidades > 0 en el alcance, avisa y no crea nada |
| Almacén sin resolver | los renglones cuyo código de almacén no resuelve a un id **quedan fuera y se avisan**, en vez de perderse callados |
| Bajada sin dueño único | si una bajada junta varios proveedores, la liga a la compra queda `null` **y se declara**: apuntar a la primera sería inventarla |
| Folio | se asigna de forma atómica por secuencia; dos clics simultáneos no comparten folio |

## 7. Evidencia medida

- **53 lotes / 221 documentos**, promedio **4.2** documentos por «Armar», el peor **18**
  *(prod, 2026-10-16)*.
- El comentario de código que cita *8.2 de promedio y 117 en el peor* midió **82 generaciones** en
  otra ventana; las dos cifras son ciertas con su definición. La de arriba cuenta sólo las
  requisiciones que hoy tienen `batch_id`.
- ⚠️ Las requisiciones anteriores al lote (`[RQ.8]`, mig `20261006190000`) **no tienen uno** y la
  bandeja las muestra como lote de uno, sin inventarle un agrupamiento hacia atrás.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| «Sucursales sin identificar» | `/filters` falló y los lookups quedaron vacíos | recargar la página y rearmar |
| Salieron más documentos de los esperados | consolidación: compra + bajadas | es correcto; verlo agrupado por lote en la bandeja |
| Se armó dos veces lo mismo | el aviso de duplicado se ignoró | dar de baja una en la bandeja **antes** de autorizar (§7 de [P-COM-02](P-COM-02_armado_del_pedido.md)) |

---

**Documento oficial de este paso:** ✅ **`RQ-YYYY-NNNNN`**, el único documento propio del flujo que
hoy existe de punta a punta. El PDF que lo acompaña **no se archiva** — ver
[P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §3.
