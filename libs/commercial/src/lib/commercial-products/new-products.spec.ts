import {
  CRITERIO_RECOMPRA,
  Movimiento,
  NewProductSource,
  Senales,
  armarProducto,
  construirCohortes,
  construirResumen,
  esKindValido,
  estadoDe,
  etapaDe,
  existenciaMayor,
  ocultarCosto,
  porSemana,
  recomendar,
  serieDiaria,
  sumarDias,
} from './new-products';

/**
 * `[NP.2]` La lógica de Productos nuevos: la serie (historia + hoy), los hitos, la recomendación de
 * recompra global y por sucursal, y las cohortes.
 *
 * Se prueba aquí, sin base, porque es donde se DECIDE. El candado de base
 * (`database/tests/test-newdb-new-products.js`) prueba que la matvista y la función en vivo miden
 * lo que dicen.
 */

const HOY = '2026-10-07';

/** Un producto lanzado hace `dias` días, con historia hasta ayer (corte = hoy). */
function fuente(over: Partial<NewProductSource> & { dias?: number } = {}): NewProductSource {
  const dias = over.dias ?? 45;
  const lanzamiento = sumarDias(HOY, -dias);
  return {
    product_id: 'p1', sku: 'X1', nombre: 'Producto', marca: null, proveedor: null,
    alta_suite: lanzamiento, alta_en_lote: false, primera_recepcion: lanzamiento, primera_venta: lanzamiento,
    lanzamiento, historia_desde: '2025-01-01', fuentes: ['entradas', 'kepler'],
    sin_movimiento: false, no_medible: false, exclusion_auto: null, posible_recodificacion: false,
    corte: HOY,
    venta_dia: new Array(dias).fill(100),
    venta_por_plaza: { '03': new Array(dias).fill(100) },
    entradas: [{ f: lanzamiento, p: '03', i: 2000 }],
    clasificacion: null, nota: null, clasificado_por: null,
    ...over,
  };
}

const senales = (over: Partial<Senales> = {}): Senales => ({
  dia: 45, venta_total: 4000, inversion_total: 3000, dias_con_venta_28: 20, venta_28: 2000,
  venta_28_previa: 2000, dias_sin_venta: 0, agotado_en: 0, plazas_con_existencia: 1, ...over,
});

describe('etapa y estado', () => {
  it('los cortes son los días 30, 60 y 90', () => {
    expect([null, 0, 29, 30, 59, 60, 89, 90].map(etapaDe))
      .toEqual(['sin_movimiento', 'mes_1', 'mes_1', 'mes_2', 'mes_2', 'mes_3', 'mes_3', 'graduado']);
  });

  it('⭐ Compras manda sobre el sistema en las dos direcciones', () => {
    const base = { exclusion_auto: null, sin_movimiento: false, no_medible: false };
    expect(estadoDe({ ...base, exclusion_auto: 'promocion', clasificacion: 'nuevo' }).estado).toBe('seguimiento');
    expect(estadoDe({ ...base, clasificacion: 'recodificacion' }).estado).toBe('excluido');
    expect(estadoDe({ ...base, clasificacion: null, exclusion_auto: 'descuento' }).motivo).toBe('Código de descuento');
  });
});

describe('serieDiaria — historia + hoy, sin contar dos veces', () => {
  it('la historia llega hasta el corte y lo de hoy se suma después', () => {
    const s = serieDiaria('2026-10-01', '2026-10-07', '2026-10-07', [1, 2, 3, 4, 5, 6], [
      { fecha: '2026-10-07', importe: 10 },
    ]);
    expect(s).toEqual([1, 2, 3, 4, 5, 6, 10]);
  });

  it('⛔ si la historia trajera días después del corte, se ignoran (esos vienen en vivo)', () => {
    // La matvista corta en fecha < corte; si por error trajera de más, no debe doblar el día.
    const s = serieDiaria('2026-10-05', '2026-10-07', '2026-10-06', [1, 999, 999], [
      { fecha: '2026-10-06', importe: 5 }, { fecha: '2026-10-07', importe: 7 },
    ]);
    expect(s).toEqual([1, 5, 7]);
  });

  it('agrupa por semanas desde el inicio', () => {
    expect(porSemana([1, 1, 1, 1, 1, 1, 1, 2, 2])).toEqual([7, 4]);
  });
});

