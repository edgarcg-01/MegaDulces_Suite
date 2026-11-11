/**
 * `[MCP.18]` Lo que se lee de la base para los justificantes: los «Corregir» y las cancelaciones de la
 * historia del pedido, con el nombre de quien los hizo. Una consulta para todos los pedidos de la
 * pantalla (nunca una por pedido).
 */
import type { Knex } from 'knex';
import type { FilaHistoria } from './justificantes.engine';

export async function historiaDeCambios(trx: Knex | Knex.Transaction, orderIds: string[]): Promise<Map<string, FilaHistoria[]>> {
  const out = new Map<string, FilaHistoria[]>();
  const ids = [...new Set((orderIds ?? []).filter(Boolean))];
  if (!ids.length) return out;
  const { rows } = await trx.raw(
    `SELECT h.order_id, h.from_status, h.to_status, h.reason, h.changed_at,
            coalesce(nullif(btrim(u.nombre), ''), h.changed_by_username) AS by_name,
            (h.changed_by IS NOT NULL AND h.changed_by = o.user_id) AS by_seller
       FROM commercial.order_status_history h
       JOIN commercial.orders o ON o.id = h.order_id AND o.tenant_id = h.tenant_id
       LEFT JOIN identity.users u ON u.id = h.changed_by
      WHERE h.order_id = ANY(?::uuid[])
        AND ((h.to_status = 'draft' AND h.from_status IN ('confirmed', 'pending_approval')) OR h.to_status = 'cancelled')
      -- Empate de hora (la misma transacción): la cancelación es lo último que le pasa a un pedido.
      ORDER BY h.changed_at ASC, (h.to_status = 'cancelled') ASC`,
    [ids],
  );
  for (const r of rows as Array<FilaHistoria & { order_id: string }>) {
    const lista = out.get(r.order_id) ?? [];
    lista.push({
      from_status: r.from_status ?? null,
      to_status: r.to_status,
      reason: r.reason ?? null,
      changed_at: r.changed_at,
      by_name: r.by_name ?? null,
      by_seller: !!r.by_seller,
    });
    out.set(r.order_id, lista);
  }
  return out;
}
