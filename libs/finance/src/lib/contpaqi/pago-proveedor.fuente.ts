/**
 * `[CP.8.72]` — **De un movimiento de banco a la entrada del armador**: qué facturas y notas paga, de qué
 * proveedor y con qué cuenta. Es lo que `armarPagoProveedorCompleto` NO hace a propósito.
 *
 * Sin D8 (sin el REP ni la relación nota → factura del ADD), con lo que ya está en Postgres:
 *
 *   proveedor  L1: el pago de Kepler (X-D-25/26/60, `C%`) cuya cuenta de tesorería `c45` es la del banco,
 *              importe ±$1, fecha Kepler −2…+7 días · si no, el NOMBRE que escribió tesorería en el concepto
 *   RFC        `kdxd.c10` validado y reparado (`rfc-acreedor.ts`)
 *   facturas   L2/L3: lo que `kdxf` aplicó a ese pago → entradas `kdxe` (A·20) → CFDI por RFC + total (±$1)
 *              o por el folio de la referencia (≤ 3 %) · si no, UNA factura abierta del RFC por importe
 *   notas      las que `kdxf` aplicó a esas entradas (55 nota · 40 devolución) → CFDI de egreso
 *   cuenta     la ya usada con ese RFC antes de la fecha (99.7 %, `[CP.8.67]`); si no, `gl_supplier_accounts`
 *   2120       la provisión del mes en ContPAQi (diario, abono 2120 por el total) + la regla de 20 mil
 *
 * ⛔ Las combinaciones por importe NO se arman (37 % de error sin el ADD): van a confirmar.
 * Cruzado contra `database/scripts/punta-a-punta-proveedor-contpaqi.js` (`SIN_ADD=1`) en las 1,831 pólizas
 * de pago a proveedor de 2026: 975 de 977 armadas idénticas renglón por renglón.
 *
 * Lee dentro del alcance de tenant de quien lo llama (`fiscal.cfdis`, `finance.*` tienen RLS forzado).
 */
import type { Knex } from 'knex';
import type { EntradaPagoProveedor, FacturaPagada, NotaAplicada } from './pago-proveedor';
import { construirPadron, resolverRfcAcreedor, rfcPorTexto, type PadronEmisores } from './rfc-acreedor';

const TOL = 1;
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const dia = (s: string): number => Math.floor(Date.parse(String(s).slice(0, 10)) / 86400000);
const digitos = (s: unknown): string => String(s ?? '').replace(/[^0-9]/g, '');
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** El movimiento de banco tal como lo trae el armado. */
export interface MovimientoPago {
  cuenta_banco: string;
  importe: number;
  fecha: string;
  concepto: string;
}

export type FuenteFacturas = 'cadena_kepler' | 'importe_una' | 'confirmada';

export type ResolucionPago =
  | { estado: 'armable'; fuente: FuenteFacturas; proveedor_por_nombre: boolean; entrada: Omit<EntradaPagoProveedor, 'concepto'> }
  | { estado: 'a_confirmar' | 'sin_resolver'; motivo: string };

/** Un CFDI tal como se le muestra a quien confirma. */
export interface CfdiPropuesto {
  uuid: string; folio: string | null; fecha: string; total: number;
  /** Si ContPAQi ya lo tiene en una póliza de pago anterior, su fecha: la pantalla lo advierte. */
  pagada_antes?: string | null;
}

/** `[CP.8.73]` La propuesta para confirmar un pago: proveedor, candidatos y una sugerencia que NO se aplica sola. */
export interface PropuestaPago {
  rfc: string;
  proveedor_por_nombre: boolean;
  pagado: number;
  facturas: CfdiPropuesto[];
  notas: CfdiPropuesto[];
  /** UUID sugeridos (facturas). Vacío = sin sugerencia. */
  sugerencia: string[];
  origen: 'kepler' | 'importe' | null;
}

