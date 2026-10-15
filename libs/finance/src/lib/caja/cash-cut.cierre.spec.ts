import { decidirConteoDelCierre, esperadoCambio } from './cash-cut.engine';

/**
 * `[CGP-L.1]` y `[CGP-L.2]` — las dos decisiones del cierre, como funciones puras.
 *
 * L.1: un conteo SELLADO no se cambia al cerrar. `cerrar()` usaba lo que viniera en la reja en lugar
 *      del sellado y reescribía el desglose: el arqueo ciego se podía saltar sin recontar.
 * L.2: lo que se firma es lo que se reveló. `cerrar()` recalcula el esperado con el universo de ese
 *      momento y pisaba en silencio el que `contar()` mostró.
 */
describe('[CGP-L.1] decidirConteoDelCierre', () => {
  const sellado = {
    conteo: [{ denom_key: '1000', denominacion: 1000, piezas: 1 }, { denom_key: '500', denominacion: 500, piezas: 1 }],
    morralla: 12.5,
  };

  it('sin conteo sellado, cierra con lo que trae el cuerpo (contar y cerrar en un paso)', () => {
    expect(decidirConteoDelCierre(null, { conteo: sellado.conteo, morralla: 0 })).toEqual({ usar: 'cuerpo' });
  });

  it('con conteo sellado y el cuerpo vacío, usa el sellado (la pantalla después de recargar)', () => {
    expect(decidirConteoDelCierre(sellado, { conteo: [], morralla: 0 })).toEqual({ usar: 'sellado' });
    expect(decidirConteoDelCierre(sellado, {})).toEqual({ usar: 'sellado' });
    // Sin piezas en la reja, la morralla sola no es un conteo nuevo: rechazar acá trabaría un cierre
    // legítimo según cómo mande la pantalla ese campo, y un cierre trabado es el defecto de origen.
    expect(decidirConteoDelCierre(sellado, { conteo: [], morralla: 12.5 })).toEqual({ usar: 'sellado' });
  });

  it('con el MISMO conteo en el cuerpo, usa el sellado (la pantalla sin recargar)', () => {
    const igual = { conteo: [...sellado.conteo].reverse(), morralla: 12.5 };   // el orden no importa
    expect(decidirConteoDelCierre(sellado, igual)).toEqual({ usar: 'sellado' });
  });

  it('una fila sin llave se identifica por su valor, como en el resto del sistema', () => {
    const sinLlave = { conteo: [{ denominacion: 1000, piezas: 1 }, { denominacion: 500, piezas: 1 }], morralla: 12.5 };
    expect(decidirConteoDelCierre(sellado, sinLlave)).toEqual({ usar: 'sellado' });
  });

  it('las filas con cero piezas no cuentan: la reja manda las 15 denominaciones', () => {
    const conCeros = { conteo: [...sellado.conteo, { denom_key: '200', denominacion: 200, piezas: 0 }], morralla: 12.5 };
    expect(decidirConteoDelCierre(sellado, conCeros)).toEqual({ usar: 'sellado' });
  });

  it('⛔ otra cifra en la reja se RECHAZA, con lo sellado y lo tecleado', () => {
    const otro = { conteo: [...sellado.conteo, { denom_key: '100', denominacion: 100, piezas: 3 }], morralla: 12.5 };
    expect(decidirConteoDelCierre(sellado, otro)).toEqual({
      usar: 'rechazo', motivo: 'conteo_distinto', sellado: 1512.5, tecleado: 1812.5,
    });
  });

  it('⛔ la MISMA suma con otra composición también se rechaza: lo sellado es el desglose, no sólo el total', () => {
    const recompuesto = { conteo: [{ denom_key: '500', denominacion: 500, piezas: 3 }], morralla: 12.5 };
    expect(decidirConteoDelCierre(sellado, recompuesto)).toMatchObject({ usar: 'rechazo', motivo: 'conteo_distinto' });
  });

  it('⛔ cambiar sólo la morralla también es cambiar el conteo', () => {
    expect(decidirConteoDelCierre(sellado, { conteo: sellado.conteo, morralla: 20 }))
      .toMatchObject({ usar: 'rechazo', tecleado: 1520 });
  });
});

describe('[CGP-L.2] esperadoCambio', () => {
  it('si nada cambió desde el conteo, firma', () => {
    expect(esperadoCambio(1500, 1500, undefined)).toEqual({ cambio: false, contra: 1500 });
  });

  it('⛔ si entró un movimiento después de contar, el esperado cambió y NO firma en silencio', () => {
    expect(esperadoCambio(1500, 1800, undefined)).toEqual({ cambio: true, contra: 1500 });
  });

  it('quien ya vio el esperado nuevo lo confirma, y se compara contra lo que VIO', () => {
    expect(esperadoCambio(1500, 1800, 1800)).toEqual({ cambio: false, contra: 1800 });
    // Y si volvió a cambiar después de que lo vio, tampoco firma.
    expect(esperadoCambio(1500, 1900, 1800)).toEqual({ cambio: true, contra: 1800 });
  });

  it('un corte sellado antes de que el esperado se guardara (CG.156) se DECLARA: no hay contra qué comparar', () => {
    expect(esperadoCambio(null, 3402.45, undefined)).toEqual({ cambio: false, contra: null });
  });

  it('la comparación es al centavo, sin ruido de coma flotante', () => {
    expect(esperadoCambio(0.3, 0.1 + 0.2, undefined)).toEqual({ cambio: false, contra: 0.3 });
  });
});
