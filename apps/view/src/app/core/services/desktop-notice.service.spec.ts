import { TestBed } from '@angular/core/testing';
import { DesktopNoticeService } from './desktop-notice.service';

/** `[MS.AVISO]` El aviso del sistema operativo: sólo sale con permiso, y si no sale lo dice (no se finge). */
describe('DesktopNoticeService', () => {
  type G = { Notification?: unknown };
  const g = globalThis as G;
  const original = g.Notification;
  let creadas: { titulo: string; opts: Record<string, unknown>; close: ReturnType<typeof vi.fn>; onclick?: () => void }[];

  function falsa(permiso: string, alSolicitar?: () => void): void {
    creadas = [];
    class N {
      static permission = permiso;
      static requestPermission = vi.fn(async () => { alSolicitar?.(); return N.permission; });
      close = vi.fn();
      onclick?: () => void;
      constructor(public titulo: string, public opts: Record<string, unknown>) { creadas.push(this as never); }
    }
    g.Notification = N;
  }
  const servicio = (): DesktopNoticeService => TestBed.inject(DesktopNoticeService);

  afterEach(() => { g.Notification = original; TestBed.resetTestingModule(); });

  it('⭐ con permiso concedido el aviso sale, y al hacer clic enfoca y ejecuta la acción', () => {
    falsa('granted');
    const accion = vi.fn();
    expect(servicio().mostrar('Nueva solicitud', 'SRV-1', accion, 'sd-aviso')).toBe(true);
    expect(creadas).toHaveLength(1);
    expect(creadas[0].opts['tag']).toBe('sd-aviso');
    creadas[0].onclick!();
    expect(accion).toHaveBeenCalledTimes(1);
    expect(creadas[0].close).toHaveBeenCalled();
  });
  it('NEGATIVA: sin permiso (default o denied) NO sale nada y lo dice con false', () => {
    for (const p of ['default', 'denied']) {
      falsa(p);
      expect(servicio().mostrar('t', 'm', vi.fn())).toBe(false);
      expect(creadas).toHaveLength(0);
      TestBed.resetTestingModule();
    }
  });
  it('NEGATIVA: un navegador sin la API se declara unsupported y no lanza', async () => {
    delete g.Notification;
    const s = servicio();
    expect(s.permiso()).toBe('unsupported');
    expect(s.mostrar('t', 'm', vi.fn())).toBe(false);
    expect(await s.solicitar()).toBe('unsupported');
  });
  it('solicitar() relee el permiso que dio la persona', async () => {
    falsa('default', () => { (g.Notification as { permission: string }).permission = 'granted'; });
    const s = servicio();
    expect(s.permiso()).toBe('default');
    expect(await s.solicitar()).toBe('granted');
    expect(s.permiso()).toBe('granted');
  });
  it('si el constructor lanza, mostrar() devuelve false en vez de tirar la pantalla', () => {
    g.Notification = Object.assign(function () { throw new Error('bloqueado'); }, { permission: 'granted' });
    expect(servicio().mostrar('t', 'm', vi.fn())).toBe(false);
  });
});
