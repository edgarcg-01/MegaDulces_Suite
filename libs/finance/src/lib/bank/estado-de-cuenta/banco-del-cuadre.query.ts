import type { Knex } from 'knex';
import { componerBanco, type RenglonDelBanco } from '../banco-del-cuadre';
import { cuadresDeLaDescarga } from './cuadre-de-cuentas.query';
import { descargaEnMovimientos, type RenglonComparable } from './contra-el-libro';
import { clasificarRenglon } from './clasificador';
import { leerReglaDelLibro } from './descarga-en-movimientos.query';

/**
 * `[CB.85]` De dónde sale el «Banco» de cada cuenta en el Cuadre 3 vías (VERDAD_ABSOLUTA §38.4):
 *  - `descarga`: su descarga cuadra de punta a punta (`[CB.73]`) y toca el mes → el libro de ANTES del primer día de la
 *    descarga, más, desde ese día, el libro que la descarga confirma y lo que sólo trae la descarga (`componerBanco`).
 *  - `libro`: no hay descarga que cuadre → el libro de Tesorería, como siempre, con el porqué (`motivo`).
 *
 * `[CB.86]` El pareo libro↔descarga (el núcleo de `[CB.64]`, `descargaEnMovimientos`) se hace sólo con el libro DESDE el
 * primer día de la descarga. Con el margen de ±3 días de Movimientos, una salida que el banco cobró el 11-nov se pareaba
 * con otra del mismo importe que el libro tenía el 9 —antes de la descarga— y el «Banco» perdía una (STDR 2169,
 * $2,187.80; las dos son reales: la descarga abre el 10 en el saldo con que el libro cerró el 9, ya con la del 9 restada).
 * Lo encontró la paridad de `test-newdb-bank-threeway-cobertura.js`.
 *
 * Sólo lee. Las cuentas sin descarga del mes no aparecen en `descarga` y el Cuadre las deja exactamente como estaban.
 */
export interface BancoDeCuentaPorDescarga {
  cuenta_id: string;
  account_label: string;
  /** Primer y último día de la descarga que cuadra (`[CB.73]`). */
  descarga_desde: string;
  descarga_hasta: string;
  /** Renglones del mes: libro previo + libro confirmado + lo que sólo trae la descarga. */
  renglones: RenglonDelBanco[];
  /** Último día que cubre el banco dentro del mes (el corte de la cuenta si va atrasada). */
  hasta: string;
  /** Ese último día es el de un archivo subido el mismo día: puede venir incompleto. */
  dia_parcial: boolean;
}

export interface BancoDelCuadre {
  /** account_label → la cuenta que usa la descarga. */
  descarga: Map<string, BancoDeCuentaPorDescarga>;
  /** account_label → por qué sigue con el libro, cuando tiene alguna descarga que no cuadra. */
  libro_motivo: Map<string, string>;
}

