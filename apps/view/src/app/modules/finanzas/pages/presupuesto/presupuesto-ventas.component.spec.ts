import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PresupuestoVentasComponent } from './presupuesto-ventas.component';
import type { ProposeCoverage, SalesComparison } from './presupuesto-shared';

/**
 * `[PVI.9]` — La vista **Ventas** del presupuesto, recién salida del shell.
 *
 * ── Por qué esta spec existe, y por qué es el candado y no un extra ─────────────────────────
 *
 * En este repo **no se puede compilar `view` en local** (regla dura: nada de `nx build` ni
 * `nx serve`; compila el CI), y `view` **no tiene target `typecheck`**. O sea que para un
 * componente recién extraído —395 líneas movidas de archivo— montarlo en una prueba es
 * literalmente **la única verificación de que existe, que sus imports resuelven y que su
 * plantilla se renderiza** antes de que lo vea el CI. Por eso la primera prueba es «monta y
 * pinta»: parece trivial y es la que detecta un refactor roto.
 *
 * Lo demás protege la lógica que viajó, que es justo la que ya costó dinero:
 *
 *   · `[VSO.8]` el pivote FILTRABA por una lista literal de canales, y las entidades de canal
 *     `mayoreo` y `contado_nf` no producían renglón: **$21,754,366 de meta capturada** que la
 *     pantalla no pintaba. Acá se prueba con un canal que no está en la lista de orden conocida.
 *   · `ADR-056` «sin datos» ≠ cero, tres veces: el CREC sin real es **desconocido, no −100 %**;
 *     el subtotal sin ningún real es **null, no 0**; y el KPI de cumplimiento sin meta es un
 *     guion, no un `0 %` disfrazado con `format: 'text'`.
 *   · `[PVI.2]` el desglose en dinero devuelve **null** cuando la API no lo emite — un objeto
 *     en ceros colapsaría «vale cero» con «no lo pude medir».
 *
 * Y es la **primera prueba de esta pantalla**: el presupuesto tenía 0 specs del lado de `view`.
 */

const budget = { id: 'b1', name: 'Presupuesto', fiscal_year: 2027, status: 'borrador' };

/** Una celda del pivote; lo que no se declara queda en null a propósito. */
const celda = (over: Record<string, unknown>) => ({
  entity_key: 'x', channel: 'ruta', channel_label: 'Ruta directa (RD)', entity_type: 'warehouse',
  warehouse_code: 'W1', branch_name: null, period_no: 1,
  meta: null, real: null, real_prior: null,
  cumplimiento_pct: null, crec_pct: null, part_pct: null, method: null,
  ...over,
});

const comparacion = (cells: unknown[]): SalesComparison => ({
  budget, prior_year: 2026, cells,
  totals: { meta: 0, real: null, real_prior: 0, cumplimiento_pct: null, crec_pct: null },
  data_as_of: null, real_available: false, freshness: null, coverage: null,
} as unknown as SalesComparison);

const montar = async (over: Record<string, unknown> = {}): Promise<ComponentFixture<PresupuestoVentasComponent>> => {
  await TestBed.configureTestingModule({
    imports: [PresupuestoVentasComponent],
  }).compileComponents();
  const fix = TestBed.createComponent(PresupuestoVentasComponent);
  fix.componentRef.setInput('budget', budget);
  fix.componentRef.setInput('tab', 'plan');
  for (const [k, v] of Object.entries(over)) fix.componentRef.setInput(k, v);
  fix.detectChanges();
  return fix;
};

describe('[PVI.9] vista Ventas — monta y pinta', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('⭐ se renderiza con lo mínimo: es la única verificación de que el refactor no quedó roto', async () => {
    const fix = await montar();
    const txt = (fix.nativeElement as HTMLElement).textContent || '';
    expect(txt).toContain('Presupuesto de ventas');
    expect(txt).toContain('2027');
  });

  it('sin comparación cargada invita a cargarla, en vez de mostrar una tabla vacía', async () => {
    const fix = await montar();
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Cargar meta vs real');
  });
});

