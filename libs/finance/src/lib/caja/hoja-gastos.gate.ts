import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ZONAS_HOJA_GASTOS, folioHoja, type MedioPagoHoja, type ZonaHojaGastos } from '@megadulces/contracts';
import { requisitoDeHoja } from './hoja-gastos.engine';

/**
 * ⛔ `[CGA-A.65]` **El candado de la hoja de gastos de zona.** Edgar, 2026-10-29: *«tiene que estar
 * aprobada, si no está aprobada no se puede pagar»*.
 *
 * Un botón «Pagar» que exige la aprobación no basta: medido el 2026-10-29, los 144 egresos de
 * Morelia desde el 14/10 ($1,046,087.60) entraron al libro A MANO, uno por uno, y ninguno por el
 * lote. Por eso la regla vive donde se escribe el dinero, y la llaman los DOS únicos lugares que
 * escriben un vínculo con CAOS: el alta del libro (`CashLedgerService.create`, que también usa el
 * lote) y el alta de vínculo (`altaVinculo` de CAOS, que usan vincular, el lote de vínculos y mover):
 *
 *  · un pago que va en la hoja entra al libro SÓLO con su hoja pagada: ligado a su retiro, o del
 *    cajón (la diferencia, o la hoja entera si se pagó con el cajón);
 *  · el retiro de una hoja sólo explica pagos de esa hoja.
 *
 * Qué pago va en la hoja lo decide la MISMA regla que arma la hoja (`requisitoDeHoja`): si el
 * candado y la hoja decidieran distinto, quedaría un pago que ni entra a la hoja ni se paga suelto.
 * ⚠️ No cubre el SQL a mano. Sin la migración de las hojas aplicada, no frena nada (no hay hoja
 * con qué pagar): se dice en `instalada`.
 */

/** Las sucursales que se reponen por hoja, y la llave del libro de un pago suyo con su efectivo. */
const SUCURSALES_DE_HOJA = [...new Set(ZONAS_HOJA_GASTOS.flatMap((z) => z.sucursales))];
const RX_REF_DE_ZONA = new RegExp(`^(${SUCURSALES_DE_HOJA.join('|')})[|][^|]+[|][^|]+[|]0011$`);

export interface HojaDelPago {
  id: string;
  numero: number;
  estado: string;
  medio: MedioPagoHoja | null;
  caos_device: string | null;
  caos_external_id: number | null;
}

export interface RequisitoDelPago {
  zona: ZonaHojaGastos;
  /** La hoja vigente en que va, o `null` si todavía no va en ninguna. */
  hoja: HojaDelPago | null;
}

