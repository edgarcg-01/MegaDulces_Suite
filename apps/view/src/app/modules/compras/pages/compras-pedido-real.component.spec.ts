import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';

import { ComprasPedidoRealComponent } from './compras-pedido-real.component';
import { ComprasService } from '../compras.service';
import { AuthService } from '../../../core/services/auth.service';
import { UsoService } from '../../../core/services/uso.service';

/**
 * `[RA-PERF.6]` / `[RA-PERF.8]` — el primer candado de ESTA pantalla.
 *
 * Medido el 2026-10-07: `/compras/pedido` tenía **cero** pruebas sobre el componente. Las cuatro
 * specs del módulo (`pedido-redondeo`, `pedido-unidades`, `pedido-requisicion-*`) cubren los
 * ayudantes que se habían EXTRAÍDO; las 3,652 líneas que quedaron —la orquestación de carga, el
 * grafo de signals, el guard de recursión y la píldora— no tenían ninguna. Por eso un guard que no
 * podía disparar sobrevivió 69 días en prod y una píldora muda pasó varias revisiones.
 *
 * Montar la pantalla también compila su template, que es la otra mitad de lo que no se verificaba.
 */

/** jsdom no implementa ResizeObserver y PrimeNG lo usa al montar. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const FILTROS = { suppliers: [], brands: [], categories: [], warehouses: [] };

const VACIO = {
  total: 0, page: 1, pageSize: 20, coverage_days: 30,
  territories: [], totals: { pedido: 0, venta: 0, exis: 0 }, rows: [],
};

const FRESCO: Freshness = {
  data_as_of: new Date(Date.now() - 4 * 60_000).toISOString(),
  status: 'fresh', stale: false, age_human: '4 min',
  inputs: [{
    key: 'fact_replenishment_plan_stock', label: 'Fact del pedido (existencia + demanda)',
    at: new Date(Date.now() - 4 * 60_000).toISOString(), age_human: '4 min', status: 'fresh', stale: false,
  }],
};

/** `[RA-CICLO.1]` Un canal de reabasto, con lo mínimo que la pantalla lee de él. */
function canal(p: Partial<Record<string, unknown>> = {}) {
  return {
    warehouse_id: 'w-01', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
    supplier_id: 's-1', supplier_name: 'DULCES DEMO', via: 'purchase',
    source_warehouse_id: null, source_warehouse_code: null,
    cadence_days: 15, health_band: null,
    last_delivery_date: '2026-09-01', next_due_date: '2026-09-16',
    days_to_due: -22, lead_time_days: 4,
    n_skus: 40, n_below: 12, suggested_qty: 300, suggested_cost: 125000,
    ...p,
  };
}

function montar(workbook: Record<string, unknown>, worklist?: unknown) {
  const api = {
    filters: () => of(FILTROS),
    workbook: () => of(workbook),
    purchaseSuggestion: () => of({ rows: [] }),
    transferSuggestion: () => of({ rows: [] }),
    overstock: () => of({ rows: [] }),
    deadStock: () => of({ rows: [], total_value: 0 }),
    worklist: () => (worklist === 'error'
      ? throwError(() => new Error('500'))
      : of(worklist ?? { total: 0, vencidos: 0, hoy: 0, prox7: 0, page: 1, pageSize: 500, rows: [] })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ComprasPedidoRealComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ComprasService, useValue: api },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null, has: () => true } },
      { provide: UsoService, useValue: { reportarIncidente: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(ComprasPedidoRealComponent);
  fixture.detectChanges();
  return fixture;
}

describe('[RA-PERF.8] la píldora dice la edad del DATO, y declara cuando no la sabe', () => {
  it('arranca en «sin medir»: nunca nace diciendo que está al día', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.frescura().status).toBe('unknown');
    expect(c.frescura().data_as_of).toBeNull();
  });

  it('toma la frescura que manda el SERVIDOR, no el reloj del navegador', () => {
    const c = montar({ ...VACIO, freshness: FRESCO }).componentInstance;
    expect(c.frescura().status).toBe('fresh');
    expect(c.frescura().data_as_of).toBe(FRESCO.data_as_of);
  });

  it('⛔ un backend que NO manda frescura deja «sin medir», no la frescura de la carga', () => {
    const c = montar(VACIO).componentInstance;
    // Ésta es la regresión que importa: caer a `Date.now()` acá es el bug que VP.0 corrigió en
    // 21 de 24 píldoras de la app — prometer la edad del dato y medir la de la consulta.
    expect(c.frescura().status).toBe('unknown');
    expect(c.frescura().stale).toBe(true);
  });

  it('la pantalla igual se monta y carga sus filas con el campo ausente (backend viejo)', () => {
    const c = montar({ ...VACIO, total: 3, rows: [] }).componentInstance;
    expect(c.wbTotal()).toBe(3);
  });
});

