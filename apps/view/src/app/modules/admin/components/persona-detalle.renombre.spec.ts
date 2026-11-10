import { signal, SimpleChange } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConfirmationService } from 'primeng/api';
import { Observable, of, Subject, throwError } from 'rxjs';
import type { PersonaFila } from '@megadulces/contracts';

import { AdminService } from '../admin.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { PersonaDetalleComponent, soloCambioElUsuario } from './persona-detalle.component';

/**
 * `[AU.34]` — **Cambiar el usuario desde la ficha.**
 *
 * Lo que se prueba es lo que, si falla, deja a alguien sin poder entrar o le esconde por qué:
 *   · la acción sólo se ofrece a quien el servidor se la va a aceptar (llave de contraseñas, y
 *     nunca en la propia ficha);
 *   · el botón no ofrece lo que el servidor rechazaría (mismas reglas que `RenameUserDto`);
 *   · un rechazo por historia dice DÓNDE aparece el usuario, que es lo que hace falta para decidir;
 *   · el doble clic no manda dos cambios;
 *   · la misma persona que vuelve con el usuario nuevo no borra lo editado sin guardar.
 */
const persona = (over: Partial<PersonaFila> = {}): PersonaFila =>
  ({ id: 'p1', username: 'prueba_uno', nombre: 'Persona De Prueba', kind: 'interno', ...over }) as PersonaFila;

let llamadas: unknown[][] = [];
let respuesta: () => Observable<unknown> = () => of({});

const montar = async (opts: { permiso?: boolean; yo?: string } = {}): Promise<ComponentFixture<PersonaDetalleComponent>> => {
  llamadas = [];
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => {
      if (k === 'renombrarPersona') return (...a: unknown[]) => { llamadas.push(a); return respuesta(); };
      if (k === 'propuesta' || k === 'responsabilidadesDePersona' || k === 'historiaDePuesto') return () => of(null);
      return () => of([]);
    },
  });
  await TestBed.configureTestingModule({
    imports: [PersonaDetalleComponent],
    providers: [
      ConfirmationService,
      { provide: AdminService, useValue: api },
      { provide: PermissionsService, useValue: { has: () => opts.permiso ?? true, has$: () => opts.permiso ?? true } },
      { provide: AuthService, useValue: { user: signal({ sub: opts.yo ?? 'admin', username: 'admin' }) } },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(PersonaDetalleComponent);
  fix.componentRef.setInput('persona', persona());
  fix.componentRef.setInput('puedeEscribir', true);
  fix.detectChanges();
  return fix;
};

const texto = (fix: ComponentFixture<unknown>) => (fix.nativeElement as HTMLElement).textContent ?? '';
const boton = (fix: ComponentFixture<unknown>, rotulo: string) =>
  Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(rotulo));

describe('[AU.34] cambiar el usuario — quién lo ve', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('con la llave de contraseñas y en la ficha de otra persona, ofrece «Cambiar usuario»', async () => {
    const fix = await montar();
    expect(boton(fix, 'Cambiar usuario')).toBeTruthy();
    expect(texto(fix)).not.toContain('no se renombra');
  });

  it('en la propia ficha no lo ofrece, y dice por qué', async () => {
    const fix = await montar({ yo: 'p1' });
    expect(boton(fix, 'Cambiar usuario')).toBeFalsy();
    expect(texto(fix)).toContain('Tu propio usuario lo cambia otra persona');
  });

  it('sin la llave no lo ofrece, y dice quién puede', async () => {
    const fix = await montar({ permiso: false });
    expect(boton(fix, 'Cambiar usuario')).toBeFalsy();
    expect(texto(fix)).toContain('Lo cambia quien puede resetear contraseñas');
  });
});

