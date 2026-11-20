/**
 * `[MCP.28]` `[MCP.30]` El buscador de pedidos de la app del vendedor: «Mis pedidos» (los que levantó,
 * de cualquier día) y «Por entregar» (los abiertos de su cartera, más allá de los 200 que caben en la lista).
 *
 * Un solo motor para los dos (ADR-056): `applySmartSearch` en modo ESTRICTO — cada palabra tiene que
 * aparecer, en cualquier orden y campo, sin acentos ni mayúsculas — con las palabras de 1–2 caracteres
 * COMPLETAS («ruta 4» no trae el folio 01364). Dónde busca: folio, cliente, su clave de Kepler, los
 * productos del pedido y quién lo levantó; el monto, si lo escrito es un número.
 */
import { BadRequestException } from '@nestjs/common';
import type { Knex } from 'knex';
import { applySmartSearch, type SmartSearchOptions } from '@megadulces/platform-core';

/** Lo más corto que se busca: una letra suelta traería media cartera. */
export const BUSQUEDA_MINIMO = 2;
/** Lo más largo que se acepta (un folio, un cliente y dos productos caben de sobra). */
export const BUSQUEDA_MAXIMO = 80;
/** «Mis pedidos»: hasta dónde busca hacia atrás, por día en que se levantó (D2 de David, 2026-11-20). */
export const BUSQUEDA_DIAS = 60;
/** Cuántos devuelve como máximo; si hubo más, la respuesta lo dice (`truncated`). */
export const BUSQUEDA_TOPE = 30;

/** Cómo busca (igual en las dos pantallas): estricto, palabras cortas completas, el monto si es número. */
export const BUSQUEDA_MODO: Pick<SmartSearchOptions, 'numeric' | 'fuzzy' | 'wholeWordUpTo'> = {
  numeric: ['o.total'],
  fuzzy: false,
  wholeWordUpTo: 2,
};

/** «Mis pedidos»: columnas de texto con los alias de {@link buscarEnPedidos}. `lp` = {@link PRODUCTOS_DEL_PEDIDO_SQL}. */
export const BUSQUEDA_OPCIONES: SmartSearchOptions = {
  ...BUSQUEDA_MODO,
  columns: ['o.code', 'c.name', 'c.erp_customer_code', 'lp.productos', 'su.nombre', 'su.username'],
};

/** Los productos del pedido en un solo texto (nombre y clave), para buscar «payaso» o un SKU. */
export const PRODUCTOS_DEL_PEDIDO_SQL = `LEFT JOIN LATERAL (
    SELECT string_agg(concat_ws(' ', p.nombre, p.sku), ' ') AS productos
      FROM commercial.order_lines ol
      LEFT JOIN public.products p ON p.id = ol.product_id
     WHERE ol.order_id = o.id AND ol.tenant_id = o.tenant_id
  ) lp ON true`;

/**
 * Lo escrito, listo para buscar: recortado y con su largo validado. Lanza 400 si es muy corto (la pantalla
 * no llama con menos de {@link BUSQUEDA_MINIMO}; si llega, es otra app y se le dice por qué).
 */
export function textoDeBusqueda(q: unknown): string {
  const texto = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, BUSQUEDA_MAXIMO) : '';
  const util = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]/g, '');
  if (util.length < BUSQUEDA_MINIMO) {
    throw new BadRequestException(`Escribe al menos ${BUSQUEDA_MINIMO} letras o números para buscar.`);
  }
  return texto;
}

/**
 * Le pone al query de pedidos (alias `o`) lo que el buscador necesita: cliente `c`, quien lo levantó `su`,
 * los productos `lp` y el filtro de lo escrito. No ordena ni limita: eso lo decide quien llama.
 */
export function buscarEnPedidos(qb: Knex.QueryBuilder, texto: string): Knex.QueryBuilder {
  qb.leftJoin('commercial.customers as c', function () {
    this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
  })
    .leftJoin('public.users as su', 'su.id', 'o.user_id')
    .joinRaw(PRODUCTOS_DEL_PEDIDO_SQL);
  applySmartSearch(qb, texto, BUSQUEDA_OPCIONES);
  return qb;
}
