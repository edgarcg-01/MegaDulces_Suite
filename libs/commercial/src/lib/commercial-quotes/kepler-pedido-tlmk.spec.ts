/**
 * `[COT.7.1]` La cotización en las columnas del Pedido Telemarketing de Kepler.
 *
 * Control con respuesta conocida: el pedido TELEMARK real 01/`0003710` (cliente C1088, 2 % de
 * descuento, 3 renglones en CJA), tal como está en `kepler_ods` el 2026-11-03. Se le da a la
 * función lo que la cotización habría guardado para esos renglones y tiene que devolver lo que
 * Kepler guardó: `c16` 10,154.17 · `c15` 752.16 · `c14` 0 · `c13` 191.88.
 */
import { armarPedidoTlmk, renglonesObservaciones, type FichaTlmk, type RenglonCotizacion } from './kepler-pedido-tlmk';

const ficha = (nombre: string, unidad: string, factor: number, costo = 10): FichaTlmk =>
  ({ nombre, unidad_base: unidad, iva: 0, ieps: -8, costo_base: costo, factor_presentacion: factor });

const FICHAS = new Map<string, FichaTlmk>([
  ['29014', ficha('PRODUCTO 29014', 'PAQ', 8)],
  ['53205', ficha('PRODUCTO 53205', 'PAQ', 12)],
  ['14011', ficha('PRODUCTO 14011', '500', 20)],
]);

// unit_price = c12 × c58 (la base a centavos × factor), line_total = c13, list_price = c66 × c58.
const PEDIDO_3710: RenglonCotizacion[] = [
  { sku: '29014', cantidad: 5, presentacion: 'CJA', factor: 8, precio: 718.4, lista: 731.34, importe: 3592.0 },
  { sku: '53205', cantidad: 5, presentacion: 'CJA', factor: 12, precio: 845.4, lista: 853.09, importe: 4227.0 },
  { sku: '14011', cantidad: 4, presentacion: 'CJA', factor: 20, precio: 635.6, lista: 694.7, importe: 2542.4 },
];

describe('[COT.7.1] armarPedidoTlmk — contra el pedido real 01/0003710', () => {
  it('reconstruye la cabecera que guardó Kepler, al centavo', () => {
    const r = armarPedidoTlmk(PEDIDO_3710, FICHAS, 2);
    if (!r.ok) throw new Error(r.motivos.join('; '));
    expect(r.cabecera).toEqual({ c19: 2, c13: 191.88, c14: 0, c15: 752.16, c16: 10154.17 });
  });

  it('y cada renglón: c9 = c51 × c58, c12 por unidad base, c13 = c12 × c9', () => {
    const r = armarPedidoTlmk(PEDIDO_3710, FICHAS, 2);
    if (!r.ok) throw new Error(r.motivos.join('; '));
    expect(r.renglones.map((l) => [l.c9, l.c11, l.c12, l.c13, l.c51, l.c55, l.c58])).toEqual([
      [40, 'PAQ', 89.8, 3592.0, 5, 'CJA', 8],
      [60, 'PAQ', 70.45, 4227.0, 5, 'CJA', 12],
      [80, '500', 31.78, 2542.4, 4, 'CJA', 20],
    ]);
    expect(r.renglones[0].c17).toBe(0);
    expect(r.renglones[0].c18).toBe(-8);
    expect(r.renglones[0].c66).toBeCloseTo(91.4175, 4);
  });

  it('sin descuento de cliente: c16 = Σ c13 y c13 de cabecera en 0 (pedido 01/0003592)', () => {
    const r = armarPedidoTlmk(
      [
        { sku: '44415', cantidad: 10, presentacion: 'PAQ', factor: null, precio: 17.33, lista: 19.09, importe: 173.3 },
        { sku: '44416', cantidad: 10, presentacion: 'PAQ', factor: null, precio: 17.92, lista: 19.09, importe: 179.2 },
      ],
      new Map([['44415', ficha('GALL WAFER', 'PAQ', 1)], ['44416', ficha('GALL WAFER V', 'PAQ', 1)]]),
      null,
    );
    if (!r.ok) throw new Error(r.motivos.join('; '));
    expect(r.cabecera.c16).toBe(352.5);
    expect(r.cabecera.c13).toBe(0);
    expect(r.cabecera.c19).toBe(0);
    expect(r.renglones[0].c58).toBe(1);
  });
});

