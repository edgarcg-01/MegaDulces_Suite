import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Route, Router, RouterOutlet, Routes, provideRouter } from '@angular/router';
import { routes, rutasDeLaApp } from '../../app.routes';
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

/**
 * `[MT.5]` El nivel donde vive el outlet `panel`: el shell de la RAÍZ, que es
 * el primer hijo del árbol. Es lo que `SplitShellComponent` le registra al
 * servicio, y contra lo que se arman cerrar y abrir-al-lado.
 */
function shell(router: Router): ActivatedRoute {
  const s = router.routerState.root.firstChild;
  if (!s) throw new Error('no se encontró el shell de la raíz');
  return s;
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
/**
 * ⚠️ La FORMA cambió cuando el panel se mudó del área a la RAÍZ:
 *   antes  /compras/(requisiciones//panel:compras/requisiciones/abc)
 *   ahora  /compras/requisiciones(panel:compras/requisiciones/abc)
 * El panel ya no es hijo del área sino hermano del outlet primario, y por eso
 * sobrevive al cambiar de área — que es el defecto que la mudanza vino a cerrar.
 */
const SPLIT = '/compras/requisiciones(panel:compras/requisiciones/abc)';

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
    ({ router, fix } = montar(desnudar(rutasDeLaApp)));
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
    // El nivel del outlet `panel` ya no es el área: es el shell de la raíz.
    const cerrar = router.createUrlTree([{ outlets: { panel: null } }], { relativeTo: shell(router) });
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
    expect(await ir('/compras/requisiciones(panel:esto/no/existe)')).toBe(true);
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

  /**
   * `[MT.5.3]` **El split SOBREVIVE al cambiar de pantalla**, incluso saliendo
   * del área.
   *
   * ── El defecto, reportado por Edgar el 2026-10-16 ────────────────────────────
   * «si le doy en Mi trabajo las dos pestañas se cierran, y sólo debería cerrarse
   * una». El outlet `panel` colgaba del ÁREA, así que al navegar a `/projects`
   * —que ni siquiera usa el layout— el panel no tenía dónde existir y la
   * partición se perdía entera.
   *
   * ⭐ Lo que lo arregla NO es un enlace nuevo: es DÓNDE vive el outlet.
   * `createUrlTree` conserva los outlets que los comandos no nombran, en el grupo
   * donde están. Colgando de la raíz, el panel es hermano del primario y
   * cualquier `routerLink` normal lo deja intacto. Medido antes de mover nada:
   *
   *   panel en el ÁREA  → createUrlTree(['/projects']) = '/projects'
   *   panel en la RAÍZ  → createUrlTree(['/projects']) = '/projects(panel:…)'
   *
   * Por eso se afirma sobre `createUrlTree` y no sólo sobre `navigateByUrl`: el
   * gesto real es un enlace, y un test que escribiera la URL a mano pasaría
   * aunque el enlace la perdiera — que es exactamente el caso que falló.
   */
  describe('[MT.5.3] el panel sobrevive al salir del área', () => {
    /** Lo que arma un `routerLink` normal del sidebar o de la migaja. */
    const comoUnEnlace = (destino: string) => router.createUrlTree([destino]);

    it('ir a «Mi trabajo» con un enlace normal CONSERVA el panel', async () => {
      await ir(SPLIT);
      expect(panel.abierto).toBe(true);

      const arbol = comoUnEnlace('/projects');
      expect(router.serializeUrl(arbol)).toContain('panel:compras/requisiciones/abc');

      expect(await router.navigateByUrl(arbol)).toBe(true);
      fix.detectChanges();
      expect(router.url).toContain('/projects');
      expect(panel.abierto).toBe(true); // ⛔ esto es lo que se perdía
    });

    it('cruzar a OTRA área con un enlace normal también lo conserva', async () => {
      await ir(SPLIT);
      const arbol = comoUnEnlace('/comercial/command-center');
      expect(router.serializeUrl(arbol)).toContain('panel:compras/requisiciones/abc');
      expect(await router.navigateByUrl(arbol)).toBe(true);
      fix.detectChanges();
      expect(panel.abierto).toBe(true);
    });

    /**
     * NEGATIVA — que la compuerta sepa ponerse roja. Se rearma el cableado como
     * estaba (el aux route colgando del ÁREA) y se comprueba que el defecto
     * vuelve: el enlace a `/projects` pierde el panel. Sin esto, las dos pruebas
     * de arriba pasarían igual con un router que conservara outlets por su
     * cuenta, y no probarían que lo que arregla es la mudanza a la raíz.
     */
    it('NEGATIVA: con el panel colgando del ÁREA, el enlace lo pierde', async () => {
      const viejo = montar(
        desnudar([
          {
            path: 'compras',
            component: Anfitrion,
            children: [
              { path: 'requisiciones', component: Vacio },
              { matcher: (s) => (s.length > 0 ? { consumed: [] } : null), outlet: 'panel',
                children: [{ path: 'compras/requisiciones/abc', component: Vacio }] },
            ],
          },
          { path: 'projects', component: Vacio },
        ]),
      );
      expect(
        await viejo.router.navigateByUrl('/compras/(requisiciones//panel:compras/requisiciones/abc)'),
      ).toBe(true);
      expect(viejo.router.serializeUrl(viejo.router.createUrlTree(['/projects']))).toBe('/projects');
    });
  });
});
