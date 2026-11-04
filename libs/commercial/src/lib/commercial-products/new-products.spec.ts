import {
  CRITERIO_LANZAMIENTO,
  CRITERIO_SUCURSAL,
  VEREDICTOS,
  VER_PRODUCTOS,
  juzgarRecuperacion,
  compraPorDocumento,
  compraSinImpuestos,
  llaveCompra,
  type CompraNetaInfo,
  type RenglonCompra,
  Existencia,
  MargenFuente,
  Movimiento,
  NewProductSource,
  Senales,
  armarProducto,
  conHitos,
  kpiHito,
  semaforoHito,
  llegadaDe,
  margenesDe,
  ocultarCostoPlazas,
  construirCohortes,
  construirResumen,
  esKindValido,
  estadoDe,
  etapaDe,
  escaleraComun,
  escaleraDeFicha,
  existenciaEnDuda,
  ocultarCosto,
  porSemana,
  recomendar,
  serieDiaria,
  sumarDias,
  tipoEntradaTexto,
} from './new-products';
import type { KpiUmbral } from '@megadulces/contracts';

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
  dia: 45, venta_total: 4000, venta_neta: 3448.28, inversion_total: 3000, dias_con_venta_28: 20, venta_28: 2000,
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

describe('recomendar — [NP.20] ¿el lanzamiento funcionó?', () => {
  it('antes del día 21 no se juzga', () => {
    const r = recomendar(senales({ dia: 12 }));
    expect(r.veredicto).toBe('pronto');
    expect(r.motivos[0]).toContain(`día ${CRITERIO_LANZAMIENTO.diasMinimos}`);
  });

  it('nunca vendido, con existencia → sacar', () => {
    expect(recomendar(senales({ venta_total: 0, dias_con_venta_28: 0, dias_sin_venta: null })).veredicto).toBe('sacar');
  });

  it('dejó de venderse hace 3 semanas, con existencia donde se vendía → sacar', () => {
    const r = recomendar(senales({ dias_sin_venta: 25, vendio_con_existencia: 1 }));
    expect(r.veredicto).toBe('sacar');
    expect(r.motivos[0]).toContain('25 días sin venderse');
  });

  it('el vocabulario es el nuevo: ningún veredicto dice recomprar, esperar ni no recomprar', () => {
    const casos = [
      senales({ dia: 12 }), senales({ venta_total: 0, dias_con_venta_28: 0, dias_sin_venta: null }),
      senales({ dias_sin_venta: 25 }), senales({ dias_con_venta_28: 5 }), senales(),
      senales({ dias_sin_venta: 25, plazas_con_existencia: 0 }), senales({ agotado_en: 1 }),
    ];
    for (const s of casos) expect(VEREDICTOS).toContain(recomendar(s).veredicto);
    expect(VEREDICTOS).toEqual(['se_queda', 'revisar', 'sacar', 'agotado', 'pronto']);
  });

  it('la venta cayó más de 40% contra las 4 semanas anteriores → revisar', () => {
    const r = recomendar(senales({ venta_28: 500, venta_28_previa: 2000 }));
    expect(r.veredicto).toBe('revisar');
    expect(r.motivos[0]).toContain('cayó 75%');
  });

  it('se vende pocos días → revisar', () => {
    expect(recomendar(senales({ dias_con_venta_28: 5 })).veredicto).toBe('revisar');
  });

  it('venta sostenida + agotado en una sucursal que lo vende → se queda, y la compra se manda a Productos', () => {
    const r = recomendar(senales({ agotado_en: 1, inversion_total: 10000 }));
    expect(r.veredicto).toBe('se_queda');
    expect(r.motivos.join(' ')).toContain('Se agotó en 1 sucursal');
    expect(r.motivos.join(' ')).toContain(VER_PRODUCTOS);
  });

  it('venta sostenida → se queda, haya recuperado o no (la recuperación se juzga contra la meta del corte)', () => {
    const rec = recomendar(senales({ venta_total: 2900, venta_neta: 2500, inversion_total: 3000 }));
    const no = recomendar(senales({ venta_total: 1160, venta_neta: 1000, inversion_total: 3000 }));
    expect(rec.veredicto).toBe('se_queda');
    expect(no.veredicto).toBe('se_queda');
    expect(no.motivos.join(' ')).toContain('$0.33 (sin impuestos) por cada $1 invertido');
  });

  it('⛔ sin permiso de costo la decisión no cambia, pero el motivo no dice cifras de inversión', () => {
    const con = recomendar(senales({ venta_total: 2900, venta_neta: 2500, inversion_total: 3000 }), { conCosto: true });
    const sin = recomendar(senales({ venta_total: 2900, venta_neta: 2500, inversion_total: 3000 }), { conCosto: false });
    expect(sin.veredicto).toBe(con.veredicto);
    expect(con.motivos.join(' ')).toContain('por cada $1 invertido');
    expect(sin.motivos.join(' ')).not.toMatch(/\$\d.*invertido/);
  });
});

