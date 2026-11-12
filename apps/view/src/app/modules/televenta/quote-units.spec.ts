import { describe, it, expect } from 'vitest';
import { abrevUnidadBase, desglose, esPaquete, gramosDeBase, unidadBaseLegible, unidadBaseDesglose, textoHay, nombreUnidadBase, opcionesUnidad, paqueteDeCaja, parseCantidad, vendedorDelCliente, descuentoDerivado, descuentoDelMecanismo, textoDescuento, existenciaEnUnidad, tonoFuentePrecio, unidadDelEscaneo, netoPorUnidad } from './quote-units';
import { pasosDelPrecio } from './quote-discount-breakdown';
import { etiquetaDesglose } from './quote-deliverable-export';
import type { QuoteCatalogRow } from './quotes.service';

/**
 * COT.16 — los botones de unidad y el desglose del precio. Los casos son productos reales de la
 * sucursal 01 (medidos en prod, solo lectura, 2026-10-01).
 */
const fila = (o: Partial<QuoteCatalogRow>): QuoteCatalogRow => ({
  sku: 'X',
  name: null,
  content: null,
  barcode: null,
  unit_base: 'PZA',
  piece_price: 1,
  pack_size: null,
  box_size: null,
  box_label: null,
  sold_by_kg: false,
  ...o,
});

describe('opcionesUnidad — de menor a mayor, sólo las que el ERP declara', () => {
  it('KINDER DELICE (42029): Pieza 1 · Paquete 10 · Caja 140 (antes salía Pieza · Caja · Paquete)', () => {
    const o = opcionesUnidad(fila({ unit_base: 'PZA', pack_size: 10, box_size: 140, box_label: 'CJA' }));
    expect(o.map((x) => `${x.titulo} ${x.tamano}`)).toEqual(['Pieza 1', 'Paquete 10', 'Caja 140']);
  });

  it('un producto con una sola unidad pinta UN solo botón', () => {
    expect(opcionesUnidad(fila({ unit_base: 'PZA' }))).toHaveLength(1);
  });

  it('el gansito (base PAQ) dice "Paquete", no "Pieza"', () => {
    const o = opcionesUnidad(fila({ unit_base: 'PAQ', box_size: 12, box_label: 'CJA' }));
    expect(o.map((x) => x.titulo)).toEqual(['Paquete', 'Caja']);
    expect(o[1].detalle).toBe('12 PAQ');
  });

  it('granel por kilo con bulto: Kilo · Bulto 20 kg', () => {
    const o = opcionesUnidad(fila({ unit_base: 'KG', sold_by_kg: true, box_size: 20, box_label: 'BTO' }));
    expect(o.map((x) => `${x.titulo} ${x.detalle}`)).toEqual(['Kilo 1 kg', 'Bulto 20 kg']);
  });

  it('[COT.30] 70500 (base medio kilo, KG de 2, CJA de 20): el KG sale como «Kilo», no se pierde', () => {
    const o = opcionesUnidad(fila({ unit_base: '500', pack_size: 2, pack_label: 'KG', box_size: 20, box_label: 'CJA' }));
    expect(o.map((x) => `${x.rung} ${x.titulo} ${x.tamano}`)).toEqual(['base Medio kilo 1', 'pack Kilo 2', 'box Caja 20']);
    // El KG de 2 de Kepler prueba que «500» son gramos: los botones hablan en peso, no en «u.».
    expect(o.map((x) => x.detalle)).toEqual(['500 g', '1 kg', '10 kg']);
  });

  it('[COT.38] con gramos probados: «500 g» en la base, la existencia en kilos y el desglose «× 500 g»', () => {
    const e = fila({ unit_base: '500', pack_size: 2, pack_label: 'KG', box_size: 20, box_label: 'CJA' });
    expect(unidadBaseLegible(e)).toBe('500 g');
    expect(textoHay(726.8, e)).toBe('hay 363.4 kg');
    expect(unidadBaseDesglose(e)).toBe('× 500 g');
  });

  it('[COT.38] sin gramos probados se queda como siempre (no se inventa el peso)', () => {
    const e = fila({ unit_base: '500' });
    expect(unidadBaseLegible(e)).toBe('u.');
    expect(textoHay(726.8, e)).toBe('hay 726.8 500');
    expect(textoHay(12, fila({ unit_base: 'PAQ' }))).toBe('hay 12 PAQ');
    expect(unidadBaseDesglose(fila({ unit_base: 'PAQ' }))).toBe('PAQ');
  });

  it('[COT.30] un «500» sin KG que lo pruebe sigue siendo unidad desconocida', () => {
    expect(gramosDeBase({ unit_base: '500', pack_label: null, pack_size: null })).toBeNull();
    expect(gramosDeBase({ unit_base: '500', pack_label: 'KG', pack_size: 3 })).toBeNull();
    expect(opcionesUnidad(fila({ unit_base: '500' }))[0].titulo).toBe('500');
  });

  it('[COT.30] la intermedia sin rótulo o PAQ sigue siendo «Paquete»; el paquete se desglosa en la caja sólo si ES paquete', () => {
    expect(opcionesUnidad(fila({ unit_base: 'PZA', pack_size: 10, pack_label: 'PAQ', box_size: 140 }))[1].titulo).toBe('Paquete');
    expect(esPaquete('KG')).toBe(false);
    expect(esPaquete(null)).toBe(true);
  });
});

