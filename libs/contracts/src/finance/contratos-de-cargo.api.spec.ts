import {
  problemasDeEncabezado, problemasDeRenglon, sePuedeEditar, sePuedeSubirDocumento,
} from './contratos-de-cargo.contract';

/**
 * `[PGP.213]` Lo que la API revisa ANTES de escribir un contrato: las mismas guardas que los CHECK de
 * `finance.charge_contracts` / `_lines` / `_schedule` (migración 20261126001551), dichas en llano. Si una regla se quita,
 * el cuerpo malo llega a la base y la persona ve un error de Postgres en lugar de qué corregir.
 */
describe('[PGP.213] qué se puede cambiar según el estado', () => {
  it('sólo una propuesta se corrige; el PDF, a una propuesta o a un confirmado', () => {
    expect(sePuedeEditar('propuesto')).toBe(true);
    for (const e of ['confirmado', 'terminado', 'cancelado'] as const) expect(sePuedeEditar(e)).toBe(false);
    expect(sePuedeSubirDocumento('propuesto')).toBe(true);
    expect(sePuedeSubirDocumento('confirmado')).toBe(true);
    expect(sePuedeSubirDocumento('terminado')).toBe(false);
    expect(sePuedeSubirDocumento('cancelado')).toBe(false);
  });
});

describe('[PGP.213] el encabezado que manda la pantalla', () => {
  it('uno bien formado no tiene problemas; lo que no viene no se revisa', () => {
    expect(problemasDeEncabezado({ tipo: 'arrendamiento', acreedor: 'Arrendadora del Bajío', cadencia: 'mensual', dia_desde: 12, dia_hasta: 14, inicio: '2026-01-12', fin: '2028-12-12', sucursal: '00' })).toEqual([]);
    expect(problemasDeEncabezado({})).toEqual([]);
  });

  it('⛔ el tipo y la cadencia, del catálogo (= los CHECK kind_ck y cadence_ck)', () => {
    expect(problemasDeEncabezado({ tipo: 'regalo' })[0]).toContain('tipo');
    expect(problemasDeEncabezado({ cadencia: 'anual' })[0]).toContain('mensual o semanal');
  });

  it('⛔ el acreedor de 2 a 200 letras (creditor_ck) y la sucursal de dos dígitos (sucursal_ck)', () => {
    expect(problemasDeEncabezado({ acreedor: ' A ' })[0]).toContain('2 a 200');
    expect(problemasDeEncabezado({ acreedor: 'x'.repeat(201) })[0]).toContain('2 a 200');
    expect(problemasDeEncabezado({ sucursal: '8' })[0]).toContain('dos dígitos');
    expect(problemasDeEncabezado({ sucursal: null })).toEqual([]);
  });

  it('⛔ los días según la cadencia, y «hasta» después de «desde» (days_ck)', () => {
    expect(problemasDeEncabezado({ cadencia: 'mensual', dia_desde: 0 })[0]).toContain('del 1 al 31');
    expect(problemasDeEncabezado({ cadencia: 'semanal', dia_desde: 8 })[0]).toContain('lunes');
    expect(problemasDeEncabezado({ dia_desde: 14, dia_hasta: 12 })).toContain('El día «hasta» va después del día «desde».');
  });

  it('⛔ fechas reales y en orden (term_ck): el 31 de noviembre no existe', () => {
    expect(problemasDeEncabezado({ inicio: '2026-11-31' })[0]).toContain('inicio');
    expect(problemasDeEncabezado({ fin: '12/12/2028' })[0]).toContain('fin');
    expect(problemasDeEncabezado({ inicio: '2026-12-01', fin: '2026-11-01' })).toContain('El contrato termina antes de empezar.');
  });
});

