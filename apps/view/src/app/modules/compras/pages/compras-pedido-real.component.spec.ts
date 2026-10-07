import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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

function montar(workbook: Record<string, unknown>) {
  const api = {
    filters: () => of(FILTROS),
    workbook: () => of(workbook),
    purchaseSuggestion: () => of({ rows: [] }),
    transferSuggestion: () => of({ rows: [] }),
    overstock: () => of({ rows: [] }),
    deadStock: () => of({ rows: [], total_value: 0 }),
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
