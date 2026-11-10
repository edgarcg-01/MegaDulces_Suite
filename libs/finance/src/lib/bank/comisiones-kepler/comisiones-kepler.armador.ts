import { ivaProporcional } from '../../payment-calendar/kepler-pago/pago-kepler.armador';

/**
 * `[CB.62]` — **Las comisiones de la terminal, de la descarga del banco al idioma de Kepler, sin tocar Kepler.**
 *
 * Plan: [`FASE_CB_CONCILIACION_BANCARIA.md`](../../../../../../docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md)
 * §9. Capa C1: funciones puras. Quien escribe (C2) lee lo vivo —la plantilla, el depósito en Kepler— y le
 * pasa aquí los datos; esto devuelve QUÉ documentos van o POR QUÉ no.
 *
 * ── Lo que Finanzas captura hoy a mano (medido en `kepler_ods`, octubre 2026) ─────────────────────────
 * Por cada sucursal, banco y **día de venta**:
 *   · una solicitud `X-A-15` y su gasto `X-A-10` (`c37/c38/c39` → la solicitud), con un renglón `kdm6` por
 *     COMISIÓN (`611-003`, concepto `199`) y el IVA de todas en la cabecera (`c14`); `c16` = total con IVA;
 *   · un pago `X-D-26` por CADA cargo del banco —la comisión y su IVA, aparte— aplicado a ese gasto, con la
 *     fecha y la cuenta del cargo, y su IVA proporcional (`c81`/`c82`, la misma regla que el pago a proveedor).
 * 273 gastos en octubre: 257 con una sola fecha de cargo, 265 pagados al centavo por sus pagos. Los 1,408 pagos
 * casan 1,357 con un cargo del banco (misma cuenta, importe exacto, ±3 días); placebo contra otra cuenta: 40.
 *
 * ⭐ El gasto va por DÍA DE VENTA, no por día de cargo: los cargos del lunes se reparten en los gastos de
 * viernes, sábado y domingo. El banco no dice el día; lo dice el depósito al que pertenece la comisión (el
 * renglón anterior de la misma terminal), que la sucursal captura en Kepler como `U-A-5` con «VTA DEL 02-11-26».
 *
 * ⛔ Fuera de este armador (se declaran, no se adivinan):
 *  - las cuotas fijas sin depósito (renta de terminal, cuota de afiliación de Santander): otra forma de gasto;
 *  - el cargo cuya terminal no tiene depósito abierto en la descarga: queda «huérfano», por revisar;
 *  - los ACUMULADOS que Kepler mueve además (`kdxg` del acreedor, `kdc126` por cuenta, `kdcn26` por centro de
 *    costo) y los números de folio y de póliza: los resuelve C2, y la lista se cierra con una captura real
 *    (foto de contadores antes y después). La póliza, `kdxe` y `kdxf` sí están aquí, medidos en el ODS.
 */

/** Quién capturó (`kdm1.c67`): la Suite, como en el pago a proveedor. */
export const CAPTURISTA_SUITE = 'SUITE';
/** El renglón del gasto, igual en las 9 sucursales (734 de 734 renglones de octubre). */
export const CUENTA_COMISION = '611-003';
export const TEXTO_COMISION = 'COMISIONES BANCARIAS POR VENTA';
export const CONCEPTO_GASTO_COMISION = '199';
/** El IVA del gasto en la póliza (272 de 272 gastos de octubre). */
export const CUENTA_IVA_ACREDITABLE = '122-001';

export type TipoCargo = 'comision' | 'iva';

/** Un renglón de la descarga del banco (`finance.bank_statement_lines`). */
export interface RenglonDescarga {
  id: string;
  /** `finance.bank_accounts.account_label` = `kdm1.c45` del pago en Kepler. */
  cuenta: string;
  /** `YYYY-MM-DD`. */
  fecha: string;
  /** El orden cronológico del lector (`seq`). */
  seq: number;
  concepto: string;
  entra: number;
  sale: number;
}

/** La tarjeta que identifica el bloque: la terminal y la clase de venta. */
export interface Tarjeta { terminal: string; clase: string }

