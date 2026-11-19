import { armarQuienTrabajaLasRutas, elegirQuienDeRuta, mismaPersona, numeroDeEtiqueta } from './quien-trabaja-la-ruta';

/**
 * `[MKT.29]` Quién trabaja cada ruta: una sola respuesta para el ranking de promociones y Ventas por
 * ruta. Orden: comisión → asignación de la Suite → nombre de persona en Kepler → nadie.
 */

describe('[MKT.29] elegirQuienDeRuta: el orden de las fuentes', () => {
  it('⭐ la comisión manda; las personas asignadas que NO son el chofer se devuelven aparte', () => {
    expect(elegirQuienDeRuta({
      comision: 'JUAN PEREZ', kepler: 'OTRO KEPLER',
      asignados: [{ nombre: 'Juan Pérez López', dias: 6 }, { nombre: 'ANA RUIZ', dias: 2 }],
    })).toEqual({ nombre: 'JUAN PEREZ', fuente: 'comision', otros: ['ANA RUIZ'] });
  });
  it('sin comisión: la persona asignada con más días; las demás, apoyo', () => {
    expect(elegirQuienDeRuta({ asignados: [{ nombre: 'B', dias: 1 }, { nombre: 'A', dias: 6 }], kepler: 'K' }))
      .toEqual({ nombre: 'A', fuente: 'asignacion', otros: ['B'] });
  });
  it('sin comisión ni asignación: el nombre de persona que trae Kepler', () => {
    expect(elegirQuienDeRuta({ kepler: 'RVMA01 PERSONA' })).toEqual({ nombre: 'RVMA01 PERSONA', fuente: 'kepler', otros: [] });
  });
  it('[negativa] nadie (o sólo vacíos) → null, no se inventa un nombre', () => {
    expect(elegirQuienDeRuta({})).toBeNull();
    expect(elegirQuienDeRuta({ comision: '  ', asignados: [{ nombre: ' ', dias: 3 }], kepler: '' })).toBeNull();
  });
});

describe('[MKT.29] mismaPersona: dos capturas a mano del mismo nombre', () => {
  it('ignora acentos, mayúsculas y un apellido de más', () => {
    expect(mismaPersona('José Martínez', 'JOSE MARTINEZ')).toBe(true);
    expect(mismaPersona('JOSE MARTINEZ', 'JOSE MARTINEZ LOPEZ')).toBe(true);
  });
  it('[negativa] un prefijo que no es palabra completa no es la misma persona', () => {
    expect(mismaPersona('ANA', 'ANABEL RUIZ')).toBe(false);
    expect(mismaPersona('', 'ANA')).toBe(false);
  });
});

describe('[MKT.29] numeroDeEtiqueta: la ruta directa se liga por el número de su etiqueta', () => {
  it('«RUTA 501», «ruta 22» y «502» a secas', () => {
    expect(numeroDeEtiqueta('RUTA 501')).toBe('501');
    expect(numeroDeEtiqueta(' ruta 22 ')).toBe('22');
    expect(numeroDeEtiqueta('502')).toBe('502');
  });
  it('[negativa] una etiqueta que no es sólo un número de ruta no liga', () => {
    expect(numeroDeEtiqueta('RUTA VECINAL PH 01')).toBeNull();
    expect(numeroDeEtiqueta('RUTA 21 B')).toBeNull();
    expect(numeroDeEtiqueta(null)).toBeNull();
  });
});

describe('[MKT.29] armarQuienTrabajaLasRutas: las ligas', () => {
  const asig = (sucursal: string | null, codigo: string | null, etiqueta: string, nombre: string | null, dias = 6) =>
    ({ sucursal, codigo, etiqueta, nombre, dias });

  it('⭐ dos filas del catálogo con el mismo número («RUTA 501» dos veces) se juntan, sin repetir a la persona', () => {
    const q = armarQuienTrabajaLasRutas([], [
      asig(null, null, 'RUTA 501', 'TITULAR', 6), asig(null, null, 'RUTA 501', 'TITULAR', 2), asig(null, null, 'RUTA 501', 'APOYO', 1),
    ], []);
    expect(q.de('501')).toEqual({ nombre: 'TITULAR', fuente: 'asignacion', otros: ['APOYO'] });
  });
  it('la vecinal ligada por erp_* se encuentra con su sucursal', () => {
    const q = armarQuienTrabajaLasRutas([], [asig('07', '2V003', 'RUTA VECINAL', 'VENDEDORA')], []);
    expect(q.de('2V003', '07')?.nombre).toBe('VENDEDORA');
    // vendió en otra sucursal: la única liga con esa clave sigue siendo ella
    expect(q.de('2V003', '01')?.nombre).toBe('VENDEDORA');
  });
  it('[negativa] una clave de Kepler con sucursal NO usa la liga por etiqueta de una camioneta', () => {
    const q = armarQuienTrabajaLasRutas([], [asig(null, null, 'RUTA 21', 'CHOFER CAMIONETA')], []);
    expect(q.de('21', '01')).toBeNull();
    expect(q.de('21')?.nombre).toBe('CHOFER CAMIONETA'); // control: la camioneta sí
  });
  it('[negativa] la misma clave en dos sucursales y sin sucursal para desempatar: no se adivina', () => {
    const q = armarQuienTrabajaLasRutas([], [asig('01', '20005', 'X', 'UNO'), asig('08', '20005', 'Y', 'DOS')], []);
    expect(q.de('20005')).toBeNull();
    expect(q.de('20005', '08')?.nombre).toBe('DOS');
  });
  it('comisión y Kepler se buscan por el código de la ruta', () => {
    const q = armarQuienTrabajaLasRutas([{ ruta: '505', nombre: 'CHOFER' }], [], [{ ruta: '1V004', nombre: 'PERSONA KEPLER' }]);
    expect(q.de('505')).toEqual({ nombre: 'CHOFER', fuente: 'comision', otros: [] });
    expect(q.de('1V004', '04')?.fuente).toBe('kepler');
    expect(q.de('')).toBeNull();
  });
});
