import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ComercialEgresosComponent } from './comercial-egresos.component';
import type { ExpensesReport, ExpensesTree } from '../comercial.service';

/**
 * [GX.19] Candado de la DECLARACIÓN de `/finanzas/egresos`.
 *
 * La pantalla publicaba, en su vista por defecto, **+27.0 %** de "egresos vs período previo" cuando
 * el gasto comparable había subido **+1.1 %**: 26 de esos 27 puntos eran sucursales entrando al
 * universo (06 en ago, 07 y 08 en sep, 01 en jul). Nada de eso estaba mal calculado — el total
 * cuadra al centavo contra la balanza — pero nadie decía que el universo había cambiado.
 *
 * Lo que este archivo cuida no es el número, que se prueba en `expense-coverage.spec.ts` sobre las
 * cifras reales de prod. Es que la pantalla **lo diga**: que el aviso salga cuando hay algo que
 * declarar, que muestre los DOS Δ, y —lo que es igual de importante— que NO salga cuando la
 * tendencia sí es comparable. Un aviso permanente se vuelve parte del fondo y deja de avisar.
 *
 * Y montar el componente compila su template: `tsc` no mira adentro de una plantilla de Angular.
 */

const SERIE = (mes: string, total: number, parcial: boolean, sucursales: number) => ({
  mes, total, compras: total, gastos: 0, financiero: 0, activo: 0, parcial, sucursales,
});

const REPORTE = (p: Partial<ExpensesReport> = {}): ExpensesReport => ({
  from: '2026-06-27', to: '2026-09-25', prev_from: '2026-03-28', prev_to: '2026-06-26',
  freshness: {
    data_as_of: '2026-09-25T09:34:28.000Z', status: 'fresh', stale: false, age_human: '6 h',
    inputs: [],
  },
  coverage: {
    measured: true, pct: 95.9,
    note: '3 sucursales no están en todos los meses del rango: 06 (desde 2026-08).',
    sucursales: ['00', '01', '02', '03', '04', '05', '06', '07', '08'],
    sucursales_todos: ['00', '01', '02', '03', '04', '05'],
    sucursales_parciales: [{ sucursal: '06', desde: '2026-08', total: 6_573_368.44 }],
    meses_parciales: ['2026-06', '2026-09'],
  },
  comparativo: {
    sucursales_ambos: ['00', '02', '03', '04', '05'],
    solo_actual: ['01', '06', '07', '08'], solo_previo: [],
    total: 195_232_624.72, total_prev: 153_731_451.29, delta_pct: 27,
    total_comparable: 155_487_953.74, total_prev_comparable: 153_731_451.29,
    delta_pct_comparable: 1.1, universo_cambio: true,
  },
  group_by: 'cuenta', total: 195_232_624.72, movimientos: 11_212,
  by_familia: [], rows: [],
  series: [SERIE('2026-06', 20_570_056.78, true, 6), SERIE('2026-09', 40_805_147.25, true, 9)],
  ...p,
});

const ARBOL: ExpensesTree = { from: '2026-06-27', to: '2026-09-25', total: 0, tree: [] };

describe('ComercialEgresosComponent — cobertura declarada', () => {
  let fix: ComponentFixture<ComercialEgresosComponent>;
  let c: ComercialEgresosComponent;
  let http: HttpTestingController;

  /** Responde a las 4 llamadas del arranque (sucursales, filtros, reporte, árbol). */
  const arrancar = (rep: ExpensesReport) => {
    http.expectOne((r) => r.url.includes('/analytics/expenses/sucursales')).flush([]);
    http.expectOne((r) => r.url.includes('/analytics/expenses/filters'))
      .flush({ doc_tipos: [], areas: [], mayores: [], dptos: [], conceptos: [] });
    http.expectOne((r) => r.url.includes('/analytics/expenses/tree')).flush(ARBOL);
    http.expectOne((r) => /\/analytics\/expenses(\?|$)/.test(r.urlWithParams.split('?')[0] + (r.urlWithParams.includes('?') ? '?' : '')))
      .flush(rep);
    fix.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComercialEgresosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialEgresosComponent);
    c = fix.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fix.detectChanges();
  });

  afterEach(() => http.verify());

  it('el template compila y monta', () => {
    arrancar(REPORTE());
    expect(c).toBeTruthy();
  });

  it('publica los DOS Δ: el de todas las sucursales y el comparable', () => {
    arrancar(REPORTE());
    const txt = (fix.nativeElement as HTMLElement).querySelector('.ex-cov')?.textContent ?? '';
    expect(txt).toContain('+27%');
    expect(txt).toContain('+1.1%');
    // Y nombra a las que entraron, que es lo accionable: sin eso el lector no sabe qué descontar.
    expect(txt).toContain('01, 06, 07, 08');
  });

  it('declara los meses que el rango corta', () => {
    arrancar(REPORTE());
    const txt = (fix.nativeElement as HTMLElement).querySelector('.ex-cov')?.textContent ?? '';
    expect(txt).toContain('2026-06');
    expect(txt).toContain('2026-09');
  });

  it('NO pinta el aviso cuando la tendencia es comparable — un aviso siempre visible no avisa', () => {
    arrancar(REPORTE({
      coverage: {
        measured: true, pct: 100, note: 'La tendencia es comparable.',
        sucursales: ['00'], sucursales_todos: ['00'], sucursales_parciales: [], meses_parciales: [],
      },
      comparativo: null,
    }));
    expect(c.coverageAviso()).toBeNull();
    expect((fix.nativeElement as HTMLElement).querySelector('.ex-cov')).toBeNull();
  });

  it('con el universo intacto no inventa aviso aunque el comparativo venga', () => {
    arrancar(REPORTE({
      coverage: {
        measured: true, pct: 100, note: 'La tendencia es comparable.',
        sucursales: ['00'], sucursales_todos: ['00'], sucursales_parciales: [], meses_parciales: [],
      },
      comparativo: {
        sucursales_ambos: ['00'], solo_actual: [], solo_previo: [],
        total: 100, total_prev: 80, delta_pct: 25,
        total_comparable: 100, total_prev_comparable: 80, delta_pct_comparable: 25,
        universo_cambio: false,
      },
    }));
    expect(c.coverageAviso()).toBeNull();
  });

  it('marca el mes cortado EN LA ETIQUETA del eje, que es lo único que viaja con la barra', () => {
    arrancar(REPORTE());
    expect(c.chartData().labels).toEqual(['2026-06 ·parcial', '2026-09 ·parcial']);
  });

  it('dice «sin base» en vez de 0 % cuando no hay período previo con qué comparar', () => {
    arrancar(REPORTE()); // el componente ya pidió sus 4 requests en el beforeEach: hay que cerrarlas
    expect(c.signo(null)).toBe('sin base');
    expect(c.signo(27)).toBe('+27%');
    expect(c.signo(-3.2)).toBe('-3.2%');
  });

  it('el aviso se calla si la cobertura no se pudo medir — no afirma nada', () => {
    arrancar(REPORTE({
      coverage: {
        measured: false, pct: null, note: 'Sin movimientos en el período.',
        sucursales: [], sucursales_todos: [], sucursales_parciales: [], meses_parciales: [],
      },
      comparativo: null,
    }));
    expect(c.coverageAviso()).toBeNull();
  });
});