// BBVA: el depósito dice `/145096809` y su comisión `/175096809`: la terminal es lo que sigue a los 2 primeros.
const BBVA_CLASE: [RegExp, string][] = [[/CREDITO/, 'CREDITO'], [/DEBITO/, 'DEBITO'], [/TDC INTER/, 'INTER'], [/NAL\.? AMEX/, 'AMEX_NAL'], [/INTL\.? AMEX/, 'AMEX_INTL']];
const BBVA_DEPOSITO = /^VENTAS? (CREDITO|DEBITO|TDC INTER|NAL\.? AMEX|INTL\.? AMEX)\/\d{2}(\d{5,})/;
const BBVA_COMISION = /^(APLI TASA DE DES (CREDITO|DEBITO)|COM\.? VTAS? TDC INTER|COM\.? VTA\.? (NAL|INTL)\.? AMEX)\/\d{2}(\d{5,})/;
const BBVA_IVA = /^IVA (TASA DE DESC (CREDITO|DEBITO)|COM\.? VTAS? TDC INTER|COM\.? VTA\.? (NAL|INTL)\.? AMEX)\/\d{2}(\d{5,})/;
// Banorte: la afiliación con su letra (C crédito, D débito) va pegada en los tres renglones del bloque.
const BTE_COMISION = /^COMISION (\d{6,}[CD])APLICACION DE TASAS/;
const BTE_IVA = /^I\.?\s?V\.?\s?A\.? COMISION (\d{6,}[CD])\b/;
const BTE_DEPOSITO = /\b(\d{8}[CD])\s*$/;

const claseBbva = (s: string): string => BBVA_CLASE.find(([re]) => re.test(s))?.[1] ?? 'OTRA';
const limpio = (s: string): string => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** La comisión o el IVA de una venta con tarjeta, con su terminal. `null` si el renglón no es eso. */
export function cargoDeTarjeta(r: Pick<RenglonDescarga, 'concepto' | 'entra' | 'sale'>): (Tarjeta & { tipo: TipoCargo }) | null {
  if (!(r.sale > 0) || r.entra > 0) return null;
  const c = limpio(r.concepto);
  let m = BBVA_IVA.exec(c);
  if (m) return { tipo: 'iva', terminal: m[4], clase: claseBbva(m[1]) };
  m = BBVA_COMISION.exec(c);
  if (m) return { tipo: 'comision', terminal: m[4], clase: claseBbva(m[1]) };
  m = BTE_IVA.exec(c);
  if (m) return { tipo: 'iva', terminal: m[1], clase: 'BTE' };
  m = BTE_COMISION.exec(c);
  if (m) return { tipo: 'comision', terminal: m[1], clase: 'BTE' };
  return null;
}

/** El depósito de la venta con tarjeta, con su terminal. `null` si el renglón no es eso. */
export function depositoDeTarjeta(r: Pick<RenglonDescarga, 'concepto' | 'entra' | 'sale'>): Tarjeta | null {
  if (!(r.entra > 0) || r.sale > 0) return null;
  const c = limpio(r.concepto);
  const m = BBVA_DEPOSITO.exec(c);
  if (m) return { terminal: m[2], clase: claseBbva(m[1]) };
  const b = BTE_DEPOSITO.exec(c);
  if (b && !/^(COMISION|IVA|I\.V\.A)/.test(c)) return { terminal: b[1], clase: 'BTE' };
  return null;
}

export interface CargoTarjeta {
  id: string;
  cuenta: string;
  fecha: string;
  seq: number;
  importe: number;
  tipo: TipoCargo;
}

export interface BloqueTarjeta {
  /** El depósito que abre el bloque: el que la sucursal captura en Kepler (`U-A-5`). */
  deposito: { id: string; cuenta: string; fecha: string; importe: number; terminal: string; clase: string };
  cargos: CargoTarjeta[];
}

export interface Bloques {
  bloques: BloqueTarjeta[];
  /** Cargos de tarjeta sin depósito abierto de su terminal antes de ellos, en la misma cuenta y día. */
  huerfanos: CargoTarjeta[];
}

/**
 * Parte la descarga en bloques «depósito → su comisión → su IVA». Medido en la descarga de BBVA 4885 y
 * Banorte 7744 (31-oct al 3-nov): los tres renglones van seguidos y el depósito primero. Un bloque no recibe
 * dos comisiones ni dos IVA: el segundo abre la duda y va a huérfanos, no se suma al de otro día.
 */