/**
 * `[NP.21]` (D2 de David, 2026-11-03) Agotado no es «no se vende». El caso real: el SKU 28034 en la base
 * local — sin existencia en ninguna sucursal, 29 días sin venta — salía «No recomprar: lleva 29 días sin
 * venderse» mientras Productos decía «Comprar: ya no hay existencia».
 */
describe('[NP.21] sin mercancía no se juzga la venta', () => {
  it('⭐ el caso 28034: sin existencia en ninguna sucursal y 29 días sin venta → agotado, no sacar', () => {
    const r = recomendar(senales({ dia: 60, dias_sin_venta: 29, dias_con_venta_28: 0, venta_28: 0, plazas_con_existencia: 0 }));
    expect(r.veredicto).toBe('agotado');
    expect(r.motivos[0]).toBe('No hay existencia en ninguna sucursal: la venta no se puede juzgar');
    expect(r.motivos[1]).toContain('29 días sin venderse');
    expect(r.motivos).toContain(VER_PRODUCTOS);
  });

  it('[negativa] la misma falta de venta CON existencia donde se vendía sigue siendo sacar', () => {
    const r = recomendar(senales({ dia: 60, dias_sin_venta: 29, dias_con_venta_28: 0, venta_28: 0, plazas_con_existencia: 1, vendio_con_existencia: 1 }));
    expect(r.veredicto).toBe('sacar');
  });

  it('se agotó en todas las que lo vendían, aunque haya existencia en otra que nunca lo vendió → agotado', () => {
    const r = recomendar(senales({ dias_sin_venta: 40, plazas_con_existencia: 1, vendio_con_existencia: 0 }));
    expect(r.veredicto).toBe('agotado');
    expect(r.motivos[0]).toContain('todas las sucursales donde se vendía');
  });

  it('[negativa] sin la medida de dónde se vendía (ausente) no se supone agotado', () => {
    expect(recomendar(senales({ dias_sin_venta: 40, plazas_con_existencia: 1 })).veredicto).toBe('sacar');
  });

  it('una caída o poca venta con una sucursal agotada tampoco es falta de demanda', () => {
    expect(recomendar(senales({ venta_28: 500, venta_28_previa: 2000, agotado_en: 1 })).veredicto).toBe('agotado');
    expect(recomendar(senales({ dias_con_venta_28: 5, agotado_en: 2 })).veredicto).toBe('agotado');
    // [negativa] sin agotado, las dos siguen en revisar.
    expect(recomendar(senales({ venta_28: 500, venta_28_previa: 2000 })).veredicto).toBe('revisar');
  });

  it('con la existencia en duda en todas, lo dice', () => {
    const r = recomendar(senales({ dias_sin_venta: 30, plazas_con_existencia: 0, en_duda: 2 }));
    expect(r.veredicto).toBe('agotado');
    expect(r.motivos[0]).toContain('en duda en 2');
  });

  it('armarProducto: sin renglón de existencia y 29 días sin venta → agotado; con existencia donde vendía → sacar', () => {
    const dias = 60;
    const venta = [...new Array(31).fill(100), ...new Array(29).fill(0)];
    const f = fuente({ dias, venta_dia: venta, venta_por_plaza: { '03': venta } });
    const sin = armarProducto(f, HOY, [], []);
    expect(sin.fila.plazas_con_existencia).toBe(0);
    expect(sin.fila.recomendacion?.veredicto).toBe('agotado');
    expect(sin.plazas[0].recomendacion.veredicto).toBe('agotado');
    const con = armarProducto(f, HOY, [], [{ product_id: 'p1', plaza: '03', cantidad: 36, factor: 12, fuente: 'kepler', unidad: 'PZA' }]);
    expect(con.fila.recomendacion?.veredicto).toBe('sacar');
    expect(con.plazas[0].recomendacion.veredicto).toBe('sacar');
  });
});

