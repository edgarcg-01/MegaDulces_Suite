import { Knex } from 'knex';
import { parear, type RenglonComparable } from './contra-el-libro';

/**
 * `[BFU.2.5]` Al pasar una cuenta al banco («Usar el banco», CB.60b), sus renglones del libro desde el primer día de
 * la descarga se marcan borrados y entra la descarga. Lo que la gente o el sistema ligó a esos renglones —un pago del
 * calendario, una confirmación de ContPAQi, una captura de WhatsApp, un pareo hecho a mano, el cliente declarado, la
 * categoría puesta a mano— se quedaba apuntando a un renglón borrado. Medido el 2026-11-19: 34 pagos del calendario
 * en las cuentas que pasarían ese día.
 *
 * Aquí se mueve cada liga al renglón del banco que es el mismo movimiento, con **el mismo pareo de la compuerta y de
 * Movimientos** (`parear`: mismo lado e importe al centavo, primero el mismo día, luego ±3 días, 1:1). Lo que no
 * tiene pareja NO se adivina: se devuelve en `sin_pareja` y la pantalla lo dice.
 *
 * Los pareos del motor de conciliación (`matched_by` = motor…) no se mueven: el motor vuelve a casar solo al entrar
 * el banco (CB.53). Sólo se mueven los pareos de personas.
 */

/** Dónde puede estar colgado un renglón de `bank_movements` (FK o columna que lo nombra). */
const LIGAS = [
  { tabla: 'finance.payment_allocations', columna: 'paid_bank_movement_id', nombre: 'pago del calendario' },
  { tabla: 'finance.payment_program', columna: 'bank_movement_id', nombre: 'programa de pagos' },
  { tabla: 'finance.bank_capture_inbox', columna: 'bank_movement_id', nombre: 'captura de depósito' },
  { tabla: 'contpaqi.pago_confirmaciones', columna: 'bank_movement_id', nombre: 'confirmación de ContPAQi' },
  { tabla: 'finance.bank_recon_matches', columna: 'bank_movement_id', nombre: 'pareo hecho a mano', soloHumanos: true },
] as const;

export interface RenglonConLigas extends RenglonComparable {
  /** Qué tiene colgado (nombres legibles de `LIGAS`, más «cliente declarado» y «categoría puesta a mano»). */
  ligas: string[];
  customer_code: string | null;
  customer_nota: string | null;
  customer_declared_by: string | null;
  customer_declared_at: string | null;
  category_id: string | null;
  manual: boolean;
}

export interface Religado {
  /** Renglones del libro cuyas ligas pasaron a su renglón del banco. */
  religados: number;
  /** Los que tenían algo colgado y no tienen pareja en el banco: su liga queda en el renglón borrado y se dice. */
  sin_pareja: { fecha: string; importe: number; lado: 'entra' | 'sale'; ligas: string[] }[];
}

/** El plan, puro: renglón del libro → renglón del banco, con el pareo de la compuerta. */
export function planReligar(libro: readonly RenglonConLigas[], banco: readonly RenglonComparable[]): { par: Map<string, string>; sinPareja: RenglonConLigas[] } {
  // Los lados al revés a propósito: por cada renglón del LIBRO que tiene algo colgado, su renglón del banco (primero el
  // mismo día; si no, el más cercano dentro de ±3). `parear` es simétrico en su regla; lo que cambia es quién busca.
  const { parDe } = parear(libro, banco);
  const par = new Map<string, string>();
  parDe.forEach((b, libroId) => par.set(libroId, b.id));
  return { par, sinPareja: libro.filter((l) => !par.has(l.id)) };
}

async function existe(trx: Knex.Transaction, tabla: string): Promise<boolean> {
  return !!(await trx.raw('select to_regclass(?) as r', [tabla])).rows[0].r;
}