interface PagoKepler { acr: string; t: number; s: number; folio: string; f: string; monto: number; c45: string }
interface Aplicacion { acr: string; pt: number; ps: number; pf: string; dt: number; ds: number; df: string }
interface DocKepler { acr: string; t: number; s: number; folio: string; f: string; imp: number; ref: string | null }
interface Cfdi { u: string; rfc: string; nom: string | null; tc: 'I' | 'E'; folio: string | null; tot: number; iva: number; ieps: number; s16: number; f: string }

/** Agrega a una lista dentro de un mapa. */
function meter<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const xs = m.get(k); if (xs) xs.push(v); else m.set(k, [v]);
}

/** Tuplas (acreedor, tipo, subtipo, folio) como cuatro arreglos para `unnest`. */
function columnas(xs: readonly (readonly [string, number, number, string])[]): [string[], number[], number[], string[]] {
  return [xs.map((x) => x[0]), xs.map((x) => x[1]), xs.map((x) => x[2]), xs.map((x) => x[3])];
}

export class FuentePagoProveedor {
  private constructor(
    private readonly etiquetas: Map<string, string>,
    private readonly pagos: PagoKepler[],
    private readonly padron: PadronEmisores,
    private readonly mapa: Map<string, string>,
    private readonly rfcDe: Map<string, string>,
    private readonly aplicaciones: Map<string, Aplicacion[]> = new Map(),
    private readonly notasDe: Map<string, Aplicacion[]> = new Map(),
    private readonly docs: Map<string, DocKepler> = new Map(),
    private readonly cfdiPorRfc: Map<string, Cfdi[]> = new Map(),
    private readonly prov: Map<string, string> = new Map(),
    private readonly usoRfc: Map<string, { f: string; suf: string }[]> = new Map(),
    private readonly pagadaAntes: Map<string, string> = new Map(),
  ) {}