/** ¿Está aplicada la migración de las hojas (`20261029143450`)? */
export async function hojasInstaladas(trx: Knex | Knex.Transaction): Promise<boolean> {
  const r = await trx.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL AS ok`);
  return r.rows?.[0]?.ok === true;
}

const aHoja = (h: Record<string, unknown>): HojaDelPago => ({
  id: String(h['id']), numero: Number(h['numero']), estado: String(h['estado']),
  medio: (h['medio'] as MedioPagoHoja | null) ?? null, caos_device: (h['caos_device'] as string | null) ?? null,
  caos_external_id: h['caos_external_id'] == null ? null : Number(h['caos_external_id']),
});

/**
 * Para cada pago (llave del libro) de una zona que se repone por hoja: si sólo se paga con su hoja
 * —por su día de pago, su centro y su referencia en Kepler— y en qué hoja vigente va. Los demás
 * pagos no aparecen en el mapa: siguen su camino de siempre.
 */
export async function requisitosDeHoja(
  trx: Knex | Knex.Transaction, tenantId: string, refs: readonly (string | null | undefined)[],
): Promise<Map<string, RequisitoDelPago>> {
  const out = new Map<string, RequisitoDelPago>();
  const deZona = [...new Set(refs.map((r) => String(r ?? '')).filter((r) => RX_REF_DE_ZONA.test(r)))];
  if (!deZona.length || !(await hojasInstaladas(trx))) return out;

  const tuplas = deZona.map((r) => r.split('|').slice(0, 3));
  const filas = await trx('analytics.bank_movement_legs as l')
    .join('kepler_ods.kdm1 as d', function llave() {
      this.on('d.sucursal', 'l.src_sucursal').andOn('d.c1', 'l.src_c1').andOn('d.c2', 'l.src_c2')
        .andOn('d.c3', 'l.src_c3').andOn('d.c4', 'l.src_c4').andOn('d.c5', 'l.src_c5').andOn('d.c6', 'l.src_c6');
    })
    .where('l.tenant_id', tenantId).where('l.clave_banco', '0011')
    // `ix_bml_documento (tenant_id, sucursal, doc_tipo, folio)`.
    .whereRaw(`(l.sucursal, l.doc_tipo, l.folio) IN (${tuplas.map(() => '(?, ?, ?)').join(', ')})`, tuplas.flat())
    .select('l.sucursal', 'l.doc_tipo', 'l.folio',
      trx.raw(`to_char(l.fecha_valor, 'YYYY-MM-DD') AS fecha_pago`),
      trx.raw(`nullif(btrim(d.c12::text), '') AS centro`),
      trx.raw(`nullif(btrim(d.c11::text), '') AS referencia`));

  const zonaDe = new Map<string, ZonaHojaGastos>();
  for (const f of filas) {
    const ref = `${f.sucursal}|${f.doc_tipo}|${f.folio}|0011`;
    const zona = requisitoDeHoja({ sucursal: f.sucursal, fecha_pago: f.fecha_pago, centro: f.centro, referencia: f.referencia });
    if (zona && !zonaDe.has(ref)) zonaDe.set(ref, zona);
  }
  if (!zonaDe.size) return out;

  const lineas = await trx('finance.expense_sheet_lines as x')
    .join('finance.expense_sheets as s', 's.id', 'x.sheet_id')
    .where('x.tenant_id', tenantId).where('x.vigente', true).whereIn('x.origen_ref', [...zonaDe.keys()])
    .select('x.origen_ref', 's.id', 's.numero', 's.estado', 's.medio', 's.caos_device', 's.caos_external_id');
  const hojaDe = new Map(lineas.map((l) => [String(l.origen_ref), aHoja(l)]));
  for (const [ref, zona] of zonaDe) out.set(ref, { zona, hoja: hojaDe.get(ref) ?? null });
  return out;
}

/** La hoja que pagó un retiro de CAOS, o `null`. */
async function hojaDelRetiro(trx: Knex | Knex.Transaction, tenantId: string, device: string, externalId: number) {
  const h = await trx('finance.expense_sheets')
    .where({ tenant_id: tenantId, caos_device: device, caos_external_id: externalId })
    .first('id', 'numero', 'estado', 'medio', 'caos_device', 'caos_external_id');
  return h ? aHoja(h) : null;
}

/** La frase para quien ve un pago de la hoja en la cola, o intenta pagarlo suelto. */
export function textoPagoDeHoja(req: RequisitoDelPago): string {
  const h = req.hoja;
  if (!h) return `Va en la hoja de gastos de ${req.zona.nombre}: se paga con la hoja aprobada, en Finanzas › Gastos › Hoja de zona.`;
  if (h.estado === 'aprobada') return `Va en la hoja ${folioHoja(h.numero)}, ya aprobada: se paga con ella, de un solo retiro, en Finanzas › Gastos › Hoja de zona.`;
  if (h.estado === 'cerrada') return `Va en la hoja ${folioHoja(h.numero)}, que espera la aprobación de finanzas: sin aprobación no se paga.`;
  return `Va en la hoja ${folioHoja(h.numero)} (${h.estado}).`;
}

export interface EscrituraDeDinero {
  /** La llave del libro (`sucursal|doc_tipo|folio|0011`), si la tiene. */
  origen_ref: string | null | undefined;
  tipo: string;
  /** Los retiros de CAOS a los que se liga. */
  retiros: ReadonlyArray<{ device: string; external_id: number }>;
  origen_efectivo: string | null | undefined;
}

export type VeredictoPagoDeHoja = { ok: true } | { ok: false; http: 400 | 409; texto: string };

/**
 * La decisión del candado, PURA (se prueba sin base). `retirosDeHoja`: de los retiros a los que se
 * liga, los que ya pagaron una hoja y si este pago es de esa hoja. `req`: lo que el pago exige.
 *  1. El retiro de una hoja sólo explica pagos de esa hoja (sea el pago de la zona o no).
 *  2. Un pago que va en la hoja sólo entra con su hoja PAGADA: ligado a su retiro, o del cajón (la
 *     diferencia, o la hoja entera si se pagó con el cajón).
 */
export function veredictoPagoDeHoja(
  e: EscrituraDeDinero,
  retirosDeHoja: ReadonlyArray<{ hoja: HojaDelPago; esSuyo: boolean }>,
  req: RequisitoDelPago | null,
): VeredictoPagoDeHoja {
  for (const r of retirosDeHoja) {
    if (!r.esSuyo) {
      return { ok: false, http: 409, texto: `Ese retiro de CAOS pagó la hoja ${folioHoja(r.hoja.numero)}: sólo los pagos de esa hoja se ligan a él.` };
    }
  }
  if (e.tipo !== 'gasto' || !req) return { ok: true };
  const h = req.hoja;
  if (!h || h.estado !== 'pagada') return { ok: false, http: 400, texto: textoPagoDeHoja(req) };
  const alRetiroDeLaHoja = (r: { device: string; external_id: number }) =>
    h.medio === 'caos' && r.device === h.caos_device && Number(r.external_id) === h.caos_external_id;
  const bien = e.retiros.length ? e.retiros.every(alRetiroDeLaHoja) : e.origen_efectivo === 'cajon';
  if (bien) return { ok: true };
  return { ok: false, http: 409, texto: h.medio === 'caos'
    ? `La hoja ${folioHoja(h.numero)} se pagó con el retiro ${h.caos_external_id} de CAOS: este pago se liga a ese retiro (o sale del cajón por la diferencia).`
    : `La hoja ${folioHoja(h.numero)} se pagó con el cajón: este pago sale del cajón.` };
}

/**
 * ⛔ El candado. Se llama dentro de la transacción de quien escribe, antes de escribir: si no pasa,
 * no se guarda nada y la frase dice por qué y dónde se hace.
 */
export async function verificarPagoDeHoja(trx: Knex | Knex.Transaction, tenantId: string, e: EscrituraDeDinero): Promise<void> {
  // Sin retiro y sin un pago de zona, no hay nada que mirar: la captura de siempre no paga una consulta.
  const esDeZona = e.tipo === 'gasto' && RX_REF_DE_ZONA.test(String(e.origen_ref ?? ''));
  if (!e.retiros.length && !esDeZona) return;
  if (!(await hojasInstaladas(trx))) return;

  const retirosDeHoja: Array<{ hoja: HojaDelPago; esSuyo: boolean }> = [];
  for (const r of e.retiros) {
    const hoja = await hojaDelRetiro(trx, tenantId, r.device, Number(r.external_id));
    if (!hoja) continue;
    const esSuyo = !!e.origen_ref && !!(await trx('finance.expense_sheet_lines')
      .where({ tenant_id: tenantId, sheet_id: hoja.id, origen_ref: e.origen_ref, vigente: true }).first('id'));
    retirosDeHoja.push({ hoja, esSuyo });
  }
  const req = esDeZona ? (await requisitosDeHoja(trx, tenantId, [e.origen_ref])).get(String(e.origen_ref)) ?? null : null;
  const v = veredictoPagoDeHoja(e, retirosDeHoja, req);
  if (!v.ok) throw v.http === 400 ? new BadRequestException(v.texto) : new ConflictException(v.texto);
}
