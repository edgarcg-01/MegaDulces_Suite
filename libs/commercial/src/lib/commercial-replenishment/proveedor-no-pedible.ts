/**
 * `[PQ.145]` — **Un proveedor que Kepler marcó «no usar» no se ofrece en el Pedido.**
 *
 * Pedido de Edgar (2026-11-23): *«quitemos los productos de inhabilitado del menú de pedido»*.
 *
 * ---
 *
 * ## Qué marca Kepler, y dónde lo escribe
 *
 * Kepler **no tiene una bandera** de proveedor dado de baja: lo dice **renombrándolo**. El acreedor
 * sigue existiendo, con sus ligas producto→proveedor intactas, y el único rastro de que ya no se le
 * compra es su nombre en `kepler_ods.kdxd.c3`. Medido en prod el 2026-11-23, los nombres que
 * aparecen en el Pedido con esa marca:
 *
 * | código | nombre en Kepler | canales | productos activos |
 * |---|---|---:|---:|
 * | `CD43`  | `INHABILITADO`                  | 6 | 1 |
 * | `CR015` | `ROMPOPE DON AGUSTIN (NO USAR)` | 9 | 3 |
 *
 * ⛔ **La bandera `catalog.suppliers.activo` NO sirve para esto**: medida el mismo día, está en
 * `true` en **1,034 de 1,034** proveedores vivos. Nadie la puso jamás en `false`, así que filtrar por
 * ella no quitaría nada. Por eso la regla lee el NOMBRE, que es donde está el hecho.
 *
 * ---
 *
 * ## ⭐ Lo que esto NO excluye, y por qué importa
 *
 * El comodín **`00001 PRODUCTOS SIN PROVEEDOR ASIGNADO` se queda**. Parece de la misma familia y no
 * lo es: no dice «no le compres», dice «todavía nadie dijo a quién comprarle». Medido en prod,
 * cuelgan de él **606 productos activos, 127 con política de reorden en 9 almacenes**. Sacarlo del
 * menú escondería 127 renglones de compra reales sin avisarle a nadie — que es exactamente el modo
 * de que un faltante nazca de una limpieza. La regla de «sin proveedor» ya vive aparte, en
 * `SIN_PROVEEDOR_EXPR` (`commercial-products/catalogo-detallado.sql.ts`), y hace otra cosa.
 *
 * ---
 *
 * ## Dónde se aplica, y dónde NO
 *
 * Se aplica **sólo donde se OFRECE comprarle a alguien**: el selector de proveedores
 * (`filters`), la lista «Qué toca» por canal (`worklist`) y la agenda por proveedor
 * (`worklistProveedores`).
 *
 * ⛔ **No se aplica a Existencia Crítica ni al workbook.** Ahí la fila es el PRODUCTO, no el
 * proveedor, y esconderla haría desaparecer demanda real: el único producto de `INHABILITADO`
 * (SKU 10211, GALL ARTESANALES DE AVENA /12) **se sigue comprando** — a `CM036` desde octubre —, y
 * lo que está mal es la liga que Kepler no actualizó, no el producto. Quitarlo del menú deja de
 * invitar a pedirle a un proveedor muerto; quitarlo del catálogo del pedido lo dejaría sin pedir.
 *
 * ---
 *
 * ## Antes y después (prod, 2026-11-23, sólo lectura)
 *
 * | lo que lista | hoy | con la regla |
 * |---|---:|---:|
 * | canales «Qué toca» (almacén × proveedor) | 1,865 | 1,851 |
 * | agenda por proveedor | 296 | 294 |
 * | selector de proveedores | 327 | 325 |
 *
 * La causa de fondo —la liga producto→proveedor vieja en Kepler— **la arregla Compras en Kepler**,
 * no la Suite: cuando el 10211 quede ligado a `CM036`, la fila desaparece sola y esta regla deja de
 * tener a quién esconder.
 */

/**
 * Las marcas con las que Kepler dice «a éste ya no se le compra», dentro del nombre del acreedor.
 *
 * ⚠️ Es la MISMA familia de etiquetas que `commercial-replenishment.service.ts` ya excluye del
 * selector de **categorías** de compra (`ELIMINAR|BAJA ROTAC|OBSOLET|DESCONTINU|NO USAR|NO UTILIZAR`).
 * Acá va sólo el subconjunto que se midió sobre nombres de PROVEEDOR: las de ciclo de vida de
 * producto (`OBSOLETO`, `DESCONTINUADO`) no aparecen en ningún acreedor y agregarlas sin medirlas
 * sería ampliar el filtro por analogía.
 */
export const PROVEEDOR_NO_PEDIBLE_RX = '(INHABILITAD|NO USAR|NO UTILIZAR)';

/**
 * La condición SQL de **«a este proveedor sí se le puede pedir»**, para el `WHERE`.
 *
 * ⛔ El `coalesce` no es cosmético: el join al proveedor es `LEFT`, y `NULL !~* '…'` da **NULL**, que
 * en un `WHERE` descarta la fila. Sin él, un canal cuyo `supplier_id` ya no existe en
 * `catalog.suppliers` desaparecería del menú en silencio — un efecto que nadie pidió, sobre filas
 * que justamente hay que ver.
 *
 * @param alias el alias del `catalog.suppliers` en la consulta (p. ej. `sup`)
 */
export function proveedorPedibleSql(alias: string): string {
  return `coalesce(${alias}.name, '') !~* '${PROVEEDOR_NO_PEDIBLE_RX}'`;
}

/**
 * La misma regla en TypeScript, para poder probarla sin base. Un nombre vacío o ausente **sí** es
 * pedible: la ausencia de nombre no es una marca de baja (ver el `coalesce` de arriba).
 */
export function proveedorEsPedible(name: string | null | undefined): boolean {
  return !new RegExp(PROVEEDOR_NO_PEDIBLE_RX, 'i').test(name ?? '');
}
