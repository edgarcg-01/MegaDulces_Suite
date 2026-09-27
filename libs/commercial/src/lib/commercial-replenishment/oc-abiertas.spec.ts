import { clasificarRecepciones, filtroSucursalOc, OcAbierta, resumenOcAbiertas } from './oc-abiertas';

const OC = (o: Partial<OcAbierta>): OcAbierta => ({
  almacen: '00', folio: 'F1', fecha_oc: '2026-09-01', proveedor: 'PROV', estatus: 'N',
  dias: 5, lineas: 1, valor: 100, prob: 100, ...o,
});

describe('[RA-PRO.60] filtroSucursalOc — el alcance corta por sucursal', () => {
  it('null (alcance total, nada pedido) → todas', () => {
    expect(filtroSucursalOc(null)).toEqual({ todas: true, codigos: [] });
  });

  it('⭐ NEGATIVA: [] (cero sucursales) NO se lee como "todas"', () => {
    // Es el defecto que cierra: con el patrón `if (codes.length)` una encargada cuyo alcance
    // resolvió a nada veía las órdenes de toda la red.
    expect(filtroSucursalOc([])).toEqual({ todas: false, codigos: [] });
  });

  it('lista → esas sucursales, sin repetidos ni vacíos', () => {
    expect(filtroSucursalOc(['01', ' 01 ', '', '08'])).toEqual({ todas: false, codigos: ['01', '08'] });
  });
});

describe('[RA-PRO.60] resumenOcAbiertas — los indicadores no dependen del tope de la tabla', () => {
  it('sin recortar: totales, esperado pesado y "para barrer" (+30 d)', () => {
    const r = resumenOcAbiertas([
      OC({ dias: 45, valor: 1000, prob: 10 }),
      OC({ dias: 31, valor: 500, prob: 50 }),
      OC({ dias: 30, valor: 200, prob: 100 }),   // 30 exactos NO es "+30"
    ]);
    expect(r).toMatchObject({ total: 3, mostradas: 3, truncado: false, total_valor: 1700,
      valor_esperado: 100 + 250 + 200, viejas: 2, valor_viejas: 1500 });
  });

  it('⭐ NEGATIVA: con más órdenes que el tope, los indicadores cuentan TODAS y se declara el recorte', () => {
    const todas = Array.from({ length: 7 }, (_, i) => OC({ folio: `F${i}`, dias: 40 - i, valor: 10 }));
    const r = resumenOcAbiertas(todas, 3);
    expect(r.rows.map((o) => o.folio)).toEqual(['F0', 'F1', 'F2']);   // las primeras (las más viejas)
    expect(r).toMatchObject({ total: 7, mostradas: 3, truncado: true, total_valor: 70, viejas: 7, valor_viejas: 70 });
  });

  it('sin curva (prob null) el valor cuenta completo en el esperado — no se inventa una probabilidad', () => {
    expect(resumenOcAbiertas([OC({ valor: 300, prob: null })]).valor_esperado).toBe(300);
  });

  it('lista vacía → todo en cero, sin recorte', () => {
    expect(resumenOcAbiertas([])).toMatchObject({ total: 0, mostradas: 0, truncado: false, total_valor: 0, valor_esperado: 0, viejas: 0 });
  });

  it('redondea a centavos (sin arrastrar ruido de flotante)', () => {
    const r = resumenOcAbiertas([OC({ valor: 0.1 }), OC({ valor: 0.2 })]);
    expect(r.total_valor).toBe(0.3);
  });
});

describe('[RA-PRO.62] resumenOcAbiertas — conteo por estatus de seguimiento', () => {
  const seg = (estatus: 'vigente' | 'detenida_pago' | 'backorder') =>
    ({ estatus, nota: estatus === 'vigente' ? null : 'motivo', actualizado_por: 'francisco', actualizado_en: '2026-09-26T10:00:00.000Z' });

  it('cuenta cada estatus y las que no tienen registro como "sin_revisar", con todas las llaves presentes', () => {
    const r = resumenOcAbiertas([
      OC({ seguimiento: seg('detenida_pago') }), OC({ seguimiento: seg('detenida_pago') }),
      OC({ seguimiento: seg('vigente') }), OC({ seguimiento: null }), OC({}),
    ]);
    expect(r.por_seguimiento).toEqual({
      sin_revisar: 2, vigente: 1, detenida_pago: 2, detenida_logistica: 0, backorder: 0, no_surtida_cancelada: 0,
    });
  });

  it('⭐ el conteo es sobre TODAS, no sobre las que caben en la tabla', () => {
    const todas = Array.from({ length: 5 }, () => OC({ seguimiento: seg('backorder') }));
    expect(resumenOcAbiertas(todas, 2).por_seguimiento['backorder']).toBe(5);
  });
});

describe('[RA-PRO.61] clasificarRecepciones — qué cuenta como surtido de la OC', () => {
  const R = (folio: string, proveedor_code: string | null, fecha: string | null, monto = 100) => ({ folio, proveedor_code, fecha, monto });

  it('⭐ el caso real: la OC de BARCEL no suma las recepciones de BIMBO que citan su folio', () => {
    const { validas, descartadas } = clasificarRecepciones('CP001', '2026-04-14', [
      R('0006333', 'CP002', '2026-06-01'), R('0006557', 'CP001', '2026-06-03'), R('0008544', 'CP002', '2026-08-03'),
    ]);
    expect(validas.map((r) => r.folio)).toEqual(['0006557']);
    expect(descartadas.map((r) => r.folio)).toEqual(['0006333', '0008544']);
  });

  it('una recepción anterior a la orden no cuenta', () => {
    expect(clasificarRecepciones('CP001', '2026-04-14', [R('1', 'CP001', '2026-04-13')]).descartadas).toHaveLength(1);
    expect(clasificarRecepciones('CP001', '2026-04-14', [R('1', 'CP001', '2026-04-14')]).validas).toHaveLength(1);
  });

  it('sin código de proveedor (en la OC o en la recepción) no se puede afirmar: no cuenta', () => {
    expect(clasificarRecepciones(null, '2026-04-14', [R('1', 'CP001', '2026-05-01')]).validas).toHaveLength(0);
    expect(clasificarRecepciones('CP001', '2026-04-14', [R('1', null, '2026-05-01')]).validas).toHaveLength(0);
  });

  it('compara el código sin espacios ni mayúsculas', () => {
    expect(clasificarRecepciones(' cp001 ', null, [R('1', 'CP001', null)]).validas).toHaveLength(1);
  });
});
