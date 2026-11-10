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
 *  - las tablas que Kepler escribe además (`kdxe`, `kdxf`, `kdxg`, la póliza `kdc2AAMM`, `kdc126`, `kdcn26`):
 *    se miden con una captura real antes de C2.
 */

/** Quién capturó (`kdm1.c67`): la Suite, como en el pago a proveedor. */
export const CAPTURISTA_SUITE = 'SUITE';
/** El renglón del gasto, igual en las 9 sucursales (734 de 734 renglones de octubre). */
export const CUENTA_COMISION = '611-003';
export const TEXTO_COMISION = 'COMISIONES BANCARIAS POR VENTA';
export const CONCEPTO_GASTO_COMISION = '199';

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

export interface PlanComisionesKepler {
  /** La solicitud `X-A-15`: cabecera y renglones (`c6` folio lo pone C2, `MAX+1`). */
  solicitud: { kdm1: Record<string, Valor>; kdm6: Record<string, Valor>[] };
  /** El gasto `X-A-10`: igual a la solicitud y apuntándola (`c39` = folio de la solicitud, lo pone C2). */
  gasto: { kdm1: Record<string, Valor>; kdm6: Record<string, Valor>[] };
  /** Un `X-D-26` por cargo del banco, aplicado al gasto. */
  pagos: { cargo: string; kdm1: Record<string, Valor> }[];
  total: number;
  iva: number;
}

export type ResultadoComisiones = { ok: true; plan: PlanComisionesKepler } | { ok: false; motivos: string[] };

const cent = (n: number): number => Math.round(Number(n) * 100);
/** El banco redondea el IVA cargo por cargo: un centavo por renglón es la holgura contra el 16 %. */
const TASA_IVA = 0.16;

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
  const comisiones = g.cargos.filter((c) => c.tipo === 'comision');
  if (!comisiones.length) motivos.push('El día no tiene comisiones: un IVA solo no hace gasto');
  for (const c of g.cargos) {
    if (!(c.importe > 0)) motivos.push(`El cargo ${c.id} no tiene importe positivo`);
    if (!String(c.cuenta ?? '').trim()) motivos.push(`El cargo ${c.id} no trae cuenta de tesorería`);
    if (g.diaVenta && c.fecha < g.diaVenta) motivos.push(`El cargo ${c.id} (${c.fecha}) es anterior al día de venta ${g.diaVenta}`);
  }
  const base = comisiones.reduce((s, c) => s + cent(c.importe), 0);
  const iva = g.cargos.filter((c) => c.tipo === 'iva').reduce((s, c) => s + cent(c.importe), 0);
  if (comisiones.length && Math.abs(iva - Math.round(base * TASA_IVA)) > g.cargos.length) {
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
  const pagos = g.cargos.map((c) => {
    const importe = cent(c.importe) / 100;
    const { c81, c82 } = ivaProporcional([{ aplicado: importe, iva: ivaTotal, ieps: 0, total }]);
    return {
      cargo: c.id,
      kdm1: {
        c9: c.fecha, c7: 'PESOS', c10: p.acreedor, c11: c.tipo === 'iva' ? 'IVA' : 'COMISIONES', c12: p.conceptoPago,
        c16: importe, c42: importe, c43: 'N', c31: 'Tra', c45: c.cuenta, c48: p.sucursalTexto,
        c32: p.nombre, c33: p.domicilio[0], c34: p.domicilio[1], c35: p.domicilio[2], c67: CAPTURISTA_SUITE, c81, c82,
      } as Record<string, Valor>,
    };
  });
  return {
    ok: true,
    plan: {
      solicitud: { kdm1: { ...cabecera, c31: 'Sol', c43: 'F' }, kdm6: renglones },
      gasto: { kdm1: { ...cabecera, c31: 'Gas', c36: 'A', c37: 15, c38: 1, c42: total, c43: 'N', c90: '01' }, kdm6: renglones.map((r) => ({ ...r })) },
      pagos,
      total,
      iva: ivaTotal,
    },
  };
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
