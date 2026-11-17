import { CAPTURISTA_SUITE } from '@megadulces/platform-core';
import {
  movimientosKdc126, movimientosKdcn26, periodoKdcn26, tablaPolizaDelMes,
  type MovimientoCentroDeCosto, type MovimientoCuenta, type PolizaKepler,
} from './kepler-contable';

/**
 * `[PGP.123]` C1 — **El gasto `X-A-10` («Alta gasto CFDI») en el idioma de Kepler, armado sin tocar Kepler.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md` §3 y §5.2. Funciones puras: el escritor
 * (C2) lee lo vivo —la X-A-15 con `FOR UPDATE`, sus renglones, `kdmm` y `kdc3` del servidor— y le pasa aquí; esto
 * devuelve QUÉ se escribe en las 9 tablas o POR QUÉ no. El folio (`c6`), el número de póliza (`c1`) y el documento
 * de la póliza (`c15`–`c19`) los pone el escritor.
 *
 * ── Lo medido (1,922 X-A-10 vivos con fecha desde el 1-oct-2026, ODS, 2026-11-15) ────────────────────────────────
 * Un gasto es su solicitud copiada: de las 200 columnas de `kdm1` sólo varían 23, y 15 de ellas se copian de la
 * X-A-15 en ≥ 96.6 %. Por eso se CLONA la solicitud viva y se pisan sólo las constantes del gasto y lo propio
 * (`COLUMNAS_DEL_GASTO`). `kdm6` es copia (4,563 de 4,566 renglones idénticos). La póliza es de Diario en la tabla
 * del mes de `c9`, con las cuentas de `kdmm` (158 de 158 combinaciones servidor × documento) y cuadra en 1,909 de
 * 1,918: las 9 que no, traen un concepto sin cuenta, y aquí eso es un motivo para NO escribir.
 *
 * ⛔ Fuera de este armador (se declaran, no se adivinan): retenciones (DG6), un gasto distinto de su solicitud, una
 * solicitud que no está en `A` con su saldo completo, y la fecha (DG1: la decide quien llama, aquí sólo se valida).
 */

type Valor = string | number;
type Fila = Readonly<Record<string, Valor | null | undefined>>;

/** Lo que el catálogo de documentos `kdmm` del servidor dice del X-A-10: el tipo de póliza (`c18`) y sus cuentas. */
export interface ConfigGastoKepler {
  /** `kdmm.c18`: `D` en 9 de 9 servidores. */
  tipoPoliza: string;
  /** `kdmm.c20`: el abono al acreedor. `203` en 00 (desde el 2026-05-26), `201` en 01–08. */
  cuentaAcreedor: string;
  /** `kdmm.c21`: el IVA acreditable, `122-001`. */
  cuentaIva: string;
  /** `kdmm.c22`: la retención (`122-003`). v1 no escribe retenciones. */
  cuentaRetencion: string;
}

/** Las cuentas medidas: si `kdmm` dice otra cosa, Contabilidad cambió la configuración y no se escribe a ciegas. */
export const CUENTAS_ACREEDOR_MEDIDAS: ReadonlySet<string> = new Set(['201', '203']);
export const CUENTA_IVA_DEL_GASTO = '122-001';

/** Lo que el gasto pisa de su solicitud clonada (más `c6`, el folio, que pone el escritor). */
export const COLUMNAS_DEL_GASTO = [
  'c4', 'c9', 'c31', 'c36', 'c37', 'c38', 'c39', 'c41', 'c42', 'c43', 'c63', 'c67', 'c68', 'c69', 'c90',
] as const;

export interface DatosGastoKepler {
  /** El servidor (`md_NN`). */
  sucursal: string;
  /** La X-A-15 viva, la fila entera de `kdm1` tal como la devuelve el Kepler vivo. */
  solicitud: Fila;
  /** Sus renglones `kdm6`. */
  renglones: ReadonlyArray<Fila>;
  config: ConfigGastoKepler;
  /** `c9` del gasto, `YYYY-MM-DD` (DG1): la fecha y el MES de la póliza y de los acumulados. */
  fecha: string;
  /** `c68` (`YYYY-MM-DD`) y `c69` (`HH:MM`), hora de México: cuándo lo escribe la Suite. */
  capturadoEn: { fecha: string; hora: string };
  /** DG3: la forma de pago del vale (`01`…`04`, `99`, ya decodificada), para cuando la solicitud no trae `c90`. */
  formaPagoVale?: string | null;
  /** Las claves de `kdc3` del servidor: los departamentos padre que acumulan en `kdcn26`. */
  departamentos: ReadonlySet<string>;
}

