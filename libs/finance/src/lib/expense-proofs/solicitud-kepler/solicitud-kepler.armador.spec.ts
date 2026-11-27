import { armarSolicitudKepler, COLUMNAS_QUE_VARIAN, marcaDeLaSolicitud, type DatosSolicitudKepler } from './solicitud-kepler.armador';

/** Una solicitud de mantenimiento vehicular, como la pediría la Suite (datos sintéticos: el repo es público). */
const base = (): DatosSolicitudKepler => ({
  sucursal: '08', acreedor: 'GA022', fechaSolicitud: '2026-11-13', fechaPago: null,
  renglones: [{ concepto: '240', proyecto: '2-15-26-02', departamento: '1-02-32-15', importe: 5498.4 }],
  iva: 0,
  comprobante: { tipo: 'ticket', folio: '1198', fecha: '2026-11-12' },
  comentario: 'Mantenimiento vehicular', solicita: 'usuario_prueba', formaPago: 'transferencia',
  marca: 'SUITE SG-6F9A1B2C', estado: 'A', capturadaEn: { fecha: '2026-11-13', hora: '17:42' },
});

describe('[PGP.122.7] armarSolicitudKepler — la X-A-15 como la escribe Kepler', () => {
  it('pisa sólo columnas que varían en una solicitud real, con las dos fechas donde decidió Francisco', () => {
    const r = armarSolicitudKepler(base());
    if (!r.ok) throw new Error(r.motivos.join('; '));
    const { kdm1, kdm6 } = r.plan;
    expect(Object.keys(kdm1).every((k) => (COLUMNAS_QUE_VARIAN as readonly string[]).includes(k))).toBe(true);
    expect(kdm1).toMatchObject({
      c1: '08', c9: '2026-11-13', c10: 'GA022', c11: '1198', c14: 0, c15: 0, c16: 5498.4, c17: '0', c18: '2026-11-13',
      c24: 'MANTENIMIENTO VEHICULAR', c25: 'AMPARA TICKET 1198 DEL 12/11/2026', c26: 'SUITE SG-6F9A1B2C',
      c30: 'FINANZAS', c42: 5498.4, c43: 'A', c48: 'USUARIO_PRUEBA', c67: 'SUITE', c68: '2026-11-13', c69: '17:42', c90: '03',
    });
    expect(kdm1).not.toHaveProperty('c6');
    expect(kdm1).not.toHaveProperty('c32');
    expect(kdm6).toEqual([{ c1: '08', c2: 'X', c3: 'A', c4: 15, c5: 1, c7: 1, c10: 'C', c11: 5498.4, c12: '240', c13: '2-15-26-02', c14: '', c15: '', c16: '1-02-32-15', c17: 0, c18: 0 }]);
  });
  it('c16 = Σ renglones + IVA, en centavos; la fecha de pago da el plazo (c17 TEXTO, c18 = c9 + c17)', () => {
    const r = armarSolicitudKepler({ ...base(), renglones: [{ concepto: '240', proyecto: 'P', departamento: 'D', importe: 0.1 }, { concepto: '240', proyecto: 'P', departamento: 'D', importe: 0.2 }], iva: 0.05, fechaPago: '2026-11-20' });
    if (!r.ok) throw new Error(r.motivos.join('; '));
    expect(r.plan.kdm1).toMatchObject({ c16: 0.35, c14: 0.05, c42: 0.35, c17: '7', c18: '2026-11-20' });
    expect(r.plan.kdm6.map((x) => x.c7)).toEqual([1, 2]);
  });
  it('c90: sólo los códigos decodificados; «vales» (07, sin decodificar) va vacío', () => {
    const vales = armarSolicitudKepler({ ...base(), formaPago: 'vales' });
    expect(vales.ok && vales.plan.kdm1.c90).toBe('');
    const efectivo = armarSolicitudKepler({ ...base(), formaPago: 'efectivo' });
    expect(efectivo.ok && efectivo.plan.kdm1.c90).toBe('01');
  });
  it('en F (como nacen las de comisiones, CB.62) el saldo c42 es 0', () => {
    const r = armarSolicitudKepler({ ...base(), estado: 'F' });
    expect(r.ok && r.plan.kdm1.c42).toBe(0);
  });
  it('los textos van como los escribe Kepler: mayúsculas, sin acentos ni comillas, recortados a su columna', () => {
    const r = armarSolicitudKepler({ ...base(), comentario: "Refacción 'urgente' para la camioneta de reparto de Zamora — ruta 21 y 22", comprobante: { tipo: 'cfdi', folio: 'A'.repeat(40), fecha: '2026-11-12' } });
    if (!r.ok) throw new Error(r.motivos.join('; '));
    expect(r.plan.kdm1.c24).toMatch(/^REFACCION URGENTE PARA/);
    expect(String(r.plan.kdm1.c24).length).toBeLessThanOrEqual(60);
    expect(String(r.plan.kdm1.c11)).toHaveLength(20);
    expect(String(r.plan.kdm1.c25)).toMatch(/ DEL 12\/11\/2026$/);
  });
  it('⛔ NEGATIVA — cada cosa que Kepler no aceptaría se rechaza con su motivo, sin armar nada', () => {
    const casos: Array<[string, Partial<DatosSolicitudKepler>, RegExp]> = [
      ['camioneta', { sucursal: '01-005' }, /Sucursal/],
      ['acreedor de 8', { acreedor: 'GFS00001' }, /Acreedor/],
      ['sin renglones', { renglones: [] }, /renglones/],
      ['importe con 3 decimales', { renglones: [{ concepto: '240', proyecto: 'P', departamento: 'D', importe: 1.005 }] }, /importe/],
      ['concepto con comilla', { renglones: [{ concepto: "24'0", proyecto: 'P', departamento: 'D', importe: 1 }] }, /concepto/],
      ['proyecto de 2025 en 2026', { renglones: [{ concepto: '240', proyecto: '2-15-25-02', departamento: 'D', importe: 1 }] }, /proyecto/],
      ['pago antes de la solicitud', { fechaPago: '2026-11-01' }, /anterior/],
      ['sin fecha del documento', { comprobante: { tipo: 'ticket', folio: '1', fecha: null } }, /AMPARA/],
      ['sin marca', { marca: 'X' }, /marca/],
      ['estado N', { estado: 'N' as never }, /Estado/],
      ['forma de pago inventada', { formaPago: 'bitcoin' }, /Forma de pago/],
      ['sin hora', { capturadaEn: { fecha: '2026-11-13', hora: '5pm' } }, /cuándo/],
    ];
    for (const [nombre, cambio, rx] of casos) {
      const r = armarSolicitudKepler({ ...base(), ...cambio });
      expect(r.ok, nombre).toBe(false);
      if (!r.ok) expect(r.motivos.join(' | '), nombre).toMatch(rx);
    }
  });
});

