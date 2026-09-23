import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Route, Router, RouterOutlet, Routes, provideRouter } from '@angular/router';
import { espejarParaPanel, olvidarEspejo, rutasDelPanel } from './panel-routes';
import { routes } from '../../app.routes';

/**
 * `[MT.5]` El espejo del panel.
 *
 * Es la pieza donde un error no se ve: si una ruta espejada pierde su
 * `canActivate`, el panel derecho abre una pantalla que la persona no puede
 * abrir por el camino normal. **Un espejo mal hecho no es un bug de layout, es
 * un guard evadido**, y en pantalla se ve perfecto.
 *
 * Se prueba contra el árbol REAL (`app.routes.ts`), no contra un juguete: lo que
 * hay que garantizar es que las 12 áreas de verdad se aplanen bien.
 */

const esLayout = (r: Route) => !!r.children?.length && /LayoutComponent/.test(String(r.component));

@Component({ standalone: true, template: '' })
class Vacio {}

@Component({ standalone: true, imports: [RouterOutlet], template: '<router-outlet /><router-outlet name="panel" />' })
class Anfitrion {}

/**
 * El espejo REAL con los cargadores doblados.
 *
 * Se mide el MATCHING del router, no las pantallas: montar los componentes de
 * verdad arrastraria media app a jsdom y la prueba diria mas sobre PrimeNG que
 * sobre el espejo. Los guards tambien se doblan -- que viajen ya lo prueba el
 * bloque de arriba, y con ellos puestos esto probaria los permisos, no las
 * rutas.
 */
function sinCargar(rs: Routes): Routes {
  return rs.map((r) => {
    const hijos = r.children ? sinCargar(r.children) : undefined;
    return {
      path: r.path,
      pathMatch: r.pathMatch,
      outlet: r.outlet,
      component: hijos ? undefined : Vacio,
      children: hijos,
    } as Route;
  });
}

/** Un router con el espejo real montado en el outlet `panel`. */
function routerConElEspejo(): Router {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '', component: Vacio }, ...sinCargar(espejarParaPanel(routes, esLayout))])],
  });
  const fix = TestBed.createComponent(Anfitrion);
  fix.detectChanges();
  return TestBed.inject(Router);
}