export function bloquesDeTarjeta(renglones: readonly RenglonDescarga[]): Bloques {
  const orden = [...renglones].sort((a, b) => (a.cuenta < b.cuenta ? -1 : a.cuenta > b.cuenta ? 1 : a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.seq - b.seq));
  const bloques: BloqueTarjeta[] = [];
  const huerfanos: CargoTarjeta[] = [];
  const abierto = new Map<string, BloqueTarjeta>();
  let dia = '';
  for (const r of orden) {
    if (`${r.cuenta}|${r.fecha}` !== dia) { abierto.clear(); dia = `${r.cuenta}|${r.fecha}`; }
    const d = depositoDeTarjeta(r);
    if (d) {
      const b: BloqueTarjeta = { deposito: { id: r.id, cuenta: r.cuenta, fecha: r.fecha, importe: r.entra, ...d }, cargos: [] };
      bloques.push(b);
      abierto.set(`${d.terminal}|${d.clase}`, b);
      continue;
    }
    const c = cargoDeTarjeta(r);
    if (!c) continue;
    const cargo: CargoTarjeta = { id: r.id, cuenta: r.cuenta, fecha: r.fecha, seq: r.seq, importe: r.sale, tipo: c.tipo };
    const b = abierto.get(`${c.terminal}|${c.clase}`);
    if (!b || b.cargos.some((x) => x.tipo === c.tipo)) { huerfanos.push(cargo); continue; }
    b.cargos.push(cargo);
  }
  return { bloques, huerfanos };
}

/**
 * El día de venta, del texto con que la sucursal capturó el depósito en Kepler (`U-A-5.c12`): «VTA DEL
 * 02-11-26», «VENTA DEL 30-10-26 EN TERMINAL», «VTA 31-10-26», «01/10/2026». Sólo se acepta un día ANTERIOR
 * al del banco y a no más de 7 días: lo demás es un dedazo y se devuelve `null` (por revisar). Medido en la
 * sombra del 3-nov: los dos depósitos que decían «VENTAS 3/11/2026» —el mismo día que el banco los abonó— los
 * puso Finanzas en el gasto del 1-nov y del 31-oct; la terminal liquida al día siguiente.
 */
export function diaDeVentaDelTexto(texto: string | null | undefined, fechaBanco: string): string | null {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(String(texto ?? ''));
  if (!m) return null;
  const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dia = `${anio}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = Date.parse(`${dia}T00:00:00Z`);
  const banco = Date.parse(`${fechaBanco}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(banco) || new Date(t).toISOString().slice(0, 10) !== dia) return null;
  const dias = (banco - t) / 86_400_000;
  return dias >= 1 && dias <= 7 ? dia : null;
}

/**
 * Lo que Kepler ya tiene de esa sucursal y banco, de su último gasto de comisiones capturado a mano. Lo lee
 * C2 en vivo; aquí no se inventa ninguno de estos valores.
 */
export interface PlantillaComisiones {
  /** `kdm1.c10`: el banco como acreedor (`GB004` BBVA…). */
  acreedor: string;
  /** `kdm1.c32`–`c35`: nombre y domicilio, como los trae su último pago. */
  nombre: string;
  domicilio: [string, string, string];
  /** `kdm1.c11` de la solicitud y el gasto. */
  referenciaGasto: string;
  /** `kdm1.c30`. */
  areaGasto: string;
  /** `kdm6.c13` (proyecto) y `c16` (departamento de la sucursal: `1-02-32-00` en Madero). */
  proyecto: string;
  departamento: string;
  /** `kdm1.c12` del pago (catálogo `kdxv`). */
  conceptoPago: string;
  /** `kdm1.c48` del pago: la sucursal en texto. */
  sucursalTexto: string;
  /** Para el texto de la cabecera (`c24`). */
  sucursalNombre: string;
  /**
   * El abono del acreedor en la póliza del gasto, como lo trae su último gasto: `201` en las sucursales de TPV;
   * CEDIS asienta sus cuotas de banco a `203` (acreedores diversos) y `702-002`, fuera de este armador.
   */
  cuentaAcreedor: string;
}

