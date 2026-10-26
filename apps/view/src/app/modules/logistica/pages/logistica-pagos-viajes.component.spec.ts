import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { OperacionDelReporte, ReporteDePagos } from '@megadulces/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LogisticaPagosViajesComponent } from './logistica-pagos-viajes.component';

/**
 * `[EMB.47]` — «Operaciones»: cada operación de Kepler de la catorcena, quién fue y cuánto le toca
 * a cada quien. Se MONTA (eso compila la plantilla) y se recorre la captura completa: la hoja nace
 * sola al guardar al chofer o a los cargadores. Nombres, folios y montos inventados.
 */
const o = (x: Partial<OperacionDelReporte>): OperacionDelReporte => ({
  sucursal: '06', guia: '0000002', fecha: '2026-10-10', paradas: 2, destinos: 'CLIENTE PRUEBA', tipo: 'cliente',
  chofer_kepler: null, importe: 500.5, shipment_id: null, shipment_folio: null, guide_id: null, driver_id: null,
  helper1_id: null, helper2_id: null, departure_time: null, arrival_time: null, overnight: false, cargadores: 0,
  faltan: ['chofer', 'horario', 'cargadores'], cajas: 15, sueltos: 0, tarifa_por_caja: 0.2, carga_total: 3, cargador_ids: [],
  comision_ruta: { chofer: null, ayudante: null, ruta: null, sin_tarifa: [] }, chofer_kepler_id: null,
  renglones: [], repartido: 0, ...x,
});
/** Sin hoja; Kepler trae a PERSONA DOS, que está en el padrón: su comisión de ruta ya se sabe. */
const SIN_HOJA = o({
  chofer_kepler: 'PERSONA DOS', chofer_kepler_id: 'd2', faltan: ['horario', 'cargadores'], sueltos: 40,
  comision_ruta: { chofer: 150, ayudante: 100, ruta: 'LA PIEDAD', sin_tarifa: [] }, repartido: 150,
  renglones: [{ persona_id: 'd2', persona: 'PERSONA DOS', rol: 'chofer', concepto: 'comision', codigo: '075', nombre_concepto: 'COMISIONES LOGISTICAS TLMKT', importe: 150, fuente: 'kepler' }],
});
const SIN_HORARIO = o({
  sucursal: '01', guia: '0000004', tipo: 'mixto', chofer_kepler: 'PERSONA DOS', shipment_id: 's-d', shipment_folio: 'EMB-D',
  guide_id: 'g-d', driver_id: 'd2', faltan: ['horario', 'cargadores'], cajas: null, carga_total: null,
  comision_ruta: { chofer: null, ayudante: null, ruta: null, sin_tarifa: ['RUTA NUEVA'] },
});
const COMPLETA = o({
  sucursal: '00', guia: '0000001', tipo: 'traspaso', destinos: 'YURECUARO', shipment_id: 's-a', shipment_folio: 'EMB-A',
  guide_id: 'g-a', driver_id: 'd1', departure_time: '05:30', arrival_time: '16:10', cargadores: 1, faltan: [],
  cajas: 500, carga_total: 100, cargador_ids: ['c1'], repartido: 400,
  comision_ruta: { chofer: 300, ayudante: 150, ruta: 'YURECUARO', sin_tarifa: [] },
  renglones: [
    { persona_id: 'd1', persona: 'PERSONA UNO', rol: 'chofer', concepto: 'comision', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 300, fuente: 'captura' },
    { persona_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', concepto: 'carga', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 100, fuente: 'captura' },
  ],
});
const REPORTE: ReporteDePagos = {
  corte: { desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' },
  operaciones: [SIN_HOJA, SIN_HORARIO, COMPLETA], fuera_de_alcance: 1, solo_tiempo_aire: 7,
  personas: [{ id: 'd1', full_name: 'PERSONA UNO', roles: ['chofer'] }, { id: 'd2', full_name: 'PERSONA DOS', roles: ['chofer'] },
    { id: 'a1', full_name: 'AYUDANTE PRUEBA', roles: ['ayudante'] }, { id: 'c1', full_name: 'CARGADOR PRUEBA', roles: ['cargador'] }],
  leido_at: '2026-10-24T18:00:00.000Z',
};
/** El reporte después de que la hoja nació: Kepler resolvió al chofer contra el padrón. */
const CON_HOJA: ReporteDePagos = {
  ...REPORTE,
  operaciones: [o({ ...SIN_HOJA, shipment_id: 's-b', shipment_folio: 'EMB-B', guide_id: 'g-b', driver_id: 'd2', faltan: ['horario', 'cargadores'] }), SIN_HORARIO, COMPLETA],
};

function montar(permisos: Partial<Record<Permission, boolean>> = { [Permission.LOGISTICS_PAGOS_GESTIONAR]: true }) {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosViajesComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: AuthService, useValue: { user: signal({ permissions: permisos }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false } },
    ],
  });
  const f = TestBed.createComponent(LogisticaPagosViajesComponent);
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}
const reporte = (http: HttpTestingController) => http.expectOne((r) => r.method === 'GET' && r.url.endsWith('/logistics/trip-closure/reporte'));
/** Deja correr las promesas de `firstValueFrom` entre una respuesta y la siguiente. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LogisticaPagosViajesComponent', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('pide la catorcena que va corriendo (sin fechas) y dice cuánto ya está repartido y a cuántas les falta', () => {
    const { f, http, el } = montar();
    const req = reporte(http);
    expect(req.request.params.keys()).toEqual([]);
    req.flush(REPORTE);
    f.detectChanges();
    expect(el.textContent).toContain('3 operaciones: $103.00 de carga (515 cajas) y $450.00 de comisión de choferes. '
      + '$550.00 ya asignado a 3 personas; falta quién cargó en 2.');
    expect(el.textContent).toContain('Falta el horario');
    expect(el.textContent).toContain('PERSONA DOS (Kepler)');
  });

  it('[EMB.48] cada fila dice lo que ya se sabe: carga, comisión de la ruta, y «sin tarifa» en vez de $0', () => {
    const { f, http, el } = montar();
    reporte(http).flush(REPORTE);
    f.detectChanges();
    const filas = [...el.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '');
    const sinHoja = filas.find((t) => t.includes('0000002')) ?? '';
    expect(sinHoja).toContain('$3.00');
    expect(sinHoja).toContain('$150');
    expect(sinHoja).toContain('+40 sueltas');
    expect(filas.find((t) => t.includes('0000004'))).toContain('Ruta sin tarifa');
    expect(el.textContent).toContain('7 sólo tiempo aire');
  });

  it('abre en «Por completar»; la búsqueda encuentra también por quien cobra', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000002', '0000004']);
    c.vista.set('completas');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001']);
    c.vista.set('todas');
    c.busqueda.set('cargador prueba');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001']);
  });

  it('sin hoja: guardar al chofer CREA la hoja, relee y completa la guía sin mandar chofer (vino de Kepler)', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(c.operaciones()[0]);
    c.ayudante1.set('a1');
    c.salida.set(new Date(2026, 9, 10, 5, 7));
    c.llegada.set(new Date(2026, 9, 10, 16, 45));
    expect(c.erroresTripulacion(c.op()!)).toEqual([]);
    const listo = c.guardarTripulacion(c.op()!);
    const toma = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/shipments/from-kepler/06/0000002'));
    expect(toma.request.body).toEqual({ delivery_type: 'route' });
    toma.flush({ shipment: { id: 's-b', folio: 'EMB-B', status: 'programado', kepler_sucursal: '06', kepler_guia: '0000002' }, guide: { id: 'g-b', number: 'G', status: 'pendiente' }, destinatarios: 2 });
    await tick();
    reporte(http).flush(CON_HOJA);
    await tick();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-b/complete'));
    expect(post.request.body).toEqual({ helper1_id: 'a1', helper2_id: null, departure_time: '05:07', arrival_time: '16:45', overnight: false });
    post.flush({ id: 'g-b', number: 'G', driver_commission: 180, helper1_commission: 120, helper2_commission: 0, per_diem_total: 200 });
    await tick();
    reporte(http).flush(CON_HOJA);
    await listo;
    expect(c.avisoPeek()).toContain('comisión $300.00');
    expect(c.errorPeek()).toBeNull();
  });

  it('PRUEBA NEGATIVA: si el chofer de Kepler NO está en el padrón y no se eligió, frena ANTES de crear la hoja', async () => {
    const { c, http } = montar();
    const fuera = o({ chofer_kepler: 'NO ESTA EN EL PADRON', chofer_kepler_id: null });
    reporte(http).flush({ ...REPORTE, operaciones: [fuera, SIN_HORARIO, COMPLETA] });
    c.abrir(c.operaciones()[0]);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 14, 0));
    expect(c.erroresTripulacion(c.op()!)).toContain('Elige al chofer.');
    await c.guardarTripulacion(c.op()!);
    http.expectNone((r) => r.method === 'POST');
  });

  it('PRUEBA NEGATIVA: sin horario, o con la misma persona dos veces, no se manda nada', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    expect(c.erroresTripulacion(SIN_HORARIO)).toContain('Captura la hora de salida.');
    await c.guardarTripulacion(c.op()!);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 14, 0));
    c.ayudante1.set('d2');
    expect(c.erroresTripulacion(SIN_HORARIO)).toContain('Una persona no puede ir dos veces en el mismo viaje.');
    await c.guardarTripulacion(c.op()!);
    http.expectNone((r) => r.method === 'POST');
  });

  it('cargadores en una operación sin hoja: crea la hoja, guarda la lista y relee', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(c.operaciones()[0]);
    c.cargadoresSel.set(['c1', 'a1']);
    expect(c.textoReparto(c.op()!)).toBe('Al guardar: $1.50 para cada uno de los 2.');
    const listo = c.guardarCargadores(c.op()!);
    http.expectOne((r) => r.url.endsWith('/from-kepler/06/0000002')).flush({ shipment: { id: 's-b' }, guide: { id: 'g-b' }, destinatarios: 2 });
    await tick();
    reporte(http).flush(CON_HOJA);
    await tick();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url.endsWith('/trip-closure/shipments/s-b/cargadores'));
    expect(put.request.body).toEqual({ driver_ids: ['c1', 'a1'] });
    put.flush({});
    await tick();
    const despues: ReporteDePagos = { ...CON_HOJA, operaciones: [o({ ...CON_HOJA.operaciones[0], cargadores: 2, cargador_ids: ['c1', 'a1'] }), SIN_HORARIO, COMPLETA] };
    reporte(http).flush(despues);
    await listo;
    expect(c.avisoPeek()).toContain('2 cargadores: CARGADOR PRUEBA, AYUDANTE PRUEBA.');
    expect(c.cargadoresSel()).toEqual(['c1', 'a1']);
  });

  it('agregar un cargador nuevo lo pone en la lista y lo deja elegido (falta guardar)', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    c.cargadorCreado({ accion: 'creada', driver: { id: 'n1', full_name: 'PERSONA NUEVA', roles: ['cargador'], active: true, status: 'activo' }, mensaje: 'Se dio de alta.' });
    expect(c.cargadoresSel()).toEqual(['c1', 'n1']);
    expect(c.opciones().map((p) => p.id)).toContain('n1');
    expect(c.avisoPeek()).toContain('Falta «Guardar cargadores»');
  });

  it('PRUEBA NEGATIVA: quien sólo VE el módulo no captura (la API también lo rechaza)', () => {
    const v = montar({ [Permission.LOGISTICS_PAGOS_VER]: true });
    reporte(v.http).flush(REPORTE);
    expect(v.c.puedeCapturar()).toBe(false);
    TestBed.resetTestingModule();
    const g = montar();
    reporte(g.http).flush(REPORTE);
    expect(g.c.puedeCapturar()).toBe(true);
  });

  it('moverse de catorcena pide las fechas 14 días antes', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.mover(-1);
    const req = reporte(http);
    expect(req.request.params.get('desde')).toBe('2026-09-24');
    expect(req.request.params.get('hasta')).toBe('2026-10-07');
    req.flush({ ...REPORTE, corte: { desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' }, operaciones: [] });
  });
});
