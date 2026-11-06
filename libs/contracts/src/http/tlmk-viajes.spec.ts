import { armarViajesTlmk, resumirViajesTlmk, type CierreGuiaTlmk, type ParadaTlmk } from './tlmk-viajes.contract';

/**
 * `[FCT.1]` Las reglas del viaje TM. Los importes salen de casos reales cotejados contra la hoja
 * «RENTABILIDAD TLMKT 2026» (2026-11-04): la guía 0001755 de Hidalgo (Degollado, $106,525.39 en
 * Kepler; la hoja dice $106,523.29 el 17-oct, un día después del embarque, y $120 / $100 de
 * comisión a chofer y auxiliar).
 */
const parada = (p: Partial<ParadaTlmk>): ParadaTlmk => ({
  sucursal: '01', sucursal_nombre: 'Sucursal Hidalgo', guia: '0001755', fecha: '2026-10-16',
  cliente_code: 'C1', destino_ciudad: 'DEGOLLADO', vendedor_code: '10001',
  vendedor_nombre: 'Cinthia Yaret del Valle Rueda', total: 0, ...p,
});
const captura = (c: Partial<CierreGuiaTlmk>): CierreGuiaTlmk => ({
  sucursal: '01', guia: '0001755', shipment_id: 's1', cancelado: false, guias: 1, guias_incompletas: 0,
  km: 102, comision_chofer: 120, comision_auxiliares: 100, viaticos: 160, gastos_ruta: 425.21, ...c,
});

const degollado = [
  parada({ cliente_code: 'C1', total: 60000.39 }),
  parada({ cliente_code: 'C2', total: 40000 }),
  parada({ cliente_code: 'C2', destino_ciudad: 'AYOTLAN', total: 6525 }),
];

describe('tlmk-viajes · el viaje', () => {
  it('agrupa las paradas por guía y suma la venta al centavo', () => {
    const [v] = armarViajesTlmk(degollado, []);
    expect(v.paradas).toBe(3);
    expect(v.clientes).toBe(2);
    expect(v.venta).toBe(106525.39);
    expect(v.ciudades).toEqual(['AYOTLAN', 'DEGOLLADO']);
  });

  it('la misma guía en otra sucursal es OTRO viaje (el folio es por sucursal)', () => {
    const vs = armarViajesTlmk([...degollado, parada({ sucursal: '08', total: 5 })], []);
    expect(vs).toHaveLength(2);
  });

  it('una guía con paradas en dos días declara el rango', () => {
    const [v] = armarViajesTlmk([parada({ fecha: '2026-10-06', total: 1 }), parada({ fecha: '2026-10-08', total: 1 })], []);
    expect([v.fecha, v.fecha_hasta]).toEqual(['2026-10-06', '2026-10-08']);
  });
});

describe('tlmk-viajes · el costo', () => {
  it('PRUEBA NEGATIVA: sin captura en Logística el costo es null, NUNCA $0', () => {
    const [v] = armarViajesTlmk(degollado, []);
    expect(v.estado_costo).toBe('sin_captura');
    expect(v.costo).toBeNull();
    expect(v.pct_registrado).toBeNull();
    expect(v.km).toBeNull();
  });

  it('capturado: suma comisiones, viáticos y gastos de ruta; la camioneta queda declarada sin dato', () => {
    const [v] = armarViajesTlmk(degollado, [captura({})]);
    expect(v.estado_costo).toBe('capturado');
    expect(v.costo).toEqual({
      comision_chofer: 120, comision_auxiliares: 100, viaticos: 160, gastos_ruta: 425.21, unidad: null, registrado: 805.21,
    });
    expect(v.pct_registrado).toBe(0.76); // 805.21 / 106,525.39
    expect(v.km).toBe(102);
  });

  it('PRUEBA NEGATIVA: una guía sin chofer u horario deja el viaje a medias, sin costo', () => {
    const [v] = armarViajesTlmk(degollado, [captura({ guias: 2, guias_incompletas: 1 })]);
    expect(v.estado_costo).toBe('a_medias');
    expect(v.costo).toBeNull();
  });

  it('PRUEBA NEGATIVA: un embarque dado de alta sin guías no está capturado', () => {
    const [v] = armarViajesTlmk(degollado, [captura({ guias: 0, guias_incompletas: 0 })]);
    expect(v.estado_costo).toBe('a_medias');
  });

  it('un embarque cancelado no captura el viaje', () => {
    const [v] = armarViajesTlmk(degollado, [captura({ cancelado: true })]);
    expect(v.estado_costo).toBe('sin_captura');
  });

  it('sin renglón de gastos de ruta es «sin dato», distinto de $0 capturado', () => {
    const [sin] = armarViajesTlmk(degollado, [captura({ gastos_ruta: null })]);
    const [cero] = armarViajesTlmk(degollado, [captura({ gastos_ruta: 0 })]);
    expect(sin.costo?.gastos_ruta).toBeNull();
    expect(cero.costo?.gastos_ruta).toBe(0);
    expect(sin.costo?.registrado).toBe(380);
  });

  it('el km del viaje no se publica si algún embarque no lo trae', () => {
    const [v] = armarViajesTlmk(degollado, [captura({}), captura({ shipment_id: 's2', km: null })]);
    expect(v.km).toBeNull();
  });
});

describe('tlmk-viajes · resumen', () => {
  it('el % sale SÓLO sobre la venta de los capturados, no sobre toda la venta', () => {
    const viajes = armarViajesTlmk(
      [...degollado, parada({ guia: '0001744', destino_ciudad: 'LEON', total: 217347.94 })],
      [captura({})],
    );
    const r = resumirViajesTlmk(viajes);
    expect(r.viajes).toBe(2);
    expect(r.venta).toBe(323873.33);
    expect(r.por_estado.capturado).toEqual({ viajes: 1, venta: 106525.39 });
    expect(r.por_estado.sin_captura).toEqual({ viajes: 1, venta: 217347.94 });
    expect(r.capturados_pct).toBe(0.76);
  });

  it('sin viajes capturados no hay porcentaje', () => {
    expect(resumirViajesTlmk(armarViajesTlmk(degollado, [])).capturados_pct).toBeNull();
  });
});
