import { esCodigoSimbolico, esNombreDePromocion, marcarCodigosSimbolicos } from './codigo-simbolico.contract';

/**
 * `[ETQ-PROMO.1]` Casos tomados de producción (2026-10-22): lo que SÍ es un código simbólico de Kepler y,
 * con el mismo peso, lo que NO lo es y tiene que seguir diciendo «hay que ponerle precio».
 */
describe('esNombreDePromocion', () => {
  it.each([
    '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS',   // el 09089 que disparó el trabajo
    '$15,000 MONDELEZ = GRATIS 1 CJ CH TRIDENT VALUPACK',
    '5 CJS CAR SUAVE WINIS =GRATIS 1 CJ',          // sin espacio tras el signo
    '3 cjs trident = gratis 1 cj paq diversión',   // minúsculas
  ])('«%s» es una promoción', (n) => expect(esNombreDePromocion(n)).toBe(true));

  it.each([
    'JABON FOCA 250GR',
    '10 CJS OREO BASE 9 KG',                       // sin «= GRATIS»
    'GRATIS POR COMPRA',                           // «gratis» sin el signo no basta
    '',
  ])('«%s» NO lo es', (n) => expect(esNombreDePromocion(n)).toBe(false));

  it('un nombre ausente no es promoción (y no truena)', () => {
    expect(esNombreDePromocion(null)).toBe(false);
    expect(esNombreDePromocion(undefined)).toBe(false);
  });
});

describe('esCodigoSimbolico', () => {
  it('⭐ el 09089: promoción por nombre, a $0.01 en todas las plazas', () => {
    expect(esCodigoSimbolico('10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', true)).toBe(true);
  });

  it('⭐ una promoción que en OTRA plaza sí cotiza (78171) se detecta por el nombre, no por el precio', () => {
    expect(esCodigoSimbolico('3 EXH PAL WINIS = GRATIS 1 EXH MAS', false)).toBe(true);
  });

  it('⭐ «3X2 EN CH POOSH» no dice «= GRATIS»: lo agarra el $0.01 en todas las plazas', () => {
    expect(esCodigoSimbolico('3X2 EN CH POOSH', true)).toBe(true);
    expect(esCodigoSimbolico('3 PROD ANAHUAC= GRATUS 1 CHIPILETA SOLAPA NARANJA', true)).toBe(true); // typo
  });

  it('⛔ [negativa] un producto real sin precio NO es simbólico: sigue pidiendo precio en Kepler', () => {
    // Producto nuevo, todavía a 0.00 en las plazas: `centavoEnTodas` es false (0.00 ≠ 0.01).
    expect(esCodigoSimbolico('JABON FOCA 250GR', false)).toBe(false);
  });

  it('⛔ [negativa] «no se pudo medir» (null) no se convierte en simbólico', () => {
    expect(esCodigoSimbolico('JABON FOCA 250GR', null)).toBe(false);
  });
});

/** `[ETQ-PROMO.2]` La búsqueda de la etiquetera: las promociones SÍ salen, marcadas y después de los productos. */
describe('marcarCodigosSimbolicos', () => {
  const hit = (sku: string, name: string) => ({ sku, name });
  const OREO = hit('09089', '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS');
  const REAL = hit('10245', 'OREO GALLETA 36 G');
  const POOSH = hit('91041', '3X2 EN CAJAS DE POOSH');
  const centavo = new Map<string, boolean>([['09089', true], ['10245', false], ['91041', true]]);

  it('⭐ buscar «oreo» devuelve LOS DOS: el producto sin marca y la promoción marcada', () => {
    const r = marcarCodigosSimbolicos([OREO, REAL], centavo);
    expect(r.map((x) => [x.sku, x.es_promocion])).toEqual([['10245', false], ['09089', true]]);
  });
  it('⭐ la promoción va AL FINAL aunque venga primera (no se confunde con mercancía), y el resto conserva su orden', () => {
    const A = hit('1', 'A'); const B = hit('2', 'B');
    const r = marcarCodigosSimbolicos([POOSH, A, OREO, B], new Map([['91041', true], ['09089', true]]));
    expect(r.map((x) => x.sku)).toEqual(['1', '2', '91041', '09089']);
  });
  it('⭐ «3X2 EN CAJAS DE POOSH» (sin «= GRATIS») se marca por el $0.01 en todas las plazas', () => {
    expect(marcarCodigosSimbolicos([POOSH], centavo)[0].es_promocion).toBe(true);
  });
  it('⛔ [negativa] un producto real nunca se marca, aunque no se sepa su precio en las demás plazas', () => {
    expect(marcarCodigosSimbolicos([REAL], new Map())[0].es_promocion).toBe(false);
  });
  it('⛔ [negativa] ninguna promoción se pierde: la lista devuelta tiene los mismos elementos', () => {
    expect(marcarCodigosSimbolicos([OREO, REAL, POOSH], centavo)).toHaveLength(3);
  });
});
