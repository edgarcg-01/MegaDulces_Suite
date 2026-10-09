// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { roundSeed, diasInventario } from './pedido-redondeo';
import { MotivoTope, roundSeedConTope, textoTope, TOPE_COBERTURA_DIAS } from './pedido-tope';

/**
 * `[RA.45D]` — El candado del tope de 45 días.
 *
 * Lo que de verdad hay que probar acá no es "recorta": es **cuándo NO recorta**. Un tope que
 * recorta de más borra compras reales y nadie lo nota, porque el renglón simplemente sale más
 * chico. Por eso la mitad de este archivo son casos donde el tope tiene que quedarse quieto.
 */

/** Un caso con números de prod: caja de 20 pz, venta 30 d en cajas. */
const CJ = 20;

describe('[RA.45D] el arnés: los números de los casos son los que digo que son', () => {
  it('`diasInventario` usa 30.4 días/mes, que es el convenio del comprador', () => {
    // 10 cajas de existencia contra 10 cajas al mes = un mes = 30.4 días. Si este convenio
    // cambiara, el tope recortaría en otro punto y los días mostrados no cuadrarían con el corte.
    expect(diasInventario(10, 10, 0)).toBeCloseTo(30.4, 6);
  });

  it('`roundSeed` sin tope redondea 0.6 cajas a 1 caja — el origen del problema', () => {
    expect(roundSeed(0.6, CJ)).toEqual({ cajas: 1, unit: 'caja' });
  });
});

describe('[RA.45D] cuándo el tope NO debe tocar nada', () => {
  it('⛔ sin venta no hay cobertura que medir: devuelve el sugerido INTACTO', () => {
    // Éste es el caso peligroso: con venta 0, `venta30 × 45 / 30.4 − exis` da negativo y un tope
    // ingenuo recortaría a 0 TODO producto sin venta — justo los que a veces hay que sembrar.
    const t = roundSeedConTope(3, CJ, 0, 0);
    expect(t.cajas).toBe(3);
    expect(t.motivo).toBe<MotivoTope>('sin_medir');
    expect(t.dias).toBeNull();
  });

  it('⛔ peldaño de unidad contradicho: tampoco topa, y lo declara', () => {
    // La existencia en cajas de esa sucursal no es verdad (U.2), así que los días tampoco.
    const t = roundSeedConTope(3, CJ, 100, 10, true);
    expect(t.cajas).toBe(3);
    expect(t.motivo).toBe<MotivoTope>('sin_medir');
    expect(t.diasHoy).toBeNull();
  });

  it('un pedido que deja menos de 45 días pasa sin tocarse', () => {
    // 10 cj/mes, 0 de existencia: 10 cajas dejan 30.4 días. Cabe de sobra.
    const t = roundSeedConTope(10, CJ, 0, 10);
    expect(t.cajas).toBe(10);
    expect(t.motivo).toBeNull();
    expect(t.dias).toBeCloseTo(30.4, 5);
  });

  it('⭐ uno que cae JUSTO en 45 días no se toca — el tope es un techo, no un margen', () => {
    // Un off-by-one acá recorta renglones perfectamente válidos, uno por uno, sin avisar.
    // 30.4 cj/mes = 1 cj/día, así que 45 días son 45 cajas EXACTAS y el redondeo no interfiere.
    const t = roundSeedConTope(45, CJ, 0, 30.4);
    expect(t.motivo).toBeNull();
    expect(t.cajas).toBe(45);
    expect(t.dias).toBeCloseTo(45, 5);
  });

  it('⭐⭐ pero si el REDONDEO lo empuja por encima, el tope sí entra — y es el caso real', () => {
    // Éste lo encontró el test, no yo: con 10 cj/mes, 45 días son 14.80 cajas, y `roundSeed`
    // redondea a 15 = 45.6 días. O sea que el renglón se pasa del tope **por el redondeo**, que
    // es exactamente el mecanismo que esta fase existe para tapar (3,301 renglones medidos).
    // La primera versión de esta aserción daba el caso por "no se toca" y salió roja con el
    // código correcto: la premisa estaba mal, no la función.
    const sugerido = 45 * 10 / 30.4;                  // 14.8026… cajas
    expect(roundSeed(sugerido, CJ).cajas).toBe(15);   // el redondeo de siempre se pasa
    const t = roundSeedConTope(sugerido, CJ, 0, 10);
    expect(t.motivo).toBe<MotivoTope>('recortado');
    expect(t.cajas).toBe(14);
    expect(t.dias!).toBeLessThanOrEqual(TOPE_COBERTURA_DIAS);
  });

  it('sugerido 0 no inventa un recorte, pero sí publica los días que hay', () => {
    const t = roundSeedConTope(0, CJ, 5, 10);
    expect(t.cajas).toBe(0);
    expect(t.motivo).toBeNull();
    expect(t.diasHoy).toBeCloseTo(15.2, 5);
  });
});