describe('[PGP.122.7] marcaDeLaSolicitud', () => {
  it('SUITE SG- + los primeros 8 hexadecimales del vale', () => {
    expect(marcaDeLaSolicitud('6f9a1b2c-3d4e-4f50-8a1b-2c3d4e5f6a7b')).toBe('SUITE SG-6F9A1B2C');
  });
  it('⛔ NEGATIVA — sin un id de vale no hay marca', () => {
    expect(marcaDeLaSolicitud('')).toBe('');
    expect(marcaDeLaSolicitud('abc')).toBe('');
  });
});

/**
 * `[CB.62.4]` El gasto SIN papel que lo ampare — lo declara quien llama, nunca se deduce.
 *
 * Nace del canario del 2026-11-26: las comisiones de la terminal las cobra el banco en el estado de
 * cuenta, no hay ticket ni CFDI que fechar, y el armador rechazaba el día entero con «Falta la fecha
 * del documento que ampara el gasto (DS15)». Medido ese día en el ODS (acreedor GB%, desde
 * septiembre): de 690 X-A-15 y 653 X-A-10 de comisiones, CERO llevan renglón AMPARA.
 */
describe('[CB.62.4] una solicitud sin documento que la ampare', () => {
  it('con la bandera, se arma y c25 queda VACÍO', () => {
    const r = armarSolicitudKepler({ ...base(), comprobante: { tipo: 'ticket', folio: 'REF-1', fecha: null }, sinDocumentoQueAmpare: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kdm1['c25']).toBe('');
    // c11 NO se pierde: la referencia de la sucursal va aunque no haya documento.
    expect(r.plan.kdm1['c11']).toBe('REF-1');
  });

  it('⛔ SIN la bandera sigue siendo un error: a un ticket sin fecha no se le perdona', () => {
    const r = armarSolicitudKepler({ ...base(), comprobante: { tipo: 'ticket', folio: 'REF-1', fecha: null } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos.join(' ')).toMatch(/AMPARA/);
  });

  it('y con documento Y bandera, gana el documento: si hay papel, se escribe su AMPARA', () => {
    const r = armarSolicitudKepler({ ...base(), comprobante: { tipo: 'ticket', folio: '1198', fecha: '2026-11-12' }, sinDocumentoQueAmpare: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(String(r.plan.kdm1['c25'])).toMatch(/^AMPARA TICKET 1198 DEL 12\/11\/2026$/);
  });
});