describe('[PVI.9] el pivote entidad × periodo', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('agrega por entidad y agrega subtotal de canal + total general', async () => {
    const cmp = (await montar({
      cmp: comparacion([
        celda({ entity_key: 'e1', period_no: 1, meta: 100, real: 90, real_prior: 50, method: 'historico_ajustado' }),
        celda({ entity_key: 'e1', period_no: 2, meta: 200, real: 110, real_prior: 50 }),
        celda({ entity_key: 'e2', period_no: 1, meta: 300, real: 300, real_prior: 100 }),
      ]),
    })).componentInstance;
    const rows = cmp.rows();
    expect(rows.find((r) => r.entity_key === 'e1')?.meta).toBe(300);   // 100 + 200
    expect(rows.find((r) => r.label.startsWith('Subtotal'))?.meta).toBe(600);
    const total = rows[rows.length - 1];
    expect(total.label).toBe('Total Venta');
    expect(total.meta).toBe(600);
    expect(total.real).toBe(500);
  });

  it('el periodo elegido acota las celdas', async () => {
    const fix = await montar({
      cmp: comparacion([
        celda({ entity_key: 'e1', period_no: 1, meta: 100 }),
        celda({ entity_key: 'e1', period_no: 2, meta: 900 }),
      ]),
    });
    expect(fix.componentInstance.rows().find((r) => r.entity_key === 'e1')?.meta).toBe(1000);
    fix.componentRef.setInput('period', 2);
    fix.detectChanges();
    expect(fix.componentInstance.rows().find((r) => r.entity_key === 'e1')?.meta).toBe(900);
  });

  it('⛔ [VSO.8] un canal fuera de la lista de orden conocida NO se descarta', async () => {
    const cmp = (await montar({
      cmp: comparacion([
        celda({ entity_key: 'e9', channel: 'canal_nuevo', channel_label: 'Canal nuevo', meta: 777 }),
      ]),
    })).componentInstance;
    const rows = cmp.rows();
    expect(rows.find((r) => r.entity_key === 'e9')?.meta).toBe(777);
    expect(rows[rows.length - 1].meta).toBe(777);
  });

  it('⛔ ADR-056: sin real, el CREC es DESCONOCIDO — no −100 %', async () => {
    const cmp = (await montar({
      cmp: comparacion([celda({ entity_key: 'e1', meta: 100, real: null, real_prior: 500 })]),
    })).componentInstance;
    const fila = cmp.rows().find((r) => r.entity_key === 'e1');
    expect(fila?.crec_pct).toBeNull();
    expect(fila?.real).toBeNull();
  });

  it('⛔ ADR-056: un subtotal sin NINGÚN real queda en null, no en 0', async () => {
    const cmp = (await montar({
      cmp: comparacion([
        celda({ entity_key: 'e1', meta: 100 }),
        celda({ entity_key: 'e2', meta: 200 }),
      ]),
    })).componentInstance;
    const sub = cmp.rows().find((r) => r.label.startsWith('Subtotal'));
    expect(sub?.meta).toBe(300);
    expect(sub?.real).toBeNull();
  });

  it('una entidad con dos orígenes distintos se declara «mixto»', async () => {
    const cmp = (await montar({
      cmp: comparacion([
        celda({ entity_key: 'e1', period_no: 1, meta: 1, method: 'historico_ajustado' }),
        celda({ entity_key: 'e1', period_no: 2, meta: 1, method: 'estacional' }),
      ]),
    })).componentInstance;
    expect(cmp.rows().find((r) => r.entity_key === 'e1')?.method).toBe('mixto');
    expect(cmp.methodLabel('mixto')).toBe('Mixto');
  });
});

describe('[PVI.9] las ausencias que no se dibujan en cero', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('⛔ el KPI de cumplimiento sin meta es un guion, y su tono queda inhabilitado', async () => {
    const cmp = (await montar()).componentInstance;
    const kpis = cmp.salesKpis(comparacion([]));
    const cumpl = kpis.find((k) => k.label === 'Cumplimiento');
    expect(cumpl?.value).toBe('—');
    expect(cumpl?.format).toBe('text');
    expect(cumpl?.tone).toBeUndefined();
  });

  it('el total se rotula con cuántos períodos cubre cuando NO cubre el año', async () => {
    const cmp = (await montar()).componentInstance;
    const c = comparacion([]);
    c.periodos = { del_anio: 13, con_meta: 10, sin_meta: [11, 12, 13], completo: false, referencia: null, nota: 'faltan 3' };
    const kpis = cmp.salesKpis(c);
    expect(kpis[0].label).toBe('Meta de 10 de 13 períodos');
    expect(kpis[0].tone).toBe('warn');
  });

  it('⛔ [PVI.2] sin desglose en dinero devuelve null, nunca un objeto en ceros', async () => {
    const cmp = (await montar()).componentInstance;
    expect(cmp.covEnDinero({ proxy_canal: 3 } as unknown as ProposeCoverage)).toBeNull();
    expect(cmp.proxyAviso({ proxy_canal: 3 } as unknown as ProposeCoverage)).toBeNull();
  });

  it('[PVI.2] con desglose y proxy, el aviso dice DE DÓNDE sale la cifra', async () => {
    const cmp = (await montar()).componentInstance;
    const cov = {
      historico_ajustado: 1, estacional: 1, proxy_canal: 104, sin_base_declarado: 0, no_signal: 0, manual_kept: 0,
      coverage_monto: { historico_ajustado: 1, estacional: 1, proxy_canal: 197160564, sin_base_declarado: 0 },
      proxy_canal_pct: 0.2446,
    } as ProposeCoverage;
    const aviso = cmp.proxyAviso(cov);
    expect(aviso).toContain('24.5 % de la meta');
    expect(aviso).toContain('PROMEDIO DE OTRAS entidades');
    expect(aviso).toContain('104 celdas sin base');
  });
});

