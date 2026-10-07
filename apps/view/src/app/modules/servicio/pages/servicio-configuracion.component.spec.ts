import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse, SdRoutingResponse, SdRoutingRuleDto } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MS.3.10]` La pantalla de reglas de asignación automática. Lo que se defiende:
 *  · una regla necesita nombre, persona Y (categoría o al menos una palabra) — si no, no se puede guardar;
 *  · las palabras se mandan como lista, sin vacíos, aunque se escriban con comas y espacios de más;
 *  · editar rellena el formulario y guardar ACTUALIZA (no crea otra); cancelar lo limpia;
 *  · la persona que no puede atender se MARCA (la regla la saltaría): no se esconde;
 *  · el selector sólo ofrece a quien puede atender.
 */
const CFG: SdConfigResponse = {
  settings: {
    business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [],
  queues: [{ id: 'q1', code: 'ti', name: 'TI', department_code: null, active: true, sort_order: 10 }],
  categories: [
    { id: 'c-dev', queue_id: 'q1', code: 'desarrollo', name: 'Desarrollo', default_priority: 'media', requires_branch: false, active: true, sort_order: 95 },
  ],
};

const REGLA_OK: SdRoutingRuleDto = {
  id: 'r1', name: 'Equipo de cómputo', keywords: ['cpu', 'impresora'], category_id: null, category_name: null,
  assignee_id: 'u-felipe', assignee_name: 'Felipe Galván', assignee_username: 'felipe_galvan', assignee_ok: true, sort_order: 10, active: true,
};
const REGLA_SIN_PERMISO: SdRoutingRuleDto = {
  ...REGLA_OK, id: 'r2', name: 'Desarrollo', keywords: [], category_id: 'c-dev', category_name: 'Desarrollo',
  assignee_id: 'u-david', assignee_name: 'David Cisneros', assignee_username: 'david_cisneros', assignee_ok: false, sort_order: 20,
};

describe('[MS.3.10] ServicioConfiguracionComponent — asignación automática', () => {
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  async function render(reglas: SdRoutingRuleDto[] = [REGLA_OK, REGLA_SIN_PERMISO]) {
    const resp = (rules: SdRoutingRuleDto[]): SdRoutingResponse => ({ rules });
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of(resp(reglas))),
      agents: vi.fn(() => of([{ user_id: 'u-felipe', username: 'felipe_galvan', name: 'Felipe Galván', open_count: 0 }])),
      createRouting: vi.fn(() => of(resp(reglas))),
      updateRouting: vi.fn(() => of(resp(reglas))),
      removeRouting: vi.fn(() => of(resp([]))),
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

  it('lista las reglas y MARCA a la persona que no puede atender', async () => {
    await render();
    const filas = (fix.nativeElement as HTMLElement).querySelectorAll('section[aria-labelledby="h-rut"] tbody tr');
    expect(filas.length).toBe(2);
    const t = (fix.nativeElement as HTMLElement).textContent ?? '';
    expect(t).toContain('Felipe Galván');
    expect(t).toContain('David Cisneros');
    const marcas = (fix.nativeElement as HTMLElement).querySelectorAll('section[aria-labelledby="h-rut"] .sc-off');
    expect(marcas.length).toBe(1);
    expect(marcas[0].textContent).toContain('no puede atender');
    expect(filas[1].textContent).toContain('no puede atender');
  });

  it('el selector de «Asigna a» ofrece SÓLO a quien puede atender', async () => {
    await render();
    expect(c.agentes()).toEqual([{ user_id: 'u-felipe', label: 'Felipe Galván' }]);
  });

  it('⛔ NEGATIVA — una regla sin nombre, sin persona o sin disparador NO es válida', async () => {
    await render();
    c.formRegla = { name: '', assignee_id: 'u-felipe', category_id: null, sort_order: 100, keywords: 'cpu' };
    expect(c.reglaValida()).toBe(false);
    c.formRegla = { name: 'x', assignee_id: null, category_id: null, sort_order: 100, keywords: 'cpu' };
    expect(c.reglaValida()).toBe(false);
    c.formRegla = { name: 'x', assignee_id: 'u-felipe', category_id: null, sort_order: 100, keywords: ' , ,  ' };
    expect(c.reglaValida()).toBe(false);
  });

  it('con una categoría basta, o con palabras: cualquiera de las dos la dispara', async () => {
    await render();
    c.formRegla = { name: 'x', assignee_id: 'u-felipe', category_id: 'c-dev', sort_order: 100, keywords: '' };
    expect(c.reglaValida()).toBe(true);
    c.formRegla = { name: 'x', assignee_id: 'u-felipe', category_id: null, sort_order: 100, keywords: 'cpu' };
    expect(c.reglaValida()).toBe(true);
  });

  it('⭐ guardar manda las palabras como lista, sin vacíos ni espacios de más', async () => {
    await render();
    c.formRegla = { name: '  Equipo  ', assignee_id: 'u-felipe', category_id: null, sort_order: 15, keywords: ' cpu , impresora,, sistemas ,' };
    c.guardarRegla();
    expect(api['createRouting']).toHaveBeenCalledWith({ name: 'Equipo', assignee_id: 'u-felipe', category_id: null, sort_order: 15, keywords: ['cpu', 'impresora', 'sistemas'] });
    expect(api['updateRouting']).not.toHaveBeenCalled();
    // y deja el formulario limpio
    expect(c.formRegla.name).toBe('');
    expect(c.editandoRegla()).toBeNull();
  });

  it('⭐ editar rellena el formulario y guardar ACTUALIZA esa regla (no crea otra)', async () => {
    await render();
    c.editarRegla(REGLA_OK);
    expect(c.editandoRegla()).toBe('r1');
    expect(c.formRegla.keywords).toBe('cpu, impresora');
    expect(c.formRegla.assignee_id).toBe('u-felipe');
    c.formRegla.keywords = 'cpu, impresora, laptop';
    c.guardarRegla();
    expect(api['updateRouting']).toHaveBeenCalledWith('r1', expect.objectContaining({ keywords: ['cpu', 'impresora', 'laptop'] }));
    expect(api['createRouting']).not.toHaveBeenCalled();
  });

  it('cancelar la edición limpia el formulario', async () => {
    await render();
    c.editarRegla(REGLA_OK);
    c.cancelarRegla();
    expect(c.editandoRegla()).toBeNull();
    expect(c.formRegla).toEqual({ name: '', assignee_id: null, category_id: null, sort_order: 100, keywords: '' });
  });

  it('apagar, cambiar el orden y retirar llaman a la API con lo que toca', async () => {
    await render();
    c.alternarRegla(REGLA_OK);
    expect(api['updateRouting']).toHaveBeenCalledWith('r1', { active: false });
    c.cambiarOrden(REGLA_OK, '5');
    expect(api['updateRouting']).toHaveBeenCalledWith('r1', { sort_order: 5 });
    c.retirarRegla(REGLA_OK);
    expect(api['removeRouting']).toHaveBeenCalledWith('r1');
  });

  it('⛔ NEGATIVA — un orden inválido o sin cambio NO llama a la API', async () => {
    await render();
    c.cambiarOrden(REGLA_OK, 'abc');
    c.cambiarOrden(REGLA_OK, '-3');
    c.cambiarOrden(REGLA_OK, '1.5');
    c.cambiarOrden(REGLA_OK, '10'); // el mismo que ya tiene
    expect(api['updateRouting']).not.toHaveBeenCalled();
  });

  it('sin reglas lo dice: toda solicitud nueva queda en «Sin asignar»', async () => {
    await render([]);
    expect((fix.nativeElement as HTMLElement).textContent).toContain('toda solicitud nueva queda en «Sin asignar»');
  });
});
