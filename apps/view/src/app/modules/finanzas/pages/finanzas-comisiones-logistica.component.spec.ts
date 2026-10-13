import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { PagoViaje } from '@megadulces/contracts';
import { FinanzasComisionesLogisticaComponent } from './finanzas-comisiones-logistica.component';

/**
 * `[EMB.29]` — Gastos › «Comisiones de logística». Se MONTA la página (eso compila la plantilla,
 * que `tsc` no mira) y se recorre: el corte, una persona, armar su vale y moverse de corte.
 * Nombres y montos de prueba, inventados.
 */

const CORTE = { desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' };
const PERSONA = {
  driver_id: 'd1', persona: 'CHOFER PRUEBA', roles: ['chofer'], viajes: 2, cargas: 0,
  liberado: { comision: 129, viatico: 200, maniobra_carga: 0 }, liberado_total: 329,
  retenido_total: 50, retenidos: 1, en_vale_total: 0, vales: [],
};
const item = (o: Partial<PagoViaje>): PagoViaje => ({
  source: 'guia', source_id: 'g1', shipment_id: 's1', shipment_folio: 'EMB-2026-00001', kepler_sucursal: '01',
  kepler_guia: '0001597', shipment_date: '2026-09-30', guide_number: 'GUIA-1', driver_id: 'd1', persona: 'CHOFER PRUEBA',
  rol: 'chofer', concept: 'comision', amount: 129, estado_viaje: 'cerrado', liberado: true, motivo: 'Viaje cerrado',
  en_vale: false, expense_proof_id: null, vale_status: null, vale_folio: null, ...o,
});
const DETALLE = {
  corte: CORTE, driver_id: 'd1', persona: 'CHOFER PRUEBA',
  pagables: [item({}), item({ concept: 'viatico', amount: 200 })],
  retenidos: [item({ source_id: 'g2', amount: 50, liberado: false, estado_viaje: 'abierto', motivo: 'Faltan paradas por cerrar' })],
  en_vale: [],
};

function montar() {
  TestBed.configureTestingModule({
    imports: [FinanzasComisionesLogisticaComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(FinanzasComisionesLogisticaComponent);
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}

describe('FinanzasComisionesLogisticaComponent', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('pide el corte vigente (sin fechas) y pinta los totales y a cada persona', async () => {
    const { f, http, el } = montar();
    const req = http.expectOne((r) => r.url.endsWith('/finance/trip-pay/corte'));
    expect(req.request.params.keys()).toEqual([]);
    req.flush({ corte: CORTE, personas: [PERSONA], totales: { liberado: 329, retenido: 50, en_vale: 0 } });
    f.detectChanges();
    await f.whenStable();
    expect(el.textContent).toContain('CHOFER PRUEBA');
    expect(el.textContent).toContain('$329.00');
    expect(el.textContent).toContain('$50.00');
  });

  it('al abrir a una persona trae su detalle del mismo corte, y el total a pagar sólo suma lo liberado', () => {
    const { f, c, http } = montar();
    http.expectOne((r) => r.url.endsWith('/corte')).flush({ corte: CORTE, personas: [PERSONA], totales: { liberado: 329, retenido: 50, en_vale: 0 } });
    c.abrir(PERSONA as any);
    const req = http.expectOne((r) => r.url.endsWith('/personas/d1'));
    expect(req.request.params.get('desde')).toBe('2026-09-24');
    expect(req.request.params.get('hasta')).toBe('2026-10-07');
    req.flush(DETALLE);
    f.detectChanges();
    expect(c.totalPagable()).toBe(329);
  });

  it('armar el vale manda persona y corte, avisa y recarga el corte', () => {
    const { c, http } = montar();
    http.expectOne((r) => r.url.endsWith('/corte')).flush({ corte: CORTE, personas: [PERSONA], totales: { liberado: 329, retenido: 50, en_vale: 0 } });
    c.armarVale(DETALLE as any);
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/vales'));
    expect(post.request.body).toEqual({ driver_id: 'd1', desde: '2026-09-24', hasta: '2026-10-07' });
    post.flush({ id: 'v1', importe: 329, renglones: 2, persona: 'CHOFER PRUEBA' });
    expect(c.aviso()?.ok).toBe(true);
    expect(c.aviso()?.texto).toContain('$329.00');
    http.expectOne((r) => r.url.endsWith('/corte')).flush({ corte: CORTE, personas: [], totales: { liberado: 0, retenido: 0, en_vale: 329 } });
  });

  it('si el vale choca (409) muestra el mensaje del servidor', () => {
    const { c, http } = montar();
    http.expectOne((r) => r.url.endsWith('/corte')).flush({ corte: CORTE, personas: [PERSONA], totales: { liberado: 329, retenido: 50, en_vale: 0 } });
    c.armarVale(DETALLE as any);
    http.expectOne((r) => r.url.endsWith('/vales')).flush(
      { message: 'Alguno de estos viajes ya se pagó en otro vale. Recarga la página.' },
      { status: 409, statusText: 'Conflict' },
    );
    expect(c.creando()).toBe(false);
    expect(c.error()).toContain('ya se pagó');
  });

  it('moverse de corte pide las fechas de 14 días antes y suelta a la persona abierta', () => {
    const { c, http } = montar();
    http.expectOne((r) => r.url.endsWith('/corte')).flush({ corte: CORTE, personas: [PERSONA], totales: { liberado: 329, retenido: 50, en_vale: 0 } });
    c.moverCorte(-14);
    const req = http.expectOne((r) => r.url.endsWith('/corte'));
    expect(req.request.params.get('desde')).toBe('2026-09-10');
    expect(req.request.params.get('hasta')).toBe('2026-09-23');
    req.flush({ corte: { desde: '2026-09-10', hasta: '2026-09-23', pago: '2026-09-25' }, personas: [], totales: { liberado: 0, retenido: 0, en_vale: 0 } });
    expect(c.sel()).toBeNull();
    expect(c.detalle()).toBeNull();
  });
});
