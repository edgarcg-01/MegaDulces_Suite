import { TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { FinanzasPresupuestoComponent } from './finanzas-presupuesto.component';

/**
 * `[PU.DIR.0]` — **Las siete vistas de `/presupuesto` viven en la URL.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Hasta este commit `setView()` sólo hacía `this.view.set(v)`: medido, cero coincidencias de
 * `ActivatedRoute`, `queryParam` y `router.navigate` en las 2,778 líneas del componente. O sea
 * que una vista no se podía compartir, no se podía marcar, y un F5 te devolvía a Ejercicio.
 * Eso bloquea a la vista «Dirección», cuyo trabajo es contestar y MANDAR a la vista donde se
 * trabaja: un destino que no se puede nombrar no es un destino.
 *
 * ── Qué se vigila, y por qué cada cosa se puede romper ───────────────────────────────────────
 *  1. **El orden.** La vista se rehidrata ANTES de las cargas. Si se leyera después,
 *     `loadBudgets()` ya habría resuelto con la vista por default y el bloque que la selección
 *     de ejercicio dispara por vista saldría para la vista equivocada: la pantalla terminaría
 *     en el lugar correcto con el dato del lugar anterior, que es peor que un error visible.
 *     Por eso se afirma sobre la CONSULTA que salió, no sólo sobre el estado final.
 *  2. **Que no invente.** Sin parámetro la pantalla se comporta como siempre y **no escribe la
 *     URL**: una regresión acá le mete un `?view=` a todo el mundo sin que nadie lo pida.
 *  3. **Que un valor basura no se cuele.** `?view=nope` tiene que caer a la vista por default,
 *     no dejar la pantalla en una vista que no existe y por lo tanto en blanco.
 *  4. ⭐ **Que la lista de vistas válidas salga de los selectores y no de un tercer arreglo.**
 *     Es la única aserción que se rompe el día que alguien agregue una vista nueva sin pensar
 *     en la URL — y el síntoma de ese defecto sería que la vista nueva funciona con el dedo y
 *     NO por enlace, que es exactamente lo que este commit vino a cerrar.
 *
 * ⚠️ Lo que este candado **no** afirma: que «atrás» recorra las vistas. No lo hace, a propósito
 * — `replaceUrl:true`, como las otras veinte pantallas del repo. Cambiar de pestaña no es
 * navegar, y con `replaceUrl:false` salir de la pantalla costaría tantos «atrás» como clics.
 */

function montar(queryParams: Record<string, string> = {}) {
  TestBed.configureTestingModule({
    imports: [FinanzasPresupuestoComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LOCALE_ID, useValue: 'es-MX' },
      // El `snapshot` es lo único que el componente consulta; el Router va de verdad para poder
      // espiar el ARGUMENTO con el que se escribe la URL, no un doble que acepte cualquier cosa.
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const fix = TestBed.createComponent(FinanzasPresupuestoComponent);
  fix.detectChanges(); // dispara ngOnInit
  return { fix, cmp: fix.componentInstance, http, navigate };
}

/** ¿Salió la consulta del flujo de caja? Es la carga perezosa de la vista `flujo`, y es la única
 *  que NO depende de que haya un ejercicio seleccionado, así que se puede observar en el primer
 *  pintado sin montar media pantalla. */
const consultasDeFlujo = (http: HttpTestingController) =>
  http.match((r) => r.url.includes('/cashflow')).length;

describe('PU.DIR.0 · la vista de /presupuesto viaja en la URL', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ deep-link: `?view=flujo` abre en flujo Y dispara su consulta en el primer pintado', () => {
    const { cmp, http } = montar({ view: 'flujo' });
    expect(cmp.view()).toBe('flujo');
    expect(consultasDeFlujo(http)).toBe(1);
  });

  it('⛔ NEGATIVA — sin parámetro no inventa vista, no consulta de más y no escribe la URL', () => {
    // ⚠️ El default dejó de ser Ejercicio el día que entró `[PU.DIR.1]`: `/presupuesto` abre en
    // Dirección. Se afirma el literal y NO la constante del componente: un test que importa la
    // constante que vigila se pone verde aunque la constante esté mal.
    const { cmp, http, navigate } = montar({});
    expect(cmp.view()).toBe('direccion');
    expect(consultasDeFlujo(http)).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([['nope'], [''], ['GASTOS'], ['flujo ']])(
    '⛔ el valor basura %p NO se cuela: cae a la vista por default',
    (view) => {
      // `GASTOS` y `flujo ` están a propósito: la comparación es exacta, y un `includes` laxo
      // o un `trim()` de más dejarían pasar un valor que la plantilla no sabe pintar.
      const { cmp } = montar({ view });
      expect(cmp.view()).toBe('direccion');
    },
  );

  it('`setView` deja la vista escrita en la URL, sin pisar los otros parámetros', () => {
    const { cmp, navigate } = montar({});
    cmp.setView('capacidad');
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { view: 'capacidad' },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
  });

  it('la vista por default se OMITE del parámetro: `/presupuesto` limpio es Dirección', () => {
    // Si se escribiera `?view=direccion`, la URL que se comparte diría algo que el default ya
    // dice, y cualquier cambio de default a futuro dejaría enlaces viejos clavados en el viejo.
    const { cmp, navigate } = montar({ view: 'flujo' });
    cmp.setView('direccion');
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { view: null } }));
  });

  it('⭐ Ejercicio dejó de ser el default, así que AHORA sí tiene que viajar en la URL', () => {
    // El día que el default cambió, la vista que antes era implícita pasó a necesitar parámetro.
    // Sin esta aserción, un enlace viejo a Ejercicio abriría en Dirección sin que nadie lo note.
    const { cmp, navigate } = montar({});
    cmp.setView('ejercicios');
    expect(cmp.view()).toBe('ejercicios');
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { view: 'ejercicios' } }));
  });

  it('⭐ las OCHO vistas de los selectores son enlazables — la lista no se escribe a mano', () => {
    // Esta es la aserción que se pone roja cuando alguien agrega una vista al selector y se
    // olvida de la URL. Ya cobró una vez: al entrar «Dirección» se puso roja sola, con el
    // conteo y con el default. Se recorren los dos grupos tal como los declara el componente.
    const { cmp } = montar({});
    const valores = [...cmp.viewOptsArmar, ...cmp.viewOptsPagos].map((o) => o.value);
    TestBed.resetTestingModule();
    expect(valores).toHaveLength(8);
    for (const v of valores) {
      const caso = montar({ view: v });
      expect(caso.cmp.view(), `la vista ${v} no se rehidrata desde la URL`).toBe(v);
      TestBed.resetTestingModule();
    }
  });
});
