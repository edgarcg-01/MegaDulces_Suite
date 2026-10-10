import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MSH.3]` Configuración de una cola CONFIDENCIAL. Lo que se defiende:
 *  · cada bandera (confidencial, usa prioridad, mide plazos) manda SÓLO ella al servidor, y sólo si cambió;
 *  · ⛔ el mínimo de casos del reporte no viaja si no es un entero de 1 a 1000 (y se avisa por qué);
 *  · el mínimo sólo se pide en una cola confidencial;
 *  · una cola SIN prioridad no ofrece el selector de «prioridad sugerida por»;
 *  · lo que el servidor rechaza (p. ej. confidencial con solicitudes) se muestra, no se traga.
 */
const COLA = { code: 'x', department_code: null, active: true, sort_order: 10, priority_model: 'impacto' as const, asks_zone: false, default_assignee_id: null, default_assignee_name: null };
const CFG: SdConfigResponse = {
  settings: {
    business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [],
  queues: [
    { ...COLA, id: 'q-ti', code: 'ti', name: 'TI', confidential: false, uses_priority: true, sla_enabled: true, report_min_cases: 5 },
    { ...COLA, id: 'q-rh', code: 'rh', name: 'Recursos Humanos', confidential: true, uses_priority: false, sla_enabled: false, report_min_cases: 5 },
  ],
  zones: [],
  categories: [],
  fields: [],
} as unknown as SdConfigResponse;

describe('[MSH.3] configuración — comportamiento de la cola', () => {
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      updateQueue: vi.fn(() => of(CFG)),
    };
    await TestBed.configureTestingModule({ imports: [ServicioConfiguracionComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(ServicioConfiguracionComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ cada bandera manda SÓLO ella, y no manda nada si no cambió', async () => {
    await render();
    c.cambiarBandera('q-ti', 'confidential', false, true);
    expect(api['updateQueue']).toHaveBeenLastCalledWith('q-ti', { confidential: true });
    c.cambiarBandera('q-ti', 'uses_priority', true, false);
    expect(api['updateQueue']).toHaveBeenLastCalledWith('q-ti', { uses_priority: false });
    c.cambiarBandera('q-ti', 'sla_enabled', true, false);
    expect(api['updateQueue']).toHaveBeenLastCalledWith('q-ti', { sla_enabled: false });
    api['updateQueue'].mockClear();
    c.cambiarBandera('q-ti', 'confidential', false, false);
    expect(api['updateQueue']).not.toHaveBeenCalled();
  });

  it('⛔ NEGATIVA — un mínimo que no es entero de 1 a 1000 no viaja y se avisa', async () => {
    await render();
    for (const malo of ['0', '-3', '1001', '2.5', 'abc', '']) {
      c.cambiarMinimo('q-rh', 5, malo);
      expect(api['updateQueue']).not.toHaveBeenCalled();
      expect(c.error()).toContain('entero entre 1 y 1000');
    }
  });

  it('⭐ un mínimo válido y distinto viaja; el mismo, no', async () => {
    await render();
    c.cambiarMinimo('q-rh', 5, '8');
    expect(api['updateQueue']).toHaveBeenCalledWith('q-rh', { report_min_cases: 8 });
    api['updateQueue'].mockClear();
    c.cambiarMinimo('q-rh', 5, '5');
    expect(api['updateQueue']).not.toHaveBeenCalled();
  });

  it('el mínimo de casos sólo se pide en la cola confidencial', async () => {
    await render();
    const minimos = Array.from(el().querySelectorAll('input.sc-min'));
    expect(minimos.length).toBe(1);
    expect((minimos[0] as HTMLInputElement).getAttribute('aria-label')).toContain('Recursos Humanos');
  });

  it('una cola sin prioridad NO ofrece «Prioridad sugerida por»; la que sí la usa, sí', async () => {
    await render();
    const colas = Array.from(el().querySelectorAll('.sc-queue')) as HTMLElement[];
    const de = (nombre: string) => colas.find((q) => q.querySelector('.sc-qhead b')?.textContent?.trim() === nombre) as HTMLElement;
    expect(de('TI').textContent).toContain('Prioridad sugerida por');
    expect(de('Recursos Humanos').textContent).not.toContain('Prioridad sugerida por');
  });
});
