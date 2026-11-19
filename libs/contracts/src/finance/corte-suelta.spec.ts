/**
 * `[PGP.113]` La regla que suelta una factura de sucursal anterior al corte, afinada en `[PGP.147]`.
 *
 * Los vectores son SINTÉTICOS (el repo es público): reproducen la FORMA de los casos medidos en prod
 * —la factura que Oficinas nunca registró, la que sí copió y pagó, la que tiene un pago por su importe,
 * la que lleva una nota aplicada, la que sólo coincide en importe con la factura de otra sucursal, la
 * que lleva un pago de su propia sucursal— sin nombres ni montos reales.
 */
import {
  anteriorAlCorte, bloqueadaPorCorte, copiaEnOficinas, esDeOtraFactura, leerReferencia, sueltaPorCorte,
  CORTE_OFICINAS, SUCURSAL_DE_SERIE,
} from './corte-suelta.contract';

const ob = (o: Partial<{ obligation_source: string; branch_code: string | null; original_due_date: string | null; entity_ref: string | null }> = {}) => ({
  obligation_source: 'kepler_payable', branch_code: '01', original_due_date: '2026-09-20', entity_ref: 'oblig:01|20|1|0000100', ...o,
});

describe('[PGP.13] anteriorAlCorte', () => {
  it('sucursal, Kepler y vence antes del corte: cae en el candado', () => {
    expect(anteriorAlCorte(ob())).toBe(true);
  });
  it('Oficinas nunca cae: es desde donde se pagaba', () => {
    expect(anteriorAlCorte(ob({ branch_code: '00' }))).toBe(false);
    expect(anteriorAlCorte(ob({ branch_code: ' 00 ' }))).toBe(false);
  });
  it('vence el día del corte o después: no cae', () => {
    expect(anteriorAlCorte(ob({ original_due_date: CORTE_OFICINAS }))).toBe(false);
    expect(anteriorAlCorte(ob({ original_due_date: '2026-10-15T00:00:00.000Z' }))).toBe(false);
  });
  it('lo que no viene de Kepler no cae', () => {
    expect(anteriorAlCorte(ob({ obligation_source: 'supplier_payable' }))).toBe(false);
  });
  it('sin sucursal o sin vencimiento no se inventa: no cae', () => {
    expect(anteriorAlCorte(ob({ branch_code: null }))).toBe(false);
    expect(anteriorAlCorte(ob({ original_due_date: null }))).toBe(false);
  });
});

describe('[PGP.113] sueltaPorCorte', () => {
  const base = { copia_en_oficinas: false, pago_en_oficinas: false, nota_aplicada: false, importe: 1000, pendiente: 1000 };
  it('sin copia en Oficinas, sin pago y sin nada aplicado: se suelta', () => {
    expect(sueltaPorCorte(base)).toBe(true);
  });
  it('⛔ con copia en Oficinas (el mecanismo de antes del corte): se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, copia_en_oficinas: true })).toBe(false);
  });
  it('⛔ con un pago o anticipo de Oficinas por su importe o su pendiente: se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, pago_en_oficinas: true })).toBe(false);
  });
  it('⛔ [PGP.147] con una nota, devolución o ajuste aplicado (así cerró el corte lo que pagó Oficinas): se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, nota_aplicada: true })).toBe(false);
    expect(sueltaPorCorte({ ...base, nota_aplicada: true, pendiente: 400 })).toBe(false);
  });
  it('[PGP.147] lo aplicado por un pago o anticipo de SU sucursal no la bloquea: se programa lo pendiente', () => {
    expect(sueltaPorCorte({ ...base, pendiente: 400 })).toBe(true);
    expect(sueltaPorCorte({ ...base, pendiente: 999.94 })).toBe(true); // el sobrante de un pago que cubrió otras
  });
  it('⛔ sin pendiente, o con pendiente mayor que el importe (dato que no cuadra): se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, pendiente: 0 })).toBe(false);
    expect(sueltaPorCorte({ ...base, pendiente: 0.004 })).toBe(false);
    expect(sueltaPorCorte({ ...base, pendiente: 1000.5 })).toBe(false);
    expect(sueltaPorCorte({ ...base, pendiente: 1000.004 })).toBe(true); // medio centavo de redondeo, no más
  });
  it('⛔ importes que no son número o no son positivos: se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, importe: Number.NaN })).toBe(false);
    expect(sueltaPorCorte({ ...base, pendiente: Number.NaN })).toBe(false);
    expect(sueltaPorCorte({ ...base, importe: 0, pendiente: 0 })).toBe(false);
  });
});

describe('[PGP.147] leerReferencia', () => {
  it('serie de dos dígitos, guion, F opcional y número (sin ceros a la izquierda)', () => {
    expect(leerReferencia('10-1234')).toEqual({ serie: '10', numero: '1234' });
    expect(leerReferencia('10-F1234')).toEqual({ serie: '10', numero: '1234' });
    expect(leerReferencia(' 30-0456 ')).toEqual({ serie: '30', numero: '456' });
    expect(leerReferencia('10-0')).toEqual({ serie: '10', numero: '0' });
  });
  it('⛔ cualquier otra forma no se lee', () => {
    for (const r of ['SUGERIDO', '0-F-1234', '40-S/N', '30', '1234', '10-70C5', '30-Y0175', '', null, undefined]) {
      expect(leerReferencia(r)).toBeNull();
    }
  });
});

