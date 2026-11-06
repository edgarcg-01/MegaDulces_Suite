import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.41]` — **La ruta lleva el nombre de su chofer** (Edgar, 2026-11-05).
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. La fila muestra el chofer; sin fuente que lo sepa dice «sin chofer asignado», no un blanco
 *     (un blanco se lee como «nadie maneja esa ruta»).
 *  2. Se busca por chofer: es por lo que la gente conoce a una camioneta.
 *  3. El nombre ficticio de la prueba no puede coincidir con ninguna otra columna (negativa).
 */

const fila = (route_no: string, driver_name: string | null): SalesByRouteRow => ({
  warehouse_code: '01', warehouse_name: 'Padre Hidalgo', route_code: `WIN-${route_no}`, route_no,
  label: route_no, driver_name, driver_source: driver_name ? 'comision' : null,
  monthly: { '10': { revenue: 100, units: 0, tickets: 1 } },
  revenue_total: 100, units_total: 0, tickets_total: 1, share_pct: 0,
});

const REPORTE = {
  year: 2026, months: ['10'], generated_at: '', freshness: null,
  totals: { revenue: 0, units: 0, tickets: 0 }, monthly_totals: {},
  rows: [fila('21', 'Persona Ficticia Uno'), fila('505', null)],
};

function montar() {
  const svc = {
    salesByRoute: vi.fn().mockReturnValue(of(REPORTE)),
    salesByRouteRoutes: vi.fn().mockReturnValue(of([])),
    salesByRouteProducts: vi.fn().mockReturnValue(of([])),
    salesByRouteClients: vi.fn().mockReturnValue(of([])),
  };
  TestBed.configureTestingModule({
    imports: [ComercialVentasPorRutaComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ComercialService, useValue: svc },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fix = TestBed.createComponent(ComercialVentasPorRutaComponent);
  fix.detectChanges();
  return { fix, cmp: fix.componentInstance };
}

describe('VEC.41 · el chofer de la ruta', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('la fila dice el chofer, y «sin chofer asignado» cuando ninguna fuente lo sabe', () => {
    const { fix } = montar();
    const textos = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('.rr-chofer'))
      .map((e) => e.textContent?.trim());
    expect(textos).toContain('Persona Ficticia Uno');
    expect(textos).toContain('sin chofer asignado');
  });

  it('se busca por el nombre del chofer', () => {
    const { cmp } = montar();
    cmp.fQuery.set('ficticia');
    expect(cmp.filteredRows().map((r) => r.route_no)).toEqual(['21']);
    // Negativa: algo que no está en ninguna columna no encuentra nada.
    cmp.fQuery.set('zzz-nadie');
    expect(cmp.filteredRows().length).toBe(0);
  });
});
