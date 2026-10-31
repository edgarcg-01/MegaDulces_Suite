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

/**
 * `[CSU.8]` La cuenta de tesorería del cobro — el banco del depósito.
 *
 * Los cuatro primeros casos son los REALES de Padre Hidalgo, corte `UD2301-0000008 · Caja 5-123`,
 * medidos contra prod el 2026-10-09 corriendo la vista nueva dentro de `BEGIN/ROLLBACK`:
 * `0000006`/`0000007` → `BBVA  4885`, `0000009` → `SANTANDER 2169`, `0000010` → `BAJIO 4166`.
 *
 * ⭐ El quinto es el que define la forma de la columna: **3,599 cobros por $75,075,947.72 entraron
 * a `CAJA GENERAL`**, o sea en efectivo. No es un hueco, es la respuesta — y el motor tiene que
 * dejarlo pasar con su clase, no blanquearlo.
 */
describe('[CSU.8] la cuenta donde entró el cobro', () => {
  const c = construirCorte(base({
    cobrado: '1000',
    cobros: [
      { doc_prefix: 'UA0501', folio: '0000006', fecha: '2026-10-02', monto: '100', forma_pago: 'tarjeta', concepto: null, medio_cobro: 'banco', cuenta_tesoreria: 'BBVA  4885' },
      { doc_prefix: 'UA0501', folio: '0000009', fecha: '2026-10-05', monto: '100', forma_pago: 'otro', concepto: null, medio_cobro: 'banco', cuenta_tesoreria: 'SANTANDER 2169' },
      { doc_prefix: 'UA0501', folio: '0000050', fecha: '2026-10-05', monto: '100', forma_pago: 'efectivo', concepto: null, medio_cobro: 'caja', cuenta_tesoreria: 'CAJA GENERAL' },
      { doc_prefix: 'UA0501', folio: '0000051', fecha: '2026-10-05', monto: '100', forma_pago: 'otro', concepto: null, medio_cobro: 'sin_declarar', cuenta_tesoreria: null },
      { doc_prefix: 'UA0501', folio: '0000052', fecha: '2026-10-05', monto: '100', forma_pago: 'otro', concepto: null },
    ],
  }), NOMBRES);

  it('pasa el banco del depósito tal como lo clasificó la vista', () => {
    expect(c.cobros[0].medio_cobro).toBe('banco');
    expect(c.cobros[0].cuenta_tesoreria).toBe('BBVA  4885');
    expect(c.cobros[1].cuenta_tesoreria).toBe('SANTANDER 2169');
  });

  it('⭐ el efectivo a CAJA GENERAL conserva su clase: NO se disfraza de banco ni se blanquea', () => {
    expect(c.cobros[2].medio_cobro).toBe('caja');
    expect(c.cobros[2].cuenta_tesoreria).toBe('CAJA GENERAL');
    expect(c.cobros[2].medio_cobro).not.toBe('banco');
  });

  it('NEGATIVA: las DOS ausencias son distintas y ninguna inventa una cuenta', () => {
    // El documento existe en la vista pero no trae cuenta de tesorería (6 de 24,763 en prod).
    expect(c.cobros[3].medio_cobro).toBe('sin_declarar');
    expect(c.cobros[3].cuenta_tesoreria).toBeNull();
    // El cobro ni siquiera está en `erp_collections`: no se sabe nada, y eso NO es 'sin_declarar'.
    expect(c.cobros[4].medio_cobro).toBeNull();
    expect(c.cobros[4].cuenta_tesoreria).toBeNull();
  });

  it('NEGATIVA: agregar la cuenta no movió ni un peso del cuadre', () => {
    expect(c.cobrado).toBe(1000);
    expect(c.cuadre).toBe('cuadra');
  });
});

/**
 * `[CSU.9]` El conteo por denominación — el único efectivo que alguien contó.
 *
 * Caso REAL: Padre Hidalgo, `UD2301-0000017 · Caja 2-97`, medido contra prod el 2026-10-09 en
 * `kepler_ods.kdpv_folio_caja`:
 *
 *     c15 esperado 81,736.84  ·  c25 contado 81,736.84  ·  c35 diferencia 0.00
 *     c43 billetes  8,460.00  ·  c44 monedas  2,077.00  ·  c48 retirado 74,000.00
 *     → conteo físico 84,537.00, que NO es 81,736.84: sobran $2,800.16
 *
 * ⛔ La pantalla decía «Cuadra $0.00» porque comparaba el corte contra `c25`, y `c25` es un número
 * DECLARADO idéntico al esperado en el **81.2 %** de los cortes (996 medidos desde sep-2026). De
 * 870 cortes con denominación, **409 (47.0 %) difieren** del declarado: **$1,106,561.32** en total
 * absoluto, peor caso **$56,329.65**, neto **−$133,292.90**.
 */
