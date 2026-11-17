import { armarGastoKepler, polizaCuadra, type DatosGastoKepler } from './gasto-kepler.armador';

/**
 * `[PGP.123]` G.3 — Candado del armador del gasto `X-A-10` (anexo G §3 y §5.2). La sombra contra los X-A-10 reales de
 * oct–nov (§13) dio póliza idéntica en 1,731 de 1,731 copias y `kdxe` en 1,731 de 1,731; esto fija esas reglas con
 * datos sintéticos (repo público) y cada candado con su caso.
 */
const NOMBRE = 'ACREEDOR DE PRUEBA SOCIEDAD ANONIMA DE CAPITAL VARIABLE';
const solicitud = (over: Record<string, string | number> = {}): Record<string, string | number> => ({
  c1: '05', c2: 'X', c3: 'A', c4: 15, c5: 1, c6: '0000420', c7: 'PESOS', c9: '2026-11-10T00:00:00', c10: 'GZT01',
  c11: 'F-1001', c14: 16, c15: 0, c16: 116, c17: '3', c18: '2026-11-13T00:00:00', c22: 'QZA991231AA1', c24: 'COMENTARIO',
  c25: 'AMPARA CFDI F-1001 DEL 10/11/2026', c26: 'SUITE SG-0A1B2C3D', c30: 'FINANZAS', c31: 'Sol', c32: NOMBRE, c40: 1,
  c41: '1800-01-01T00:00:00', c42: 116, c43: 'A', c48: 'QUIEN SOLICITA', c63: 'XA1501-', c67: 'SUITE', c68: '2026-11-10T00:00:00',
  c69: '09:30', c90: '03', ...over,
});
const renglon = (over: Record<string, string | number> = {}): Record<string, string | number> => ({
  c1: '05', c2: 'X', c3: 'A', c4: 15, c5: 1, c6: '0000420', c7: 1, c8: '611-003', c9: 'GASTO DE PRUEBA', c10: 'C', c11: 100,
  c12: '199', c13: '2-15-26-02', c14: '', c15: '', c16: '1-02-32-00', c17: 0, c18: 0, ...over,
});
const datos = (over: Partial<DatosGastoKepler> = {}): DatosGastoKepler => ({
  sucursal: '05', solicitud: solicitud(), renglones: [renglon()],
  config: { tipoPoliza: 'D', cuentaAcreedor: '201', cuentaIva: '122-001', cuentaRetencion: '122-003' },
  fecha: '2026-11-13', capturadoEn: { fecha: '2026-11-13', hora: '10:15' }, formaPagoVale: null,
  departamentos: new Set(['1-02']), ...over,
});
const armar = (over: Partial<DatosGastoKepler> = {}) => {
  const r = armarGastoKepler(datos(over));
  if (!r.ok) throw new Error(r.motivos.join(' · '));
  return r.plan;
};
const motivos = (over: Partial<DatosGastoKepler> = {}): string => {
  const r = armarGastoKepler(datos(over));
  return r.ok ? '(lo armó)' : r.motivos.join(' · ');
};