describe('[PGP.213] un renglón que manda la pantalla', () => {
  const fijo = { concepto: 'renta', descripcion: 'Renta mensual', regla_importe: 'fijo', importe_fijo: 21291, cargos_por_periodo: 2 };

  it('uno bien formado no tiene problemas (fijo, estimado y por tabla)', () => {
    expect(problemasDeRenglon(fijo, 1)).toEqual([]);
    expect(problemasDeRenglon({ concepto: 'interes', descripcion: 'Intereses', regla_importe: 'estimado', tasa_referencia: 'TIIE 28', tasa_puntos: 3.5, base_dias: 360 }, 2)).toEqual([]);
    expect(problemasDeRenglon({ concepto: 'capital', descripcion: 'Capital', regla_importe: 'tabla', tabla: [{ fecha: '2026-12-05', importe: 83333.33, saldo: 1000000 }, { fecha: '2027-01-05', importe: 83333.33 }] }, 1)).toEqual([]);
  });

  it('⛔ el importe fijo va SÓLO en un fijo, y ahí es obligatorio (fixed_ck)', () => {
    expect(problemasDeRenglon({ ...fijo, importe_fijo: null }, 1)[0]).toContain('mayor que cero');
    expect(problemasDeRenglon({ ...fijo, importe_fijo: -5 }, 1)[0]).toContain('mayor que cero');
    expect(problemasDeRenglon({ ...fijo, regla_importe: 'estimado' }, 1)[0]).toContain('va vacío');
    expect(problemasDeRenglon({ ...fijo, regla_importe: 'estimado', importe_fijo: null }, 1)).toEqual([]);
  });

  it('⛔ concepto, regla, descripción y cargos por periodo del catálogo (concept_ck, rule_ck, description_ck, charges_ck)', () => {
    expect(problemasDeRenglon({ ...fijo, concepto: 'propina' }, 3)[0]).toMatch(/^Concepto 3: no es renta/);
    expect(problemasDeRenglon({ ...fijo, regla_importe: 'adivinado', importe_fijo: null }, 1).join(' ')).toContain('fijo, por tabla o estimado');
    expect(problemasDeRenglon({ ...fijo, descripcion: 'R' }, 1)[0]).toContain('2 a 200');
    expect(problemasDeRenglon({ ...fijo, cargos_por_periodo: 0 }, 1)[0]).toContain('1 a 31');
    expect(problemasDeRenglon({ ...fijo, cargos_por_periodo: 1.5 }, 1)[0]).toContain('1 a 31');
  });

  it('⛔ la tasa sólo en un interés, con referencia y base 360/365 (rate_ck)', () => {
    expect(problemasDeRenglon({ ...fijo, tasa_referencia: 'TIIE', base_dias: 360 }, 1)).toContain('Concepto 1: la tasa sólo va en un concepto de interés.');
    const interes = { concepto: 'interes', descripcion: 'Intereses', regla_importe: 'estimado' };
    expect(problemasDeRenglon({ ...interes, base_dias: 360 }, 1)[0]).toContain('referencia');
    expect(problemasDeRenglon({ ...interes, tasa_referencia: 'TIIE', base_dias: 300 }, 1)[0]).toContain('360 o 365');
    expect(problemasDeRenglon(interes, 1)).toEqual([]); // sin tasa: el interés se estima (DCR10)
  });

  it('⛔ la tabla: fechas reales sin repetir (line_date_ux), importes > 0 (amount_ck), saldo no negativo (balance_ck)', () => {
    const tabla = (filas: unknown) => problemasDeRenglon({ concepto: 'capital', descripcion: 'Capital', regla_importe: 'tabla', tabla: filas }, 1);
    expect(tabla('no')[0]).toContain('lista');
    expect(tabla([{ fecha: '2026-02-30', importe: 1 }])[0]).toContain('fila 1');
    expect(tabla([{ fecha: '2026-12-05', importe: 1 }, { fecha: '2026-12-05', importe: 2 }])[0]).toContain('ya está en otra fila');
    expect(tabla([{ fecha: '2026-12-05', importe: 0 }])[0]).toContain('mayor que cero');
    expect(tabla([{ fecha: '2026-12-05', importe: 1, saldo: -1 }])[0]).toContain('negativo');
  });
});
