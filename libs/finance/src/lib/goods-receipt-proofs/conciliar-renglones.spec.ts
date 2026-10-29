import type { RemisionLine } from '@megadulces/platform-core';
import { aprendibles, conciliarRenglones, lineSimilarity, tokenize, type EntradaConciliar, type RenglonKepler } from './conciliar-renglones';

/**
 * `[RE.53]` El caso que lo trajo (entrada 0001088 de 8 Esquinas, AGA), con importes SINTÉTICOS
 * (el repo es público) pero el mismo patrón: la remisión trae precios CON IVA, y los nombres
 * empujan a cruzar RED COLA 400 con 600.
 */
const rem = (descripcion: string, cantidad: number, importe: number | null, unidad = 'CJ'): RemisionLine =>
  ({ descripcion, cantidad, unidad, importe, precio_unitario: null, sku_proveedor: null, codigo_barras: null });
const kep = (linea: string, sku: string, nombre: string, cantidad: number, importe: number): RenglonKepler =>
  ({ linea, sku, nombre, unidad: 'PZA', cantidad, costo_unitario: importe / cantidad, importe });

const kepler = [
  kep('1', 'S600', 'RED COLA 600 ML', 192, 2000),
  kep('2', 'S400', 'RED COLA 400ML AGA', 192, 1000),
  kep('3', 'M600', 'SIDRAL AGA MANZANA 600ML', 48, 500),
  kep('4', 'Q2L', 'SQUIRT TORONJA 2LT AGA', 45, 900),
  kep('5', 'Z600', 'ZUBBA UVA 600ML AGA', 72, 800),
];
const bf = new Map([['S600', 24], ['S400', 24], ['M600', 24], ['Q2L', 9], ['Z600', 24]]);
const conIva = (x: number) => Math.round(x * 1.16 * 100) / 100;

const entrada = (remision: RemisionLine[], extra: Partial<EntradaConciliar> = {}): EntradaConciliar =>
  ({ remision, kepler, aliases: new Map(), barcodes: new Map(), boxFactor: bf, ...extra });

const remisionAga = [
  rem('RED COLA 24/400', 8, conIva(1000)),
  rem('RED COLA 24/600', 8, conIva(2000)),
  rem('AGA DE MANZANA 24/600', 2, conIva(500)),
  rem('SQUIRT 9/2.0', 5, conIva(900)),
  rem('ZUBBA 24/600', 3, conIva(800)),
  rem('CAB PINA 24/400', 4, conIva(700)),
];

describe('[RE.53] conciliación por renglón', () => {
  it('CONTROL del caso: por NOMBRE solo, «RED COLA 24/400» se parece más a «600 ML» que a «400ML»', () => {
    // Es lo que hacía cruzar al motor de RE.11: si este control deja de cumplirse, el caso de abajo
    // ya no prueba que la cantidad y el importe sean los que deciden.
    const t = tokenize('RED COLA 24/400');
    expect(lineSimilarity(t, tokenize('RED COLA 600 ML'))).toBeGreaterThan(lineSimilarity(t, tokenize('RED COLA 400ML AGA')));
  });

  it('empareja por cantidad e importe, no por el orden de la remisión: RED COLA 400↔400 y 600↔600', () => {
    const c = conciliarRenglones(entrada(remisionAga));
    const par = (d: string) => c.lines.find((l) => l.remision.descripcion === d)?.resolved_sku;
    expect(par('RED COLA 24/400')).toBe('S400');
    expect(par('RED COLA 24/600')).toBe('S600');
  });

  it('detecta que la remisión viene CON IVA y entonces el precio cuadra (antes: «Difiere precio» en todos)', () => {
    const c = conciliarRenglones(entrada(remisionAga));
    expect(c.base_precio).toBe('con_iva');
    const emparejados = c.lines.filter((l) => l.kepler);
    expect(emparejados.length).toBe(5);
    expect(emparejados.every((l) => l.status === 'cuadra')).toBe(true);
    expect(c.lines.find((l) => l.remision.descripcion === 'CAB PINA 24/400')?.status).toBe('sin_match');
  });

  it('NEGATIVA: un documento SIN IVA no se lee como con IVA, y un importe 16 % arriba sí difiere', () => {
    const sinIva = remisionAga.slice(0, 4).map((r) => ({ ...r, importe: Math.round((r.importe as number) / 1.16 * 100) / 100 }));
    sinIva[3] = { ...sinIva[3], importe: conIva(900) }; // un renglón 16 % arriba en un documento sin IVA
    const c = conciliarRenglones(entrada(sinIva));
    expect(c.base_precio).toBe('sin_iva');
    expect(c.lines.find((l) => l.remision.descripcion === 'SQUIRT 9/2.0')?.status).toBe('difiere_precio');
  });

  it('sin pares que cuadren en cantidad, la base no se adivina: «sin_medir»', () => {
    const c = conciliarRenglones(entrada([rem('RED COLA 24/400', 99, 50)]));
    expect(c.base_precio).toBe('sin_medir');
  });

  it('un alias aprendido manda sobre el nombre', () => {
    const aliases = new Map([['red cola 24 400', { sku: 'S400', nombre_interno: 'RED COLA 400ML AGA', box_factor: 24 }]]);
    const c = conciliarRenglones(entrada([rem('RED COLA 24/400', 8, conIva(1000))], { aliases }));
    expect(c.lines[0]).toMatchObject({ resolved_sku: 'S400', method: 'alias', alias_hit: true, status: 'cuadra' });
  });
});

describe('[RE.53] qué se aprende solo al dar por buena la factura', () => {
  it('aprende los pares con cantidad E importe cuadrando y nombre ≥ 50 %; no el de nombre flojo', () => {
    const a = aprendibles(conciliarRenglones(entrada(remisionAga)));
    const skus = a.map((x) => x.sku).sort();
    // ZUBBA 24/600 → «ZUBBA UVA 600ML AGA» cuadra en todo pero su nombre se parece < 50 %: no.
    expect(skus).toEqual(['M600', 'Q2L', 'S400', 'S600']);
    expect(a.find((x) => x.sku === 'S400')).toMatchObject({ descripcion: 'RED COLA 24/400', unidad_proveedor: 'CJ', box_factor: 24, refuerza: false });
  });

  it('NEGATIVA: un par que difiere en importe (el cruce del motor viejo) NO se aprende', () => {
    // Se fuerza el cruce con alias equivocados: el importe lo delata (1.58 / 0.63) y no se refuerza.
    const aliases = new Map([
      ['red cola 24 400', { sku: 'S600', nombre_interno: null, box_factor: 24 }],
      ['red cola 24 600', { sku: 'S400', nombre_interno: null, box_factor: 24 }],
    ]);
    const c = conciliarRenglones(entrada(remisionAga.slice(0, 2), { aliases }));
    expect(c.lines.map((l) => l.status)).toEqual(['difiere_precio', 'difiere_precio']);
    expect(aprendibles(c)).toEqual([]);
  });

  it('NEGATIVA: si dos renglones de la remisión resuelven al MISMO SKU, ninguno se aprende', () => {
    const aliases = new Map([
      ['red cola 24 400', { sku: 'S400', nombre_interno: null, box_factor: 24 }],
      ['otra cola', { sku: 'S400', nombre_interno: null, box_factor: 24 }],
    ]);
    const c = conciliarRenglones(entrada([rem('RED COLA 24/400', 8, conIva(1000)), rem('OTRA COLA', 8, conIva(1000))], { aliases }));
    expect(aprendibles(c).some((x) => x.sku === 'S400')).toBe(false);
  });
});