describe('[PVI.9] lo que el hijo le pide al shell', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('emite acciones, no datos: el estado y el HTTP viven en el shell', async () => {
    const cmp = (await montar()).componentInstance;
    const visto: string[] = [];
    cmp.tabChange.subscribe((t) => visto.push('tab:' + t));
    cmp.proposePlan.subscribe(() => visto.push('propose'));
    cmp.loadComparison.subscribe(() => visto.push('load'));
    cmp.projectTargets.subscribe(() => visto.push('project'));
    cmp.periodChange.subscribe((p) => visto.push('period:' + p));

    cmp.tabChange.emit('indicadores');
    cmp.proposePlan.emit();
    cmp.loadComparison.emit();
    cmp.projectTargets.emit();
    cmp.periodChange.emit(7);

    expect(visto).toEqual(['tab:indicadores', 'propose', 'load', 'project', 'period:7']);
  });
});

/**
 * `[PU.17]` — **La meta de una celda se vuelve a corregir a mano.**
 *
 * ADR-074 retiró la meta por celda («reversible fácil si estorba en operación») y PVI volvió los
 * supuestos de solo lectura: quien arma el presupuesto no tenía con qué corregir un número y seguía
 * en Excel. El lápiz vuelve, pero sólo donde el servidor lo acepta: una ENTIDAD (no un subtotal), en
 * un PERIODO (la meta se guarda por periodo) y con el ejercicio ABIERTO (borrador o en revisión).
 * Cada condición tiene su caso negativo: un lápiz que abre y luego el servidor rechaza es peor que
 * no tenerlo.
 */
describe('[PU.17] corregir la meta de una celda', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const celdas = () => comparacion([
    celda({ entity_key: 'e1', branch_name: 'Morelia Centro', period_no: 3, meta: 100, method: 'historico_ajustado' }),
    celda({ entity_key: 'e2', branch_name: 'Zamora', period_no: 3, meta: 200, method: 'estacional' }),
  ]);
  const lapices = (fix: ComponentFixture<PresupuestoVentasComponent>) =>
    Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button[aria-label^="Corregir la meta"]')) as HTMLButtonElement[];

  it('⭐ con un periodo elegido y el ejercicio abierto, cada entidad tiene su lápiz y los subtotales no', async () => {
    const fix = await montar({ cmp: celdas(), period: 3 });
    const b = lapices(fix);
    expect(b.length).toBe(2);   // e1 y e2; ni «Subtotal» ni «Total Venta»
    expect(b.map((x) => x.getAttribute('aria-label'))).toEqual([
      'Corregir la meta de Morelia Centro en P3',
      'Corregir la meta de Zamora en P3',
    ]);
  });

  it('⭐ el lápiz emite el renglón de ESA entidad, para que el shell guarde la celda correcta', async () => {
    const fix = await montar({ cmp: celdas(), period: 3 });
    const pedidos: Array<string | null> = [];
    fix.componentInstance.editMeta.subscribe((r) => pedidos.push(r.entity_key));
    lapices(fix)[1].click();
    expect(pedidos).toEqual(['e2']);
  });

  it('⛔ en la vista anual no hay lápiz: no hay una celda que corregir, y se dice cómo llegar a ella', async () => {
    const fix = await montar({ cmp: celdas(), period: 0 });
    expect(lapices(fix).length).toBe(0);
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Para corregir una meta, elige un periodo.');
  });

  it('⛔ con el ejercicio aprobado no hay lápiz ni invitación: el servidor sólo acepta borrador o revisión', async () => {
    const fix = await montar({ cmp: celdas(), period: 3 });
    fix.componentRef.setInput('budget', { ...budget, status: 'aprobado' });
    fix.detectChanges();
    expect(lapices(fix).length).toBe(0);
    expect((fix.nativeElement as HTMLElement).textContent).not.toContain('Para corregir una meta');
  });

  it('en revisión sí se corrige, igual que en borrador', async () => {
    const fix = await montar({ cmp: celdas(), period: 3 });
    fix.componentRef.setInput('budget', { ...budget, status: 'en_revision' });
    fix.detectChanges();
    expect(lapices(fix).length).toBe(2);
  });
});
