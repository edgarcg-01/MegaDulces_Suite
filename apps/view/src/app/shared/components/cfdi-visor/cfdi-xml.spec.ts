import { describe, it, expect } from 'vitest';
import { leerCfdiXml, urlVerificadorSat } from './cfdi-xml';

/**
 * `[LC.20]` Candado del lector de CFDI. El XML es SINTÉTICO a propósito (el repo es público): la
 * forma es la de un CFDI 4.0 real del ADD — prefijos `cfdi:` / `tfd:`, impuestos por concepto y
 * del comprobante — y los datos son inventados.
 */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Serie="F" Folio="00123" Fecha="2026-10-14T10:00:00" SubTotal="1000.00" Descuento="0.00" Total="1160.00"
  Moneda="MXN" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" Sello="AAAAAAAAAAAAAAAAAAAAqwertyZZ">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="PROVEEDOR DE PRUEBA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="BBB010101BBB" Nombre="RECEPTOR DE PRUEBA" UsoCFDI="G01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="50161800" Cantidad="10" ClaveUnidad="H87" Unidad="PZA" Descripcion="DULCE DE PRUEBA" ValorUnitario="100.000000" Importe="1000.00">
      <cfdi:Impuestos><cfdi:Traslados>
        <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
      </cfdi:Traslados></cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="160.00"><cfdi:Traslados>
    <cfdi:Traslado Base="1000.00" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="160.00"/>
  </cfdi:Traslados></cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="1c170000-0000-4000-8000-000000000001" FechaTimbrado="2026-10-14T10:05:00"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe('leerCfdiXml', () => {
  it('lee encabezado, partes, conceptos, impuestos y timbre tal como los dice el XML', () => {
    const c = leerCfdiXml(XML);
    expect(c).not.toBeNull();
    expect(c?.serie).toBe('F');
    expect(c?.folio).toBe('00123');
    expect(c?.total).toBe(1160);
    expect(c?.emisor).toEqual({ rfc: 'AAA010101AAA', nombre: 'PROVEEDOR DE PRUEBA', regimen: '601' });
    expect(c?.receptor.uso).toBe('G01');
    expect(c?.conceptos).toHaveLength(1);
    expect(c?.conceptos[0]).toMatchObject({ cantidad: 10, clave_unidad: 'H87', descripcion: 'DULCE DE PRUEBA', importe: 1000 });
    expect(c?.conceptos[0].traslados[0]).toMatchObject({ impuesto: 'IVA', tasa: 0.16, importe: 160 });
    expect(c?.traslados).toEqual([{ impuesto: 'IVA', tipo_factor: 'Tasa', tasa: 0.16, base: 1000, importe: 160 }]);
    expect(c?.uuid).toBe('1C170000-0000-4000-8000-000000000001');
    expect(c?.sello_8).toBe('qwertyZZ');
  });

  it('lo que falta viaja como null, no como 0', () => {
    const c = leerCfdiXml(XML.replace(' Descuento="0.00"', '').replace(' MetodoPago="PPD"', ''));
    expect(c?.descuento).toBeNull();
    expect(c?.metodo_pago).toBeNull();
  });

  it('⛔ lo que no es un CFDI devuelve null (no un documento vacío)', () => {
    expect(leerCfdiXml('esto no es xml')).toBeNull();
    expect(leerCfdiXml('<otra:Cosa xmlns:otra="x"/>')).toBeNull();
  });
});

describe('urlVerificadorSat', () => {
  it('arma el enlace del QR con id, re, rr, tt y los últimos 8 del sello', () => {
    const c = leerCfdiXml(XML);
    expect(c).not.toBeNull();
    const u = c ? urlVerificadorSat(c) : null;
    expect(u).toContain('verificacfdi.facturaelectronica.sat.gob.mx');
    expect(u).toContain('id=1C170000-0000-4000-8000-000000000001');
    expect(u).toContain('tt=1160.000000');
    expect(u).toContain('fe=qwertyZZ');
  });

  it('⛔ sin sello no arma un enlace incompleto', () => {
    const c = leerCfdiXml(XML.replace(/ Sello="[^"]*"/, ''));
    expect(c && urlVerificadorSat(c)).toBeNull();
  });
});