describe('[CSU.9] el conteo por denominación contra el efectivo declarado', () => {
  const ph = base({
    folio: '0000017', referencia: 'Caja 2-97', caja: '2', turno: '97', monto: '85788.99',
    efectivo_esperado: '81736.84', efectivo_contado: '81736.84',
    tarjeta_esperado: '3150.64', tarjeta_contado: '3150.64',
    transfer_esperado: '901.51', transfer_contado: '901.51',
    arqueo_billetes: '8460.00', arqueo_monedas: '2077.00', efectivo_retirado: '74000.00',
  });

  it('⭐ reproduce el caso real: el físico son $84,537.00 y sobran $2,800.16 sobre lo esperado', () => {
    const a = construirCorte(ph, NOMBRES).arqueo!;
    expect(a.conteo_fisico).toBe(84537);
    expect(a.fisico_diferencia).toBe(2800.16);
  });

  it('⛔ declara que el arqueo NO contó: el declarado es idéntico al esperado', () => {
    const a = construirCorte(ph, NOMBRES).arqueo!;
    expect(a.arqueo_declarado).toBe(true);
    // Y el veredicto viejo sigue diciendo "cuadra" — por eso hacía falta el otro renglón.
    expect(construirCorte(ph, NOMBRES).cuadre).toBe('cuadra');
  });

  it('NEGATIVA: un arqueo que SÍ contó no se marca como declarado', () => {
    const a = construirCorte(base({ ...ph, efectivo_contado: '81000.00' }), NOMBRES).arqueo!;
    expect(a.arqueo_declarado).toBe(false);
  });

  it('⛔ NEGATIVA: sin denominaciones NO se dibuja un cero — se declara que no se puede verificar', () => {
    const a = construirCorte(base({ ...ph, arqueo_billetes: null, arqueo_monedas: null, efectivo_retirado: null }), NOMBRES).arqueo!;
    expect(a.conteo_fisico).toBeNull();
    expect(a.fisico_diferencia).toBeNull();
    expect(a.conteo_fisico).not.toBe(0);
  });

  it('NEGATIVA: tres ceros tampoco son un conteo — 6.4% de los cortes llegan así', () => {
    const a = construirCorte(base({ ...ph, arqueo_billetes: '0', arqueo_monedas: '0', efectivo_retirado: '0' }), NOMBRES).arqueo!;
    expect(a.conteo_fisico).toBeNull();
  });

  it('⚠️ `arqueo_otros` (c45) NO entra: con él la identidad cae del 53.4% al 19.3%', () => {
    // El crudo ni siquiera lo acepta: si alguien lo agregara, este número cambiaría.
    const a = construirCorte(ph, NOMBRES).arqueo!;
    expect(a.conteo_fisico).toBe(8460 + 2077 + 74000);
    expect(a.conteo_fisico).not.toBe(8460 + 2077 + 74000 + 4052.05);
  });
});

describe('[CSU.13] cobros cancelados en Kepler: se publican y NO suman', () => {
  // El caso real: corte 06/UD2301-0000033, el UA0501-0000075 ($10,962.00) se canceló en Kepler.
  const c = construirCorte(base({
    sucursal: '06', folio: '0000033', monto: '36407.84', cobrado: '36407.84',
    cobros: [{ doc_prefix: 'UA0501', folio: '0000072', fecha: '2026-10-14', monto: '36407.84', forma_pago: 'otro', concepto: null }],
    cobros_cancelados: [{ doc_prefix: 'UA0501', folio: '0000075', fecha: '2026-10-08T06:00:00.000Z', monto: '10962.00', concepto: 'VTA 10-10-26' }],
  }), NOMBRES);

  it('el cancelado viaja aparte, con monto numérico y fecha corta', () => {
    expect(c.cobros_cancelados).toEqual([{ doc_prefix: 'UA0501', folio: '0000075', fecha: '2026-10-08', monto: 10962, concepto: 'VTA 10-10-26' }]);
  });

  it('⛔ NEGATIVA: el cancelado NO entra a cobrado ni al saldo (sin él el corte queda cobrado exacto, no sobrecobrado)', () => {
    expect(c.cobrado).toBe(36407.84);
    expect(c.saldo).toBe(0);
    expect(c.estado_cobro).toBe('cobrado');
    expect(c.cobros.map((x) => x.folio)).toEqual(['0000072']);
  });

  it('sin cancelados llega vacío, nunca undefined (la pantalla lo recorre sin preguntar)', () => {
    expect(construirCorte(base({}), NOMBRES).cobros_cancelados).toEqual([]);
    expect(construirCorte(base({ cobros_cancelados: null }), NOMBRES).cobros_cancelados).toEqual([]);
  });
});