  /**
   * Carga lo necesario para resolver `movimientos` (los pagos entre `desde` y `hasta`, `YYYY-MM-DD`).
   * ⭐ En dos fases: cargar el universo costaba 6–12 s por mes (21,757 CFDI completos). Primero lo barato
   * —pagos de Kepler, acreedores, padrón de emisores— para saber QUÉ pagos y QUÉ proveedores entran;
   * después sólo sus aplicaciones, sus documentos, sus CFDI y su historia.
   */
  static async cargar(db: Knex, movimientos: readonly MovimientoPago[], desde: string, hasta: string): Promise<FuentePagoProveedor> {
    const anio = Number(desde.slice(0, 4));
    // ── Fase 1: lo barato ──────────────────────────────────────────────────────────────────────
    const etiquetas = new Map(
      ((await db('finance.bank_accounts').where({ tenant_id: MEGA }).whereNotNull('contpaqi_cuenta')
        .select('contpaqi_cuenta', 'account_label')) as { contpaqi_cuenta: string; account_label: string | null }[])
        .map((r) => [r.contpaqi_cuenta, String(r.account_label ?? '')]),
    );
    const pagos = (await db.raw(`
      SELECT DISTINCT ON (c4, c5, c6, c10) c10 acr, c4::int t, c5::int s, c6 folio, c9::date::text f,
             c16::float8 monto, btrim(coalesce(c45,'')) c45
        FROM kepler_ods.kdm1
       WHERE c2='X' AND c3='D' AND c4 IN (25,26,60) AND c10 LIKE 'C%' AND c9 BETWEEN ?::date - 3 AND ?::date + 8
       ORDER BY c4, c5, c6, c10, (btrim(c1)=sucursal) DESC`, [desde, hasta])).rows as PagoKepler[];
    const kdxd = (await db.raw(`
      SELECT DISTINCT ON (c2) c2, upper(btrim(coalesce(c10,''))) rfc, c3 nombre
        FROM kepler_ods.kdxd ORDER BY c2, (coalesce(btrim(c10),'') <> '') DESC`)).rows as { c2: string; rfc: string; nombre: string | null }[];
    const emisores = (await db.raw(`
      SELECT emisor_rfc rfc, emisor_nombre nom FROM fiscal.cfdis
       WHERE tenant_id = ? AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= ?::date - 400
       GROUP BY 1, 2`, [MEGA, desde])).rows as { rfc: string; nom: string | null }[];
    const mapaRows = (await db('finance.gl_supplier_accounts').where({ tenant_id: MEGA, activo: true }).whereNull('deleted_at')
      .whereNotNull('rfc').select('rfc', 'cuenta_proveedor')) as { rfc: string; cuenta_proveedor: string }[];
    const padron = construirPadron(emisores);
    const mapa = new Map(mapaRows.map((r) => [String(r.rfc).toUpperCase(), String(r.cuenta_proveedor).slice(4)]));

    // ── Qué pagos y qué proveedores entran: la misma L1 que `resolver` ────────────────────────────
    const fase1 = new FuentePagoProveedor(etiquetas, pagos, padron, mapa, new Map());
    const kdxdDe = new Map(kdxd.map((a) => [a.c2, a]));
    const rfcDe = new Map<string, string>(); const usados = new Map<string, PagoKepler>(); const rfcs = new Set<string>();
    for (const m of movimientos) {
      const l1 = fase1.candidatosL1(m);
      if (l1.length === 1) {
        const pg = l1[0]; usados.set(`${pg.acr}|${pg.t}|${pg.s}|${pg.folio}`, pg);
        if (!rfcDe.has(pg.acr)) {
          const a = kdxdDe.get(pg.acr);
          const rfc = (a ? resolverRfcAcreedor(a.rfc, a.nombre, padron)?.rfc : null) ?? (a?.rfc || null);
          if (rfc) rfcDe.set(pg.acr, rfc);
        }
        const rf = rfcDe.get(pg.acr); if (rf) { rfcs.add(rf); continue; }
      }
      const rt = rfcPorTexto(m.concepto, padron); if (rt) rfcs.add(rt);
    }

    // ── Fase 2: sólo lo de esos pagos y esos proveedores ──────────────────────────────────────────
    const tuplaPago = [...usados.values()].map((p) => [p.acr, p.t, p.s, p.folio] as const);
    const aps = tuplaPago.length ? (await db.raw(`
      SELECT DISTINCT f.c2 acr, f.c4::int pt, f.c5::int ps, f.c6 pf, f.c7::int dt, f.c8::int ds, f.c9 df
        FROM kepler_ods.kdxf f
        JOIN unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS u(acr, t, s, folio)
          ON f.c2 = u.acr AND f.c4::int = u.t AND f.c5::int = u.s AND f.c6 = u.folio`, columnas(tuplaPago))).rows as Aplicacion[] : [];
    const tuplaEntrada = aps.filter((a) => a.dt === 20).map((a) => [a.acr, a.dt, a.ds, a.df] as const);
    const apsNotas = tuplaEntrada.length ? (await db.raw(`
      SELECT DISTINCT f.c2 acr, f.c4::int pt, f.c5::int ps, f.c6 pf, f.c7::int dt, f.c8::int ds, f.c9 df
        FROM kepler_ods.kdxf f
        JOIN unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS u(acr, t, s, folio)
          ON f.c2 = u.acr AND f.c7::int = u.t AND f.c8::int = u.s AND f.c9 = u.folio
       WHERE f.c4::int IN (55, 40)`, columnas(tuplaEntrada))).rows as Aplicacion[] : [];
    const tuplaDoc = [...tuplaEntrada, ...apsNotas.map((a) => [a.acr, a.pt, a.ps, a.pf] as const)];
    const docsRows = tuplaDoc.length ? (await db.raw(`
      SELECT DISTINCT ON (x.c2, x.c4, x.c5, x.c6) x.c2 acr, x.c4::int t, x.c5::int s, x.c6 folio, x.c7::date::text f,
             x.c11::float8 imp, x.c16 ref
        FROM kepler_ods.kdxe x
        JOIN unnest(?::text[], ?::int[], ?::int[], ?::text[]) AS u(acr, t, s, folio)
          ON x.c2 = u.acr AND x.c4::int = u.t AND x.c5::int = u.s AND x.c6 = u.folio
       ORDER BY x.c2, x.c4, x.c5, x.c6, (btrim(x.c1)=x.sucursal) DESC`, columnas(tuplaDoc))).rows as DocKepler[] : [];
    const listaRfc = [...rfcs];
    // ⭐ La ventana de CFDI sale de los datos, no es fija: 180 días antes del mes para el importe, y 90 antes
    // de la entrada más vieja que aplica Kepler para la cadena. Fija a 200 días perdía 10 pagos de facturas
    // pagadas tarde; fija a 400 traía 12 mil CFDI (1.6 s) para usar unos cientos.
    const menos = (f: string, n: number): string => new Date(Date.parse(f) - n * 86400000).toISOString().slice(0, 10);
    const inicioCfdi = [menos(desde, 180), ...docsRows.map((d) => menos(d.f, 90))].sort()[0];
    const cfdis = listaRfc.length ? (await db.raw(`
      SELECT upper(uuid) u, emisor_rfc rfc, emisor_nombre nom, tipo_comprobante tc, folio, total::float8 tot,
             coalesce((impuestos->>'iva_trasladado')::float8,0) iva, coalesce((impuestos->>'ieps_trasladado')::float8,0) ieps,
             coalesce((impuestos->>'subtotal_iva_16')::float8,0) s16, fecha::date::text f
        FROM fiscal.cfdis
       WHERE tenant_id = ? AND rol='recibidas' AND tipo_comprobante IN ('I','E')
         AND fecha >= ?::date AND emisor_rfc = ANY(?)`, [MEGA, inicioCfdi, listaRfc])).rows as Cfdi[] : [];
    // Para la historia basta UUID → RFC (sin impuestos ni nombres): es lo que hace barata la ventana larga.
    const uuidsRfc = listaRfc.length ? (await db.raw(`
      SELECT upper(uuid) u, emisor_rfc rfc FROM fiscal.cfdis
       WHERE tenant_id = ? AND rol='recibidas' AND tipo_comprobante='I' AND fecha >= ?::date - 400 AND emisor_rfc = ANY(?)`,
    [MEGA, desde, listaRfc])).rows as { u: string; rfc: string }[] : [];
    // Historia: con qué cuenta se asentó cada RFC y qué facturas ya se pagaron (el RFC sale del CFDI del renglón).
    // ⛔ Unir por upper(cfdi_uuid) contra fiscal.cfdis agotaba el statement_timeout: se filtra por la lista de
    // UUID de esos RFC de los últimos 400 días.
    const rfcDeUuid = new Map(uuidsRfc.map((x) => [x.u, x.rfc]));
    const usoRows = rfcDeUuid.size ? ((await db.raw(`
      SELECT upper(l.cfdi_uuid) u, l.cuenta, p.fecha::date::text f
        FROM analytics.gl_polizas p
        JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source AND l.ejercicio=p.ejercicio
         AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.tenant_id = ? AND p.source='contpaqi' AND p.ejercicio IN (?, ?) AND p.tipo_pol='2'
         AND l.cargo_abono='C' AND l.cfdi_uuid IS NOT NULL AND l.cuenta ~ '^(2120|5010|5020)'
         AND upper(l.cfdi_uuid) = ANY(?)`, [MEGA, anio - 1, anio, [...rfcDeUuid.keys()]])).rows as { u: string; cuenta: string; f: string }[])
      .map((l) => ({ ...l, rfc: rfcDeUuid.get(l.u) ?? '' })) : [];
    const usoRfc = new Map<string, { f: string; suf: string }[]>(); const pagadaAntes = new Map<string, string>();
    for (const l of usoRows) {
      const f0 = pagadaAntes.get(l.u); if (!f0 || l.f < f0) pagadaAntes.set(l.u, l.f);
      meter(usoRfc, l.rfc, { f: l.f, suf: l.cuenta.slice(4) });
    }
    for (const v of usoRfc.values()) v.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
    // Provisiones (diario, abono 2120) sólo de las cuentas de esos proveedores.
    const cuentas = new Set<string>();
    for (const rf of listaRfc) {
      for (const u of usoRfc.get(rf) ?? []) cuentas.add(`2120${u.suf}`);
      const m = mapa.get(rf); if (m) cuentas.add(`2120${m}`);
    }
    const provRows = cuentas.size ? (await db.raw(`
      SELECT l.cuenta, round(l.importe::numeric,2)::float8 imp, min(p.fecha)::date::text f
        FROM analytics.gl_polizas p
        JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source AND l.ejercicio=p.ejercicio
         AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.tenant_id = ? AND p.source='contpaqi' AND p.ejercicio IN (?, ?) AND p.tipo_pol='3'
         AND l.cargo_abono='A' AND l.cuenta = ANY(?)
       GROUP BY 1, 2`, [MEGA, anio - 1, anio, [...cuentas]])).rows as { cuenta: string; imp: number; f: string }[] : [];

    const aplicaciones = new Map<string, Aplicacion[]>(); const notasDe = new Map<string, Aplicacion[]>();
    for (const a of aps) meter(aplicaciones, `${a.acr}|${a.pt}|${a.ps}|${a.pf}`, a);
    for (const a of apsNotas) meter(notasDe, `${a.acr}|${a.dt}|${a.ds}|${a.df}`, a);
    const docs = new Map(docsRows.map((d) => [`${d.acr}|${d.t}|${d.s}|${d.folio}`, d]));
    const cfdiPorRfc = new Map<string, Cfdi[]>(); for (const x of cfdis) meter(cfdiPorRfc, `${x.rfc}|${x.tc}`, x);
    const prov = new Map(provRows.map((x) => [`${x.cuenta}|${x.imp.toFixed(2)}`, x.f]));
    return new FuentePagoProveedor(etiquetas, pagos, padron, mapa, rfcDe, aplicaciones, notasDe, docs, cfdiPorRfc, prov, usoRfc, pagadaAntes);
  }

