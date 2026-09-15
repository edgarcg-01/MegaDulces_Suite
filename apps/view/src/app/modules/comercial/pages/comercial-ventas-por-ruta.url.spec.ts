import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[JZ.1]` — La pantalla aterriza FILTRADA cuando se llega desde un enlace.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * La portada del jefe de zona no construye un reporte nuevo: toma el número y manda acá. Para que
 * eso sirva, su fila «Ruta 28 · +62.8%» tiene que abrir esta pantalla ya puesta en esa ruta. El
 * filtro por sucursal y por ruta **ya existía como control**; lo que no existía era leerlo de la
 * URL — cero usos de `ActivatedRoute` en el componente antes de esto.
 *
 * ── Qué se vigila, y por qué cada cosa se puede romper ───────────────────────────────────────
 *  1. **El orden.** `year` y `routes` viajan en `params()`, así que si se leyeran DESPUÉS del
 *     `load()` del constructor la primera consulta saldría sin filtro. Se afirma sobre el
 *     argumento REAL con el que se llamó a `salesByRoute`, no sobre el estado final del
 *     componente: el estado final sería verde aunque la consulta hubiera salido mal.
 *  2. **Que no invente filtros.** Sin parámetros, la pantalla tiene que comportarse como siempre.
 *     Una regresión acá haría que todo el mundo vea el reporte recortado sin haber pedido nada.
 *  3. **Que un año basura no se cuele.** El reporte es por año de folio; `?year=abc` o `?year=99`
 *     tienen que caer al año en curso en vez de consultar un rango imposible.
 */

/** Los cuatro métodos que el constructor llama. Devuelven vacío: acá se mide el ARGUMENTO. */
function servicioStub() {
  return {
    salesByRoute: jest.fn().mockReturnValue(of({ rows: [], months: [], totals: null })),
    salesByRouteRoutes: jest.fn().mockReturnValue(of([])),
    salesByRouteProducts: jest.fn().mockReturnValue(of([])),
    salesByRouteClients: jest.fn().mockReturnValue(of([])),
  };
}

function montar(queryParams: Record<string, string>) {
  const svc = servicioStub();
  TestBed.configureTestingModule({
    imports: [ComercialVentasPorRutaComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ComercialService, useValue: svc },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } },
      },
    ],
  });
  const fix = TestBed.createComponent(ComercialVentasPorRutaComponent);
  return { fix, cmp: fix.componentInstance, svc };
}

describe('JZ.1 · Ventas por ruta aterriza filtrada desde la URL', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ el filtro viaja en la PRIMERA consulta, no después', () => {
    // Si se leyera la URL después del `load()` del constructor, `salesByRoute` habría recibido
    // `routes: undefined` y el reporte completo parpadearía antes de filtrarse.
    const { svc } = montar({ route: 'RUTA-28', year: '2026' });
    expect(svc.salesByRoute).toHaveBeenCalledTimes(1);
    expect(svc.salesByRoute).toHaveBeenCalledWith(
      expect.objectContaining({ year: 2026, routes: ['RUTA-28'] }),
    );
  });

  it('acepta varias rutas separadas por coma, y tolera espacios', () => {
    const { cmp } = montar({ routes: 'RUTA-21 , RUTA-22,RUTA-23' });
    expect(cmp.routes).toEqual(['RUTA-21', 'RUTA-22', 'RUTA-23']);
  });

  it('`branch` acota la VISTA por sucursal (no se manda al servidor)', () => {
    // Es un filtro client-side sobre lo ya cargado: el servidor re-agrega por ruta, no por
    // sucursal. Mandarlo en `params()` sería pedirle al backend algo que no filtra.
    const { cmp, svc } = montar({ branch: '01,02,03' });
    expect(cmp.fBranch()).toEqual(['01', '02', '03']);
    expect(svc.salesByRoute).toHaveBeenCalledWith(
      expect.not.objectContaining({ branches: expect.anything() }),
    );
  });

  it('⛔ NEGATIVA — sin parámetros no inventa ningún filtro', () => {
    const { cmp, svc } = montar({});
    expect(cmp.routes).toEqual([]);
    expect(cmp.fBranch()).toEqual([]);
    expect(cmp.year).toBe(new Date().getFullYear());
    expect(svc.salesByRoute).toHaveBeenCalledWith(
      expect.objectContaining({ routes: undefined }),
    );
  });

  /*
   * ⚠️ Un `montar()` por caso, con su reset: `TestBed.configureTestingModule` no se puede llamar
   * dos veces sin resetear, y la primera versión de esta prueba lo hacía tres veces en un solo
   * `it` — fallaba por el arnés, no por el código que vigila.
   */
  it.each([['abc'], ['99'], ['3000'], ['']])(
    '⛔ el año basura %p NO se consulta: cae al año en curso',
    (year) => {
      const { cmp } = montar({ year });
      expect(cmp.year).toBe(new Date().getFullYear());
    },
  );

  it('una lista vacía o de puras comas se ignora, no deja el filtro en blanco', () => {
    // `?route=` (vacío) tiene que comportarse como «sin filtro», no como «ninguna ruta»,
    // que dejaría la tabla vacía sin que nadie lo haya pedido.
    const { cmp } = montar({ route: ' , , ' });
    expect(cmp.routes).toEqual([]);
  });
});
