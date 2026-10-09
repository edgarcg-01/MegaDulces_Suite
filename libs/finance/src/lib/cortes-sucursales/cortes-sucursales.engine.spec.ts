/**
 * `[CSU.1]` Pruebas del motor de Cortes/Sucursales.
 *
 * Los casos son los REALES de Zamora Centro, oct-2026 (medidos en prod el 2026-10-05):
 *  · `Caja 4-199`: corte $12,230.15 = lo esperado → cuadra; 4 cobros por $3,127.47 → saldo $9,102.68,
 *    que es exactamente el que muestra Kepler en "Alta de cobro".
 *  · `Caja 5-151`: el POS esperaba $10,067.30 de efectivo y el cajero contó $1,067.30 → el corte sale
 *    por lo contado y el veredicto tiene que ser FALTANTE, no "cuadra".
 * Y la prueba negativa: sin arqueo el veredicto NO puede ser "cuadra" (ADR-056: lo que no se midió
 * se declara).
 */
import {
  armarRespuesta, construirCorte, estadoCobro, veredictoCuadre, type CorteCrudo,
} from './cortes-sucursales.engine';

const base = (over: Partial<CorteCrudo>): CorteCrudo => ({
  sucursal: '05', folio: '0000001', fecha: '2026-10-01', referencia: 'Caja 4-199', caja: '4', turno: '199',
  monto: '12230.15', cobrado: '0', cobros: null, arqueo_fecha: '2026-10-01',
  efectivo_esperado: '11431.93', efectivo_contado: '11431.93', tarjeta_esperado: '655.06', tarjeta_contado: '655.06',
  transfer_esperado: '143.16', transfer_contado: '143.16', cajero_cierre: null, ...over,
});
const NOMBRES = { '05': 'Zamora Centro' };

describe('[CSU.1] estado de cobro', () => {
  it('sin cobro / parcial / cobrado / sobrecobrado', () => {
    expect(estadoCobro(100, 0)).toBe('sin_cobro');
    expect(estadoCobro(100, 40)).toBe('parcial');
    expect(estadoCobro(100, 100)).toBe('cobrado');
    expect(estadoCobro(100, 100.5)).toBe('sobrecobrado');
  });
});

describe('[CSU.1] corte real Caja 4-199', () => {
  const c = construirCorte(base({
    cobrado: '3127.47',
    cobros: [
      { doc_prefix: 'UA0501', folio: '0000001', fecha: '2026-10-02', monto: '655.06', forma_pago: 'tarjeta', concepto: null },
      { doc_prefix: 'UA0501', folio: '0000002', fecha: '2026-10-02', monto: '143.16', forma_pago: 'tarjeta', concepto: null },
      { doc_prefix: 'UA0501', folio: '0000003', fecha: '2026-10-02', monto: '1907.62', forma_pago: 'otro', concepto: null },
      { doc_prefix: 'UA0501', folio: '0000004', fecha: '2026-10-02', monto: '421.63', forma_pago: 'tarjeta', concepto: null },
    ],
  }), NOMBRES);

  it('reproduce el saldo de Kepler al centavo', () => {
    expect(c.documento).toBe('UD2301-0000001');
    expect(c.saldo).toBe(9102.68);
    expect(c.estado_cobro).toBe('parcial');
  });
  it('cuadra contra el arqueo de su turno', () => {
    expect(c.cuadre).toBe('cuadra');
    expect(c.arqueo?.esperado_total).toBe(12230.15);
  });
});

describe('[CSU.1] corte real Caja 5-151 (faltan $9,000)', () => {
  const c = construirCorte(base({
    folio: '0000007', referencia: 'Caja 5-151', caja: '5', turno: '151', monto: '1203.36',
    efectivo_esperado: '10067.30', efectivo_contado: '1067.30',
    tarjeta_esperado: '0', tarjeta_contado: '0', transfer_esperado: '136.06', transfer_contado: '136.06',
  }), NOMBRES);

  it('es faltante en arqueo, con la diferencia exacta', () => {
    expect(c.cuadre).toBe('faltante_arqueo');
    expect(c.diferencia).toBe(-9000);
  });
});