describe('[PGP.147] SUCURSAL_DE_SERIE', () => {
  it('cada serie es de UNA sucursal, ninguna es Oficinas y no hay dos series para la misma sucursal', () => {
    const sucursales = Object.values(SUCURSAL_DE_SERIE);
    expect(sucursales).not.toContain('00');
    expect(new Set(sucursales).size).toBe(sucursales.length);
    for (const serie of Object.keys(SUCURSAL_DE_SERIE)) expect(serie).toMatch(/^\d{2}$/);
  });
});

describe('[PGP.147] esDeOtraFactura / copiaEnOficinas', () => {
  // La forma del caso medido: el mismo pedido surtido a varias sucursales, facturas por el mismo importe.
  // Serie `10` = sucursal `01`; serie `30` = sucursal `08` (ver SUCURSAL_DE_SERIE).
  const fac = { sucursal: '01', folio: '0000100', referencia: '10-1234' };
  it('el cargo de Oficinas con la serie de OTRA sucursal y OTRO número es la factura de esa sucursal: no es copia', () => {
    expect(esDeOtraFactura('30-5678', fac)).toBe(true);
    expect(copiaEnOficinas(['30-5678'], fac)).toBe(false);
  });
  it('⛔ la copia de verdad (serie de SU sucursal, con o sin F, por número de factura o por folio) sí es copia', () => {
    expect(esDeOtraFactura('10-F1234', fac)).toBe(false);
    expect(esDeOtraFactura('10-1234', fac)).toBe(false);
    expect(esDeOtraFactura('10-100', fac)).toBe(false);
    expect(esDeOtraFactura('10-9999', fac)).toBe(false); // su misma serie: ante la duda, copia
  });
  it('⛔ serie que no es de ninguna sucursal conocida (un dedazo): ante la duda, copia', () => {
    expect(esDeOtraFactura('45-5678', fac)).toBe(false);
    expect(esDeOtraFactura('01-5678', fac)).toBe(false);
    expect(esDeOtraFactura('00-5678', fac)).toBe(false);
  });
  it('⛔ la serie de la factura se toma de SU sucursal, no de lo que se tecleó en su referencia', () => {
    // La factura de la 08 con una referencia mal tecleada: un cargo con serie 30 sigue siendo de SU sucursal.
    expect(esDeOtraFactura('30-5678', { sucursal: '08', folio: '0000100', referencia: '10-1234' })).toBe(false);
    // Y una factura cuya referencia no se lee se compara igual, por su sucursal y su folio.
    expect(esDeOtraFactura('30-5678', { sucursal: '01', folio: '0000100', referencia: 'SUGERIDO' })).toBe(true);
    expect(esDeOtraFactura('30-5678', { sucursal: '01', folio: '0000100', referencia: null })).toBe(true);
  });
  it('⛔ otra sucursal pero el MISMO número, o uno es la terminación del otro: ante la duda, copia', () => {
    expect(esDeOtraFactura('30-1234', fac)).toBe(false);
    expect(esDeOtraFactura('30-100', fac)).toBe(false);
    expect(esDeOtraFactura('30-F961234', fac)).toBe(false); // abreviado en un lado
    expect(esDeOtraFactura('30-234', fac)).toBe(false); // abreviado en el otro
    expect(esDeOtraFactura('30-0100', fac)).toBe(false); // ceros a la izquierda
  });
  it('⛔ referencia de Oficinas ilegible, o factura sin sucursal: copia', () => {
    expect(esDeOtraFactura('SUGERIDO', fac)).toBe(false);
    expect(esDeOtraFactura(null, fac)).toBe(false);
    expect(esDeOtraFactura('30-5678', { sucursal: '', folio: '0000100', referencia: '10-1234' })).toBe(false);
  });
  it('basta UN cargo que no sea de otra factura para que haya copia', () => {
    expect(copiaEnOficinas(['30-5678', '10-F1234'], fac)).toBe(true);
    expect(copiaEnOficinas(['30-5678', null], fac)).toBe(true);
    expect(copiaEnOficinas(['30-5678', '50-4321'], fac)).toBe(false);
  });
  it('sin cargos por el mismo importe no hay copia', () => {
    expect(copiaEnOficinas([], fac)).toBe(false);
    expect(copiaEnOficinas(null, fac)).toBe(false);
  });
});

describe('[PGP.113] bloqueadaPorCorte', () => {
  const sueltas = new Set(['oblig:01|20|1|0000100']);
  it('la que se soltó ya no está bloqueada', () => {
    expect(bloqueadaPorCorte(ob(), sueltas)).toBe(false);
  });
  it('la que no se soltó sigue bloqueada', () => {
    expect(bloqueadaPorCorte(ob({ entity_ref: 'oblig:01|20|1|0000200' }), sueltas)).toBe(true);
  });
  it('⛔ si la lista no se pudo leer (null), TODAS siguen bloqueadas: falla cerrado', () => {
    expect(bloqueadaPorCorte(ob(), null)).toBe(true);
  });
  it('⛔ sin llave no se suelta aunque la lista traiga algo', () => {
    expect(bloqueadaPorCorte(ob({ entity_ref: null }), sueltas)).toBe(true);
  });
  it('lo que no cae en el candado nunca se bloquea', () => {
    expect(bloqueadaPorCorte(ob({ branch_code: '00' }), null)).toBe(false);
  });
});
