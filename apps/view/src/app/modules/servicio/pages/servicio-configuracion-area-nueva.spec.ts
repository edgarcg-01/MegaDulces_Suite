import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MS.8.3]` «Nueva área» en la configuración de la Mesa (antes sólo la API creaba colas). Lo que se defiende:
 *  · ⭐ el área nace APAGADA (`active: false`): encendida y sin nadie, cada ticket caería en una bandeja que nadie ve;
 *  · el código se deriva del nombre si se deja vacío, y uno escrito a mano gana;
 *  · ⛔ sin nombre, o con un código inválido, no se puede crear;
 *  · lo que el servidor rechaza (p. ej. el código ya existe) se muestra, no se traga.
 */
const CFG = {
  settings: {
    business_days: [1, 2, 3, 4, 5], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [],
  queues: [{ id: 'q-ti', code: 'ti', name: 'TI', department_code: null, active: true, sort_order: 10, priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true, default_assignee_id: null, default_assignee_name: null, report_min_cases: 5 }],
  zones: [],
  categories: [],
  fields: [],
} as unknown as SdConfigResponse;

describe('[MS.8.3] configuración — nueva área', () => {
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      createQueue: vi.fn(() => of(CFG)),
    };
    await TestBed.configureTestingModule({ imports: [ServicioConfiguracionComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(ServicioConfiguracionComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ crea el área APAGADA, con el código derivado del nombre, y limpia el formulario', async () => {
    await render();
    c.areaNueva = { name: 'Compras (precios y productos)', code: '', priority_model: 'impacto', confidential: false };
    expect(c.areaValida()).toBe(true);
    c.crearArea();
    expect(api['createQueue']).toHaveBeenCalledWith({ name: 'Compras (precios y productos)', code: 'compras_precios_y_productos', priority_model: 'impacto', confidential: false, active: false });
    expect(c.areaNueva.name).toBe('');
  });

  it('un código escrito a mano gana sobre el derivado, y la confidencialidad viaja', async () => {
    await render();
    c.areaNueva = { name: 'Recursos Humanos', code: 'rh', priority_model: 'impacto', confidential: true };
    c.crearArea();
    expect(api['createQueue']).toHaveBeenCalledWith(expect.objectContaining({ code: 'rh', confidential: true, active: false }));
  });

  it('⛔ NEGATIVA — sin nombre o con un código inválido no se crea', async () => {
    await render();
    for (const a of [
      { name: '', code: '', priority_model: 'impacto' as const, confidential: false },
      { name: '   ', code: '', priority_model: 'impacto' as const, confidential: false },
      { name: 'Compras', code: 'Compras', priority_model: 'impacto' as const, confidential: false },
      { name: 'Compras', code: '1compras', priority_model: 'impacto' as const, confidential: false },
    ]) {
      c.areaNueva = a;
      expect(c.areaValida()).toBe(false);
      c.crearArea();
    }
    expect(api['createQueue']).not.toHaveBeenCalled();
  });

  it('⭐ la pantalla ofrece «Crear área», y lo que el servidor rechaza se muestra', async () => {
    await render();
    expect(el().textContent).toContain('Nueva área');
    expect(el().textContent).toContain('Crear área');
    api['createQueue'].mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 400, error: { message: 'Ya existe una cola con ese código' } })));
    c.areaNueva = { name: 'TI', code: 'ti', priority_model: 'impacto', confidential: false };
    c.crearArea();
    expect(c.error()).toContain('Ya existe una cola con ese código');
  });
});
