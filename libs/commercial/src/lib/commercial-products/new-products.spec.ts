import {
  NewProductSource,
  aFila,
  construirCohortes,
  construirResumen,
  esKindValido,
  estadoDe,
  etapaDe,
  ocultarCosto,
} from './new-products';

/**
 * `[NP.2]` La lógica de Productos nuevos: etapa, estado, hitos y cohortes.
 *
 * Se prueba aquí, sin base, porque es donde se DECIDE. El smoke de DB
 * (`database/tests/test-newdb-new-products.js`) prueba que la matvista mide lo que dice.
 */

function fuente(over: Partial<NewProductSource> = {}): NewProductSource {
  return {
    product_id: '00000000-0000-0000-0000-000000000001',
    sku: 'X1',
    nombre: 'Producto',
    marca: null,
    proveedor: null,
    alta_suite: '2026-06-01',
    alta_en_lote: false,
    primera_recepcion: '2026-06-01',
    primera_venta: '2026-06-02',
    lanzamiento: '2026-06-01',
    dia: 45,
    fuentes: ['entradas', 'kepler'],
    sin_movimiento: false,
    no_medible: false,
    exclusion_auto: null,
    posible_recodificacion: false,
    inversion_30: 1000,
    inversion_60: 1500,
    inversion_90: 1500,
    inversion_total: 1500,
    entradas: 2,
    plazas_recibido: 1,
    primera_recompra: '2026-06-21',
    venta_30: 800,
    venta_60: 1400,
    venta_90: 1400,
    venta_total: 1800,
    dias_con_venta_30: 12,
    plazas_venta: 3,
    ultima_venta: '2026-07-10',
    plazas_con_existencia: 2,
    clasificacion: null,
    nota: null,
    clasificado_por: null,
    ...over,
  };
}

describe('etapaDe — en qué tramo de su seguimiento va', () => {
  it('sin lanzamiento = sin movimiento', () => {
    expect(etapaDe(null)).toBe('sin_movimiento');
  });

  it('los cortes son los días 30, 60 y 90, y el día del corte ya es el tramo siguiente', () => {
    expect(etapaDe(0)).toBe('mes_1');
    expect(etapaDe(29)).toBe('mes_1');
    expect(etapaDe(30)).toBe('mes_2');
    expect(etapaDe(59)).toBe('mes_2');
    expect(etapaDe(60)).toBe('mes_3');
    expect(etapaDe(89)).toBe('mes_3');
    expect(etapaDe(90)).toBe('graduado');
  });
});

describe('estadoDe — si cuenta para los KPIs', () => {
  it('lo normal: en seguimiento', () => {
    expect(estadoDe(fuente()).estado).toBe('seguimiento');
  });

  it('la exclusión automática lo saca (promoción, descuento, descontinuado)', () => {
    const r = estadoDe(fuente({ exclusion_auto: 'descuento' }));
    expect(r.estado).toBe('excluido');
    expect(r.motivo).toBe('Código de descuento');
  });

  it('⭐ Compras manda sobre el sistema: si dijo "nuevo", entra aunque el sistema lo excluyera', () => {
    expect(estadoDe(fuente({ exclusion_auto: 'promocion', clasificacion: 'nuevo' })).estado).toBe('seguimiento');
  });

  it('⭐ y si dijo recodificación, sale aunque el sistema no lo viera', () => {
    const r = estadoDe(fuente({ clasificacion: 'recodificacion' }));
    expect(r.estado).toBe('excluido');
    expect(r.motivo).toContain('Recodificación');
  });

  it('no medible se declara: no se cuenta como nuevo', () => {
    expect(estadoDe(fuente({ no_medible: true })).estado).toBe('no_medible');
  });

  it('sin movimiento va aparte', () => {
    expect(estadoDe(fuente({ sin_movimiento: true, lanzamiento: null, dia: null })).estado).toBe('sin_movimiento');
  });
});

