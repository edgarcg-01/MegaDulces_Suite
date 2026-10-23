import { armarRenglon, surteDe, type EntradaRenglon, type EscaleraUnidades, type AutoabastoPedidoLinea } from './autoabasto-pedido.contract';
import { filtrarRenglones, ordenarRenglones, resumirRenglones, cantidadEfectiva } from './autoabasto-mesa.contract';

/**
 * `[AB.27]` CANDADO de la mesa sobre la cuenta única. Los renglones se arman con `armarRenglon`, igual
 * que en el servidor: esta prueba no inventa renglones a mano que la cuenta real no pueda producir.
 *
 * Prueba negativa hecha al escribirla (2026-10-23): quitando el `if (cantidadEfectiva(r) > 0)` del
 * resumen se ponen en rojo «CONTROL» y «por a quién se le pide» (cuentan como pendiente de valuar lo
 * que no lleva nada). «El total es el de los grupos» NO cae con esa mutación: un renglón que no lleva
 * nada ya sale con `valor: null` de `armarRenglon`, así que no suma pesos de más.
 */
const cajaDe12: EscaleraUnidades = { unit_base: 'PZA', u2_label: 'CJA', u3_label: null, f2: 12, f3: null, is_weight: false };
const base: EntradaRenglon = {
  product_id: 'p', sku: '0', nombre: '', venta_30d: 10, existencia: 1, objetivo: 3, falta: 2, falta_base: 24,
  caja_factor: 12, costo_base: 1.5, rung_veredicto: null, posicion: 'bajo_minimo', viene: null, planeado_compras: 0,
  escalera: cajaDe12, ajuste: null, surte: surteDe('transfer', '01', 'prov-1', 'DULCES SA'),
};
const renglon = (p: Partial<EntradaRenglon>): AutoabastoPedidoLinea => armarRenglon({ ...base, ...p }).linea;

// Cuatro renglones, uno por estado, y uno sin valor (peldaño contradicho).
const sinPedir = renglon({ product_id: 'a', sku: '100', nombre: 'MAZAPÁN', falta_base: 36, falta: 3 });               // 3 cajas · $54
const planeado = renglon({ product_id: 'b', sku: '200', nombre: 'CHICLE', planeado_compras: 1, surte: surteDe('purchase', null, 'prov-2', 'GOMAS SA') }); // 2 cajas · $36
const yaViene = renglon({ product_id: 'c', sku: '300', nombre: 'PALETA', viene: { ya: 24, atorado: 0, negado: 0, camino: 0 } });     // 0 · null
const sinValor = renglon({ product_id: 'd', sku: '400', nombre: 'CACAHUATE', rung_veredicto: 'x1_inflada' });       // 2 cajas · sin valor
const todos = [yaViene, sinValor, planeado, sinPedir];

describe('[AB.27] resumirRenglones — la misma suma que los grupos de «Mi pedido»', () => {
  it('CONTROL: cuenta los estados y suma sólo lo que lleva algo', () => {
    const r = resumirRenglones(todos);
    expect(r.renglones).toBe(4);
    expect(r.por_estado).toEqual({ sin_pedir: 2, compras_lo_planeo: 1, ya_viene: 1, en_politica: 0 });
    expect(r.valor_a_pedir).toBe(90);   // 54 + 36; «ya viene» no lleva nada y «sin valor» no se suma
    expect(r.sin_valuar).toBe(1);
  });

  it('el total es el de los grupos de «Mi pedido»: Σ valor de los renglones con cantidad > 0', () => {
    const grupos = todos.filter((l) => cantidadEfectiva(l) > 0 && l.valor != null).reduce((s, l) => s + (l.valor as number), 0);
    expect(resumirRenglones(todos).valor_a_pedir).toBe(grupos);
  });

  it('por a quién se le pide, con lo que no se pudo valuar aparte', () => {
    const r = resumirRenglones(todos);
    expect(r.por_surte.matriz).toEqual({ renglones: 3, a_pedir: 2, valor: 54, sin_valuar: 1 });
    expect(r.por_surte.proveedor).toEqual({ renglones: 1, a_pedir: 1, valor: 36, sin_valuar: 0 });
    expect(r.por_surte.sin_ruta).toEqual({ renglones: 0, a_pedir: 0, valor: null, sin_valuar: 0 });
  });

  it('⛔ si nada se pudo valuar, el total es null, nunca $0', () => {
    const r = resumirRenglones([sinValor]);
    expect(r.valor_a_pedir).toBeNull();
    expect(r.sin_valuar).toBe(1);
  });

  it('el ajuste guardado manda: un renglón llevado a 0 deja de sumar', () => {
    const ajustado = armarRenglon({ ...base, product_id: 'e', sku: '500', ajuste: {
      cantidad: 0, unidad: 'CJA', motivo: 'producto_lento', ajustado_por: 'ana', ajustado_at: '2026-10-23T10:00:00.000Z', cantidad_base: 0,
    } }).linea;
    expect(cantidadEfectiva(ajustado)).toBe(0);
    expect(resumirRenglones([ajustado]).valor_a_pedir).toBeNull();
  });
});

describe('[AB.27] filtrarRenglones', () => {
  it('por estado, posición y a quién se le pide', () => {
    expect(filtrarRenglones(todos, { estado: 'ya_viene' }).map((r) => r.sku)).toEqual(['300']);
    expect(filtrarRenglones(todos, { surte: 'proveedor' }).map((r) => r.sku)).toEqual(['200']);
    expect(filtrarRenglones(todos, { posicion: 'agotado' })).toEqual([]);
  });
  it('la búsqueda no distingue mayúsculas ni acentos', () => {
    expect(filtrarRenglones(todos, { search: 'mazapan' }).map((r) => r.sku)).toEqual(['100']);
    expect(filtrarRenglones(todos, { search: '40' }).map((r) => r.sku)).toEqual(['400']);
  });
  it('sin filtro devuelve todo', () => {
    expect(filtrarRenglones(todos, {})).toHaveLength(4);
  });
});

describe('[AB.27] ordenarRenglones', () => {
  it('orden de lectura: nadie lo ha pedido primero, por valor; después planeado y ya viene', () => {
    expect(ordenarRenglones(todos).map((r) => r.sku)).toEqual(['100', '400', '200', '300']);
  });
  it('⛔ sin valor va al final en las dos direcciones (no es «el más barato»)', () => {
    // «ya viene» (300) y «sin valor» (400) no tienen valor: los dos al final, empatados por SKU.
    expect(ordenarRenglones(todos, 'valor', 'asc').map((r) => r.sku)).toEqual(['200', '100', '300', '400']);
    expect(ordenarRenglones(todos, 'valor', 'desc').map((r) => r.sku)).toEqual(['100', '200', '300', '400']);
  });
  it('un empate se rompe por SKU: la página 2 no repite ni salta renglones', () => {
    const a = renglon({ product_id: 'x', sku: '900' });
    const b = renglon({ product_id: 'y', sku: '800' });
    expect(ordenarRenglones([a, b], 'falta_neta').map((r) => r.sku)).toEqual(['800', '900']);
  });
});
