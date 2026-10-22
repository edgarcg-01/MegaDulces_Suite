/**
 * `[RA-UX.1b]` **EL LOTE QUE YA SE GENERÓ NO SE VUELVE A GENERAR SIN QUE ALGUIEN LO DIGA.**
 *
 * ── Por qué existe, medido en prod el 2026-10-21 ────────────────────────────────────────────
 *
 * Tras «Generar», `/compras/pedido` dejaba cantidades y marcas puestas y el botón armado: **9 de
 * 106 lotes** repetían a otro de la MISMA persona —mismo producto, misma sucursal destino, misma
 * cantidad— a **1.2 min de mediana** (0.1–16.3). La misma ventana corrida 7 días después: **0**.
 * En 5 pares las dos copias seguían vivas: 93 renglones, $264,619, dos ya con OC las dos veces.
 *
 * `[RA-UX.1]` cerró la puerta de la pantalla. Esto es la red del servidor, por dos razones: hay
 * más de una pantalla (y más de una pestaña) que puede mandar el mismo lote, y un arreglo de
 * frontend se deshace en el siguiente refactor sin que nada lo note.
 *
 * ── Qué cuenta como repetido ────────────────────────────────────────────────────────────────
 *
 * Un renglón de COMPRA del lote nuevo que coincide EXACTO —producto, sucursal destino, cantidad—
 * con un renglón de compra NO cancelado que la MISMA persona creó en los últimos
 * `VENTANA_LOTE_REPETIDO_MIN` minutos. Es el mismo criterio con el que se midió, y el placebo
 * a +7 días da 0: no confunde la compra de la semana siguiente con un doble clic.
 *
 * ⛔ No BLOQUEA para siempre: el servidor contesta 409 con lo que encontró y la pantalla ofrece
 * «Generar de todos modos» (`allow_duplicate`). Pedir dos veces lo mismo en una hora puede ser
 * legítimo; hacerlo sin enterarse, no.
 *
 * ⚠️ Los traspasos (`source_type='branch'`) no entran: no le piden nada a un proveedor, y una
 * bajada repetida se nota en el almacén antes de costar dinero.
 *
 * Módulo PURO (sin Nest) a propósito: la prueba de base `test-newdb-lote-repetido.js` lo carga con
 * ts-node y corre ESTE MISMO SQL contra datos reales. Una copia del SQL en la prueba se quedaría
 * verde midiendo algo que ya nadie ejecuta.
 */

/** Minutos hacia atrás en que un renglón idéntico cuenta como el mismo pedido. */
export const VENTANA_LOTE_REPETIDO_MIN = 60;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo mínimo que se lee de cada documento del lote (estructural: no depende del DTO de Nest). */
export interface DocLote {
  warehouse_id?: string | null;
  source_type?: string | null;
  lines?: Array<{
    product_id?: string | null;
    source_type?: string | null;
    destination_warehouse_id?: string | null;
    final_qty?: number | string | null;
  }> | null;
}

/** Un renglón de compra, en la forma con que se compara. */
export interface RenglonCompra { product_id: string; destino: string; qty: number; }

/**
 * Los renglones de COMPRA del lote. El destino es el del renglón (`[RA-FIX.1]`) y, si no viene,
 * el del encabezado — el mismo `COALESCE` que hace el SQL del lado de lo ya guardado.
 */
export function renglonesDeCompra(docs: DocLote[]): RenglonCompra[] {
  const out: RenglonCompra[] = [];
  for (const d of docs || []) {
    if (d?.source_type === 'branch') continue;
    for (const l of d?.lines || []) {
      if (!l || l.source_type === 'branch') continue;
      const qty = Number(l.final_qty);
      if (!(qty > 0)) continue;
      const destino = l.destination_warehouse_id || d.warehouse_id || '';
      if (!UUID_RX.test(String(l.product_id || '')) || !UUID_RX.test(destino)) continue;
      out.push({ product_id: String(l.product_id), destino, qty });
    }
  }
  return out;
}

/**
 * Bindings: `[tenant_id, renglones_json, user_id, ahora, ventana_min, ahora]`.
 * `ahora` es parámetro y no `now()` para que la prueba pueda REPRODUCIR un duplicado histórico
 * parándose en el instante en que se creó.
 */
