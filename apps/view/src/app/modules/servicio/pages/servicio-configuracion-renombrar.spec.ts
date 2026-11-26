import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MS.8.5]` «Renombrar» un área desde la configuración de la Mesa (antes sólo la API cambiaba el nombre; un área creada con un
 * error de dedo —«Operación de sucursales ·», 2026-11-26— no tenía cómo corregirse en pantalla). Lo que se defiende:
 *  · ⭐ viaja SÓLO el nombre, recortado: el código no se toca (lo usan órdenes de servicio, reglas y reportes);
 *  · ⛔ un nombre vacío no viaja (se avisa) y el mismo nombre sólo cierra el campo, sin una llamada inútil;
 *  · el campo se cierra sólo si el servidor aceptó; si rechaza, su motivo se muestra y el campo sigue abierto con lo escrito;
 *  · Escape cancela y Enter guarda, desde el teclado.
 */
const COLA = { id: 'q-ops', code: 'operacion_de_sucursales', name: 'Operación de sucursales ·', department_code: null, active: false, sort_order: 100, priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true, default_assignee_id: null, default_assignee_name: null, report_min_cases: 5 };
const cfgCon = (nombre: string) => ({
  settings: {
    business_days: [1, 2, 3, 4, 5], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [],
  queues: [{ ...COLA, name: nombre }],
  zones: [],
  categories: [],
  fields: [],
}) as unknown as SdConfigResponse;

describe('[MS.8.5] configuración — renombrar un área', () => {
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;
  const campo = () => el().querySelector<HTMLInputElement>('#sc-renombre-q-ops');
  const boton = (texto: string) => Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === texto);

  async function render() {
    api = {
      config: vi.fn(() => of(cfgCon(COLA.name))),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      updateQueue: vi.fn(() => of(cfgCon('Operación de sucursales'))),
    };
    await TestBed.configureTestingModule({ imports: [ServicioConfiguracionComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(ServicioConfiguracionComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ «Renombrar» abre el campo con el nombre actual y avisa que el código no cambia', async () => {
    await render();
    expect(campo()).toBeNull();
    boton('Renombrar')?.click();
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    expect(campo()).not.toBeNull();
    expect(campo()?.value).toBe('Operación de sucursales ·');
    expect(c.nombreNuevo).toBe('Operación de sucursales ·');
    expect(el().textContent).toContain('El código operacion_de_sucursales no cambia');
    expect(boton('Renombrar')).toBeUndefined();
  });

  it('⭐ guarda SÓLO el nombre, recortado, cierra el campo y dice el antes y el después', async () => {
    await render();
    c.empezarRenombre(COLA);
    c.nombreNuevo = '  Operación de sucursales  ';
    c.guardarRenombre(COLA);
    expect(api['updateQueue']).toHaveBeenCalledWith('q-ops', { name: 'Operación de sucursales' });
    expect(c.renombrando()).toBeNull();
    expect(c.aviso()).toContain('«Operación de sucursales ·» ahora se llama «Operación de sucursales»');
    expect(c.aviso()).toContain('Su código (operacion_de_sucursales) no cambia');
    fix.detectChanges();
    // El encabezado del área ya dice el nombre nuevo (el aviso, a propósito, cita el viejo y el nuevo).
    expect(el().querySelector('.sc-qhead b')?.textContent?.trim()).toBe('Operación de sucursales');
    expect(campo()).toBeNull();
  });

  it('⛔ NEGATIVA — un nombre vacío no viaja, se avisa y el campo sigue abierto', async () => {
    await render();
    c.empezarRenombre(COLA);
    for (const vacio of ['', '   ']) {
      c.nombreNuevo = vacio;
      c.guardarRenombre(COLA);
    }
    expect(api['updateQueue']).not.toHaveBeenCalled();
    expect(c.error()).toContain('no puede quedar vacío');
    expect(c.renombrando()).toBe('q-ops');
  });

  it('el mismo nombre sólo cierra el campo, sin llamada al servidor', async () => {
    await render();
    c.empezarRenombre(COLA);
    c.nombreNuevo = ' Operación de sucursales · ';
    c.guardarRenombre(COLA);
    expect(api['updateQueue']).not.toHaveBeenCalled();
    expect(c.renombrando()).toBeNull();
  });

  it('⛔ si el servidor rechaza, su motivo se muestra y el campo sigue abierto con lo escrito', async () => {
    await render();
    api['updateQueue'].mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 403, error: { message: 'Sólo la coordinación de esa cola puede cambiarla' } })));
    c.empezarRenombre(COLA);
    c.nombreNuevo = 'Operación de sucursales';
    c.guardarRenombre(COLA);
    expect(c.error()).toContain('Sólo la coordinación de esa cola puede cambiarla');
    expect(c.renombrando()).toBe('q-ops');
    expect(c.nombreNuevo).toBe('Operación de sucursales');
  });

  it('desde el teclado: Escape cancela y Enter guarda', async () => {
    await render();
    boton('Renombrar')?.click();
    fix.detectChanges();
    campo()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fix.detectChanges();
    expect(c.renombrando()).toBeNull();
    expect(api['updateQueue']).not.toHaveBeenCalled();

    boton('Renombrar')?.click();
    fix.detectChanges();
    c.nombreNuevo = 'Operación de sucursales';
    campo()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(api['updateQueue']).toHaveBeenCalledWith('q-ops', { name: 'Operación de sucursales' });
  });
});
