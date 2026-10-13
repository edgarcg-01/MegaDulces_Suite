import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { HrVacantePublicaDto } from '@megadulces/contracts';
import { EmpleoComponent, ciudadesDe } from './empleo.component';

/**
 * `[RH.2.4]` La bolsa de trabajo pública. Lo que se defiende: el puesto se elige después de la ciudad (sólo las vacantes
 * de esa ciudad), Chofer pide licencia, no se envía con datos faltantes, y lo que contesta el servidor se muestra tal cual.
 */
const v = (o: Partial<HrVacantePublicaDto>): HrVacantePublicaDto => ({
  id: 'v1', name: 'Cajera', area: null, branch_codes: [], branches_text: null, salary_text: '$2,300 semanales', schedule_text: null,
  requirements: null, description: null, image_url: null, ...o,
});
const VACANTES = [
  v({ id: 'v1', name: 'Cajera', branch_codes: ['zamora-canindo'] }),
  v({ id: 'v2', name: 'Chofer', branch_codes: ['morelia-figaredo'] }),
  v({ id: 'v3', name: 'Almacenista', branch_codes: [] }),
];

describe('[RH.2.4] ciudades de una vacante', () => {
  it('desde sus sucursales; sin sucursales, todas; el texto de RH manda', () => {
    expect(ciudadesDe(v({ branch_codes: ['zamora-canindo', 'zamora-catedral', 'morelia-figaredo'] }))).toBe('Morelia · Zamora');
    expect(ciudadesDe(v({ branch_codes: [] }))).toBe('Todas las ciudades');
    expect(ciudadesDe(v({ branches_text: 'Zamora y La Piedad' }))).toBe('Zamora y La Piedad');
  });
});

describe('[RH.2.4] EmpleoComponent', () => {
  let fix: ComponentFixture<EmpleoComponent>;
  let http: HttpTestingController;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EmpleoComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fix = TestBed.createComponent(EmpleoComponent);
    fix.detectChanges();
    http.expectOne((r) => r.url.endsWith('/hr/talent/public/jobs')).flush(VACANTES);
    fix.detectChanges();
  });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });

  it('⭐ lista las vacantes con su ciudad y sueldo', () => {
    expect(texto()).toContain('Cajera');
    expect(texto()).toContain('Zamora · $2,300 semanales');
    expect(texto()).toContain('Todas las ciudades');
  });

  it('el puesto se elige después de la ciudad: sólo las de esa ciudad (y las de todas)', () => {
    const c = fix.componentInstance;
    expect(c.vacantesDeCiudad()).toEqual([]);
    c.f.city_branch = 'Zamora';
    c.alCambiarCiudad();
    expect(c.vacantesDeCiudad().map((x) => x.name)).toEqual(['Cajera', 'Almacenista']);
    // Cambiar de ciudad limpia un puesto que ya no aplica.
    c.f.job_posting_id = 'v1';
    c.f.city_branch = 'Morelia';
    c.alCambiarCiudad();
    expect(c.f.job_posting_id).toBe('');
  });

  it('«Postularme» en una vacante de una sola ciudad la deja elegida con su ciudad', () => {
    const c = fix.componentInstance;
    c.elegir(VACANTES[1]);
    expect([c.f.city_branch, c.f.job_posting_id, c.pideLicencia()]).toEqual(['Morelia', 'v2', true]);
  });

  it('⛔ NEGATIVA — con datos faltantes no se envía nada al servidor, y dice qué falta', async () => {
    const c = fix.componentInstance;
    await c.enviar();
    expect(c.error()).toBe('Elige la ciudad.');
    c.elegir(VACANTES[1]);
    Object.assign(c.f, { full_name: 'Ana Prueba López', phone: '3511234567', heard_from: 'Otro', privacy_accepted: true });
    c.cv.set(new File(['%PDF-1.7'], 'cv.pdf', { type: 'application/pdf' }));
    await c.enviar();
    expect(c.error()).toBe('Adjunta tu licencia de manejo.'); // Chofer
    http.expectNone((r) => r.url.endsWith('/applications'));
  });

  it('⭐ envía la solicitud completa y muestra lo que contesta el servidor', async () => {
    const c = fix.componentInstance;
    c.f.city_branch = 'Zamora';
    c.alCambiarCiudad();
    Object.assign(c.f, { job_posting_id: 'v1', full_name: 'Ana Prueba López', phone: '351 123 4567', heard_from: 'Feria de empleo', privacy_accepted: true });
    c.cv.set(new File(['%PDF-1.7'], 'cv.pdf', { type: 'application/pdf' }));
    await c.enviar();
    const req = http.expectOne((r) => r.url.endsWith('/hr/talent/public/applications'));
    expect(req.request.body).toMatchObject({ job_posting_id: 'v1', city_branch: 'Zamora', heard_from: 'Feria de empleo', privacy_accepted: true, license_base64: null, website: null });
    expect(String(req.request.body.cv_base64)).toMatch(/^data:application\/pdf;base64,/);
    req.flush({ resultado: 'rechazada', mensaje: 'Ya hay una postulación en proceso con este teléfono.' });
    fix.detectChanges();
    expect(texto()).toContain('No pudimos recibirla');
    expect(texto()).toContain('Ya hay una postulación en proceso con este teléfono.');
  });
});