const VACIO: BancoDelCuadre = { descarga: new Map(), libro_motivo: new Map() };
const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** `soloCuenta` (account_label): el detalle de una cuenta lee sólo esa cuenta, con el mismo resultado que en el cuadre. */
export async function leerBancoDelCuadre(trx: Knex.Transaction, periodo: string, hoy: string, soloCuenta?: string): Promise<BancoDelCuadre> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) return VACIO;
  const ini = `${periodo}-01`;
  const [y, m] = periodo.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const cuentas: { id: string; account_label: string }[] = await trx('finance.bank_accounts')
    .where({ kind: 'bank' }).whereNotNull('account_label')
    .modify((q) => { if (soloCuenta) q.where('account_label', soloCuenta); })
    .select('id', 'account_label');
  if (!cuentas.length) return VACIO;
  // Sólo las cuentas con algún renglón de descarga que toque el mes: las demás ni se juzgan (siguen con el libro).
  const conDescarga = new Set<string>((await trx('finance.bank_statement_lines')
    .whereIn('bank_account_id', cuentas.map((c) => c.id)).whereBetween('movement_date', [ini, fin])
    .distinct('bank_account_id')).map((r: { bank_account_id: string }) => r.bank_account_id));
  if (!conDescarga.size) return VACIO;
  const cuadres = await cuadresDeLaDescarga(trx, Array.from(conDescarga), hoy);
  const out: BancoDelCuadre = { descarga: new Map(), libro_motivo: new Map() };
  const usan: { id: string; account_label: string; desde: string; hasta: string }[] = [];
  for (const c of cuentas) {
    const q = cuadres.get(c.id);
    if (!q) continue;
    if (q.cuadra && q.desde && q.hasta && q.desde <= fin && q.hasta >= ini) usan.push({ ...c, desde: q.desde, hasta: q.hasta });
    else out.libro_motivo.set(c.account_label, q.motivo || 'su descarga no cuadra de punta a punta');
  }
  if (!usan.length) return out;
  const ids = usan.map((u) => u.id);

  // Los dos lados, con el margen de CB.64 (±3 días la descarga, ±6 el libro) para casar en los bordes del mes.
  const desdeLeer = sumarDias(ini, -3), hastaLeer = sumarDias(fin, 3);
  type Banco = RenglonComparable & { bank_account_id: string };
  const banco: Banco[] = await trx('finance.bank_statement_lines').whereIn('bank_account_id', ids).whereBetween('movement_date', [desdeLeer, hastaLeer])
    .select('id', 'bank_account_id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'amount_in', 'amount_out', 'running_balance', 'concept as concepto');
  type Libro = RenglonComparable & { bank_account_id: string; periodo: string | null };
  const libro: Libro[] = await trx('finance.bank_movements as bm').leftJoin('finance.bank_statements as st', 'st.id', 'bm.statement_id')
    .whereIn('bm.bank_account_id', ids).whereNull('bm.deleted_at').whereNot('bm.sync_source', 'banco')
    .whereBetween('bm.movement_date', [sumarDias(desdeLeer, -3), sumarDias(hastaLeer, 3)])
    .select('bm.id', 'bm.bank_account_id', trx.raw("to_char(bm.movement_date, 'YYYY-MM-DD') as fecha"), 'bm.amount_in', 'bm.amount_out',
      'bm.running_balance', 'bm.concept as concepto', 'st.period as periodo');
  // El «Banco» del mes parte de los renglones del estado de cuenta del periodo (como la fila de siempre).
  const delMes: Libro[] = await trx('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
    .where('st.period', periodo).whereIn('bm.bank_account_id', ids).whereNull('bm.deleted_at')
    .whereRaw('(bm.amount_in > 0 OR bm.amount_out > 0)')
    .select('bm.id', 'bm.bank_account_id', trx.raw("to_char(bm.movement_date, 'YYYY-MM-DD') as fecha"), 'bm.amount_in', 'bm.amount_out',
      'bm.running_balance', 'bm.concept as concepto', 'st.period as periodo');
  const archivos = (await trx('finance.bank_statement_files').whereIn('bank_account_id', ids)
    .select('bank_account_id', trx.raw("to_char(date_from, 'YYYY-MM-DD') as desde"), trx.raw("to_char(date_to, 'YYYY-MM-DD') as hasta"),
      trx.raw("to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') as subido"))) as { bank_account_id: string; desde: string; hasta: string; subido: string }[];
  const conCorte = await trx.schema.withSchema('finance').hasColumn('bank_accounts', 'statement_source_since');
  const corteDe = new Map<string, string | null>(conCorte
    ? (await trx('finance.bank_accounts').whereIn('id', ids).select('id', trx.raw("to_char(statement_source_since, 'YYYY-MM-DD') as corte")))
      .map((a: { id: string; corte: string | null }) => [a.id, a.corte])
    : []);
  let regla: ((concepto: string) => string) | null = null;

  const aRenglon = (origen: 'libro' | 'descarga') => (x: RenglonComparable): RenglonDelBanco => {
    const sale = Number(x.amount_out) > 0;
    return { id: x.id, origen, fecha: x.fecha, dir: sale ? 'out' : 'in', importe: sale ? Number(x.amount_out) : Number(x.amount_in), concepto: x.concepto ?? null };
  };
  for (const u of usan) {
    // Sólo el libro DESDE el primer día de la descarga entra al pareo: lo de antes, la descarga no lo ve.
    const d = descargaEnMovimientos(
      banco.filter((b) => b.bank_account_id === u.id),
      libro.filter((l) => l.bank_account_id === u.id && l.fecha >= u.desde),
      archivos.filter((a) => a.bank_account_id === u.id), corteDe.get(u.id) ?? null);
    const noTrae = new Set(d.no_trae);
    const soloIds = new Set(d.solo_descarga.map((s) => s.id));
    const solo = banco.filter((b) => soloIds.has(b.id) && b.fecha >= ini && b.fecha <= fin);
    if (solo.length && !regla) regla = await leerReglaDelLibro(trx);
    const renglones = componerBanco(
      delMes.filter((l) => l.bank_account_id === u.id).map(aRenglon('libro')), noTrae,
      solo.map((b) => ({ ...aRenglon('descarga')(b),
        categoria: clasificarRenglon({ amount_in: b.amount_in, amount_out: b.amount_out, concepto: b.concepto ?? '' }, regla ?? undefined).categoria })));
    // Hasta dónde llega el banco: lo que cubre la descarga (un archivo que va al 18 dice que el 18 no hubo más), o el
    // último renglón si el libro llega más lejos. Nunca después del mes ni de hoy.
    const ultimoRenglon = renglones.filter((x) => x.fecha <= hoy).map((x) => x.fecha).pop() ?? null;
    const cubre = [u.hasta, fin, hoy].sort()[0];
    const hasta = ultimoRenglon && ultimoRenglon > cubre ? ultimoRenglon : cubre;
    const diaParcial = archivos.some((a) => a.bank_account_id === u.id && a.hasta === hasta && a.subido === hasta);
    out.descarga.set(u.account_label, { cuenta_id: u.id, account_label: u.account_label, descarga_desde: u.desde, descarga_hasta: u.hasta, renglones, hasta, dia_parcial: diaParcial });
  }
  return out;
}
