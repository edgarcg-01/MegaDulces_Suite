import { AUTHZ_TREE } from '../../core/constants/authz-tree';
import { rankRoutes, score, similarity } from './route-suggest';

/**
 * La sugerencia del 404 se calibró corriéndola contra el árbol real. Esta prueba
 * congela esa calibración: si alguien mueve los pesos o el umbral y empieza a
 * ofrecer rutas que no vienen al caso, se entera acá y no en producción.
 */

const targets = (AUTHZ_TREE.find((a) => a.id === 'view')?.projects ?? []).flatMap((p) =>
  p.modules.filter((m) => !!m.route).map((m) => ({ route: m.route as string, label: m.label })),
);

describe('similarity', () => {
  it('vale 1 en idénticas y 0 con cadena vacía', () => {
    expect(similarity('pricing', 'pricing')).toBe(1);
    expect(similarity('', 'pricing')).toBe(0);
  });

  it('es simétrica', () => {
    expect(similarity('precios', 'pricing')).toBeCloseTo(similarity('pricing', 'precios'), 10);
  });

  it('castiga proporcional al largo, no en absoluto', () => {
    // Una letra de diferencia duele más en una palabra corta que en una larga.
    expect(similarity('red', 'rad')).toBeLessThan(similarity('entradas', 'entrada'));
  });
});

describe('score', () => {
  it('no considera una ruta cuyo último segmento no se parece, aunque acierte el proyecto', () => {
    // La regresión que motivó la compuerta: "mismo proyecto" alcanzaba para
    // cruzar el umbral y CUALQUIER ruta del proyecto salía sugerida.
    expect(score(['comercial', 'xxxxxxxx'], '/comercial/pricing')).toBe(0);
  });

  it('premia acertarle al proyecto', () => {
    expect(score(['comercial', 'pricin'], '/comercial/pricing'))
      .toBeGreaterThan(score(['almacen', 'pricin'], '/comercial/pricing'));
  });
});

describe('rankRoutes contra el árbol real', () => {
  it.each([
    ['/comercial/precios', '/comercial/pricing'],
    ['/comercial/pricin', '/comercial/pricing'],
    ['/comercial/pricing/', '/comercial/pricing'],
    ['/admin/usuarios', '/admin/users'],
    ['/finanzas/banco', '/finanzas/bancos'],
    ['/compras/entrada', '/compras/entradas'],
    ['/comercial/sellout', '/comercial/sell-out'],
    ['/almacen/inventarios', '/almacen/inventory'],
  ])('%s sugiere %s primero', (url, esperada) => {
    expect(rankRoutes(url, targets)[0]?.route).toBe(esperada);
  });

  it.each(['/zzzzz/qqqqq', '/', '/comercial/xxxxxxxx'])(
    'no inventa sugerencias para %s',
    (url) => {
      // En un 404, una sugerencia equivocada es peor que ninguna.
      expect(rankRoutes(url, targets)).toEqual([]);
    },
  );

  it('toda ruta real se encuentra a sí misma como primera opción', () => {
    const fallan = targets.filter((t) => rankRoutes(t.route, targets)[0]?.route !== t.route);
    expect(fallan.map((t) => t.route)).toEqual([]);
  });

  /**
   * `[RD.57]` Prueba negativa del desempate. Dos rutas que terminan en el mismo segmento
   * puntúan **exactamente igual** (mismo proyecto, último segmento idéntico, todos los
   * segmentos compartidos), así que sin la regla de coincidencia exacta desempataba el orden
   * del arreglo y la ruta anidada no se encontraba a sí misma. Se prueba con el caso que lo
   * destapó y **en los dos órdenes**: un empate que se rompe por casualidad no está roto.
   */
  it('una coincidencia exacta gana aunque empate el puntaje, en cualquier orden', () => {
    const a = { route: '/comercial/rentabilidad' };
    const b = { route: '/comercial/ruta-directa/rentabilidad' };
    expect(rankRoutes(b.route, [a, b])[0]?.route).toBe(b.route);
    expect(rankRoutes(b.route, [b, a])[0]?.route).toBe(b.route);
    expect(rankRoutes(a.route, [a, b])[0]?.route).toBe(a.route);
    expect(rankRoutes(a.route, [b, a])[0]?.route).toBe(a.route);
  });

  it('sobre una ruta exacta casi no ofrece alternativas', () => {
    const promedio =
      targets.reduce((a, t) => a + rankRoutes(t.route, targets).length, 0) / targets.length;
    expect(promedio).toBeLessThan(1.5); // 1.0 = sin ruido; medido 1.24
  });

  it('nunca devuelve más de tres', () => {
    for (const t of targets) expect(rankRoutes(t.route, targets).length).toBeLessThanOrEqual(3);
  });
});
