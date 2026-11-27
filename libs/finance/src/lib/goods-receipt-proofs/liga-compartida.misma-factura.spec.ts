/**
 * `[RE.88]` El PDF repetido que es la MISMA factura de otra entrada. Control: el caso real de CEDIS (2026-11-25) —
 * 0010285 ($165,618.07, ya con el PDF) y 0010295 ($530.31) de Relámpago citan `0-F-1979`; la factura vale $165,618.07
 * y el RFC de Kepler tiene un dígito de menos.
 */
import { armarMismaFacturaDuplicado, referenciaCitable, type DatosMismaFactura } from './liga-compartida';

const RFC_SAT = 'TZW141008RS4';
const caso = (p: Partial<DatosMismaFactura> = {}): DatosMismaFactura => ({
  entrada: { proveedor_code: 'CP050', proveedor_rfc: RFC_SAT, referencia: '0-F-1979', monto: 530.31 },
  hermana: { sucursal: '00', folio: '0010285', proveedor_code: 'CP050', referencia: '0-F-1979', monto: 165618.07 },
  otras: [],
  cfdi: { uuid: '7C0FA3CC-3372-4277-BF38-977CCC04335F', total: 165618.07, emisor_rfc: RFC_SAT },
  papelTotal: 165618.07,
  entradaYaLigada: false,
  ...p,
});

describe('[RE.88] referenciaCitable', () => {
  it('una referencia con folio de factura sí cita', () => {
    expect(referenciaCitable(' 0-f-1979 ')).toBe('0-F-1979');
    expect(referenciaCitable('1115')).toBe('1115');
  });
  it('NEGATIVA: los rellenos medidos en prod no citan factura', () => {
    for (const r of ['LPA', '40-S/N', '40 S/N', 'S/N', 's / n', '', null, undefined]) expect(referenciaCitable(r)).toBeNull();
  });
});

describe('[RE.88] armarMismaFacturaDuplicado', () => {
  it('el caso de CEDIS: misma factura, suma contra el SAT y la diferencia a la vista', () => {
    const m = armarMismaFacturaDuplicado(caso())!;
    expect(m.referencia).toBe('0-F-1979');
    expect(m.hermana).toEqual({ sucursal: '00', folio: '0010285', monto: 165618.07 });
    expect(m.suma_entradas).toBe(166148.38);
    expect(m.factura_total).toBe(165618.07);
    expect(m.factura_fuente).toBe('sat');
    expect(m.diferencia).toBe(530.31);
    expect(m.no_se_puede).toBeNull();
  });

  it('con el RFC equivocado de Kepler NO se puede ligar, y dice cuál corregir', () => {
    const m = armarMismaFacturaDuplicado(caso({ entrada: { ...caso().entrada, proveedor_rfc: 'TZW14108RS4' } }))!;
    expect(m.no_se_puede).toContain('TZW14108RS4');
    expect(m.no_se_puede).toContain(RFC_SAT);
  });

  it('NEGATIVA: otro proveedor, otra referencia o una referencia de relleno => no es la misma factura', () => {
    expect(armarMismaFacturaDuplicado(caso({ hermana: { ...caso().hermana, proveedor_code: 'CB011' } }))).toBeNull();
    expect(armarMismaFacturaDuplicado(caso({ hermana: { ...caso().hermana, referencia: '0-F-1980' } }))).toBeNull();
    expect(armarMismaFacturaDuplicado(caso({
      entrada: { ...caso().entrada, referencia: 'S/N' }, hermana: { ...caso().hermana, referencia: 'S/N' },
    }))).toBeNull();
  });

  it('sin CFDI: usa el total del papel, lo dice, y no deja ligar', () => {
    const m = armarMismaFacturaDuplicado(caso({ cfdi: null }))!;
    expect(m.factura_fuente).toBe('papel');
    expect(m.factura_total).toBe(165618.07);
    expect(m.cfdi_uuid).toBeNull();
    expect(m.no_se_puede).toMatch(/ContPAQi/);
  });

  it('las otras entradas ya ligadas entran en la suma; si la destino ya tiene factura, no se liga otra', () => {
    const m = armarMismaFacturaDuplicado(caso({ otras: [{ sucursal: '00', folio: '0010300', monto: 100 }], entradaYaLigada: true }))!;
    expect(m.suma_entradas).toBe(166248.38);
    expect(m.no_se_puede).toMatch(/ya tiene una factura/);
  });
});
