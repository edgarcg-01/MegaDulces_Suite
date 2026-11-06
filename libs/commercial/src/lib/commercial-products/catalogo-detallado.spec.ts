import {
  TOPE_VEREDICTO,
  armarCompras90,
  contarDetallado,
  cuidadoDe,
  direccionValida,
  etiquetaCaducidad,
  etiquetaNuevo,
  filaDetallada,
  filtroDetalladoValido,
  notaNoSeVenden,
  ordenValido,
  ordenarDetallado,
  pasa,
  ventaMesDeProductos,
  SUBFILTROS_LANZAMIENTO,
  contarLanzamiento,
  lanzamientoDe,
  pasaLanzamiento,
  subfiltroValido,
  type FilaUniverso,
  type Lanzamiento,
  type Medido,
} from './catalogo-detallado';
import { juntarPlaza, juzgarPlaza, periodos, resumirProducto, type HistoriaPlaza, type VentaVivo } from './product-flow';
import { SIN_PROVEEDOR_EXPR, COMPRAS_VENTANA_SQL } from './catalogo-detallado.sql';
import { ENTRADAS_XA20 } from './catalogo-ficha.sql';
import { costoSinImpuestos } from './catalogo-ficha';

const P = periodos('2026-10-26');

const hist = (product_id: string, plaza: string, mes: number, ant: number): HistoriaPlaza => ({
  product_id, plaza, mes, mes_anterior_mismo: ant, mes_anterior_total: ant * 1.2, monto30: mes, unidades30: 10, ultima: '2026-10-24',
});
const vivo = (sku: string, plaza: string, fecha: string, monto: number): VentaVivo => ({ sku, plaza, fecha, monto, unidades: 1 });

const fila = (id: string, over: Partial<FilaUniverso> = {}): FilaUniverso => ({
  id, sku: id.toUpperCase(), nombre: 'PRODUCTO ' + id, description: null, barcode: null, proveedor_id: 's', proveedor: 'PROV',
  n_codigos: 1, sin_precio: false, sin_proveedor: false, ...over,
});

/** `[NP.22]` Un renglón de Productos nuevos como lo deja `lanzamientoDe`. */
const LZ = (over: Partial<Lanzamiento> = {}): Lanzamiento => ({
  estado: 'seguimiento', etapa: 'mes_1', dia: 12, veredicto: 'se_queda', motivo: 'Se vendió 20 de los últimos 28 días',
  posible_recodificacion: false, sin_venta_30: false, orden: 0, etiqueta: 'Nuevo · día 12', ...over,
});

const MEDIDO = (over: Partial<Medido> = {}): Medido => ({
  conPrecio: true, venta: new Map(), cuidado: null, nuevos: new Map(), veredicto: new Map(), veredictoNota: null, ...over,
});

describe('Detallado › «Este mes»: la misma suma que el motor PF', () => {
  it('⭐ cruzado contra resumirProducto: historia + en vivo, por sucursal, da el mismo mes, anterior y variación', () => {
    const h = [hist('a', '01', 1000, 800), hist('a', '02', 500, 0)];
    const v = [vivo('A', '01', '2026-10-26', 120), vivo('A', '03', '2026-10-26', 30)];
    const mapa = ventaMesDeProductos(P, h, v, new Map([['a', 'A']]));
    // La otra implementación: el motor juzga cada sucursal y resume el producto.
    const plazas = ['01', '02', '03'].map((pl) => juzgarPlaza(P, {
      plaza: pl, nombre: null, ...juntarPlaza(P, h.find((x) => x.plaza === pl), v.filter((x) => x.plaza === pl)),
      existencia: 10, duda: null, escalera: null, costo: null,
    }));
    const r = resumirProducto('a', P, plazas.filter((x) => x.estado !== 'sin_movimiento'));
    expect(mapa.get('a')).toEqual({ mes: r.mes, ant: r.mes_anterior_mismo, variacion: r.variacion });
    expect(mapa.get('a')).toEqual({ mes: 1650, ant: 800, variacion: 1.06 });
  });

  it('[negativa] lo en vivo de OTRO sku no se suma; sin venta, el producto no aparece (y el renglón lo pinta como 0 medido)', () => {
    const mapa = ventaMesDeProductos(P, [], [vivo('OTRO', '01', '2026-10-26', 999)], new Map([['a', 'A']]));
    expect(mapa.has('a')).toBe(false);
    const f = filaDetallada({ id: 'a', sku: 'A', nombre: 'X', proveedor: null, unidades: [], razon: null, nCodigos: 0 }, MEDIDO({ venta: mapa }));
    expect(f).toMatchObject({ mes: 0, mesAnterior: 0, variacion: null });
  });

  it('⛔ si la venta no se pudo medir, el renglón dice null (sin dato), nunca 0', () => {
    const f = filaDetallada({ id: 'a', sku: 'A', nombre: 'X', proveedor: null, unidades: [], razon: null, nCodigos: 0 }, MEDIDO({ venta: null }));
    expect(f).toMatchObject({ mes: null, mesAnterior: null, variacion: null });
  });
});

