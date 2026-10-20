import { describe, expect, it } from 'vitest';
import type { MayoreoTier, VerificadorSnapshotItem } from '@megadulces/contracts';
import {
  aBuscable, buscarEnCatalogo, escalonesDe, presentacionesDe, tramoNormal, type UnidadConFactor,
} from './mostrador-catalogo';

/**
 * `[MOS.1]` — El buscador del mostrador: qué encuentra, cómo cuenta la caja y cómo dice el mayoreo.
 *
 * Los negativos pesan tanto como los positivos: una caja que «siempre» se convierte a paquetes se
 * ve bien con el producto de ejemplo y miente con el que no divide exacto.
 */

const u = (x: string, precio: number, factor = 1): UnidadConFactor => ({ u: x, precio_con_iva: precio, factor });

const tier = (o: Partial<MayoreoTier>): MayoreoTier => ({
  etiqueta: 'paquete', desde: 3, palabra: 'paquetes', precio_con_iva: 120, ahorro_por_unidad: 6,
  ahorro_en_el_minimo: 18, descuento_pct: 4.8, realza: true, aplica_a: 'paquete', unidad_monto: 'por paquete',
  ...o,
});

describe('presentacionesDe — qué trae cada presentación', () => {
  it('la caja se cuenta en PAQUETES cuando el producto tiene paquete', () => {
    const p = presentacionesDe([u('PZA', 3.5), u('PAQ', 126, 40), u('CJA', 2380, 800)]);
    expect(p.map((x) => [x.u, x.trae?.n, x.trae?.u])).toEqual([
      ['PZA', undefined, undefined], ['PAQ', 40, 'PZA'], ['CJA', 20, 'PAQ'],
    ]);
    expect(p[2].trae?.palabra).toBe('paquetes');
    expect(p[2].precioPorTrae).toBe(119);            // $2,380 / 20 paquetes
  });

  it('⛔ si la caja no divide exacto entre el paquete, dice las PIEZAS (no inventa 12.5 paquetes)', () => {
    const p = presentacionesDe([u('PZA', 3.5), u('PAQ', 126, 40), u('CJA', 1700, 500)]);
    expect(p[2].trae).toEqual({ n: 500, u: 'PZA', palabra: 'piezas' });
  });

  it('⛔ sin paquete, la caja va en piezas', () => {
    const p = presentacionesDe([u('PZA', 14.5), u('CJA', 320, 24)]);
    expect(p[1].trae).toEqual({ n: 24, u: 'PZA', palabra: 'piezas' });
  });

  it('cuando la base ES el paquete, la caja cuenta paquetes', () => {
    const p = presentacionesDe([u('PAQ', 52), u('CJA', 980, 20)]);
    expect(p[1].trae).toEqual({ n: 20, u: 'PAQ', palabra: 'paquetes' });
  });

  it('la base no "trae" nada y una unidad desconocida conserva su clave', () => {
    const p = presentacionesDe([u('BTO', 40)]);
    expect(p[0].trae).toBeNull();
    expect(p[0].nombre).toBe('BTO');
  });
});

describe('escalonesDe — el mayoreo en la presentación en que Kepler lo captura', () => {
  const uni = [u('PZA', 4.8), u('PAQ', 88, 20), u('CJA', 1690, 400)];

  it('un escalón de paquete se dice por paquete, con el precio normal del paquete', () => {
    const [e] = escalonesDe(uni, [tier({ desde: 5, precio_con_iva: 84 })]);
    expect(e).toMatchObject({ u: 'PAQ', precio: 84, precioNormal: 88, etiqueta: 'c/paquete', desde: 5 });
    expect(tramoNormal(e)).toBe('1 a 4 paquetes');
  });

  it('un escalón de la base se dice por pieza', () => {
    const [e] = escalonesDe(uni, [tier({ aplica_a: 'base', etiqueta: 'pieza', palabra: 'piezas', desde: 10, precio_con_iva: 4.5 })]);
    expect(e).toMatchObject({ u: 'PZA', precio: 4.5, precioNormal: 4.8, etiqueta: 'c/pieza' });
  });

  it('⛔ el precio de mayoreo NO se convierte a pieza: es el de UNA unidad de su presentación', () => {
    const [e] = escalonesDe([u('PZA', 3.5), u('PAQ', 126, 40)], [tier({ precio_con_iva: 120 })]);
    expect(e.precio).toBe(120);
    expect(e.etiqueta).toBe('c/paquete');
  });

  it('a granel se dice por kilo', () => {
    const [e] = escalonesDe([u('KG', 98)], [tier({ aplica_a: 'base', palabra: 'kg', desde: 5, precio_con_iva: 92 })]);
    expect(e.etiqueta).toBe('c/kg');
    expect(tramoNormal(e)).toBe('1 a 4 kg');
  });

  it('con mínimo de 2, el tramo normal es "1 pieza"', () => {
    const [e] = escalonesDe([u('PZA', 10)], [tier({ aplica_a: 'base', palabra: 'piezas', desde: 2, precio_con_iva: 9 })]);
    expect(tramoNormal(e)).toBe('1 pieza');
  });
});

