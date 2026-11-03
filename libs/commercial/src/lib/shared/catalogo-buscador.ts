import type { Knex } from 'knex';
import { applySmartSearch } from '@megadulces/platform-core';
import { PALABRAS_RELLENO, SINONIMOS_CATALOGO } from '../commercial-quotes/catalog-search-terms';

/**
 * La consulta INTERNA del buscador del catálogo por sucursal (`[COT.16]`): cada palabra tiene que
 * aparecer en el nombre o el SKU, en cualquier orden, con el vocabulario del dictado; el código de
 * barras va aparte y por igualdad exacta. Orden: SKU exacto → código exacto → prefijo de SKU → lo que
 * MÁS SE VENDE en la sucursal (`analytics.product_demand`, 30 d) → nombre → SKU.
 *
 * Movida aquí sin cambiar una línea desde `CommercialQuotesService.searchCatalog` cuando apareció el
 * segundo consumidor (`[NP.7.L.10]`, el buscador de respaldo del levantamiento): regla 16 / ADR-056.
 *
 * ⚠️ Devuelve la consulta interna con el LIMIT ya puesto. Quien la envuelva tiene que REPETIR el mismo
 * ORDER BY afuera (`ORDEN_BUSCADOR_CATALOGO`; `v.revenue` es columna de esta consulta): el de adentro
 * decide qué entra al LIMIT y el de afuera el orden que se muestra.
 * ⚠️ Selecciona PRECIOS (`piece_price`, `box_price`) y venta (`revenue`): quien no deba verlos (el
 * levantamiento) los quita en su SELECT de afuera, con lista blanca.
 * ⚠️ No valida alcance: la compuerta de sucursal es de cada servicio.
 */
export function consultaBuscadorCatalogo(knex: Knex | Knex.Transaction, suc: string, term: string, n: number): Knex.QueryBuilder {
  const demanda = knex
    .select(knex.raw('btrim(p.sku) AS sku'), knex.raw('max(d.revenue) AS revenue'))
    .from('analytics.product_demand as d')
    .join('commercial.warehouses as w', function () {
      this.on('w.id', '=', 'd.warehouse_id').andOn('w.tenant_id', '=', 'd.tenant_id');
    })
    .join('catalog.products as p', function () {
      this.on('p.id', '=', 'd.product_id').andOn('p.tenant_id', '=', 'd.tenant_id');
    })
    .whereRaw('d.tenant_id = public.current_tenant_id()')
    .where('w.code', suc)
    .whereNull('w.deleted_at')
    .whereNull('p.deleted_at')
    .groupByRaw('btrim(p.sku)');

  const inner = knex
    .select('v.sku', 'v.name', 'v.content', 'v.barcode', 'v.unit_base', 'v.piece_price', 'v.pack_size', 'v.box_size', 'v.box_price', 'v.sold_by_kg', 'dem.revenue')
    .from('analytics.v_label_prices as v')
    .leftJoin(demanda.as('dem'), 'dem.sku', 'v.sku')
    .where('v.sucursal', suc)
    .orderByRaw(
      `CASE WHEN upper(v.sku) = upper(?) THEN 0
            WHEN v.barcode = ?          THEN 1
            WHEN v.sku ILIKE ?          THEN 2
            ELSE 3 END,
       dem.revenue DESC NULLS LAST,
       v.name NULLS LAST,
       v.sku`,
      [term, term, `${term}%`],
    )
    .limit(n);
  if (term) {
    inner.andWhere((g) => {
      g.where('v.barcode', term).orWhere((porPalabras) =>
        applySmartSearch(porPalabras, term, {
          columns: ['v.name', 'v.sku'],
          fuzzy: false,
          stem: true,
          synonyms: SINONIMOS_CATALOGO,
          ignore: PALABRAS_RELLENO,
        }),
      );
    });
  }
  return inner;
}

/** El ORDER BY que se repite afuera, con bindings nombrados `:term` y `:pre` (= `term + "%"`). */
export const ORDEN_BUSCADOR_CATALOGO = `
  CASE WHEN upper(v.sku) = upper(:term) THEN 0
       WHEN v.barcode = :term          THEN 1
       WHEN v.sku ILIKE :pre           THEN 2
       ELSE 3 END,
  v.revenue DESC NULLS LAST,
  v.name NULLS LAST,
  v.sku`;
