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
 *
 * ── `[CSU.7]` DEVOLUCIONES PAGADAS EN CAJA (medido en prod, 2026-10-08) ─────────────────────
 * · El arqueo de Kepler espera la venta BRUTA del turno; el corte `U-D-23` ya resta las notas de
 *   crédito POS que se pagaron en esa caja (`UA2101` fiscal y `UA2501` no fiscal, ligadas por
 *   `kdm1.c81` caja + `kdm1.c80` turno). Ej. Zamora `Caja 2-171`: esperado $12,908.53 −
 *   UA2101-0000071 $179.92 = corte $12,728.61.
 * · Oct-2026 (1 al 8, los 196 cortes con arqueo que lista la pantalla): con el esperado NETO cuadran
 *   184 (contra 141 con el bruto). Los "faltantes" de Madero 4-28 (−$2,641.97) y Abastos 3-12 (−$3,450.52) eran
 *   devoluciones: la cajera contó lo que de verdad quedó en el cajón.
 * · Un caso (Madero `Caja 2-23`) tiene devolución en el turno pero el corte salió por el BRUTO:
 *   se acepta como `cuadra` contra lo esperado bruto, no se inventa una diferencia.
 */
import type {
  CorteArqueo, CorteCobro, CorteCuadre, CorteDevolucion, CorteEstadoCobro, CorteMedioCobro, CorteRow,
  CorteSucursalResumen, CortesAlcance, CortesSucursalesResponse,
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

/**
 * Veredicto del corte contra el arqueo de su turno. Sin arqueo NO es "cuadra": es `sin_arqueo`.
 * `[CSU.7]` Se juzga contra `esperado_neto` (esperado − devoluciones pagadas en la caja).
 */
export function veredictoCuadre(monto: number, arqueo: CorteArqueo | null): { cuadre: CorteCuadre; diferencia: number | null } {
  if (!arqueo) return { cuadre: 'sin_arqueo', diferencia: null };
  const esperado = arqueo.esperado_neto;
  const diferencia = r2(monto - esperado);
  if (Math.abs(diferencia) < TOLERANCIA_CUADRE) return { cuadre: 'cuadra', diferencia };
  // Hubo devolución pero el corte salió por el bruto: coincide con lo que Kepler esperaba.
  if (Math.abs(monto - arqueo.esperado_total) < TOLERANCIA_CUADRE) {
    return { cuadre: 'cuadra', diferencia: r2(monto - arqueo.esperado_total) };
  }
  if (Math.abs(monto - arqueo.contado_total) < TOLERANCIA_CUADRE) {
    return { cuadre: arqueo.contado_total < esperado ? 'faltante_arqueo' : 'sobrante_arqueo', diferencia };
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
  cobros: Array<{ doc_prefix: string; folio: string; fecha: string | null; monto: string | number; forma_pago: string | null; concepto: string | null;
    /** `[CSU.8]` Lo que trae `analytics.erp_collections`. Opcionales: una fila sin cobro en la vista llega sin ellos. */
    medio_cobro?: CorteMedioCobro | null; cuenta_tesoreria?: string | null }> | null;
  /** `[CSU.7]` Notas de crédito POS pagadas en la caja del turno. */
  devoluciones?: Array<{ doc_prefix: string; folio: string; fecha: string; monto: string | number; cliente: string | null; motivo: string | null; cajero: string | null }> | null;
  arqueo_fecha: string | null;
  efectivo_esperado: string | number | null;
  efectivo_contado: string | number | null;
  tarjeta_esperado: string | number | null;
  tarjeta_contado: string | number | null;
  transfer_esperado: string | number | null;
  transfer_contado: string | number | null;
  cajero_cierre: string | null;
  /** `[CSU.9]` Denominaciones del arqueo (`c43`/`c44`) y lo retirado en el turno (`c48`). */
  arqueo_billetes?: string | number | null;
  arqueo_monedas?: string | number | null;
  efectivo_retirado?: string | number | null;
}

const n = (v: string | number | null | undefined): number => Number(v) || 0;

function arqueoDe(c: CorteCrudo, devoluciones: number): CorteArqueo | null {
  if (!c.arqueo_fecha) return null;
  const a = {
    efectivo_esperado: r2(n(c.efectivo_esperado)), efectivo_contado: r2(n(c.efectivo_contado)),
    tarjeta_esperado: r2(n(c.tarjeta_esperado)), tarjeta_contado: r2(n(c.tarjeta_contado)),
    transfer_esperado: r2(n(c.transfer_esperado)), transfer_contado: r2(n(c.transfer_contado)),
  };
  const esperado_total = r2(a.efectivo_esperado + a.tarjeta_esperado + a.transfer_esperado);
  // [CSU.9] El conteo físico: billetes + monedas + lo retirado durante el turno. Es el ÚNICO
  // efectivo que alguien contó — `efectivo_contado` es un número declarado. ⚠️ `arqueo_otros`
  // (c45) NO entra: medido, con él la identidad cae del 53.4% al 19.3%.
  const bil = c.arqueo_billetes, mon = c.arqueo_monedas, ret = c.efectivo_retirado;
  const hayDenominacion = bil != null || mon != null || ret != null;
  const fisicoBruto = hayDenominacion ? r2(n(bil) + n(mon) + n(ret)) : null;
  // Un corte sin denominaciones llega con las tres en 0, que NO es "contaron cero" sino "no hay
  // dato". Se declara `null` (ADR-056); medido: 72 de 1,125 cortes (6.4%).
  const conteo_fisico = fisicoBruto && fisicoBruto > 0 ? fisicoBruto : null;
  return {
    fecha: c.arqueo_fecha,
    ...a,
    esperado_total,
    esperado_neto: r2(esperado_total - devoluciones),
    contado_total: r2(a.efectivo_contado + a.tarjeta_contado + a.transfer_contado),
    cajero: c.cajero_cierre || null,
    conteo_fisico,
    fisico_diferencia: conteo_fisico === null ? null : r2(conteo_fisico - a.efectivo_contado),
    // ⛔ El arqueo declaró lo esperado en vez de contarlo. Medido: 81.2% de los cortes.
    arqueo_declarado: a.efectivo_contado === a.efectivo_esperado,
  };
}

export function construirCorte(c: CorteCrudo, nombres: Record<string, string>): CorteRow {
  const monto = r2(n(c.monto));
  const cobrado = r2(n(c.cobrado));
  const devoluciones: CorteDevolucion[] = (c.devoluciones || []).map((x) => ({
    doc_prefix: x.doc_prefix, folio: x.folio, fecha: String(x.fecha).slice(0, 10), monto: r2(n(x.monto)),
    cliente: x.cliente || null, motivo: x.motivo || null, cajero: x.cajero || null,
  }));
  const devoluciones_total = r2(devoluciones.reduce((t, x) => t + x.monto, 0));
  const arqueo = arqueoDe(c, devoluciones_total);
  const { cuadre, diferencia } = veredictoCuadre(monto, arqueo);
  const cobros: CorteCobro[] = (c.cobros || []).map((x) => ({
    doc_prefix: x.doc_prefix, folio: x.folio, fecha: x.fecha ? String(x.fecha).slice(0, 10) : null,
    monto: r2(n(x.monto)), forma_pago: x.forma_pago ?? null, concepto: x.concepto ?? null,
    // [CSU.8] Pasan tal cual: la clasificación la hace la vista, no esta capa. `null` cuando el
    // cobro no está en `analytics.erp_collections` — que es distinto de 'sin_declarar'.
    medio_cobro: x.medio_cobro ?? null, cuenta_tesoreria: x.cuenta_tesoreria ?? null,
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
    devoluciones,
    devoluciones_total,
    arqueo,
    cuadre,
    diferencia,
  };
}

const conDiferencia = (c: CorteRow): boolean => c.cuadre !== 'cuadra' && c.cuadre !== 'sin_arqueo';

/** Arma la respuesta completa: separa los cortes en blanco y resume por sucursal. */
export function armarRespuesta(
  crudos: CorteCrudo[], nombres: Record<string, string>, periodo: { from: string; to: string },
  alcance: CortesAlcance = { todas: true, sucursales: [] },
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
    alcance,
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
