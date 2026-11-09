import {
  SIN_DEPARTAMENTO, agruparPorDepartamento, nombreDeDepartamento, repartirPorDepartamento,
} from './departamentos-del-vale';

/**
 * `[GX.98]` El departamento del gasto sale de Kepler (`kdm6.c16` → `kdc3`), no del capturado (que
 * dice «Sucursal NN» en los 1,672 vales de prod). Un vale repartido va en cada departamento con su
 * parte, y las partes suman el importe al centavo.
 */
describe('[GX.98] repartirPorDepartamento', () => {
  it('un solo departamento se lleva todo el importe', () => {
    expect(repartirPorDepartamento([{ clave: '1-02-30-00', nombre: 'MORELIA ABASTOS.', importe: 862.07 }], 1000))
      .toEqual([{ clave: '1-02-30-00', nombre: 'MORELIA ABASTOS', importe: 1000 }]);
  });

  /** ⭐ Los renglones pueden venir sin IVA (458 vales en prod): manda la proporción, no el renglón. */
  it('⭐ reparte en proporción a los renglones, aunque vengan sin IVA', () => {
    const r = repartirPorDepartamento([
      { clave: 'A', nombre: 'UNO', importe: 400 }, // los renglones suman 1,000 (sin IVA)
      { clave: 'B', nombre: 'DOS', importe: 600 }, // y el vale es de 1,250
    ], 1250);
    expect(r.map((d) => d.importe)).toEqual([750, 500]);
  });

  /** ⭐ Las partes suman el importe EXACTO: si no, los totales por grupo no cuadran con el total. */
  it('⭐ las partes suman el importe al centavo, aunque la división no sea exacta', () => {
    const r = repartirPorDepartamento([
      { clave: 'A', nombre: null, importe: 1 }, { clave: 'B', nombre: null, importe: 1 }, { clave: 'C', nombre: null, importe: 1 },
    ], 100);
    expect(r.reduce((s, d) => s + Math.round(d.importe * 100), 0)).toBe(10000);
    expect(r.map((d) => d.importe).sort()).toEqual([33.33, 33.33, 33.34]);
  });

  it('el mismo departamento en varios renglones se junta', () => {
    const r = repartirPorDepartamento([
      { clave: 'A', nombre: 'UNO', importe: 100 }, { clave: 'A', nombre: 'UNO', importe: 100 }, { clave: 'B', nombre: 'DOS', importe: 200 },
    ], 400);
    expect(r).toHaveLength(2);
    expect(r.find((d) => d.clave === 'A')?.importe).toBe(200);
  });

  it('renglones en cero: reparte parejo, no divide entre cero', () => {
    const r = repartirPorDepartamento([{ clave: 'A', nombre: null, importe: 0 }, { clave: 'B', nombre: null, importe: 0 }], 10);
    expect(r.map((d) => d.importe)).toEqual([5, 5]);
  });

  it('sin departamento en Kepler: vacío (la pantalla lo dice)', () => {
    expect(repartirPorDepartamento([], 100)).toEqual([]);
    expect(repartirPorDepartamento([{ clave: '  ', nombre: null, importe: 9 }], 100)).toEqual([]);
  });

  it('el nombre de Kepler sin el punto final', () => {
    expect(nombreDeDepartamento('CANINDO .')).toBe('CANINDO');
    expect(nombreDeDepartamento('  ')).toBeNull();
  });
});

describe('[GX.98] agruparPorDepartamento', () => {
  const V = (id: string, importe: number, departamentos: { clave: string; nombre: string | null; importe: number }[] | null) =>
    ({ id, importe, departamentos });

  /** ⭐ Decisión del usuario: el repartido aparece en CADA departamento, con su parte. */
  it('⭐ un vale repartido cuenta en cada departamento, con su parte', () => {
    const g = agruparPorDepartamento([
      V('v1', 1250, [{ clave: 'A', nombre: 'MORELIA', importe: 750 }, { clave: 'B', nombre: 'CANINDO', importe: 500 }]),
      V('v2', 300, [{ clave: 'A', nombre: 'MORELIA', importe: 300 }]),
    ]);
    expect(g.map((x) => [x.etiqueta, x.n, x.monto, x.ids])).toEqual([
      ['MORELIA', 2, 1050, ['v1', 'v2']],
      ['CANINDO', 1, 500, ['v1']],
    ]);
    // Las partes de todos los grupos suman el total de la lista.
    expect(g.reduce((s, x) => s + x.monto, 0)).toBe(1550);
  });

  it('lo que no tiene departamento va a su grupo, al final, y lo dice', () => {
    const g = agruparPorDepartamento([V('v1', 10, []), V('v2', 20, [{ clave: 'A', nombre: 'UNO', importe: 20 }])]);
    expect(g[g.length - 1]).toMatchObject({ clave: SIN_DEPARTAMENTO, etiqueta: 'Sin departamento en Kepler', origen: 'sin_clasificar', n: 1, monto: 10 });
  });

  /** ⛔ No se pudo leer ≠ no tiene: se dice distinto. */
  it('⛔ si Kepler no se pudo leer, el grupo lo dice', () => {
    expect(agruparPorDepartamento([V('v1', 10, null)])[0].etiqueta).toBe('Sin leer en Kepler');
  });

  it('el código sin nombre en el catálogo se muestra con su clave', () => {
    expect(agruparPorDepartamento([V('v1', 10, [{ clave: '9-99', nombre: null, importe: 10 }])])[0].etiqueta).toBe('9-99');
  });

  it('los grupos de Kepler se marcan como tales', () => {
    expect(agruparPorDepartamento([V('v1', 10, [{ clave: 'A', nombre: 'UNO', importe: 10 }])])[0].origen).toBe('kepler');
  });
});
