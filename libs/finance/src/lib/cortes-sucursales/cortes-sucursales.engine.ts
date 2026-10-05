/**
 * `[CSU.1]` Motor de Cortes/Sucursales — la lógica pura, sin base de datos, para poder probarla.
 *
 * ── LO QUE SE MIDIÓ ANTES DE ESCRIBIR ESTO (prod, 2026-10-05) ───────────────────────────────
 * · El corte `U-D-23` deja un cargo a `CONTADO` en `kepler_ods.kdue` con la referencia
 *   `Caja <caja>-<folio de arqueo>`. Los 110 cortes de oct-2026 encontraron arqueo salvo 2.
 * · **El monto del corte es lo que CONTÓ el cajero** (efectivo + tarjeta + transferencia del
 *   arqueo), no lo que vendió: 91 de 121 pares iguales al centavo contra lo contado, 73 contra
 *   lo esperado. Por eso la caja 5-151 de Zamora Centro tiene corte $1,203.36 contra $10,203.36
 *   vendidos: el cajero contó $1,067.30 donde el POS esperaba $10,067.30.
 * · Comparar contra los tickets del DÍA daba diferencias falsas de ±$90 mil cuando el turno
 *   cruza la medianoche. El testigo es el arqueo del TURNO.
 */
import type {
  CorteArqueo, CorteCobro, CorteCuadre, CorteEstadoCobro, CorteRow, CorteSucursalResumen,
  CortesSucursalesResponse,
} from '@megadulces/contracts';

/** Tolerancia del cuadre corte↔arqueo: redondeos de centavos del POS. */
export const TOLERANCIA_CUADRE = 1;
/** Un corte por debajo de esto es un corte en blanco ($0.01 al cerrar una caja sin venta). */
export const MONTO_MINIMO_CORTE = 1;

export const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

export function estadoCobro(monto: number, cobrado: number): CorteEstadoCobro {
  if (cobrado <= 0.005) return 'sin_cobro';
  const saldo = r2(monto - cobrado);
  if (saldo > 0.005) return 'parcial';
  if (saldo < -0.005) return 'sobrecobrado';
  return 'cobrado';
}

/** Veredicto del corte contra el arqueo de su turno. Sin arqueo NO es "cuadra": es `sin_arqueo`. */
export function veredictoCuadre(monto: number, arqueo: CorteArqueo | null): { cuadre: CorteCuadre; diferencia: number | null } {
  if (!arqueo) return { cuadre: 'sin_arqueo', diferencia: null };
  const diferencia = r2(monto - arqueo.esperado_total);
  if (Math.abs(diferencia) < TOLERANCIA_CUADRE) return { cuadre: 'cuadra', diferencia };
  if (Math.abs(monto - arqueo.contado_total) < TOLERANCIA_CUADRE) {
    return { cuadre: arqueo.contado_total < arqueo.esperado_total ? 'faltante_arqueo' : 'sobrante_arqueo', diferencia };
  }
  return { cuadre: 'corte_distinto', diferencia };
}

/** Fila cruda de la consulta (Postgres devuelve `numeric` como texto). */
export interface CorteCrudo {
  sucursal: string;
  folio: string;
  fecha: string;
  referencia: string | null;
  caja: string | null;
  turno: string | null;
  monto: string | number;
  cobrado: string | number | null;
  cobros: Array<{ doc_prefix: string; folio: string; fecha: string | null; monto: string | number; forma_pago: string | null; concepto: string | null }> | null;
  arqueo_fecha: string | null;
  efectivo_esperado: string | number | null;
  efectivo_contado: string | number | null;
  tarjeta_esperado: string | number | null;
  tarjeta_contado: string | number | null;
  transfer_esperado: string | number | null;
  transfer_contado: string | number | null;
  cajero_cierre: string | null;
}

const n = (v: string | number | null | undefined): number => Number(v) || 0;

function arqueoDe(c: CorteCrudo): CorteArqueo | null {
  if (!c.arqueo_fecha) return null;
  const a = {
    efectivo_esperado: r2(n(c.efectivo_esperado)), efectivo_contado: r2(n(c.efectivo_contado)),
    tarjeta_esperado: r2(n(c.tarjeta_esperado)), tarjeta_contado: r2(n(c.tarjeta_contado)),
    transfer_esperado: r2(n(c.transfer_esperado)), transfer_contado: r2(n(c.transfer_contado)),
  };
  return {
    fecha: c.arqueo_fecha,
    ...a,
    esperado_total: r2(a.efectivo_esperado + a.tarjeta_esperado + a.transfer_esperado),
    contado_total: r2(a.efectivo_contado + a.tarjeta_contado + a.transfer_contado),
    cajero: c.cajero_cierre || null,
  };
}