describe('unidad base — nunca un rótulo inventado', () => {
  it('rótulos que el ERP usa como unidad pero no lo son ("500") se muestran como los dice Kepler, no como "Unidad"', () => {
    expect(nombreUnidadBase('500')).toBe('500');
    expect(abrevUnidadBase('500')).toBe('u.');
  });
  it('vendido por kilo gana sobre el rótulo', () => {
    expect(abrevUnidadBase('PZA', true)).toBe('KG');
  });
});

describe('etiquetaDesglose — el texto que llega al Excel/PDF del cliente', () => {
  it('un bulto de 20 KG dice "20 KG", no "20PZS"', () => {
    expect(etiquetaDesglose(20, 'KG', 56.5)).toBe('(20 KG 56.50)');
  });
  it('una caja de 12 paquetes dice "12 PAQ"', () => {
    expect(etiquetaDesglose(12, 'PAQ', 41.82)).toBe('(12 PAQ 41.82)');
  });
  it('sin unidad conocida cae a PZA (lo de antes)', () => {
    expect(etiquetaDesglose(12, null, 80.82)).toBe('(12 PZA 80.82)');
  });
});

describe('COT.17 — la unidad del MEDIO (el paquete dentro de la caja)', () => {
  it('KINDER DELICE: caja de 140 a $1,706.06 → 14 PAQ $121.86 · 140 PZA $12.19', () => {
    const d = desglose(1706.06, 140, 'PZA', 10);
    expect(d.map((p) => `${p.cantidad} ${p.unidad} ${p.precio.toFixed(2)}`)).toEqual(['14 PAQ 121.86', '140 PZA 12.19']);
  });
  it('en el Excel/PDF: "(14 PAQ 121.86 · 140 PZA 12.19)"', () => {
    expect(etiquetaDesglose(140, 'PZA', 1706.06 / 140, 10)).toBe('(14 PAQ 121.86 · 140 PZA 12.19)');
  });
  it('sin paquete queda igual que antes (sólo la base)', () => {
    expect(etiquetaDesglose(12, 'PAQ', 41.82, null)).toBe('(12 PAQ 41.82)');
    expect(desglose(501.8, 12, 'PAQ')).toHaveLength(1);
  });
  it('un paquete que NO cabe exacto en la caja no se inventa ("13.3 PAQ")', () => {
    expect(paqueteDeCaja(40, 3)).toBeNull();
    expect(desglose(100, 40, 'PZA', 3)).toHaveLength(1);
  });
  it('paquete igual o mayor que la caja, o de 1, no es unidad del medio', () => {
    expect(paqueteDeCaja(12, 12)).toBeNull();
    expect(paqueteDeCaja(12, 1)).toBeNull();
    expect(paqueteDeCaja(null, 10)).toBeNull();
  });
  it('una unidad base (factor 1) no se desglosa', () => {
    expect(desglose(12.19, 1, 'PZA', 10)).toEqual([]);
  });
});

