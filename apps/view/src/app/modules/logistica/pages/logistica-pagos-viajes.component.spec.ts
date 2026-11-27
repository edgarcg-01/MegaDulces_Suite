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
  comision_ruta: { chofer: null, ayudante: null, ruta: null, sin_tarifa: [] }, chofer_kepler_id: null, centro: null, sin_centro: null,
  renglones: [], repartido: 0, ...x,
});
/** Sin hoja; Kepler trae a PERSONA DOS, que está en el padrón: su comisión de ruta ya se sabe. */
const SIN_HOJA = o({
  chofer_kepler: 'PERSONA DOS', chofer_kepler_id: 'd2', faltan: ['horario', 'cargadores'], sueltos: 40,
  comision_ruta: { chofer: 150, ayudante: 100, ruta: 'LA PIEDAD', sin_tarifa: [] }, repartido: 0, por_cerrar: 150,
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
  data: Record<string, string> | null = null,
) {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosViajesComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: AuthService, useValue: { user: signal({ permissions: permisos }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false } },
      ...(query || data ? [{ provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query ?? {}), data: data ?? {} } } }] : []),
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
      + '$400.00 a pagar a 2 personas de viajes cerrados y $150.00 por cerrar; falta quién cargó en 2.');
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
    // Lo que más falta primero; a igualdad, sucursal y guía (orden fijo: la lista no baila).
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000004', '0000002']);
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
    // [CML.J] Con el horario de la hoja guardado, se vuelve a pedir el desglose (mismo viaje sin GPS).
    desglose(http).flush(DESGLOSE);
    expect(c.avisoPeek()).toContain('Comisión $300.00');
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

  it('PRUEBA NEGATIVA: con UNA sola hora, o con la misma persona dos veces, no se manda nada', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush(DESGLOSE);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    expect(c.erroresTripulacion(SIN_HORARIO)).toContain('Captura la hora de llegada (o borra la salida para guardar sólo la tripulación).');
    await c.guardarTripulacion(c.op()!);
    c.salida.set(null);
    c.llegada.set(new Date(2026, 9, 10, 14, 0));
    expect(c.erroresTripulacion(SIN_HORARIO)).toContain('Captura la hora de salida.');
    await c.guardarTripulacion(c.op()!);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.ayudante1.set('d2');
    expect(c.erroresTripulacion(SIN_HORARIO)).toContain('Una persona no puede ir dos veces en el mismo viaje.');
    await c.guardarTripulacion(c.op()!);
    http.expectNone((r) => r.method === 'POST');
  });

  it('[CML.HV] sin horario guarda SÓLO la tripulación (al salir): no manda horas ni completa la guía', async () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush(DESGLOSE);
    f.detectChanges();
    expect(c.soloTripulacion()).toBe(true);
    expect(el.textContent).toContain('Guardar tripulación');
    expect(el.textContent).not.toContain('Cerrar viaje y calcular comisiones');
    c.ayudante1.set('a1');
    expect(c.erroresTripulacion(SIN_HORARIO)).toEqual([]);
    const listo = c.guardarTripulacion(c.op()!);
    await tick();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-d/tripulacion'));
    // Chofer de Kepler (d2): no se manda; tampoco horas.
    expect(post.request.body).toEqual({ helper1_id: 'a1', helper2_id: null });
    post.flush({ id: 'g-d', number: 'G', driver_id: 'd2', helper1_id: 'a1', helper2_id: null, crew_saved_at: '2026-11-24T14:05:00.000Z' });
    await tick();
    reporte(http).flush({ ...REPORTE, operaciones: [{ ...SIN_HORARIO, helper1_id: 'a1', tripulacion_guardada_en: '2026-11-24T14:05:00.000Z' }] });
    await listo;
    http.expectNone((r) => r.url.includes('/complete'));
    expect(c.avisoPeek()).toContain('tripulación guardada');
    expect(c.errorPeek()).toBeNull();
    f.detectChanges();
    expect(el.textContent).toContain('Tripulación guardada al salir');
    // Al regresar, ya con las dos horas, el botón completa la guía.
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 14, 0));
    f.detectChanges();
    expect(el.textContent).toContain('Cerrar viaje y calcular comisiones');
  });

  it('[CML.J] sin GPS: el aviso dice que la sugerencia sale de la hoja y a qué hora se capturó la otra guía', () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: 'La unidad no tiene rastreador GPS.',
      mismo_viaje: [{ sucursal: '00', guia: '0000009', fecha: '2026-10-10', por: 'hoja', hora_captura: '11:20' }] } });
    f.detectChanges();
    expect(el.textContent).toContain('Posiblemente el mismo viaje que la guía 0000009');
    expect(el.textContent).toContain('a las 11:20 AM, mientras el camión estaba fuera según la hoja de viaje');
    expect(el.textContent).not.toContain('según el GPS)');
    // El mismo botón de siempre: confirma una persona.
    expect(el.textContent).toContain('Es el mismo viaje: pagar una vez');
  });

  it('[CML.J2] unidad compartida: dice cuántas guías hubo y no ofrece ligar ninguna', () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: 'La unidad no tiene rastreador GPS.', mismo_viaje: [], mismo_viaje_omitidas: 4 } });
    f.detectChanges();
    expect(el.textContent).toContain('Kepler le hizo 4 guías a esta unidad mientras el camión estaba fuera');
    expect(el.textContent).not.toContain('Es el mismo viaje: pagar una vez');
    expect(el.textContent).not.toContain('Posiblemente el mismo viaje');
  });

  it('[CML.J2] NEGATIVA: sin omitidas no aparece el aviso de unidad compartida', () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: null, mismo_viaje: [] } });
    f.detectChanges();
    expect(el.textContent).not.toContain('Kepler le hizo');
  });

  it('[CML.J] avisa si la guía salió en el mismo viaje que otra, y la abre si está en la catorcena', () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: null, mismo_viaje: [{ sucursal: '06', guia: '0000002', fecha: '2026-10-10' }] } });
    f.detectChanges();
    expect(el.textContent).toContain('Salió en el mismo viaje que la guía 0000002');
    expect(el.textContent).toContain('Revisa no pagar el viaje dos veces');
    c.abrirMismoViaje(c.mismoViaje()[0]);
    desglose(http).flush(DESGLOSE);
    expect(c.op()?.guia).toBe('0000002');
    // NEGATIVA: una guía que no está en la catorcena no abre nada, lo dice.
    c.abrirMismoViaje({ sucursal: '09', guia: '9999999', fecha: '2026-09-01' });
    expect(c.op()?.guia).toBe('0000002');
    expect(c.avisoPeek()).toContain('no está en esta catorcena');
    http.expectNone((r) => r.method !== 'GET');
  });

  it('[CML.J] «Es el mismo viaje: pagar una vez» liga la guía, relee y deja deshacerlo', async () => {
    const MISMO = [{ sucursal: '06', guia: '0000002', fecha: '2026-10-10' }];
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: null, mismo_viaje: MISMO } });
    f.detectChanges();
    expect(el.textContent).toContain('Es el mismo viaje: pagar una vez');
    const listo = c.ligarMismoViaje(c.op()!, MISMO[0]);
    await tick();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-d/mismo-viaje'));
    expect(post.request.body).toEqual({ same_trip_as: '06|0000002' });
    post.flush({ id: 'g-d', same_trip_as: '06|0000002' });
    await tick();
    reporte(http).flush({ ...REPORTE, operaciones: [{ ...SIN_HORARIO, mismo_viaje_confirmado: ['06|0000002'], mismo_viaje_liga: '06|0000002' }] });
    await listo;
    expect(c.avisoPeek()).toContain('es el mismo viaje que la guía 0000002');
    f.detectChanges();
    // Confirmada: ya no se ofrece confirmar; se dice cómo se paga y se puede deshacer.
    expect(c.mismoViajeSinConfirmar()).toEqual([]);
    expect(el.textContent).toContain('Mismo viaje que la guía 0000002: a cada persona se le paga la comisión mayor y un solo viático');
    expect(el.textContent).not.toContain('Es el mismo viaje: pagar una vez');
    const deshacer = c.ligarMismoViaje(c.op()!, null);
    await tick();
    const post2 = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-d/mismo-viaje'));
    expect(post2.request.body).toEqual({ same_trip_as: null });
    post2.flush({ id: 'g-d', same_trip_as: null });
    await tick();
    reporte(http).flush(REPORTE);
    await deshacer;
    expect(c.avisoPeek()).toContain('cada guía se paga por separado');
  });

  it('[CML.J] PRUEBA NEGATIVA: quien sólo VE no confirma, y la liga hecha desde la OTRA guía no se deshace aquí', () => {
    const SUGERIDA = { ...DESGLOSE, horario_gps: { viaje: null, motivo: null, mismo_viaje: [{ sucursal: '06', guia: '0000003', fecha: '2026-10-10' }] } };
    const g = montar();
    reporte(g.http).flush({ ...REPORTE, operaciones: [{ ...SIN_HORARIO, mismo_viaje_confirmado: ['06|0000002'], mismo_viaje_liga: null }] });
    g.c.abrir(g.c.operaciones()[0]);
    desglose(g.http).flush(SUGERIDA);
    g.f.detectChanges();
    expect(g.el.textContent).toContain('Mismo viaje que la guía 0000002');
    expect(g.el.textContent).not.toContain('Deshacer');
    expect(g.el.textContent).toContain('Es el mismo viaje: pagar una vez');
    g.http.expectNone((r) => r.method !== 'GET');
    TestBed.resetTestingModule();
    const v = montar({ [Permission.LOGISTICS_PAGOS_VER]: true });
    reporte(v.http).flush(REPORTE);
    v.c.abrir(SIN_HORARIO);
    desglose(v.http).flush(SUGERIDA);
    v.f.detectChanges();
    expect(v.el.textContent).toContain('Salió en el mismo viaje que la guía 0000003');
    expect(v.el.textContent).not.toContain('Es el mismo viaje: pagar una vez');
    v.http.expectNone((r) => r.method !== 'GET');
  });

  it('[CML.T1] precarga los ayudantes del viaje anterior del chofer, lo dice, y el aviso se va si alguien los cambia', () => {
    const SUGERIDA = o({ ...SIN_HOJA, tripulacion_sugerida: { helper1_id: 'a1', helper2_id: null, fecha: '2026-10-09', guia: '0000099' } });
    const { c, f, http, el } = montar();
    reporte(http).flush({ ...REPORTE, operaciones: [SUGERIDA, SIN_HORARIO, COMPLETA] });
    c.abrir(c.operaciones()[0]);
    desglose(http).flush(DESGLOSE);
    f.detectChanges();
    expect(c.ayudante1()).toBe('a1');
    expect(c.ayudante2()).toBeNull();
    expect(el.textContent).toContain('Los mismos ayudantes de su viaje del');
    expect(el.textContent).toContain('guía 0000099');
    http.expectNone((r) => r.method !== 'GET');
    c.ayudante1.set(null);
    expect(c.sugeridaVigente()).toBeNull();
  });

  it('[CML.T1] PRUEBA NEGATIVA: lo ya capturado manda; sin sugerencia no se precarga a nadie', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    const CAPTURADA = o({ ...COMPLETA, helper1_id: 'd2', tripulacion_sugerida: { helper1_id: 'a1', helper2_id: null, fecha: '2026-10-09', guia: '1' } });
    c.abrir(CAPTURADA);
    desglose(http).flush(DESGLOSE);
    expect(c.ayudante1()).toBe('d2');
    expect(c.sugerida()).toBeNull();
    c.abrir(SIN_HORARIO);
    desglose(http).flush(DESGLOSE);
    expect(c.ayudante1()).toBeNull();
    expect(c.sugeridaVigente()).toBeNull();
  });

  /** `[CML.H]` Lo que el GPS dice de la unidad: cargó el 10 y salió el 11 (lo medido en prod). */
  const GPS = { salida: '07:24', llegada: '16:11', duerme_fuera: false, km: 103, km_metodo: 'trazo' as const, puntos: 40, dia_salida: '2026-10-11' };

  it('[CML.H] precarga el horario del GPS, dice el día y los km, no guarda nada, y el aviso se va si alguien lo cambia', () => {
    const { c, f, http, el } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(c.operaciones()[0]);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: GPS, motivo: null } });
    f.detectChanges();
    expect([c.salida()?.getHours(), c.salida()?.getMinutes()]).toEqual([7, 24]);
    expect([c.llegada()?.getHours(), c.llegada()?.getMinutes()]).toEqual([16, 11]);
    expect(c.durmio()).toBe(false);
    const texto = document.body.textContent ?? el.textContent ?? '';
    expect(texto).toContain('Según el GPS de la unidad: salió el');
    expect(texto).toContain('a las 7:24 AM y regresó a las 4:11 PM');
    expect(texto).toContain('(103 km)');
    expect(texto).toContain('Sin confirmar');
    http.expectNone((r) => r.method !== 'GET');
    c.llegada.set(new Date(2026, 9, 11, 18, 0));
    expect(c.horarioGpsVigente()).toBeNull();
  });

  it('[CML.H] PRUEBA NEGATIVA: lo tecleado y lo capturado mandan; sin GPS se dice por qué y no se inventa horario', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    // La persona tecleó la salida antes de que llegara el desglose: no se le pisa.
    c.abrir(c.operaciones()[0]);
    const tecleada = new Date(2026, 9, 10, 6, 15);
    c.salida.set(tecleada);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: GPS, motivo: null } });
    expect(c.salida()).toBe(tecleada);
    expect(c.llegada()).toBeNull();
    expect(c.horarioGps()).toBeNull();
    // Guía completa: lo capturado manda.
    c.abrir(COMPLETA);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: GPS, motivo: null } });
    expect(c.salida()).toBeNull();
    expect(c.horarioGps()).toBeNull();
    // Sin GPS: ni horario ni 00:00, y el motivo a la vista.
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, horario_gps: { viaje: null, motivo: 'La unidad no tiene rastreador GPS.' } });
    expect(c.salida()).toBeNull();
    expect(c.sinHorarioGps()).toBe('La unidad no tiene rastreador GPS.');
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

  it('[EMB.52] filtros de la pantalla principal: tipo, estado, persona y día', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.vista.set('todas');
    c.tipoFiltro.set('traspaso');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001']);
    c.tipoFiltro.set(null);
    c.estadoFiltro.set('sin_tarifa');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000004']);
    c.estadoFiltro.set('sueltas');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000002']);
    c.estadoFiltro.set(null);
    c.personaFiltro.set('c1');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001']);
    c.personaFiltro.set(null);
    c.diaFiltro.set('2026-10-10');
    expect(c.filtrados()).toHaveLength(3);
    expect(c.personasFiltro().map((p) => p.label)).toContain('CARGADOR PRUEBA');
  });

  it('[EMB.52] el orden manda también en la vista de tarjetas: mayor carga, mayor comisión, guía', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.vista.set('todas');
    c.orden.set('carga');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001', '0000002', '0000004']);
    c.orden.set('comision');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001', '0000002', '0000004']);
    c.orden.set('guia');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001', '0000004', '0000002']);
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

  // ── [CML.K] Una sola ventana: se cierra en Embarques; Pagos de viaje es historial sin edición ──

  const HISTORIAL = { modo: 'historial' };

  it('[CML.K] historial: abre en las cerradas, avisa que no se edita y no ofrece capturar', () => {
    const { c, f, http, el } = montar(undefined, null, HISTORIAL);
    reporte(http).flush(REPORTE);
    expect(c.enCierre()).toBe(false);
    expect(c.vista()).toBe('completas');
    expect(c.puedeCapturar()).toBe(false);
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, guia: '0000004', sucursal: '01' });
    f.detectChanges();
    expect(el.textContent).toContain('Historial: aquí se consulta y no se edita.');
    expect(el.textContent).toContain('Este viaje todavía no se cierra.');
    expect(el.textContent).toContain('Cerrarlo en Embarques');
    expect(el.textContent).not.toContain('Cerrar viaje y calcular comisiones');
    expect(el.textContent).not.toContain('Es el mismo viaje: pagar una vez');
    expect(c.ligaCierre(SIN_HORARIO)).toEqual({ vista: 'cerrar', op: '01|0000004', desde: '2026-10-08', hasta: '2026-10-21' });
  });

  it('[CML.K] historial: un viaje cerrado se REABRE sólo con motivo; manda el motivo y relee', async () => {
    const { c, f, http, el } = montar(undefined, null, HISTORIAL);
    reporte(http).flush(REPORTE);
    c.abrir(COMPLETA);
    desglose(http).flush(DESGLOSE);
    f.detectChanges();
    expect(el.textContent).toContain('Reabrir con motivo');
    c.reabriendo.set(true);
    // Motivo corto: no manda nada.
    c.motivo.set('error');
    await c.reabrir(c.op()!);
    http.expectNone((r) => r.url.includes('/reabrir'));
    c.motivo.set('  la hora de regreso estaba mal  ');
    const listo = c.reabrir(c.op()!);
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-a/reabrir'));
    expect(post.request.body).toEqual({ motivo: 'la hora de regreso estaba mal' });
    post.flush({ id: 'g-a', number: 'G', reopened_at: '2026-11-24T20:00:00.000Z' });
    await tick();
    reporte(http).flush(REPORTE);
    await listo;
    expect(c.avisoPeek()).toContain('el viaje se reabrió');
    expect(c.reabriendo()).toBe(false);
    expect(c.motivo()).toBe('');
  });

  it('[CML.K] PRUEBA NEGATIVA: reabrir no aparece sin permiso de gestionar, ni en la ventana de cierre', () => {
    const sinPermiso = montar({ [Permission.LOGISTICS_PAGOS_VER]: true }, null, HISTORIAL);
    reporte(sinPermiso.http).flush(REPORTE);
    expect(sinPermiso.c.puedeReabrir()).toBe(false);
    TestBed.resetTestingModule();
    const cierre = montar();
    reporte(cierre.http).flush(REPORTE);
    cierre.c.abrir(COMPLETA);
    desglose(cierre.http).flush(DESGLOSE);
    cierre.f.detectChanges();
    expect(cierre.c.puedeReabrir()).toBe(false);
    expect(cierre.el.textContent).not.toContain('Reabrir con motivo');
  });

  it('[CML.K] el input «modo» manda sobre la ruta (así lo incrusta Embarques)', () => {
    const { c, f, http } = montar(undefined, null, HISTORIAL);
    f.componentRef.setInput('modo', 'cierre');
    reporte(http).flush(REPORTE);
    expect(c.enCierre()).toBe(true);
    expect(c.puedeCapturar()).toBe(true);
  });

  it('[CML.K] al cerrar el viaje, los km de la hoja van al embarque y el aviso los dice', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, guia: '0000004', sucursal: '01' });
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 15, 0));
    c.km.set(120);
    const listo = c.guardarTripulacion(c.op()!);
    await tick();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-d/complete'));
    post.flush({ id: 'g-d', number: 'G', driver_commission: 0, helper1_commission: 0, helper2_commission: 0, per_diem_total: 80 });
    await tick();
    const km = http.expectOne((r) => r.method === 'PATCH' && r.url.endsWith('/shipments/s-d'));
    expect(km.request.body).toEqual({ actual_km: 120 });
    km.flush({ id: 's-d' });
    await tick();
    reporte(http).flush(REPORTE);
    await listo;
    // [CML.J] Con el horario de la hoja guardado, se vuelve a pedir el desglose (mismo viaje sin GPS).
    desglose(http).flush(DESGLOSE);
    expect(c.avisoPeek()).toContain('viaje cerrado');
    expect(c.avisoPeek()).toContain('Km: 120.');
  });

  it('[CML.K] PRUEBA NEGATIVA: si los km no se guardan, el viaje igual queda cerrado y se dice', async () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.abrir(SIN_HORARIO);
    desglose(http).flush({ ...DESGLOSE, guia: '0000004', sucursal: '01' });
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 15, 0));
    c.km.set(95);
    const listo = c.guardarTripulacion(c.op()!);
    await tick();
    http.expectOne((r) => r.url.endsWith('/guides/g-d/complete'))
      .flush({ id: 'g-d', number: 'G', driver_commission: 0, helper1_commission: 0, helper2_commission: 0, per_diem_total: 80 });
    await tick();
    http.expectOne((r) => r.method === 'PATCH' && r.url.endsWith('/shipments/s-d'))
      .flush({ message: 'Sin permiso' }, { status: 403, statusText: 'Forbidden' });
    await tick();
    reporte(http).flush(REPORTE);
    await listo;
    // [CML.J] Con el horario de la hoja guardado, se vuelve a pedir el desglose (mismo viaje sin GPS).
    desglose(http).flush(DESGLOSE);
    expect(c.avisoPeek()).toContain('viaje cerrado');
    expect(c.avisoPeek()).toContain('Los km no se guardaron');
    expect(c.errorPeek()).toBeNull();
  });

  it('[CML.K] la hoja nació SIN chofer pero Kepler sí lo identificó: al cerrar se manda el de Kepler (antes se atoraba)', async () => {
    const { c, http } = montar();
    // Kepler trae al chofer en el viaje (d2, en el padrón) pero la hoja nació sin él.
    const sinChofer = o({ ...SIN_HOJA, shipment_id: 's-x', shipment_folio: 'EMB-X', guide_id: 'g-x', driver_id: null });
    reporte(http).flush({ ...REPORTE, operaciones: [sinChofer] });
    c.abrir(sinChofer);
    desglose(http).flush(DESGLOSE);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 15, 0));
    expect(c.erroresTripulacion(c.op()!)).toEqual([]);
    const listo = c.guardarTripulacion(c.op()!);
    await tick();
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-x/complete'));
    expect(post.request.body.driver_id).toBe('d2');
    post.flush({ id: 'g-x', number: 'G', driver_commission: 150, helper1_commission: 0, helper2_commission: 0, per_diem_total: 80 });
    await tick();
    reporte(http).flush(REPORTE);
    await listo;
    // [CML.J] Con el horario de la hoja guardado, se vuelve a pedir el desglose (mismo viaje sin GPS).
    desglose(http).flush(DESGLOSE);
    expect(c.errorPeek()).toBeNull();
  });

  it('[CML.K] un viaje reabierto dice cuándo y por qué', () => {
    const { c, f, http, el } = montar(undefined, null, HISTORIAL);
    const reabierta = o({ ...SIN_HORARIO, reabierta: { en: '2026-11-24T20:00:00.000Z', motivo: 'el ayudante era otro' } });
    reporte(http).flush({ ...REPORTE, operaciones: [reabierta] });
    c.abrir(reabierta);
    desglose(http).flush({ ...DESGLOSE, guia: '0000004', sucursal: '01' });
    f.detectChanges();
    expect(el.textContent).toContain('«el ayudante era otro»');
  });
});
