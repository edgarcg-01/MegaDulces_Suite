import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { MessageService } from 'primeng/api';
import { AlertsSocketService, type CommercialAlert } from '../command-center/alerts-socket.service';
import { DesktopNoticeService } from '../../../core/services/desktop-notice.service';
import { ServiceDeskAvisoToastComponent } from './service-desk-aviso-toast.component';

/** `[MS.AVISO]` Entra una solicitud nueva → ventana emergente (y aviso del sistema si la pestaña no se ve). */
const alerta = (event: string, severity: CommercialAlert['severity'] = 'info', type = 'service_desk'): CommercialAlert => ({
  type: type as never, severity, title: 'Nueva solicitud', message: 'SRV-2026-00042 · No abre el ERP — la reportó Ana.',
  data: { source: 'service_desk', event, request_id: 'abc-123', folio: 'SRV-2026-00042' }, emitted_at: new Date().toISOString(),
});

describe('ServiceDeskAvisoToastComponent', () => {
  let fix: ComponentFixture<ServiceDeskAvisoToastComponent>;
  let alert$: Subject<CommercialAlert>;
  let add: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;
  let mostrar: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  async function montar(): Promise<void> {
    alert$ = new Subject();
    add = vi.fn(); clear = vi.fn(); mostrar = vi.fn(() => true); disconnect = vi.fn();
    await TestBed.configureTestingModule({
      imports: [ServiceDeskAvisoToastComponent],
      providers: [
        provideRouter([]),
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), disconnect, alert$, connected: signal(true) } },
        { provide: DesktopNoticeService, useValue: { mostrar, permiso: signal('granted') } },
      ],
    })
      // El componente trae su propio MessageService (como el toast de salud): se reemplaza en SU inyector.
      .overrideComponent(ServiceDeskAvisoToastComponent, { set: { providers: [{ provide: MessageService, useValue: { add, clear, messageObserver: new Subject(), clearObserver: new Subject() } }] } })
      .compileComponents();
    fix = TestBed.createComponent(ServiceDeskAvisoToastComponent);
    fix.detectChanges();
  }
  const oculta = (v: boolean): void => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); };

  afterEach(() => { oculta(false); TestBed.resetTestingModule(); });

  it('⭐ una solicitud nueva abre la ventana con su ruta al detalle', async () => {
    await montar();
    alert$.next(alerta('nueva_solicitud'));
    expect(add).toHaveBeenCalledTimes(1);
    const m = add.mock.calls[0][0];
    expect(m.key).toBe('sd-aviso');
    expect(m.summary).toBe('Nueva solicitud');
    expect(m.data.route).toBe('/servicio/bandeja?id=abc-123');
    expect(m.sticky).toBe(false);
  });
  it('una urgente NO se cierra sola (sticky) y sale como error', async () => {
    await montar();
    alert$.next(alerta('nuevo_prioritario', 'critical'));
    expect(add.mock.calls[0][0]).toMatchObject({ sticky: true, severity: 'error' });
  });
  it('NEGATIVA: un comentario, otro tipo de alerta o un evento ajeno NO abren ventana', async () => {
    await montar();
    alert$.next(alerta('comentario'));
    alert$.next(alerta('nueva_solicitud', 'info', 'db_health'));
    alert$.next(alerta('asignado'));
    expect(add).not.toHaveBeenCalled();
    expect(mostrar).not.toHaveBeenCalled();
  });
  it('⭐ con la pestaña OCULTA sale además el aviso del sistema; con la pestaña a la vista NO (no se duplica)', async () => {
    await montar();
    oculta(true);
    alert$.next(alerta('nueva_solicitud'));
    expect(mostrar).toHaveBeenCalledTimes(1);
    expect(mostrar.mock.calls[0][0]).toBe('Nueva solicitud');
    oculta(false);
    alert$.next(alerta('nueva_solicitud'));
    expect(mostrar).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(2);
  });
  it('abrir() cierra la ventana y navega al detalle', async () => {
    await montar();
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    fix.componentInstance.abrir('/servicio/bandeja?id=abc-123');
    expect(clear).toHaveBeenCalledWith('sd-aviso');
    expect(nav).toHaveBeenCalled();
  });
  it('⭐ la ventana REAL pinta el título, el detalle y un botón que abre el detalle (con el MessageService de verdad)', async () => {
    alert$ = new Subject();
    await TestBed.configureTestingModule({
      imports: [ServiceDeskAvisoToastComponent],
      providers: [
        provideRouter([]),
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), disconnect: vi.fn(), alert$, connected: signal(true) } },
        { provide: DesktopNoticeService, useValue: { mostrar: vi.fn(), permiso: signal('default') } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServiceDeskAvisoToastComponent);
    fix.detectChanges();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    alert$.next(alerta('nueva_solicitud'));
    await fix.whenStable();
    fix.detectChanges();
    const boton = document.querySelector('.sd-aviso') as HTMLButtonElement | null;
    expect(boton).not.toBeNull();
    expect(boton!.textContent).toContain('Nueva solicitud');
    expect(boton!.textContent).toContain('SRV-2026-00042');
    boton!.click();
    expect(nav).toHaveBeenCalled();
    expect(String(nav.mock.calls[0][0])).toContain('/servicio/bandeja');
  });
  it('al destruirse suelta el socket y deja de escuchar', async () => {
    await montar();
    fix.destroy();
    expect(disconnect).toHaveBeenCalled();
    alert$.next(alerta('nueva_solicitud'));
    expect(add).not.toHaveBeenCalled();
  });
});
