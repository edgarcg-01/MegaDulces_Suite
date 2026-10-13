import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { CierreDeEmbarque, PagoViaje, ParadaCierre } from '@megadulces/contracts';
import { agruparPorPersona, CierreViajeComponent } from './cierre-viaje.component';

/**
 * EMB.26 — «Lo que se libera por persona» en la pestaña Cierre y pago. Una fila por persona y
 * papel; si cualquier renglón está retenido la fila dice Retenido (con su motivo): un liberado
 * no puede tapar un retenido.
 */
const p = (o: Partial<PagoViaje>): PagoViaje => ({
  source: 'guia', source_id: 'g1', shipment_id: 's1', shipment_folio: 'EMB-1', kepler_sucursal: '01', kepler_guia: '0001',
  shipment_date: '2026-10-06', guide_number: 'GUIA-1', driver_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer',
  concept: 'comision', amount: 129, estado_viaje: 'cerrado', liberado: true, motivo: 'Viaje cerrado', en_vale: false,
  expense_proof_id: null, vale_status: null, vale_folio: null, ...o,
});

describe('agruparPorPersona', () => {
  it('suma comisión y viático de la misma persona en una fila', () => {
    const f = agruparPorPersona([p({ concept: 'comision', amount: 129 }), p({ concept: 'viatico', amount: 200 })]);
    expect(f).toHaveLength(1);
    expect(f[0].montos).toEqual({ comision: 129, viatico: 200, maniobra_carga: 0 });
    expect(f[0].total).toBe(329);
    expect(f[0].estado).toBe('liberado');
  });

  it('un renglón retenido manda sobre los liberados y trae su motivo', () => {
    const f = agruparPorPersona([
      p({ concept: 'comision' }),
      p({ concept: 'viatico', amount: 200, liberado: false, estado_viaje: 'abierto', motivo: 'Faltan paradas por cerrar' }),
    ]);
    expect(f[0].estado).toBe('retenido');
    expect(f[0].motivo).toBe('Faltan paradas por cerrar');
  });

  it('ordena chofer, ayudante, cargador y omite lo cancelado', () => {
    const f = agruparPorPersona([
      p({ driver_id: 'c', persona: 'CARGADOR PRUEBA', rol: 'cargador', concept: 'maniobra_carga', amount: 30, source: 'carga', estado_viaje: 'cargado' }),
      p({ driver_id: 'a', persona: 'AYUDANTE PRUEBA', rol: 'ayudante', amount: 91.2 }),
      p({ driver_id: 'd' }),
      p({ driver_id: 'x', persona: 'CANCELADO', estado_viaje: 'cancelado' }),
    ]);
    expect(f.map((x) => x.rol)).toEqual(['chofer', 'ayudante', 'cargador']);
  });

  it('lo que ya está en un vale se marca En vale', () => {
    expect(agruparPorPersona([p({ en_vale: true, expense_proof_id: 'v1' })])[0].estado).toBe('en_vale');
  });
});

/**
 * Se MONTA la pestaña (compila la plantilla, que `tsc` no mira) contra un HTTP de prueba.
 */
const parada = (o: Partial<ParadaCierre>): ParadaCierre => ({
  recipient_id: 'r1', guide_id: 'g1', sequence_order: 1, customer_name: 'CLIENTE PRUEBA', kepler_serie: 1,
  kepler_folio: '0002544', value: 1000, tipo_parada: 'cliente', destino_code: 'C1', importe_embarcado: 1000,
  recepcion_folio: null, recepcion_importe: null, recepcion_fecha: null, diferencia: null,
  recipient_status: 'pendiente', delivered_at: null, delivered_to: null, incident_type: null, incident_notes: null,
  estado_parada: 'pendiente', motivo: 'Falta registrar la entrega', remision_url: null, ...o,
});
const cierre = (paradas: ParadaCierre[], estado: CierreDeEmbarque['viajes'][number]['estado_viaje'] = 'abierto'): CierreDeEmbarque => ({
  shipment_id: 's1',
  viajes: [{
    guide_id: 'g1', guide_number: 'GUIA-1', shipment_id: 's1', shipment_folio: 'EMB-1', kepler_sucursal: '01',
    kepler_guia: '0001597', shipment_date: '2026-09-30', estado_viaje: estado, paradas: paradas.length,
    paradas_cerradas: paradas.filter((x) => x.estado_parada === 'cerrada').length, paradas_con_diferencia: 0,
    paradas_pendientes: paradas.filter((x) => x.estado_parada === 'pendiente').length,
  }],
  paradas,
  pagos: [p({ liberado: estado !== 'abierto', estado_viaje: estado })],
  cargadores: [],
  tarifa_carga: 30,
});