describe('recomendar — ¿conviene volver a comprarlo?', () => {
  it('antes del día 21 no se decide', () => {
    const r = recomendar(senales({ dia: 12 }));
    expect(r.veredicto).toBe('pronto');
    expect(r.motivos[0]).toContain(`día ${CRITERIO_RECOMPRA.diasMinimos}`);
  });

  it('nunca vendido → no recomprar', () => {
    expect(recomendar(senales({ venta_total: 0, dias_con_venta_28: 0, dias_sin_venta: null })).veredicto).toBe('no_recomprar');
  });

  it('dejó de venderse hace 3 semanas → no recomprar', () => {
    const r = recomendar(senales({ dias_sin_venta: 25 }));
    expect(r.veredicto).toBe('no_recomprar');
    expect(r.motivos[0]).toContain('25 días sin venderse');
  });

  it('la venta cayó más de 40% contra las 4 semanas anteriores → revisar', () => {
    const r = recomendar(senales({ venta_28: 500, venta_28_previa: 2000 }));
    expect(r.veredicto).toBe('revisar');
    expect(r.motivos[0]).toContain('cayó 75%');
  });

  it('se vende pocos días → revisar', () => {
    expect(recomendar(senales({ dias_con_venta_28: 5 })).veredicto).toBe('revisar');
  });

  it('venta sostenida + agotado en una plaza que lo vende → recomprar', () => {
    const r = recomendar(senales({ agotado_en: 1, inversion_total: 10000 }));
    expect(r.veredicto).toBe('recomprar');
    expect(r.motivos.join(' ')).toContain('Se agotó en 1 plaza');
  });

  it('venta sostenida + ya recuperó lo invertido → recomprar', () => {
    expect(recomendar(senales({ venta_total: 2500, inversion_total: 3000 })).veredicto).toBe('recomprar');
  });

  it('venta sostenida pero todavía hay existencia y no ha recuperado → esperar', () => {
    const r = recomendar(senales({ venta_total: 1000, inversion_total: 3000 }));
    expect(r.veredicto).toBe('esperar');
    expect(r.motivos[0]).toContain('todavía hay existencia');
  });

  it('⛔ sin permiso de costo la decisión no cambia, pero el motivo no dice cifras de inversión', () => {
    const con = recomendar(senales({ venta_total: 2500, inversion_total: 3000 }), { conCosto: true });
    const sin = recomendar(senales({ venta_total: 2500, inversion_total: 3000 }), { conCosto: false });
    expect(sin.veredicto).toBe(con.veredicto);
    expect(con.motivos.join(' ')).toContain('por cada $1 invertido');
    expect(sin.motivos.join(' ')).not.toMatch(/\$\d.*invertido/);
  });
});

describe('armarProducto — global', () => {
  it('hitos: un hito que todavía no llega no está cerrado', () => {
    const { fila } = armarProducto(fuente({ dias: 45 }), HOY, [], []);
    expect(fila.dia).toBe(45);
    expect(fila.hitos[30]).toEqual({ cerrado: true, inversion: 2000, venta: 3000 });
    expect(fila.hitos[60].cerrado).toBe(false);
  });

  it('⭐ la venta de hoy (en vivo) entra a la serie, al total y a "venta de hoy"', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'venta', plaza: '03', fecha: HOY, importe: 250 }];
    const { fila } = armarProducto(fuente({ dias: 10 }), HOY, vivo, []);
    expect(fila.venta_total).toBe(10 * 100 + 250);
    expect(fila.venta_hoy).toBe(250);
    expect(fila.semanas[fila.semanas.length - 1]).toBe(3 * 100 + 250);
  });

  it('⭐ una entrada de HOY en una plaza que ya lo tenía es recompra', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'entrada', plaza: '03', fecha: HOY, importe: 2000 }];
    const { fila } = armarProducto(fuente({ dias: 45 }), HOY, vivo, []);
    expect(fila.primera_recompra).toBe(HOY);
    expect(fila.dia_recompra).toBe(45);
    expect(fila.inversion_total).toBe(4000);
  });

  it('⭐ un producto sin historia que hoy entra arranca hoy: día 0', () => {
    const f = fuente({ lanzamiento: null, sin_movimiento: true, venta_dia: [], venta_por_plaza: {}, entradas: [] });
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'entrada', plaza: '01', fecha: HOY, importe: 900 }];
    const { fila } = armarProducto(f, HOY, vivo, []);
    expect(fila.estado).toBe('seguimiento');
    expect(fila.dia).toBe(0);
    expect(fila.recomendacion?.veredicto).toBe('pronto');
  });

  it('⛔ sin entradas la inversión es NULL, nunca 0', () => {
    const { fila } = armarProducto(fuente({ entradas: [] }), HOY, [], []);
    expect(fila.inversion_total).toBeNull();
    expect(fila.venta_por_peso).toBeNull();
    expect(fila.hitos[30].inversion).toBeNull();
  });

  it('excluido o sin movimiento no lleva recomendación', () => {
    expect(armarProducto(fuente({ exclusion_auto: 'promocion' }), HOY, [], []).fila.recomendacion).toBeNull();
  });
});