export interface PlanGastoKepler {
  /** Lo que se pisa de la X-A-15 clonada (`COLUMNAS_DEL_GASTO`), sin `c6`. */
  kdm1: Record<string, Valor>;
  /** Cada renglón de la solicitud clonado, con lo que se pisa (sin `c6`). Mismo orden y `c7` que la solicitud. */
  kdm6: Record<string, Valor>[];
  /** La cuenta por pagar, derivada entera salvo `c6` (§3.4). */
  kdxe: Record<string, Valor>;
  /** La póliza (§3.5), sin `c1` (número) ni `c15`–`c19` (el documento): los pone el escritor. */
  poliza: PolizaKepler;
  /** El UPDATE de la X-A-15: su folio, el saldo que le queda y su estado nuevo. */
  solicitud: { folio: string; saldo: number; estado: 'F' };
  acumulados: {
    /** El mes de la póliza (1–12): las columnas de `kdc126` y `kdxg`. */
    mes: number;
    periodo: string;
    kdc126: MovimientoCuenta[];
    kdcn26: MovimientoCentroDeCosto[];
    kdxg: { acreedor: string; cargo: number; fecha: string };
  };
  total: number;
  iva: number;
}

export type ResultadoGastoKepler = { ok: true; plan: PlanGastoKepler } | { ok: false; motivos: string[] };

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const cent = (n: unknown): number => Math.round(Number(n) * 100);
const txt = (v: unknown): string => String(v ?? '').trim();
/** `2026-11-13T00:00:00.000Z`, `2026-11-13 00:00:00` o un `Date` → `2026-11-13`. */
const dia = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);

