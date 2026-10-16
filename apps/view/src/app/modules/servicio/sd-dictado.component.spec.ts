import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ServiceDeskService } from './service-desk.service';
import { SdDictadoComponent } from './sd-dictado.component';

/**
 * `[MS.DICTADO]` El dictado en pantalla. Lo que se defiende:
 *  · grabar → transcribir → entregar el TEXTO (y mandar el área, de la que depende la regla del servidor);
 *  · sin área no se graba; sin micrófono o sin permiso se dice por qué; un error de transcripción no entrega nada;
 *  · si el navegador no puede grabar, no se pinta (escribir sigue sirviendo).
 */
class FalsoMediaRecorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public flujo: unknown, public opciones?: unknown) {}
  start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
}

describe('[MS.DICTADO] SdDictadoComponent', () => {
  let fix: ComponentFixture<SdDictadoComponent>;
  let c: SdDictadoComponent;
  let api: { transcribe: ReturnType<typeof vi.fn> };
  let pedirMic: ReturnType<typeof vi.fn>;
  const pistaStop = vi.fn();
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const emitido: string[] = [];

  async function render(opts: { queueId?: string | null; respuesta?: unknown; falla?: unknown; mic?: boolean; micError?: unknown } = {}) {
    const mic = opts.mic ?? true;
    if (mic) {
      vi.stubGlobal('MediaRecorder', FalsoMediaRecorder);
      pedirMic = vi.fn(() => (opts.micError ? Promise.reject(opts.micError) : Promise.resolve({ getTracks: () => [{ stop: pistaStop }] })));
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: pedirMic }, configurable: true });
    } else {
      vi.stubGlobal('MediaRecorder', undefined);
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    }
    api = { transcribe: vi.fn(() => (opts.falla ? throwError(() => opts.falla) : of(opts.respuesta ?? { text: 'No abre el sistema de caja' }))) };
    await TestBed.configureTestingModule({ imports: [SdDictadoComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdDictadoComponent);
    c = fix.componentInstance;
    fix.componentRef.setInput('queueId', opts.queueId === undefined ? 'q-ti' : opts.queueId);
    emitido.length = 0;
    c.texto.subscribe((t) => emitido.push(t));
    fix.detectChanges();
    await fix.whenStable();
  }

  async function dictar() {
    c.alternar(); // empieza
    await vi.waitFor(() => expect(c.estado()).toBe('grabando'));
    c.alternar(); // termina
    await vi.waitFor(() => expect(c.estado()).toBe('inactivo'));
  }

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    pistaStop.mockClear();
  });

  it('⭐ graba, manda el audio con el ÁREA y entrega el texto transcrito', async () => {
    await render();
    await dictar();
    expect(api.transcribe).toHaveBeenCalledTimes(1);
    const dto = api.transcribe.mock.calls[0][0];
    expect(dto.queue_id).toBe('q-ti');
    expect(dto.mime).toBe('audio/webm');
    expect(dto.audio.length).toBeGreaterThan(0);
    expect(emitido).toEqual(['No abre el sistema de caja']);
    expect(pistaStop).toHaveBeenCalled(); // el micrófono se suelta
  });

  it('se pinta el botón con su pista y avisa que el audio no se guarda', async () => {
    await render();
    expect(texto()).toContain('Dictar');
    expect(texto()).toMatch(/audio no se guarda/i);
  });

  it('⛔ NEGATIVA — sin área elegida no se pide el micrófono (el botón está apagado)', async () => {
    await render({ queueId: null });
    expect((fix.nativeElement as HTMLElement).querySelector('button')?.disabled).toBe(true);
    c.alternar();
    await Promise.resolve();
    expect(pedirMic).not.toHaveBeenCalled();
    expect(c.estado()).toBe('inactivo');
  });

  it('⛔ NEGATIVA — si el navegador no puede grabar, no se pinta nada', async () => {
    await render({ mic: false });
    expect(c.soportado).toBe(false);
    expect((fix.nativeElement as HTMLElement).querySelector('.sdd')).toBeNull();
  });

  it('⛔ NEGATIVA — micrófono sin permiso: se explica y no queda grabando', async () => {
    await render({ micError: Object.assign(new Error('x'), { name: 'NotAllowedError' }) });
    c.alternar();
    await vi.waitFor(() => expect(c.error()).toMatch(/permiso/i));
    expect(c.estado()).toBe('inactivo');
    expect(api.transcribe).not.toHaveBeenCalled();
  });

  it('⛔ NEGATIVA — el servicio de voz no configurado se dice y NO entrega texto', async () => {
    await render({ respuesta: { text: '', error: 'no_key' } });
    await dictar();
    expect(c.error()).toMatch(/no está configurado/i);
    expect(emitido).toEqual([]);
  });

  it('⛔ NEGATIVA — una transcripción vacía se dice y NO entrega texto', async () => {
    await render({ respuesta: { text: '   ' } });
    await dictar();
    expect(c.error()).toMatch(/no se entendió/i);
    expect(emitido).toEqual([]);
  });

  it('⛔ NEGATIVA — si el servidor la rechaza (área confidencial, 403) se muestra SU motivo y no se entrega nada', async () => {
    const e = new HttpErrorResponse({ status: 403, error: { message: 'En un área confidencial no se dicta: el audio lo procesa un servicio externo. Escribe tu mensaje.' } });
    await render({ falla: e });
    await dictar();
    expect(c.error()).toMatch(/área confidencial no se dicta/i);
    expect(emitido).toEqual([]);
  });

  it('cancelar descarta lo grabado: no se transcribe y el micrófono se suelta', async () => {
    await render();
    c.alternar();
    await vi.waitFor(() => expect(c.estado()).toBe('grabando'));
    c.cancelar();
    expect(c.estado()).toBe('inactivo');
    expect(api.transcribe).not.toHaveBeenCalled();
    expect(pistaStop).toHaveBeenCalled();
  });
});