describe('[CSU.1] veredicto del cuadre', () => {
  it('sobrante cuando lo contado supera lo esperado y el corte sale por lo contado', () => {
    const a = { fecha: 'x', efectivo_esperado: 100, efectivo_contado: 150, tarjeta_esperado: 0, tarjeta_contado: 0, transfer_esperado: 0, transfer_contado: 0, esperado_total: 100, esperado_neto: 100, contado_total: 150, cajero: null };
    expect(veredictoCuadre(150, a).cuadre).toBe('sobrante_arqueo');
  });
  it('corte distinto cuando no coincide con ninguno de los dos', () => {
    const a = { fecha: 'x', efectivo_esperado: 100, efectivo_contado: 100, tarjeta_esperado: 0, tarjeta_contado: 0, transfer_esperado: 0, transfer_contado: 0, esperado_total: 100, esperado_neto: 100, contado_total: 100, cajero: null };
    expect(veredictoCuadre(60, a)).toEqual({ cuadre: 'corte_distinto', diferencia: -40 });
  });
  it('NEGATIVA: sin arqueo nunca es "cuadra"', () => {
    expect(veredictoCuadre(12230.15, null)).toEqual({ cuadre: 'sin_arqueo', diferencia: null });
    const c = construirCorte(base({ arqueo_fecha: null }), NOMBRES);
    expect(c.cuadre).not.toBe('cuadra');
    expect(c.arqueo).toBeNull();
  });
});

/**
 * `[CSU.7]` Devoluciones pagadas en caja — casos REALES de oct-2026 (medidos en prod el 2026-10-08).
 * El arqueo de Kepler espera la venta bruta; el corte ya resta la nota de crédito POS del turno.
 */
describe('[CSU.7] devoluciones pagadas en la caja del turno', () => {
  const dev = (folio: string, monto: string) => ({
    doc_prefix: 'UA2101', folio, fecha: '2026-10-06', monto, cliente: 'CLIENTE DE PRUEBA', motivo: 'EL CLIENTE LA DEVOLVIO', cajero: 'CAJERO-1',
  });
  const soloEfectivo = { tarjeta_esperado: '0', tarjeta_contado: '0', transfer_esperado: '0', transfer_contado: '0' };

  it('Zamora Caja 2-171: corte $12,728.61 = esperado $12,908.53 − UA2101-0000071 $179.92 → cuadra', () => {
    const c = construirCorte(base({
      folio: '0000016', referencia: 'Caja 2-171', caja: '2', turno: '171', fecha: '2026-10-06', arqueo_fecha: '2026-10-06',
      monto: '12728.61', efectivo_esperado: '12908.53', efectivo_contado: '12908.53', ...soloEfectivo,
      devoluciones: [dev('0000071', '179.92')],
    }), NOMBRES);
    expect(c.devoluciones_total).toBe(179.92);
    expect(c.arqueo?.esperado_total).toBe(12908.53);
    expect(c.arqueo?.esperado_neto).toBe(12728.61);
    expect(c.cuadre).toBe('cuadra');
    expect(c.diferencia).toBe(0);
  });

  it('Madero Caja 4-28: el "faltante" de $2,641.97 era la devolución — la cajera contó lo que quedó', () => {
    const c = construirCorte(base({
      monto: '38753.69', efectivo_esperado: '41395.66', efectivo_contado: '38753.69', ...soloEfectivo,
      devoluciones: [dev('0000011', '2641.97')],
    }), NOMBRES);
    expect(c.cuadre).toBe('cuadra');
  });

  it('Madero Caja 2-23: hubo devolución pero el corte salió por el bruto → cuadra contra el bruto, sin diferencia inventada', () => {
    const c = construirCorte(base({
      monto: '19639.83', efectivo_esperado: '19639.83', efectivo_contado: '19797.16', ...soloEfectivo,
      devoluciones: [dev('0000008', '157.33')],
    }), NOMBRES);
    expect(c.cuadre).toBe('cuadra');
    expect(c.diferencia).toBe(0);
  });

  it('NEGATIVA — Madero Caja 3-17: una devolución que no explica la diferencia NO la tapa', () => {
    const c = construirCorte(base({
      monto: '30376.45', efectivo_esperado: '30061.13', efectivo_contado: '30061.13', ...soloEfectivo,
      devoluciones: [dev('0000010', '50.98')],
    }), NOMBRES);
    expect(c.cuadre).toBe('corte_distinto');
    expect(c.diferencia).toBe(366.3);
  });

  it('el faltante se mide contra el esperado NETO', () => {
    const c = construirCorte(base({
      monto: '900', efectivo_esperado: '1100', efectivo_contado: '900', ...soloEfectivo,
      devoluciones: [dev('0000001', '100')],
    }), NOMBRES);
    expect(c.cuadre).toBe('faltante_arqueo');
    expect(c.diferencia).toBe(-100);
  });

  it('sin devoluciones el neto es el bruto (nada cambia para los cortes de siempre)', () => {
    const c = construirCorte(base({}), NOMBRES);
    expect(c.devoluciones).toEqual([]);
    expect(c.devoluciones_total).toBe(0);
    expect(c.arqueo?.esperado_neto).toBe(c.arqueo?.esperado_total);
  });
});

