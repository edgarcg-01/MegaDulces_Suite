# P-COM-08 — Recepción de la mercancía

> Paso 8 de 9 · `/compras/ordenes` → registrar OE · `/compras/entradas` (espejo del ERP) ·
> [índice](README.md)

## 1. Para qué existe este paso

Cerrar el ciclo con el hecho físico: **llegó**. Es el paso que alimenta el **fill rate** (recibido ÷
pedido), que a su vez vuelve al motor del sugerido.

⭐ **El inventario de verdad lo mueve Kepler**, en la `X-A-40` — la única que toca el kardex `kdij`.
Lo nuestro es un **overlay optimista** que el snapshot nocturno re-sincroniza. Kepler es la verdad
del inventario; nosotros, la planeación (ADR-031).

## 2. Quién lo ejecuta

| | |
|---|---|
| Registrar OE (`POST /purchase-orders/:id/receipts`) | `COMPRAS_ORDENES_GESTIONAR` |
| Atajo `markReceived` (`POST /requisitions/:id/receive`) | `COMPRAS_REQUISICIONES_GESTIONAR` |
| Quién recibió de verdad | `gerente_compras` 1 · `superadmin` 1 *(requisiciones, prod 2026-10-16)* |

## 3. Disparador y entradas

- **Disparador:** la mercancía en la puerta, con su remisión.
- **Entradas:** cantidad realmente recibida por renglón y el costo real.

## 4. Qué se hace

**Camino recomendado (OE):** abrir la OC → registrar la **orden de entrada** `OE-YYYY-NNNNN` con
las cantidades reales. Admite **parciales**: varias OE contra una misma OC.

**Atajo:** marcar la requisición como `received`, capturando `received_qty` por renglón (por
omisión, recepción completa).

⛔ **El atajo se bloquea** si la requisición ya generó una OC no cancelada: la recepción debe ir por
el camino que **sí mueve stock**, para no contar doble.

## 5. Qué queda registrado

| | |
|---|---|
| OE | `commercial.goods_receipts` + `_lines`, folio `OE-YYYY-NNNNN`, costo real por línea |
| Stock | movimiento `in` al almacén destino (traspaso: además descuenta el origen, con clamp a disponible) |
| Requisición | `received_qty` / `received_at` por renglón → **base del fill rate** |
| En Kepler | `X-A-37` vale → `X-A-40` entrada → **`X-A-20`/XA2001 «Aplica»**, que es **el ancla**: el proveedor la firma, se le adjunta la remisión y genera la póliza (511/201/122) y la CxP |

⚠️ **El Total Factura del proveedor NO está en Kepler**: es externo (el CFDI). Lo pone el OCR, y el
cuadre a 3 vías es OCR(factura) vs `c16`(entrada) vs OC. El Excel legacy mostró **41 % que no
cuadra**.

## 6. Controles

| control | qué hace |
|---|---|
| Bloqueo del atajo | impide el doble conteo contra la cadena OC→OE |
| Parciales | varias OE por OC, en vez de forzar «todo o nada» |
| Reconciliación | el feed de stock de Kepler es un **snapshot absoluto**; el overlay se auto-sana en la corrida nocturna |
| Clasificación del descuadre | `/compras/entradas` escribe `discrepancy_kind` (cuadra / iva / typo / faltante / devolución / descuento / duplicada) |
| Auto-explicación | el detalle de la entrada lista los `X-D-40` / `X-D-55` del proveedor que explican la diferencia |

## 7. Evidencia medida

- **65 recepciones** en `commercial.goods_receipts` *(prod, 2026-10-16)*, contra **18**
  requisiciones en estado `received`: la mayoría de las OE no cierran la requisición.
- ⚠️ **«Factura > Compra» no siempre es faltante**: puede ser **devolución por sobre-envío** —
  causa opuesta, mismo signo. El motivo del `X-D-40` las distingue.
- El canal **comercial** (notas de crédito `X-D-55`: apoyos, pronto pago, descuentos) movió
  **$20.3 M en 2026** y **no estaba en el Excel legacy**: era invisible.

## 8. Cuando falla

| síntoma | qué significa | qué hacer |
|---|---|---|
| El atajo se niega | ya hay una OC viva | registrar la OE, no forzar el estado |
| La existencia subió y después bajó | el overlay se re-sincronizó con el snapshot de Kepler | es el diseño; la verdad es Kepler |
| La entrada no cuadra con la factura | puede ser faltante, devolución, IVA o typo | usar *«¿Por qué no cuadra?»* en `/compras/entradas` antes de reclamar |
| Entró mercancía sin OC | ocurre | `/compras/entradas-sin-oc` |

---

**Documento oficial de este paso:** ✅ `OE-YYYY-NNNNN` del lado nuestro y **XA2001** del lado del
ERP — el único paso del flujo con documento firmado por un tercero. Lo que falta es **ligarlos**:
ver [P-COM-00](P-COM-00_ACTAS_POR_PASO.md) §8.
