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
  ordenValido,
  ordenarDetallado,
  pasa,
  ventaMesDeProductos,
  type FilaUniverso,
  type Medido,
} from './catalogo-detallado';
import { juntarPlaza, juzgarPlaza, periodos, resumirProducto, type HistoriaPlaza, type VentaVivo } from './product-flow';
import { SIN_PROVEEDOR_EXPR, COMPRAS_VENTANA_SQL } from './catalogo-detallado.sql';

const P = periodos('2026-10-26');

const hist = (product_id: string, plaza: string, mes: number, ant: number): HistoriaPlaza => ({
  product_id, plaza, mes, mes_anterior_mismo: ant, mes_anterior_total: ant * 1.2, monto30: mes, unidades30: 10, ultima: '2026-10-24',
});
const vivo = (sku: string, plaza: string, fecha: string, monto: number): VentaVivo => ({ sku, plaza, fecha, monto, unidades: 1 });

const fila = (id: string, over: Partial<FilaUniverso> = {}): FilaUniverso => ({
  id, sku: id.toUpperCase(), nombre: 'PRODUCTO ' + id, description: null, barcode: null, proveedor_id: 's', proveedor: 'PROV',
  n_codigos: 1, sin_precio: false, sin_proveedor: false, ...over,
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
    const m = MEDIDO({ veredicto: new Map([['a', 'comprar'], ['b', 'traspasar'], ['c', 'comprar']]), nuevos: new Map([['b', 'Nuevo · día 3']]) });
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
});

describe('Ficha › compras de 90 días', () => {
  it('documentos distintos, lo comprado por unidad, la primera y la última; el costo sólo con permiso', () => {
    const filas = [{ docs: '21', unidad: 'PAQ', cantidad: '11800', primera: '2026-07-30' }, { docs: '21', unidad: 'CJA', cantidad: '3', primera: '2026-08-02' }];
    const ultima = { sucursal: '08', fecha: '2026-10-08', unidad: 'PAQ', cantidad: '1600', costo: '42.5' };
    const con = armarCompras90('2026-07-29', 90, filas, ultima, 'Morelia Abastos', true);
    expect(con).toMatchObject({ entradas: 21, primera: '2026-07-30', comprado: [{ unidad: 'PAQ', cantidad: 11800 }, { unidad: 'CJA', cantidad: 3 }] });
    expect(con.ultima).toMatchObject({ costo: 42.5, nombreSucursal: 'Morelia Abastos' });
    expect(armarCompras90('2026-07-29', 90, filas, ultima, null, false).ultima?.costo).toBeNull();
  });

  it('[negativa] sin compras: cero entradas declaradas, sin primera y sin última (no se inventa)', () => {
    expect(armarCompras90('2026-07-29', 90, [], null, null, true)).toMatchObject({ entradas: 0, comprado: [], primera: null, ultima: null });
  });
});

describe('Detallado › SQL', () => {
  it('«sin proveedor» usa la regla del comodín de PF; las compras no meten «?» en una regex', () => {
    expect(SIN_PROVEEDOR_EXPR).toContain("'PRODUCTOS SIN PROVEEDOR%'");
    expect((COMPRAS_VENTANA_SQL.match(/\?/g) ?? []).length).toBe(2);
  });
});