describe('[CSU.1] respuesta', () => {
  const r = armarRespuesta([
    base({}),
    base({ folio: '0000004', referencia: 'Caja 5-150', monto: '0.01' }),
    base({ folio: '0000007', fecha: '2026-10-02', monto: '500', cobrado: '500' }),
  ], NOMBRES, { from: '2026-10-01', to: '2026-10-31' });

  it('[CSU.6] el alcance viaja en la respuesta: sin sucursal asignada se DECLARA, no es "sin cortes"', () => {
    const sin = armarRespuesta([], {}, { from: '2026-10-01', to: '2026-10-31' }, { todas: false, sucursales: [] });
    expect(sin.alcance).toEqual({ todas: false, sucursales: [] });
    expect(sin.totales.cortes).toBe(0);
    const una = armarRespuesta([base({})], NOMBRES, { from: '2026-10-01', to: '2026-10-31' }, { todas: false, sucursales: [{ codigo: '05', nombre: 'Zamora Centro' }] });
    expect(una.alcance.sucursales.map((s) => s.codigo)).toEqual(['05']);
  });
  it('la clave distingue el mismo folio en dos sucursales', () => {
    const otra = armarRespuesta([base({}), base({ sucursal: '01' })], NOMBRES, { from: '2026-10-01', to: '2026-10-31' });
    expect(otra.cortes.map((c) => c.documento)).toEqual(['UD2301-0000001', 'UD2301-0000001']);
    expect(new Set(otra.cortes.map((c) => c.clave)).size).toBe(2);
  });
  it('los cortes en blanco se DECLARAN aparte, no se listan', () => {
    expect(r.cortes_en_blanco).toBe(1);
    expect(r.cortes.map((c) => c.folio)).toEqual(['0000001', '0000007']);
  });
  it('resume por sucursal: pendiente y corte abierto más viejo', () => {
    const s = r.sucursales[0];
    expect(s.sucursal_nombre).toBe('Zamora Centro');
    expect(s.vendido).toBe(12730.15);
    expect(s.pendiente).toBe(12230.15);
    expect(s.sin_cobro).toBe(1);
    expect(s.abierto_desde).toBe('2026-10-01');
    expect(r.totales.pendiente).toBe(12230.15);
    expect(r.ultimo_corte).toBe('2026-10-02');
  });
});
