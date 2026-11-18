import type { Knex } from 'knex';
import { componerBanco, type RenglonDelBanco } from '../banco-del-cuadre';
import { cuadresDeLaDescarga } from './cuadre-de-cuentas.query';
import { leerDescargaDelPeriodo } from './descarga-en-movimientos.query';

/**
 * `[CB.85]` De dónde sale el «Banco» de cada cuenta en el Cuadre 3 vías (VERDAD_ABSOLUTA §38.4):
 *  - `descarga`: su descarga cuadra de punta a punta (`[CB.73]`) y toca el mes → el libro del mes menos lo que la
 *    descarga no trae, más lo que sólo trae la descarga (`componerBanco`).
 *  - `libro`: no hay descarga que cuadre → el libro de Tesorería, como siempre, con el porqué (`motivo`).
 *
 * Sólo lee. Las cuentas sin descarga del mes no aparecen en `descarga` y el Cuadre las deja exactamente como estaban.
 */
export interface BancoDeCuentaPorDescarga {
  cuenta_id: string;
  account_label: string;
  /** Primer y último día de la descarga que cuadra (`[CB.73]`). */
  descarga_desde: string;
  descarga_hasta: string;
  /** Renglones del mes: libro confirmado + lo que sólo trae la descarga. */
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

  const d = await leerDescargaDelPeriodo(trx, periodo, usan.length === 1 ? usan[0].id : undefined);
  const ids = usan.map((u) => u.id);
  const aRenglon = (origen: 'libro' | 'descarga') => (x: { id: string; fecha: string; amount_in: string | null; amount_out: string | null; concepto: string | null }): RenglonDelBanco => {
    const sale = Number(x.amount_out) > 0;
    return { id: x.id, origen, fecha: x.fecha, dir: sale ? 'out' : 'in', importe: sale ? Number(x.amount_out) : Number(x.amount_in), concepto: x.concepto };
  };
  type Fila = { id: string; bank_account_id: string; fecha: string; amount_in: string | null; amount_out: string | null; concepto: string | null };
  const libro: Fila[] = await trx('finance.bank_movements as bm').join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
    .where('st.period', periodo).whereIn('bm.bank_account_id', ids).whereNull('bm.deleted_at')
    .whereRaw('(bm.amount_in > 0 OR bm.amount_out > 0)')
    .select('bm.id', 'bm.bank_account_id', trx.raw("to_char(bm.movement_date, 'YYYY-MM-DD') as fecha"), 'bm.amount_in', 'bm.amount_out', 'bm.concept as concepto');
  // Los renglones que sólo trae la descarga ya los leyó `leerDescargaDelPeriodo`: no se vuelven a pedir.
  const solo: Fila[] = d ? Array.from(d.renglones_solo.values()).map((r) => ({ id: r.id, bank_account_id: r.bank_account_id, fecha: r.fecha,
    amount_in: r.amount_in == null ? null : String(r.amount_in), amount_out: r.amount_out == null ? null : String(r.amount_out), concepto: r.concepto ?? null })) : [];
  // El archivo del último día subido ese mismo día (hora de MX) puede venir incompleto.
  const archivos = (await trx('finance.bank_statement_files').whereIn('bank_account_id', ids)
    .select('bank_account_id', trx.raw("to_char(date_to, 'YYYY-MM-DD') as hasta"),
      trx.raw("to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') as subido"))) as { bank_account_id: string; hasta: string; subido: string }[];
  const noTrae = d?.no_trae ?? new Set<string>();
  for (const u of usan) {
    const renglones = componerBanco(
      libro.filter((l) => l.bank_account_id === u.id).map(aRenglon('libro')), noTrae,
      solo.filter((s) => s.bank_account_id === u.id).map(aRenglon('descarga'))
        .map((x) => ({ ...x, categoria: d?.categoria.get(x.id)?.codigo ?? null })));
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
