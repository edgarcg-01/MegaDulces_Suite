import { Permission } from '../../../core/constants/permissions';
import type { PageTab } from './page-tabs.component';
import { pestanaVisible, primeraPestanaVisible, urlEnPestanas } from './pestanas-de-area';

/**
 * `[GX.80]` La regla de un área con pestañas. La usan la barra (`app-page-tabs`) y la entrada del
 * menú lateral: si se rompe acá, el menú puede ofrecer una pantalla que la barra no muestra.
 */
const A: PageTab = { label: 'A', route: '/x/a', permission: Permission.FINANCE_EXPENSES_COMPROBAR };
const B: PageTab = { label: 'B', route: '/x/b', anyOf: [Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR] };
const C: PageTab = { label: 'C', route: '/x/c', alsoActiveOn: ['/x/c-otra'] };

const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);

describe('[GX.80] pestanaVisible', () => {
  it('con `permission`, hace falta ese permiso', () => {
    expect(pestanaVisible(A, con(Permission.FINANCE_EXPENSES_COMPROBAR))).toBe(true);
    expect(pestanaVisible(A, con(Permission.FINANCE_EXPENSES_VER))).toBe(false);
  });

  it('con `anyOf`, basta uno', () => {
    expect(pestanaVisible(B, con(Permission.FINANCE_EXPENSES_CAPTURAR))).toBe(true);
    expect(pestanaVisible(B, con(Permission.FINANCE_EXPENSES_COMPROBAR))).toBe(false);
  });

  it('sin permiso declarado la ve cualquiera', () => {
    expect(pestanaVisible(C, con())).toBe(true);
  });
});

describe('[GX.80] primeraPestanaVisible', () => {
  it('es la primera en el orden de la barra que la persona ve', () => {
    expect(primeraPestanaVisible([A, B], con(Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_EXPENSES_VER))?.route).toBe('/x/a');
    expect(primeraPestanaVisible([A, B], con(Permission.FINANCE_EXPENSES_VER))?.route).toBe('/x/b');
  });

  /** ⛔ Sin ninguna visible no hay destino: la entrada del menú no se pinta. */
  it('⛔ sin ninguna visible devuelve null', () => {
    expect(primeraPestanaVisible([A, B], con())).toBeNull();
  });
});

describe('[GX.80] urlEnPestanas', () => {
  it('la ruta exacta, una hija, con query o fragmento', () => {
    for (const u of ['/x/a', '/x/a/123', '/x/b?folio=1', '/x/b#arriba']) expect(urlEnPestanas(u, [A, B])).toBe(true);
  });

  it('cuenta las rutas de `alsoActiveOn`', () => {
    expect(urlEnPestanas('/x/c-otra', [C])).toBe(true);
  });

  /** ⛔ El corte es por SEGMENTO: un prefijo pelado no basta. */
  it('⛔ `/x/a-vieja` no es `/x/a`, ni una ruta ajena cuenta', () => {
    expect(urlEnPestanas('/x/a-vieja', [A])).toBe(false);
    expect(urlEnPestanas('/y/a', [A, B, C])).toBe(false);
  });
});