/**
 * `[E.20]` La cantidad tecleada. El defecto que esto cierra: «2.5» kg se cotizaba como 25 en el
 * alta (se borraba el punto) y como 2 en el detalle (Math.floor).
 */
describe('parseCantidad', () => {
  it('«2.5» en lo que se pesa es 2.5, nunca 25 ni 2', () => {
    expect(parseCantidad('2.5', true)).toBe(2.5);
    expect(parseCantidad(' 0.750 ', true)).toBe(0.75);
  });

  it('en unidades enteras una fracción no se convierte en otro número', () => {
    expect(parseCantidad('2.5', false)).toBeNull();
    expect(parseCantidad('12', false)).toBe(12);
  });

  it('la coma es separador de miles; «2,5» es ambiguo y no se adivina', () => {
    expect(parseCantidad('1,250', false)).toBe(1250);
    expect(parseCantidad('1,250.5', true)).toBe(1250.5);
    expect(parseCantidad('2,5', true)).toBeNull();
  });

  it('vacío, cero, negativo o texto: null (la pantalla conserva la cantidad anterior)', () => {
    for (const v of ['', '0', '-3', 'abc', '2.', '.5', '1.2.3', null, undefined]) {
      expect(parseCantidad(v, true)).toBeNull();
    }
  });
});

/** `[E.29]` El vendedor sale del cliente: en Kepler, 3,257 de 3,336 pedidos de telemarketing (90 d). */
describe('vendedorDelCliente', () => {
  const padron = [{ code: '10001', name: 'CINTHIA' }, { code: '00502', name: 'DANIEL' }];

  it('encuentra el del cliente, con o sin ceros a la izquierda', () => {
    expect(vendedorDelCliente('10001', padron)?.name).toBe('CINTHIA');
    expect(vendedorDelCliente(' 502 ', padron)?.code).toBe('00502');
  });

  it('cliente sin vendedor, o con uno que no está en el padrón de la sucursal: null, nunca otro', () => {
    for (const c of [null, undefined, '', '   ', '99999']) {
      expect(vendedorDelCliente(c, padron)).toBeNull();
    }
  });
});

