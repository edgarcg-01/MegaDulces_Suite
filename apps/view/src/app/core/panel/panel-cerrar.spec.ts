import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Route, Router, RouterOutlet, Routes, provideRouter } from '@angular/router';
import { routes } from '../../app.routes';
import { espejarParaPanel, olvidarEspejo } from './panel-routes';

/**
 * `[MT.5.2]` **Abrir al lado y CERRAR**, sobre el árbol real y RENDERIZADO.
 *
 * ── Por qué existe aparte de `panel-routes.spec.ts` ──────────────────────────
 * Aquél prueba la FORMA del espejo (que los guards viajen, que no se incluya a
 * sí mismo). Éste prueba el GESTO: que el panel se abra cuando se pide, que NO
 * se abra cuando nadie lo pidió, y que la X lo cierre. Son preguntas distintas,
 * y la segunda tanda se escapó entera dos veces seguidas a producción:
 *
 *  - 2026-09-24 (a): los hijos espejados llevaban `outlet: 'panel'` → no
 *    matcheaba nada → **la app quedaba en blanco**.
 *  - 2026-09-24 (b), el arreglo de (a): el espejo se llevaba el `'**'` del 404
 *    de la app, que también vive dentro del layout. Ese comodín matchea **la
 *    lista vacía**, y el aux route del panel es de camino vacío → el panel se
 *    abría **solo, en todas las pantallas**, con un 404 adentro, y la X no
 *    tenía nada que quitar de la URL. Medido en producción sobre `176dee6e`:
 *    `/comercial/command-center` limpio abría 960 px de panel.
 *
 * ── Por qué se mide `(activate)` y no el árbol de rutas ──────────────────────
 * Primera versión de este archivo: buscaba una rama con `outlet === 'panel'` en
 * `routerState` y daba ROJO con el arreglo puesto. Estaba mirando lo que no es:
 * el aux route puede quedar activado **sin componente**, y entonces el outlet
 * no emite nada y en pantalla no hay panel. Lo que decide si el usuario ve la
 * columna es exactamente lo que el layout escucha — `(activate)`/`(deactivate)`
 * del `<router-outlet name="panel">` —, así que es lo que se afirma acá.
 */

/** Lo que el layout guarda en `panelAbierto`, replicado. */
const panel = { abierto: false, pinto: '' };

@Component({ standalone: true, template: 'no-existe' })
class NoExistePanel {}

@Component({ standalone: true, template: '' })
class Vacio {}

/** Host de área con los DOS outlets, como el layout de verdad. */
@Component({
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet /><router-outlet name="panel" (activate)="abrir($event)" (deactivate)="cerrar()" />',
})
class Anfitrion {
  abrir(c: unknown): void {
    panel.abierto = true;
    panel.pinto = (c as object)?.constructor?.name ?? '?';
  }
  cerrar(): void {
    panel.abierto = false;
    panel.pinto = '';
  }
}

@Component({ standalone: true, imports: [RouterOutlet], template: '<router-outlet />' })
class Raiz {}

/**
 * El árbol REAL con los componentes doblados y **el cableado intacto**.
 *
 * Se conservan `path`, `pathMatch`, `outlet`, `matcher`, la anidación y —clave—
 * los `loadChildren`: el espejo del panel ES un `loadChildren`, así que una
 * versión que los tire probaría otra cosa. Se doblan sólo los componentes, que
 * arrastrarían media app a jsdom.
 */
function desnudar(rs: Routes): Routes {
  return rs.map((r) => {
    const out: Route = { path: r.path, pathMatch: r.pathMatch, outlet: r.outlet, matcher: r.matcher };
    if (r.redirectTo !== undefined) {
      out.redirectTo = r.redirectTo;
      return out;
    }
    if (r.children) {
      out.children = desnudar(r.children);
      out.component = r.component ? Anfitrion : undefined;
      return out;
    }
    if (r.loadChildren) {
      out.loadChildren = async () => desnudar(await (r.loadChildren as () => Promise<Routes>)());
      return out;
    }
    out.component = r.matcher ? NoExistePanel : Vacio;
    return out;
  });
}

function montar(rs: Routes): { router: Router; fix: ComponentFixture<Raiz> } {
  panel.abierto = false;
  panel.pinto = '';
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter(rs)] });
  const fix = TestBed.createComponent(Raiz);
  fix.detectChanges();
  return { router: TestBed.inject(Router), fix };
}

function area(router: Router, path: string): ActivatedRoute {
  const pila = [router.routerState.root];
  while (pila.length) {
    const r = pila.shift() as ActivatedRoute;
    if (r.routeConfig?.path === path) return r;
    pila.push(...r.children);
  }
  throw new Error('no se encontró el área ' + path);
}

const esLayoutReal = (r: Route) => !!r.children?.length && /LayoutComponent/.test(String(r.component));
const SPLIT = '/compras/(requisiciones//panel:compras/requisiciones/abc)';