describe('Detallado › etiquetas', () => {
  it('caducidad: lo caducado gana; no alcanza o caduca pronto = «pronto»; a tiempo, nada', () => {
    const c = { vencido: 0, en_riesgo: 0, por_caducar: 0, proxima: null, plazas_vencido: [], plazas_en_riesgo: [], lotes: 1 };
    expect(etiquetaCaducidad({ ...c, vencido: 3, en_riesgo: 2 })).toBe('caducado');
    expect(etiquetaCaducidad({ ...c, en_riesgo: 2 })).toBe('pronto');
    expect(etiquetaCaducidad({ ...c, por_caducar: 1 })).toBe('pronto');
    expect(etiquetaCaducidad(c)).toBeNull();
    expect(etiquetaCaducidad(null)).toBeNull();
  });

  it('nuevo: en seguimiento con día, o sin movimiento; [negativa] graduado o excluido no', () => {
    expect(etiquetaNuevo({ estado: 'seguimiento', etapa: 'mes_1', dia: 12 })).toBe('Nuevo · día 12');
    expect(etiquetaNuevo({ estado: 'sin_movimiento', etapa: 'sin_movimiento', dia: null })).toBe('Nuevo · sin movimiento');
    expect(etiquetaNuevo({ estado: 'seguimiento', etapa: 'graduado', dia: 120 })).toBeNull();
    expect(etiquetaNuevo({ estado: 'excluido', etapa: 'mes_2', dia: 40 })).toBeNull();
  });

  it('«Para cuidar hoy»: líderes con su lugar, pendientes sólo con motivo, no se venden y caducidad', () => {
    const c = cuidadoDe({
      lideres: { lista: [
        { motivos: ['agotado'], resumen: { product_id: 'a', lider: { rank: 3 } } },
        { motivos: [], resumen: { product_id: 'b', lider: { rank: 9 } } },
      ] },
      no_se_venden: { total: 969, productos: [{ product_id: 'n' }] },
      caducidad: { productos: [{ resumen: { product_id: 'c', caducidad: { vencido: 1, en_riesgo: 0, por_caducar: 0, proxima: null, plazas_vencido: [], plazas_en_riesgo: [], lotes: 1 } } }] },
    });
    expect([...c.lideres]).toEqual([['a', 3], ['b', 9]]);
    expect([...c.lideresPendiente]).toEqual(['a']);
    expect(c.noSeVendenTotal).toBe(969);
    expect(c.caducidad.get('c')).toBe('caducado');
  });
});