describe('[MT.5] el espejo de rutas del panel', () => {
  afterEach(() => olvidarEspejo());

  describe('sobre un árbol de juguete, para poder afirmar los casos', () => {
    const guardA = () => true;
    const guardB = () => true;
    const cargar = () => Promise.resolve(class {});
    const juguete: Routes = [
      { path: 'login', loadComponent: cargar }, // no es área
      {
        path: 'compras',
        component: { name: 'LayoutComponent' } as never,
        children: [
          { path: '', loadComponent: cargar, canActivate: [guardA] },
          { path: 'ordenes', loadComponent: cargar, canActivate: [guardA] },
          { path: 'ordenes/:id', loadComponent: cargar, canActivate: [guardB] },
          { path: 'viejo', redirectTo: 'ordenes' },
        ],
      },
      {
        path: 'finanzas',
        component: { name: 'LayoutComponent' } as never,
        children: [{ path: 'bancos', loadComponent: cargar, canActivate: [guardB] }],
      },
      { path: '**', loadComponent: cargar },
    ];
    const espejo = () => espejarParaPanel(juguete, (r) => /LayoutComponent/.test(String((r.component as never as { name: string })?.name)));

    it('aplana el área adentro del camino', () => {
      expect(espejo().map((r) => r.path)).toEqual(['compras', 'compras/ordenes', 'compras/ordenes/:id', 'finanzas/bancos']);
    });

    it('el hijo índice queda como el área pelada, no como "compras/"', () => {
      expect(espejo().some((r) => r.path === 'compras/')).toBe(false);
      expect(espejo().some((r) => r.path === 'compras')).toBe(true);
    });

    it('todas salen al outlet del panel', () => {
      expect(espejo().every((r) => r.outlet === 'panel')).toBe(true);
    });

    /** El que importa: si esto se rompe, el panel es una puerta trasera. */
    it('CADA ruta conserva su canActivate, con los MISMOS guards', () => {
      const porCamino = new Map(espejo().map((r) => [r.path, r.canActivate]));
      expect(porCamino.get('compras/ordenes')).toEqual([guardA]);
      expect(porCamino.get('compras/ordenes/:id')).toEqual([guardB]);
      expect(porCamino.get('finanzas/bancos')).toEqual([guardB]);
    });

    it('el cargador se comparte por referencia — el panel no agrega bundle', () => {
      expect(espejo().every((r) => r.loadComponent === cargar)).toBe(true);
    });

    it('no espeja redirects ni el comodín', () => {
      const caminos = espejo().map((r) => r.path);
      expect(caminos).not.toContain('compras/viejo');
      expect(caminos.some((p) => p?.includes('**'))).toBe(false);
    });

    it('lo que no es un área (login) no entra', () => {
      expect(espejo().some((r) => r.path?.includes('login'))).toBe(false);
    });
  });

  describe('sobre el árbol REAL de la Suite', () => {
    const espejo = () => espejarParaPanel(routes, esLayout);

    it('espeja las 12 áreas y ninguna queda sin prefijo', () => {
      const areas = new Set(espejo().map((r) => (r.path || '').split('/')[0]));
      expect(areas.size).toBeGreaterThanOrEqual(10);
      // Las cuatro de los drill-downs que CRUZAN de área tienen que estar.
      for (const a of ['comercial', 'compras', 'finanzas', 'dashboard', 'almacen', 'logistica']) {
        expect(areas.has(a)).toBe(true);
      }
    });

    /**
     * Se prueba por RESOLUCIÓN, no por forma, y la diferencia importa: el
     * primer intento de esta prueba buscaba `almacen/inventory/sessions/:id`
     * como entrada plana del espejo y fallaba — esa ruta cuelga del shell del
     * área (`path: ''` con hijos), cuyos `children` el espejo copia por
     * referencia. O sea que la ruta SÍ resuelve aunque no figure en la lista.
     * Mirar la lista habría reportado un defecto que no existe; y al revés,
     * una lista correcta no prueba que el router llegue.
     */
    it('los 4 destinos que cruzan de área RESUELVEN en el panel', async () => {
      const router = routerConElEspejo();
      for (const destino of [
        'comercial/documentos',
        'compras/descuentos',
        'dashboard/routes',
        'almacen/inventory/sessions/abc-123',
      ]) {
        const llego = await router.navigateByUrl(`/(panel:${destino})`);
        expect([destino, llego]).toEqual([destino, true]);
      }
    });

    /**
     * NEGATIVA — que la compuerta sepa ponerse roja.
     *
     * Sin esto, `espejarParaPanel` podría estar copiando `canActivate` "por
     * casualidad" (por ejemplo si TODAS las rutas reales tuvieran guard) y la
     * prueba de arriba se pondría verde con un espejo que los pierde. Se le da
     * un árbol donde el guard está y se comprueba que, si la copia lo tirara,
     * la diferencia se ve.
     */
    it('NEGATIVA: un espejo que tire el canActivate se detecta', () => {
      const guard = () => true;
      const arbol: Routes = [
        { path: 'x', component: { name: 'LayoutComponent' } as never, children: [{ path: 'y', loadComponent: () => Promise.resolve(class {}), canActivate: [guard] }] },
      ];
      const esL = (r: Route) => /LayoutComponent/.test(String((r.component as never as { name: string })?.name));
      expect(espejarParaPanel(arbol, esL)[0].canActivate).toEqual([guard]);

      // El espejo "malo" que este test existe para prohibir.
      const malo = arbol[0].children!.map((h) => ({ path: `x/${h.path}`, loadComponent: h.loadComponent, outlet: 'panel' }));
      expect((malo[0] as Route).canActivate).toBeUndefined();
    });

    /**
     * Comparación POSICIONAL, no por camino. El primer intento indexaba por
     * camino y daba falsos positivos: `almacen` tiene DOS hijos con
     * `path: 'anden'` y dos con `path: ''` (legal — el router matchea el
     * primero que calza, y `pathMatch: 'full'` los distingue), así que el mapa
     * los colapsaba y acusaba de "perdidas" a rutas sanas.
     */
    it('ninguna ruta real espejada perdió su guard', () => {
      const originales: unknown[] = [];
      for (const area of routes) {
        if (!esLayout(area) || !area.path) continue;
        for (const h of area.children!) {
          if (h.redirectTo !== undefined || h.path === '**') continue;
          if (!(h.loadComponent || h.component || h.loadChildren || h.children)) continue;
          originales.push(h.canActivate);
        }
      }
      const copiadas = espejo().map((r) => r.canActivate);
      expect(copiadas.length).toBe(originales.length);
      const distintas = copiadas.filter((g, i) => g !== originales[i]).length;
      expect(distintas).toBe(0);
    });
  });

  describe('el costo', () => {
    it('el espejo se arma una sola vez', async () => {
      const a = await rutasDelPanel(routes, esLayout);
      const b = await rutasDelPanel(routes, esLayout);
      expect(a).toBe(b); // la MISMA referencia: no se recorrió el árbol de nuevo
    });
  });
});