export function construirCorte(c: CorteCrudo, nombres: Record<string, string>): CorteRow {
  const monto = r2(n(c.monto));
  const cobrado = r2(n(c.cobrado));
  const arqueo = arqueoDe(c);
  const { cuadre, diferencia } = veredictoCuadre(monto, arqueo);
  const cobros: CorteCobro[] = (c.cobros || []).map((x) => ({
    doc_prefix: x.doc_prefix, folio: x.folio, fecha: x.fecha ? String(x.fecha).slice(0, 10) : null,
    monto: r2(n(x.monto)), forma_pago: x.forma_pago ?? null, concepto: x.concepto ?? null,
  }));
  const documento = `UD2301-${c.folio}`;
  return {
    clave: `${c.sucursal}-${documento}`,
    sucursal: c.sucursal,
    sucursal_nombre: nombres[c.sucursal] || `Sucursal ${c.sucursal}`,
    documento,
    folio: c.folio,
    fecha: String(c.fecha).slice(0, 10),
    referencia: c.referencia || '',
    caja: c.caja,
    turno: c.turno,
    monto,
    cobrado,
    saldo: r2(monto - cobrado),
    estado_cobro: estadoCobro(monto, cobrado),
    cobros,
    arqueo,
    cuadre,
    diferencia,
  };
}

const conDiferencia = (c: CorteRow): boolean => c.cuadre !== 'cuadra' && c.cuadre !== 'sin_arqueo';

/** Arma la respuesta completa: separa los cortes en blanco y resume por sucursal. */
export function armarRespuesta(
  crudos: CorteCrudo[], nombres: Record<string, string>, periodo: { from: string; to: string },
): CortesSucursalesResponse {
  const todos = crudos.map((c) => construirCorte(c, nombres));
  const cortes = todos.filter((c) => c.monto >= MONTO_MINIMO_CORTE);
  const porSuc = new Map<string, CorteSucursalResumen>();
  for (const c of cortes) {
    let s = porSuc.get(c.sucursal);
    if (!s) {
      s = { sucursal: c.sucursal, sucursal_nombre: c.sucursal_nombre, cortes: 0, vendido: 0, cobrado: 0, pendiente: 0, sin_cobro: 0, abierto_desde: null, con_diferencia: 0, sin_arqueo: 0 };
      porSuc.set(c.sucursal, s);
    }
    s.cortes += 1;
    s.vendido = r2(s.vendido + c.monto);
    s.cobrado = r2(s.cobrado + c.cobrado);
    s.pendiente = r2(s.pendiente + Math.max(c.saldo, 0));
    if (c.estado_cobro === 'sin_cobro') s.sin_cobro += 1;
    if (c.saldo > 0.005 && (!s.abierto_desde || c.fecha < s.abierto_desde)) s.abierto_desde = c.fecha;
    if (conDiferencia(c)) s.con_diferencia += 1;
    if (c.cuadre === 'sin_arqueo') s.sin_arqueo += 1;
  }
  const sucursales = [...porSuc.values()].sort((a, b) => a.sucursal.localeCompare(b.sucursal));
  const suma = (k: 'vendido' | 'cobrado' | 'pendiente'): number => r2(sucursales.reduce((t, s) => t + s[k], 0));
  return {
    periodo,
    totales: {
      cortes: cortes.length,
      vendido: suma('vendido'),
      cobrado: suma('cobrado'),
      pendiente: suma('pendiente'),
      sin_cobro: cortes.filter((c) => c.estado_cobro === 'sin_cobro').length,
      con_diferencia: cortes.filter(conDiferencia).length,
      sin_arqueo: cortes.filter((c) => c.cuadre === 'sin_arqueo').length,
    },
    sucursales,
    cortes,
    cortes_en_blanco: todos.length - cortes.length,
    ultimo_corte: cortes.reduce<string | null>((m, c) => (!m || c.fecha > m ? c.fecha : m), null),
  };
}