describe('[MT.5.2] abrir al lado y cerrar', () => {
  let router: Router;
  let fix: ComponentFixture<Raiz>;

  const ir = async (url: string) => {
    const ok = await router.navigateByUrl(url);
    fix.detectChanges();
    return ok;
  };

  beforeEach(() => {
    olvidarEspejo();
    ({ router, fix } = montar(desnudar(routes)));
  });

  it('una pantalla normal NO abre el panel', async () => {
    expect(await ir('/compras/requisiciones')).toBe(true);
    expect(panel.abierto).toBe(false);
  });

  it('el 404 de la app tampoco lo abre', async () => {
    expect(await ir('/esto-no-existe')).toBe(true);
    expect(panel.abierto).toBe(false);
  });

  it('pedirlo al lado SÍ lo abre', async () => {
    expect(await ir(SPLIT)).toBe(true);
    expect(panel.abierto).toBe(true);
  });

  it('la X cierra: sale de la URL Y el panel se apaga', async () => {
    await ir(SPLIT);
    expect(panel.abierto).toBe(true);

    // El gesto, con el mismo comando que arma el enlace de la X.
    const cerrar = router.createUrlTree([{ outlets: { panel: null } }], { relativeTo: area(router, 'compras') });
    expect(router.serializeUrl(cerrar)).toBe('/compras/requisiciones');

    expect(await router.navigateByUrl(cerrar)).toBe(true);
    fix.detectChanges();
    expect(router.url).toBe('/compras/requisiciones');
    expect(panel.abierto).toBe(false); // ⛔ esto es lo que fallaba en producción
  });

  it('maximizar deshace la partición, no la duplica', async () => {
    await ir(SPLIT);
    // Lo que arma `enlacePanelACompleto`: el árbol PARSEADO del camino del panel.
    const completo = router.parseUrl('/compras/requisiciones/abc');
    expect(await router.navigateByUrl(completo)).toBe(true);
    fix.detectChanges();
    expect(router.url).toBe('/compras/requisiciones/abc');
    expect(panel.abierto).toBe(false);
  });

  it('un destino de panel inventado NO tumba la navegación', async () => {
    expect(await ir('/compras/(requisiciones//panel:esto/no/existe)')).toBe(true);
    expect(router.url).toContain('requisiciones');
    expect(panel.abierto).toBe(true);
    // ⚠️ Se mira lo PINTADO, no `(activate)`: el outlet activa el componente del
    // aux route (`ɵEmptyOutletComponent`), que a su vez lleva el outlet donde cae
    // la hoja. Afirmar sobre el activado diría siempre lo mismo y no probaría nada.
    expect(fix.nativeElement.textContent).toContain('no-existe');
  });

  /**
   * NEGATIVA — que la compuerta sepa ponerse roja.
   *
   * Se rearma el aux route EXACTAMENTE como salió a producción (`path: ''`) y
   * se comprueba que el defecto vuelve: el panel se abre sin que nadie lo pida,
   * **aunque el espejo ya esté arreglado**. Eso es lo que prueba que quien
   * arregla es el `matcher` y no el otro cambio.
   *
   * ⚠️ Además deja escrito el porqué: el componente que se activa es
   * `ɵEmptyOutletComponent`, el que Angular le pone solo a una ruta de outlet
   * nombrado con hijos y sin componente. No hay ninguna ruta nuestra pintando
   * — y la columna igual se abre.
   */
  it('NEGATIVA: con el aux route de camino vacío el panel se abre solo', async () => {
    const roto = montar([
      {
        path: 'compras',
        component: Anfitrion,
        children: [
          { path: 'requisiciones', component: Vacio },
          { path: '', outlet: 'panel', loadChildren: async () => desnudar(espejarParaPanel(routes, esLayoutReal)) },
        ],
      },
    ]);
    expect(await roto.router.navigateByUrl('/compras/requisiciones')).toBe(true);
    roto.fix.detectChanges();
    expect(panel.abierto).toBe(true); // el defecto, reproducido
    expect(panel.pinto).toBe('ɵEmptyOutletComponent');
  });

  it('el espejo no contiene comodín ni ruta de camino vacío', () => {
    const espejo = espejarParaPanel(routes, esLayoutReal);
    expect(espejo.filter((r) => r.path === '**')).toEqual([]);
    expect(espejo.filter((r) => r.path === '')).toEqual([]);

    // La cola es el matcher que exige AL MENOS un segmento: ése es el invariante.
    const cola = espejo[espejo.length - 1];
    expect(cola.matcher).toBeDefined();
    const llamar = (segs: unknown[]) => (cola.matcher as (s: unknown[]) => unknown)(segs);
    expect(llamar([])).toBeNull();
    expect(llamar([{ path: 'x', parameters: {} }])).not.toBeNull();
  });
});
