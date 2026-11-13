import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { TiendaArqueoPromosComponent } from './tienda-arqueo-promos.component';
import { TicketConPromo, TicketsDeTurnos, asignacionesPendientes, llaveTicket } from '../arqueo-promos.service';
import { environment } from '../../../../environments/environment';

const BASE = `${environment.apiUrl}/commercial/mkt-ranking/vendedoras`;

const t = (folio: string, vendedora: TicketConPromo['vendedora'] = null): TicketConPromo => ({
  doc_tipo: 10, caja: '91', folio, business_date: '2026-11-10', turno_apertura: '900123', cajero: 'DEMO_FLUJO', total: 120,
  promos: [{ code: 'DM001', mecanica: '3 leches = gratis 1', cantidad: 2 }], vendedora,
});

const respuesta = (over: Partial<TicketsDeTurnos> = {}): TicketsDeTurnos => ({
  sucursal: '01', dias: 7, ve_toda_la_sucursal: false,
  tickets: [t('A1'), t('A2'), t('A3', { code: '902', nombre: 'VENDEDORA DEMO B' })],
  personas: [{ code: '901', nombre: 'VENDEDORA DEMO A', promotora: false }, { code: '902', nombre: 'VENDEDORA DEMO B', promotora: false }],
  asignados: 1, consultado_at: '2026-11-11T18:00:00Z', ...over,
});

describe('[MKT.18] asignacionesPendientes', () => {
  it('sólo manda lo que cambió contra lo guardado; elegir lo mismo no manda nada; vaciar = quitar', () => {
    const ts = [t('A1'), t('A3', { code: '902', nombre: 'B' })];
    expect(asignacionesPendientes(ts, {})).toEqual([]);
    expect(asignacionesPendientes(ts, { [llaveTicket(ts[1])]: '902' })).toEqual([]);
    expect(asignacionesPendientes(ts, { [llaveTicket(ts[0])]: '901', [llaveTicket(ts[1])]: null })).toEqual([
      { doc_tipo: 10, caja: '91', folio: 'A1', person_code: '901' },
      { doc_tipo: 10, caja: '91', folio: 'A3', person_code: null },
    ]);
  });
});

describe('[MKT.18] TiendaArqueoPromosComponent', () => {
  async function montar(r: TicketsDeTurnos) {
    TestBed.configureTestingModule({
      imports: [TiendaArqueoPromosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(TiendaArqueoPromosComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((q) => q.url === BASE && q.params.get('dias') === '7').flush(r);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, http, comp: fixture.componentInstance };
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('abre en «sin vendedora» y lo dice en la franja; asignar los vacíos los llena todos', async () => {
    const { comp, fixture } = await montar(respuesta());
    expect(comp.filas().map((x) => x.folio)).toEqual(['A1', 'A2']);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Sin vendedora (2)');
    comp.paraTodos.set('901');
    comp.asignarVacios();
    expect(comp.pendientes().map((p) => [p.folio, p.person_code])).toEqual([['A1', '901'], ['A2', '901']]);
    expect(comp.hasUnsavedChanges()).toBe(true);
  });

  it('guardar manda SÓLO lo cambiado, con la sucursal, y recarga', async () => {
    const { comp, http, fixture } = await montar(respuesta());
    comp.elegir(comp.filas()[0], '902');
    const p = comp.guardar();
    const req = http.expectOne((q) => q.url === BASE && q.method === 'PUT');
    expect(req.request.body).toEqual({ sucursal: '01', items: [{ doc_tipo: 10, caja: '91', folio: 'A1', person_code: '902' }] });
    req.flush({ guardados: 1, quitados: 0 });
    await p;
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.method === 'GET').flush(respuesta());
    await fixture.whenStable();
    expect(comp.hasUnsavedChanges()).toBe(false);
  });

  it('⭐ NEGATIVA: con varias sucursales el servidor pide elegir; NO se pinta como «sin tickets»', async () => {
    TestBed.configureTestingModule({
      imports: [TiendaArqueoPromosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(TiendaArqueoPromosComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((q) => q.url === BASE).flush({ message: 'Elige la sucursal: tienes 2 asignadas.' }, { status: 400, statusText: 'Bad Request' });
    await fixture.whenStable();
    fixture.detectChanges();
    const comp = fixture.componentInstance;
    expect(comp.pideSucursal()).toBe(true);
    expect(comp.error()).toContain('Elige la sucursal');
    // [MKT.23] Se ve como instrucción, no como falla en rojo (lo encontró David en la pantalla, 2026-11-13).
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('Elige una sucursal');
    expect(texto).not.toContain('No se pudo cargar');
    comp.elegirSucursal('03');
    fixture.detectChanges();
    http.expectOne((q) => q.url === BASE && q.params.get('sucursal') === '03').flush(respuesta({ sucursal: '03' }));
    await fixture.whenStable();
    expect(comp.datos()?.sucursal).toBe('03');
  });

  it('⭐ admin sin sucursal propia: se le ofrece elegirla (no «revisa tu conexión»)', async () => {
    TestBed.configureTestingModule({ imports: [TiendaArqueoPromosComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const fixture = TestBed.createComponent(TiendaArqueoPromosComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((q) => q.url === BASE).flush({ message: 'Tu usuario no tiene sucursal asignada.' }, { status: 400, statusText: 'Bad Request' });
    await fixture.whenStable();
    const comp = fixture.componentInstance;
    expect(comp.pideSucursal()).toBe(true);
    expect(comp.error()).not.toContain('conexión');
  });

  it('otro 4xx dice el motivo del servidor; sin respuesta se culpa a la conexión', async () => {
    TestBed.configureTestingModule({ imports: [TiendaArqueoPromosComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const fixture = TestBed.createComponent(TiendaArqueoPromosComponent);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((q) => q.url === BASE).flush({ message: 'No tienes permiso' }, { status: 403, statusText: 'Forbidden' });
    await fixture.whenStable();
    expect(fixture.componentInstance.error()).toBe('No tienes permiso');
    expect(fixture.componentInstance.pideSucursal()).toBe(false);
    // Control de la anterior: una falla de verdad SÍ se pinta como falla.
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No se pudo cargar');
  });
});