/** Antes de borrar: los renglones del libro de la cuenta, desde `desde`, que tienen algo colgado. Sólo lee. */
export async function leerLigasDelLibro(trx: Knex.Transaction, cuentaId: string, desde: string): Promise<RenglonConLigas[]> {
  const filas = (await trx('finance.bank_movements').where({ bank_account_id: cuentaId }).where('movement_date', '>=', desde)
    .whereIn('sync_source', ['upload', 'sheet']).whereRaw("client_uuid NOT LIKE 'whatsapp:%'").whereNull('deleted_at')
    .select('id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'amount_in', 'amount_out', 'running_balance', 'concept as concepto',
      'customer_code', 'customer_nota', 'customer_declared_by', 'customer_declared_at', 'category_id', 'classified_by')
    .orderBy([{ column: 'movement_date' }, { column: 'id' }])) as
    (RenglonComparable & { customer_code: string | null; customer_nota: string | null; customer_declared_by: string | null;
      customer_declared_at: string | null; category_id: string | null; classified_by: string | null })[];
  if (!filas.length) return [];
  const ligas = new Map<string, string[]>();
  const anota = (id: string, n: string) => { const a = ligas.get(id); if (a) { if (!a.includes(n)) a.push(n); } else ligas.set(id, [n]); };
  const ids = filas.map((f) => f.id);
  for (const L of LIGAS) {
    if (!(await existe(trx, L.tabla))) continue;
    for (let i = 0; i < ids.length; i += 1000) {
      const q = trx(L.tabla).whereIn(L.columna, ids.slice(i, i + 1000)).distinct(`${L.columna} as id`);
      if ('soloHumanos' in L) q.whereRaw("coalesce(matched_by, '') NOT LIKE 'motor%'");
      for (const r of (await q) as { id: string }[]) anota(r.id, L.nombre);
    }
  }
  for (const f of filas) {
    if (f.customer_code) anota(f.id, 'cliente declarado');
    if (f.classified_by === 'manual' && f.category_id) anota(f.id, 'categoría puesta a mano');
  }
  return filas.filter((f) => ligas.has(f.id)).map((f) => ({ ...f, ligas: ligas.get(f.id)!, manual: f.classified_by === 'manual' }));
}

/**
 * Después de meter la descarga: mueve las ligas de cada renglón del libro a su pareja del banco. En la MISMA
 * transacción que «usar el banco»: si algo falla, no pasa nada de la cuenta.
 */
export async function religarAlBanco(trx: Knex.Transaction, cuentaId: string, desde: string, libro: readonly RenglonConLigas[]): Promise<Religado> {
  if (!libro.length) return { religados: 0, sin_pareja: [] };
  const banco = (await trx('finance.bank_movements').where({ bank_account_id: cuentaId, sync_source: 'banco' }).where('movement_date', '>=', desde)
    .whereNull('deleted_at').select('id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'amount_in', 'amount_out', 'running_balance')
    .orderBy([{ column: 'movement_date' }, { column: 'id' }])) as RenglonComparable[];
  const { par, sinPareja } = planReligar(libro, banco);
  const tablas: (typeof LIGAS)[number][] = [];
  for (const L of LIGAS) if (await existe(trx, L.tabla)) tablas.push(L);
  for (const l of libro) {
    const nuevo = par.get(l.id);
    if (!nuevo) continue;
    for (const L of tablas) {
      const q = trx(L.tabla).where(L.columna, l.id);
      if ('soloHumanos' in L) q.whereRaw("coalesce(matched_by, '') NOT LIKE 'motor%'");
      await q.update({ [L.columna]: nuevo });
    }
    const copia: Record<string, unknown> = {};
    if (l.customer_code) Object.assign(copia, { customer_code: l.customer_code, customer_nota: l.customer_nota,
      customer_declared_by: l.customer_declared_by, customer_declared_at: l.customer_declared_at });
    if (l.manual && l.category_id) Object.assign(copia, { category_id: l.category_id, classified_by: 'manual' });
    if (Object.keys(copia).length) await trx('finance.bank_movements').where({ id: nuevo }).update({ ...copia, updated_at: trx.fn.now() });
  }
  return {
    religados: par.size,
    sin_pareja: sinPareja.map((l) => {
      const sale = Math.round(Number(l.amount_out) * 100) !== 0;
      return { fecha: l.fecha, importe: Number(sale ? l.amount_out : l.amount_in), lado: sale ? 'sale' : 'entra', ligas: l.ligas };
    }),
  };
}
