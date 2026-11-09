import type { Knex } from 'knex';
import { PATRON_PROMOCION_PG, sinExistenciaAfirmada, type StockNoticeState } from '@megadulces/contracts';
import { estadoDeProductos } from '../commercial-inventory/stock-state';

/**
 * `[DN.8]` (ADR-115, anexo A de la fase DN) **El registro de lo que el cliente pidió y puede no
 * haber**, en `commercial.order_stock_notices` (`[DN.6]`).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────────
 * Con el bloqueo de `[MCP.3.16]` el vendedor no podía capturar un producto en 0 y la demanda se
 * perdía sin rastro: medido en prod el 2026-11-07 (misma base, foto de cierre del día anterior),
 * antes del bloqueo el 14.2 % de los renglones de preventa entraban sin existencia (31 de 218); con
 * el bloqueo, el 0.23 % (2 de 857). Compras necesita leer lo que el cliente pide y no hay.
 *
 * ── Los tres pasos (durable aunque el segundo muera) ────────────────────────────────────────────
 *  1. `marcarAlAgendar` — DENTRO de la transacción de `place()`, en un SAVEPOINT: una fila por
 *     renglón con la COPIA del original y `stock_state = 'pendiente'`. No lee existencia (ms), así
 *     que no alarga el `FOR UPDATE` del pedido. Si falla, `place()` sigue: el registro nunca hace
 *     fallar el agendado (en la sincronización sin conexión un 4xx gasta intentos hasta dejar el
 *     pedido «muerto»).
 *  2. `completarRegistro` — DESPUÉS del commit, en otra transacción: lee la existencia de cada
 *     renglón en su sucursal de surtido con el resolvedor de siempre (`estadoDeProductos`, la
 *     vista canónica + la frescura del carril) y completa la fila. Cuesta ~0.4–1.5 s según el
 *     pedido: por eso va fuera del candado.
 *  3. `declararPendientesViejas` — un barrido pasa a `sin_dato` toda fila que siga `pendiente`
 *     después de `MINUTOS_PARA_DECLARAR`: si el paso 2 murió, el hueco queda DECLARADO, nunca
 *     contado como 0 ni como «había» (ADR-056).
 *
 * ── Lo que se guarda ────────────────────────────────────────────────────────────────────────────
 * Todas las filas, también las `con_existencia`: son el denominador de la métrica por versión de la
 * app (`client_build`). La demanda negada son `agotado` y `no_se_maneja` de filas vigentes;
 * `sin_dato` y `pendiente` se declaran aparte. Las promociones (`= GRATIS`) no se registran: su
 * existencia es 0 por construcción (`[MCP.11]`).
 *
 * ── La llave ────────────────────────────────────────────────────────────────────────────────────
 * Una fila VIGENTE por (`order_id`, `product_id`, `source_warehouse_id`): el pedido en el que queda el
 * renglón después de separar por sucursal. Reagendar (reabrir y volver a mandar) reemplaza
 * (`superseded_at`) la vigente de la misma llave y la de un renglón que cambió de sucursal (mismo
 * `order_line_id`), y escribe otra con la lectura nueva; un renglón que se QUITÓ antes de reagendar
 * conserva su fila (fue demanda que el cliente expresó). Las filas con una decisión humana (frente 2:
 * la hoja del vendedor) no se reemplazan desde aquí.
 *
 * ⚠️ La llave por la RAÍZ del grupo (lo que decía el plan) contaba doble y perdía cantidad: reabrir
 * una PARTE y reagendarla le cambia `group_id` en `separarPorSucursal`, y dos partes del grupo pueden
 * pedir lo mismo de la misma sucursal. `root_order_id` queda como dato para agrupar, y se CONSERVA la
 * de las filas anteriores del pedido cuando se reagenda.
 */

/** Minutos que una marca puede quedar `pendiente` antes de que el barrido la declare `sin_dato`. */
export const MINUTOS_PARA_DECLARAR = 10;

/** El motivo que deja el barrido: dice qué pasó, no «no había». */
export const MOTIVO_BARRIDO = 'La revisión de existencia no se completó al agendar (barrido).';

/** Lo que el registro necesita saber de quién agendó. */
export interface OpcionesRegistro {
  userId: string | null;
  /** Versión de la app que agendó, ya saneada (`marcaDeVersion`); `null` = sin marca. */
  clientBuild: string | null;
  /**
   * La raíz del grupo leída ANTES de `separarPorSucursal` (que a una parte reabierta le cambia
   * `group_id`). Se usa sólo si estos pedidos no tienen filas anteriores; si las tienen, manda la de
   * ellas. Sin ella, `COALESCE(group_id, id)` ya separado.
   */
  raizRespaldo?: string | null;
}