describe('[PGP.123] armarGastoKepler', () => {
  it('⭐ kdm1: pisa SÓLO las constantes del gasto y lo propio; lo demás sale de la solicitud clonada', () => {
    const p = armar();
    expect(p.kdm1).toEqual({
      c4: 10, c9: '2026-11-13', c31: 'Gas', c36: 'A', c37: 15, c38: 1, c39: '0000420', c41: '2000-01-01', c42: 116, c43: 'N',
      c63: 'XA1001-', c67: 'SUITE', c68: '2026-11-13', c69: '10:15', c90: '03',
    });
    expect(p.kdm6).toEqual([{ c4: 10, c7: 1 }]);
    expect(p.solicitud).toEqual({ folio: '0000420', saldo: 0, estado: 'F' });
    expect(p.total).toBe(116);
    expect(p.iva).toBe(16);
  });

  it('⭐ kdxe: la cuenta por pagar, derivada (vence en la fecha de pago de la solicitud, c18)', () => {
    expect(armar().kdxe).toEqual({
      c1: '05', c2: 'GZT01', c3: 'A', c4: 10, c5: 1, c7: '2026-11-13', c8: 'PESOS', c9: '3', c10: '2026-11-13',
      c11: 116, c13: 16, c14: 0, c16: 'F-1001', c17: 116, c20: 116, c28: 'X', c29: 'A',
    });
  });

  it('⭐ la póliza D: abono al acreedor por el total, IVA a 122-001, un cargo por renglón con sus segmentos', () => {
    const p = armar();
    expect(p.poliza.tipo).toBe('D');
    expect(p.poliza.fecha).toBe('2026-11-13');
    const r = p.poliza.renglones;
    expect(r.map((x) => [x['c10'], x['c3'], x['c4'], x['c5']])).toEqual([[1, '201', 'A', 116], [2, '122-001', 'C', 16], [3, '611-003', 'C', 100]]);
    // El nombre del acreedor, cortado a 40 como Kepler; la referencia en c7 y su primera letra en c23.
    expect(r[0]['c6']).toBe(NOMBRE.slice(0, 40));
    expect(r[1]['c6']).toBe(NOMBRE.slice(0, 40));
    expect(r[2]['c6']).toBe('GASTO DE PRUEBA');
    for (const x of r) {
      expect(x['c7']).toBe('F-1001');
      expect(x['c23']).toBe('F');
      expect(x['c9']).toBe(x['c5']);
      expect(x['c14']).toBe('05');
      expect(x['c31']).toBe('1800-01-01');
    }
    expect([r[0]['c13'], r[0]['c20'], r[0]['c21']]).toEqual(['', '', '']);
    expect([r[2]['c13'], r[2]['c20'], r[2]['c21']]).toEqual(['1-02-32-00', '199', '2-15-26-02']);
    expect(polizaCuadra(p.poliza, p.total)).toBe(true);
  });

  it('⭐ los acumulados del mes: kdc126 con mayores, kdcn26 con padres de kdc3, y el cargo del acreedor en kdxg', () => {
    const a = armar().acumulados;
    expect(a.mes).toBe(11);
    expect(a.periodo).toBe('2611');
    expect(a.kdc126).toEqual([
      { cuenta: '122', cargo: 16, abono: 0 }, { cuenta: '122-001', cargo: 16, abono: 0 }, { cuenta: '201', cargo: 0, abono: 116 },
      { cuenta: '611', cargo: 100, abono: 0 }, { cuenta: '611-003', cargo: 100, abono: 0 },
    ]);
    expect(a.kdcn26.filter((x) => x.concepto === '199').map((x) => x.departamento).sort()).toEqual(['*', '*', '1-02', '1-02', '1-02-32-00', '1-02-32-00']);
    expect(a.kdcn26.filter((x) => x.concepto === '').every((x) => x.importe === -100)).toBe(true);
    expect(a.kdxg).toEqual({ acreedor: 'GZT01', cargo: 116, fecha: '2026-11-13' });
  });

  it('sin IVA no hay renglón de IVA, y los renglones se numeran seguidos', () => {
    const p = armar({ solicitud: solicitud({ c14: 0, c16: 100, c42: 100 }) });
    expect(p.poliza.renglones.map((x) => [x['c10'], x['c3']])).toEqual([[1, '201'], [2, '611-003']]);
    expect(p.kdxe['c13']).toBe(0);
  });

  it('00 abona a la 203 (lo dice su kdmm), las demás a la 201', () => {
    const p = armar({ sucursal: '00', solicitud: solicitud({ c1: '00' }), renglones: [renglon({ c1: '00' })], config: { tipoPoliza: 'D', cuentaAcreedor: '203', cuentaIva: '122-001', cuentaRetencion: '122-003' } });
    expect(p.poliza.renglones[0]['c3']).toBe('203');
  });

  it('⭐ un renglón sin texto lleva el nombre del acreedor en la póliza (como Kepler: 1 de 1,742 copias de la sombra)', () => {
    const p = armar({ renglones: [renglon({ c9: '' })] });
    expect(p.poliza.renglones[2]['c6']).toBe(NOMBRE.slice(0, 40));
  });

  it('⛔ c23 es la primera letra de la referencia —vacía si no hay referencia— y nunca el «0» del pago', () => {
    const p = armar({ solicitud: solicitud({ c11: '' }) });
    expect(p.poliza.renglones.every((x) => x['c23'] === '' && x['c7'] === '')).toBe(true);
    expect(armar().poliza.renglones.some((x) => x['c23'] === '0')).toBe(false);
  });

  it('DG3: la forma de pago es la de la solicitud; si viene vacía, la del vale; si tampoco, 01 como Kepler', () => {
    expect(armar().kdm1['c90']).toBe('03');
    expect(armar({ solicitud: solicitud({ c90: '' }), formaPagoVale: '04' }).kdm1['c90']).toBe('04');
    expect(armar({ solicitud: solicitud({ c90: '' }) }).kdm1['c90']).toBe('01');
    expect(motivos({ formaPagoVale: 'tarjeta' })).toContain('Forma de pago del vale inválida');
  });

  it('las fechas pueden llegar como Date (pg) o como texto con hora', () => {
    const p = armar({ solicitud: solicitud({ c9: new Date('2026-11-10T00:00:00Z') as unknown as string, c18: '2026-11-14 00:00:00' }) });
    expect(p.kdxe['c10']).toBe('2026-11-14');
  });

  describe('⛔ candados: un motivo basta y se dice', () => {
    it('la solicitud cancelada, ya aplicada o sin autorizar', () => {
      expect(motivos({ solicitud: solicitud({ c43: 'C' }) })).toContain('cancelada');
      expect(motivos({ solicitud: solicitud({ c43: 'F' }) })).toContain('ya está aplicada');
      expect(motivos({ solicitud: solicitud({ c43: 'N' }) })).toContain('no está autorizada');
    });

    it('el saldo ya no es el total (otro gasto la tocó, o uno parcial)', () => {
      expect(motivos({ solicitud: solicitud({ c42: 16 }) })).toContain('ya tiene un gasto');
    });

    it('una retención (DG6)', () => {
      expect(motivos({ solicitud: solicitud({ c15: 1.25, c16: 114.75, c42: 114.75 }) })).toContain('retención');
    });

    it('un renglón sin cuenta: Kepler omitiría su cargo y la póliza no cuadraría (9 pólizas así hoy)', () => {
      expect(motivos({ renglones: [renglon({ c8: '' })] })).toContain('no tiene cuenta contable');
    });

    it('un renglón sin proyecto o departamento: se completa en la solicitud', () => {
      expect(motivos({ renglones: [renglon({ c16: '' })] })).toContain('no trae departamento');
      expect(motivos({ renglones: [renglon({ c13: '' })] })).toContain('no trae proyecto');
    });

    it('la solicitud no cuadra (renglones + IVA ≠ total) o no trae renglones', () => {
      expect(motivos({ renglones: [renglon({ c11: 90 })] })).toContain('no cuadra');
      expect(motivos({ renglones: [] })).toContain('no trae renglones');
    });

    it('un renglón de otra solicitud, o un documento que no es X-A-15', () => {
      expect(motivos({ renglones: [renglon({ c6: '0000999' })] })).toContain('no es de la solicitud');
      expect(motivos({ solicitud: solicitud({ c4: 10 }) })).toContain('no es una solicitud X-A-15-1');
      expect(motivos({ sucursal: '07' })).toContain('es de la sucursal 05');
    });

    it('kdmm distinto de lo medido: Contabilidad cambió algo y no se escribe a ciegas', () => {
      const cfg = { tipoPoliza: 'D', cuentaAcreedor: '201', cuentaIva: '122-001', cuentaRetencion: '122-003' };
      expect(motivos({ config: { ...cfg, tipoPoliza: 'E' } })).toContain('se midió D');
      expect(motivos({ config: { ...cfg, cuentaAcreedor: '205' } })).toContain('se midió 201 o 203');
      expect(motivos({ config: { ...cfg, cuentaIva: '119' } })).toContain('se midió 122-001');
      // Sin IVA, la cuenta del IVA no importa.
      expect(motivos({ solicitud: solicitud({ c14: 0, c16: 100, c42: 100 }), config: { ...cfg, cuentaIva: '' } })).toBe('(lo armó)');
    });

    it('la fecha: de otro año (los acumulados son del año), futura, o anterior a la solicitud', () => {
      expect(motivos({ fecha: '2026-12-31', capturadoEn: { fecha: '2027-01-02', hora: '09:00' } })).toContain('del año en curso');
      expect(motivos({ fecha: '2026-11-14' })).toContain('posterior a hoy');
      expect(motivos({ fecha: '2026-11-09' })).toContain('anterior a la de su solicitud');
      expect(motivos({ fecha: '13/11/2026' })).toContain('Fecha del gasto inválida');
      expect(motivos({ capturadoEn: { fecha: '2026-11-13', hora: '' } })).toContain('cuándo lo escribe la Suite');
    });
  });

  it('⛔ polizaCuadra: un centavo de diferencia, o un abono que no es el total, no cuadra', () => {
    const p = armar().poliza;
    expect(polizaCuadra(p, 116)).toBe(true);
    expect(polizaCuadra(p, 116.01)).toBe(false);
    expect(polizaCuadra({ ...p, renglones: p.renglones.map((x, i) => (i === 2 ? { ...x, c5: 99.99 } : x)) }, 116)).toBe(false);
  });
});
