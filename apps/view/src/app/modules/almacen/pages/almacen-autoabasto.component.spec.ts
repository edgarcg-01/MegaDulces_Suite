import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { AutoabastoMesaRenglon, AutoabastoRenglonesResponse } from '@megadulces/contracts';
import { AlmacenAutoabastoComponent } from './almacen-autoabasto.component';
import { AutoabastoService } from '../autoabasto.service';
import { AuthService } from '../../../core/services/auth.service';
import { CONTEXT_HELP } from '../../../shared/context-help/context-help.dictionary';

/**
 * `[AB.28]` La mesa de Autoabasto sobre la cuenta única (FASE_AB §16.8): un almacén a la vez (D2),
 * «Surte» en vez de la «Acción» por sobrante de la red (D3), y lo que no se pudo medir, dicho.
 */
class ResizeObserverStub { observe(): void { /* */ } unobserve(): void { /* */ } disconnect(): void { /* */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const renglon = (p: Partial<AutoabastoMesaRenglon> = {}): AutoabastoMesaRenglon => ({
  product_id: 'p-1', sku: '70056', nombre: 'MAZAPÁN', venta_30d: 10, existencia: 2, objetivo: 12, falta: 10,
  ya_pedido: 2, atorado: 0, negado_30d: 0, en_camino: 3, planeado_compras: 0, falta_neta: 5,
  a_pedir: { cantidad: 5, unidad: 'CJA', factor: 12, cantidad_base: 60, regla: 'cajas' } as never,
  ajuste: null, valor: 90, costo_base: 1.5, posicion: 'bajo_minimo', minimo_menor: 'no_aplica' as never, valor_menor: null,
  estado: 'sin_pedir', surte: { tipo: 'matriz', clave: '01', nombre: '01' },
  diagnostico: { min_stock: 1, reorder_point: 3, max_stock: 12, oc_en_camino: 0, venta_diaria: 0.4, next_due_date: null,
    lead_time_days: null, cadence_days: null, abc_class: null, rung_veredicto: null, sales_rank: 3 },
  ...p,
});

const RESP = (rs: AutoabastoMesaRenglon[], extra: Partial<AutoabastoRenglonesResponse> = {}): AutoabastoRenglonesResponse => ({
  almacen: { id: 'w-02', code: '02', name: 'La Piedad Abastos' }, fecha_mx: '2026-10-23', hora_mx: '11:00', cobertura_dias: 21,
  pedidos_medidos: true, total: rs.length, page: 1, pageSize: 50,
  resumen: {
    renglones: rs.length,
    por_estado: { sin_pedir: 1, compras_lo_planeo: 0, ya_viene: 0, en_politica: 0 },
    por_surte: {
      matriz: { renglones: 1, a_pedir: 1, valor: 90, sin_valuar: 0 },
      proveedor: { renglones: 0, a_pedir: 0, valor: null, sin_valuar: 0 },
      sin_ruta: { renglones: 0, a_pedir: 0, valor: null, sin_valuar: 0 },
    },
    valor_a_pedir: 90, sin_valuar: 0,
  },
  renglones: rs,
  ...extra,
});

const ALMACENES = [{ id: 'w-02', code: '02', name: 'La Piedad Abastos', purchase_zone: null, is_purchase_hub: false }];

function montar(resp: AutoabastoRenglonesResponse, warehouses = ALMACENES) {
  const llamadas: unknown[] = [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AlmacenAutoabastoComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]),
      { provide: AutoabastoService, useValue: {
        filtros: () => of({ warehouses, suppliers: [] }),
        renglones: (q: unknown) => { llamadas.push(q); return of(resp); },
      } },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'u1', permissions: {} }), token: () => null } },
    ],
  });
  const f = TestBed.createComponent(AlmacenAutoabastoComponent);
  f.detectChanges();
  return { f, llamadas };
}
const texto = (f: ReturnType<typeof montar>['f']) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

describe('[AB.28] la mesa sobre la cuenta única', () => {
  it('con un solo almacén, la mesa es la de ese almacén y se carga sola', () => {
    const { f, llamadas } = montar(RESP([renglon()]));
    expect(llamadas).toHaveLength(1);
    expect((llamadas[0] as { warehouse_id: string }).warehouse_id).toBe('w-02');
    expect(texto(f)).toContain('La Piedad Abastos');
  });

  it('D3: muestra Falta neta, Surte y Estado; la «Acción» por sobrante de la red ya no está', () => {
    const t = texto(montar(RESP([renglon()])).f);
    expect(t).toContain('Falta neta');
    expect(t).toContain('Surte');
    expect(t).toContain('Falta por pedir');
    expect(t).not.toContain('Acción');
    expect(t).not.toContain('De la red');
    expect(t).not.toContain('A comprar');
  });

  it('⛔ la matriz que surte se NOMBRA, nunca se numera', () => {
    const t = texto(montar(RESP([renglon()])).f);
    expect(t).toContain('Padre Hidalgo');
  });

  it('D2: con varios almacenes no adivina uno: pide elegir y no carga nada', () => {
    const dos = [...ALMACENES, { id: 'w-03', code: '03', name: '8 Esquinas', purchase_zone: null, is_purchase_hub: false }];
    const { f, llamadas } = montar(RESP([]), dos);
    expect(llamadas).toHaveLength(0);
    expect(texto(f)).toContain('Cada mesa es de un solo almacén');
  });

  it('⛔ si lo ya pedido no se pudo medir, lo dice arriba', () => {
    const t = texto(montar(RESP([renglon()], { pedidos_medidos: false })).f);
    expect(t).toContain('no se pudo medir');
  });

  it('el primario es cuántos renglones nadie ha pedido', () => {
    const c = montar(RESP([renglon()])).f.componentInstance;
    expect(c.kpis()[0]).toMatchObject({ label: 'Falta por pedir', value: 1, tone: 'bad' });
  });

  it('⛔ un importe que no se pudo medir sale «—», nunca $0', () => {
    const c = montar(RESP([renglon()])).f.componentInstance;
    const proveedor = c.kpis().find((k) => k.label === 'Se pide al proveedor');
    expect(proveedor).toMatchObject({ value: '—', format: 'text' });
  });

  it('el filtro de estado va al servidor y vuelve a la página 1', () => {
    const { f, llamadas } = montar(RESP([renglon()]));
    f.componentInstance.page.set(3);
    f.componentInstance.setEstado('ya_viene');
    expect(llamadas.at(-1)).toMatchObject({ estado: 'ya_viene', page: 1 });
    f.componentInstance.setEstado('todos');
    expect((llamadas.at(-1) as { estado?: string }).estado).toBeUndefined();
  });
});

describe('[AB.28] la ayuda de la mesa existe en el diccionario', () => {
  const topic = CONTEXT_HELP['almacen-autoabasto'];
  const terminos = topic.groups!.flatMap((g) => g.entries.map((e) => e.term));
  it.each(['Falta', 'Ya viene', 'Falta neta', 'Surte', 'Posición', 'Falta por pedir', 'Compras lo planeó', 'Valor sin medir'])(
    'documenta «%s»', (t) => {
      expect(terminos).toContain(t);
    });
  it('no repite términos', () => {
    expect(new Set(terminos).size).toBe(terminos.length);
  });
});