/**
 * La versión que manda la app en el cuerpo de `place` (`client_build`), saneada: sólo letras,
 * dígitos y `@ . _ : -`, máximo 60. Cualquier otra cosa es `null`: es un dato de medición, no se
 * guarda texto libre de un cliente.
 */
export function marcaDeVersion(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[A-Za-z0-9@._:-]{1,60}$/.test(s) ? s : null;
}

/** Un renglón del grupo tal como se copia a la fila. */
interface RenglonParaRegistro {
  line_id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
  unit_price: number | null;
  line_total: number | null;
  source_warehouse_id: string;
  order_warehouse_id: string;
  customer_id: string | null;
  user_id: string | null;
  requested_delivery_date: string | null;
  root_order_id: string;
}

/** La fila que se inserta (sin las columnas que pone el SQL). */
interface FilaNueva {
  root_order_id: string;
  order_id: string;
  order_line_id: string;
  customer_id: string | null;
  seller_user_id: string | null;
  order_warehouse_id: string;
  source_warehouse_id: string;
  requested_delivery_date: string | null;
  product_id: string;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
  unit_quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Agrupa por llave (pedido, producto, sucursal). Dos renglones con la misma llave en un mismo pedido
 * no deberían existir (el pedido fusiona por producto y sucursal), pero si existen se suman: con
 * unidades distintas la presentación queda en `null` (sumar PAQ con CJA no es una cantidad en
 * ninguna de las dos). El mismo producto y sucursal en DOS pedidos del grupo son dos filas.
 */
export function filasDelGrupo(renglones: readonly RenglonParaRegistro[]): FilaNueva[] {
  const porLlave = new Map<string, FilaNueva>();
  for (const r of renglones) {
    const llave = `${r.order_id}|${r.product_id}|${r.source_warehouse_id}`;
    const quantity = num(r.quantity) ?? 0;
    const unidad = r.qty_unit ? String(r.qty_unit) : null;
    const factor = num(r.qty_factor);
    const previa = porLlave.get(llave);
    if (previa) {
      previa.quantity += quantity;
      previa.line_total = previa.line_total == null || num(r.line_total) == null ? null : previa.line_total + (num(r.line_total) as number);
      if (previa.qty_unit !== unidad || previa.qty_factor !== factor) {
        previa.qty_unit = null;
        previa.qty_factor = null;
      }
      continue;
    }
    porLlave.set(llave, {
      root_order_id: r.root_order_id,
      order_id: r.order_id,
      order_line_id: r.line_id,
      customer_id: r.customer_id,
      seller_user_id: r.user_id,
      order_warehouse_id: r.order_warehouse_id,
      source_warehouse_id: r.source_warehouse_id,
      requested_delivery_date: r.requested_delivery_date,
      product_id: r.product_id,
      quantity,
      qty_unit: unidad,
      qty_factor: factor,
      unit_quantity: null,
      unit_price: num(r.unit_price),
      line_total: num(r.line_total),
    });
  }
  // La cantidad en su presentación: sólo con unidad Y factor (un renglón sincronizado sin conexión
  // llega sin unidad y se queda en null; nunca se rellena con la base).
  for (const f of porLlave.values()) {
    f.unit_quantity = f.qty_unit && f.qty_factor && f.qty_factor > 0 ? +(f.quantity / f.qty_factor).toFixed(4) : null;
  }
  return [...porLlave.values()];
}

/**
 * Paso 1 — DENTRO de la transacción de `place()` (quien llama abre el SAVEPOINT). Por cada renglón
 * de los pedidos que se agendan (el principal y sus partes, ya separados por sucursal), una fila
 * `pendiente` con la copia del original. Devuelve la raíz del grupo y cuántas filas escribió.
 *
 * La raíz se CONSERVA: si estos pedidos ya tenían filas (se reagendan), la de ellas; si no,
 * `COALESCE(group_id, id)`. Así una parte reabierta a la que `separarPorSucursal` le cambió el grupo
 * sigue contando en el grupo original.
 */
export async function marcarAlAgendar(
  trx: Knex.Transaction,
  orderIds: readonly string[],
  o: OpcionesRegistro,
): Promise<{ root: string | null; marcadas: number }> {
  if (!orderIds.length) return { root: null, marcadas: 0 };
  const { rows } = (await trx.raw(
    `SELECT l.id AS line_id, l.order_id, l.product_id, l.quantity::float8 AS quantity,
            l.qty_unit, l.qty_factor::float8 AS qty_factor,
            l.unit_price::float8 AS unit_price, l.line_total::float8 AS line_total,
            COALESCE(l.source_warehouse_id, o.warehouse_id) AS source_warehouse_id,
            o.warehouse_id AS order_warehouse_id, o.customer_id, o.user_id,
            o.requested_delivery_date::text AS requested_delivery_date,
            COALESCE(o.group_id, o.id) AS root_order_id
       FROM commercial.order_lines l
       JOIN commercial.orders o ON o.id = l.order_id
       LEFT JOIN catalog.products p ON p.id = l.product_id
      WHERE l.order_id = ANY(?::uuid[])
        AND NOT (coalesce(p.nombre, '') ~* ?)
      ORDER BY l.order_id, l.line_number`,
    [[...orderIds], PATRON_PROMOCION_PG],
  )) as { rows: RenglonParaRegistro[] };
  const filas = filasDelGrupo(rows);
  if (!filas.length) return { root: null, marcadas: 0 };

  const { rows: previas } = (await trx.raw(
    `SELECT root_order_id FROM commercial.order_stock_notices
      WHERE order_id = ANY(?::uuid[])
      ORDER BY created_at
      LIMIT 1`,
    [[...orderIds]],
  )) as { rows: Array<{ root_order_id: string }> };
  const root = previas[0]?.root_order_id ?? o.raizRespaldo ?? filas[0].root_order_id;
  for (const f of filas) f.root_order_id = root;

  // Reagendar: se reemplaza (lectura nueva) la fila vigente que nadie decidió de la misma llave, y la
  // de un renglón que sigue en el pedido pero cambió de sucursal (mismo `order_line_id`). La de un
  // renglón que se quitó NO se toca: fue demanda que el cliente expresó.
  await trx.raw(
    `UPDATE commercial.order_stock_notices n
        SET superseded_at = now(), updated_at = now(), updated_by = ?
      WHERE n.superseded_at IS NULL
        AND n.context = 'vendedor'
        AND n.decision = 'sin_aviso'
        AND ((n.order_id, n.product_id, n.source_warehouse_id) IN (
               SELECT k.order_id, k.product_id, k.source_warehouse_id
                 FROM unnest(?::uuid[], ?::uuid[], ?::uuid[]) AS k(order_id, product_id, source_warehouse_id))
             OR n.order_line_id = ANY(?::uuid[]))`,
    [
      o.userId,
      filas.map((f) => f.order_id), filas.map((f) => f.product_id), filas.map((f) => f.source_warehouse_id),
      [...new Set(rows.map((r) => r.line_id))],
    ],
  );

  // Una fila vigente DECIDIDA (frente 2) no se pisa: ni por la llave (el conflicto la deja como está)
  // ni por el renglón (una decisión tomada en el borrador, antes de que `separarPorSucursal` moviera el
  // renglón a otra parte, tiene otro `order_id`: sin el NOT EXISTS el renglón quedaría vigente dos veces).
  const { rows: insertadas } = (await trx.raw(
    `INSERT INTO commercial.order_stock_notices
       (tenant_id, context, root_order_id, order_id, order_line_id, customer_id, seller_user_id,
        order_warehouse_id, source_warehouse_id, requested_delivery_date, product_id, quantity,
        qty_unit, qty_factor, unit_quantity, unit_price, line_total, stock_state, decision,
        client_build, created_by, updated_by)
     SELECT public.current_tenant_id(), 'vendedor', x.root_order_id, x.order_id, x.order_line_id,
            x.customer_id, x.seller_user_id, x.order_warehouse_id, x.source_warehouse_id,
            x.requested_delivery_date, x.product_id, x.quantity, x.qty_unit, x.qty_factor,
            x.unit_quantity, x.unit_price, x.line_total, 'pendiente', 'sin_aviso', ?, ?, ?
       FROM jsonb_to_recordset(?::jsonb) AS x(
              root_order_id uuid, order_id uuid, order_line_id uuid, customer_id uuid,
              seller_user_id uuid, order_warehouse_id uuid, source_warehouse_id uuid,
              requested_delivery_date date, product_id uuid, quantity numeric, qty_unit text,
              qty_factor numeric, unit_quantity numeric, unit_price numeric, line_total numeric)
      WHERE NOT EXISTS (
              SELECT 1 FROM commercial.order_stock_notices d
               WHERE d.superseded_at IS NULL
                 AND d.decision <> 'sin_aviso'
                 AND d.order_line_id = x.order_line_id)
     ON CONFLICT (tenant_id, order_id, product_id, source_warehouse_id)
        WHERE superseded_at IS NULL DO NOTHING
     RETURNING id`,
    [o.clientBuild, o.userId, o.userId, JSON.stringify(filas)],
  )) as { rows: Array<{ id: string }> };
  return { root, marcadas: insertadas.length };
}

/** Lo que el paso 2 escribe en cada fila. */
interface Completado {
  id: string;
  stock_state: Exclude<StockNoticeState, 'pendiente'>;
  stock_qty: number | null;
  stock_checked_at: string | null;
  twin_product_id: string | null;
  stock_reason: string | null;
}

/**
 * Paso 2 — DESPUÉS del commit de `place()`, en su propia transacción. Lee la existencia de cada fila
 * `pendiente` del grupo en su sucursal de surtido y la completa. Idempotente: sólo toca lo que sigue
 * `pendiente` (y `SKIP LOCKED`: si el barrido la tiene, no se espera).
 */
export async function completarRegistro(
  trx: Knex.Transaction,
  rootOrderId: string,
): Promise<{ completadas: number; negadas: number; sinDato: number }> {
  const filas = (await trx('commercial.order_stock_notices')
    .where({ root_order_id: rootOrderId, stock_state: 'pendiente' })
    .whereNull('superseded_at')
    .forUpdate()
    .skipLocked()
    .select('id', 'product_id', 'source_warehouse_id')) as Array<{ id: string; product_id: string; source_warehouse_id: string }>;
  if (!filas.length) return { completadas: 0, negadas: 0, sinDato: 0 };

  const whIds = [...new Set(filas.map((f) => f.source_warehouse_id))];
  const whs = (await trx('commercial.warehouses').whereIn('id', whIds).select('id', 'code')) as Array<{ id: string; code: string | null }>;
  const codigo = new Map(whs.map((w) => [w.id, w.code]));
  const { estado, lecturas } = await estadoDeProductos(
    trx,
    whIds.map((id) => ({ id, code: codigo.get(id) ?? null })),
    filas.map((f) => f.product_id),
  );

  const valores: Completado[] = filas.map((f) => {
    const e = estado(f.source_warehouse_id, f.product_id);
    return {
      id: f.id,
      stock_state: e.state,
      stock_qty: e.qty,
      stock_checked_at: e.checked_at,
      twin_product_id: e.twin_product_id,
      stock_reason: e.state === 'sin_dato'
        ? (lecturas.get(f.source_warehouse_id)?.motivo ?? 'No se pudo medir la existencia de este producto en esa sucursal.')
        : null,
    };
  });
  await trx.raw(
    `UPDATE commercial.order_stock_notices n
        SET stock_state = x.stock_state, stock_qty = x.stock_qty, stock_checked_at = x.stock_checked_at,
            twin_product_id = x.twin_product_id, stock_reason = x.stock_reason, updated_at = now()
       FROM jsonb_to_recordset(?::jsonb) AS x(
              id uuid, stock_state text, stock_qty numeric, stock_checked_at timestamptz,
              twin_product_id uuid, stock_reason text)
      WHERE n.id = x.id AND n.stock_state = 'pendiente'`,
    [JSON.stringify(valores)],
  );
  return {
    completadas: valores.length,
    negadas: valores.filter((v) => sinExistenciaAfirmada(v.stock_state)).length,
    sinDato: valores.filter((v) => v.stock_state === 'sin_dato').length,
  };
}

/**
 * Paso 3 — el barrido. Toda fila que siga `pendiente` después de `minutos` pasa a `sin_dato` con su
 * motivo: el hueco se declara (ADR-056). Sólo las del tenant de la transacción (RLS).
 */
export async function declararPendientesViejas(
  trx: Knex.Transaction,
  minutos: number = MINUTOS_PARA_DECLARAR,
): Promise<number> {
  const n = await trx('commercial.order_stock_notices')
    .where({ stock_state: 'pendiente' })
    .whereRaw('created_at < now() - make_interval(mins => ?::int)', [minutos])
    .update({ stock_state: 'sin_dato', stock_reason: MOTIVO_BARRIDO, updated_at: trx.fn.now() });
  return Number(n) || 0;
}