/** [E.29] Lo que la bandeja del alta muestra antes de guardar, igual que el detalle (captura COT-2026-00027). */
describe('renglón antes de guardar = renglón guardado', () => {
  it('el descuento contra lista es la cuenta del servidor: 26.94 → 24.79 = 7.98 %; 79.75 → 39.88 = 49.99 %', () => {
    expect(descuentoDerivado(26.94, 24.79)).toBe(7.98);
    expect(descuentoDerivado(79.75, 39.88)).toBe(49.99);
    expect(descuentoDerivado(26.94, 26.94)).toBe(0);
  });

  it('sin lista o sin precio NO es 0 %: es null', () => {
    for (const [l, p] of [[null, 10], [0, 10], [10, null], [undefined, 1]] as const) expect(descuentoDerivado(l, p)).toBeNull();
  });

  it('[E.29] a lista no hay descuento de mecanismo: el centavo es el redondeo de Kepler (código o rótulo)', () => {
    expect(descuentoDerivado(1169.91, 1170)).toBe(-0.01); // control: la cuenta cruda sí da «−0.01 %»
    expect(descuentoDelMecanismo(1169.91, 1170, 'list')).toBeNull();
    expect(descuentoDelMecanismo(1169.91, 1170, 'Lista')).toBeNull();
    expect(descuentoDelMecanismo(26.94, 24.79, 'volume_qty')).toBe(7.98);
    expect(descuentoDelMecanismo(50, 50.2, 'volume_qty')).toBe(-0.4);
  });

  it('[E.29] el texto del descuento dice recargo con «+», y el PDF lleva guion ASCII', () => {
    expect(textoDescuento(7.98)).toBe('−7.98%');
    expect(textoDescuento(-0.4)).toBe('+0.4%');
    expect(textoDescuento(7.98, '-')).toBe('-7.98%');
  });

  it('la existencia en la unidad del renglón y lo que falta (60 base en PAQ de 10, piden 7: hay 6, faltan 1)', () => {
    expect(existenciaEnUnidad(60, 10, 7)).toEqual({ cantidad: 6, faltan: 1 });
    expect(existenciaEnUnidad(170, 10, 1)).toEqual({ cantidad: 17, faltan: 0 });
    expect(existenciaEnUnidad(0, 10, 3)).toEqual({ cantidad: 0, faltan: 3 });
    expect(existenciaEnUnidad(5, null, 2)).toEqual({ cantidad: 5, faltan: 0 });
  });

  it('los pasos del precio: lista → volumen; un solo paso no se explica', () => {
    const f = (n: number) => '$' + n.toFixed(2);
    expect(pasosDelPrecio([{ step: 'lista', after: 26.94 }, { step: 'volumen', after: 24.79 }], f)).toBe('lista $26.94 → volumen $24.79');
    expect(pasosDelPrecio([{ step: 'lista', after: 79.75 }, { step: 'promo_cantidad', after: 39.88 }], f)).toBe('lista $79.75 → promoción $39.88');
    expect(pasosDelPrecio([{ step: 'lista', after: 10 }], f)).toBe('');
    expect(pasosDelPrecio([{ step: 'lista', after: 10 }, { step: 'volumen', after: null }], f)).toBe('');
  });

  it('el tono de la etiqueta: desconocida = secundaria', () => {
    expect(tonoFuentePrecio('volume_qty')).toBe('info');
    expect(tonoFuentePrecio('promo_qty')).toBe('success');
    expect(tonoFuentePrecio('algo')).toBe('secondary');
  });
});

describe('[COT.42] unidadDelEscaneo — el código de la caja elige la caja', () => {
  const agua = fila({ unit_base: 'PZA', pack_size: 6, pack_label: 'PAQ', box_size: 24, box_label: 'CJA' });
  it('sin código (búsqueda por palabras): null, no toca la unidad', () => expect(unidadDelEscaneo({ ...agua, scan_factor: null })).toBeNull());
  it('código de la pieza: base', () => expect(unidadDelEscaneo({ ...agua, scan_factor: 1 })).toBe('base'));
  it('código del paquete: pack', () => expect(unidadDelEscaneo({ ...agua, scan_factor: 6 })).toBe('pack'));
  it('código de la caja: box', () => expect(unidadDelEscaneo({ ...agua, scan_factor: 24 })).toBe('box'));
  it('un empaque sin precio en la sucursal: se avisa, no cae a pieza', () => expect(unidadDelEscaneo({ ...agua, scan_factor: 12 })).toBe('sin-opcion'));
});

describe('[COT.43] netoPorUnidad — lo que paga el cliente por unidad, con todo descontado', () => {
  it('el ejemplo de Televenta: 10 CJA x6, neto $2,573.02 → $257.30 la CJA y $42.88 el PAQ', () => {
    const r = netoPorUnidad(2573.02, 2652.6, 10, desglose(265.26, 6, 'PAQ'))!;
    expect(r.precio.toFixed(2)).toBe('257.30');
    expect(r.pasos.map((p) => [p.unidad, p.precio.toFixed(2)])).toEqual([['PAQ', '42.88']]);
  });
  it('caja con paquete y pieza: reparte en las dos', () => {
    const r = netoPorUnidad(970, 1000, 1, desglose(1000, 140, 'PZA', 10))!;
    expect(r.pasos.map((p) => [p.unidad, p.precio.toFixed(2)])).toEqual([['PAQ', '69.29'], ['PZA', '6.93']]);
  });
  it('sin % de cliente (neto = importe) no se repite: null', () => expect(netoPorUnidad(100, 100, 2, [])).toBeNull());
  it('sin neto o cantidad cero: null', () => { expect(netoPorUnidad(null, 100, 2, [])).toBeNull(); expect(netoPorUnidad(90, 100, 0, [])).toBeNull(); });
});
