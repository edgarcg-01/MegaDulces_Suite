import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import type { SdRequestDetail, SdStatus } from '@megadulces/contracts';
import { ServiceDeskService } from './service-desk.service';
import { SdRequestDetailComponent } from './sd-request-detail.component';

/**
 * `[MS.3.3]` La ficha. Lo que se defiende:
 *  · quien REPORTA ve «Cerrar» / «Sigue fallando» sólo cuando está resuelto, y NUNCA los botones de atención;
 *  · quien ATIENDE ve «Tomar» sólo en un ticket nuevo, y el menú de estados que le corresponde;
 *  · resolver y reabrir EXIGEN nota (el botón no se habilita sin ella);
 *  · una nota interna SÍ admite archivos (`[MS.3.13]`), y la pantalla avisa que tampoco los ve quien reportó;
 *  · lo que el servidor rechaza se muestra con su razón, no como un fallo genérico.
 */

const t = (status: SdStatus, over: Partial<SdRequestDetail> = {}): SdRequestDetail => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q', queue_name: 'TI', category_id: 'c', category_name: 'Sistema de caja',
  title: 'No abre la caja', priority: 'alta', priority_suggested: 'alta', impact: 'sucursal', blocks_work: true, status,
  requester_id: 'u1', requester_name: 'Ana', warehouse_code: '02', warehouse_name: 'La Piedad Abastos',
  assigned_to: status === 'nuevo' ? null : 'u2', assigned_to_name: status === 'nuevo' ? null : 'Jorge', assigned_at: null,
  created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
  description: 'Sale un error', requester_department_code: null, requester_position_code: null, channel: 'web',
  resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
  messages: [
    { id: 'm1', kind: 'system', visibility: 'public', author_id: 'u1', author_label: 'Ana', body: 'Solicitud creada', meta: {}, created_at: '2026-10-02T15:00:00.000Z' },
    { id: 'm2', kind: 'internal_note', visibility: 'internal', author_id: 'u2', author_label: 'Jorge', body: 'Parece el usuario bloqueado', meta: {}, created_at: '2026-10-02T15:05:00.000Z' },
  ],
  attachments: [], time_logged_minutes: 0, ...over,
});

function makeApi(initial: SdRequestDetail) {
  return {
    detail: vi.fn(() => of(initial)),
    take: vi.fn(() => of(t('asignado'))),
    status: vi.fn((_id: string, b: { status: SdStatus }) => of(t(b.status))),
    confirm: vi.fn(() => of(t('cerrado'))),
    reopen: vi.fn(() => of(t('en_proceso'))),
    cancel: vi.fn(() => of(t('cancelado'))),
    assign: vi.fn(() => of(t('asignado'))),
    priority: vi.fn(() => of(t('asignado'))),
    logTime: vi.fn(() => of(t('asignado'))),
    message: vi.fn(() => of(t('asignado'))),
    agents: vi.fn(() => of([])),
  };
}