export interface GrupoComisiones {
  /** El servidor (`md_NN`) donde se captura: la sucursal del depósito en Kepler. */
  sucursal: string;
  /** `YYYY-MM-DD`: el día de venta. */
  diaVenta: string;
  /** `kdm1.c10`: el banco como acreedor. La sucursal 08 lleva un gasto de BBVA y otro de Banorte el mismo día. */
  acreedor: string;
  /** Los cargos de todos los bloques de ese día (comisiones e IVA), en el orden del banco. */
  cargos: CargoTarjeta[];
}

type Valor = string | number;

/**
 * Una póliza `kdc2AAMM`: tipo (`c8`), fecha (`c2`) y renglones. El número (`c1`, `MAX+1` por mes y tipo), la
 * sucursal (`c14`) y el documento (`c15`–`c19`) los pone C2 al escribir. Medido en octubre: los 1,408 pagos
 * traen UNA póliza `E` de dos renglones (cargo 201, abono 102, su fecha y su referencia en `c7`); 272 de 273
 * gastos traen UNA póliza `D` con su fecha y referencia, el IVA en 122-001 (272 de 272) y un 611-003 por renglón.
 * La solicitud no hace póliza.
 */
export interface PolizaKepler { tipo: 'D' | 'E'; fecha: string; renglones: Record<string, Valor>[] }

export interface PlanComisionesKepler {
  /** La solicitud `X-A-15`: cabecera y renglones (`c6` folio lo pone C2, `MAX+1`). */
  solicitud: { kdm1: Record<string, Valor>; kdm6: Record<string, Valor>[] };
  /** El gasto `X-A-10`: igual a la solicitud y apuntándola (`c39` = folio de la solicitud, lo pone C2). */
  gasto: { kdm1: Record<string, Valor>; kdm6: Record<string, Valor>[]; kdxe: Record<string, Valor>; poliza: PolizaKepler };
  /**
   * Un `X-D-26` por cargo del banco, aplicado al gasto (`kdxf`: C2 pone `c6`, el folio del pago, y `c9`, el del
   * gasto). Como todos se escriben con el gasto, su saldo (`kdxe.c20`) queda en 0: el de los 7 gastos idénticos
   * de la sombra lo está.
   */
  pagos: { cargo: string; kdm1: Record<string, Valor>; kdxe: Record<string, Valor>; kdxf: Record<string, Valor>; poliza: PolizaKepler }[];
  total: number;
  iva: number;
}

export type ResultadoComisiones = { ok: true; plan: PlanComisionesKepler } | { ok: false; motivos: string[] };

const cent = (n: number): number => Math.round(Number(n) * 100);
const TASA_IVA = 0.16;
/**
 * Cuánto se aleja el IVA del banco del 16 % de SU comisión. Medido en 272 bloques de la descarga (1–10 nov):
 * BBVA, 260 de 261 al centavo exacto y uno a +1; Banorte, hasta ±4 centavos (calcula el IVA sobre otra base).
 * Un IVA faltante, por chico que sea, lo detecta antes la revisión del bloque (`revisarBloque`).
 */
export const HOLGURA_IVA_CENTAVOS = 5;