/** Arma el gasto de esa solicitud, o dice por qué no. Fail-closed: un motivo basta. */
export function armarGastoKepler(d: DatosGastoKepler): ResultadoGastoKepler {
  const no: string[] = [];
  const s = d.solicitud ?? {};
  const sucursal = txt(d.sucursal);
  if (!/^\d{2}$/.test(sucursal)) no.push(`Sucursal Kepler inválida «${d.sucursal}»`);

  // ── La solicitud: una X-A-15 viva, autorizada y con todo su saldo ─────────────────────────────────────────────
  const folio = txt(s['c6']);
  const tipo = `${txt(s['c2'])}-${txt(s['c3'])}-${txt(s['c4'])}-${txt(s['c5'])}`;
  if (tipo !== 'X-A-15-1') no.push(`El documento no es una solicitud X-A-15-1 (es ${tipo})`);
  if (!/^\d{1,7}$/.test(folio)) no.push(`La solicitud no trae folio («${s['c6']}»)`);
  if (txt(s['c1']) && txt(s['c1']) !== sucursal) no.push(`La solicitud es de la sucursal ${txt(s['c1'])}, no de ${sucursal}`);
  const estado = txt(s['c43']);
  if (estado !== 'A') {
    no.push(estado === 'C' ? 'La solicitud está cancelada en Kepler' : estado === 'F' ? 'La solicitud ya está aplicada (F): ya tiene su gasto'
      : `La solicitud no está autorizada en Kepler (estado «${estado || 'vacío'}»)`);
  }
  const total = cent(s['c16']);
  const iva = cent(s['c14']);
  const retencion = cent(s['c15']);
  if (!(total > 0)) no.push(`La solicitud no tiene total («${s['c16']}»)`);
  if (cent(s['c42']) !== total) no.push(`El saldo de la solicitud (${(cent(s['c42']) / 100).toFixed(2)}) no es su total (${(total / 100).toFixed(2)}): ya tiene un gasto, o uno parcial`);
  if (retencion !== 0) no.push(`La solicitud trae retención de $${(retencion / 100).toFixed(2)}: se captura en Kepler`);
  if (iva < 0) no.push('La solicitud trae IVA negativo');
  const acreedor = txt(s['c10']);
  if (!acreedor) no.push('La solicitud no trae acreedor (c10)');

  // ── Sus renglones: cada uno con cuenta, y la identidad del total al centavo ──────────────────────────────────
  const renglones = [...(d.renglones ?? [])].sort((a, b) => Number(a['c7']) - Number(b['c7']));
  if (!renglones.length) no.push('La solicitud no trae renglones (kdm6)');
  let suma = 0;
  renglones.forEach((r) => {
    const n = txt(r['c7']);
    if (`${txt(r['c2'])}-${txt(r['c3'])}-${txt(r['c4'])}-${txt(r['c5'])}` !== 'X-A-15-1' || txt(r['c6']) !== folio) {
      no.push(`El renglón ${n} no es de la solicitud ${folio}`);
    }
    if (!txt(r['c8'])) no.push(`El renglón ${n} (concepto ${txt(r['c12']) || 'vacío'}) no tiene cuenta contable: Kepler omitiría su cargo y la póliza no cuadraría`);
    // Sin proyecto o departamento, el ejercido de Kepler (`kdcn26`) pierde su centro de costo. Kepler los acepta
    // vacíos (35 de 1,922 gastos de oct–nov), pero en 9 de esos 35 la persona los COMPLETÓ al comprobar: copiarlos
    // vacíos sería decidir por ella. Fail-closed: se completan en la solicitud o se comprueba a mano.
    for (const [col, que] of [['c12', 'concepto'], ['c13', 'proyecto'], ['c16', 'departamento']] as const) {
      if (!txt(r[col])) no.push(`El renglón ${n} no trae ${que}: complétalo en la solicitud de Kepler`);
    }
    if (!(cent(r['c11']) > 0)) no.push(`El renglón ${n} no tiene importe positivo`);
    suma += cent(r['c11']);
  });
  if (renglones.length && suma + iva - retencion !== total) {
    no.push(`La solicitud no cuadra: renglones ${(suma / 100).toFixed(2)} + IVA ${(iva / 100).toFixed(2)} ≠ total ${(total / 100).toFixed(2)}`);
  }

  // ── La configuración del servidor (kdmm), tal como se midió ──────────────────────────────────────────────────
  const cfg = d.config ?? ({} as ConfigGastoKepler);
  if (txt(cfg.tipoPoliza) !== 'D') no.push(`kdmm dice que el gasto hace póliza «${txt(cfg.tipoPoliza)}»; se midió D`);
  if (!CUENTAS_ACREEDOR_MEDIDAS.has(txt(cfg.cuentaAcreedor))) no.push(`kdmm abona el gasto a «${txt(cfg.cuentaAcreedor)}»; se midió 201 o 203`);
  if (iva > 0 && txt(cfg.cuentaIva) !== CUENTA_IVA_DEL_GASTO) no.push(`kdmm manda el IVA a «${txt(cfg.cuentaIva)}»; se midió ${CUENTA_IVA_DEL_GASTO}`);

  // ── La fecha (DG1), quién y cuándo, la forma de pago (DG3) ───────────────────────────────────────────────────
  const tabla = FECHA.test(d.fecha ?? '') ? tablaPolizaDelMes(d.fecha) : null;
  if (!tabla || Number.isNaN(Date.parse(d.fecha))) no.push(`Fecha del gasto inválida «${d.fecha}»`);
  if (!FECHA.test(d.capturadoEn?.fecha ?? '') || !HORA.test(d.capturadoEn?.hora ?? '')) no.push('Falta cuándo lo escribe la Suite (fecha y hora de México)');
  // `kdc126` y `kdxg` son los acumulados del AÑO en curso (igual que el pago, PGP.106).
  if (tabla && FECHA.test(d.capturadoEn?.fecha ?? '') && d.fecha.slice(0, 4) !== d.capturadoEn.fecha.slice(0, 4)) {
    no.push(`El gasto es de ${d.fecha.slice(0, 4)} y los acumulados de Kepler son del año en curso: se captura a mano`);
  }
  if (tabla && FECHA.test(d.capturadoEn?.fecha ?? '') && d.fecha > d.capturadoEn.fecha) no.push(`La fecha del gasto (${d.fecha}) es posterior a hoy`);
  const fechaSolicitud = dia(s['c9']);
  if (tabla && FECHA.test(fechaSolicitud) && d.fecha < fechaSolicitud) no.push(`La fecha del gasto (${d.fecha}) es anterior a la de su solicitud (${fechaSolicitud})`);
  const fpVale = txt(d.formaPagoVale);
  if (fpVale && !/^\d{2}$/.test(fpVale)) no.push(`Forma de pago del vale inválida «${fpVale}»`);

  if (no.length) return { ok: false, motivos: no };

  // ── kdm1: la solicitud clonada, con las constantes del gasto y lo propio ─────────────────────────────────────
  const kdm1: Record<string, Valor> = {
    c4: 10,
    c9: d.fecha,
    c31: 'Gas',
    c36: 'A',
    c37: 15,
    c38: 1,
    c39: folio,
    c41: '2000-01-01',
    c42: total / 100,
    c43: 'N',
    c63: 'XA1001-',
    c67: CAPTURISTA_SUITE,
    c68: d.capturadoEn.fecha,
    c69: d.capturadoEn.hora,
    // DG3: la de la solicitud; si viene vacía, la del vale; si tampoco, `01` como Kepler (96.0 % de las vacías).
    c90: txt(s['c90']) || fpVale || '01',
  };

  // ── kdm6: los renglones de la solicitud, con el tipo del gasto ───────────────────────────────────────────────
  const kdm6 = renglones.map((r) => ({ c4: 10, c7: Number(r['c7']) }));

  // ── kdxe: la cuenta por pagar que salda el X-D-26 ────────────────────────────────────────────────────────────
  const referencia = txt(s['c11']);
  const kdxe: Record<string, Valor> = {
    c1: sucursal, c2: acreedor, c3: 'A', c4: 10, c5: 1, c7: d.fecha, c8: 'PESOS',
    c9: txt(s['c17']), c10: dia(s['c18']) || d.fecha,
    c11: total / 100, c13: iva / 100, c14: 0, c16: referencia, c17: total / 100, c20: total / 100,
    c28: 'X', c29: 'A',
  };

  // ── La póliza D: abono al acreedor, IVA, y un cargo por renglón con sus segmentos ────────────────────────────
  const nombre = txt(s['c32']).slice(0, 40);
  const c23 = referencia.slice(0, 1);
  const base = (c3: string, c4: 'C' | 'A', importe: number, c6: string, seg: { c13: string; c20: string; c21: string }): Record<string, Valor> =>
    ({ c3, c4, c5: importe / 100, c9: importe / 100, c6: c6.slice(0, 40), c7: referencia, c13: seg.c13, c14: sucursal, c20: seg.c20, c21: seg.c21, c23, c31: '1800-01-01' });
  const sinSegmentos = { c13: '', c20: '', c21: '' };
  const poliza: PolizaKepler = {
    tipo: 'D',
    fecha: d.fecha,
    renglones: [
      base(txt(cfg.cuentaAcreedor), 'A', total, nombre, sinSegmentos),
      ...(iva > 0 ? [base(CUENTA_IVA_DEL_GASTO, 'C', iva, nombre, sinSegmentos)] : []),
      // El texto del cargo es el del renglón (`kdm6.c9`); si viene vacío, Kepler pone el nombre del acreedor.
      ...renglones.map((r) => base(txt(r['c8']), 'C', cent(r['c11']), txt(r['c9']) || nombre, { c13: txt(r['c16']), c20: txt(r['c12']), c21: txt(r['c13']) })),
    ].map((r, i) => ({ c10: i + 1, ...r })),
  };

  // ── Los acumulados del mes de la póliza ──────────────────────────────────────────────────────────────────────
  const mes = Number(d.fecha.slice(5, 7));
  return {
    ok: true,
    plan: {
      kdm1, kdm6, kdxe, poliza,
      solicitud: { folio, saldo: 0, estado: 'F' },
      acumulados: {
        mes,
        periodo: periodoKdcn26(d.fecha) as string,
        kdc126: movimientosKdc126(poliza),
        kdcn26: movimientosKdcn26(poliza, d.departamentos ?? new Set()),
        kdxg: { acreedor, cargo: total / 100, fecha: d.fecha },
      },
      total: total / 100,
      iva: iva / 100,
    },
  };
}

/** La póliza cuadra al centavo y su abono es el total: la revisión que se repite antes del COMMIT. */
export function polizaCuadra(p: PolizaKepler, total: number): boolean {
  let cargo = 0;
  let abono = 0;
  for (const r of p.renglones) {
    if (r['c4'] === 'C') cargo += cent(r['c5']);
    else if (r['c4'] === 'A') abono += cent(r['c5']);
  }
  return cargo === abono && abono === cent(total);
}
