import {
  CRITERIO_RECOMPRA,
  CRITERIO_SUCURSAL,
  Existencia,
  MargenFuente,
  Movimiento,
  NewProductSource,
  Senales,
  armarProducto,
  llegadaDe,
  margenesDe,
  ocultarCostoPlazas,
  construirCohortes,
  construirResumen,
  esKindValido,
  estadoDe,
  etapaDe,
  existenciaDesglose,
  ocultarCosto,
  porSemana,
  recomendar,
  serieDiaria,
  sumarDias,
  tipoEntradaTexto,
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
    expect(fila.hitos[30]).toEqual({ cerrado: true, inversion: 2000, venta: 3000, unidades: {} });
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
    expect(p05.existencia_desglose).toEqual([{ unidad: 'CJA', cantidad: 3 }]);
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

describe('[NP.16] existencia en las presentaciones de la ficha de cada plaza, en enteros', () => {
  const ex = { product_id: 'p1', plaza: '03', cantidad: 36, factor: 1 };
  const k = { ...ex, fuente: 'kepler', unidad: 'PZA' };

  it('Kepler: cajas enteras y lo que sobra en la base', () => {
    expect(existenciaDesglose({ ...k, cantidad: 13, unidad_mayor: 'CJA', factor_mayor: 12 }))
      .toEqual([{ unidad: 'CJA', cantidad: 1 }, { unidad: 'PZA', cantidad: 1 }]);
    expect(existenciaDesglose({ ...k, unidad_mayor: 'PAQ', factor_mayor: 12 })).toEqual([{ unidad: 'PAQ', cantidad: 3 }]);
  });

  it('⭐ con paquete en medio: cajas, paquetes y piezas (334 = 5 cajas de 60, 3 paquetes de 10 y 4 piezas)', () => {
    const tres = { ...k, cantidad: 334, unidad_mayor: 'CJA', factor_mayor: '60.00', unidad_media: 'PAQ', factor_media: '10.00', peldano_caja: 3 };
    expect(existenciaDesglose(tres)).toEqual([
      { unidad: 'CJA', cantidad: 5 }, { unidad: 'PAQ', cantidad: 3 }, { unidad: 'PZA', cantidad: 4 },
    ]);
    // Menos de una caja: paquetes y piezas, sin "0 cajas".
    expect(existenciaDesglose({ ...tres, cantidad: 34 })).toEqual([{ unidad: 'PAQ', cantidad: 3 }, { unidad: 'PZA', cantidad: 4 }]);
  });

  it('⛔ el intermedio entra sólo si la caja es múltiplo exacto de él, y si es otra presentación', () => {
    // Medido: caja de 200 con paquete de 11. Partirla en paquetes daría una cuenta que no cuadra.
    const raro = { ...k, cantidad: 425, unidad_mayor: 'CJA', factor_mayor: 200, unidad_media: 'PAQ', factor_media: 11, peldano_caja: 3 };
    expect(existenciaDesglose(raro)).toEqual([{ unidad: 'CJA', cantidad: 2 }, { unidad: 'PZA', cantidad: 25 }]);
    // La ficha más común: u2 repite la base con factor 1.
    const plana = { ...k, cantidad: 13, unidad_mayor: 'CJA', factor_mayor: 12, unidad_media: 'PZA', factor_media: 1, peldano_caja: 3 };
    expect(existenciaDesglose(plana)).toEqual([{ unidad: 'CJA', cantidad: 1 }, { unidad: 'PZA', cantidad: 1 }]);
    // Con la caja en el peldaño 2, u2 ES la caja: no hay intermedio.
    expect(existenciaDesglose({ ...plana, unidad_media: 'CJA', factor_media: 12, peldano_caja: 2 }))
      .toEqual([{ unidad: 'CJA', cantidad: 1 }, { unidad: 'PZA', cantidad: 1 }]);
  });

  it('un bulto de peso con factor fraccionario: bultos enteros y el resto en kilos', () => {
    expect(existenciaDesglose({ ...k, cantidad: 20, unidad: 'KG', unidad_mayor: 'BTO', factor_mayor: '6.84' }))
      .toEqual([{ unidad: 'BTO', cantidad: 2 }, { unidad: 'KG', cantidad: 6.32 }]);
    // El flotante no se come una caja: 60 = 1 caja exacta.
    expect(existenciaDesglose({ ...k, cantidad: 59.9999999999, unidad_mayor: 'CJA', factor_mayor: 60 }))
      .toEqual([{ unidad: 'CJA', cantidad: 1 }]);
  });

  it('⛔ sin ficha, con una sola unidad, agotado, o sin alcanzar una caja: no hay desglose', () => {
    expect(existenciaDesglose({ ...k, unidad: null, unidad_mayor: null, factor_mayor: null })).toBeNull();
    expect(existenciaDesglose({ ...k, unidad_mayor: 'PZA', factor_mayor: 1 })).toBeNull();
    expect(existenciaDesglose({ ...k, unidad_mayor: 'CJA', factor_mayor: null })).toBeNull();
    expect(existenciaDesglose({ ...k, cantidad: 0, unidad_mayor: 'CJA', factor_mayor: 12 })).toBeNull();
    expect(existenciaDesglose({ ...k, cantidad: 8, unidad_mayor: 'CJA', factor_mayor: 12 })).toBeNull();
  });

  it('Wincaja: el divisor de presentación (ADR-055) es la caja, y la base queda sin rótulo de Kepler', () => {
    expect(existenciaDesglose({ ...ex, cantidad: 53, factor: 10, fuente: 'wincaja', unidad: 'PZA' }))
      .toEqual([{ unidad: 'CJA', cantidad: 5 }, { unidad: '?', cantidad: 3 }]);
    const { plazas } = armarProducto(fuente(), HOY, [], [{ ...ex, cantidad: 50, factor: 10, fuente: 'wincaja', unidad: 'PZA' }]);
    expect(plazas[0].existencia_unidad).toBeNull();
    expect(plazas[0].existencia_fuente).toBe('wincaja');
    expect(plazas[0].existencia_desglose).toEqual([{ unidad: 'CJA', cantidad: 5 }]);
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

/**
 * `[NP.15]` Los tres márgenes y dónde se mueve mejor. Las cifras de entrada son pesos SIN impuesto
 * (los deja así la matvista); aquí se prueba que cada margen use SU denominador y declare lo que no
 * alcanza a cubrir.
 */
const mf = (over: Partial<MargenFuente> = {}): MargenFuente => ({
  n: 1000, nc: 800, c: 600, nm: 1000, m: 170, b: { PZA: { q: 100, n: 1000 } }, ...over,
});

describe('[NP.15] los tres márgenes', () => {
  it('cada uno con su denominador: lista 17%, real 25% sobre lo que trae costo, pagado 35%', () => {
    const m = margenesDe([mf()], { PZA: { q: 200, i: 1300 } })!;
    expect(m.venta_neta).toBe(1000);
    expect(m.lista).toEqual({ pct: 17, utilidad: 170, cobertura: 1, nota: null });
    // El real se mide SÓLO sobre los $800 que traen costo: (800 − 600) / 800.
    expect(m.real.pct).toBe(25);
    expect(m.real.utilidad).toBe(200);
    expect(m.real.cobertura).toBe(0.8);
    expect(m.real.nota).toContain('20%');
    // Pagado: $1,300 / 200 PZA = $6.50 la pieza; 100 PZA vendidas cuestan $650.
    expect(m.costo_pagado).toEqual({ unidad: 'PZA', por_unidad: 6.5 });
    expect(m.pagado).toEqual({ pct: 35, utilidad: 350, cobertura: 1, nota: null });
  });

  it('⛔ la venta sin costo NO es margen cero: se declara', () => {
    const m = margenesDe([mf({ nc: 0, c: 0 })], { PZA: { q: 200, i: 1300 } })!;
    expect(m.real.pct).toBeNull();
    expect(m.real.utilidad).toBeNull();
    expect(m.real.cobertura).toBe(0);
    expect(m.real.nota).toMatch(/no registró el costo/);
    // Los otros dos no dependen del costo del renglón.
    expect(m.lista.pct).toBe(17);
    expect(m.pagado.pct).toBe(35);
  });

  it('el margen de varias plazas se pondera por venta, no promedia porcentajes', () => {
    // A: $100 al 50% · B: $900 al 10% → (1000 − 860) / 1000 = 14%, no el 30% del promedio simple.
    const m = margenesDe([
      mf({ n: 100, nc: 100, c: 50, nm: 0, m: 0, b: {} }),
      mf({ n: 900, nc: 900, c: 810, nm: 0, m: 0, b: {} }),
    ], undefined)!;
    expect(m.real.pct).toBe(14);
    expect(m.real.utilidad).toBe(140);
  });

  it('compra y venta en distinta unidad base: no se compara, se dice', () => {
    const m = margenesDe([mf()], { CJA: { q: 10, i: 1300 } })!;
    expect(m.pagado.pct).toBeNull();
    expect(m.pagado.nota).toContain('CJA');
    expect(m.pagado.nota).toContain('PZA');
    expect(m.costo_pagado).toEqual({ unidad: 'CJA', por_unidad: 130 });
  });

  it('compra en dos unidades base, o sin compras: tampoco se adivina', () => {
    expect(margenesDe([mf()], { PZA: { q: 10, i: 65 }, CJA: { q: 1, i: 600 } })!.pagado.nota).toMatch(/varias unidades/);
    expect(margenesDe([mf()], undefined)!.pagado.nota).toMatch(/Sin compras/);
    expect(margenesDe([mf()], {})!.costo_pagado).toBeNull();
  });

  it('sin meta en la ficha: el de lista se declara; con meta parcial, dice cuánto falta', () => {
    expect(margenesDe([mf({ nm: 0, m: 0 })], undefined)!.lista.nota).toMatch(/no trae % de margen/);
    const parcial = margenesDe([mf({ nm: 600, m: 90 })], undefined)!;
    expect(parcial.lista.pct).toBe(15);
    expect(parcial.lista.cobertura).toBe(0.6);
    expect(parcial.lista.nota).toContain('40%');
  });

  it('sin venta en la historia no hay márgenes', () => {
    expect(margenesDe([], undefined)).toBeNull();
    expect(margenesDe([mf({ n: 0 })], undefined)).toBeNull();
  });
});

describe('[NP.15] dónde se mueve mejor', () => {
  // Lanzado hace 45 días en la 03; la 05 empezó a vender hace 10 días y la 06 hace 3.
  const serie = (desde: number) => Array.from({ length: 45 }, (_, i) => (i >= desde ? 100 : 0));
  const ex: Existencia[] = [
    { product_id: 'p1', plaza: '03', cantidad: 50, factor: null, fuente: 'kepler', unidad: 'PZA' },
  ];
  const nombres = new Map([['03', 'La Piedad'], ['05', 'Zamora'], ['06', 'Yurécuaro']]);
  const armado = () => armarProducto(fuente({
    venta_por_plaza: { '03': serie(0), '05': serie(35), '06': serie(42) },
    margen_plaza: {
      '03': mf({ n: 4500, b: { PZA: { q: 450, n: 4500 } } }),
      '05': mf({ n: 2000 }),
      '06': mf({ n: 900 }),
    },
  }), HOY, [], ex, { conCosto: true, nombres });

  it('ordena por venta neta por día desde que llegó a cada plaza', () => {
    const { fila, plazas } = armado();
    const p = (c: string) => plazas.find((x) => x.plaza === c)!.movimiento;
    expect(p('03')).toMatchObject({ dias: 45, venta_neta_dia: 100, lugar: 2 });
    expect(p('05')).toMatchObject({ dias: 10, venta_neta_dia: 200, lugar: 1 });
    expect(fila.mejor_plaza).toEqual({ plaza: '05', nombre: 'Zamora', venta_neta_dia: 200, dias: 10 });
  });

  it(`⛔ una plaza con menos de ${CRITERIO_SUCURSAL.diasMinimos} días no compite, aunque venda más por día`, () => {
    const m = armado().plazas.find((x) => x.plaza === '06')!.movimiento;
    expect(m.venta_neta_dia).toBe(300);
    expect(m.lugar).toBeNull();
  });

  it('lo desplazado se mide en la unidad de la ficha: 450 vendidas contra 50 en existencia = 90%', () => {
    const plazas = armado().plazas;
    expect(plazas.find((x) => x.plaza === '03')!.movimiento.desplazado).toBe(0.9);
    // Sin renglón de existencia no hay contra qué medir: NULL, no 100%.
    expect(plazas.find((x) => x.plaza === '05')!.movimiento.desplazado).toBeNull();
  });

  it('los márgenes van por producto y por plaza', () => {
    const { fila, plazas } = armado();
    expect(fila.margenes!.venta_neta).toBe(7400);
    expect(plazas.find((x) => x.plaza === '05')!.margenes!.venta_neta).toBe(2000);
  });

  it('⛔ sin permiso de costo no viajan los márgenes, pero sí dónde se mueve mejor', () => {
    const { fila, plazas } = armado();
    const [f] = ocultarCosto([fila]);
    expect(f.margenes).toBeNull();
    expect(f.mejor_plaza?.plaza).toBe('05');
    const ps = ocultarCostoPlazas(plazas);
    expect(ps.every((x) => x.margenes === null)).toBe(true);
    expect(ps.find((x) => x.plaza === '05')!.movimiento.lugar).toBe(1);
  });
});

/** `[NP.16]` Cuándo llegó, las unidades de cada corte y el reparto entre sucursales. */
describe('[NP.16] llegada a la empresa', () => {
  const nombres = new Map([['01', 'Padre Hidalgo'], ['06', 'Canindo'], ['08', 'Morelia Abastos']]);

  it('sale del kardex: la primera compra física y dónde entró ese día', () => {
    const ll = llegadaDe({ llegada: { compra: '2026-09-18', compra_plazas: ['06', '01'], entrada: '2026-09-18', entrada_doc: 'X-A-40' },
      primera_recepcion: '2026-09-20', entradas: [] }, [], nombres)!;
    expect(ll.fecha).toBe('2026-09-18');
    expect(ll.fuente).toBe('kardex');
    expect(ll.sucursales).toEqual([{ plaza: '01', nombre: 'Padre Hidalgo' }, { plaza: '06', nombre: 'Canindo' }]);
    expect(ll.antes).toBeNull();
  });

  it('⛔ si entró ANTES por otro camino, se dice cuándo y por qué documento', () => {
    const ll = llegadaDe({ llegada: { compra: '2026-07-09', compra_plazas: ['01'], entrada: '2026-01-29', entrada_doc: 'N-A-30' },
      primera_recepcion: null, entradas: [] }, [], nombres)!;
    expect(ll.antes).toEqual({ fecha: '2026-01-29', tipo: 'ajuste de inventario' });
  });

  it('sin compra en Kepler: la fecha va vacía y se dice por dónde entró', () => {
    const ll = llegadaDe({ llegada: { compra: null, compra_plazas: [], entrada: '2026-09-22', entrada_doc: 'U-A-50' },
      primera_recepcion: null, entradas: [] }, [], nombres)!;
    expect(ll.fecha).toBeNull();
    expect(ll.antes).toEqual({ fecha: '2026-09-22', tipo: 'traspaso de otra sucursal' });
    expect(tipoEntradaTexto('U-A-25')).toBe('otro movimiento (U-A-25)');
  });

  it('sin kardex: la compra aplicada, y si tampoco hay, nada (no se inventa)', () => {
    const ll = llegadaDe({ llegada: {}, primera_recepcion: '2026-09-03', entradas: [{ f: '2026-09-03', p: '08', i: 100 }] }, [], nombres)!;
    expect(ll).toMatchObject({ fecha: '2026-09-03', fuente: 'compra_aplicada', sucursales: [{ plaza: '08', nombre: 'Morelia Abastos' }] });
    expect(llegadaDe({ llegada: {}, primera_recepcion: null, entradas: [] }, [], nombres)).toBeNull();
  });
});

describe('[NP.16] unidades por corte y reparto', () => {
  it('las unidades de cada corte: la historia + lo de hoy sólo si hoy cae dentro del tramo', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'venta', plaza: '03', fecha: HOY, importe: 50, unidad: 'PZA', cantidad: 4 }];
    const { fila } = armarProducto(fuente({
      dias: 45,
      venta_unidades_hito: { '30': { CJA: 2 }, '60': { CJA: 3, PZA: 10 }, '90': { CJA: 3, PZA: 10 } },
    }), HOY, vivo, []);
    expect(fila.hitos[30].unidades).toEqual({ CJA: 2 });            // hoy (día 45) ya no es del tramo de 30
    expect(fila.hitos[60].unidades).toEqual({ CJA: 3, PZA: 14 });   // sí del de 60
  });

  it('⭐ por sucursal: lo que le llegó de otra y lo que mandó a otras y a rutas; una que sólo recibió también aparece', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'traspaso', plaza: '05', fecha: HOY, importe: 0, unidad: 'CJA', cantidad: 1 }];
    const { plazas } = armarProducto(fuente({
      reparto: {
        '03': { salida_sucursal: { CJA: 5 }, salida_ruta: { PAQ: 4 } },
        '04': { traspaso: { CJA: 2 }, desde: sumarDias(HOY, -10) },
      },
    }), HOY, vivo, []);
    const p = (c: string) => plazas.find((x) => x.plaza === c)!;
    expect(p('03')).toMatchObject({ enviado_sucursales: { CJA: 5 }, enviado_rutas: { PAQ: 4 }, recibido_traspaso: {} });
    // La 04 no vendió ni compró: está por el traspaso, y sus días cuentan desde que le llegó.
    expect(p('04')).toMatchObject({ recibido_traspaso: { CJA: 2 }, primera_actividad: sumarDias(HOY, -10), dia: 10 });
    // Lo de hoy también se suma.
    expect(p('05').recibido_traspaso).toEqual({ CJA: 1 });
  });

  it('⛔ un traspaso no es un lanzamiento: el producto sin historia sigue "sin movimiento"', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'traspaso', plaza: '05', fecha: HOY, importe: 0, unidad: 'CJA', cantidad: 1 }];
    const { fila } = armarProducto(fuente({ lanzamiento: null, sin_movimiento: true, venta_dia: [], venta_por_plaza: {}, entradas: [] }),
      HOY, vivo, []);
    expect(fila.lanzamiento).toBeNull();
    expect(fila.estado).toBe('sin_movimiento');
  });
});
