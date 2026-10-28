import type { Knex } from 'knex';
import type { VendorZoneStockResponse, ZoneWarehouse } from '@megadulces/contracts';
import { gemelosDe, lecturaDeSucursales, leerExistencia, vistaCanonicaLista } from '../commercial-inventory/stock-state';

/**
 * `[MCP.3.12]` Existencias de las sucursales de la zona de `sucursalId`, para la tira de la toma
 * de pedido. La zona es `commercial.warehouses.purchase_zone` (ver el contrato).
 *
 * `[MCP.3.16]` La existencia sale del resolvedor único (`commercial-inventory/stock-state.ts`): la
 * vista canónica `analytics.v_erp_stock_on_hand` (ya no la copia `commercial.stock`), sin
 * descontar apartados, con el gemelo de cada duplicado legado, y la frescura POR SUCURSAL del
 * carril `ods_live_hot`. Una sucursal con la lectura vieja o caída viaja `stale` y sus celdas en
 * `null` («sin dato»), nunca en 0.
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
    .select('id', 'code', 'kepler_code', 'short_label', 'name')) as {
      id: string; code: string | null; kepler_code: string | null; short_label: string | null; name: string;
    }[];
  if (!whs.length) return vacio('Tu zona no tiene sucursales activas.', zona);

  const lecturas = await lecturaDeSucursales(trx, whs.map((w) => ({ id: w.id, code: w.code })));
  const medidas = whs.filter((w) => lecturas.get(w.id)?.medido).map((w) => w.id);

  // Sólo se lee la existencia de las sucursales al día: la de una lectura vieja no se publica.
  let existencia = new Map<string, Map<string, number>>();
  if (medidas.length) {
    const leida = (await vistaCanonicaLista(trx)) ? await leerExistencia(trx, medidas, null) : null;
    if (!leida) return vacio('No se pudo leer la existencia de tu zona.', zona);
    existencia = leida;
  }

  const ids = whs.map((w) => w.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const stock: Record<string, (number | null)[]> = {};
  for (const [whId, porProducto] of existencia) {
    const i = pos.get(whId);
    if (i == null) continue;
    for (const [productId, q] of porProducto) {
      const fila = stock[productId] ?? (stock[productId] = ids.map(() => null));
      fila[i] = q;
    }
  }
  // El duplicado legado viaja con la existencia de su gemelo, bajo su propio product_id (es el id
  // que trae el renglón del catálogo).
  if (Object.keys(stock).length) {
    for (const [legado, ide] of await gemelosDe(trx, null)) {
      if (ide.twin_product_id && stock[ide.twin_product_id] && !stock[legado]) stock[legado] = [...stock[ide.twin_product_id]];
    }
  }
  // Sólo lo que tiene existencia en alguna sucursal al día: lo demás es «sin existencias en la zona».
  for (const k of Object.keys(stock)) if (!stock[k].some((q) => (q ?? 0) > 0)) delete stock[k];

  const warehouses: ZoneWarehouse[] = whs.map((w) => {
    const lec = lecturas.get(w.id);
    return {
      id: w.id,
      code: w.kepler_code ?? '',
      short: (w.short_label || '').trim() || w.kepler_code || w.name,
      name: w.name,
      mine: w.id === sucursalId,
      as_of: lec?.checked_at ?? null,
      stale: !lec?.medido,
      checked_at: lec?.checked_at ?? null,
    };
  });
  return { zone: zona, warehouses, stock, unmeasured_reason: null };
}
