import type { Knex } from 'knex';

/**
 * `[CE.2.3]` **El traspaso trae la fecha de quien lo mandó** (Anexo CE de la Fase WMS).
 *
 * Medido el 2026-11-11 (prod, 60 días): los traspasos entre almacenes suman ~19,600 renglones contra
 * 11,583 de compras, y salen sobre todo de Padre Hidalgo, CEDIS y Morelia Abastos. Si el origen fechó
 * su entrada, la sucursal que recibe no tiene por qué volver a leer la etiqueta desde cero: se le
 * PROPONE el lote que el origen despacharía primero por FEFO (el más próximo a vencer que no esté
 * vencido, como el trigger `fn_rebalance_stock_lots`), y el operario lo confirma con la etiqueta.
 *
 * ⚠️ Es una propuesta, nunca un dato: Kepler no descuenta por lote, y mientras el origen tenga
 * existencia sin fecha (`NA`) sus lotes fechados no bajan con la venta (CE.1.4), así que el lote
 * propuesto puede ya no ser el que viajó. Por eso no se guarda nada hasta que alguien lo confirma.
 */

export interface SugerenciaOrigen {
  lot_code: string;
  expiry_date: string; // YYYY-MM-DD
  origin_name: string | null;
}

/** El almacén de la suite que corresponde a una sucursal de Kepler (mapa, si no por código). */
export async function almacenDeSucursal(
  trx: Knex | Knex.Transaction,
  sucursal: string,
): Promise<{ id: string; name: string | null } | null> {
  const porMapa = await trx('commercial.erp_sucursal_warehouse as m')
    .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
      this.on('w.tenant_id', '=', 'm.tenant_id').andOn('w.id', '=', 'm.warehouse_id');
    })
    .where('m.sucursal', sucursal)
    .whereNull('w.deleted_at')
    .first('w.id', 'w.name');
  if (porMapa) return porMapa;
  const porCodigo = await trx('commercial.warehouses').where({ code: sucursal }).whereNull('deleted_at').first('id', 'name');
  return porCodigo ?? null;
}

/**
 * El lote que el almacén de origen despacharía primero, por producto. Una consulta.
 * Sólo lotes fechados, con existencia y no vencidos; desempata por cantidad (el más grande).
 */
export async function sugerenciasDeOrigen(
  trx: Knex | Knex.Transaction,
  origen: { id: string; name: string | null } | null,
  productIds: string[],
): Promise<Map<string, SugerenciaOrigen>> {
  const out = new Map<string, SugerenciaOrigen>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!origen || !ids.length) return out;
  const { rows } = await trx.raw(
    `SELECT DISTINCT ON (sl.product_id)
            sl.product_id, sl.lot_code, to_char(sl.expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM commercial.stock_lots sl
      WHERE sl.warehouse_id = ? AND sl.product_id = ANY(?::uuid[])
        AND sl.quantity > 0 AND sl.expiry_date IS NOT NULL
        AND sl.expiry_date >= (now() AT TIME ZONE 'America/Mexico_City')::date
      ORDER BY sl.product_id, sl.expiry_date ASC, sl.quantity DESC`,
    [origen.id, ids],
  );
  for (const r of rows)
    out.set(r.product_id, { lot_code: r.lot_code, expiry_date: r.expiry_date, origin_name: origen.name ?? null });
  return out;
}
