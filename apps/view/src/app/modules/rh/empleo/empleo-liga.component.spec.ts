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
