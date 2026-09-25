import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { FinanzasIngresosComponent } from './finanzas-ingresos.component';
import type { IncomeReport, IncomeSources, IncomeTree } from '../../comercial/comercial.service';

/**
 * `[IG.2]` Candado de la pantalla de Ingresos contables.
 *
 * Además de comprobar el comportamiento, **compila el template**: `tsc` no mira adentro de una
 * plantilla de Angular, y montar el componente es la única compuerta de este lado.
 *
 * Lo que cuida de fondo es lo que puede publicar un número equivocado o esconder por qué cambió:
 * que el residuo NO se desglose como si fueran plazas, que la cobertura hable de PLAZAS, que el
 * cuadre marque la cobranza como no comparable, y que el mes cortado salga rotulado.
 */

const REPORTE = (p: Partial<IncomeReport> = {}): IncomeReport => ({
  from: '2026-06-27', to: '2026-09-25', prev_from: '2026-03-28', prev_to: '2026-06-26',
  freshness: { data_as_of: '2026-09-25T17:03:54.000Z', status: 'fresh', stale: false, age_human: '2 min', inputs: [] },
  coverage: {
    measured: true, pct: 91.4, note: '1 plaza no está en todos los meses del rango: MORELIA MADERO (desde 2026-09).',
    grupos: ['CANINDO', 'MORELIA ABASTOS', 'MORELIA MADERO'],
    grupos_todos: ['CANINDO', 'MORELIA ABASTOS'],
    grupos_parciales: [{ grupo: 'MORELIA MADERO', desde: '2026-09', total: 6_155_966.01 }],
    meses_parciales: ['2026-06', '2026-09'],
  },
  comparativo: {
    grupos_ambos: ['CANINDO', 'MORELIA ABASTOS'], solo_actual: ['MORELIA MADERO'], solo_previo: [],
    total: 155_698_155.92, total_prev: 140_000_000, delta_pct: 11.2,
    total_comparable: 149_542_189.91, total_prev_comparable: 140_000_000, delta_pct_comparable: 6.8,
    universo_cambio: true,
  },
  group_by: 'canal', total: 155_698_155.92, movimientos: 3_860,
  by_canal: [
    { canal: 'mostrador', label: 'Mostrador', total: 92_970_994.91, movs: 697 },
    { canal: 'otro', label: 'Sin canal declarado', total: 19_356_397.89, movs: 1789 },
  ],
  rows: [
    { key: 'mostrador', label: 'mostrador', canal: 'mostrador', total: 92_970_994.91, movs: 697, share_pct: 59.7, prev_total: null, delta_pct: null },
  ],
  series: [
    { mes: '2026-06', total: 20_000_000, mostrador: 12_000_000, telemarketing: 4_000_000, ruta: 3_000_000, vecinal: 1_000_000, contado: 0, otro: 0, parcial: true, plazas: 6 },
    { mes: '2026-07', total: 56_987_270.38, mostrador: 30_000_000, telemarketing: 12_000_000, ruta: 9_000_000, vecinal: 4_987_270.38, contado: 0, otro: 1_000_000, parcial: false, plazas: 6 },
    { mes: '2026-09', total: 35_961_728.8, mostrador: 20_000_000, telemarketing: 8_000_000, ruta: 4_000_000, vecinal: 2_000_000, contado: 0, otro: 1_961_728.8, parcial: true, plazas: 9 },
  ],
  ...p,
});

const ARBOL: IncomeTree = {
  from: '2026-06-27', to: '2026-09-25', total: 112_327_392.8,
  tree: [
    {
      key: 'mostrador', label: 'Mostrador', level: 'canal', total: 92_970_994.91, movs: 697, share_pct: 82.8,
      children: [{ key: 'mostrador|MORELIA ABASTOS', label: 'MORELIA ABASTOS', level: 'plaza', total: 30_208_668, movs: 210, share_pct: 26.9 }],
    },
    // El residuo llega SIN hijos desde el servidor: sus "plazas" son nombres de cliente sueltos.
    { key: 'otro', label: 'Sin canal declarado', level: 'canal', total: 19_356_397.89, movs: 1789, share_pct: 17.2, children: [] },
  ],
};

