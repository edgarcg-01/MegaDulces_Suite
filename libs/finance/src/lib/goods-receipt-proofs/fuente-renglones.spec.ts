import type { RemisionLine } from '@megadulces/platform-core';
import { conceptosDelCfdi, eanValido, lecturaConfiable } from './fuente-renglones';

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
