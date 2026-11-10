/* eslint-disable no-console */
/**
 * `[CAT.ABA.1]` — **Abarrotes SÍ se vende: 219 productos con precio dejan de estar escondidos.**
 *
 * Reporte de Edgar, 2026-11-09: *«el producto jabón roma y sopa maruchan no le aparecen al
 * vendedor»*. Medido en prod (sólo lectura) antes de tocar nada.
 *
 * ── La causa ────────────────────────────────────────────────────────────────────────────────
 * No es el precio: `JABON ROMA 1 KG / 1` ($40.44), `250GR` ($11.05), `500G` ($20.96) y las tres
 * `SOPA MARUCHAN …/12` ($14.89) **tienen precio en «Lista base (MXN)»** y aun así no aparecen.
 *
 * Los esconde la MARCA. Su marca es `ABARROTES`, con `is_commercial = false`, y las tres apps
 * cliente-facing piden `commercial_only=true` (`apps/vendor`, `apps/portal`, `apps/view`), que el
 * servicio traduce a `WHERE b.is_commercial = true OR b.is_commercial IS NULL`.
 *
 * **Lo que la bandera oculta hoy, medido:**
 *
 *     ABARROTES .................. 115 productos · 106 con precio
 *     MEGA DULCES DE LOS ALTOS ....  95 productos ·  94 con precio
 *     ABARROTES LA VIOLETA ........  19 productos ·  19 con precio
 *     TOTAL ....................... 229 productos · 219 con precio
 *
 * ⭐ **219 productos con precio que ningún vendedor podía pedir.** El reporte nombró dos; eran la
 * punta.
 *
 * ── De dónde salió la bandera, y por qué estaba mal ─────────────────────────────────────────
 * `20260602150000_brands_is_commercial_flag.js` marcó **18 marcas por NOMBRE** en una sola lista,
 * y esa lista mezcló tres cosas distintas:
 *
 *   - operativo/administrativo real: `PRODUCTOS A ELIMINAR`, `ADMINISTRATIVO`, `PROMOCIONES`,
 *     `PROMOCIONES ESPECIALES`, `RIFA ROSI` — correcto esconderlas.
 *   - razones sociales de proveedor: `BOLSAS DE LOS ALTOS`, `POLIETILENOS DEL CENTRO`,
 *     `JOSE IVAN VELAZQUEZ JUAREZ`.
 *   - ⛔ **mercancía que SÍ se vende**: `ABARROTES`, `ABARROTES LA VIOLETA`,
 *     `MEGA DULCES DE LOS ALTOS`.
 *
 * ⭐ Y hay precedente: `PRODUCTOS VARIOS` estaba en esa misma lista y hoy aparece con
 * `is_commercial = true` — alguien ya la corrigió a mano, sin migración que lo registre.
 *
 * **Decisión (Edgar, 2026-11-09): «sí deben verse, no debemos esconder nada».**
 *
 * ── ⚠️ Lo que esto cambia, que es más que el catálogo del vendedor ──────────────────────────
 * La bandera gatea **siete** consumidores, y los 229 productos aparecen en todos:
 * `commercial-pricing` (catálogo del vendedor y del portal), `commercial-catalog-search`,
 * `commercial-findings`, `push-directives`, `thot.service` (sugeridos), y las vistas
 * `public.products_active` y la FDW del verificador de precios.
 *
 * Eso es lo pedido —no esconder nada—, pero **no es sólo una pantalla**: el buscador, los
 * sugeridos de Thot y el verificador de la tienda también los van a mostrar.
 *
 * ── ⛔ Lo que esta migración NO arregla ─────────────────────────────────────────────────────
 * Cinco productos siguen sin verse **por falta de precio**, no por la marca, porque
 * `priced_only` convierte el `LEFT JOIN` a `product_prices` en `INNER`:
 *
 *     IND SOPA MARUCHAN CAMARON (00641) · … Y CHILE HABANERO (00640) · … Y CHILE PIQ (00639)
 *     JABON ROMA 1KG (sin SKU) · SOPA MARUCHAN CAMARON (sin SKU)
 *
 * Esos necesitan que alguien les ponga precio en «Lista base (MXN)»: es trabajo de oficina, no de
 * migración. **Queda declarado, no escondido.**
 *
 * ⚠️ Y un hallazgo aparte que conviene medir: cada producto aparece **dos veces** —uno con SKU
 * (`JABON ROMA 500G / 1`) y otro sin SKU (`JABON ROMA 500G`)— **con precios distintos**
 * ($20.96 contra $20.568). Duplicado de catálogo, no de esta fase.
 */
'use strict';

/** Las tres marcas que son mercancía, no administración. Por nombre, como la migración original. */
const SON_COMERCIALES = [
  'ABARROTES',
  'ABARROTES LA VIOLETA',
  'MEGA DULCES DE LOS ALTOS',
];

exports.up = async function up(knex) {
  // Antes: para que el log del apply deje la cifra, no sólo la intención.
  const antes = await knex('brands')
    .whereIn('nombre', SON_COMERCIALES)
    .whereNull('deleted_at')
    .select('nombre', 'is_commercial');
  console.log('  antes:', antes.map((b) => `${b.nombre}=${b.is_commercial}`).join(' · ') || '(ninguna)');

  /**
   * Idempotente: si ya están en true, no toca nada.
   *
   * ⛔ **`updated_by` NO se escribe, y no es un olvido.** Es `uuid` (apunta a un usuario), no
   * texto: el primer intento puso ahí la etiqueta `migracion [CAT.ABA.1]` y prod lo rechazó con
   * `invalid input syntax for type uuid`. Una migración no tiene usuario, así que la huella de
   * quién lo cambió vive en el ledger (`knex_migrations`) y en este archivo, no en la fila.
   */
  const tocadas = await knex('brands')
    .whereIn('nombre', SON_COMERCIALES)
    .whereNull('deleted_at')
    .where('is_commercial', false)
    .update({ is_commercial: true, updated_at: knex.fn.now() });
  console.log(`  ✓ ${tocadas} marca(s) pasaron a comercial`);

  /**
   * ⛔ El índice parcial `WHERE is_commercial = true` que creó la migración original ahora cubre
   * 229 filas más. No hay que recrearlo —Postgres lo mantiene solo— pero sí conviene refrescar
   * las estadísticas: el planner de `products_active` las usa y venían de un universo más chico.
   */
  await knex.raw('ANALYZE brands');

  const despues = await knex('brands')
    .whereIn('nombre', SON_COMERCIALES)
    .whereNull('deleted_at')
    .select('nombre', 'is_commercial');
  console.log('  despues:', despues.map((b) => `${b.nombre}=${b.is_commercial}`).join(' · '));
};

/**
 * ⛔ `down` deliberadamente NO-OP. Volver atrás vuelve a esconder 219 productos con precio, que es
 * el defecto que esto corrige, y lo haría sin que nadie se entere — exactamente como pasó en
 * junio. Si hubiera que revertir, va una migración nueva que diga por qué y a cuáles.
 */
exports.down = async function down() {};