describe('aFila — hitos y cifras por producto', () => {
  it('un hito que todavía no llega NO está cerrado: va en curso', () => {
    const f = aFila(fuente({ dia: 45 }));
    expect(f.hitos[30].cerrado).toBe(true);
    expect(f.hitos[60].cerrado).toBe(false);
    expect(f.hitos[90].cerrado).toBe(false);
    expect(f.hitos[30].venta).toBe(800);
  });

  it('venta por peso invertido = venta total / inversión total', () => {
    expect(aFila(fuente()).venta_por_peso).toBe(1.2);
  });

  it('⛔ inversión NO medida es NULL y el cociente también: nunca 0', () => {
    // Un producto que entró por el CEDIS cuando era Wincaja no tiene entrada en Kepler. Eso no es
    // "no costó nada": es que no se midió. Un 0 aquí daría un retorno infinito o un cero falso.
    const f = aFila(fuente({ inversion_30: null, inversion_60: null, inversion_90: null, inversion_total: null }));
    expect(f.inversion_total).toBeNull();
    expect(f.venta_por_peso).toBeNull();
    expect(f.hitos[30].inversion).toBeNull();
  });

  it('a qué día de su lanzamiento se volvió a comprar', () => {
    expect(aFila(fuente({ lanzamiento: '2026-06-01', primera_recompra: '2026-06-21' })).dia_recompra).toBe(20);
    expect(aFila(fuente({ primera_recompra: null })).dia_recompra).toBeNull();
  });

  it('sin venta a 30 días sólo aplica a quien ya cumplió 30 días', () => {
    expect(aFila(fuente({ dia: 40, venta_30: null })).sin_venta_30).toBe(true);
    expect(aFila(fuente({ dia: 40, venta_30: 0 })).sin_venta_30).toBe(true);
    expect(aFila(fuente({ dia: 12, venta_30: null })).sin_venta_30).toBe(false);
    expect(aFila(fuente({ dia: 40, venta_30: 5 })).sin_venta_30).toBe(false);
  });

  it('los numéricos de Postgres llegan como texto y se convierten', () => {
    const f = aFila(fuente({ inversion_total: '250.505' as unknown as number, venta_total: '100' as unknown as number }));
    expect(f.inversion_total).toBe(250.51);
    expect(f.venta_total).toBe(100);
  });
});

describe('cohortes y resumen', () => {
  const filas = [
    aFila(fuente({ product_id: 'a', lanzamiento: '2026-06-01', dia: 120 })),
    aFila(fuente({ product_id: 'b', lanzamiento: '2026-06-20', dia: 101, primera_recompra: null,
      venta_30: null, venta_total: 0 })),
    // Sin inversión medida: su venta NO entra al cociente.
    aFila(fuente({ product_id: 'c', lanzamiento: '2026-07-05', dia: 86, inversion_total: null, venta_total: 5000 })),
    aFila(fuente({ product_id: 'd', lanzamiento: '2026-07-10', dia: 81, exclusion_auto: 'promocion' })),
    aFila(fuente({ product_id: 'e', lanzamiento: null, dia: null, sin_movimiento: true })),
  ];

  it('agrupa sólo lanzamientos reales, por mes, el más reciente primero', () => {
    const c = construirCohortes(filas);
    expect(c.map((x) => x.mes)).toEqual(['2026-07', '2026-06']);
    expect(c[1].productos).toBe(2);
    expect(c[0].productos).toBe(1); // la promoción de julio no cuenta
  });

  it('⭐ el cociente usa el MISMO universo arriba y abajo', () => {
    const julio = construirCohortes(filas)[0];
    expect(julio.con_inversion).toBe(0);
    expect(julio.inversion).toBeNull();
    expect(julio.venta_por_peso).toBeNull(); // los $5,000 sin inversión no inventan un retorno
    expect(julio.venta).toBe(5000);
  });

  it('recompra y "sin venta a 30 días" por cohorte', () => {
    const junio = construirCohortes(filas)[1];
    expect(junio.recomprados).toBe(1);
    expect(junio.con_30_dias).toBe(2);
    expect(junio.sin_venta_30).toBe(1);
  });

  it('el resumen cuenta cada estado y deja fuera de los KPIs lo que no es lanzamiento', () => {
    const r = construirResumen(filas);
    expect(r.total).toBe(5);
    expect(r.seguimiento).toBe(3);
    expect(r.excluido).toBe(1);
    expect(r.sin_movimiento).toBe(1);
    expect(r.por_confirmar).toBe(3);
    expect(r.por_etapa.graduado).toBe(2);
  });
});

describe('ocultarCosto — sin permiso no viaja la inversión', () => {
  it('⛔ ni por producto ni sumada en la cohorte', () => {
    const filas = ocultarCosto([aFila(fuente())]);
    expect(filas[0].inversion_total).toBeNull();
    expect(filas[0].venta_por_peso).toBeNull();
    expect(filas[0].hitos[30].inversion).toBeNull();
    // La venta sí: no es dato de costo.
    expect(filas[0].venta_total).toBe(1800);
    const cohorte = construirCohortes(filas)[0];
    expect(cohorte.inversion).toBeNull();
    expect(cohorte.venta_por_peso).toBeNull();
  });
});

describe('esKindValido', () => {
  it('acepta las cuatro clasificaciones y nada más', () => {
    expect(esKindValido('nuevo')).toBe(true);
    expect(esKindValido('no_mercancia')).toBe(true);
    expect(esKindValido('otro')).toBe(false);
    expect(esKindValido(null)).toBe(false);
  });
});
