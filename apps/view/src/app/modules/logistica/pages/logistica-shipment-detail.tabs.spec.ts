import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LogisticaShipmentDetailComponent } from './logistica-shipment-detail.component';

/**
 * `[EMB.26]` — Pestañas del embarque tras la revisión del 2026-10-12:
 *   · «Cierre y pago» va primero y es la que abre;
 *   · se quitaron «Costos» (se capturan en Logística › Costos), «Carta Porte» y el panel
 *     «Preparación del viaje» de Información.
 */

const EMB = {
  id: 'e1', folio: 'EMB-2026-00010', shipment_date: '2026-10-03', status: 'programado', type: 'entrega',
  freight_revenue: 0, cargo_value: 0, boxes_count: 0, total_weight_kg: 0,
};

const CIERRE = { shipment_id: 'e1', viajes: [], paradas: [], pagos: [], cargadores: [], carga: { tarifa_por_caja: 0.2, cajas: 0, fuente_cajas: 'kepler', total: 0 } };

function contestar(http: HttpTestingController) {
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const abiertas = http.match(() => true).filter((r: TestRequest) => !r.cancelled);
    if (!abiertas.length) return;
    for (const r of abiertas) {
      // OJO: /trip-closure/shipments/e1 también termina en shipments/e1 (lo pide la pestaña de cierre).
      if (/\/logistics\/shipments\/e1$/.test(r.request.url)) r.flush(EMB);
      else if (r.request.url.includes('/trip-closure/')) r.flush(CIERRE);
      // Listas vacías: varias cargas del detalle no manejan error y un 404 sería un error sin capturar.
      else r.flush([]);
    }
  }
}

function montar() {
  TestBed.configureTestingModule({
    imports: [LogisticaShipmentDetailComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'e1' })), snapshot: { paramMap: convertToParamMap({ id: 'e1' }) } } },
    ],
  });
  const f = TestBed.createComponent(LogisticaShipmentDetailComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  contestar(http);
  f.detectChanges();
  contestar(http);
  f.detectChanges();
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}

const pestanas = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.shd-mode-tab')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('LogisticaShipmentDetailComponent — pestañas', () => {
  it('«Cierre y pago» es la primera pestaña y la que abre', () => {
    const { c, el } = montar();
    expect(c.tab()).toBe('cierre');
    const t = pestanas(el);
    expect(t[0]).toBe('Cierre y pago');
    expect(t.map((x) => x.replace(/\s*\d+$/, ''))).toEqual(['Cierre y pago', 'Información', 'Guías']);
    expect(el.querySelector('.shd-mode-tab.active')?.textContent).toContain('Cierre y pago');
    expect(el.querySelector('app-cierre-viaje')).not.toBeNull();
  });

  it('ya no hay Costos, Carta Porte ni el panel de Preparación del viaje', () => {
    const { c, f, el } = montar();
    expect(pestanas(el).some((x) => /Costos|Carta Porte/.test(x))).toBe(false);
    c.setTab('info');
    f.detectChanges();
    expect(el.textContent).not.toContain('Preparación del viaje');
    expect(el.textContent).not.toContain('Guardar costos');
  });
});

describe('LogisticaShipmentDetailComponent — nuevo ayudante desde la guía (EMB.32)', () => {
  it('el ayudante dado de alta entra a la lista y queda elegido en el campo que lo pidió', () => {
    const { c } = montar();
    c.abrirAltaAyudante('helper2_id');
    expect(c.altaAyudanteVisible()).toBe(true);
    c.ayudanteCreado({ accion: 'papel_agregado', mensaje: 'X', driver: { id: 'a9', full_name: 'AYUDANTE NUEVO', roles: ['chofer', 'ayudante'], active: true, status: 'activo' } });
    expect(c.guideForm.get('helper2_id')?.value).toBe('a9');
    expect(c.ayudanteOptions().map((o) => o.value)).toContain('a9');
  });
});
