import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { DesgloseDeOperacion, OperacionDelReporte, ReporteDePagos } from '@megadulces/contracts';
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
  renglones: [{ persona_id: 'd2', persona: 'PERSONA DOS', rol: 'chofer', concepto: 'comision', codigo: '075', nombre_concepto: 'COMISIONES LOGISTICAS TLMKT', importe: 150, fuente: 'kepler', calculo: 'Tarifa de la ruta LA PIEDAD: $150.00 al chofer' }],
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
    { persona_id: 'd1', persona: 'PERSONA UNO', rol: 'chofer', concepto: 'comision', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 300, fuente: 'captura', calculo: 'CALCULO PRUEBA' },
    { persona_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', concepto: 'carga', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 100, fuente: 'captura', calculo: 'CALCULO PRUEBA' },
  ],
});
const REPORTE: ReporteDePagos = {
  corte: { desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' },
  operaciones: [SIN_HOJA, SIN_HORARIO, COMPLETA], fuera_de_alcance: 1, solo_tiempo_aire: 7,
  personas: [{ id: 'd1', full_name: 'PERSONA UNO', roles: ['chofer'] }, { id: 'd2', full_name: 'PERSONA DOS', roles: ['chofer'] },
    { id: 'a1', full_name: 'AYUDANTE PRUEBA', roles: ['ayudante'] }, { id: 'c1', full_name: 'CARGADOR PRUEBA', roles: ['cargador'] }],
  leido_at: '2026-10-24T18:00:00.000Z',
};
/** `[EMB.50]` El desglose de una operación: un traspaso con su recepción y un documento sin nombre de surtidor. */
const DESGLOSE: DesgloseDeOperacion = {
  sucursal: '00', guia: '0000001', cajas: 105, sueltos: 536.94, leido_at: '2026-10-26T15:00:00.000Z',
  documentos: [{
    serie: 2, folio: '0001153', tipo: 'traspaso', destino: 'TRASPASO A SUCURSAL PRUEBA', cajas: 105, sueltos: 536.94,
    surtio: { codigo: '01', nombre: 'SURTIDOR PRUEBA' }, checo: { codigo: '07', nombre: null }, embarco: { codigo: '01', nombre: 'EMBARCADOR PRUEBA' },
    capturo: '9ABC', hora_captura: '10:39',
    recepcion: { sucursal: '01', folio: '0000518', fecha: '2026-10-22', capturo: '10XYZ', diferencia: 0, estado: 'cerrada' },
    renglones: [
      { linea: 1, sku: '83002', producto: 'PASTA PRUEBA GRANEL', cantidad: 536.94, presentacion: 'KG', cajas: 0, sin_carga: false },
      { linea: 2, sku: '89155', producto: 'DULCE PRUEBA / 20', cantidad: 105, presentacion: 'CJA', cajas: 105, sin_carga: false },
    ],
  }],
};
/** El reporte después de que la hoja nació: Kepler resolvió al chofer contra el padrón. */
const CON_HOJA: ReporteDePagos = {
  ...REPORTE,
  operaciones: [o({ ...SIN_HOJA, shipment_id: 's-b', shipment_folio: 'EMB-B', guide_id: 'g-b', driver_id: 'd2', faltan: ['horario', 'cargadores'] }), SIN_HORARIO, COMPLETA],
};

function montar(
  permisos: Partial<Record<Permission, boolean>> = { [Permission.LOGISTICS_PAGOS_GESTIONAR]: true },
  query: Record<string, string> | null = null,
) {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosViajesComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: AuthService, useValue: { user: signal({ permissions: permisos }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false } },
      ...(query ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } }] : []),
    ],
  });
  const f = TestBed.createComponent(LogisticaPagosViajesComponent);
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}
const desglose = (http: HttpTestingController) => http.expectOne((r) => r.method === 'GET' && r.url.includes('/trip-closure/operaciones/'));
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
    desglose(http).flush(DESGLOSE);
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
    desglose(http).flush(DESGLOSE);
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
    desglose(http).flush(DESGLOSE);
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
    desglose(http).flush(DESGLOSE);
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
    desglose(http).flush(DESGLOSE);
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

  it('[EMB.50] al abrir una operación pide su desglose y lo pinta: cajas, quién surtió/embarcó y la recepción', () => {
    const { f, c, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    const req = desglose(http);
    expect(req.request.url).toContain('/trip-closure/operaciones/00/0000001/desglose');
    req.flush(DESGLOSE);
    f.detectChanges();
    const texto = document.body.textContent ?? el.textContent ?? '';
    expect(texto).toContain('SURTIDOR PRUEBA');
    expect(texto).toContain('EMBARCADOR PRUEBA');
    expect(texto).toContain('clave 07 (sin nombre en Kepler)');
    expect(texto).toContain('Recibido completo');
    expect(texto).toContain('capturó el usuario 10XYZ');
    expect(texto).toContain('2 productos');
  });

  it('[EMB.50] PRUEBA NEGATIVA: si llega tarde el desglose de OTRA operación, no pisa el de la abierta', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    const vieja = desglose(http);
    c.abrir(SIN_HORARIO);
    const nueva = desglose(http);
    nueva.flush({ ...DESGLOSE, guia: '0000004', sucursal: '01' });
    vieja.flush(DESGLOSE);
    expect(c.desglose()?.guia).toBe('0000004');
  });

  it('[EMB.51] la liga ?op= abre la catorcena pedida con esa operación abierta (aunque esté completa)', () => {
    const { c, http } = montar(undefined, { op: '00|0000001', desde: '2026-10-08', hasta: '2026-10-21' });
    const req = reporte(http);
    expect(req.request.params.get('desde')).toBe('2026-10-08');
    req.flush(REPORTE);
    desglose(http).flush(DESGLOSE);
    expect(c.op()?.guia).toBe('0000001');
    expect(c.vista()).toBe('todas');
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
