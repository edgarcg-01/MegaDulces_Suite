import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ReclutamientoService } from './reclutamiento.service';
import { ETAPAS, duracion, etapaLabel, hace, rebasaSla, siguienteEtapa, telefono } from './reclutamiento-formato';

/**
 * `[RH.2.3]` El cliente y los textos de Reclutamiento. Lo que se defiende: los nombres de etapa son los de Mega Talento,
 * lo que no se puede medir no se pinta como «a tiempo», y las rutas del cliente son las del servidor.
 */
describe('[RH.2.3] formato de reclutamiento', () => {
  it('las etapas con el nombre y la meta que RH ya usa en Mega Talento', () => {
    expect(ETAPAS.slice(0, 4).map((e) => [e.id, e.label, e.slaHoras])).toEqual([
      ['filtro_inicial', 'Filtro Inicial', 24],
      ['entrevista_rh', 'Entrevista Orientación Conductual', 48],
      ['aptitudes', 'Aptitudes y Entrevista Técnica', 48],
      ['psicometria', 'Psicométricas', 72],
    ]);
    expect(etapaLabel(null)).toBe('Sin etapa');
    expect(etapaLabel('dictamen')).toBe('dictamen'); // lo desconocido se muestra tal cual, no se inventa
  });

  it('siguiente etapa: en orden; ninguna desde la última ni desde un desenlace', () => {
    expect(siguienteEtapa('filtro_inicial')).toBe('entrevista_rh');
    expect(siguienteEtapa('aptitudes')).toBe('psicometria');
    expect(siguienteEtapa('psicometria')).toBeNull();
    expect(siguienteEtapa('contratado')).toBeNull();
  });

  it('«hace…» y duraciones', () => {
    const ahora = new Date('2026-10-12T18:00:00Z');
    expect(hace('2026-10-12T17:59:30Z', ahora)).toBe('hace un momento');
    expect(hace('2026-10-12T17:15:00Z', ahora)).toBe('hace 45 min');
    expect(hace('2026-10-12T12:00:00Z', ahora)).toBe('hace 6 h');
    expect(hace('2026-10-09T18:00:00Z', ahora)).toBe('hace 3 días');
    expect(hace(null, ahora)).toBe('—');
    expect(duracion(5.5)).toBe('5.5 h');
    expect(duracion(72)).toBe('3 días');
    expect(duracion(null)).toBe('—');
  });

  it('⛔ NEGATIVA — sin meta o sin fecha NO es «a tiempo»: es null', () => {
    const ahora = new Date('2026-10-12T18:00:00Z');
    expect(rebasaSla('filtro_inicial', '2026-10-11T12:00:00Z', ahora)).toBe(true); // 30 h > 24
    expect(rebasaSla('filtro_inicial', '2026-10-12T12:00:00Z', ahora)).toBe(false);
    expect(rebasaSla('contratado', '2026-01-01T00:00:00Z', ahora)).toBeNull();
    expect(rebasaSla('aptitudes', null, ahora)).toBeNull();
  });

  it('teléfono legible con los últimos 10 dígitos (el bot guarda 13)', () => {
    expect(telefono('5213511234567')).toBe('351 123 4567');
    expect(telefono('(351) 123-4567')).toBe('351 123 4567');
    expect(telefono('123')).toBe('123');
    expect(telefono(null)).toBe('—');
  });
});

describe('[RH.2.3] ReclutamientoService', () => {
  let api: ReclutamientoService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ReclutamientoService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('la lista manda sólo los filtros con valor', () => {
    api.candidatos({ view: 'postulados', stage: null, q: '', limit: 100, offset: 0 }).subscribe();
    const r = http.expectOne((x) => x.url.endsWith('/hr/talent/candidates'));
    expect(r.request.params.keys().sort()).toEqual(['limit', 'offset', 'view']);
    r.flush({ total: 0, filas: [], por_etapa: {} });
  });

  it('las acciones van a las rutas del servidor con el cuerpo que espera', () => {
    const id = '7f1b8c2e-0000-4000-8000-000000000001';
    api.moverEtapa(id, 'aptitudes').subscribe();
    http.expectOne((x) => x.url.endsWith(`/candidates/${id}/stage`) && x.body.stage === 'aptitudes').flush({});
    api.noRecontratable(id, true, 'abandono').subscribe();
    http.expectOne((x) => x.url.endsWith(`/candidates/${id}/no-rehire`) && x.body.mark === true && x.body.reason === 'abandono').flush({});
    api.fusionar(id, 'otro').subscribe();
    http.expectOne((x) => x.url.endsWith(`/candidates/${id}/merge`) && x.body.absorb_id === 'otro').flush({});
    api.retirarDocumento(id, 'k/a.pdf', 'ilegible').subscribe();
    http.expectOne((x) => x.url.endsWith(`/candidates/${id}/documents/retire`) && x.body.llave === 'k/a.pdf').flush({});
    api.vacantes(true).subscribe();
    http.expectOne((x) => x.url.endsWith('/hr/talent/jobs') && x.params.get('active') === 'true').flush([]);
  });
});
