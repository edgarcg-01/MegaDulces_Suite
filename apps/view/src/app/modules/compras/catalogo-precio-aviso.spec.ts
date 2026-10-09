/**
 * `[CAT.PRECIO]` El aviso de frescura de la lista de precios.
 *
 * El caso que originó todo es REAL y está medido contra prod el 2026-10-09, buscando el SKU
 * `44430` (`PAL TIPITIN CERVECITA / 20 COLOMBINA`):
 *
 * ```
 * con el término "44430"   → 2026-10-06 15:57:56-06
 * sin término (la lista)   → 2026-10-09 15:44:24-06
 * ```
 *
 * El banner publicaba la primera como si fuera la de toda la red.
 */
import { avisoDePrecio } from './catalogo-precio-aviso';

const LISTA = '2026-10-09T21:44:24.385Z'; // 15:44 -06
const SKU_44430 = '2026-10-06T21:57:56.860Z'; // 15:57 -06, tres dias antes
// ⚠️ 16:00 -06, cuando se miro la pantalla. El primer intento puso `AHORA` 56 SEGUNDOS antes de los
// tres dias exactos y el `floor` daba 2: el fixture estaba mal, no el codigo. Un reloj de prueba
// pegado a un borde mide el borde, no la regla.
const AHORA = new Date('2026-10-09T22:00:00.000Z').getTime();

describe('[CAT.PRECIO] el aviso habla de LA LISTA, no de lo que buscaste', () => {
  it('⭐ el caso real: la lista se movio hoy, aunque el SKU buscado sea del 6 oct', () => {
    const a = avisoDePrecio({ price_updated_at: LISTA, price_updated_at_filtrado: SKU_44430 }, AHORA)!;
    expect(a.viejo).toBe(false);
    expect(a.titulo).toContain('La lista se actualizo el');
    // ⛔ La regresión que se vigila: la fecha del subconjunto NO puede salir en el título.
    expect(a.titulo).not.toContain('6 oct');
  });

  it('⭐ y lo filtrado se DECLARA, no se esconde: el usuario tiene que saber que ve algo viejo', () => {
    const a = avisoDePrecio({ price_updated_at: LISTA, price_updated_at_filtrado: SKU_44430 }, AHORA)!;
    expect(a.detalle).toContain('Lo que estas viendo es mas viejo');
    expect(a.detalle).toContain('hace 3 dias');
  });

  it('⛔ NEGATIVA: un SKU viejo NO puede marcar la lista como rezagada', () => {
    // 40 dias sin reprecio en ESE producto, la lista movida hoy. Antes esto imprimia
    // "Estos precios llevan 40 dias sin actualizarse" sobre toda la red.
    const viejisimo = '2026-08-30T21:00:00.000Z';
    const a = avisoDePrecio({ price_updated_at: LISTA, price_updated_at_filtrado: viejisimo }, AHORA)!;
    expect(a.viejo).toBe(false);
    expect(a.titulo).not.toContain('sin moverse');
  });

  it('la lista SI rezagada se marca — el aviso no se volvio mudo', () => {
    const hace9 = '2026-09-30T21:44:00.000Z';
    const a = avisoDePrecio({ price_updated_at: hace9, price_updated_at_filtrado: null }, AHORA)!;
    expect(a.viejo).toBe(true);
    expect(a.titulo).toContain('dias sin moverse');
  });

  it('⚠️ el borde son 7 dias: a los 7 todavia no es rezago, a los 8 si', () => {
    const d = (n: number) => new Date(AHORA - n * 86400000).toISOString();
    expect(avisoDePrecio({ price_updated_at: d(7), price_updated_at_filtrado: null }, AHORA)!.viejo).toBe(false);
    expect(avisoDePrecio({ price_updated_at: d(8), price_updated_at_filtrado: null }, AHORA)!.viejo).toBe(true);
  });

  it('sin busqueda no se inventa un subconjunto', () => {
    const a = avisoDePrecio({ price_updated_at: LISTA, price_updated_at_filtrado: null }, AHORA)!;
    expect(a.detalle).not.toContain('Lo que estas viendo');
  });

  it('⛔ NEGATIVA: si lo filtrado COINCIDE con la lista no se repite — seria leerse como dos medidas', () => {
    const a = avisoDePrecio({ price_updated_at: LISTA, price_updated_at_filtrado: LISTA }, AHORA)!;
    expect(a.detalle).not.toContain('Lo que estas viendo');
  });

  it('⛔ NEGATIVA: sin fecha se DECLARA, no se dibuja un hoy', () => {
    const a = avisoDePrecio({ price_updated_at: null, price_updated_at_filtrado: SKU_44430 }, AHORA)!;
    expect(a.viejo).toBe(true);
    expect(a.titulo).toContain('No se sabe');
  });

  it('sin stats no hay aviso', () => {
    expect(avisoDePrecio(null, AHORA)).toBeNull();
  });
});