describe('Detallado › «Mostrar»: filtra y cuenta en el servidor; lo no medido se declara', () => {
  const U = [
    fila('a', { n_codigos: 2 }), fila('b', { n_codigos: 0, sin_proveedor: true, proveedor_id: null }), fila('c', { sin_precio: true }),
  ];

  it('⭐ cuenta cada opción sobre la búsqueda entera', () => {
    const m = MEDIDO({
      veredicto: new Map([['a', 'comprar'], ['b', 'traspasar'], ['c', 'comprar']]),
      // [NP.22] «nuevos» cuenta los EN SEGUIMIENTO: el sin movimiento (c) no entra.
      nuevos: new Map([['b', LZ({ etiqueta: 'Nuevo · día 3' })], ['c', LZ({ estado: 'sin_movimiento', veredicto: null })]]),
    });
    const { conteos } = contarDetallado(U, m);
    expect(conteos).toMatchObject({ todos: 3, varios_codigos: 1, sin_codigo: 1, sin_precio: 1, sin_proveedor: 1, comprar: 2, traspasar: 1, esperar: 0, nuevos: 1 });
  });

  it('⛔ sin veredicto (búsqueda grande), sin «Para cuidar hoy» o sin precio por sucursal: null con su porqué, nunca 0', () => {
    const { conteos, notas } = contarDetallado(U, MEDIDO({ conPrecio: false, cuidado: null, nuevos: null, veredicto: null, veredictoNota: 'Busca un proveedor' }));
    for (const f of ['comprar', 'traspasar', 'esperar', 'sobra', 'no_comprar', 'lideres_pendiente', 'no_se_venden', 'caducidad', 'nuevos', 'sin_precio'] as const) {
      expect(conteos[f]).toBeNull();
      expect(notas[f]).toBeTruthy();
    }
    expect(notas.comprar).toBe('Busca un proveedor');
    expect(conteos.todos).toBe(3);
  });

  it('[negativa] un filtro no medido no deja pasar a nadie como si cumpliera', () => {
    expect(pasa(U[0], 'comprar', MEDIDO({ veredicto: null }))).toBeNull();
    expect(pasa(U[0], 'comprar', MEDIDO({ veredicto: new Map([['a', 'esperar']]) }))).toBe(false);
  });

  it('«No se venden» declara que la lista trae sólo los de más dinero detenido', () => {
    const cuidado = cuidadoDe({ lideres: { lista: [] }, no_se_venden: { total: 969, productos: [{ product_id: 'a' }] }, caducidad: { productos: [] } });
    const { conteos, notas } = contarDetallado(U, MEDIDO({ cuidado }));
    expect(conteos.no_se_venden).toBe(1);
    expect(notas.no_se_venden).toBe('Los 1 de más dinero detenido, de 969 en la red');
  });

  it('[PF.UI.3] la nota dice el dinero a costo, si el total es un mínimo y cuántos salen por camioneta', () => {
    const cuidado = cuidadoDe({ lideres: { lista: [] }, caducidad: { productos: [] },
      no_se_venden: { total: 1200, productos: [{ product_id: 'a' }], valor_total: 1234567.4, total_es_minimo: true, por_camioneta: 12 } });
    expect(contarDetallado(U, MEDIDO({ cuidado })).notas.no_se_venden)
      .toBe('Los 1 de más dinero detenido, de 1,200 o más en la red ($1,234,567 a costo); fuera 12 que salen por camioneta');
    // Sin permiso de costo el servidor manda valor_total null: no se dice dinero (ni un $0).
    const sinCosto = cuidadoDe({ lideres: { lista: [] }, caducidad: { productos: [] },
      no_se_venden: { total: 969, productos: [{ product_id: 'a' }], valor_total: null, por_camioneta: 1 } });
    expect(notaNoSeVenden(sinCosto)).toBe('Los 1 de más dinero detenido, de 969 en la red; fuera 1 que sale por camioneta');
    // [negativa] lista completa, sin tope, sin dinero y sin camioneta: no hay nada que aclarar.
    const completa = cuidadoDe({ lideres: { lista: [] }, caducidad: { productos: [] }, no_se_venden: { total: 1, productos: [{ product_id: 'a' }] } });
    expect(notaNoSeVenden(completa)).toBeNull();
    // Un servidor previo (sin los campos nuevos) da la nota de antes.
    expect(completa.noSeVendenValor).toBeNull();
    expect(completa.noSeVendenMinimo).toBe(false);
    expect(completa.noSeVendenCamioneta).toBe(0);
  });

  it('valida lo que llega por la URL: lo desconocido es «todos»; el orden default es venta del mes de mayor a menor', () => {
    expect(filtroDetalladoValido('comprar')).toBe('comprar');
    expect(filtroDetalladoValido('DROP TABLE')).toBe('todos');
    expect(ordenValido(undefined)).toBe('mes');
    expect(direccionValida(undefined, 'mes')).toBe('desc');
    expect(direccionValida(undefined, 'producto')).toBe('asc');
    expect(direccionValida('asc', 'mes')).toBe('asc');
    expect(TOPE_VEREDICTO).toBe(200);
  });
});