const ddmmaaaa = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Arma solicitud, gasto y pagos de un día de venta, o dice por qué no. Fail-closed: un motivo basta. */
export function armarComisionesKepler(g: GrupoComisiones, p: PlantillaComisiones): ResultadoComisiones {
  const motivos: string[] = [];
  if (!/^\d{2}$/.test(g.sucursal)) motivos.push(`Sucursal Kepler inválida «${g.sucursal}»`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g.diaVenta)) motivos.push(`Día de venta inválido «${g.diaVenta}»`);
  if (p.acreedor !== g.acreedor) motivos.push(`La plantilla es del acreedor ${p.acreedor} y el día es de ${g.acreedor}`);
  if (!/^GB/.test(p.acreedor ?? '')) motivos.push(`El acreedor «${p.acreedor || '(vacío)'}» no es un banco (GB…)`);
  for (const k of ['proyecto', 'departamento', 'conceptoPago'] as const) {
    if (!String(p[k] ?? '').trim()) motivos.push(`La plantilla no trae ${k}: no se copia de otra sucursal`);
  }
  if (!['201', '203'].includes(String(p.cuentaAcreedor ?? '').trim())) motivos.push(`La cuenta del acreedor «${p.cuentaAcreedor || '(vacía)'}» no es 201 ni 203`);
  const comisiones = g.cargos.filter((c) => c.tipo === 'comision');
  if (!comisiones.length) motivos.push('El día no tiene comisiones: un IVA solo no hace gasto');
  for (const c of g.cargos) {
    if (!(c.importe > 0)) motivos.push(`El cargo ${c.id} no tiene importe positivo`);
    if (!String(c.cuenta ?? '').trim()) motivos.push(`El cargo ${c.id} no trae cuenta de tesorería`);
    if (g.diaVenta && c.fecha < g.diaVenta) motivos.push(`El cargo ${c.id} (${c.fecha}) es anterior al día de venta ${g.diaVenta}`);
  }
  const base = comisiones.reduce((s, c) => s + cent(c.importe), 0);
  const iva = g.cargos.filter((c) => c.tipo === 'iva').reduce((s, c) => s + cent(c.importe), 0);
  if (comisiones.length && Math.abs(iva - Math.round(base * TASA_IVA)) > HOLGURA_IVA_CENTAVOS * comisiones.length) {
    motivos.push(`El IVA del día (${(iva / 100).toFixed(2)}) no es el 16 % de las comisiones (${(base / 100).toFixed(2)}): falta o sobra un cargo`);
  }
  if (motivos.length) return { ok: false, motivos };

  const total = (base + iva) / 100;
  const ivaTotal = iva / 100;
  const cabecera: Record<string, Valor> = {
    c9: g.diaVenta, c18: g.diaVenta, c7: 'PESOS', c10: p.acreedor, c11: p.referenciaGasto, c14: ivaTotal, c16: total,
    c24: `COMISIONES ${p.sucursalNombre} VTA ${ddmmaaaa(g.diaVenta)}`, c30: p.areaGasto, c32: p.nombre, c67: CAPTURISTA_SUITE,
  };
  const renglones = comisiones.map((c, i) => ({
    c7: i + 1, c8: CUENTA_COMISION, c9: TEXTO_COMISION, c10: 'C', c11: cent(c.importe) / 100,
    c12: CONCEPTO_GASTO_COMISION, c13: p.proyecto, c16: p.departamento,
  }));
  // La póliza repite el importe en `c5` y en `c9` (este con 4 decimales en Kepler).
  const asiento = (c3: string, c4: 'C' | 'A', importe: number, c6: string, c7: string, extra: Record<string, Valor> = {}): Record<string, Valor> =>
    ({ c3, c4, c5: importe, c9: importe, c6, c7, ...extra });
  const polizaGasto: PolizaKepler = {
    tipo: 'D', fecha: g.diaVenta,
    renglones: [
      asiento(p.cuentaAcreedor.trim(), 'A', total, p.nombre, p.referenciaGasto),
      ...(iva > 0 ? [asiento(CUENTA_IVA_ACREDITABLE, 'C', ivaTotal, p.nombre, p.referenciaGasto)] : []),
      ...renglones.map((r) => asiento(CUENTA_COMISION, 'C', Number(r.c11), TEXTO_COMISION, p.referenciaGasto, { c13: p.departamento, c20: CONCEPTO_GASTO_COMISION, c21: p.proyecto })),
    ].map((r, i) => ({ c10: i + 1, ...r })),
  };
  const pagos = g.cargos.map((c) => {
    const importe = cent(c.importe) / 100;
    const ref = c.tipo === 'iva' ? 'IVA' : 'COMISIONES';
    const { c81, c82 } = ivaProporcional([{ aplicado: importe, iva: ivaTotal, ieps: 0, total }]);
    return {
      cargo: c.id,
      kdm1: {
        c9: c.fecha, c7: 'PESOS', c10: p.acreedor, c11: ref, c12: p.conceptoPago,
        c16: importe, c42: importe, c43: 'N', c31: 'Tra', c45: c.cuenta, c48: p.sucursalTexto,
        c32: p.nombre, c33: p.domicilio[0], c34: p.domicilio[1], c35: p.domicilio[2], c67: CAPTURISTA_SUITE, c81, c82,
      } as Record<string, Valor>,
      kdxe: { c2: p.acreedor, c3: 'D', c4: 26, c5: 1, c7: c.fecha, c8: 'PESOS', c11: importe, c16: ref, c17: importe, c18: p.conceptoPago, c20: 0, c22: c.cuenta, c28: 'X', c29: 'C' } as Record<string, Valor>,
      kdxf: { c1: g.sucursal, c2: p.acreedor, c3: c.fecha, c4: 26, c5: 1, c7: 10, c8: 1, c10: importe, c11: importe } as Record<string, Valor>,
      poliza: {
        tipo: 'E' as const, fecha: c.fecha,
        renglones: [asiento('201', 'C', importe, p.nombre, ref), asiento('102', 'A', importe, p.nombre, ref)].map((r, i) => ({ c10: i + 1, ...r })),
      },
    };
  });
  return {
    ok: true,
    plan: {
      solicitud: { kdm1: { ...cabecera, c31: 'Sol', c43: 'F' }, kdm6: renglones },
      gasto: {
        kdm1: { ...cabecera, c31: 'Gas', c36: 'A', c37: 15, c38: 1, c42: total, c43: 'N', c90: '01' },
        kdm6: renglones.map((r) => ({ ...r })),
        kdxe: { c2: p.acreedor, c3: 'A', c4: 10, c5: 1, c7: g.diaVenta, c8: 'PESOS', c10: g.diaVenta, c11: total, c13: ivaTotal, c16: p.referenciaGasto, c17: total, c20: 0, c28: 'X', c29: 'A' },
        poliza: polizaGasto,
      },
      pagos,
      total,
      iva: ivaTotal,
    },
  };
}