describe('[AU.34] cambiar el usuario — qué deja enviar', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('pide usuario válido, distinto del actual, y motivo — las reglas del servidor', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.abrirRenombre();
    expect(cmp.faltaParaRenombrar()).toBe('Es el mismo usuario.');
    cmp.fNuevoUsuario.set('  PRUEBA_UNO ');
    expect(cmp.faltaParaRenombrar()).toBe('Es el mismo usuario.');
    cmp.fNuevoUsuario.set('prueba dos');
    expect(cmp.faltaParaRenombrar()).toContain('sin espacios');
    cmp.fNuevoUsuario.set('ml');
    expect(cmp.faltaParaRenombrar()).toContain('de 3 a 64');
    cmp.fNuevoUsuario.set('prueba_dos');
    expect(cmp.faltaParaRenombrar()).toContain('motivo');
    cmp.fMotivoRenombre.set('error de dedo');
    expect(cmp.faltaParaRenombrar()).toBeNull();
  });

  it('envía normalizado, avisa, cierra el formulario y emite el usuario nuevo', async () => {
    const fix = await montar();
    const cmp = fix.componentInstance;
    const emitidos: unknown[] = [];
    const avisos: string[] = [];
    cmp.renombrado.subscribe((r) => emitidos.push(r));
    cmp.aviso.subscribe((m) => avisos.push(m));
    respuesta = () => of({ user_id: 'p1', username_anterior: 'prueba_uno', username: 'prueba_dos', sessions_revoked_at: 'x' });
    cmp.abrirRenombre();
    cmp.fNuevoUsuario.set(' Prueba_Dos ');
    cmp.fMotivoRenombre.set('  error de dedo ');
    cmp.renombrar();
    expect(llamadas).toEqual([['p1', 'prueba_dos', 'error de dedo']]);
    expect(emitidos.length).toBe(1);
    expect(avisos[0]).toContain('prueba_dos');
    expect(cmp.renombrando()).toBe(false);
    expect(cmp.fUsername()).toBe('prueba_dos');
  });

  it('un rechazo por historia dice DÓNDE aparece y no emite nada', async () => {
    const fix = await montar();
    const cmp = fix.componentInstance;
    const emitidos: unknown[] = [];
    cmp.renombrado.subscribe((r) => emitidos.push(r));
    respuesta = () => throwError(() => ({
      status: 409,
      error: { code: 'usuario_con_historia', message: 'No se puede', encontrados: [{ clave: 'kepler_cajero', etiqueta: 'es un código de cajero en Kepler' }] },
    }));
    cmp.abrirRenombre();
    cmp.fNuevoUsuario.set('prueba_dos');
    cmp.fMotivoRenombre.set('error de dedo');
    cmp.renombrar();
    fix.detectChanges();
    expect(texto(fix)).toContain('es un código de cajero en Kepler');
    expect(texto(fix)).toContain('Pídeselo a Sistemas');
    expect(emitidos.length).toBe(0);
    expect(cmp.renombrando()).toBe(true);
  });

  it('si el nombre NUEVO ya es llave de otra persona, lo dice así y pide otro nombre', async () => {
    const fix = await montar();
    const cmp = fix.componentInstance;
    respuesta = () => throwError(() => ({
      status: 409,
      error: { code: 'usuario_nuevo_ocupado', message: 'x', encontrados: [{ clave: 'kepler_cajero', etiqueta: 'es un código de cajero en Kepler' }], sin_revisar: [] },
    }));
    cmp.abrirRenombre();
    cmp.fNuevoUsuario.set('cajero_ajeno');
    cmp.fMotivoRenombre.set('error de dedo');
    cmp.renombrar();
    fix.detectChanges();
    expect(texto(fix)).toContain('ya se usa como llave de otra persona');
    expect(texto(fix)).toContain('elige otro nombre');
  });

  it('lo que el servidor no pudo revisar se DICE (no se esconde detrás de un mensaje genérico)', async () => {
    const fix = await montar();
    const cmp = fix.componentInstance;
    respuesta = () => throwError(() => ({
      status: 409,
      error: {
        code: 'usuario_con_historia', message: 'x',
        encontrados: [{ clave: 'vales', etiqueta: 'creó, comprobó o autorizó vales de gasto' }],
        sin_revisar: [{ clave: 'kepler_cajero', etiqueta: 'es un código de cajero en Kepler' }],
      },
    }));
    cmp.abrirRenombre();
    cmp.fNuevoUsuario.set('prueba_dos');
    cmp.fMotivoRenombre.set('error de dedo');
    cmp.renombrar();
    fix.detectChanges();
    expect(texto(fix)).toContain('creó, comprobó o autorizó vales de gasto');
    expect(texto(fix)).toContain('No se pudo revisar si');
    expect(texto(fix)).toContain('es un código de cajero en Kepler');
  });

  it('Esc cierra el bloque y NO llega al documento (si llega, el side-peek cierra la ficha entera)', async () => {
    const fix = await montar();
    const cmp = fix.componentInstance;
    cmp.abrirRenombre();
    fix.detectChanges();
    let llegoAlDocumento = 0;
    const oyente = (ev: Event) => { if ((ev as KeyboardEvent).key === 'Escape') llegoAlDocumento++; };
    document.addEventListener('keydown', oyente);
    try {
      const input = (fix.nativeElement as HTMLElement).querySelector('#pd-ren-user') as HTMLInputElement;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      document.removeEventListener('keydown', oyente);
    }
    expect(cmp.renombrando()).toBe(false);
    expect(llegoAlDocumento).toBe(0);
  });

  it('el doble clic manda UN solo cambio', async () => {
    const cmp = (await montar()).componentInstance;
    const pendiente = new Subject<unknown>();
    respuesta = () => pendiente;
    cmp.abrirRenombre();
    cmp.fNuevoUsuario.set('prueba_dos');
    cmp.fMotivoRenombre.set('error de dedo');
    cmp.renombrar();
    cmp.renombrar();
    expect(llamadas.length).toBe(1);
  });
});

