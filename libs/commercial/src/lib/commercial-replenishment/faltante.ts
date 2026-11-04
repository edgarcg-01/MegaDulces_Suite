/**
 * `[PQ.44]` **CUÁNDO SE PIDE UN PRODUCTO: UNA SOLA REGLA PARA LA MESA Y PARA `/compras/pedido`.**
 *
 * D33 (PM, 2026-11-04): se pide al llegar al punto de reorden, hasta el objetivo, en las dos
 * pantallas. Antes la mesa de `/almacen/autoabasto` (vía `criticalStock`) sólo listaba lo que estaba
 * en o bajo el reorden, y Pedido pedía todo lo que faltara para el objetivo aunque alcanzara: medido
 * el 2026-11-04, **681 renglones ($2.9 M)** que Pedido pedía y la mesa no, la diferencia más grande
 * entre las dos (PQ.43). Pedir arriba del reorden son pedidos chicos y frecuentes de lo que todavía
 * alcanza; se retoma cuando la agenda de proveedores tenga fechas confiables (PQ.3).
 *
 * Las dos leen la misma existencia (`analytics.replenishment_plan.stock_pz`) y el mismo reorden
 * (`commercial.reorder_policy.reorder_point`), en la unidad nativa del almacén. Por eso la regla se
 * escribe UNA vez, aquí, y no dos veces parecidas.
 *
 * ⚠️ Sin punto de reorden (el almacén no tiene política para ese producto) Pedido **no frena**: no
 * hay contra qué comparar, y frenar ocultaría la necesidad. La mesa no lista esos productos (parte de
 * la política). Medido en PQ.43: 1 de 718.
 *
 * Pendiente de PQ.44 (no está aquí): cobertura por almacén como base en Pedido (D25).
 */

/** ¿Está en o bajo su punto de reorden? Expresiones SQL en la MISMA unidad. */
export const bajoReorden = (existencia: string, reorden: string): string => `(${existencia} <= ${reorden})`;

/**
 * La cantidad sugerida sólo si toca pedir (D33); si no, 0. Sin reorden (NULL) se deja pasar: ver
 * arriba.
 */
export const segunReorden = (existencia: string, reorden: string, cantidad: string): string =>
  `(CASE WHEN ${reorden} IS NULL OR ${bajoReorden(existencia, reorden)} THEN ${cantidad} ELSE 0 END)`;

/**
 * ¿El reorden frenó una cantidad que SÍ faltaba? Es la marca con la que la pantalla dice por qué una
 * celda sale en 0. Sólo ahí: arriba del reorden está la mitad de las celdas (12,579 de 25,241,
 * medido 2026-11-04), y a casi todas ya no les falta nada; decirlo en todas sería ruido.
 */
export const frenadoPorReorden = (existencia: string, reorden: string, cantidad: string): string =>
  `(${reorden} IS NOT NULL AND NOT ${bajoReorden(existencia, reorden)} AND ${cantidad} > 0)`;

/**
 * D26 (PM, 2026-11-04): el inflado por cumplimiento del proveedor sólo en lo que se le COMPRA. Un
 * traspaso de la matriz no depende de lo que surta el proveedor; la mesa nunca lo infló.
 *
 * El canal sale de `commercial.replenishment_channel` (cómo llegó de verdad la mercancía de ese
 * proveedor a ese almacén). Contrastado contra Kepler el 2026-11-04: de 1,356 pares «traspaso», 40
 * (3 %) tienen entradas de compra `X-A-40` de ese proveedor en 90 días. Sin canal se infla como antes.
 */
export const cumplimientoSoloCompra = (esTraspaso: string, factor: string): string =>
  `(CASE WHEN ${esTraspaso} THEN 1.0 ELSE ${factor} END)`;
