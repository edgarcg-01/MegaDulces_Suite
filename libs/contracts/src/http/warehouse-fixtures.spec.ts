import {
  CROQUIS_COLUMNAS_MAX,
  MIRAS,
  CROQUIS_FILAS_MAX,
  acomodarCara,
  carasCoherentes,
  carasPorOmision,
  racksDeLaCara,
  type RacksDeCara,
  laOtraCaraDelMueble,
  miraOpuesta,
  plantaDeCaras,
  queTieneEnfrente,
  type FixtureFace,
  type MiraHacia,
  FIXTURE_KINDS,
  acomodar,
  cabeEnElCroquis,
  expandFixture,
  nombreDeCara,
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

/**
 * `[UB.PL.11]` **La planta se arma con caras.** Lo planteó Edgar el 2026-11-26: «¿y si los anaqueles
 * están entre pasillos?». Colocar la pieza entera daba por hecho que una letra es un corredor con
 * sus dos frentes enfrentados, y así un anaquel **entre** dos pasillos —cuyas caras pertenecen a
 * letras distintas— no se podía decir. Al ofrecerle elegir entre los dos modelos contestó que no:
 * «que todo pueda ser configurable, un sistema más libre acomodar».
 */
describe('[UB.PL.11] la planta se arma con caras', () => {
  const cara = (id: string, fila: number | null, columna: number | null, mira: MiraHacia | null): FixtureFace =>
    ({ id, fixture_id: 'f' + id, cara: 'nones', fila, columna, mira });

  describe('cuántas caras tiene cada mueble', () => {
    it('⭐ con qué caras NACE cada mueble (sólo el punto de partida: después se configuran)', () => {
      expect(carasPorOmision('anaquel')).toEqual(['nones', 'pares']);
      expect(carasPorOmision('cabecera')).toEqual(['todos']);
    });

    it('⛔ NEGATIVA: una caja tampoco tiene dos frentes — no se le dibuja un corredor en medio', () => {
      expect(carasPorOmision('caja')).toEqual(['todos']);
    });
  });

  describe('el anaquel ENTRE dos pasillos', () => {
    // El caso de Edgar: A-pares y B-nones son el MISMO mueble, espalda con espalda.
    const aPares = cara('a-pares', 2, 1, 'arriba');
    const bNones = { ...cara('b-nones', 2, 1, 'abajo'), cara: 'pares' as const };
    const aNones = cara('a-nones', 1, 1, 'abajo');
    const todas = [aNones, aPares, bNones];

    it('⭐ dos caras en la misma celda mirando a lados opuestos SON un solo mueble', () => {
      expect(laOtraCaraDelMueble(todas, 'a-pares')?.id).toBe('b-nones');
      expect(laOtraCaraDelMueble(todas, 'b-nones')?.id).toBe('a-pares');
    });

    it('⭐ y cada una sirve a SU corredor: A-pares mira al mismo pasillo que A-nones', () => {
      expect(queTieneEnfrente(todas, 'a-pares')?.id).toBe('a-nones');
      expect(queTieneEnfrente(todas, 'a-nones')?.id).toBe('a-pares');
    });

    it('⛔ NEGATIVA: la cara que da al otro lado NO está enfrente de nadie si ahí no hay nada', () => {
      expect(queTieneEnfrente(todas, 'b-nones')).toBeNull();
    });

    it('⛔ NEGATIVA: un mueble contra la pared no tiene otra cara, y no se la inventa', () => {
      expect(laOtraCaraDelMueble([aNones], 'a-nones')).toBeNull();
    });
  });

  describe('soltar una cara', () => {
    const a = cara('a', 1, 1, 'abajo');
    const b = cara('b', 2, 1, 'arriba');
    const suelta = cara('s', null, null, null);
    const ok = (r: ReturnType<typeof acomodarCara>) => { if (!r.ok) throw new Error(r.motivo); return r.cambios; };

    it('⭐ una cara de la bandeja cae en la celda que se eligió, y nadie más se mueve', () => {
      expect(ok(acomodarCara([a, b, suelta], { id: 's', fila: 2, columna: 1, mira: 'abajo' })))
        .toEqual([{ id: 's', fila: 2, columna: 1, mira: 'abajo' }]);
    });

    it('⛔ NEGATIVA: dos caras mirando al MISMO lado en la misma celda no existen', () => {
      const r = acomodarCara([a, b, suelta], { id: 's', fila: 2, columna: 1, mira: 'arriba' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('un frente por lado');
    });

    it('⭐ soltarla donde ya estaba no escribe nada', () => {
      expect(ok(acomodarCara([a, b], { id: 'a', fila: 1, columna: 1, mira: 'abajo' }))).toEqual([]);
    });

    it('⭐ sacarla de la planta la devuelve a la bandeja', () => {
      expect(ok(acomodarCara([a, b], { id: 'b', fila: null, columna: null, mira: null })))
        .toEqual([{ id: 'b', fila: null, columna: null, mira: null }]);
    });

    it('⛔ NEGATIVA: sin decir hacia dónde mira, no se puede dibujar', () => {
      const r = acomodarCara([a, suelta], { id: 's', fila: 1, columna: 2, mira: null });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('hacia qué lado mira');
    });

    it('⛔ NEGATIVA: renglones y lugares fuera de rango se rechazan con su motivo', () => {
      expect(acomodarCara([a, suelta], { id: 's', fila: 0, columna: 1, mira: 'arriba' }).ok).toBe(false);
      expect(acomodarCara([a, suelta], { id: 's', fila: CROQUIS_FILAS_MAX + 1, columna: 1, mira: 'arriba' }).ok).toBe(false);
      expect(acomodarCara([a, suelta], { id: 's', fila: 1, columna: 0, mira: 'arriba' }).ok).toBe(false);
      expect(acomodarCara([a, suelta], { id: 's', fila: 1, columna: CROQUIS_COLUMNAS_MAX + 1, mira: 'arriba' }).ok).toBe(false);
    });
  });

  describe('la planta que se dibuja', () => {
    it('⭐ una planta vacía abre con una celda libre: hay dónde empezar', () => {
      const p = plantaDeCaras([cara('s', null, null, null)]);
      expect(p.length).toBe(1);
      expect(p[0].length).toBe(1);
      expect(p[0][0]).toEqual({ fila: 1, columna: 1, caras: {}, cuantas: 0 });
    });

    it('⭐ crece un renglón y un lugar más allá de lo ocupado', () => {
      const p = plantaDeCaras([cara('a', 2, 3, 'arriba')]);
      expect(p.length).toBe(3);
      expect(p[0].length).toBe(4);
    });

    it('⭐ la celda compartida trae sus DOS caras, cada una de su lado', () => {
      const p = plantaDeCaras([cara('x', 1, 1, 'arriba'), cara('y', 1, 1, 'abajo')]);
      expect(p[0][0].caras.arriba?.id).toBe('x');
      expect(p[0][0].caras.abajo?.id).toBe('y');
      expect(p[0][0].cuantas).toBe(2);
    });

    it('⛔ NEGATIVA: una cara a medio colocar no se dibuja — no se adivina su lugar', () => {
      const p = plantaDeCaras([cara('a', 1, 1, null), cara('b', 1, null, 'arriba')]);
      expect(p[0][0].cuantas).toBe(0);
    });
  });
});

/**
 * `[UB.PL.11]` **Los pasillos no siempre corren en horizontal.** El croquis real de Padre Hidalgo
 * (que mandó Edgar el 2026-11-26) tiene los anaqueles **en vertical**, con los corredores entre
 * ellos: ahí las caras miran a izquierda y derecha, no arriba y abajo. Con dos direcciones el
 * dibujo habría salido girado 90° respecto de la tienda, y nadie lo habría reconocido.
 */
describe('[UB.PL.11] los pasillos corren para donde corran', () => {
  const cara = (id: string, fila: number, columna: number, mira: MiraHacia): FixtureFace =>
    ({ id, fixture_id: 'f' + id, cara: 'nones', fila, columna, mira });

  it('⭐ hay cuatro lados, y el de enfrente de cada uno es su opuesto', () => {
    expect([...MIRAS].sort()).toEqual(['abajo', 'arriba', 'derecha', 'izquierda']);
    expect(MIRAS.map(miraOpuesta)).toEqual(['abajo', 'izquierda', 'arriba', 'derecha']);
  });

  it('⭐ un corredor VERTICAL: dos muebles de columnas vecinas se miran por el costado', () => {
    const izq = cara('izq', 1, 1, 'derecha');
    const der = cara('der', 1, 2, 'izquierda');
    expect(queTieneEnfrente([izq, der], 'izq')?.id).toBe('der');
    expect(queTieneEnfrente([izq, der], 'der')?.id).toBe('izq');
  });

  it('⛔ NEGATIVA: mirarse de costado NO es estar enfrente si hay una columna de por medio', () => {
    const izq = cara('izq', 1, 1, 'derecha');
    const lejos = cara('lejos', 1, 3, 'izquierda');
    expect(queTieneEnfrente([izq, lejos], 'izq')).toBeNull();
  });

  it('⭐ el mueble entre dos pasillos verticales: una celda, una cara a cada costado', () => {
    const a = cara('a', 1, 2, 'izquierda');
    const b = cara('b', 1, 2, 'derecha');
    expect(laOtraCaraDelMueble([a, b], 'a')?.id).toBe('b');
  });

  it('⛔ NEGATIVA: dos caras al MISMO costado en la misma celda se rechazan', () => {
    const a = cara('a', 1, 2, 'izquierda');
    const suelta = { ...cara('s', 1, 1, 'arriba'), fila: null, columna: null, mira: null } as FixtureFace;
    const r = acomodarCara([a, suelta], { id: 's', fila: 1, columna: 2, mira: 'izquierda' });
    expect(r.ok).toBe(false);
  });
});

/**
 * `[UB.PL.12]` **Qué racks lleva cada cara se configura, no se deduce.** Hasta aquí lo decidía el
 * código —par/non, porque así es Padre Hidalgo—, y eso obligaba a cada tienda a parecerse a aquélla.
 * Edgar: «que sea 100% libre de acomodar el croquis a gustos… todas las preguntas que me hiciste que
 * se puedan resolver desde interfaz».
 */
describe('[UB.PL.12] qué racks lleva una cara', () => {
  const cara = (racks_modo: RacksDeCara, rack_desde: number | null = null, rack_hasta: number | null = null) =>
    ({ id: 'c' + racks_modo + rack_desde, racks_modo, rack_desde, rack_hasta });

  it('⭐ el pasillo clásico: nones de un lado, pares del otro', () => {
    expect(racksDeLaCara(cara('nones'), 6)).toEqual([1, 3, 5]);
    expect(racksDeLaCara(cara('pares'), 6)).toEqual([2, 4, 6]);
  });

  it('⭐ un mueble contra la pared se lleva TODOS los racks en una sola cara', () => {
    expect(racksDeLaCara(cara('todos'), 4)).toEqual([1, 2, 3, 4]);
  });

  it('⭐ una corrida partida por TRAMOS, que es lo que par/non no podía decir', () => {
    expect(racksDeLaCara(cara('rango', 1, 3), 6)).toEqual([1, 2, 3]);
    expect(racksDeLaCara(cara('rango', 4, 6), 6)).toEqual([4, 5, 6]);
  });

  it('⛔ NEGATIVA: una cara que no guarda nada no se lleva un solo rack', () => {
    expect(racksDeLaCara(cara('ninguno'), 20)).toEqual([]);
  });

  it('⛔ NEGATIVA: un tramo no se sale de los racks que el mueble tiene', () => {
    expect(racksDeLaCara(cara('rango', 1, 99), 3)).toEqual([1, 2, 3]);
  });

  describe('las caras de un mueble no se pisan', () => {
    it('⭐ nones y pares se reparten el mueble entero sin tocarse', () => {
      expect(carasCoherentes([cara('nones'), cara('pares')], 10).ok).toBe(true);
    });

    it('⭐ dos tramos que no se solapan también valen', () => {
      expect(carasCoherentes([cara('rango', 1, 5), cara('rango', 6, 10)], 10).ok).toBe(true);
    });

    it('⛔ NEGATIVA: un rack no puede estar en las dos caras del mismo mueble', () => {
      const r = carasCoherentes([cara('todos'), cara('nones')], 6);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('de un lado o del otro');
    });

    it('⛔ NEGATIVA: dos tramos que se montan se rechazan diciendo EN QUÉ rack', () => {
      const r = carasCoherentes([cara('rango', 1, 5), cara('rango', 5, 9)], 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivo).toContain('05');
    });

    it('⛔ NEGATIVA: más de cuatro costados no es un mueble', () => {
      const cinco = [1, 2, 3, 4, 5].map((i) => ({ id: 'c' + i, racks_modo: 'ninguno' as RacksDeCara, rack_desde: null, rack_hasta: null }));
      expect(carasCoherentes(cinco, 10).ok).toBe(false);
    });

    it('⭐ un hueco SIN cara es válido a propósito: una esquina o un paso no necesita frente', () => {
      expect(carasCoherentes([cara('rango', 1, 3)], 10).ok).toBe(true);
    });
  });

  describe('cómo se llama cada cara', () => {
    const anaquel = { tipo: 'anaquel' as const, pasillo: 'A', label: null };

    it('⭐ la cara dice qué lado del pasillo es', () => {
      expect(nombreDeCara(anaquel, { racks_modo: 'nones', label: null })).toBe('Anaquel de pasillo A · nones');
    });

    it('⭐ una cara que se lleva el mueble entero se llama como el mueble, sin sufijo', () => {
      expect(nombreDeCara({ tipo: 'cabecera', pasillo: 'D', label: null }, { racks_modo: 'todos', label: null })).toBe('Cabecera D');
    });

    it('⭐ y su nombre propio manda sobre todo lo demás', () => {
      expect(nombreDeCara(anaquel, { racks_modo: 'nones', label: 'Dulces a granel' })).toBe('Dulces a granel');
    });
  });
});