describe('[AU.34] la ficha no pierde lo editado', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const cambiarA = (cmp: PersonaDetalleComponent, nueva: PersonaFila) => {
    const previa = cmp.persona;
    cmp.persona = nueva;
    cmp.ngOnChanges({ persona: new SimpleChange(previa, nueva, false) });
  };

  it('la misma persona SÓLO con el usuario nuevo conserva lo escrito', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.fNombre.set('Persona De Prueba Editada');
    cambiarA(cmp, persona({ username: 'prueba_dos' }));
    expect(cmp.fNombre()).toBe('Persona De Prueba Editada');
    expect(cmp.fUsername()).toBe('prueba_dos');
  });

  it('la misma persona recargada (mismo usuario) o con otro dato cambiado SÍ reinicia, como antes', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.fNombre.set('Persona De Prueba Editada');
    cambiarA(cmp, persona());
    expect(cmp.fNombre()).toBe('Persona De Prueba');

    cmp.fNombre.set('Persona De Prueba Editada');
    cambiarA(cmp, persona({ username: 'prueba_dos', nombre: 'Nombre Nuevo Del Servidor' }));
    expect(cmp.fNombre()).toBe('Nombre Nuevo Del Servidor');
  });

  it('otra persona reinicia', async () => {
    const cmp = (await montar()).componentInstance;
    cmp.fNombre.set('Persona De Prueba Editada');
    cambiarA(cmp, persona({ id: 'p2', username: 'otra', nombre: 'Otra' }));
    expect(cmp.fNombre()).toBe('Otra');
  });

  it('soloCambioElUsuario: verdad sólo con mismo id, otro usuario y todo lo demás igual', () => {
    expect(soloCambioElUsuario(persona(), persona({ username: 'prueba_dos' }))).toBe(true);
    expect(soloCambioElUsuario(persona(), persona())).toBe(false);
    expect(soloCambioElUsuario(persona(), persona({ username: 'prueba_dos', nombre: 'Otro' }))).toBe(false);
    expect(soloCambioElUsuario(persona(), persona({ id: 'p2', username: 'prueba_dos' }))).toBe(false);
    expect(soloCambioElUsuario(null, persona())).toBe(false);
  });
});