export const SQL_LOTE_REPETIDO = `
  WITH nuevo AS (
    SELECT (x->>'product_id')::uuid AS product_id,
           (x->>'destino')::uuid    AS destino,
           (x->>'qty')::numeric     AS qty
      FROM jsonb_array_elements(?::jsonb) x
  ), previo AS (
    SELECT COALESCE(r.batch_folio, r.folio)                     AS lote,
           r.created_at,
           l.product_id,
           COALESCE(l.destination_warehouse_id, r.warehouse_id)  AS destino,
           l.final_qty
      FROM commercial.purchase_requisitions r
      JOIN commercial.purchase_requisition_lines l
        ON l.tenant_id = r.tenant_id AND l.requisition_id = r.id
     WHERE r.tenant_id = ?
       AND r.created_by = ?
       AND r.source_type = 'supplier'
       AND r.estado <> 'cancelled'
       AND l.final_qty > 0
       AND r.created_at >= ?::timestamptz - make_interval(mins => ?::int)
       AND r.created_at <  ?::timestamptz
  )
  -- DISTINCT sobre el renglón NUEVO: si ya se pidió dos veces, sigue siendo UN renglón repetido.
  SELECT count(DISTINCT n.product_id::text || '|' || n.destino::text || '|' || n.qty::text)::int AS renglones,
         COALESCE(array_agg(DISTINCT p.lote), '{}')   AS lotes,
         max(p.created_at)                            AS ultimo
    FROM nuevo n
    JOIN previo p ON p.product_id = n.product_id AND p.destino = n.destino AND p.final_qty = n.qty`;

/** Lo que se encontró. `null` = el lote no repite nada. */
export interface LoteRepetido { renglones: number; de: number; lotes: string[]; minutos: number; }

/** Lo único que se le pide a la conexión: Knex, una transacción o un SAVEPOINT de Knex. */
export interface RawRunner { raw(sql: string, bindings: unknown[]): PromiseLike<{ rows: Array<Record<string, unknown>> }>; }

export async function buscarLoteRepetido(
  db: RawRunner,
  a: { tenantId: string; userId: string; docs: DocLote[]; ahora?: Date; ventanaMin?: number },
): Promise<LoteRepetido | null> {
  const renglones = renglonesDeCompra(a.docs);
  if (!renglones.length) return null;
  const ahora = (a.ahora ?? new Date()).toISOString();
  const ventana = a.ventanaMin ?? VENTANA_LOTE_REPETIDO_MIN;
  const res = await db.raw(SQL_LOTE_REPETIDO, [JSON.stringify(renglones), a.tenantId, a.userId, ahora, ventana, ahora]);
  const r = res.rows[0] || {};
  const n = Number(r['renglones'] || 0);
  if (!n) return null;
  const ultimo = r['ultimo'] ? new Date(String(r['ultimo'])) : null;
  const minutos = ultimo ? Math.max(0, Math.round((new Date(ahora).getTime() - ultimo.getTime()) / 60000)) : 0;
  const lotes = (Array.isArray(r['lotes']) ? r['lotes'] : []).map(String).sort();
  return { renglones: n, de: renglones.length, lotes, minutos };
}

/** El mensaje que ve el comprador, con lo que hace falta para decidir: cuánto, cuál y cuándo. */
export function mensajeLoteRepetido(r: LoteRepetido): string {
  const cuando = r.minutos < 1 ? 'hace menos de un minuto' : r.minutos === 1 ? 'hace 1 minuto' : `hace ${r.minutos} minutos`;
  const que = r.renglones === r.de
    ? (r.de === 1 ? 'El renglón de compra de este lote ya lo generaste' : `Los ${r.de} renglones de compra de este lote ya los generaste`)
    : `${r.renglones} de los ${r.de} renglones de compra de este lote ya los generaste`;
  return `${que} ${cuando} (${r.lotes.join(', ')}): mismo producto, misma sucursal y misma cantidad. `
    + 'No se creó nada. Si de verdad quieres pedirlo otra vez, confírmalo.';
}