  /** L1: los pagos de Kepler que pueden ser este movimiento. Uno = proveedor identificado. */
  candidatosL1(m: MovimientoPago): PagoKepler[] {
    const B = r2(m.importe);
    return this.pagos.filter((x) => this.casaTesoreria(x.c45, m.cuenta_banco) && Math.abs(x.monto - B) <= TOL
      && dia(x.f) - dia(m.fecha) >= -2 && dia(x.f) - dia(m.fecha) <= 7);
  }

  private casaTesoreria(c45: string, cuentaBanco: string): boolean {
    const e = this.etiquetas.get(cuentaBanco); const t = String(c45 ?? '').trim();
    return !!e && !!t && (t === e || t.endsWith(e) || e.endsWith(t));
  }

  /** L3: la factura (o nota) de un documento de Kepler. `null` = no se encontró; `'ambiguo'` = más de una. */
  private buscarCfdi(rfc: string, tc: 'I' | 'E', imp: number, fecha: string, ref: string | null): Cfdi | 'ambiguo' | null {
    const ventana = (this.cfdiPorRfc.get(`${rfc}|${tc}`) ?? []).filter((x) => dia(x.f) <= dia(fecha) + 15 && dia(fecha) - dia(x.f) <= 90);
    const d = digitos(ref).slice(-4);
    const conRef = (xs: Cfdi[]): Cfdi[] => (d.length >= 3 ? xs.filter((x) => digitos(x.folio).endsWith(d)) : []);
    const exactos = ventana.filter((x) => Math.abs(x.tot - imp) <= TOL);
    if (exactos.length === 1) return exactos[0];
    if (exactos.length > 1) { const r1 = conRef(exactos); return r1.length === 1 ? r1[0] : 'ambiguo'; }
    const r = conRef(ventana).filter((x) => Math.abs(x.tot - imp) <= Math.max(TOL, 0.03 * imp));
    return r.length === 1 ? r[0] : null;
  }