describe('[RA-PERF.6] el guard de recursión existe y no se dispara en uso normal', () => {
  it('money() formatea sin reventar aunque se lo llame miles de veces (volumen != recursión)', () => {
    const c = montar(VACIO).componentInstance;
    let ultimo = '';
    // Muy por encima del contador de 800: el camino caliente real (expandir todo) llama money()
    // cientos de veces con stack CORTO, y eso NO puede tumbar la pantalla.
    for (let i = 0; i < 3000; i++) ultimo = c.money(i);
    expect(ultimo).toContain('2,999');
  });

  it('money() no inventa un número cuando le llega basura', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.money(null)).toContain('0');
    expect(c.money(undefined)).toContain('0');
    expect(c.money('no-es-un-numero')).toContain('0');
  });
});

describe('[RA-CICLO.1] el CUÁNDO: a quién le toca pedir, y qué pasa cuando no se puede medir', () => {
  it('⛔ antes de leer nada, el tablero NO dice «0 vencidos»: dice sin medir', () => {
    const c = montar(VACIO).componentInstance;
    // Arranca en modo 'pedido', así que el ciclo todavía no se consultó. Dibujar un 0 acá sería
    // exactamente el `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional:
    // el comprador leería «nadie está vencido» cuando lo que pasa es que nadie preguntó.
    expect(c.cicloKpi().every((k) => k.value === '—')).toBe(true);
    expect(c.cicloKpi()[0].label).toBe('Vencidos');
  });

  it('⛔ si la consulta FALLA, sigue sin medir y lo declara — no cae a cero', () => {
    const c = montar(VACIO, 'error').componentInstance;
    c.setMode('ciclo');
    expect(c.wlError()).toBe(true);
    expect(c.wlRows().length).toBe(0);
    expect(c.cicloKpi()[0].value).toBe('—');
  });

  it('con datos reales cuenta los vencidos y los marca mal, no los deja en neutro', () => {
    const c = montar(VACIO, { total: 737, vencidos: 472, hoy: 31, prox7: 90, page: 1, pageSize: 500, rows: [canal()] }).componentInstance;
    c.setMode('ciclo');
    expect(c.wlError()).toBe(false);
    expect(c.wlRows().length).toBe(1);
    const k = c.cicloKpi();
    expect(k[0].value).toBe(472);
    expect(k[0].tone).toBe('bad');
    expect(k[3].value).toBe(737);
  });

  it('cero vencidos SÍ es un cero legítimo y se pinta bien — la ausencia medida no es la no medida', () => {
    const c = montar(VACIO, { total: 10, vencidos: 0, hoy: 0, prox7: 4, page: 1, pageSize: 500, rows: [] }).componentInstance;
    c.setMode('ciclo');
    expect(c.cicloKpi()[0].value).toBe(0);
    expect(c.cicloKpi()[0].tone).toBe('ok');
  });

  it('el atraso distingue las cuatro situaciones, y «sin fecha» no se disfraza de al día', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.atrasoTxt(canal({ days_to_due: -22 }))).toBe('22 d tarde');
    expect(c.atrasoSev(canal({ days_to_due: -22 }))).toBe('danger');
    expect(c.atrasoTxt(canal({ days_to_due: 0 }))).toBe('hoy');
    expect(c.atrasoSev(canal({ days_to_due: 0 }))).toBe('warn');
    expect(c.atrasoTxt(canal({ days_to_due: 5 }))).toBe('en 5 d');
    expect(c.atrasoTxt(canal({ days_to_due: null }))).toBe('sin fecha');
    expect(c.atrasoSev(canal({ days_to_due: null }))).toBe('secondary');
  });

  it('«Armar» deja el proveedor y la sucursal puestos en el Pedido — ése es el puente', () => {
    const c = montar(VACIO, { total: 1, vencidos: 1, hoy: 0, prox7: 0, page: 1, pageSize: 500, rows: [canal()] }).componentInstance;
    c.setMode('ciclo');
    c.irAPedido(canal());
    expect(c.fSupplier).toBe('s-1');
    expect(c.wbWarehouses).toEqual(['w-01']);
    expect(c.mode()).toBe('pedido');
  });
});

