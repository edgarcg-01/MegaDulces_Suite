import { Route, Routes } from '@angular/router';

/**
 * `[MT.5]` El árbol de rutas, espejado para el PANEL de la derecha.
 *
 * ── El problema que resuelve ──────────────────────────────────────────────────
 * La pantalla partida necesita que el panel derecho pueda mostrar **cualquier**
 * pantalla, no sólo las del área en la que estás. Y eso choca con la forma real
 * del árbol, medida antes de diseñar: **no hay un `LayoutComponent` con 225
 * hijos, hay 12** — uno por área (`dashboard`, `comercial`, `finanzas`, …). Un
 * `<router-outlet name="panel">` declarado dentro del layout sólo puede
 * hospedar hijos de SU ruta, o sea de su área.
 *
 * De los 11 drill-downs de `[MT.1]`, **4 cruzan de área** — cartera→documento,
 * pagos→descuentos, auditoría de ruta→dashboard, sesiones→almacén — y son justo
 * los de cotejar, que es para lo que existe la pantalla partida. Así que el
 * espejo **aplana**: cada hijo se reescribe con el prefijo de su área, y el
 * conjunto entero se cuelga del outlet `panel` de las 12.
 *
 * ── Lo que se conserva, que es lo que importa ─────────────────────────────────
 * Cada ruta espejada es una copia superficial: **`canActivate` viaja con ella**.
 * Sin eso el panel sería una puerta trasera a pantallas que la persona no puede
 * abrir — un espejo mal hecho no es un bug de layout, es un guard evadido. Los
 * `loadComponent`/`loadChildren` se comparten por referencia, así que el panel
 * no agrega ni un byte al bundle: es el mismo chunk, otra instancia.
 *
 * ── Lo que se deja afuera, con motivo ─────────────────────────────────────────
 * - **`redirectTo`**: al aplanar, un redirect relativo apunta a otro lado. Antes
 *   que adivinar, no se espeja: una redirección dentro del panel no es un
 *   destino que alguien pida.
 * - **El comodín `**`**: se tragaría cualquier segmento y el panel mostraría el
 *   404 en vez de no abrir. Que no abra es la respuesta honesta.
 */

/** Une el área con el camino del hijo, cuidando el hijo índice (`path: ''`). */
function unir(area: string, hijo: string | undefined): string {
  if (!hijo) return area;
  return `${area}/${hijo}`;
}

/** ¿Esta ruta se puede espejar? Ver "lo que se deja afuera". */
function espejable(r: Route): boolean {
  if (r.redirectTo !== undefined) return false;
  if (r.path === '**') return false;
  // ⛔ Nada que ya viva en un outlet con nombre — empezando por el PROPIO aux
  // route del panel, que `app.routes` empuja a las 12 áreas. Sin este freno el
  // espejo se incluye a sí mismo (medido: 14 de 200 entradas) y queda una
  // estructura recursiva con `outlet: 'panel'` dentro del panel.
  if (r.outlet) return false;
  return r.loadComponent !== undefined || r.component !== undefined || r.loadChildren !== undefined || !!r.children;
}

/**
 * Toma el árbol de primer nivel y devuelve las rutas del panel, aplanadas.
 *
 * `esLayout` decide qué rutas de primer nivel son áreas. Se pasa por parámetro
 * en vez de importar `LayoutComponent` acá: este módulo no debe arrastrar el
 * layout —ni su árbol de dependencias— al bundle inicial.
 */
export function espejarParaPanel(raiz: Routes, esLayout: (r: Route) => boolean): Routes {
  const salida: Routes = [];
  for (const area of raiz) {
    if (!esLayout(area) || !area.children?.length) continue;
    const prefijo = area.path;
    if (!prefijo) continue; // un área sin camino no se puede prefijar
    // ⛔ El 404 de la app TAMBIÉN es `LayoutComponent` con hijos, así que pasa
    // el filtro de "área" y se espejaba con `path: '**'`. Ese comodín matchea
    // **incluso con cero segmentos**, así que el aux route del panel —que es de
    // camino vacío— encontraba hijo SIEMPRE: el panel se abría solo, en todas
    // las pantallas, con el 404 adentro, y la X no tenía nada que quitar de la
    // URL (medido en producción el 2026-09-24 sobre `176dee6e`).
    if (prefijo === '**') continue;
    for (const hijo of area.children) {
      if (!espejable(hijo)) continue;
      // ⛔ SIN `outlet`. El outlet lo declara el aux route PADRE que carga este
      // espejo (`{ path: '', outlet: 'panel', loadChildren }`); estas rutas son
      // sus HIJAS y viajan por dentro de él.
      //
      // Ponérselo también acá fue un incidente real (2026-09-24, "la página sale
      // vacía y no se puede cerrar"): un hijo con outlet nombrado exige un
      // `<router-outlet name>` DENTRO del componente del padre, y el padre es
      // componentless → ningún hijo matcheaba → `NG04002: Cannot match any
      // routes` → la navegación entera fallaba y la app quedaba en `/`. Con la
      // URL sin resolver, el botón de cerrar tampoco tenía a dónde volver.
      salida.push({ ...hijo, path: unir(prefijo, hijo.path) });
    }
  }
  salida.push(NO_EXISTE);
  return salida;
}

/**
 * La red de contención del panel: **un comodín que NO matchea el vacío**.
 *
 * Son dos requisitos que pelean entre sí y por eso no se puede usar `'**'`:
 *
 *  1. Si una dirección de panel inventada no matchea NADA, **falla la
 *     navegación entera** y la app queda en blanco — el incidente original.
 *  2. Si matchea también con cero segmentos, el aux route del panel (que es de
 *     camino vacío) tiene hijo SIEMPRE y el panel se abre solo en todas las
 *     pantallas — el incidente que lo siguió.
 *
 * `'**'` cumple (1) y viola (2): en Angular el comodín matchea la lista vacía.
 * Un `matcher` propio es la única forma declarativa de exigir **al menos un
 * segmento**, y es lo que deja las dos cosas ciertas a la vez.
 */
const NO_EXISTE: Route = {
  matcher: (segmentos) => (segmentos.length > 0 ? { consumed: [...segmentos] } : null),
  loadComponent: () => import('./panel-no-existe.component').then((m) => m.PanelNoExisteComponent),
};

/**
 * El espejo se arma UNA vez y sólo cuando alguien abre el panel.
 *
 * Va como `loadChildren` a propósito: mientras nadie parta la pantalla, el
 * costo de la pantalla partida es **cero** — ni se recorre el árbol. Es el mismo
 * criterio que el resto de `[MT]` (ADR-078): lo opcional no se paga por
 * adelantado.
 */
let cache: Routes | null = null;
export function rutasDelPanel(raiz: Routes, esLayout: (r: Route) => boolean): Promise<Routes> {
  cache ??= espejarParaPanel(raiz, esLayout);
  return Promise.resolve(cache);
}

/** Sólo para pruebas: olvida el espejo ya armado. */
export function olvidarEspejo(): void {
  cache = null;
}
