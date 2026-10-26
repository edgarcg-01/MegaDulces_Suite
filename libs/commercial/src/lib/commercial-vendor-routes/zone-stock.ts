import type { Knex } from 'knex';
import type { VendorZoneStockResponse, ZoneWarehouse } from '@megadulces/contracts';

/**
 * `[MCP.3.12]` Existencias de las sucursales de la zona de `sucursalId`, para la tira de la toma
 * de pedido. La zona es `commercial.warehouses.purchase_zone` (ver el contrato).
 *
 * Sólo lectura. Lo que no se puede medir se declara en `unmeasured_reason`, nunca como ceros.
 */
export async function zoneStock(trx: Knex | Knex.Transaction, sucursalId: string | null): Promise<VendorZoneStockResponse> {
  const vacio = (reason: string, zone: string | null = null): VendorZoneStockResponse => ({
    zone, warehouses: [], stock: {}, unmeasured_reason: reason,
  });
  if (!sucursalId) return vacio('No tienes sucursal de surtido asignada.');

  const mia = (await trx('commercial.warehouses')
    .where({ id: sucursalId })
    .whereNull('deleted_at')
    .select('id', 'purchase_zone')
    .first()) as { id: string; purchase_zone: string | null } | undefined;
  if (!mia) return vacio('Tu sucursal de surtido no existe o está dada de baja.');
  const zona = (mia.purchase_zone || '').trim();
  if (!zona) return vacio('Tu sucursal no tiene zona declarada (purchase_zone).');

  // Las centrales activas de la zona: la del vendedor primero, luego el orden del catálogo.
  const whs = (await trx('commercial.warehouses')
    .where({ kind: 'central', active: true, purchase_zone: zona })
    .whereNull('deleted_at')
    .orderByRaw('(id = ?) DESC, display_order ASC NULLS LAST, kepler_code ASC', [sucursalId])
    .select('id', 'kepler_code', 'short_label', 'name')) as {
      id: string; kepler_code: string | null; short_label: string | null; name: string;
    }[];
  if (!whs.length) return vacio('Tu zona no tiene sucursales activas.', zona);

  const ids = whs.map((w) => w.id);
  const [filas, edades] = await Promise.all([
    trx.raw(
      `SELECT s.product_id, s.warehouse_id,
              GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0)::float8 AS q
         FROM commercial.stock s
        WHERE s.warehouse_id = ANY(?::uuid[])`,
      [ids],
    ),
    trx.raw(
      `SELECT s.warehouse_id, max(s.updated_at) AS as_of
         FROM commercial.stock s
        WHERE s.warehouse_id = ANY(?::uuid[])
        GROUP BY s.warehouse_id`,
      [ids],
    ),
  ]);

  const pos = new Map(ids.map((id, i) => [id, i]));
  const stock: Record<string, (number | null)[]> = {};
  for (const r of filas.rows as { product_id: string; warehouse_id: string; q: number | string }[]) {
    const i = pos.get(r.warehouse_id);
    if (i == null) continue;
    const fila = stock[r.product_id] ?? (stock[r.product_id] = ids.map(() => null));
    fila[i] = Number(r.q) || 0;
  }
  // Sólo lo que tiene existencia en alguna sucursal: lo demás es «sin existencias en la zona».
  for (const k of Object.keys(stock)) if (!stock[k].some((q) => (q ?? 0) > 0)) delete stock[k];

  const edadDe = new Map(
    (edades.rows as { warehouse_id: string; as_of: Date | string | null }[]).map((e) => [
      e.warehouse_id,
      e.as_of == null ? null : new Date(e.as_of).toISOString(),
    ]),
  );
  const warehouses: ZoneWarehouse[] = whs.map((w) => ({
    id: w.id,
    code: w.kepler_code ?? '',
    short: (w.short_label || '').trim() || w.kepler_code || w.name,
    name: w.name,
    mine: w.id === sucursalId,
    as_of: edadDe.get(w.id) ?? null,
  }));
  return { zone: zona, warehouses, stock, unmeasured_reason: null };
}
