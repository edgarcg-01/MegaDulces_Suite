import type { Knex } from 'knex';
import { cierreDelDia } from './saldo-del-libro';
import { cuadreDeLaDescarga, type ArchivoParaCuadre, type CuadreDeLaDescarga, type SaldoDelBanco, type TestigoDeEntrada } from './cuadre-de-la-descarga';

/**
 * `[CB.73]` El cuadre de la descarga por cuenta: sus archivos (con el saldo con que abre y cierra cada uno), los saldos
 * de sus renglones y el testigo de la entrada = el cierre de la cuenta el último día ANTES de su primer renglón (lo
 * que la cuenta traía, reconstruido por la cadena de saldos; sin contar lo que metió el propio banco).
 *
 * `[CB.85]` Sale de `EstadoDeCuentaService` para que el Cuadre 3 vías juzgue «la descarga va de punta a punta» con el
 * MISMO instrumento que Estados de cuenta (ADR-056: un primitivo, no dos). Sin cambios de lógica.
 */
export async function cuadresDeLaDescarga(trx: Knex.Transaction, ids: readonly string[], hoy: string): Promise<Map<string, CuadreDeLaDescarga>> {
  const out = new Map<string, CuadreDeLaDescarga>();
  if (!ids.length) return out;
  const archivos: (ArchivoParaCuadre & { bank_account_id: string })[] = await trx('finance.bank_statement_files').whereIn('bank_account_id', ids)
    .select('bank_account_id', trx.raw("to_char(date_from, 'YYYY-MM-DD') as desde"), trx.raw("to_char(date_to, 'YYYY-MM-DD') as hasta"),
      'opening_balance as abre', 'closing_balance as cierra', trx.raw(`to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as subido`));
  const saldos: (SaldoDelBanco & { bank_account_id: string })[] = await trx('finance.bank_statement_lines').whereIn('bank_account_id', ids)
    .select('bank_account_id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'running_balance as saldo',
      'file_id as archivo', 'amount_in as abono', 'amount_out as cargo');
  const antesDe = new Map<string, string>();
  for (const id of ids) {
    const inicio = [...archivos.filter((a) => a.bank_account_id === id).map((a) => a.desde), ...saldos.filter((s) => s.bank_account_id === id).map((s) => s.fecha)].sort()[0] ?? null;
    antesDe.set(id, inicio ?? manana(hoy));
  }
  const testigos = await testigosDeEntrada(trx, antesDe);
  for (const id of ids) {
    out.set(id, cuadreDeLaDescarga(archivos.filter((a) => a.bank_account_id === id), saldos.filter((s) => s.bank_account_id === id), testigos.get(id) ?? null, hoy));
  }
  return out;
}

/**
 * `[CB.85]` `testigoDeEntrada` de varias cuentas en UNA consulta (antes, dos por cuenta: 34 para 17 cuentas). Mismo
 * criterio, renglón por renglón: el último día con saldo antes de `antesDe`, sin lo que metió el banco, y su cierre.
 */
export async function testigosDeEntrada(trx: Knex.Transaction, antesDe: ReadonlyMap<string, string>): Promise<Map<string, TestigoDeEntrada | null>> {
  const out = new Map<string, TestigoDeEntrada | null>();
  if (!antesDe.size) return out;
  const pares = Array.from(antesDe.entries());
  // `NOT (sync_source = 'banco')` es lo que genera `whereNot('sync_source', 'banco')`: un NULL también queda fuera.
  const filas = (await trx.raw(`
    WITH p(id, antes) AS (SELECT * FROM unnest(?::uuid[], ?::date[])),
    -- LATERAL … ORDER BY … LIMIT 1 y no max(): baja el índice (tenant, cuenta, fecha) al revés. Medido en prod el
    -- 2026-11-18, 18 cuentas: 16 ms contra 80 ms, mismas 146 filas.
    ult AS (
      SELECT p.id, u.d FROM p CROSS JOIN LATERAL (
        SELECT bm.movement_date AS d FROM finance.bank_movements bm
         WHERE bm.bank_account_id = p.id AND bm.deleted_at IS NULL AND NOT (bm.sync_source = 'banco')
           AND bm.running_balance IS NOT NULL AND bm.movement_date < p.antes
         ORDER BY bm.movement_date DESC LIMIT 1) u)
    SELECT ult.id::text AS id, to_char(ult.d, 'YYYY-MM-DD') AS d, bm.amount_in, bm.amount_out, bm.running_balance
    FROM ult JOIN finance.bank_movements bm
      ON bm.bank_account_id = ult.id AND bm.movement_date = ult.d AND bm.deleted_at IS NULL AND NOT (bm.sync_source = 'banco')`,
  [pares.map(([id]) => id), pares.map(([, f]) => f)])).rows as { id: string; d: string; amount_in: string; amount_out: string; running_balance: string | null }[];
  for (const [id] of pares) {
    const delDia = filas.filter((f) => f.id === id);
    if (!delDia.length) { out.set(id, null); continue; }
    const saldo = cierreDelDia(delDia.map((f) => ({ amount_in: f.amount_in, amount_out: f.amount_out, running_balance: f.running_balance })));
    out.set(id, saldo === null ? null : { fecha: delDia[0].d, saldo });
  }
  return out;
}

/** El cierre de la cuenta el último día con saldo antes de `antesDe`, sin contar lo que metió el banco. `null` si no hay. */
export async function testigoDeEntrada(trx: Knex.Transaction, cuentaId: string, antesDe: string): Promise<TestigoDeEntrada | null> {
  const base = () => trx('finance.bank_movements').where({ bank_account_id: cuentaId }).whereNull('deleted_at').whereNot('sync_source', 'banco');
  const ultimo = await base().whereNotNull('running_balance').andWhere('movement_date', '<', antesDe)
    .first(trx.raw("to_char(max(movement_date), 'YYYY-MM-DD') as d"));
  if (!ultimo?.d) return null;
  const saldo = cierreDelDia(await base().where({ movement_date: ultimo.d }).select('amount_in', 'amount_out', 'running_balance'));
  return saldo === null ? null : { fecha: ultimo.d, saldo };
}

function manana(hoy: string): string {
  const d = new Date(`${hoy}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