/**
 * `[CSU.16]` Esperado (el sistema) contra Declarado (el cajero).
 *
 * Caso REAL, La Piedad Abastos `UD2301-0000112 · Caja 3-407` (30-oct-2026), medido en prod:
 *
 *     Kepler  c15 37,548.06 · c25 37,548.06 · c16 6,482.95 · c43 6,060 · c44 48 · c48 31,440
 *     cajero  cierre 6,108.50 (medios: tarjeta 6,482.95) · 4 retiros 10,000 + 10,000 + 10,000 + 1,440
 *
 * La pantalla imprimía `c25` como «Declarado» (idéntico al esperado), −$0.06 desde el desglose de
 * Kepler, y la nota «el arqueo declaró lo esperado, no lo contó». El cajero sí contó: $37,548.50.
 */
describe('[CSU.16] la declaración del cajero, que no es la del sistema', () => {
  const retiro = (total: string, hora: string) => ({ tipo: 'retiro', total, medios: null, captured_at: `2026-10-30T${hora}Z`, ligado: 'folio' as const });
  const conteos = [
    retiro('10000', '16:04:22'), retiro('10000', '18:36:34'), retiro('10000', '20:00:40'), retiro('1440', '20:43:52'),
    { tipo: 'cierre', total: '6108.5', medios: { retiros: 31440, tarjeta: 6482.95 }, captured_at: '2026-10-30T20:56:04Z', ligado: 'folio' as const },
  ];
  const piedad = base({
    sucursal: '02', folio: '0000112', referencia: 'Caja 3-407', caja: '3', turno: '407', monto: '44031.01', arqueo_fecha: '2026-10-30',
    efectivo_esperado: '37548.06', efectivo_contado: '37548.06', tarjeta_esperado: '6482.95', tarjeta_contado: '6482.95',
    transfer_esperado: '0', transfer_contado: '0',
    arqueo_billetes: '6060.00', arqueo_monedas: '48.00', efectivo_retirado: '31440.00',
  });

  it('⭐ caso real: el cajero declaró $37,548.50 de efectivo y sobran $0.44 contra lo esperado', () => {
    const d = construirCorte({ ...piedad, conteos_cajero: conteos }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(d.cajon).toBe(6108.5);
    expect(d.retiros).toBe(31440);
    expect(d.retiros_n).toBe(4);
    expect(d.efectivo).toBe(37548.5);
    expect(d.diferencia).toBe(0.44);
    expect(d.tarjeta).toBe(6482.95);
    expect(d.transferencia).toBeNull();
    // Sin transferencia esperada, que no la declare no deja el total incompleto.
    expect(d.total).toBe(44031.45);
    expect(d.retiros_kepler).toBe(31440);
    expect(d.concuerda_con_kepler).toBe(true);
    expect(d.retiros_sin_verificar).toBe(0);
    expect(d.capturado_at).toBe('2026-10-30T20:56:04Z');
  });

  it('los conteos de esa caja que no se ligaron se declaran en el corte; sin dato, 0', () => {
    expect(construirCorte({ ...piedad, conteos_cajero_sin_ligar: 3 }, NOMBRES).arqueo!.conteos_cajero_sin_ligar).toBe(3);
    expect(construirCorte(piedad, NOMBRES).arqueo!.conteos_cajero_sin_ligar).toBe(0);
  });

  it('el desglose de Kepler se mide contra el esperado, no contra c25: −$0.06', () => {
    const a = construirCorte({ ...piedad, conteos_cajero: conteos }, NOMBRES).arqueo!;
    expect(a.conteo_fisico).toBe(37548);
    expect(a.fisico_diferencia).toBe(-0.06);
  });

  it('⛔ NEGATIVA: sin arqueo ciego NO hay declaración del cajero — null, no la copia del esperado ni cero', () => {
    const a = construirCorte(piedad, NOMBRES).arqueo!;
    expect(a.declaracion_cajero).toBeNull();
    expect(a.arqueo_declarado).toBe(true);
  });

  it('⛔ NEGATIVA: retiros sin cierre no son una declaración completa del efectivo', () => {
    const d = construirCorte({ ...piedad, conteos_cajero: conteos.slice(0, 4) }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(d.retiros).toBe(31440);
    expect(d.cajon).toBeNull();
    expect(d.efectivo).toBeNull();
    expect(d.diferencia).toBeNull();
    expect(d.total).toBeNull();
  });

  it('lo que Kepler retiró y nadie contó se toma como bueno para la diferencia, y se dice aparte', () => {
    const d = construirCorte({ ...piedad, conteos_cajero: [conteos[0], conteos[4]] }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(d.retiros).toBe(10000);
    expect(d.retiros_sin_verificar).toBe(21440);
    expect(d.efectivo).toBe(16108.5);
    expect(d.diferencia).toBe(0.44);
  });

  it('[CSU.7] la devolución pagada del cajón baja el esperado: no se publica como faltante del cajero', () => {
    const dev = { doc_prefix: 'UA2101', folio: '0000071', fecha: '2026-10-30', monto: '500', cliente: null, motivo: null, cajero: null };
    const cierre = { ...conteos[4], total: '5608.5' };
    const d = construirCorte({ ...piedad, devoluciones: [dev], conteos_cajero: [...conteos.slice(0, 4), cierre] }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(d.diferencia).toBe(0.44);
  });

  it('créditos y cheques del cierre cuentan como efectivo: Kepler los espera dentro de c15', () => {
    // Caso real, Padre Hidalgo Caja 2-104: cajón 8,311 + retiros 20,000 + cheques 2,000 + créditos 1,500 = 31,811 vs c15 31,810.81.
    const ph104 = base({
      sucursal: '01', caja: '2', turno: '104', efectivo_esperado: '31810.81', efectivo_contado: '31810.81',
      tarjeta_esperado: '12041.54', transfer_esperado: '0', arqueo_billetes: null, arqueo_monedas: null, efectivo_retirado: '20000',
    });
    const c = (medios: Record<string, number>) => ({ tipo: 'cierre', total: '8311', medios, captured_at: '2026-10-12T21:00:00Z', ligado: 'folio' as const });
    const r = (total: string) => ({ tipo: 'retiro', total, medios: null, captured_at: '2026-10-12T18:00:00Z', ligado: 'folio' as const });
    const d = construirCorte({ ...ph104, conteos_cajero: [r('20000'), c({ cheques: 2000, retiros: 20000, tarjeta: 12041.54, creditos: 1500 })] }, NOMBRES)
      .arqueo!.declaracion_cajero!;
    expect(d.documentos).toBe(3500);
    expect(d.efectivo).toBe(31811);
    expect(d.diferencia).toBe(0.19);
    // NEGATIVA: sin ellos el mismo corte publicaría un faltante de $3,499.81 que no existe.
    const sin = construirCorte({ ...ph104, conteos_cajero: [r('20000'), c({ retiros: 20000, tarjeta: 12041.54 })] }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(sin.diferencia).toBe(-3499.81);
  });

  it('⛔ NEGATIVA: si el cajero y el desglose de Kepler se separan más de $50, no concuerdan', () => {
    // Caso real, Yurécuaro Caja 1-255 (24-oct): el cierre de $169 era el de la Caja 2 (esperaba $168.88).
    const y = base({
      sucursal: '04', caja: '1', turno: '255', efectivo_esperado: '14624.13', efectivo_contado: '14624.13',
      arqueo_billetes: '14600', arqueo_monedas: '24.13', efectivo_retirado: '0',
    });
    const d = construirCorte({ ...y, conteos_cajero: [{ tipo: 'cierre', total: '169', medios: null, captured_at: '2026-10-24T23:16:00Z', ligado: 'hora' }] }, NOMBRES)
      .arqueo!.declaracion_cajero!;
    expect(d.diferencia).toBe(-14455.13);
    expect(d.concuerda_con_kepler).toBe(false);
  });

  it('si el sistema esperaba tarjeta y el cajero no la declaró, el total queda sin medir', () => {
    const sinTarjeta = { ...conteos[4], medios: { retiros: 31440 } };
    const d = construirCorte({ ...piedad, conteos_cajero: [...conteos.slice(0, 4), sinTarjeta] }, NOMBRES).arqueo!.declaracion_cajero!;
    expect(d.tarjeta).toBeNull();
    expect(d.total).toBeNull();
    expect(d.efectivo).toBe(37548.5);
  });

  it('los totales cuentan cuántos cortes tienen declaración del cajero y cuántos tienen c25 = c15', () => {
    const r = armarRespuesta([{ ...piedad, conteos_cajero: conteos }, { ...piedad, folio: '0000113', turno: '408' }], NOMBRES, { from: '2026-10-30', to: '2026-10-30' });
    expect(r.totales.con_declaracion_cajero).toBe(1);
    expect(r.totales.contado_igual_esperado).toBe(2);
  });
});