/** `[NP.20]` La recuperación entra al juicio SÓLO contra la meta de Compras del último corte cerrado. */
describe('[NP.20] juzgarRecuperacion — la meta de Compras, nunca un número de aquí', () => {
  const queda = { veredicto: 'se_queda' as const, motivos: ['Se vendió 20 de los últimos 28 días'] };
  const hitos = (estado30: string | null, estado60: string | null = null, cerrado60 = false) => {
    const h = (cerrado: boolean, estado: string | null) => ({
      cerrado, inversion: 1, venta: 1, venta_neta: 1, venta_por_peso: 1, unidades: {},
      semaforo: estado ? { kpi_key: 'k', valor: 1, estado, escala_a: null, avance: null, motivo: estado === 'sin_meta' ? 'Sin meta registrada' : null } : null,
    });
    return { 30: h(true, estado30), 60: h(cerrado60, estado60), 90: h(false, null) } as never;
  };

  it('fuera de tolerancia en el último corte → revisar, sin cifras en el motivo', () => {
    const r = juzgarRecuperacion(queda, hitos('ok', 'bad', true))!;
    expect(r.veredicto).toBe('revisar');
    expect(r.motivos[0]).toContain('A 60 días');
    expect(r.motivos.join(' ')).not.toMatch(/\$\d/);
  });

  it('[negativa] juzga el ÚLTIMO corte cerrado: un 30 malo con un 60 en meta no cambia el veredicto', () => {
    expect(juzgarRecuperacion(queda, hitos('bad', 'ok', true))!.veredicto).toBe('se_queda');
  });

  it('debajo de la meta lo dice sin cambiar el veredicto; sin meta dice que la recuperación no entró', () => {
    expect(juzgarRecuperacion(queda, hitos('warn'))).toMatchObject({ veredicto: 'se_queda', motivos: expect.arrayContaining([expect.stringContaining('debajo de la meta')]) });
    const sm = juzgarRecuperacion(queda, hitos('sin_meta'))!;
    expect(sm.veredicto).toBe('se_queda');
    expect(sm.motivos.at(-1)).toContain('Sin meta de Compras para el corte de 30 días');
  });

  it('[negativa] sólo toca «Se queda»: un sacar o un agotado no se mueven por la meta', () => {
    const sacar = { veredicto: 'sacar' as const, motivos: ['x'] };
    expect(juzgarRecuperacion(sacar, hitos('bad'))).toBe(sacar);
    expect(juzgarRecuperacion(null, hitos('bad'))).toBeNull();
  });

  it('conHitos lo aplica: con la meta registrada y el corte fuera de tolerancia, se queda → revisar', () => {
    const u: KpiUmbral = { kpi_key: kpiHito(30), position_code: null, period: 'mes', target: 0.8, warn_at: 0.6, escalate_at: 0.4,
      direction: 'higher_is_better', escalate_to: null, source: 'prueba', manual_lock: true, auto_tuned_at: null };
    const { fila } = armarProducto(fuente({ dias: 45, entradas: [{ f: sumarDias(HOY, -45), p: '03', i: 2000000 }],
      margen_plaza: { '03': { n: 3880, nc: 0, c: 0, nm: 0, m: 0 } } }), HOY, [],
      [{ product_id: 'p1', plaza: '03', cantidad: 36, factor: 12, fuente: 'kepler', unidad: 'PZA' }]);
    expect(fila.recomendacion?.veredicto).toBe('se_queda');
    expect(conHitos(fila, [u]).recomendacion?.veredicto).toBe('revisar');
    // [negativa] sin meta registrada se queda en «se queda», y lo dice.
    const sm = conHitos(fila, []);
    expect(sm.recomendacion?.veredicto).toBe('se_queda');
    expect(sm.recomendacion?.motivos.at(-1)).toContain('Sin meta de Compras');
  });
});