describe('[MS.3.3] SdRequestDetailComponent', () => {
  let fix: ComponentFixture<SdRequestDetailComponent>;
  let api: ReturnType<typeof makeApi>;

  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const botones = () => Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');

  async function render(status: SdStatus, agent: boolean, coord = false, over: Partial<SdRequestDetail> = {}) {
    api = makeApi(t(status, over));
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 't1');
    fix.componentRef.setInput('agent', agent);
    fix.componentRef.setInput('coord', coord);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  it('carga el ticket por su id y pinta folio, título y estado', async () => {
    await render('nuevo', false);
    expect(api.detail).toHaveBeenCalledWith('t1');
    expect(texto()).toContain('SRV-2026-00001');
    expect(texto()).toContain('No abre la caja');
    expect(texto()).toContain('Nuevo');
  });

  describe('quien REPORTA', () => {
    it('⭐ nunca ve los botones de atención', async () => {
      for (const s of ['nuevo', 'asignado', 'en_proceso', 'en_espera', 'resuelto'] as SdStatus[]) {
        TestBed.resetTestingModule();
        await render(s, false);
        const b = botones().join('|');
        expect(b, `estado ${s}`).not.toContain('Tomar');
        expect(b, `estado ${s}`).not.toContain('Iniciar');
        expect(b, `estado ${s}`).not.toContain('Marcar resuelta');
        expect(b, `estado ${s}`).not.toContain('Aplicar prioridad');
      }
    });
    it('resuelto: ofrece cerrar o decir que sigue fallando', async () => {
      await render('resuelto', false);
      expect(botones()).toEqual(expect.arrayContaining(['Ya quedó, cerrar', 'Sigue fallando']));
    });
    it('«Ya quedó, cerrar» confirma la solicitud', async () => {
      await render('resuelto', false);
      const b = Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.includes('Ya quedó')) as HTMLButtonElement;
      b.click();
      fix.detectChanges();
      expect(api.confirm).toHaveBeenCalledWith('t1');
    });
    it('⭐ reabrir exige decir qué falla: sin texto el botón Confirmar está deshabilitado', async () => {
      await render('resuelto', false);
      (Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.includes('Sigue fallando')) as HTMLButtonElement).click();
      fix.detectChanges();
      const ok = () => Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Confirmar') as HTMLButtonElement;
      expect(ok().disabled).toBe(true);
      fix.componentInstance.notaModo.set('Sigue sin entrar');
      fix.detectChanges();
      expect(ok().disabled).toBe(false);
      ok().click();
      expect(api.reopen).toHaveBeenCalledWith('t1', 'Sigue sin entrar');
    });
    it('cancelar sólo se ofrece mientras nadie esté trabajándola (no en_proceso)', async () => {
      await render('en_proceso', false);
      expect(botones().join('|')).not.toContain('Cancelar solicitud');
      TestBed.resetTestingModule();
      await render('nuevo', false);
      expect(botones().join('|')).toContain('Cancelar solicitud');
    });
    it('no ve «Registrar tiempo» ni el tiempo registrado', async () => {
      await render('en_proceso', false, false, { time_logged_minutes: null });
      expect(texto()).not.toContain('Registrar tiempo');
      expect(texto()).not.toContain('Tiempo');
    });
    it('sin permiso de atender no hay casilla de nota interna', async () => {
      await render('en_proceso', false);
      expect(texto()).not.toContain('Nota interna (no la ve');
    });
  });

  describe('quien ATIENDE', () => {
    it('nuevo: ofrece «Tomar» y el clic llama a take', async () => {
      await render('nuevo', true);
      const b = Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Tomar') as HTMLButtonElement;
      expect(b).toBeTruthy();
      b.click();
      expect(api.take).toHaveBeenCalledWith('t1');
    });
    it('asignado: ofrece iniciar y poner en espera, y NO «Tomar»', async () => {
      await render('asignado', true);
      const b = botones().join('|');
      expect(b).toContain('Iniciar');
      expect(b).toContain('Poner en espera');
      expect(b).not.toContain('Tomar');
    });
    it('en proceso: puede marcar resuelta, y eso EXIGE la descripción de la solución', async () => {
      await render('en_proceso', true);
      (Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.includes('Marcar resuelta')) as HTMLButtonElement).click();
      fix.detectChanges();
      expect(texto()).toContain('Cómo se resolvió');
      const ok = Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Confirmar') as HTMLButtonElement;
      expect(ok.disabled).toBe(true);
      fix.componentInstance.notaModo.set('Se desbloqueó el usuario');
      fix.detectChanges();
      ok.click();
      expect(api.status).toHaveBeenCalledWith('t1', { status: 'resuelto', note: 'Se desbloqueó el usuario' });
    });
    it('ve las notas internas que el servidor le mandó, marcadas como tales', async () => {
      await render('en_proceso', true);
      expect(texto()).toContain('Parece el usuario bloqueado');
      expect(texto()).toContain('Nota interna');
    });
    it('el selector de «Asignar a» sólo aparece para coordinación', async () => {
      await render('asignado', true, false);
      expect(el().querySelector('[ariaLabel="Asignar a"], p-select[ariaLabel="Asignar a"]')).toBeNull();
      expect(api.agents).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      await render('asignado', true, true);
      expect(api.agents).toHaveBeenCalled();
    });
    it('⭐ `[MS.3.13]` una nota interna con archivos SÍ se puede enviar, y la pantalla dice que quien reportó tampoco los ve', async () => {
      await render('en_proceso', true);
      const c = fix.componentInstance;
      c.texto.set('Foto del equipo');
      c.interna.set(true);
      c.archivos.set([new File(['x'], 'a.png', { type: 'image/png' })]);
      fix.detectChanges();
      const enviar = Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Guardar nota') as HTMLButtonElement;
      expect(enviar.disabled).toBe(false);
      expect(texto()).toContain('tampoco los ve quien reportó');
    });
    it('el aviso de privacidad sólo sale con nota interna Y archivos (en un mensaje público no tiene sentido)', async () => {
      await render('en_proceso', true);
      const c = fix.componentInstance;
      c.texto.set('algo');
      c.archivos.set([new File(['x'], 'a.png', { type: 'image/png' })]);
      fix.detectChanges();
      expect(texto()).not.toContain('tampoco los ve quien reportó');
      c.interna.set(true);
      c.archivos.set([]);
      fix.detectChanges();
      expect(texto()).not.toContain('tampoco los ve quien reportó');
    });
    it('⛔ NEGATIVA — sin texto no se envía, con o sin archivos (el cuerpo sigue siendo obligatorio)', async () => {
      await render('en_proceso', true);
      const c = fix.componentInstance;
      c.interna.set(true);
      c.archivos.set([new File(['x'], 'a.png', { type: 'image/png' })]);
      fix.detectChanges();
      const enviar = Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Guardar nota') as HTMLButtonElement;
      expect(enviar.disabled).toBe(true);
    });
  });

  describe('archivos y errores', () => {
    it('sólo fotos y PDF: un .exe se rechaza con su nombre', async () => {
      await render('en_proceso', true);
      const input = el().querySelector('input[type=file]') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'virus.exe', { type: 'application/x-msdownload' }), new File(['x'], 'ok.png', { type: 'image/png' })] });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(fix.componentInstance.optimizando()).toBe(false)); // `[MS.3.12]` las fotos se optimizan antes de quedar listas
      fix.detectChanges();
      expect(texto()).toContain('virus.exe');
      expect(fix.componentInstance.archivos().map((f) => f.name)).toEqual(['ok.png']);
    });
    it('⭐ `[MS.3.12]` quien atiende tiene «Cámara» (toma la foto en el momento) además de «Adjuntar» (galería y archivos)', async () => {
      await render('en_proceso', true);
      const cam = el().querySelector('input[type=file][capture]') as HTMLInputElement;
      expect(cam, 'falta la entrada de cámara').toBeTruthy();
      expect(cam.getAttribute('capture')).toBe('environment'); // cámara trasera: la que apunta al problema
      expect(cam.accept).toBe('image/*');
      expect(cam.multiple).toBe(false); // la cámara entrega UNA foto por toma
      const galeria = Array.from(el().querySelectorAll('input[type=file]')).find((i) => !i.hasAttribute('capture')) as HTMLInputElement;
      expect(galeria.multiple).toBe(true);
      expect(galeria.accept).toContain('application/pdf');
      expect(botones()).toEqual(expect.arrayContaining(['Cámara', 'Adjuntar']));
    });
    it('⛔ NEGATIVA — mientras se optimizan las fotos NO se deja enviar (se mandaría sin achicar)', async () => {
      await render('en_proceso', true);
      const c = fix.componentInstance;
      c.texto.set('Evidencia del problema');
      c.optimizando.set(true);
      fix.detectChanges();
      const enviar = Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Enviar') as HTMLButtonElement;
      expect(enviar.disabled).toBe(true);
      c.optimizando.set(false);
      fix.detectChanges();
      expect((Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Enviar') as HTMLButtonElement).disabled).toBe(false);
    });
    it('máximo 5 archivos por envío', async () => {
      await render('en_proceso', true);
      const c = fix.componentInstance;
      const seis = Array.from({ length: 6 }, (_, i) => new File(['x'], `f${i}.png`, { type: 'image/png' }));
      const input = el().querySelector('input[type=file]') as HTMLInputElement;
      Object.defineProperty(input, 'files', { value: seis });
      input.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(c.optimizando()).toBe(false));
      expect(c.archivos()).toHaveLength(5);
      expect(c.error()).toContain('Máximo 5');
    });
    it('⭐ el 409 del servidor se muestra con SU razón, no con un mensaje genérico', async () => {
      await render('nuevo', true);
      api.take.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'La solicitud ya fue tomada por alguien más' } })));
      (Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Tomar') as HTMLButtonElement).click();
      fix.detectChanges();
      expect(texto()).toContain('ya fue tomada por alguien más');
    });
    it('una acción exitosa refresca la ficha y avisa al padre para que recargue su lista', async () => {
      await render('nuevo', true);
      const avisos: SdRequestDetail[] = [];
      fix.componentInstance.cambio.subscribe((x) => avisos.push(x));
      (Array.from(el().querySelectorAll('button')).find((x) => x.textContent?.trim() === 'Tomar') as HTMLButtonElement).click();
      fix.detectChanges();
      expect(avisos).toHaveLength(1);
      expect(avisos[0].status).toBe('asignado');
      expect(texto()).toContain('Quedó asignada a ti');
    });
  });
});