describe('buscarEnCatalogo — nombre, proveedor, SKU o código de barras', () => {
  const item = (c: string, n: string, b: string[], pv?: number): VerificadorSnapshotItem => ({ c, n, b, u: [{ u: 'PZA', p: 1, s: 1, f: 1 }], ...(pv !== undefined ? { pv } : {}) });
  const PROV = ['DULCES DE LA ROSA', 'RICOLINO'];
  const cat = [
    item('70001', 'PAL CHIQUI HUESO C/CHILE ALVHER /40', ['7501234500012']),
    item('14030', 'MAZAPAN DE LA ROSA GRANDE 30P', ['7501056310012'], 0),
    item('14055', 'PULPARINDO 20P', ['7501056320011'], 0),
    item('96158', 'PALETA PAYASO 45G', ['7501000911288'], 1),
    item('00700', 'PIÑA ENCHILADA', [], 1),
  ].map((x) => aBuscable(x, PROV));
  const buscar = (q: string) => buscarEnCatalogo(cat, q).map((r) => [r.b.codigo, r.por]);

  it('por nombre, con palabras en cualquier orden y sin acentos', () => {
    expect(buscar('chile chiqui')).toEqual([['70001', 'nombre']]);
    expect(buscar('pina')).toEqual([['00700', 'nombre']]);
  });

  it('por proveedor: trae los productos que no lo dicen en el nombre', () => {
    expect(buscar('ricolino')).toEqual([['96158', 'proveedor'], ['00700', 'proveedor']]);
    const rosa = buscar('rosa');
    expect(rosa[0]).toEqual(['14030', 'nombre']);     // lo dice en el nombre: va primero
    expect(rosa).toContainEqual(['14055', 'proveedor']);
  });

  it('por SKU, sin los ceros a la izquierda, por prefijo', () => {
    // `700` ES la clave 00700 (exacto, primero) y es el principio de 70001.
    expect(buscar('700')).toEqual([['00700', 'sku'], ['70001', 'sku']]);
    expect(buscar('1403')).toEqual([['14030', 'sku']]);
  });

  it('por código de barras, también un pedazo', () => {
    expect(buscar('7501056')).toEqual([['14030', 'barcode'], ['14055', 'barcode']]);
  });

  it('el código EXACTO va primero (es lo que se escaneó)', () => {
    const r = buscarEnCatalogo(cat, '7501056320011');
    expect(r[0].b.codigo).toBe('14055');
    expect(r[0].exacto).toBe(true);
  });

  it('nombre y proveedor juntos', () => {
    expect(buscar('paleta ricolino')).toEqual([['96158', 'varios']]);
  });

  it('⛔ sin texto no devuelve el catálogo entero, y lo que no casa no sale', () => {
    expect(buscar('')).toEqual([]);
    expect(buscar('zzz')).toEqual([]);
  });

  it('⛔ un producto sin proveedor no casa por proveedor con texto vacío', () => {
    const sinProv = aBuscable(item('1', 'GOMA', []), PROV);
    expect(sinProv.proveedor).toBeNull();
    expect(buscarEnCatalogo([sinProv], 'rosa')).toEqual([]);
  });
});
