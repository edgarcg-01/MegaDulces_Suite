import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Route, type UrlTree } from '@angular/router';
import { CATALOGO_TABS } from './catalogo-tabs';
import { Permission } from '../../core/constants/permissions';
import { routes } from '../../app.routes';
import { primeraPestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';

/**
 * El árbol REAL de rutas, aplanado. Se prueba contra `app.routes.ts` importado como DATO
 * y no como texto: una ruta que existe, lleva su discriminador y está gateada son hechos
 * del objeto, y leerlos del fuente los vuelve sensibles a un reformateo que no rompe nada.
 * Mismo criterio que `core/panel/panel-routes.spec.ts`.
 *
 * No se llama a `loadComponent()`: montar los componentes de verdad arrastraría media app
 * a jsdom y la prueba diría más sobre PrimeNG que sobre las rutas.
 */
const TODAS: Route[] = (function aplanar(rs: Route[] = []): Route[] {
  return rs.flatMap((r) => [r, ...aplanar(r.children)]);
})(routes);

const APARTADOS = ['resumen', 'solicitudes', 'incidencias', 'listas-precios'] as const;

describe('CATALOGO_TABS', () => {
  it('expone los apartados con contenido del centro de catálogo, en orden operativo', () => {
    expect(CATALOGO_TABS.map((tab) => [tab.label, tab.route])).toEqual([
      ['Productos', '/compras/catalogo'],
      ['Catálogo digital', '/compras/catalogo/digital'],
      ['No registrados', '/compras/catalogo/no-registrados'],
      ['Mantenimiento', '/compras/catalogo/mantenimiento'],
      ['Costos', '/compras/catalogo/costos'],
      ['Precios', '/compras/catalogo/precios'],
      ['Códigos', '/compras/catalogo/codigos'],
      ['Reportes', '/compras/catalogo/reporte'],
    ]);
  });

  /**
   * `[PF.12.1]` La entrada del menú lateral manda a la PRIMERA pestaña visible (`conDestino()` del layout), y
   * la primera era «Resumen», un marcador vacío: medido en prod el 2026-10-29, todo el que entraba a
   * Compras › Catálogo caía en «Estructura preparada · Contenido por desarrollar» y no veía los productos.
   *
   * `[negativa]` Ninguna pestaña puede apuntar a una ruta de marcador vacío (las de `APARTADOS`, que siguen
   * existiendo en el router), y la primera es la lista de productos.
   */
  it('⛔ ninguna pestaña es un marcador vacío y la PRIMERA es la lista de productos', () => {
    const vacias = APARTADOS.map((a) => `/compras/catalogo/${a}`);
    expect(CATALOGO_TABS.filter((t) => vacias.includes(t.route)).map((t) => t.label)).toEqual([]);
    expect(CATALOGO_TABS[0].route).toBe('/compras/catalogo');
    // CONTROL: las rutas vacías SÍ existen en el router con su discriminador; si no, la negativa mediría el vacío.
    for (const r of vacias) {
      expect(TODAS.find((x) => x.path === r.replace(/^\/compras\//, ''))?.data?.['catalogoApartado']).toBeDefined();
    }
  });

  /**
   * `[PF.12.1]` El destino de la entrada «Catálogo» del menú lateral, con la MISMA función que usa
   * `conDestino()` (`primeraPestanaVisible`) y la MISMA lista (el layout la declara `tabs: CATALOGO_TABS`).
   */
  it('el menú lateral lleva a /compras/catalogo a quien tiene COMMERCIAL_PRODUCTS_VER', () => {
    const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);
    expect(primeraPestanaVisible(CATALOGO_TABS, con(Permission.COMMERCIAL_PRODUCTS_VER))?.route).toBe('/compras/catalogo');
    // manage:all (canPerm devuelve true para todo): también la lista de productos.
    expect(primeraPestanaVisible(CATALOGO_TABS, () => true)?.route).toBe('/compras/catalogo');
    // Sólo con el permiso del costo: su pestaña. Sin ninguno: la entrada no se pinta.
    expect(primeraPestanaVisible(CATALOGO_TABS, con(Permission.COMPRAS_COSTO_ESTANDAR_VER))?.route).toBe('/compras/catalogo/costos');
    expect(primeraPestanaVisible(CATALOGO_TABS, con())).toBeNull();

    const layout = readFileSync(join(__dirname, '../dashboard/layout/layout.component.ts'), 'utf8');
    expect(layout).toMatch(/label:\s*'Catálogo',[^}]*route:\s*'\/compras\/catalogo',\s*tabs:\s*CATALOGO_TABS\s*\}/);
    expect(layout).toMatch(/primeraPestanaVisible\(item\.tabs,/);
  });

  /**
   * `[CAT-COSTO.0]` Costos y Precios son tabs separados, y ninguno se enciende en la
   * pantalla del otro.
   *
   * `[negativa]` Antes Costos vivía como `alsoActiveOn` del tab de Precios. Si esa liga
   * sobreviviera a la separación, entrar a Costos encendería dos tabs a la vez.
   */
  it('Costos y Precios abren cada uno su pantalla, sin encenderse en la del otro', () => {
    const costos = CATALOGO_TABS.find((tab) => tab.label === 'Costos');
    const precios = CATALOGO_TABS.find((tab) => tab.label === 'Precios');
    expect(costos?.route).toBe('/compras/catalogo/costos');
    expect(precios?.route).toBe('/compras/catalogo/precios');
    expect(costos?.alsoActiveOn ?? []).not.toContain('/compras/catalogo/precios');
    expect(precios?.alsoActiveOn ?? []).not.toContain('/compras/catalogo/costos');
    expect(CATALOGO_TABS.some((tab) => tab.label === 'Costos y precios')).toBe(false);
  });

  /**
   * `[CAT-COSTO.4]` Costos es una pantalla real y su tab pide el MISMO permiso que su ruta: el
   * del costo estándar. `[negativa]` Si el tab pidiera el del catálogo, quien no ve costos vería
   * un tab que rebota al abrirlo.
   */
  it('Costos: tab y ruta piden COMPRAS_COSTO_ESTANDAR_VER y la ruta ya no es cascarón', () => {
    const tab = CATALOGO_TABS.find((t) => t.label === 'Costos');
    expect(tab?.permission).toBe(Permission.COMPRAS_COSTO_ESTANDAR_VER);

    const ruta = TODAS.find((r) => r.path === 'catalogo/costos');
    expect(ruta?.data?.['catalogoApartado']).toBeUndefined();

    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    const i = fuente.indexOf(`path: 'catalogo/costos'`);
    const bloque = fuente.slice(i, fuente.indexOf('}', i));
    expect(bloque).toContain('ComprasCatalogoCostosComponent');
    expect(bloque).toContain('permissionGuard(Permission.COMPRAS_COSTO_ESTANDAR_VER)');
  });

  /**
   * `[NP.22]` Productos nuevos se unió a Productos («Mostrar › Productos nuevos», decisión de David 2026-11-04): ya no
   * es pestaña. `[negativa]` Si alguien la vuelve a agregar a CATALOGO_TABS (y con ella al menú «Ver» y al lateral),
   * esta prueba se pone roja.
   */
  it('⛔ [NP.22] «Productos nuevos» ya NO es pestaña: ninguna apunta a /compras/catalogo/nuevos', () => {
    expect(CATALOGO_TABS.map((t) => t.label)).not.toContain('Productos nuevos');
    expect(CATALOGO_TABS.map((t) => t.route)).not.toContain('/compras/catalogo/nuevos');
  });

  /**
   * `[NP.22]` La ruta vieja NO se rompe: redirige a la lista con `?mostrar=nuevos` y conserva lo demás de la URL.
   * Se ejerce la función de la ruta REAL (no un texto), en un contexto de inyección con el Router.
   */
  it('⭐ [NP.22] /compras/catalogo/nuevos redirige a /compras/catalogo?mostrar=nuevos (y conserva ?resultado=)', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const ruta = TODAS.find((r) => r.path === 'catalogo/nuevos');
    expect(ruta).toBeDefined();
    // Ya no carga la pantalla vieja: es un redirect.
    expect(ruta?.loadComponent).toBeUndefined();
    expect(typeof ruta?.redirectTo).toBe('function');
    const redirigir = ruta!.redirectTo as (d: { queryParams: Record<string, string>; fragment: string | null }) => UrlTree;
    const router = TestBed.inject(Router);
    const sola = TestBed.runInInjectionContext(() => redirigir({ queryParams: {}, fragment: null }));
    expect(router.serializeUrl(sola)).toBe('/compras/catalogo?mostrar=nuevos');
    const conResultado = TestBed.runInInjectionContext(() => redirigir({ queryParams: { resultado: 'sacar' }, fragment: null }));
    expect(router.serializeUrl(conResultado)).toBe('/compras/catalogo?resultado=sacar&mostrar=nuevos');
    // [negativa] un mostrar viejo en la URL no gana: siempre aterriza en Productos nuevos.
    const pisado = TestBed.runInInjectionContext(() => redirigir({ queryParams: { mostrar: 'todos' }, fragment: null }));
    expect(router.parseUrl(router.serializeUrl(pisado)).queryParams['mostrar']).toBe('nuevos');
    // El destino existe y pide el permiso del catálogo (el mismo que pedía la pantalla vieja).
    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    const i = fuente.indexOf(`path: 'catalogo',`);
    expect(fuente.slice(i, fuente.indexOf('}', i))).toContain('permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)');
    TestBed.resetTestingModule();
  });

  /**
   * `[MOS.2]` No registrados: tab y ruta con el MISMO permiso que su endpoint
   * (`GET /commercial/floor-stockouts/no-registrados` pide COMMERCIAL_PRODUCTS_VER). `[negativa]`
   * Si la ruta pidiera el permiso de la bandeja de faltantes, quien ve el catálogo vería un tab que
   * rebota.
   */
  it('No registrados: tab y ruta piden COMMERCIAL_PRODUCTS_VER y abren su componente', () => {
    const tab = CATALOGO_TABS.find((t) => t.label === 'No registrados');
    expect(tab?.permission).toBe(Permission.COMMERCIAL_PRODUCTS_VER);

    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    const i = fuente.indexOf(`path: 'catalogo/no-registrados'`);
    expect(i).toBeGreaterThan(-1);
    const bloque = fuente.slice(i, fuente.indexOf('}', i));
    expect(bloque).toContain('ComprasCatalogoNoRegistradosComponent');
    expect(bloque).toContain('permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)');

    const control = readFileSync(
      join(__dirname, '../../../../../../libs/commercial/src/lib/commercial-stockouts/floor-stockouts.controller.ts'), 'utf8');
    const j = control.indexOf(`@Get('no-registrados')`);
    expect(j).toBeGreaterThan(-1);
    expect(control.slice(j, j + 400)).toContain('@RequirePermissions(Permission.COMMERCIAL_PRODUCTS_VER)');
  });

  it('cada tab apunta a una ruta que existe en el árbol real', () => {
    const caminos = new Set(
      TODAS.map((r) => r.path).filter((p): p is string => typeof p === 'string'),
    );
    for (const tab of CATALOGO_TABS) {
      // Los tabs del centro cuelgan todos de `/compras`.
      const rel = tab.route.replace(/^\/compras\/?/, '');
      expect(caminos.has(rel)).toBe(true);
    }
  });

  it('cada apartado nuevo existe en el router con su discriminador y su guard', () => {
    for (const apartado of APARTADOS) {
      const ruta = TODAS.find((r) => r.path === `catalogo/${apartado}`);
      expect(ruta).toBeDefined();
      expect(ruta?.data?.['catalogoApartado']).toBe(apartado);
      expect(ruta?.canActivate ?? []).toHaveLength(1);
      expect(typeof ruta?.loadComponent).toBe('function');
    }
  });

  /**
   * El permiso y el componente NO se pueden leer del objeto: `permissionGuard(...)` devuelve
   * una función que no expone su clave, y `loadComponent` es un import perezoso que habría
   * que ejecutar. Para eso —y sólo para eso— se lee el fuente, igual que hace
   * `core/guards/landing-guards.spec.ts`. El recorte va del `path` a su `data`, así que no
   * depende de saltos de línea ni de cuántas propiedades tenga el bloque.
   */
  it('los apartados nuevos se gatean con COMMERCIAL_PRODUCTS_VER', () => {
    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    for (const apartado of APARTADOS) {
      const iPath = fuente.indexOf(`path: 'catalogo/${apartado}'`);
      const iData = fuente.indexOf(`catalogoApartado: '${apartado}'`);
      expect(iPath).toBeGreaterThan(-1);
      expect(iData).toBeGreaterThan(iPath);
      const bloque = fuente.slice(iPath, iData);
      expect(bloque).toContain('permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)');
      expect(bloque).toContain('ComprasCatalogoApartadoComponent');
    }
  });
});