describe('[RA-PEND.2] el lote se frena ANTES del clic, no después de perder el trabajo', () => {
  /** Un documento válido del plan: compra de un proveedor, un almacén, un renglón con cantidad. */
  const doc = (o: Record<string, unknown> = {}) => ({
    warehouse_id: 'w-01', supplier_id: 's-1', source_type: 'supplier',
    lines: [{ product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 3, unit_cost: 100 }],
    ...o,
  });

  it('un plan sano no tiene bloqueantes — el freno no puede estorbar el camino feliz', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc(), doc({ warehouse_id: 'w-08' })]);
    expect(c.planBloqueos()).toEqual([]);
  });

  it('⛔ pasarse del tope del lote se dice acá, no en un 400 después de armar todo', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set(Array.from({ length: 301 }, () => doc()));
    const bl = c.planBloqueos();
    expect(bl.length).toBeGreaterThan(0);
    expect(bl[0]).toContain('301');
    expect(bl[0]).toContain('300');
  });

  it('un documento sin renglones con cantidad lo señala POR NÚMERO — el lote es todo o nada', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc(), doc({ lines: [{ product_id: 'p-2', final_qty: 0, unit_cost: 10 }] })]);
    expect(c.planBloqueos().some((b: string) => b.includes('documento 2'))).toBe(true);
  });

  it('una compra que mezcla dos proveedores se frena: el servidor la rechaza y tira el lote entero', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc({ lines: [
      { product_id: 'p-1', supplier_id: 's-1', source_type: 'supplier', final_qty: 2, unit_cost: 10 },
      { product_id: 'p-2', supplier_id: 's-2', source_type: 'supplier', final_qty: 2, unit_cost: 10 },
    ] })]);
    expect(c.planBloqueos().some((b: string) => b.includes('más de un proveedor'))).toBe(true);
  });

  it('un traspaso sin origen se frena — es una de las reglas duras de insertRequisition', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set([doc({ source_type: 'branch', supplier_id: null, source_warehouse_id: null })]);
    expect(c.planBloqueos().some((b: string) => b.includes('desde dónde sale'))).toBe(true);
  });

  it('⭐ el tope es EXACTO: 300 pasa y 301 no — un off-by-one acá bloquea un lote legítimo', () => {
    const c = montar(VACIO).componentInstance;
    c.plan.set(Array.from({ length: 300 }, () => doc()));
    expect(c.planBloqueos()).toEqual([]);
  });
});

describe('[RA-PERF.7] los índices memoizados no cambian lo que la pantalla responde', () => {
  it('un producto sin filas devuelve SIEMPRE la misma referencia vacía', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.trasRows('no-existe')).toBe(c.trasRows('otro-que-tampoco'));
    expect(c.trasRows('no-existe').length).toBe(0);
  });

  it('sin desglose cargado, el traspaso del producto es 0 y no revienta', () => {
    const c = montar(VACIO).componentInstance;
    expect(c.prodTr('no-existe')).toBe(0);
    expect(c.detailRows('no-existe')).toEqual([]);
  });
});