describe('armarProducto — por sucursal', () => {
  const f = fuente({
    dias: 45,
    venta_dia: new Array(45).fill(150),
    venta_por_plaza: { '03': new Array(45).fill(100), '05': new Array(45).fill(50) },
    entradas: [{ f: sumarDias(HOY, -45), p: '03', i: 2000 }, { f: sumarDias(HOY, -44), p: '05', i: 1000 }],
  });

  it('una plaza que vende y hoy no tiene existencia cuenta como agotada', () => {
    const { fila, plazas } = armarProducto(f, HOY, [], [
      { product_id: 'p1', plaza: '03', cantidad: 0, factor: 12 },
      { product_id: 'p1', plaza: '05', cantidad: 36, factor: 12, fuente: 'kepler', unidad: 'PZA', unidad_mayor: 'CJA', factor_mayor: 12 },
    ]);
    expect(fila.agotado_en).toBe(1);
    const p03 = plazas.find((p) => p.plaza === '03')!;
    const p05 = plazas.find((p) => p.plaza === '05')!;
    expect(p03.recomendacion.veredicto).toBe('recomprar');
    expect(p03.recomendacion.motivos.join(' ')).toContain('Se agotó');
    expect(p05.existencia_unidad).toBe('PZA');
    expect(p05.existencia_mayor).toEqual({ unidad: 'CJA', cantidad: 3 });
  });

  it('cada plaza cuenta sus días desde SU primera actividad', () => {
    const conTardia = fuente({
      dias: 45,
      venta_por_plaza: { '03': new Array(45).fill(100), '06': [...new Array(40).fill(0), 1, 1, 1, 1, 1] },
    });
    const { plazas } = armarProducto(conTardia, HOY, [], []);
    const p06 = plazas.find((p) => p.plaza === '06')!;
    expect(p06.dia).toBe(5);
    expect(p06.recomendacion.veredicto).toBe('pronto');
  });

  it('los nombres de plaza llegan si se pasan', () => {
    const { plazas } = armarProducto(f, HOY, [], [], { conCosto: true, nombres: new Map([['03', '8ESQ']]) });
    expect(plazas.find((p) => p.plaza === '03')?.nombre).toBe('8ESQ');
  });
});

describe('unidades de Kepler (NP.11)', () => {
  const vivoCaja: Movimiento = { product_id: 'p1', tipo: 'venta', plaza: '03', fecha: HOY, unidad: 'CJA', cantidad: 1, importe: 300 };

  it('suma historia + hoy rótulo por rótulo, sin mezclar cajas con piezas', () => {
    const f = fuente({ venta_unidades: { '03': { u: { CJA: 2, PZA: 10 }, i: 4000 } } });
    const { fila, plazas } = armarProducto(f, HOY, [vivoCaja], []);
    expect(fila.unidades_vendidas).toEqual({ CJA: 3, PZA: 10 });
    expect(fila.unidades_hoy).toEqual({ CJA: 1 });
    expect(plazas.find((p) => p.plaza === '03')!.unidades_vendidas).toEqual({ CJA: 3, PZA: 10 });
  });

  it('⛔ los pesos sin unidad se DECLARAN (ruta o Wincaja), no se reparten', () => {
    // La plaza vendió $4,500 de historia + $300 hoy; las unidades cubren $4,000 + $300.
    const f = fuente({ venta_unidades: { '03': { u: { PZA: 40 }, i: 4000 } } });
    const { fila, plazas } = armarProducto(f, HOY, [vivoCaja], []);
    expect(fila.venta_sin_unidad).toBe(500);
    expect(plazas.find((p) => p.plaza === '03')!.venta_sin_unidad).toBe(500);
  });

  it('sin unidades en la historia, toda la venta queda sin unidad (no se inventan piezas)', () => {
    const { fila } = armarProducto(fuente(), HOY, [], []);
    expect(fila.unidades_vendidas).toEqual({});
    expect(fila.venta_sin_unidad).toBe(4500);
  });

  it('centavos de redondeo no cuentan como venta sin unidad', () => {
    const f = fuente({ venta_unidades: { '03': { u: { PZA: 40 }, i: 4499.6 } } });
    expect(armarProducto(f, HOY, [], []).fila.venta_sin_unidad).toBe(0);
  });

  it('las entradas suman su unidad de historia y la de hoy', () => {
    const f = fuente({ entradas: [{ f: sumarDias(HOY, -45), p: '03', i: 2000, u: { CJA: 5 } }] });
    const hoyEntra: Movimiento = { product_id: 'p1', tipo: 'entrada', plaza: '03', fecha: HOY, folio: 'X1', unidad: 'CJA', cantidad: 2, importe: 800 };
    const { fila, plazas } = armarProducto(f, HOY, [hoyEntra], []);
    expect(fila.unidades_recibidas).toEqual({ CJA: 7 });
    expect(plazas.find((p) => p.plaza === '03')!.unidades_recibidas).toEqual({ CJA: 7 });
  });

  it('una venta y su devolución que se anulan no dejan un rótulo en cero', () => {
    const f = fuente({ venta_unidades: { '03': { u: { CJA: 0, PZA: 10 }, i: 4500 } } });
    expect(armarProducto(f, HOY, [], []).fila.unidades_vendidas).toEqual({ PZA: 10 });
  });

  it('un movimiento sin rótulo se cuenta como "?" (sin unidad), no como pieza', () => {
    const sinRotulo: Movimiento = { ...vivoCaja, unidad: null, cantidad: 4 };
    expect(armarProducto(fuente(), HOY, [sinRotulo], []).fila.unidades_hoy).toEqual({ '?': 4 });
  });
});

