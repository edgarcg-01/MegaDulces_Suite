import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AltaPersonaComponent } from './alta-persona.component';

/** `[EMB.32]` El diálogo de alta rápida: valida, manda nombre y papel, y avisa qué pasó. Nombres inventados. */

function montar(rol: 'ayudante' | 'cargador' = 'ayudante', nombreInicial = '') {
  TestBed.configureTestingModule({
    imports: [AltaPersonaComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(AltaPersonaComponent);
  f.componentRef.setInput('rol', rol);
  f.componentRef.setInput('nombreInicial', nombreInicial);
  f.componentRef.setInput('visible', true);
  f.detectChanges();
  const c = f.componentInstance;
  c.alAbrir();
  return { f, c, http: TestBed.inject(HttpTestingController) };
}

describe('AltaPersonaComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('arranca con lo que ya se escribió en el buscador', () => {
    const { c } = montar('ayudante', 'juan prueba');
    expect(c.nombre()).toBe('juan prueba');
    expect(c.titulo()).toBe('Nuevo ayudante');
  });

  it('sin nombre y apellido no manda nada', () => {
    const { c, http } = montar('ayudante', 'Juan');
    c.guardar();
    http.expectNone(() => true);
    expect(c.errorVisible()).toBe('Escribe el nombre completo.');
  });

  it('manda nombre y papel, cierra y avisa qué pasó (reactivada)', () => {
    const { c, http } = montar('cargador', 'Juan Prueba');
    const emitidos: any[] = [];
    c.creada.subscribe((x) => emitidos.push(x));
    c.guardar();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/fleet/drivers/alta-rapida'));
    expect(req.request.body).toEqual({ full_name: 'Juan Prueba', rol: 'cargador' });
    req.flush({ accion: 'reactivada', driver: { id: 'd1', full_name: 'JUAN PRUEBA', roles: ['cargador'], active: true, status: 'activo' } });
    expect(c.visible()).toBe(false);
    expect(emitidos[0].driver.id).toBe('d1');
    expect(emitidos[0].mensaje).toContain('se reactivó');
  });

  it('si el servidor rechaza, se queda abierto y muestra su mensaje', () => {
    const { c, http } = montar('ayudante', 'Juan Prueba');
    c.guardar();
    http.expectOne(() => true).flush({ message: 'Escribe nombre y apellido.' }, { status: 400, statusText: 'Bad Request' });
    expect(c.visible()).toBe(true);
    expect(c.errorVisible()).toBe('Escribe nombre y apellido.');
  });
});