describe('armarProducto — global', () => {
  it('hitos: un hito que todavía no llega no está cerrado', () => {
    const { fila } = armarProducto(fuente({ dias: 45 }), HOY, [], []);
    expect(fila.dia).toBe(45);
    // Sin `margen_plaza` la venta neta no se mide: NULL, nunca la venta con impuestos en su lugar.
    expect(fila.hitos[30]).toEqual({
      cerrado: true, inversion: 2000, venta: 3000, venta_neta: null, venta_por_peso: null, unidades: {},
      semaforo: null,
    });
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
    // [NP.20] Vendía sostenido y se agotó: el lanzamiento funcionó; la compra la dice Productos.
    expect(p03.recomendacion.veredicto).toBe('se_queda');
    expect(p03.recomendacion.motivos.join(' ')).toContain('No hay existencia en esta sucursal');
    expect(p05.existencia_unidad).toBe('PZA');
    expect(p05.existencia_duda).toBeNull();
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

describe('[NP.16] la escalera de cada plaza y la existencia en duda', () => {
  // 96087 Kinder Delice, ficha real: paquete de 10 y caja de 60 (el factor del costo trae decimales).
  const KINDER = { u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: '9.9961', f3: '59.9786', uxc: '60.00' };
  const esc = escaleraDeFicha(KINDER)!;

  it('la ficha de la plaza da su escalera, con la misma regla que /compras/pedido', () => {
    expect(esc.map((e) => `${e.rotulo}×${e.factor}`)).toEqual(['PZA×1', 'PAQ×10', 'CJA×60']);
    expect(escaleraDeFicha({})).toBeNull();
    expect(escaleraDeFicha({ u1: 'KG', u2: 'KG', u3: 'KG', uxc: 1 })!.map((e) => e.rotulo)).toEqual(['KG']);
  });

  it('la escalera del producto: la común a sus plazas, o ninguna si difieren', () => {
    const otra = escaleraDeFicha({ ...KINDER, uxc: '120.00', f3: '119.9' })!;
    expect(escaleraComun([esc, null, escaleraDeFicha(KINDER)])).toEqual(esc);
    expect(escaleraComun([esc, otra])).toBeNull();
    expect(escaleraComun([null])).toBeNull();
  });

  it('⭐ Canindo: Kepler dice -3 (agotado), pero sumó 167 paquetes como piezas: deberían ser 1,500', () => {
    const k = { u: { PAQ: { q: 167, ult: '2026-09-19' }, PZA: { q: -170, ult: '2026-10-08' } }, crudo: -3, kdil: -3 };
    expect(existenciaEnDuda(k, esc)).toEqual({ kepler: -3, estimada: 1500, base: 'PZA', otros: ['PAQ'] });
    // Morelia: 334 en Kepler, 1,918 convirtiendo los 176 paquetes netos.
    const m = { u: { PAQ: { q: 176, ult: '2026-09-19' }, PZA: { q: 158, ult: '2026-10-08' } }, crudo: 334, kdil: '334.000' };
    expect(existenciaEnDuda(m, esc)?.estimada).toBe(1918);
  });

  it('⛔ un conteo físico DESPUÉS de los renglones viejos fija la existencia: se le cree (8 Esquinas)', () => {
    const k = { u: { PAQ: { q: 30, ult: '2026-09-19' }, PZA: { q: 156, ult: '2026-10-09' } }, crudo: 186, kdil: 186, aj: '2026-09-22' };
    expect(existenciaEnDuda(k, esc)).toBeNull();
    // Un ajuste ANTERIOR no corrige nada.
    expect(existenciaEnDuda({ ...k, aj: '2026-09-01' }, esc)?.estimada).toBe(456);
  });

  it('⛔ sin renglones en otro rótulo, o si Kepler no sumó crudo, no se acusa', () => {
    expect(existenciaEnDuda({ u: { PZA: { q: 40 } }, crudo: 40, kdil: 40 }, esc)).toBeNull();
    expect(existenciaEnDuda({ u: { PAQ: { q: 4, ult: '2026-09-19' }, PZA: { q: 36 } }, crudo: 40, kdil: 76 }, esc)).toBeNull();
    expect(existenciaEnDuda({ u: { PAQ: { q: 4 }, PZA: { q: 36 } }, crudo: 40 }, esc)).toBeNull();
    expect(existenciaEnDuda({ u: { PAQ: { q: 4 } }, crudo: 4, kdil: 4 }, null)).toBeNull();
    // CAJA y CJA valen lo mismo en una ficha de cajas: no hay nada que corregir.
    const cajas = escaleraDeFicha({ u1: 'CJA', uxc: 1 });
    expect(existenciaEnDuda({ u: { CAJA: { q: 4 }, CJA: { q: 2 } }, crudo: 6, kdil: 6 }, cajas)).toBeNull();
  });

  it('un rótulo que no se puede convertir: en duda, pero sin estimada (no se inventa)', () => {
    const k = { u: { '500': { q: 3, ult: '2026-09-19' }, PZA: { q: 10 } }, crudo: 13, kdil: 13 };
    expect(existenciaEnDuda(k, esc)).toEqual({ kepler: 13, estimada: null, base: 'PZA', otros: ['500'] });
  });

  it('⭐ armarProducto: la plaza en duda NO se da por agotada, decide la estimada y se manda a contar', () => {
    const f = fuente({
      dias: 45,
      venta_por_plaza: { '03': new Array(45).fill(100), '06': new Array(45).fill(80) },
      escalera_plaza: { '03': KINDER, '06': KINDER },
      kardex_plaza: { '06': { u: { PAQ: { q: 167, ult: '2026-09-19' }, PZA: { q: -170, ult: '2026-10-06' } }, crudo: -3, kdil: -3 } },
    });
    const { fila, plazas } = armarProducto(f, HOY, [], [
      { product_id: 'p1', plaza: '03', cantidad: 60, factor: 1, fuente: 'kepler', unidad: 'PZA' },
      { product_id: 'p1', plaza: '06', cantidad: 0, factor: 1, fuente: 'kepler', unidad: 'PZA' },
    ]);
    const p06 = plazas.find((p) => p.plaza === '06')!;
    expect(p06.existencia).toBe(0);
    expect(p06.existencia_duda?.estimada).toBe(1500);
    expect(p06.escalera?.map((e) => e.rotulo)).toEqual(['PZA', 'PAQ', 'CJA']);
    expect(p06.recomendacion.motivos.join(' ')).not.toContain('Se agotó');
    expect(fila.agotado_en).toBe(0);
    expect(fila.plazas_con_existencia).toBe(2);
    expect(fila.existencia_en_duda).toBe(1);
    expect(fila.escalera?.map((e) => e.factor)).toEqual([1, 10, 60]);
    // La plaza sin duda conserva la existencia de Kepler.
    expect(plazas.find((p) => p.plaza === '03')!.existencia_duda).toBeNull();
  });

  it('[negativa] sin el kardex, la misma plaza SÍ sale agotada (lo que la pantalla decía antes)', () => {
    const f = fuente({ dias: 45, venta_por_plaza: { '06': new Array(45).fill(80) }, escalera_plaza: { '06': KINDER } });
    const { fila } = armarProducto(f, HOY, [], [{ product_id: 'p1', plaza: '06', cantidad: 0, factor: 1, fuente: 'kepler', unidad: 'PZA' }]);
    expect(fila.agotado_en).toBe(1);
    expect(fila.existencia_en_duda).toBe(0);
  });
});

describe('cohortes, resumen y costo oculto', () => {
  const filas = [
    armarProducto(fuente({ product_id: 'a', dias: 120 }), HOY, [], []).fila,
    // Con existencia donde entró: nunca vendido es «sacar» (sin existencia sería «agotado», [NP.21]).
    armarProducto(fuente({ product_id: 'b', dias: 101, venta_dia: new Array(101).fill(0), venta_por_plaza: {} }), HOY, [],
      [{ product_id: 'b', plaza: '03', cantidad: 10, factor: 1, fuente: 'kepler', unidad: 'PZA' }]).fila,
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
    expect(r.por_veredicto.sacar).toBe(1);
    expect(Object.keys(r.por_veredicto).sort()).toEqual(['agotado', 'pronto', 'revisar', 'sacar', 'se_queda']);
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

/**
 * `[NP.UI.1]` «Venta por cada $1 invertido» compara lo mismo con lo mismo: venta SIN IVA/IEPS contra
 * compra SIN impuestos. La neta de la historia es `margen_plaza.n` (la MISMA venta de la serie, sin
 * impuestos) y la de hoy, `importe_neto` de la función. Producto con IVA 16 %: neta = con impuestos / 1.16.
 */
describe('[NP.UI.1] venta por cada $1 invertido, sin impuestos de los dos lados', () => {
  // 45 días × $116 con IVA = $5,220 → $4,500 sin IVA. Invertido (sin impuestos): $3,000.
  const conIva = (over: Partial<NewProductSource> = {}) => fuente({
    dias: 45,
    venta_dia: new Array(45).fill(116),
    venta_por_plaza: { '03': new Array(45).fill(116) },
    margen_plaza: { '03': { n: 4500, nc: 0, c: 0, nm: 0, m: 0 } },
    entradas: [{ f: sumarDias(HOY, -45), p: '03', i: 3000 }],
    ...over,
  });

  it('⭐ venta neta del producto y de la plaza, y el cociente sobre ella', () => {
    const { fila, plazas } = armarProducto(conIva(), HOY, [], []);
    expect(fila.venta_total).toBe(5220);
    expect(fila.venta_neta_total).toBe(4500);
    expect(fila.venta_por_peso).toBe(1.5);
    expect(plazas[0].venta_neta_total).toBe(4500);
  });

  it('[negativa] con la regla vieja (venta con impuestos / compra sin ellos) salía 16 % arriba', () => {
    const { fila } = armarProducto(conIva(), HOY, [], []);
    const vieja = Math.round(((fila.venta_total ?? 0) / (fila.inversion_total ?? 1)) * 100) / 100;
    expect(vieja).toBe(1.74);
    expect(fila.venta_por_peso).not.toBe(vieja);
  });

  it('cada hito con su neta (factor de impuesto del producto) y su cociente', () => {
    const { fila } = armarProducto(conIva(), HOY, [], []);
    expect(fila.hitos[30].venta).toBe(3480);
    expect(fila.hitos[30].venta_neta).toBe(3000);
    expect(fila.hitos[30].venta_por_peso).toBe(1);
  });

  it('un hito sin venta e inversión medida es un cero MEDIDO, no un hueco', () => {
    const { fila } = armarProducto(conIva({ venta_dia: [...new Array(30).fill(0), ...new Array(15).fill(116)],
      venta_por_plaza: { '03': [...new Array(30).fill(0), ...new Array(15).fill(116)] },
      margen_plaza: { '03': { n: 1500, nc: 0, c: 0, nm: 0, m: 0 } } }), HOY, [], []);
    expect(fila.hitos[30].venta).toBeNull();
    expect(fila.hitos[30].venta_por_peso).toBe(0);
  });

  it('lo de hoy suma su importe NETO', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'venta', plaza: '03', fecha: HOY, importe: 116, importe_neto: 100 }];
    const { fila } = armarProducto(conIva(), HOY, vivo, []);
    expect(fila.venta_total).toBe(5336);
    expect(fila.venta_neta_total).toBe(4600);
  });

  it('⛔ un renglón de hoy sin neta, o una plaza que vendió sin neta en la historia: NO se mide', () => {
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'venta', plaza: '03', fecha: HOY, importe: 116 }];
    const a = armarProducto(conIva(), HOY, vivo, []).fila;
    expect(a.venta_neta_total).toBeNull();
    expect(a.venta_por_peso).toBeNull();
    const b = armarProducto(conIva({ margen_plaza: {} }), HOY, [], []);
    expect(b.fila.venta_neta_total).toBeNull();
    expect(b.plazas[0].venta_neta_total).toBeNull();
    // Y la recomendación NO dice cuánto recuperó (no lo inventa con la venta con impuestos).
    expect(b.fila.recomendacion?.motivos.join(' ')).not.toContain('invertido');
  });

  it('⭐ el caso del plan: recuperó $0.69 sin impuestos; con IVA se publicaba $0.80', () => {
    const base = { venta_total: 2400, inversion_total: 3000, plazas_con_existencia: 1, agotado_en: 0 };
    const hoy = recomendar(senales({ ...base, venta_neta: 2068.97 }));
    // [NP.20] La recuperación ya no dispara el veredicto (antes, con IVA, salía «Recomprar»): se informa.
    expect(hoy.veredicto).toBe('se_queda');
    expect(hoy.motivos.join(' ')).toContain('$0.69 (sin impuestos) por cada $1 invertido');
    // [negativa] con la venta CON impuestos (la regla vieja) el motivo diría $0.80.
    expect(recomendar(senales({ ...base, venta_neta: 2400 })).motivos.join(' ')).toContain('$0.80');
    expect(hoy.motivos.join(' ')).not.toContain('$0.80');
  });

  it('la cohorte: Σ neta / Σ inversión, sólo de los productos con las DOS medidas', () => {
    const filas = [
      armarProducto(conIva({ product_id: 'a' }), HOY, [], []).fila,
      armarProducto(conIva({ product_id: 'b', margen_plaza: {} }), HOY, [], []).fila,
    ];
    const r = construirResumen(filas);
    expect(r.con_inversion).toBe(1);
    expect(r.venta_neta).toBe(4500);
    expect(r.inversion).toBe(6000);
    expect(r.venta_por_peso).toBe(1.5);
  });
});

/**
 * `[NP.6]` (sin tabla, 2026-11-04) Los cortes 30 · 60 · 90 se DERIVAN de la historia: un hito cumplido es la cifra
 * definitiva de esos N días, uno que no llega va en curso. El semáforo juzga contra `analytics.kpi_thresholds` y sin
 * umbral dice «sin meta», nunca verde.
 */
describe('[NP.6] cortes derivados de la historia y su semáforo', () => {
  const conIva = (over: Partial<NewProductSource> & { dias?: number } = {}) => fuente({
    venta_dia: new Array(over.dias ?? 45).fill(116),
    venta_por_plaza: { '03': new Array(over.dias ?? 45).fill(116) },
    margen_plaza: { '03': { n: 100 * (over.dias ?? 45), nc: 0, c: 0, nm: 0, m: 0 } },
    entradas: [{ f: sumarDias(HOY, -(over.dias ?? 45)), p: '03', i: 3000 }],
    ...over,
  });
  const umbral = (n: 30 | 60 | 90, target: number, warn: number, esc: number): KpiUmbral => ({
    kpi_key: kpiHito(n), position_code: null, period: 'mes', target, warn_at: warn, escalate_at: esc,
    direction: 'higher_is_better', escalate_to: null, source: 'prueba', manual_lock: true, auto_tuned_at: null,
  });

  it('⭐ el corte cumplido es la suma de SUS N días de la historia, y no cambia con lo que pase después', () => {
    const base = armarProducto(conIva({ dias: 45 }), HOY, [], []).fila;
    expect(base.hitos[30]).toMatchObject({ cerrado: true, venta: 3480, venta_neta: 3000, inversion: 3000, venta_por_peso: 1 });
    // Vender mucho después del día 30 no mueve el corte de 30 (sí el de 60, que va en curso).
    const despues = [...new Array(30).fill(116), ...new Array(15).fill(5000)];
    const otra = armarProducto(conIva({ dias: 45, venta_dia: despues, venta_por_plaza: { '03': despues } }), HOY, [], []).fila;
    expect(otra.hitos[30].venta).toBe(3480);
    expect(otra.hitos[60].cerrado).toBe(false);
    expect(otra.hitos[60].venta).toBeGreaterThan(base.hitos[60].venta ?? 0);
  });

  it('el día 95 los tres cortes están cumplidos; el día 20 ninguno', () => {
    const viejo = armarProducto(conIva({ dias: 95 }), HOY, [], []).fila;
    expect(([30, 60, 90] as const).map((n) => viejo.hitos[n].cerrado)).toEqual([true, true, true]);
    const joven = armarProducto(conIva({ dias: 20 }), HOY, [], []).fila;
    expect(([30, 60, 90] as const).map((n) => joven.hitos[n].cerrado)).toEqual([false, false, false]);
  });

  it('semáforo: sin umbral → «sin meta» (nunca verde); sin registro → lo dice; con umbral → clasifica', () => {
    const { fila } = armarProducto(conIva(), HOY, [], []);
    const h = fila.hitos[30];
    expect(semaforoHito(h, 30, [])?.estado).toBe('sin_meta');
    expect(semaforoHito(h, 30, null)).toMatchObject({ estado: 'sin_meta', motivo: expect.stringContaining('registro de umbrales') });
    expect(semaforoHito(h, 30, [umbral(30, 1.2, 0.9, 0.5)])).toMatchObject({ estado: 'warn', valor: 1, kpi_key: kpiHito(30) });
    expect(semaforoHito(h, 30, [umbral(30, 0.8, 0.6, 0.4)])?.estado).toBe('ok');
    // [negativa] el umbral de OTRO hito no juzga a éste.
    expect(semaforoHito(h, 30, [umbral(60, 0.8, 0.6, 0.4)])?.estado).toBe('sin_meta');
    // Un hito que no ha cerrado no se juzga; uno sin cociente es «sin medir», no rojo.
    expect(semaforoHito(fila.hitos[60], 60, [umbral(60, 0.8, 0.6, 0.4)])).toBeNull();
    expect(semaforoHito({ ...h, venta_por_peso: null }, 30, [umbral(30, 0.8, 0.6, 0.4)])?.estado).toBe('sin_medir');
  });

  it('conHitos pone el semáforo en cada corte cerrado y deja en NULL el que va en curso', () => {
    const { fila } = armarProducto(conIva(), HOY, [], []);
    const h = conHitos(fila, [umbral(30, 0.8, 0.6, 0.4)]).hitos;
    expect(h[30].semaforo).toMatchObject({ estado: 'ok', valor: 1 });
    expect(h[60].semaforo).toBeNull();
  });

  it('⛔ sin permiso de costo: ni cociente, ni semáforo, ni inversión', () => {
    const { fila } = armarProducto(conIva(), HOY, [], []);
    const [oc] = ocultarCosto([conHitos(fila, [umbral(30, 0.8, 0.6, 0.4)])]);
    expect(oc.hitos[30].venta_por_peso).toBeNull();
    expect(oc.hitos[30].semaforo).toBeNull();
    expect(oc.hitos[30].inversion).toBeNull();
    expect(oc.hitos[30].venta_neta).toBe(3000);
  });
});

/**
 * `[NP.18]` (sin migración, 2026-11-04) La compra sin impuestos se calcula en el servidor con `costoSinImpuestos`:
 * una tasa negativa quiere decir que el importe trae el impuesto adentro.
 */
describe('[NP.18] la compra sin impuestos, por documento', () => {
  const R = (over: Partial<RenglonCompra> = {}): RenglonCompra => ({
    sku: 'X1', plaza: '03', fecha: '2026-08-23', folio: '100', importe: 108, iva: 0, ieps: -8, ...over,
  });
  const vacio = (): CompraNetaInfo => ({ documentos: 0, descontados: 0, sin_documento: 0, no_cuadra: 0 });

  it('⭐ la MISMA regla que el catálogo: −8 trae el IEPS adentro, +8 ya es neto, sin tasa va tal cual', () => {
    const m = compraPorDocumento([
      R(), R({ folio: '101', importe: 100, ieps: 8 }), R({ folio: '102', importe: 116, iva: -16, ieps: 0 }),
      R({ folio: '103', importe: 50, iva: null, ieps: null }),
    ]);
    expect(m.get(llaveCompra('X1', '03', '2026-08-23', '100'))).toEqual({ bruto: 108, neto: 100, descontado: true });
    expect(m.get(llaveCompra('X1', '03', '2026-08-23', '101'))).toEqual({ bruto: 100, neto: 100, descontado: false });
    expect(m.get(llaveCompra('X1', '03', '2026-08-23', '102'))).toEqual({ bruto: 116, neto: 100, descontado: true });
    expect(m.get(llaveCompra('X1', '03', '2026-08-23', '103'))).toEqual({ bruto: 50, neto: 50, descontado: false });
  });

  it('pone el neto en las entradas de la historia y de hoy; lo que no aparece o no cuadra se deja y se cuenta', () => {
    const f = fuente({ entradas: [
      { f: '2026-08-23', p: '03', folio: '100', i: 108 },
      { f: '2026-08-23', p: '03', folio: '999', i: 77 },
      { f: '2026-08-23', p: '03', folio: '101', i: 90 },
      { f: '2026-08-24', p: '03', i: 10 },
    ] });
    const vivo: Movimiento[] = [{ product_id: 'p1', tipo: 'entrada', plaza: '03', fecha: '2026-08-23', folio: '102', importe: 58 }];
    const mapa = compraPorDocumento([R(), R({ folio: '101', importe: 100, ieps: 8 }), R({ folio: '102', importe: 116, iva: -16, ieps: 0 })]);
    const info = vacio();
    const x = compraSinImpuestos(f, vivo, mapa, info);
    expect(x.fuente.entradas.map((e) => e.i)).toEqual([100, 77, 90, 10]);
    // Un renglón de hoy (la mitad del documento) se netea con la proporción del documento.
    expect(x.vivo[0].importe).toBe(50);
    expect(info).toEqual({ documentos: 2, descontados: 2, sin_documento: 2, no_cuadra: 1 });
  });

  it('[negativa] sin el mapa, ninguna entrada cambia (la inversión no se toca a ciegas)', () => {
    const f = fuente();
    const info = vacio();
    expect(compraSinImpuestos(f, [], new Map(), info).fuente.entradas).toEqual(f.entradas);
    expect(info.documentos).toBe(0);
  });

  it('⭐ armado con la compra neta, la inversión y el cociente bajan lo que traía el impuesto', () => {
    const f = fuente({ dias: 45, entradas: [{ f: sumarDias(HOY, -45), p: '03', folio: '100', i: 2160 }],
      margen_plaza: { '03': { n: 3880, nc: 0, c: 0, nm: 0, m: 0 } } });
    const mapa = compraPorDocumento([R({ fecha: sumarDias(HOY, -45), importe: 2160 })]);
    const antes = armarProducto(f, HOY, [], []).fila;
    const neta = compraSinImpuestos(f, [], mapa, vacio());
    const despues = armarProducto(neta.fuente, HOY, neta.vivo, []).fila;
    expect(antes.inversion_total).toBe(2160);
    expect(despues.inversion_total).toBe(2000);
    expect(despues.venta_por_peso).toBeGreaterThan(antes.venta_por_peso ?? 0);
  });
});