  private cuentaDe(rfc: string, fecha: string): string | null {
    const h = (this.usoRfc.get(rfc) ?? []).filter((x) => x.f < fecha);
    return h.length ? h[h.length - 1].suf : this.mapa.get(rfc) ?? null;
  }

  private enProvision(suf: string, x: Cfdi, fechaPago: string): boolean {
    const fp = this.prov.get(`2120${suf}|${r2(x.tot).toFixed(2)}`);
    return !!fp && fp <= fechaPago && fp >= x.f.slice(0, 7);
  }

  /**
   * `[CP.8.73]` Lo que se le pone enfrente a quien confirma un pago que no se armó solo: el proveedor, sus
   * facturas y notas abiertas en la ventana, y una SUGERENCIA (nunca aplicada sola): lo que Kepler aplicó a
   * ese pago, o la única combinación de facturas que suma lo pagado.
   */
  proponer(m: MovimientoPago): PropuestaPago | null {
    const B = r2(m.importe);
    const l1 = this.candidatosL1(m);
    const pg = l1.length === 1 ? l1[0] : null;
    let rfc = pg ? this.rfcDe.get(pg.acr) ?? null : null;
    const porNombre = !rfc;
    if (!rfc) rfc = rfcPorTexto(m.concepto, this.padron);
    if (!rfc) return null;
    const enVentana = (x: Cfdi): boolean => dia(x.f) <= dia(m.fecha) + 30 && dia(m.fecha) - dia(x.f) <= 180;
    const abiertas = (this.cfdiPorRfc.get(`${rfc}|I`) ?? []).filter((x) => enVentana(x) && !((this.pagadaAntes.get(x.u) ?? '9999') < m.fecha));
    const notas = (this.cfdiPorRfc.get(`${rfc}|E`) ?? []).filter((x) => dia(x.f) <= dia(m.fecha) && dia(m.fecha) - dia(x.f) <= 180);
    // Sugerencia 1: lo que Kepler aplicó a ese pago (aunque la cadena no haya cerrado completa).
    let sugerencia: string[] = []; let origen: PropuestaPago['origen'] = null; const sugeridas: Cfdi[] = [];
    if (pg) {
      const aps = (this.aplicaciones.get(`${pg.acr}|${pg.t}|${pg.s}|${pg.folio}`) ?? []).filter((a) => a.dt === 20);
      for (const a of aps) {
        const d = this.docs.get(`${pg.acr}|${a.dt}|${a.ds}|${a.df}`);
        const x = d ? this.buscarCfdi(rfc, 'I', d.imp, d.f, d.ref) : null;
        if (x && x !== 'ambiguo' && !sugeridas.some((y) => y.u === x.u)) sugeridas.push(x);
      }
      if (sugeridas.length) { sugerencia = sugeridas.map((x) => x.u); origen = 'kepler'; }
    }
    // Sugerencia 2: la ÚNICA combinación (2..6) de facturas abiertas que suma lo pagado.
    if (!sugerencia.length) {
      const cand = abiertas.filter((x) => x.tot < B + TOL).sort((a, b) => b.tot - a.tot).slice(0, 24); const sols: string[][] = [];
      const rec = (i: number, s: number, sel: string[]): void => {
        if (sols.length > 1) return;
        if (sel.length >= 1 && Math.abs(s - B) <= TOL) { sols.push([...sel]); return; }
        if (sel.length >= 6 || i >= cand.length || s > B + TOL) return;
        sel.push(cand[i].u); rec(i + 1, s + cand[i].tot, sel); sel.pop(); rec(i + 1, s, sel);
      };
      rec(0, 0, []);
      if (sols.length === 1) { sugerencia = sols[0]; origen = 'importe'; }
    }
    const fila = (x: Cfdi): CfdiPropuesto => ({ uuid: x.u, folio: x.folio, fecha: x.f, total: x.tot, pagada_antes: this.pagadaAntes.get(x.u) ?? null });
    // ⛔ Lo sugerido SIEMPRE está en la lista: Kepler puede sugerir una factura fuera de la ventana o ya pagada
    // antes (se muestra con su fecha); sugerir algo que la pantalla no lista sería pedir confirmar a ciegas.
    const facturas = [...abiertas, ...sugeridas.filter((x) => !abiertas.some((y) => y.u === x.u))];
    return { rfc, proveedor_por_nombre: porNombre, pagado: B, facturas: facturas.map(fila), notas: notas.map(fila), sugerencia, origen };
  }

