import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { EmpleoLigaComponent } from './empleo-liga.component';

/**
 * `[RH.2.4]` La página de la liga personal. Lo que se defiende: saluda sólo con el primer nombre, una liga que no sirve
 * dice lo mismo pase lo que pase, y las fotos son dos (regla de Mega Talento).
 */
describe('[RH.2.4] EmpleoLigaComponent', () => {
  let fix: ComponentFixture<EmpleoLigaComponent>;
  let http: HttpTestingController;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function abrir(responder: (r: ReturnType<HttpTestingController['expectOne']>) => void) {
    await TestBed.configureTestingModule({
      imports: [EmpleoLigaComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok-123' }) } } }],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fix = TestBed.createComponent(EmpleoLigaComponent);
    fix.detectChanges();
    responder(http.expectOne((r) => r.url.endsWith('/hr/talent/public/links/tok-123')));
    fix.detectChanges();
  }
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });

  it('⭐ saluda con el primer nombre y el puesto', async () => {
    await abrir((r) => r.flush({ form: 'cv', nombre: 'Ana', puesto: 'Cajera', ya_tiene_cv: false, vence: '2026-10-20T06:00:00Z' }));
    expect(texto()).toContain('Hola Ana');
    expect(texto()).toContain('Cajera');
  });

  it('⛔ una liga que no sirve dice que pida otra, sin más detalle', async () => {
    await abrir((r) => r.flush({ message: 'lo que sea' }, { status: 403, statusText: 'Forbidden' }));
    expect(texto()).toContain('Este enlace ya no sirve. Pide uno nuevo a Capital Humano.');
    expect(texto()).not.toContain('lo que sea');
  });

  it('con fotos, son dos: una sola no deja enviar', async () => {
    await abrir((r) => r.flush({ form: 'cv', nombre: 'Ana', puesto: null, ya_tiene_cv: false, vence: null }));
    const c = fix.componentInstance;
    c.cambiarModo('fotos');
    c.archivos.set([new File(['x'], 'frente.png', { type: 'image/png' }), null]);
    expect(c.completo()).toBe(false);
    c.archivos.set([new File(['x'], 'frente.png', { type: 'image/png' }), new File(['y'], 'reverso.png', { type: 'image/png' })]);
    expect(c.completo()).toBe(true);
  });

  it('⭐ cuestionario: retoma en la que falta, guarda cada respuesta y al terminar sólo agradece (sin puntaje)', async () => {
    await abrir((r) => r.flush({ form: 'liderazgo', nombre: 'Ana', puesto: null, ya_tiene_cv: true, vence: null, respuestas: { 1: 3 }, terminado: false }));
    expect(texto()).toContain('Pregunta 2 de 12');
    const c = fix.componentInstance;
    c.responder(2, 4);
    const req = http.expectOne((r) => r.url.endsWith('/hr/talent/public/links/tok-123/liderazgo'));
    expect(req.request.body).toEqual({ num: 2, valor: 4 });
    req.flush({ contestadas: 2, total: 12, terminado: false });
    fix.detectChanges();
    expect(texto()).toContain('Pregunta 3 de 12');
    c.responder(3, 5);
    http.expectOne((r) => r.url.endsWith('/liderazgo')).flush({ contestadas: 12, total: 12, terminado: true });
    fix.detectChanges();
    expect(texto()).toContain('¡Gracias!');
    expect(texto()).not.toMatch(/\d+%/);
  });

  it('un cuestionario ya cerrado (409) se muestra como terminado', async () => {
    await abrir((r) => r.flush({ form: 'liderazgo', nombre: 'Ana', puesto: null, ya_tiene_cv: true, vence: null, respuestas: {}, terminado: false }));
    fix.componentInstance.responder(1, 3);
    http.expectOne((r) => r.url.endsWith('/liderazgo')).flush({ message: 'Ya contestaste' }, { status: 409, statusText: 'Conflict' });
    fix.detectChanges();
    expect(texto()).toContain('¡Gracias!');
  });

  it('⭐ aptitudes (el jefe): califica con el puntaje en vivo y no guarda sin nombre ni incompleta', async () => {
    const comp = (key: string) => ({ key, categoria: 'Resultados', parametro: `Comp ${key}`, preguntaStar: '¿Cuéntame…?',
      anclas: { inferior: 'poco', cumple: 'ok', supera: 'mucho' } });
    await abrir((r) => r.flush({ form: 'aptitudes', nombre: 'Carla', puesto: 'Vendedor de ruta', ya_tiene_cv: true, vence: null,
      candidato_nombre: 'Carla Prueba Ruiz', competencias: [comp('a'), comp('b')], rubrica: null, evaluacion: null }));
    expect(texto()).toContain('Carla Prueba Ruiz');
    expect(texto()).toContain('Comp a');
    expect(texto()).toContain('mucho'); // el ancla del nivel
    const c = fix.componentInstance;
    c.calificar('a', 'supera');
    expect(c.calc()).toMatchObject({ puntaje: 10, max: 20, completa: false });
    expect(c.puedeGuardarApt()).toBe(false);
    c.calificar('b', 'cumple');
    expect(c.puedeGuardarApt()).toBe(false); // falta su nombre
    c.evaluador.set('Jefe Prueba');
    expect(c.puedeGuardarApt()).toBe(true);
    c.calificar('b', 'cumple'); // tocar el mismo nivel lo quita
    expect(c.calc().completa).toBe(false);
    c.calificar('b', 'cumple');
    c.guardarAptitudes();
    const req = http.expectOne((r) => r.url.endsWith('/hr/talent/public/links/tok-123/aptitudes'));
    expect(req.request.body).toMatchObject({ rubrica: { a: 'supera', b: 'cumple' }, evaluador: 'Jefe Prueba' });
    req.flush({ resultado: 'recibida', mensaje: 'Gracias. La evaluación quedó guardada.' });
    fix.detectChanges();
    expect(texto()).toContain('La evaluación quedó guardada.');
  });

  it('⭐ manda el PDF a la liga y muestra la respuesta', async () => {
    await abrir((r) => r.flush({ form: 'cv', nombre: 'Ana', puesto: null, ya_tiene_cv: false, vence: null }));
    const c = fix.componentInstance;
    c.archivos.set([new File(['%PDF-1.7'], 'cv.pdf', { type: 'application/pdf' }), null]);
    await c.enviar();
    const req = http.expectOne((r) => r.url.endsWith('/hr/talent/public/links/tok-123/cv'));
    expect(req.request.body.files.length).toBe(1);
    expect(String(req.request.body.files[0].file_base64)).toMatch(/^data:application\/pdf;base64,/);
    req.flush({ resultado: 'recibida', mensaje: 'Recibimos tu CV.' });
    fix.detectChanges();
    expect(texto()).toContain('Recibimos tu CV.');
  });
});
