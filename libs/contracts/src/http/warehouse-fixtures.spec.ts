import {
  FIXTURE_KINDS,
  cabeEnElCroquis,
  expandFixture,
  nombrePieza,
  piezasDerivadas,
  tipoDePieza,
  type WarehouseFixture,
} from './warehouse-fixtures.contract';

/**
 * `[UB.PL.3]`–`[UB.PL.5]` La pieza del croquis. Lo que esto cierra, medido en prod el 2026-11-26:
 * **60 de 315 ubicaciones de Padre Hidalgo (19 %)** eran cabeceras dadas de alta como «pasillos D a
 * H», porque la captura sólo sabía generar `pasillos × racks × niveles` y no había otra forma de
 * expresarlas. El mapa las dibujaba como pasillos: el dibujo no mentía, el dato no podía decir la
 * verdad.
 */

const pieza = (p: Partial<WarehouseFixture>): WarehouseFixture => ({
  id: 'x', warehouse_id: 'w', zona: 'T', tipo: 'anaquel', pasillo: 'A', racks: 17, niveles: 5,
  fila: null, columna: null, orden: null, label: null, ...p,
});

describe('[UB.PL.3] qué puede ser una pieza', () => {
  it('⭐ un anaquel de pasillo tiene DOS frentes; una cabecera NO', () => {
    expect(FIXTURE_KINDS.anaquel.dosFrentes).toBe(true);
    expect(FIXTURE_KINDS.cabecera.dosFrentes).toBe(false);
  });

  it('⭐ una cabecera admite pocos racks: no es un pasillo con otro nombre', () => {
    expect(FIXTURE_KINDS.cabecera.racksMax).toBeLessThan(FIXTURE_KINDS.anaquel.racksMax);
  });

  it('una caja y un mostrador están en el croquis y NO guardan mercancía con código', () => {
    expect(FIXTURE_KINDS.caja.generaCodigos).toBe(false);
    expect(FIXTURE_KINDS.mostrador.generaCodigos).toBe(false);
  });
});

