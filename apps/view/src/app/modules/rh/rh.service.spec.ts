import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HR_ESTADOS_DIA, HR_ESTADOS_INCIDENCIA } from '@megadulces/contracts';
import {
  BANDERA_LABEL, ESTADO_DIA_LABEL, ESTADO_INCIDENCIA_LABEL, RhService, SEMAFORO_LABEL, etiquetaSemana, fechaCorta,
  haceCuanto, hoyEnMexico, juevesDeLaSemana, minutosTexto, rhError, sumarDias,
} from './rh.service';

/**
 * `[RH.1.7]` El cliente de las pantallas de RH. Lo que se defiende: la semana de nómina es de JUEVES a
 * miércoles (la misma regla que el servidor), ningún huso corre el día, y lo que no hay se dice «—»/«nunca».
 */
describe('[RH.1.7] semana de nómina', () => {
  it('⭐ el jueves abre la semana: de jueves a miércoles todos caen en el mismo jueves', () => {
    // 1-oct-2026 es jueves.
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-06', '2026-10-07']) expect(juevesDeLaSemana(d)).toBe('2026-10-01');
    expect(juevesDeLaSemana('2026-10-08')).toBe('2026-10-08');
    expect(juevesDeLaSemana('2026-09-30')).toBe('2026-09-24');
  });

  it('sumarDias cruza meses y años sin que el huso corra el día', () => {
    expect(sumarDias('2026-10-31', 1)).toBe('2026-11-01');
    expect(sumarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDias('2026-03-08', 1)).toBe('2026-03-09');
    expect(sumarDias('2026-10-01', -7)).toBe('2026-09-24');
  });

  it('hoyEnMexico usa la hora de México, no la del navegador ni UTC', () => {
    // 05:30 UTC del 8-oct = 23:30 del 7-oct en México.
    expect(hoyEnMexico(new Date('2026-10-08T05:30:00Z'))).toBe('2026-10-07');
    expect(hoyEnMexico(new Date('2026-10-08T06:30:00Z'))).toBe('2026-10-08');
  });

  it('las etiquetas de fecha son cortas y en español', () => {
    expect(fechaCorta('2026-10-01')).toBe('jue 1 oct');
    expect(etiquetaSemana('2026-10-01')).toBe('jue 1 oct – mié 7 oct');
  });
});

describe('[RH.1.7] textos de cantidad', () => {
  it('⛔ NEGATIVA — cero o nada se dice «—», nunca «0 min»', () => {
    for (const v of [0, null, undefined, -5, NaN]) expect(minutosTexto(v as number)).toBe('—');
  });
  it('minutos y horas', () => {
    expect(minutosTexto(25)).toBe('25 min');
    expect(minutosTexto(65)).toBe('1 h 05 min');
  });
  it('⛔ NEGATIVA — un reloj que nunca dio señal dice «nunca», no «hace 0 min»', () => {
    expect(haceCuanto(null)).toBe('nunca');
    expect(haceCuanto(undefined)).toBe('nunca');
  });
  it('hace cuánto, en la unidad que se lee', () => {
    expect(haceCuanto(30)).toBe('hace un momento');
    expect(haceCuanto(600)).toBe('hace 10 min');
    expect(haceCuanto(7200)).toBe('hace 2 h');
    expect(haceCuanto(4 * 86400)).toBe('hace 4 d');
  });
});

describe('[RH.1.7] etiquetas: cubren TODO el vocabulario del contrato', () => {
  // Si el servidor agrega un estado y la pantalla no lo conoce, pintaría `undefined`.
  it('estados del día, de la incidencia y del semáforo', () => {
    for (const e of HR_ESTADOS_DIA) expect(ESTADO_DIA_LABEL[e]).toBeTruthy();
    for (const e of HR_ESTADOS_INCIDENCIA) expect(ESTADO_INCIDENCIA_LABEL[e]).toBeTruthy();
    for (const s of ['ok', 'atrasado', 'mudo', 'pendiente'] as const) expect(SEMAFORO_LABEL[s]).toBeTruthy();
    for (const b of ['corrimiento_60', 'hd_frecuente', 'autocalificada', 'sin_nota', 'retroactiva']) expect(BANDERA_LABEL[b]).toBeTruthy();
  });
});

describe('[RH.1.7] rhError', () => {
  it('el motivo del servidor pasa tal cual (el 409 de semana cerrada lo explica él)', () => {
    const e = new HttpErrorResponse({ status: 409, error: { message: 'La semana ya se cerró para prenómina.' } });
    expect(rhError(e, 'x')).toBe('La semana ya se cerró para prenómina.');
    expect(rhError(new HttpErrorResponse({ status: 400, error: { message: ['a', 'b'] } }), 'x')).toBe('a · b');
  });
  it('sin motivo: permiso, conexión o el respaldo', () => {
    expect(rhError(new HttpErrorResponse({ status: 403 }), 'x')).toBe('Tu rol no tiene permiso para esta acción.');
    expect(rhError(new HttpErrorResponse({ status: 0 }), 'x')).toBe('Sin conexión con el servidor.');
    expect(rhError(new Error('?'), 'respaldo')).toBe('respaldo');
  });
});

describe('[RH.1.7] RhService — lo que se pide', () => {
  let api: RhService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(RhService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });

  it('asistencia: sólo manda los parámetros con valor (planta = sin only_promoters)', () => {
    api.asistencia({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07' }).subscribe();
    const r = http.expectOne((x) => x.url === '/api/hr/attendance/report');
    expect(r.request.params.keys().sort()).toEqual(['date_from', 'date_to', 'site_code']);
    r.flush({});
    api.asistencia({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', only_promoters: true }).subscribe();
    expect(http.expectOne((x) => x.url === '/api/hr/attendance/report').request.params.get('only_promoters')).toBe('1');
  });

  it('incidencias «todas» no manda un filtro de estado vacío', () => {
    api.incidencias({ site_code: 'PH', date_from: '2026-10-01', date_to: '2026-10-07', statuses: '' }).subscribe();
    expect(http.expectOne((x) => x.url === '/api/hr/attendance/incidents').request.params.has('statuses')).toBe(false);
  });

  it('el número de serie va escapado en la ruta', () => {
    api.guardarReloj('A B/1', { site_code: 'PH' }).subscribe();
    const r = http.expectOne('/api/hr/attendance/devices/A%20B%2F1');
    expect(r.request.method).toBe('PUT');
  });

  it('un paso de incidencia lleva su motivo (vacío si no aplica)', () => {
    api.paso('i-1', 'calificar').subscribe();
    const r = http.expectOne('/api/hr/attendance/incidents/i-1/calificar');
    expect(r.request.body).toEqual({ reason: '' });
  });
});