describe('[RA.45D] cuándo SÍ recorta, y cuánto', () => {
  it('recorta al máximo que cabe, sin pasarse nunca', () => {
    // 10 cj/mes, 5 cj en piso. Caben 45×10/30.4 − 5 = 9.80 cj → 9 cajas cerradas.
    const t = roundSeedConTope(30, CJ, 5, 10);
    expect(t.motivo).toBe<MotivoTope>('recortado');
    expect(t.cajas).toBe(9);
    expect(t.dias!).toBeLessThanOrEqual(TOPE_COBERTURA_DIAS);
    expect(t.sugerido).toBe(30);   // ⭐ se conserva lo que pedía el motor, para poder explicarlo
  });

  it('⭐ el resultado NUNCA pasa el tope, barriendo 200 combinaciones', () => {
    // Una sola aserción puntual no prueba un invariante. Esto sí: cualquier combinación de
    // existencia, venta y sugerido tiene que terminar bajo el techo.
    for (let exis = 0; exis < 20; exis++) {
      for (let v = 1; v <= 10; v++) {
        const t = roundSeedConTope(999, CJ, exis, v);
        if (t.dias == null || t.cajas === 0) continue;
        expect(t.dias).toBeLessThanOrEqual(TOPE_COBERTURA_DIAS + 1e-6);
      }
    }
  });

  it('⛔ cuando UNA caja ya pasa el tope, cae a PIEZAS en vez de rendirse a 0', () => {
    // Los 2,643 renglones medidos (33.5%, $2.27 M). Venta 4 pz/mes = 0.2 cj; caben
    // 45×0.2/30.4 = 0.296 cj = 5.9 pz → 5 piezas. Rendirse a 0 acá dejaba sin surtir a una
    // sucursal que sí podía pedir.
    const t = roundSeedConTope(1, CJ, 0, 0.2);
    expect(t.motivo).toBe<MotivoTope>('recortado');
    expect(t.unit).toBe('pieza');
    expect(Math.round(t.cajas * CJ)).toBe(5);
    expect(t.dias!).toBeLessThanOrEqual(TOPE_COBERTURA_DIAS);
  });

  it('⭐ la existencia SOLA por encima del tope → no se compra, con ese motivo', () => {
    // Los 8,023 pares (50.4%, $36.3 M) que ya pasan 45 días sin pedir nada.
    const t = roundSeedConTope(5, CJ, 100, 10);   // 100 cj contra 10 cj/mes = 304 días
    expect(t.cajas).toBe(0);
    expect(t.motivo).toBe<MotivoTope>('ya_pasa_sin_pedir');
    expect(t.diasHoy).toBeCloseTo(304, 0);
  });

  it('hay espacio pero no alcanza ni para una pieza → 0, con motivo distinto', () => {
    // 44.9 días en piso: queda hueco, pero menos de 1 pieza. NO es lo mismo que "ya sobra", y la
    // frase que ve el comprador tampoco.
    const venta = 10, exis = 44.9 * venta / 30.4;
    const t = roundSeedConTope(5, CJ, exis, venta);
    expect(t.cajas).toBe(0);
    expect(t.motivo).toBe<MotivoTope>('no_cabe');
    expect(t.diasHoy!).toBeLessThan(TOPE_COBERTURA_DIAS);
  });

  it('⚠️ uxc inválido no revienta ni divide por cero', () => {
    const t = roundSeedConTope(30, 0, 5, 10);
    expect(Number.isFinite(t.cajas)).toBe(true);
    expect(t.cajas).toBeGreaterThanOrEqual(0);
  });
});

describe('[RA.45D] el tope es un número con nombre, y el motivo se dice', () => {
  it('el tope vigente es 45 días, como lo pidió Edgar', () => {
    expect(TOPE_COBERTURA_DIAS).toBe(45);
  });

  it('⭐ y el tope se puede mover sin tocar la función: 90 deja pasar lo que 45 recorta', () => {
    // Prueba de que el parámetro se HONRA. Sin esto, el tope podría estar clavado adentro y el
    // argumento sería decorativo — el test pasaría igual con cualquier valor.
    const a = roundSeedConTope(30, CJ, 5, 10, false, 45);
    const b = roundSeedConTope(30, CJ, 5, 10, false, 90);
    expect(a.cajas).toBe(9);
    expect(b.cajas).toBeGreaterThan(a.cajas);
  });

  it('cada motivo tiene su frase, y ninguna sale vacía', () => {
    const casos: { t: ReturnType<typeof roundSeedConTope>; esperado: string }[] = [
      { t: roundSeedConTope(30, CJ, 5, 10), esperado: 'Recortado' },
      { t: roundSeedConTope(5, CJ, 100, 10), esperado: 'No se pide' },
      { t: roundSeedConTope(3, CJ, 0, 0), esperado: 'Sin tope' },
    ];
    for (const c of casos) expect(textoTope(c.t)).toContain(c.esperado);
  });

  it('⛔ la frase del recorte nombra lo que el motor pedía, no sólo lo que quedó', () => {
    // Sin el "sugería 30 cj" el comprador no puede saber si el recorte fue grande o cosmético.
    expect(textoTope(roundSeedConTope(30, CJ, 5, 10))).toContain('30');
    expect(textoTope(roundSeedConTope(30, CJ, 5, 10))).toContain('45');
  });
});