describe('[UB.PL.4] los códigos que produce una pieza', () => {
  it('⭐ una cabecera de 2 racks × 6 niveles produce 12 códigos, con SU letra', () => {
    const r = expandFixture({ zona: 'T', tipo: 'cabecera', pasillo: 'D', racks: 2, niveles: 6 });
    expect(r.ok && r.total).toBe(12);
    expect(r.ok && r.partes[0]).toEqual({ zona: 'T', pasillo: 'D', rack: 1, nivel: 1 });
  });

  it('⭐ un anaquel de 17 × 5 produce los 85 de un pasillo de Padre Hidalgo', () => {
    const r = expandFixture({ zona: 'T', tipo: 'anaquel', pasillo: 'A', racks: 17, niveles: 5 });
    expect(r.ok && r.total).toBe(85);
  });

  it('⭐ una caja produce CERO códigos, y eso no es un error', () => {
    const r = expandFixture({ zona: 'T', tipo: 'caja', pasillo: null, racks: 1, niveles: 1 });
    expect(r).toEqual({ ok: true, total: 0, partes: [] });
  });

  it('⛔ NEGATIVA: una cabecera NO puede pedir 17 racks (sería un pasillo disfrazado otra vez)', () => {
    const r = expandFixture({ zona: 'T', tipo: 'cabecera', pasillo: 'D', racks: 17, niveles: 6 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toContain('de 1 a 4 racks');
  });

  it('⛔ NEGATIVA: una caja con letra de pasillo se rechaza, con el motivo en palabras', () => {
    const r = expandFixture({ zona: 'T', tipo: 'caja', pasillo: 'Z', racks: 1, niveles: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toContain('no guarda mercancía con código');
  });

  it('NEGATIVA: sin letra, sin zona válida o con un tipo inventado, no se genera nada', () => {
    expect(expandFixture({ zona: 'T', tipo: 'anaquel', pasillo: '', racks: 2, niveles: 2 }).ok).toBe(false);
    expect(expandFixture({ zona: 'X' as never, tipo: 'anaquel', pasillo: 'A', racks: 2, niveles: 2 }).ok).toBe(false);
    expect(expandFixture({ zona: 'T', tipo: 'góndola' as never, pasillo: 'A', racks: 2, niveles: 2 }).ok).toBe(false);
  });

  it('NEGATIVA: 0 racks o más niveles de los que existen, tampoco', () => {
    expect(expandFixture({ zona: 'T', tipo: 'anaquel', pasillo: 'A', racks: 0, niveles: 3 }).ok).toBe(false);
    expect(expandFixture({ zona: 'T', tipo: 'anaquel', pasillo: 'A', racks: 3, niveles: 7 }).ok).toBe(false);
  });
});

describe('[UB.PL.5] dos piezas no pueden pisarse', () => {
  it('⭐ dos piezas de la misma zona no comparten letra: producirían los mismos códigos', () => {
    const r = cabeEnElCroquis({ zona: 'T', pasillo: 'A' }, [pieza({ pasillo: 'A' })]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toContain('los mismos códigos');
  });

  it('⭐ dos piezas no ocupan la misma celda del croquis', () => {
    const r = cabeEnElCroquis({ zona: 'T', pasillo: 'B', fila: 1, columna: 2 }, [pieza({ pasillo: 'A', fila: 1, columna: 2 })]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.motivo).toContain('ya está');
  });

  it('⛔ NEGATIVA: la misma letra en OTRA zona sí cabe (bodega y tienda son plantas distintas)', () => {
    expect(cabeEnElCroquis({ zona: 'B', pasillo: 'A' }, [pieza({ zona: 'T', pasillo: 'A' })]).ok).toBe(true);
  });

  it('⛔ NEGATIVA: una pieza no choca CONSIGO MISMA al moverla', () => {
    const a = pieza({ id: 'uno', pasillo: 'A', fila: 1, columna: 1 });
    expect(cabeEnElCroquis({ id: 'uno', zona: 'T', pasillo: 'A', fila: 1, columna: 1 }, [a]).ok).toBe(true);
  });

  it('una pieza sin acomodar todavía (sin fila ni columna) no choca con nadie', () => {
    expect(cabeEnElCroquis({ zona: 'T', pasillo: 'B' }, [pieza({ pasillo: 'A', fila: 1, columna: 1 })]).ok).toBe(true);
  });
});

/**
 * `[UB.PL.2]` Lo que permite configurar Padre Hidalgo sin recapturar nada. Su catálogo del
 * 2026-11-26: pasillos A, B y C con 17 racks × 5 niveles marcados `tienda_piso`, y D a H con 2 × 6
 * marcados `tienda_cabecera`.
 */
describe('[UB.PL.2] las piezas se deducen del catálogo que ya existe', () => {
  const phReal = [
    ...['A', 'B', 'C'].flatMap((p) =>
      Array.from({ length: 17 }, (_, r) => Array.from({ length: 5 }, (_, n) => ({
        zona: 'T' as const, pasillo: p, rack: r + 1, nivel: n + 1, tipo: 'tienda_piso', familia: 'ubicacion',
      }))).flat(),
    ),
    ...['D', 'E', 'F', 'G', 'H'].flatMap((p) =>
      Array.from({ length: 2 }, (_, r) => Array.from({ length: 6 }, (_, n) => ({
        zona: 'T' as const, pasillo: p, rack: r + 1, nivel: n + 1, tipo: 'tienda_cabecera', familia: 'ubicacion',
      }))).flat(),
    ),
  ];

  it('⭐ de las 315 ubicaciones de Padre Hidalgo salen 8 piezas, con su forma real', () => {
    expect(phReal).toHaveLength(315);
    const piezas = piezasDerivadas(phReal);
    expect(piezas).toHaveLength(8);
    expect(piezas.filter((p) => p.tipo === 'anaquel').map((p) => p.pasillo)).toEqual(['A', 'B', 'C']);
    expect(piezas.filter((p) => p.tipo === 'cabecera').map((p) => p.pasillo)).toEqual(['D', 'E', 'F', 'G', 'H']);
  });

  it('⭐ las cabeceras DEJAN de ser pasillos: es el 19 % del catálogo que mentía', () => {
    const piezas = piezasDerivadas(phReal);
    const cabeceras = piezas.filter((p) => p.tipo === 'cabecera');
    expect(cabeceras).toHaveLength(5);
    expect(cabeceras.every((c) => c.racks === 2 && c.niveles === 6)).toBe(true);
    expect(piezas.find((p) => p.pasillo === 'A')).toMatchObject({ tipo: 'anaquel', racks: 17, niveles: 5 });
  });

  it('⭐ y los códigos que produce cada pieza derivada suman las MISMAS 315 (nada se pierde)', () => {
    const total = piezasDerivadas(phReal).reduce((n, p) => {
      const r = expandFixture(p);
      return n + (r.ok ? r.total : NaN);
    }, 0);
    expect(total).toBe(315);
  });

  it('⛔ NEGATIVA: lo que no es familia «ubicacion» no genera pieza (carretas, código libre)', () => {
    expect(piezasDerivadas([
      { zona: null, pasillo: null, rack: null, nivel: null, tipo: null, familia: 'carreta' },
      { zona: null, pasillo: null, rack: null, nivel: null, tipo: null, familia: 'legado' },
    ])).toEqual([]);
  });

  it('⛔ NEGATIVA: si una letra mezcla tipos, gana «cabecera» — es la afirmación, no el supuesto', () => {
    const [p] = piezasDerivadas([
      { zona: 'T', pasillo: 'D', rack: 1, nivel: 1, tipo: 'tienda_piso', familia: 'ubicacion' },
      { zona: 'T', pasillo: 'D', rack: 2, nivel: 1, tipo: 'tienda_cabecera', familia: 'ubicacion' },
    ]);
    expect(p.tipo).toBe('cabecera');
  });

  it('el tipo de USO se traduce al tipo de MUEBLE, y lo desconocido es un anaquel', () => {
    expect(tipoDePieza('tienda_cabecera')).toBe('cabecera');
    expect(tipoDePieza('tienda_piso')).toBe('anaquel');
    expect(tipoDePieza(null)).toBe('anaquel');
  });

  it('la pieza se nombra en palabras de la tienda, y su nombre propio manda', () => {
    expect(nombrePieza({ tipo: 'cabecera', pasillo: 'D', label: null })).toBe('Cabecera D');
    expect(nombrePieza({ tipo: 'anaquel', pasillo: 'A', label: null })).toBe('Anaquel de pasillo A');
    expect(nombrePieza({ tipo: 'caja', pasillo: null, label: 'Caja 3' })).toBe('Caja 3');
  });
});
