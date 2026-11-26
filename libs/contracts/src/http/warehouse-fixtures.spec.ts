import {
  CROQUIS_FILAS_MAX,
  FIXTURE_KINDS,
  acomodar,
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
    // [UB.NV.1] El tope subió a 9 el 2026-11-26: el 7 ya es un nivel legítimo, el 10 no.
    expect(expandFixture({ zona: 'T', tipo: 'anaquel', pasillo: 'A', racks: 3, niveles: 10 }).ok).toBe(false);
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

/**
 * `[UB.PL.8]` **Acomodar.** El croquis existe recién cuando alguien dice dónde está cada mueble;
 * hasta entonces las piezas nacen sin fila ni columna y el mapa las dibuja a todas como pasillos.
 * Un arrastre tiene que ser UNA petición: por eso `acomodar` devuelve sólo lo que se movió.
 */
describe('[UB.PL.8] soltar una pieza en el croquis', () => {
  const a = pieza({ id: 'a', pasillo: 'A', fila: 1, columna: 1 });
  const b = pieza({ id: 'b', pasillo: 'B', fila: 1, columna: 2 });
  const c = pieza({ id: 'c', pasillo: 'C', fila: 1, columna: 3 });
  const nueva = pieza({ id: 'n', pasillo: 'D', fila: null, columna: null });
  const ok = (r: ReturnType<typeof acomodar>) => { if (!r.ok) throw new Error(r.motivo); return r.cambios; };

  it('⭐ una pieza de la bandeja cae al final del renglón, y NADIE más se mueve', () => {
    expect(ok(acomodar([a, b, c, nueva], { id: 'n', fila: 1 }))).toEqual([{ id: 'n', fila: 1, columna: 4 }]);
  });

  it('⭐ soltarla ANTES de otra empuja sólo a las que quedan atrás', () => {
    const cambios = ok(acomodar([a, b, c, nueva], { id: 'n', fila: 1, antes_de: 'b' }));
    expect(cambios).toEqual([
      { id: 'n', fila: 1, columna: 2 },
      { id: 'b', fila: 1, columna: 3 },
      { id: 'c', fila: 1, columna: 4 },
    ]);
    // La que quedó DELANTE del punto de insercion no viaja: es la mitad del ahorro.
    expect(cambios.some((x) => x.id === 'a')).toBe(false);
  });

  it('⭐ sacarla del croquis la devuelve a la bandeja sin renumerar a las demás', () => {
    expect(ok(acomodar([a, b, c], { id: 'b', fila: null }))).toEqual([{ id: 'b', fila: null, columna: null }]);
  });

  it('⛔ NEGATIVA: sacar algo que YA estaba en la bandeja no escribe nada', () => {
    expect(ok(acomodar([a, nueva], { id: 'n', fila: null }))).toEqual([]);
  });

  it('⛔ NEGATIVA: soltarla donde ya estaba no escribe nada', () => {
    expect(ok(acomodar([a, b, c], { id: 'c', fila: 1 }))).toEqual([]);
  });

  it('⛔ NEGATIVA: un renglón 0, uno fraccionario o uno más allá del tope se rechazan con su motivo', () => {
    for (const fila of [0, 1.5, CROQUIS_FILAS_MAX + 1]) {
      const r = acomodar([a, nueva], { id: 'n', fila });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain(`del 1 al ${CROQUIS_FILAS_MAX}`);
    }
  });

  it('⛔ NEGATIVA: una pieza no se suelta sobre sí misma, ni sobre una que no está en ese renglón', () => {
    expect(acomodar([a, b], { id: 'a', fila: 1, antes_de: 'a' }).ok).toBe(false);
    expect(acomodar([a, b, nueva], { id: 'n', fila: 2, antes_de: 'b' }).ok).toBe(false);
  });

  it('⛔ NEGATIVA: una pieza que no es de este croquis no se puede mover', () => {
    const r = acomodar([a, b], { id: 'fantasma', fila: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('no está en el croquis');
  });

  it('⭐ mover una pieza a OTRO renglón la renumera allá y deja el hueco acá', () => {
    const cambios = ok(acomodar([a, b, c], { id: 'a', fila: 2 }));
    expect(cambios).toEqual([{ id: 'a', fila: 2, columna: 1 }]);
    // b y c conservan 2 y 3: las columnas sólo tienen que estar ORDENADAS, no ser consecutivas.
    expect(cambios.some((x) => x.id === 'b' || x.id === 'c')).toBe(false);
  });
});