function montar() {
  TestBed.configureTestingModule({
    imports: [CierreViajeComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(CierreViajeComponent);
  f.componentRef.setInput('shipmentId', 's1');
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}

describe('CierreViajeComponent (montado)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('pinta el estado del viaje, las paradas y el botón sólo en la parada que se cierra a mano', () => {
    const { f, http, el } = montar();
    f.detectChanges();
    http.expectOne((r) => r.url.endsWith('/trip-closure/shipments/s1')).flush(cierre([
      parada({}),
      parada({ recipient_id: 'r2', tipo_parada: 'traspaso', motivo: 'Falta la recepción en la sucursal destino' }),
    ]));
    f.detectChanges();
    expect(el.textContent).toContain('Faltan 2 paradas por cerrar');
    expect(el.textContent).toContain('CLIENTE PRUEBA');
    expect(el.querySelectorAll('button').length).toBeGreaterThan(0);
    const botones = Array.from(el.querySelectorAll('button')).filter((b) => b.textContent?.includes('Registrar entrega'));
    expect(botones).toHaveLength(1);
  });

  it('registrar la entrega manda el resultado SIN foto y recarga el cierre', () => {
    const { f, c, http } = montar();
    f.detectChanges();
    http.expectOne((r) => r.url.endsWith('/shipments/s1')).flush(cierre([parada({})]));
    c.abrirCierre(parada({}));
    expect(c.erroresForm()).toContain('Escribe el nombre de quien recibió.');
    c.recibio.set('Persona Prueba');
    expect(c.erroresForm()).toEqual([]);
    c.guardarCierre();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/paradas/r1/cierre'));
    expect(post.request.body).toEqual({ resultado: 'entregado', recibio: 'Persona Prueba', motivo: null, nota: '' });
    expect('foto' in post.request.body).toBe(false);
    post.flush(parada({ recipient_status: 'entregado', estado_parada: 'cerrada' }));
    expect(c.dialogo()).toBe(false);
    http.expectOne((r) => r.url.endsWith('/shipments/s1')).flush(cierre([parada({ estado_parada: 'cerrada', recipient_status: 'entregado' })], 'cerrado'));
    expect(c.data()?.viajes[0].estado_viaje).toBe('cerrado');
  });

  it('con errores en el formulario no manda nada', () => {
    const { f, c, http } = montar();
    f.detectChanges();
    http.expectOne((r) => r.url.endsWith('/shipments/s1')).flush(cierre([parada({})]));
    c.abrirCierre(parada({}));
    c.resultado.set('no_entregado');
    c.guardarCierre();
    http.expectNone((r) => r.method === 'POST');
  });

  it('guardar cargadores manda la selección y toma la respuesta del servidor', () => {
    const { f, c, http } = montar();
    f.detectChanges();
    http.expectOne((r) => r.url.endsWith('/shipments/s1')).flush(cierre([parada({})]));
    c.seleccion = ['d7', 'd8'];
    c.guardarCargadores();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url.endsWith('/shipments/s1/cargadores'));
    expect(put.request.body).toEqual({ driver_ids: ['d7', 'd8'] });
    put.flush({ ...cierre([parada({})]), cargadores: [{ id: 'l1', driver_id: 'd7', persona: 'CARGADOR PRUEBA', rate: 30, pagado: false }] });
    expect(c.seleccion).toEqual(['d7']);
    expect(c.guardandoCarga()).toBe(false);
  });
});

describe('CierreViajeComponent — nuevo cargador (EMB.32)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('el cargador dado de alta entra a la lista, queda elegido y avisa que falta guardar', () => {
    const { f, c, http } = montar();
    f.detectChanges();
    http.expectOne((r) => r.url.endsWith('/shipments/s1')).flush(cierre([parada({})]));
    c.seleccion = ['d7'];
    c.cargadorCreado({ accion: 'creada', mensaje: 'CARGADOR NUEVO: Se dio de alta.', driver: { id: 'n1', full_name: 'CARGADOR NUEVO', roles: ['cargador'], active: true, status: 'activo' } });
    expect(c.opcionesCargadores().map((d) => d.id)).toContain('n1');
    expect(c.seleccion).toEqual(['d7', 'n1']);
    expect(c.aviso()).toContain('Guardar cargadores');
  });
});