describe('existencia en la unidad mayor de cada plaza', () => {
  const ex = { product_id: 'p1', plaza: '03', cantidad: 36, factor: 1 };

  it('Kepler: el peldaño mayor de la ficha de ESA plaza', () => {
    expect(existenciaMayor({ ...ex, fuente: 'kepler', unidad: 'PZA', unidad_mayor: 'PAQ', factor_mayor: 12 }))
      .toEqual({ unidad: 'PAQ', cantidad: 3 });
  });

  it('⛔ sin ficha, o con una sola unidad, NO se inventa la caja', () => {
    expect(existenciaMayor({ ...ex, fuente: 'kepler', unidad: null, unidad_mayor: null, factor_mayor: null })).toBeNull();
    expect(existenciaMayor({ ...ex, fuente: 'kepler', unidad: 'PZA', unidad_mayor: 'PZA', factor_mayor: 1 })).toBeNull();
    expect(existenciaMayor({ ...ex, fuente: 'kepler', unidad: 'PZA', unidad_mayor: 'CJA', factor_mayor: null })).toBeNull();
  });

  it('Wincaja: el divisor de presentación (ADR-055), y la base queda sin rótulo de Kepler', () => {
    expect(existenciaMayor({ ...ex, cantidad: 50, factor: 10, fuente: 'wincaja', unidad: 'PZA' }))
      .toEqual({ unidad: 'CJA', cantidad: 5 });
    const { plazas } = armarProducto(fuente(), HOY, [], [{ ...ex, cantidad: 50, factor: 10, fuente: 'wincaja', unidad: 'PZA' }]);
    expect(plazas[0].existencia_unidad).toBeNull();
    expect(plazas[0].existencia_fuente).toBe('wincaja');
  });

  it('una fracción de caja se dice con un decimal', () => {
    expect(existenciaMayor({ ...ex, cantidad: 24, fuente: 'kepler', unidad: 'PZA', unidad_mayor: 'CJA', factor_mayor: 30 }))
      .toEqual({ unidad: 'CJA', cantidad: 0.8 });
  });
});

describe('cohortes, resumen y costo oculto', () => {
  const filas = [
    armarProducto(fuente({ product_id: 'a', dias: 120 }), HOY, [], []).fila,
    armarProducto(fuente({ product_id: 'b', dias: 101, venta_dia: new Array(101).fill(0), venta_por_plaza: {} }), HOY, [], []).fila,
    armarProducto(fuente({ product_id: 'c', dias: 86, entradas: [], venta_dia: new Array(86).fill(50) }), HOY, [], []).fila,
    armarProducto(fuente({ product_id: 'd', dias: 80, exclusion_auto: 'promocion' }), HOY, [], []).fila,
  ];

  it('agrupa sólo lanzamientos reales, y el cociente usa el MISMO universo', () => {
    const c = construirCohortes(filas);
    const julio = c.find((x) => x.mes === sumarDias(HOY, -86).slice(0, 7))!;
    expect(julio.con_inversion).toBe(0);
    expect(julio.venta_por_peso).toBeNull();
    expect(c.reduce((a, x) => a + x.productos, 0)).toBe(3);
  });

  it('el resumen cuenta veredictos', () => {
    const r = construirResumen(filas);
    expect(r.seguimiento).toBe(3);
    expect(r.excluido).toBe(1);
    expect(r.por_veredicto.no_recomprar).toBe(1);
    expect(Object.values(r.por_veredicto).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('⛔ sin permiso no viaja la inversión, ni por producto ni sumada', () => {
    const oc = ocultarCosto(filas);
    expect(oc.every((f) => f.inversion_total === null && f.hitos[30].inversion === null)).toBe(true);
    expect(construirResumen(oc).inversion).toBeNull();
  });

  it('esKindValido acepta las cuatro clasificaciones y nada más', () => {
    expect(['nuevo', 'recodificacion', 'promocion', 'no_mercancia'].every(esKindValido)).toBe(true);
    expect(esKindValido('otro')).toBe(false);
  });
});