const CUADRE: IncomeSources = {
  from: '2026-08-01', to: '2026-08-31',
  fuentes: [
    { key: 'contable', label: 'Contable (pólizas 401, CEDIS · UD1301)', monto: 55_940_323.96, delta_pct: 0, comparable: true, nota: 'Lo que publica esta pantalla.' },
    { key: 'canal', label: 'Por canal (feed nocturno)', monto: 55_863_192.6, delta_pct: -0.1, comparable: true, nota: 'Mismo universo por otro camino.' },
    { key: 'hecho_venta', label: 'Hecho de venta (mv_sales_blended)', monto: 54_265_356.22, delta_pct: -3, comparable: true, nota: 'Testigo independiente.' },
    { key: 'cobranza', label: 'Cobranza (UA0501)', monto: 43_930_836.96, delta_pct: -21.5, comparable: false, nota: '⚠️ NO comparable de frente: es lo que se COBRÓ.' },
  ],
};

describe('FinanzasIngresosComponent', () => {
  let fix: ComponentFixture<FinanzasIngresosComponent>;
  let c: FinanzasIngresosComponent;
  let http: HttpTestingController;

  const arrancar = (rep: IncomeReport = REPORTE()) => {
    http.expectOne((r) => r.url.includes('/analytics/income/tree')).flush(ARBOL);
    http.expectOne((r) => r.url.includes('/analytics/income') && !r.url.includes('/tree') && !r.url.includes('/sources')).flush(rep);
    fix.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FinanzasIngresosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(FinanzasIngresosComponent);
    c = fix.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fix.detectChanges();
  });

  afterEach(() => http.verify());

  it('el template compila y monta', () => {
    arrancar();
    expect(c).toBeTruthy();
  });

  it('arranca en el árbol por canal, no en una tabla cruda', () => {
    arrancar();
    expect(c.view()).toBe('arbol');
    expect(c.treeNodes().length).toBe(2);
  });

  it('NO despliega el residuo como si fueran plazas', () => {
    arrancar();
    const residuo = c.treeNodes().find((n) => (n.data as { key: string }).key === 'otro');
    expect(residuo).toBeTruthy();
    // 233 de las 271 "plazas" del rango por defecto caen acá y son nombres de cliente sueltos:
    // desplegarlas fingiría 233 puntos de venta.
    expect(residuo!.children?.length ?? 0).toBe(0);
    expect((residuo!.data as { residuo: boolean }).residuo).toBe(true);
  });

  it('la cobertura habla de PLAZAS y publica los dos Δ', () => {
    arrancar();
    const txt = (fix.nativeElement as HTMLElement).querySelector('.in-cov')?.textContent ?? '';
    expect(txt).toContain('+11.2%');
    expect(txt).toContain('+6.8%');
    expect(txt).toContain('plazas');
    expect(txt).toContain('MORELIA MADERO');
  });

  it('rotula el mes cortado en el eje — es lo único que viaja con la barra', () => {
    arrancar();
    expect(c.chartData().labels).toEqual(['2026-06 ·parcial', '2026-07', '2026-09 ·parcial']);
  });

  it('no pinta el aviso cuando la tendencia es comparable', () => {
    arrancar(REPORTE({
      coverage: {
        measured: true, pct: 100, note: 'Plazas: las mismas reportan en todos los meses.',
        grupos: ['CANINDO'], grupos_todos: ['CANINDO'], grupos_parciales: [], meses_parciales: [],
      },
      comparativo: null,
    }));
    expect(c.coverageAviso()).toBeNull();
    expect((fix.nativeElement as HTMLElement).querySelector('.in-cov')).toBeNull();
  });

  it('el cuadre marca la cobranza como NO comparable de frente', () => {
    arrancar();
    c.setView('cuadre');
    http.expectOne((r) => r.url.includes('/analytics/income/sources')).flush(CUADRE);
    fix.detectChanges();
    const filas = (fix.nativeElement as HTMLElement).querySelectorAll('tr.in-nocomp');
    expect(filas.length).toBe(1);
    expect(filas[0].textContent).toContain('Cobranza');
    // Y su Δ NO se pinta como si fuera una discrepancia.
    expect(filas[0].textContent).not.toContain('-21.5%');
  });

  it('dice NO MEDIDO en vez de $0 cuando una fuente no se pudo medir', () => {
    arrancar();
    c.setView('cuadre');
    http.expectOne((r) => r.url.includes('/analytics/income/sources')).flush({
      ...CUADRE,
      fuentes: [{ ...CUADRE.fuentes[1], monto: null, delta_pct: null }],
    });
    fix.detectChanges();
    expect((fix.nativeElement as HTMLElement).textContent).toContain('NO MEDIDO');
  });

  it('dice «sin base» en vez de 0 % cuando no hay período previo', () => {
    arrancar();
    expect(c.signo(null)).toBe('sin base');
    expect(c.signo(11.2)).toBe('+11.2%');
  });
});