  /**
   * `[CP.8.73]` La entrada del armador con las facturas y notas que CONFIRMÓ una persona. Valida que sean
   * del proveedor del pago y estén en la ventana; el cuadre (facturas − notas = pagado) lo valida el armador.
   */
  entradaConfirmada(m: MovimientoPago, facturas: readonly string[], notas: readonly string[]): ResolucionPago {
    const p = this.proponer(m);
    if (!p) return { estado: 'sin_resolver', motivo: 'sin proveedor: no se puede confirmar un pago sin saber de quién es' };
    const suf = this.cuentaDe(p.rfc, m.fecha);
    if (!suf) return { estado: 'sin_resolver', motivo: `el proveedor ${p.rfc} no tiene cuenta en ContPAQi (ni historia ni mapa)` };
    const porUuid = new Map([...(this.cfdiPorRfc.get(`${p.rfc}|I`) ?? []), ...(this.cfdiPorRfc.get(`${p.rfc}|E`) ?? [])].map((x) => [x.u, x]));
    const F: Cfdi[] = []; const N: Cfdi[] = [];
    for (const u of facturas) { const x = porUuid.get(String(u).toUpperCase()); if (!x || x.tc !== 'I') return { estado: 'sin_resolver', motivo: `la factura ${u} no es del proveedor ${p.rfc} o está fuera de la ventana` }; F.push(x); }
    for (const u of notas) { const x = porUuid.get(String(u).toUpperCase()); if (!x || x.tc !== 'E') return { estado: 'sin_resolver', motivo: `la nota ${u} no es del proveedor ${p.rfc} o está fuera de la ventana` }; N.push(x); }
    if (!F.length) return { estado: 'sin_resolver', motivo: 'hay que confirmar al menos una factura' };
    if (new Set(F.map((x) => x.u)).size !== F.length || new Set(N.map((x) => x.u)).size !== N.length) {
      return { estado: 'sin_resolver', motivo: 'una factura o nota viene repetida' };
    }
    return { estado: 'armable', fuente: 'confirmada', proveedor_por_nombre: p.proveedor_por_nombre,
      entrada: { fecha: m.fecha, cuenta_banco: m.cuenta_banco, pagado: r2(m.importe), sufijo: suf,
        facturas: F.map((x) => ({ uuid: x.u, total: x.tot, iva: x.iva, ieps: x.ieps, base16: x.s16, fecha: x.f, enProvision: this.enProvision(suf, x, m.fecha) })),
        notas: N.map((x) => ({ uuid: x.u, total: x.tot, iva: x.iva, ieps: x.ieps, base16: x.s16, fecha: x.f, tipoRelacion: null })) } };
  }