/**
 * Un bloque completo trae UNA comisión y SU IVA, y el IVA es el 16 % de la comisión (±5 centavos). Medido: 272
 * de 272 bloques de la descarga del 1 al 10-nov vienen así. Lo que no, se revisa: un IVA que falta, aunque sea
 * de $0.14, se ve aquí y no se pierde en la suma del día. `null` = completo.
 */
export function revisarBloque(b: BloqueTarjeta): string | null {
  const com = b.cargos.filter((c) => c.tipo === 'comision');
  const iva = b.cargos.filter((c) => c.tipo === 'iva');
  if (com.length !== 1 || iva.length !== 1) return `el bloque trae ${com.length} comisión(es) y ${iva.length} IVA: se esperaba una de cada una`;
  const dif = Math.round(iva[0].importe * 100) - Math.round(com[0].importe * 100 * 0.16);
  return Math.abs(dif) > HOLGURA_IVA_CENTAVOS ? `el IVA (${iva[0].importe.toFixed(2)}) no es el 16 % de su comisión (${com[0].importe.toFixed(2)})` : null;
}

/** El bloque cuyo depósito la sucursal todavía no captura en Kepler: sin él no hay sucursal ni día de venta. */
export const MOTIVO_SIN_DEPOSITO = 'el depósito no está en Kepler (U-A-5)';

/** Un depósito de tesorería capturado por la sucursal en Kepler (`U-A-5`), con su texto. */
export interface DepositoKepler { sucursal: string; folio: string; cuenta: string; importe: number; fecha: string; concepto: string }

const DIA = 86_400_000;
const lejos = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));

/**
 * El bloque, resuelto con su depósito en Kepler: misma cuenta, importe exacto, ±3 días. Sin depósito, con
 * dos depósitos distintos del mismo importe, sin acreedor para la cuenta o sin día de venta legible: motivo, y
 * el bloque queda por revisar. Lo usan el servicio y la sombra (una sola regla).
 */
export function resolverBloque(
  b: BloqueTarjeta, depositos: readonly DepositoKepler[], acreedorDe: ReadonlyMap<string, string>,
): { sucursal: string; diaVenta: string; acreedor: string } | { motivo: string } {
  const m = depositos.filter((u) => u.cuenta === b.deposito.cuenta && Math.abs(u.importe - b.deposito.importe) < 0.005 && lejos(u.fecha, b.deposito.fecha) <= 3 * DIA);
  if (!m.length) return { motivo: MOTIVO_SIN_DEPOSITO };
  if (new Set(m.map((u) => `${u.sucursal}|${u.concepto}`)).size > 1) return { motivo: 'dos U-A-5 con el mismo importe' };
  const acreedor = acreedorDe.get(b.deposito.cuenta);
  if (!acreedor) return { motivo: 'la cuenta no tiene acreedor GB en Kepler' };
  const dia = diaDeVentaDelTexto(m[0].concepto, b.deposito.fecha);
  return dia ? { sucursal: m[0].sucursal, diaVenta: dia, acreedor } : { motivo: `el U-A-5 no dice el día de venta («${m[0].concepto}»)` };
}

