import {
  clasificarOc, clasificarRecepciones, filtroSucursalOc, OcAbierta, resumenOcAbiertas,
} from './oc-abiertas';

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

describe('[RA-PRO.67] clasificarOc — los dos testigos del estado real', () => {
  // Las cifras son las medidas contra prod el 2026-10-02 sobre los 292 renglones de la bandeja.

  it('el documento manda cuando dice algo: vale cancelado = compra abortada', () => {
    // Las 8 filas de c43='A'. Es el caso que resolvió qué hacer con una letra sin documentar.
    expect(clasificarOc('vale_cancelado', false)).toBe('abortada');
    // Y las 2 donde el ERP va rezagado y todavía la llama pendiente: manda el documento.
    expect(clasificarOc('vale_cancelado', true)).toBe('abortada');
  });

  it('vale vivo sin entrada = mercancía apartada que nadie capturó, diga lo que diga el ERP', () => {
    expect(clasificarOc('vale_vivo', false)).toBe('falta_entrada');   // las 27 con c43='F'
    expect(clasificarOc('vale_vivo', true)).toBe('falta_entrada');
  });

  it('sin vale el único testigo es el ERP: ahí sí decide c43', () => {
    expect(clasificarOc('sin_vale', true)).toBe('pendiente');            // 252 filas
    expect(clasificarOc('sin_vale', false)).toBe('cerrada_sin_rastro');  // 2 filas
  });

  it('⭐ sin columnas (migración sin aplicar) NO inventa: cae a pendiente, como antes de la fase', () => {
    expect(clasificarOc(null, null)).toBe('pendiente');
    expect(clasificarOc(undefined, undefined)).toBe('pendiente');
  });

  it('`clasificacion_disponible` declara si se midió o no, en vez de pintar cuatro clases vacías', () => {
    const sinColumnas = [OC({}), OC({})];
    expect(resumenOcAbiertas(sinColumnas).clasificacion_disponible).toBe(false);
    expect(resumenOcAbiertas(sinColumnas).por_clase.pendiente).toBe(2);

    const conColumnas = [OC({ estado_cadena: 'sin_vale', pendiente_en_erp: true })];
    expect(resumenOcAbiertas(conColumnas).clasificacion_disponible).toBe(true);
  });

  it('el resumen reparte dinero y conteo por clase sobre TODAS, no sobre las pintadas', () => {
    const todas: OcAbierta[] = [
      ...Array.from({ length: 3 }, () => OC({ estado_cadena: 'sin_vale', pendiente_en_erp: true, valor: 1000 })),
      OC({ estado_cadena: 'vale_cancelado', pendiente_en_erp: false, valor: 500 }),
      OC({ estado_cadena: 'vale_vivo', pendiente_en_erp: false, valor: 200 }),
      OC({ estado_cadena: 'sin_vale', pendiente_en_erp: false, valor: 70 }),
    ];
    // limite 2: sólo se pintan 2, pero los indicadores cuentan las 6.
    const r = resumenOcAbiertas(todas, 2);
    expect(r.mostradas).toBe(2);
    expect(r.por_clase).toEqual({ pendiente: 3, falta_entrada: 1, abortada: 1, cerrada_sin_rastro: 1 });
    expect(r.valor_por_clase.pendiente).toBe(3000);
    // Las que no salen solas: abortada + cerrada_sin_rastro.
    expect(r.muertas).toBe(2);
    expect(r.valor_muertas).toBe(570);
    // El universo cuadra: ninguna fila se pierde ni se cuenta dos veces.
    const suma = Object.values(r.por_clase).reduce((a, b) => a + b, 0);
    expect(suma).toBe(r.total);
    expect(Object.values(r.valor_por_clase).reduce((a, b) => a + b, 0)).toBe(r.total_valor);
  });

  it('todas las llaves existen aunque valgan 0: un chip que aparece y desaparece se lee como error', () => {
    const r = resumenOcAbiertas([]);
    expect(Object.keys(r.por_clase).sort())
      .toEqual(['abortada', 'cerrada_sin_rastro', 'falta_entrada', 'pendiente']);
    expect(r.muertas).toBe(0);
    // Bandeja vacía = no se midió nada, y así se declara.
    expect(r.clasificacion_disponible).toBe(false);
  });
});