describe('Detallado › orden por columna', () => {
  const U = [fila('a', { nombre: 'ÑOÑO' }), fila('b', { nombre: 'ABEJA' }), fila('c', { nombre: 'ZETA' })];
  const venta = new Map([['a', { mes: 10, ant: 0, variacion: null }], ['c', { mes: 500, ant: 0, variacion: null }]]);

  it('por venta del mes (sin venta = 0), con empate por nombre; y al revés', () => {
    expect(ordenarDetallado(U, 'mes', 'desc', venta).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(ordenarDetallado(U, 'mes', 'asc', venta).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('por nombre en español (la Ñ después de la N)', () => {
    expect(ordenarDetallado(U, 'producto', 'asc', venta).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('[negativa] sin venta medida no se ordena por venta: cae a nombre', () => {
    expect(ordenarDetallado(U, 'mes', 'asc', null).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('[NP.22] por lanzamiento: el orden de Productos nuevos (lo que pide atención primero); lo que no es nuevo, al final', () => {
    const nuevos = new Map([['c', LZ({ orden: 0 })], ['a', LZ({ orden: 1 })]]);
    expect(ordenarDetallado(U, 'lanzamiento', 'asc', venta, nuevos).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    // [negativa] sin la foto de Productos nuevos no se inventa un orden: cae a nombre.
    expect(ordenarDetallado(U, 'lanzamiento', 'asc', venta, null).map((x) => x.id)).toEqual(['b', 'a', 'c']);
    expect(ordenValido('lanzamiento')).toBe('lanzamiento');
    expect(direccionValida(null, 'lanzamiento')).toBe('asc');
  });
});

describe('[NP.22] Detallado › «Productos nuevos» partido por el resultado del lanzamiento', () => {
  const U = ['a', 'b', 'c', 'd', 'e', 'f', 'z'].map((id) => fila(id));
  const nuevos = new Map<string, Lanzamiento>([
    ['a', LZ({ veredicto: 'sacar' })],
    ['b', LZ({ veredicto: 'agotado', sin_venta_30: true })],
    ['c', LZ({ veredicto: 'se_queda' })],
    ['d', LZ({ estado: 'sin_movimiento', veredicto: null, dia: null })],
    ['e', LZ({ estado: 'excluido', veredicto: null })],
    ['f', LZ({ estado: 'no_medible', veredicto: null })],
  ]);

  it('⭐ los sub-filtros son los de la pantalla vieja, con su mismo significado', () => {
    const de = (s: Parameters<typeof pasaLanzamiento>[1]) => U.filter((f) => pasaLanzamiento(nuevos.get(f.id), s)).map((f) => f.id);
    expect(de('seguimiento')).toEqual(['a', 'b', 'c']);
    expect(de('sacar')).toEqual(['a']);
    expect(de('agotado')).toEqual(['b']);
    expect(de('sin_venta_30')).toEqual(['b']);
    expect(de('sin_movimiento')).toEqual(['d']);
    expect(de('excluido')).toEqual(['e']);
    expect(de('no_medible')).toEqual(['f']);
    // [negativa] un producto que no es nuevo (z) no entra en ninguno.
    for (const s of SUBFILTROS_LANZAMIENTO) expect(pasaLanzamiento(nuevos.get('z'), s)).toBe(false);
  });

  it('⭐ cuenta cada sub-filtro sobre la búsqueda entera, y «nuevos» de Mostrar es el mismo número que «seguimiento»', () => {
    const c = contarLanzamiento(U, nuevos);
    expect(c).toEqual({ seguimiento: 3, sacar: 1, revisar: 0, agotado: 1, se_queda: 1, pronto: 0, sin_venta_30: 1, sin_movimiento: 1, no_medible: 1, excluido: 1 });
    expect(contarDetallado(U, MEDIDO({ nuevos })).conteos.nuevos).toBe(c.seguimiento);
    // Una búsqueda que deja fuera a «a» lo deja fuera de los conteos.
    expect(contarLanzamiento(U.filter((f) => f.id !== 'a'), nuevos).sacar).toBe(0);
  });

  it('un sub-filtro desconocido cae a «seguimiento» (el universo del resumen), no a «todos»', () => {
    expect(subfiltroValido('sacar')).toBe('sacar');
    expect(subfiltroValido('recomprar')).toBe('seguimiento');
    expect(subfiltroValido(null)).toBe('seguimiento');
  });

  it('del renglón de Productos nuevos: el resultado sólo en seguimiento, el primer motivo y la recodificación sin clasificar', () => {
    const base = {
      estado: 'seguimiento' as const, etapa: 'graduado' as const, dia: 120, motivo: null, posible_recodificacion: true, clasificacion: null,
      sin_venta_30: false, recomendacion: { veredicto: 'sacar' as const, motivos: ['Lleva 30 días sin venderse', 'otro'] },
    };
    expect(lanzamientoDe(base, 4)).toEqual({
      estado: 'seguimiento', etapa: 'graduado', dia: 120, veredicto: 'sacar', motivo: 'Lleva 30 días sin venderse',
      posible_recodificacion: true, sin_venta_30: false, orden: 4, etiqueta: null,
    });
    // Ya clasificada: deja de ser «posible recodificación».
    expect(lanzamientoDe({ ...base, clasificacion: 'nuevo' }, 0).posible_recodificacion).toBe(false);
    // Fuera de seguimiento no hay resultado: el motivo es por qué no se sigue.
    const sm = lanzamientoDe({ ...base, estado: 'sin_movimiento', etapa: 'sin_movimiento', dia: null, motivo: 'Dado de alta, sin movimiento' }, 1);
    expect(sm).toMatchObject({ veredicto: null, motivo: 'Dado de alta, sin movimiento', etiqueta: 'Nuevo · sin movimiento' });
  });

  it('el renglón trae su lanzamiento y la etiqueta de siempre; [negativa] un producto que no es nuevo, null', () => {
    const b = { id: 'a', sku: 'A', nombre: 'X', proveedor: null, unidades: [], razon: null, nCodigos: 0 };
    expect(filaDetallada(b, MEDIDO({ nuevos }))).toMatchObject({ nuevo: 'Nuevo · día 12', lanzamiento: { veredicto: 'sacar' } });
    expect(filaDetallada({ ...b, id: 'z' }, MEDIDO({ nuevos }))).toMatchObject({ nuevo: null, lanzamiento: null });
  });
});

describe('Ficha › compras de 90 días', () => {
  it('documentos distintos, lo comprado por unidad, la primera y la última; el costo sólo si se ve', () => {
    const filas = [{ docs: '21', unidad: 'PAQ', cantidad: '11800', primera: '2026-07-30' }, { docs: '21', unidad: 'CJA', cantidad: '3', primera: '2026-08-02' }];
    const ultima = { sucursal: '08', fecha: '2026-10-08', unidad: 'PAQ', cantidad: '1600', costo: '42.5', iva: '0', ieps: '8' };
    const con = armarCompras90('2026-07-29', 90, filas, ultima, 'Morelia Abastos', true);
    expect(con).toMatchObject({ entradas: 21, primera: '2026-07-30', comprado: [{ unidad: 'PAQ', cantidad: 11800 }, { unidad: 'CJA', cantidad: 3 }] });
    expect(con.ultima).toMatchObject({ costo: 42.5, nombreSucursal: 'Morelia Abastos', impuesto: 'neto' });
    expect(armarCompras90('2026-07-29', 90, filas, ultima, null, false).ultima?.costo).toBeNull();
  });

  it('⭐ [PF.12.3] el costo de la última va SIN impuestos, con la misma regla que Sencillo (`costoSinImpuestos`)', () => {
    // 63018: 56.8944 con IEPS −8 (incluido) = 52.68 sin IEPS; el mismo número que la columna del catálogo.
    const incluido = { sucursal: '00', fecha: '2026-06-25', unidad: 'PAQ', cantidad: '6', costo: '56.8944', iva: '0', ieps: '-8' };
    const r = armarCompras90('2026-07-29', 90, [], incluido, null, true).ultima!;
    expect(r).toMatchObject({ costo: 52.68, impuesto: 'descontado', unidad: 'PAQ' });
    expect(r.costo).toBe(costoSinImpuestos(incluido.costo, incluido.iva, incluido.ieps).costo);
    // ⛔ [negativa] sin tasa: va tal cual y se declara; costo 0 no es costo.
    expect(armarCompras90('2026-07-29', 90, [], { ...incluido, iva: null, ieps: null }, null, true).ultima).toMatchObject({ costo: 56.8944, impuesto: 'sin_dato' });
    expect(armarCompras90('2026-07-29', 90, [], { ...incluido, costo: '0' }, null, true).ultima?.costo).toBeNull();
  });

  it('[negativa] sin compras: cero entradas declaradas, sin primera y sin última (no se inventa)', () => {
    expect(armarCompras90('2026-07-29', 90, [], null, null, true)).toMatchObject({ entradas: 0, comprado: [], primera: null, ultima: null });
  });
});

describe('Detallado › SQL', () => {
  it('«sin proveedor» usa la regla del comodín de PF; las compras no meten «?» en una regex', () => {
    expect(SIN_PROVEEDOR_EXPR).toContain("'PRODUCTOS SIN PROVEEDOR%'");
    // [PF.23] sku, desde y hasta: el periodo se acota por los dos lados.
    expect((COMPRAS_VENTANA_SQL.match(/\?/g) ?? []).length).toBe(3);
    expect(COMPRAS_VENTANA_SQL).toContain('BETWEEN ?::date AND ?::date');
  });

  it('[PF.12.3] las compras de 90 días usan la MISMA definición de entrada XA20 que la última entrada (no una copia)', () => {
    expect(COMPRAS_VENTANA_SQL).toContain(ENTRADAS_XA20('btrim(l.c8) = ?'));
  });
});