describe('[COT.7.1] falla cerrada: un renglón que no se puede escribir rechaza el pedido entero', () => {
  it('el factor de la cotización y el de la ficha no coinciden (el 50× de KR.6)', () => {
    const fichas = new Map(FICHAS);
    fichas.set('29014', ficha('PRODUCTO 29014', 'PAQ', 12));
    const r = armarPedidoTlmk(PEDIDO_3710, fichas, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos[0]).toMatch(/29014.*8 en la cotización y 12 en la ficha/);
  });

  it('la ficha no declara la presentación', () => {
    const fichas = new Map(FICHAS);
    fichas.set('53205', { ...ficha('P', 'PAQ', 12), factor_presentacion: null });
    const r = armarPedidoTlmk(PEDIDO_3710, fichas, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos[0]).toMatch(/53205.*no declara la presentación CJA/);
  });

  it('Kepler no tiene la ficha del producto', () => {
    const r = armarPedidoTlmk(PEDIDO_3710, new Map([...FICHAS].filter(([k]) => k !== '14011')), 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos).toEqual(['14011: Kepler no tiene la ficha del producto en esta sucursal']);
  });

  it('el importe guardado no es el que Kepler calcularía', () => {
    const r = armarPedidoTlmk([{ ...PEDIDO_3710[0], importe: 3600 }], FICHAS, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos[0]).toMatch(/importe no cuadra/);
  });

  it('sin renglones', () => {
    expect(armarPedidoTlmk([], FICHAS, 0)).toEqual({ ok: false, motivos: ['La cotización no tiene renglones con precio'] });
  });
});

describe('[COT.28] observaciones → «Comentarios» c25/c26 (varchar(60) en Kepler)', () => {
  it('vacío o puros espacios = dos renglones vacíos', () => {
    expect(renglonesObservaciones('   ')).toEqual(['', '']);
    expect(renglonesObservaciones(null)).toEqual(['', '']);
  });

  it('una línea cabe en c25; los saltos de línea se vuelven espacios', () => {
    expect(renglonesObservaciones('cobrar hoy\npara entregar   hoy mismo')).toEqual(['cobrar hoy para entregar hoy mismo', '']);
  });

  it('más de 60: corta en el último espacio, sin partir palabras, y ninguno pasa de 60', () => {
    const t = 'ENTREGAR ANTES DE LAS 10 AM EN LA BODEGA DE ATRAS, PREGUNTAR POR DON JOSE Y COBRAR EN EFECTIVO';
    const [a, b] = renglonesObservaciones(t);
    expect(a.length).toBeLessThanOrEqual(60);
    expect(b.length).toBeLessThanOrEqual(60);
    expect(`${a} ${b}`).toBe(t);
  });

  it('una palabra larga sin espacios: corta a 60 exactos', () => {
    const t = 'X'.repeat(100);
    expect(renglonesObservaciones(t)).toEqual(['X'.repeat(60), 'X'.repeat(40)]);
  });

  it('120 justos con el espacio mal puesto: el resto no cabría, corta a 60 y no pierde nada', () => {
    const t = 'A'.repeat(10) + ' ' + 'B'.repeat(109);
    const [a, b] = renglonesObservaciones(t);
    expect(a.length).toBe(60);
    expect(b.length).toBeLessThanOrEqual(60);
    expect(a + b).toBe(t);
  });

  it('más de 120 no se trunca en silencio', () => {
    expect(() => renglonesObservaciones('Y'.repeat(121))).toThrow(/120/);
  });
});