/** Un `X-D-26` que Finanzas ya capturó a un banco (`GB…`). */
export interface PagoKeplerCapturado { sucursal: string; folio: string; cuenta: string; importe: number; fecha: string }

/**
 * ⛔ **El candado contra duplicados.** Mientras Finanzas siga capturando a mano (D3: el cambio de manos es
 * cuenta por cuenta), un cargo cuyo pago ya está en Kepler NO se escribe. Pareo uno a uno: misma cuenta,
 * importe exacto, ±3 días; entre iguales, la sucursal del cargo y luego el día más cercano. Medido: 1,357 de
 * 1,408 pagos de octubre casan así con un cargo del banco; contra otra cuenta del mismo banco, 40.
 * Un falso pareo hace que un cargo NO se escriba (queda en revisión): el lado seguro.
 */
export function cruzarConKepler(
  cargos: readonly (CargoTarjeta & { sucursal?: string })[], pagos: readonly PagoKeplerCapturado[],
): Map<string, PagoKeplerCapturado> {
  const usados = new Set<number>();
  const out = new Map<string, PagoKeplerCapturado>();
  for (const c of cargos) {
    let mejor = -1;
    for (let j = 0; j < pagos.length; j++) {
      const k = pagos[j];
      if (usados.has(j) || k.cuenta !== c.cuenta || Math.abs(k.importe - c.importe) >= 0.005 || lejos(k.fecha, c.fecha) > 3 * DIA) continue;
      if (mejor < 0) { mejor = j; continue; }
      const a = pagos[mejor];
      const mejorPorSucursal = Number(k.sucursal === c.sucursal) - Number(a.sucursal === c.sucursal);
      if (mejorPorSucursal > 0 || (mejorPorSucursal === 0 && lejos(k.fecha, c.fecha) < lejos(a.fecha, c.fecha))) mejor = j;
    }
    if (mejor >= 0) { usados.add(mejor); out.set(c.id, pagos[mejor]); }
  }
  return out;
}

/**
 * Junta los bloques en días de venta por sucursal. `donde` resuelve cada bloque con su depósito en Kepler
 * (sucursal y día de venta); el bloque que no se resuelve se devuelve aparte, con su porqué, y no entra a
 * ningún día: un cargo puesto en el día equivocado cambia el mes del gasto.
 */
export function gruposPorDiaDeVenta(
  bloques: readonly BloqueTarjeta[],
  donde: (b: BloqueTarjeta) => { sucursal: string; diaVenta: string; acreedor: string } | { motivo: string },
): { grupos: GrupoComisiones[]; sinResolver: { bloque: BloqueTarjeta; motivo: string }[] } {
  const grupos = new Map<string, GrupoComisiones>();
  const sinResolver: { bloque: BloqueTarjeta; motivo: string }[] = [];
  for (const b of bloques) {
    if (!b.cargos.length) continue;
    const incompleto = revisarBloque(b);
    if (incompleto) { sinResolver.push({ bloque: b, motivo: incompleto }); continue; }
    const r = donde(b);
    if ('motivo' in r) { sinResolver.push({ bloque: b, motivo: r.motivo }); continue; }
    const k = `${r.sucursal}|${r.diaVenta}|${r.acreedor}`;
    const g = grupos.get(k) ?? { sucursal: r.sucursal, diaVenta: r.diaVenta, acreedor: r.acreedor, cargos: [] };
    g.cargos.push(...b.cargos);
    grupos.set(k, g);
  }
  for (const g of grupos.values()) g.cargos.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.seq - b.seq));
  return { grupos: [...grupos.values()].sort((a, b) => (a.sucursal + a.diaVenta + a.acreedor < b.sucursal + b.diaVenta + b.acreedor ? -1 : 1)), sinResolver };
}
