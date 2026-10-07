import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse, SdSlaPolicyDto } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MS.7.2]` Los plazos por cola en la pantalla de configuración. Lo que se defiende:
 *  · en el ámbito GENERAL se editan las 4 generales y no se ofrece «volver al general»;
 *  · en el ámbito de una cola, la prioridad con plazo propio sale «propio» y la que no, «heredado» con los números generales;
 *  · guardar en una cola manda `queue_id` (nace el plazo propio), y guardar en lo general NO lo manda;
 *  · «Volver al general» sólo aparece donde hay plazo propio y borra ESE plazo, no otro.
 */
const gen = (priority: SdSlaPolicyDto['priority'], first: number, res: number, clock: SdSlaPolicyDto['clock'] = 'business'): SdSlaPolicyDto => ({ queue_id: null, priority, first_response_minutes: first, resolution_minutes: res, clock });
const CFG: SdConfigResponse = {
  settings: {
    business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [
    gen('baja', 480, 3360), gen('media', 240, 1440), gen('alta', 120, 480), gen('urgente', 30, 240, 'calendar'),
    // Mantenimiento cambió sólo la urgente y la media.
    { queue_id: 'q-mto', priority: 'media', first_response_minutes: 480, resolution_minutes: 1440, clock: 'business' },
    { queue_id: 'q-mto', priority: 'urgente', first_response_minutes: 60, resolution_minutes: 240, clock: 'business' },
  ],
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', department_code: null, active: true, sort_order: 10, priority_model: 'impacto', asks_zone: false },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', department_code: null, active: false, sort_order: 20, priority_model: 'riesgo_operacion', asks_zone: true },
  ],
  categories: [],
  zones: [],
};

describe('[MS.7.2] ServicioConfiguracionComponent — plazos por cola', () => {
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;
  const el = () => fix.nativeElement as HTMLElement;
  const filas = () => Array.from(el().querySelectorAll('section[aria-labelledby="h-sla"] tbody tr'));

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      updatePolicy: vi.fn(() => of(CFG)),
      updateQueue: vi.fn(() => of(CFG)),
      removeQueuePolicy: vi.fn(() => of(CFG)),
    };
    await TestBed.configureTestingModule({
      imports: [ServicioConfiguracionComponent],
      providers: [{ provide: ServiceDeskService, useValue: api }],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioConfiguracionComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ por omisión muestra los plazos GENERALES, sin marcas de «propio/heredado» ni «Volver al general»', async () => {
    await render();
    expect(c.ambito()).toBeNull();
    expect(c.pol.map((p) => p.priority)).toEqual(['baja', 'media', 'alta', 'urgente']);
    expect(filas().length).toBe(4);
    expect(el().querySelector('.sc-tag')).toBeNull();
    expect(el().textContent).not.toContain('Volver al general');
  });

  it('⛔ las filas por cola NO se cuelan en la tabla general (4 filas, no 6)', async () => {
    await render();
    expect(c.pol.length).toBe(4);
    expect(c.pol.find((p) => p.priority === 'urgente')?.clock).toBe('calendar'); // la general, no la de Mantenimiento
  });

  it('⭐ en una cola: lo que cambió sale «propio» con SUS números y lo demás «heredado» con los generales', async () => {
    await render();
    c.elegirAmbito('q-mto');
    fix.detectChanges();
    const por = Object.fromEntries(c.pol.map((p) => [p.priority, p]));
    expect(por['urgente']).toMatchObject({ first_response_minutes: 60, resolution_minutes: 240, clock: 'business', propia: true });
    expect(por['media'].propia).toBe(true);
    expect(por['alta']).toMatchObject({ first_response_minutes: 120, resolution_minutes: 480, propia: false }); // hereda la general
    expect(por['baja']).toMatchObject({ first_response_minutes: 480, resolution_minutes: 3360, propia: false });
    const tags = Array.from(el().querySelectorAll('.sc-tag')).map((t) => t.textContent?.trim());
    expect(tags.filter((t) => t === 'propio').length).toBe(2);
    expect(tags.filter((t) => t === 'heredado').length).toBe(2);
  });

  it('⭐ guardar en una cola manda su queue_id; guardar en lo general NO lo manda', async () => {
    await render();
    c.guardarPolitica(c.pol.find((p) => p.priority === 'media')!);
    expect(api['updatePolicy'].mock.calls[0][2]).toBeNull();
    c.elegirAmbito('q-mto');
    c.guardarPolitica(c.pol.find((p) => p.priority === 'alta')!); // una heredada: al guardarla nace el plazo propio
    expect(api['updatePolicy'].mock.calls[1][0]).toBe('alta');
    expect(api['updatePolicy'].mock.calls[1][2]).toBe('q-mto');
  });

  it('⭐ «Volver al general» sólo aparece donde hay plazo propio, y borra ESE plazo', async () => {
    await render();
    c.elegirAmbito('q-mto');
    fix.detectChanges();
    const botones = Array.from(el().querySelectorAll('section[aria-labelledby="h-sla"] button')).filter((b) => b.textContent?.includes('Volver al general'));
    expect(botones.length).toBe(2); // media y urgente; alta y baja heredan, no hay nada que borrar
    c.heredarGeneral(c.pol.find((p) => p.priority === 'urgente')!);
    expect(api['removeQueuePolicy']).toHaveBeenCalledWith('urgente', 'q-mto');
  });

  it('⛔ en el ámbito general «Volver al general» no hace nada (no hay cola a la que devolver)', async () => {
    await render();
    c.heredarGeneral(c.pol[0]);
    expect(api['removeQueuePolicy']).not.toHaveBeenCalled();
  });

  it('el selector ofrece «General» primero y luego cada cola', async () => {
    await render();
    expect(c.ambitos().map((a) => a.name)).toEqual(['General (todas las colas)', 'TI (Sistemas)', 'Mantenimiento']);
  });

  it('volver al ámbito general restaura las filas generales (no se queda con las de la cola)', async () => {
    await render();
    c.elegirAmbito('q-mto');
    c.elegirAmbito(null);
    expect(c.pol.find((p) => p.priority === 'urgente')).toMatchObject({ clock: 'calendar', propia: false });
  });

  it('⭐ `[MS.7.7]` cambiar cómo se sugiere la prioridad de una cola manda el modelo elegido (por valor, no por nombre)', async () => {
    await render();
    c.cambiarModelo('q-ti', 'impacto', 'riesgo_operacion');
    expect(api['updateQueue']).toHaveBeenCalledWith('q-ti', { priority_model: 'riesgo_operacion' });
  });

  it('elegir el modelo que la cola ya tiene no llama al servidor', async () => {
    await render();
    c.cambiarModelo('q-mto', 'riesgo_operacion', 'riesgo_operacion');
    expect(api['updateQueue']).not.toHaveBeenCalled();
  });

  it('el selector de modelo ofrece sólo las dos matrices que el código sabe aplicar', async () => {
    await render();
    expect(c.modelos.map((m) => m.value)).toEqual(['impacto', 'riesgo_operacion']);
  });
});