  resolver(m: MovimientoPago): ResolucionPago {
    const B = r2(m.importe);
    const l1 = this.candidatosL1(m);
    let rfc: string | null = null; let porNombre = false;
    let F: Cfdi[] | null = null; let N: Cfdi[] = []; let fuente: FuenteFacturas | null = null;
    if (l1.length === 1) {
      const pg = l1[0]; rfc = this.rfcDe.get(pg.acr) ?? null;
      const aps = (this.aplicaciones.get(`${pg.acr}|${pg.t}|${pg.s}|${pg.folio}`) ?? []).filter((a) => a.dt === 20);
      if (rfc && aps.length) {
        const fs: Cfdi[] = []; const ns: Cfdi[] = []; let completa = true;
        for (const a of aps) {
          const d = this.docs.get(`${pg.acr}|${a.dt}|${a.ds}|${a.df}`);
          const x = d ? this.buscarCfdi(rfc, 'I', d.imp, d.f, d.ref) : null;
          if (!x || x === 'ambiguo') { completa = false; break; }
          if (!fs.some((y) => y.u === x.u)) fs.push(x);
          for (const n of this.notasDe.get(`${pg.acr}|${a.dt}|${a.ds}|${a.df}`) ?? []) {
            const dn = this.docs.get(`${pg.acr}|${n.pt}|${n.ps}|${n.pf}`);
            const y = dn ? this.buscarCfdi(rfc, 'E', dn.imp, dn.f, dn.ref) : null;
            if (y && y !== 'ambiguo' && !ns.some((z) => z.u === y.u)) ns.push(y);
          }
        }
        if (completa && fs.length) { F = fs; N = ns; fuente = 'cadena_kepler'; }
      }
    }
    if (!rfc) { rfc = rfcPorTexto(m.concepto, this.padron); porNombre = !!rfc; }
    if (!rfc) return { estado: 'sin_resolver', motivo: 'sin proveedor: ni pago en Kepler ni un nombre en el concepto que lleve a un RFC' };
    if (!F) {
      const abiertas = (this.cfdiPorRfc.get(`${rfc}|I`) ?? []).filter((x) => dia(x.f) <= dia(m.fecha) + 30 && dia(m.fecha) - dia(x.f) <= 180
        && !((this.pagadaAntes.get(x.u) ?? '9999') < m.fecha));
      const unas = abiertas.filter((x) => Math.abs(x.tot - B) <= TOL);
      if (unas.length === 1) { F = [unas[0]]; fuente = 'importe_una'; }
      else if (unas.length > 1) return { estado: 'a_confirmar', motivo: `${unas.length} facturas abiertas del proveedor por el mismo importe` };
      else return { estado: 'a_confirmar', motivo: 'sin cadena en Kepler y ninguna factura por el importe: varias facturas, notas o pago parcial' };
    }
    const suf = this.cuentaDe(rfc, m.fecha);
    if (!suf) return { estado: 'sin_resolver', motivo: `el proveedor ${rfc} no tiene cuenta en ContPAQi (ni historia ni mapa)` };
    const sumF = F.reduce((a, x) => a + x.tot, 0);
    // Sin la relación del ADD, las notas sólo salen de la cadena; si las facturas solas ya dan lo pagado, no van.
    const notas = Math.abs(sumF - B) <= TOL + 0.01 * F.length ? [] : (fuente === 'cadena_kepler' ? N : []);
    const facturas: FacturaPagada[] = F.map((x) => ({ uuid: x.u, total: x.tot, iva: x.iva, ieps: x.ieps, base16: x.s16, fecha: x.f, enProvision: this.enProvision(suf, x, m.fecha) }));
    const notasAp: NotaAplicada[] = notas.map((x) => ({ uuid: x.u, total: x.tot, iva: x.iva, ieps: x.ieps, base16: x.s16, fecha: x.f, tipoRelacion: null }));
    return { estado: 'armable', fuente: fuente ?? 'importe_una', proveedor_por_nombre: porNombre,
      entrada: { fecha: m.fecha, cuenta_banco: m.cuenta_banco, pagado: B, sufijo: suf, facturas, notas: notasAp } };
  }
}
