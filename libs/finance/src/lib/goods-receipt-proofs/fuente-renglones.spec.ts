import type { RemisionLine } from '@megadulces/platform-core';
import { conceptosDelCfdi, eanValido, lecturaConfiable, porPrecedencia, rfcsDelProveedor } from './fuente-renglones';

const rem = (descripcion: string, importe: number | null, codigo_barras: string | null = null): RemisionLine =>
  ({ descripcion, cantidad: 1, unidad: 'PZA', importe, precio_unitario: null, sku_proveedor: null, codigo_barras });

/**
 * `[RE.55]` Los códigos que el OCR devolvió para la entrada 0010028 de CEDIS (renglones que no están
 * en el papel). Son públicos sin problema: no existen.
 */
const INVENTADOS = ['7501091005233', '7501091012573', '7501091018920', '7501091022387'];

describe('[RE.55] dígito verificador GS1', () => {
  it('CONTROL: un EAN-13 real pasa', () => {
    expect(eanValido('7501055300075')).toBe(true);
  });
  it('un dígito cambiado no pasa', () => {
    expect(eanValido('7501055300076')).toBe(false);
  });
  it('los cuatro códigos del OCR de 0010028 no existen', () => {
    expect(INVENTADOS.map(eanValido)).toEqual([false, false, false, false]);
  });
  it('lo que no tiene forma de código no se juzga', () => {
    expect(eanValido(null)).toBeNull();
    expect(eanValido('ABC123')).toBeNull();
    expect(eanValido('12345')).toBeNull();
  });
});

describe('[RE.55] ¿la lectura del OCR es del papel?', () => {
  it('reprueba si la mayoría de los códigos de barras no existe', () => {
    const l = lecturaConfiable(INVENTADOS.map((c, i) => rem(`R${i}`, 100, c)), { subtotal: 400, total: 464 });
    expect(l.confiable).toBe(false);
    expect(l.motivos[0]).toContain('4 de 4');
  });
  it('un solo código mal copiado entre varios buenos no reprueba', () => {
    const l = lecturaConfiable([rem('A', 100, '7501055300075'), rem('B', 100, '7501055300075'), rem('C', 100, INVENTADOS[0])], { subtotal: 300, total: null });
    expect(l.confiable).toBe(true);
  });
  it('reprueba si la suma de renglones no da el subtotal, el total ni el total sin IVA', () => {
    const l = lecturaConfiable([rem('A', 100), rem('B', 100)], { subtotal: 900, total: 1044 });
    expect(l.confiable).toBe(false);
    expect(l.motivos.join(' ')).toContain('suman $200.00');
  });
  it('pasa si la suma da el total sin IVA (el papel sólo trajo el total)', () => {
    expect(lecturaConfiable([rem('A', 100), rem('B', 100)], { subtotal: null, total: 232 }).confiable).toBe(true);
  });
  it('sin total leído no reprueba, pero declara que no se midió', () => {
    const l = lecturaConfiable([rem('A', 100)], { subtotal: null, total: null });
    expect(l.confiable).toBe(true);
    expect(l.motivos[0]).toContain('no se pudo comparar');
  });
});

describe('[RE.55] conceptos del CFDI', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" SubTotal="1100.00" Total="1160.00">
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="50161813" NoIdentificacion="0012" Cantidad="10" ClaveUnidad="XBX" Unidad="CAJA" Descripcion="CHICLE MENTA 12/40" ValorUnitario="100.00" Importe="1000.00" Descuento="50.00"/>
    <cfdi:Concepto ClaveProdServ="50161813" Cantidad="5" ClaveUnidad="H87" Descripcion="PALETA FRESA" ValorUnitario="20.00" Importe="100.00"/>
  </cfdi:Conceptos>
</cfdi:Comprobante>`;

  it('lee cada concepto: clave del proveedor intacta, importe neto de descuento, unidad', () => {
    const c = conceptosDelCfdi(xml);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ descripcion: 'CHICLE MENTA 12/40', cantidad: 10, unidad: 'CAJA', sku_proveedor: '0012', importe: 950 });
    expect(c[1]).toMatchObject({ descripcion: 'PALETA FRESA', unidad: 'PZA', importe: 100 });
  });
  it('un concepto solo (fast-xml-parser lo da como objeto) también se lee', () => {
    const uno = xml.replace(/<cfdi:Concepto ClaveProdServ="50161813" Cantidad="5"[^>]*\/>/, '');
    expect(conceptosDelCfdi(uno)).toHaveLength(1);
  });
  it('XML vacío o roto: sin renglones', () => {
    expect(conceptosDelCfdi(null)).toEqual([]);
    expect(conceptosDelCfdi('<no-es-cfdi')).toEqual([]);
  });
});

describe('[PQ.150] de quién es el código: con qué RFC se buscan y se aprenden las equivalencias', () => {
  it('el acreedor sin RFC en Kepler (42 % de las entradas): se busca y se aprende con el de la factura', () => {
    expect(rfcsDelProveedor('', 'qwe141008ab4 ')).toEqual({ aprender: 'QWE141008AB4', fuente: 'factura', buscar: ['QWE141008AB4'] });
    expect(rfcsDelProveedor(null, 'AAA010101AAA')).toEqual({ aprender: 'AAA010101AAA', fuente: 'factura', buscar: ['AAA010101AAA'] });
  });

  it('Kepler trae OTRO RFC (814 pares): se busca con los dos, la factura primero, y se aprende con el de la factura', () => {
    expect(rfcsDelProveedor('QWE14108AB4', 'QWE141008AB4')).toEqual({ aprender: 'QWE141008AB4', fuente: 'factura', buscar: ['QWE141008AB4', 'QWE14108AB4'] });
  });

  it('el mismo RFC en los dos lados no se busca dos veces', () => {
    expect(rfcsDelProveedor(' aaa010101aaa', 'AAA010101AAA').buscar).toEqual(['AAA010101AAA']);
  });

  it('CONTROL: sin factura ligada todo queda como antes (el de Kepler)', () => {
    expect(rfcsDelProveedor('BBB010101BBB', null)).toEqual({ aprender: 'BBB010101BBB', fuente: 'kepler', buscar: ['BBB010101BBB'] });
  });

  it('sin ninguno no se busca ni se aprende, y lo dice', () => {
    expect(rfcsDelProveedor('  ', undefined)).toEqual({ aprender: null, fuente: null, buscar: [] });
  });

  it('al volcar en un mapa gana el primero de la lista (se escribe al último)', () => {
    const filas = [
      { proveedor_rfc: 'FAC010101FAC', sku: 'de-factura' }, { proveedor_rfc: 'KEP010101KEP', sku: 'de-kepler' },
      { proveedor_rfc: 'OTR010101OTR', sku: 'de-otro' },
    ];
    const m = new Map<string, string>();
    for (const f of porPrecedencia(filas, ['FAC010101FAC', 'KEP010101KEP'])) m.set('CODX', f.sku);
    expect(m.get('CODX')).toBe('de-factura');
    const m2 = new Map<string, string>();
    for (const f of porPrecedencia([...filas].reverse(), ['KEP010101KEP', 'FAC010101FAC'])) m2.set('CODX', f.sku);
    expect(m2.get('CODX')).toBe('de-kepler');
  });
});
