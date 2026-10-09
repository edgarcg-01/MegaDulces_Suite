import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdConfigResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.7.3]` Zonas: el LUGAR dentro de la ubicación. Lo que se defiende:
 *  · el formulario ofrece la zona SÓLO si la cola de la categoría la pregunta (`asks_zone`), no por su nombre;
 *  · la zona es opcional: sin elegirla se puede enviar;
 *  · ⛔ en una cola que NO la pregunta la zona no viaja, aunque el formulario la traiga de antes;
 *  · la configuración lista las zonas (también las apagadas), valida el código antes de agregar y apagar/encender no borra.
 */
const CATALOGO: SdCatalogResponse = {
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'riesgo_operacion', asks_zone: true, confidential: false, uses_priority: true, sla_enabled: true },
  ],
  zones: [{ code: 'bodega', name: 'Bodega' }, { code: 'anden', name: 'Andén' }],
  fields: [],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false },
    { id: 'c-mto', queue_id: 'q-mto', code: 'plomeria', name: 'Plomería', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};

describe('[MS.7.3] formulario — la zona la pregunta la cola', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render() {
    api = {
      mine: vi.fn(() => of({ rows: [], total: 0 })),
      catalog: vi.fn(() => of(CATALOGO)),
      create: vi.fn(() => of({ id: 'nuevo' })),
      detail: vi.fn(() => NEVER),
    };
    await TestBed.configureTestingModule({
      imports: [ServicioSolicitudesComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: new BehaviorSubject(convertToParamMap({})).asObservable() } },
        { provide: Router, useValue: { navigate: vi.fn(() => Promise.resolve(true)) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioSolicitudesComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    c.nueva();
    fix.detectChanges();
  }
  const elegir = (id: string) => { c.elegirCategoria(id); fix.detectChanges(); };
  const enviar = async () => { c.enviar(); await new Promise((r) => setTimeout(r)); return api.create.mock.calls[api.create.mock.calls.length - 1][0] as Record<string, unknown>; };

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ una cola que pregunta la zona la ofrece; una que no, no', async () => {
    await render();
    elegir('c-mto');
    expect(c.preguntaZona()).toBe(true);
    expect(texto()).toContain('Zona (opcional)');
    elegir('c-ti');
    expect(c.preguntaZona()).toBe(false);
    expect(texto()).not.toContain('Zona (opcional)');
  });

  it('la zona es opcional: sin elegirla se puede enviar y no viaja nada', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Fuga';
    c.form.safety_risk = false;
    expect(c.puedeEnviar()).toBe(true);
    const dto = await enviar();
    expect(dto['zone_code']).toBeNull();
  });

  it('⭐ elegida la zona, viaja su código', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Fuga';
    c.form.safety_risk = false;
    c.form.zone_code = 'bodega';
    expect((await enviar())['zone_code']).toBe('bodega');
  });

  it('⛔ NEGATIVA — en una cola que no la pregunta la zona NO viaja, aunque el formulario la traiga de antes', async () => {
    await render();
    elegir('c-mto');
    c.form.zone_code = 'anden';
    elegir('c-ti');
    c.form.title = 'Reporte lento';
    const dto = await enviar();
    expect(dto['zone_code']).toBeUndefined();
  });
});

describe('[MS.7.3] configuración — la tarjeta Zonas', () => {
  const CFG: SdConfigResponse = {
    settings: {
      business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
      auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
    },
    policies: [],
    queues: [{ id: 'q1', code: 'ti', name: 'TI', department_code: null, active: true, sort_order: 10, priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true, default_assignee_id: null, default_assignee_name: null, report_min_cases: 5 }],
    zones: [
      { id: 'z1', code: 'bodega', name: 'Bodega', sort_order: 10, active: true },
      { id: 'z2', code: 'anden', name: 'Andén', sort_order: 20, active: false },
    ],
    categories: [],
    fields: [],
  };
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      createZone: vi.fn(() => of(CFG)),
      updateZone: vi.fn(() => of(CFG)),
      updateQueue: vi.fn(() => of(CFG)),
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

  it('lista las zonas, también la apagada, con su estado', async () => {
    await render();
    const filas = (fix.nativeElement as HTMLElement).querySelectorAll('section[aria-labelledby="h-zonas"] tbody tr');
    expect(filas.length).toBe(2);
    expect(filas[0].textContent).toContain('Activa');
    expect(filas[1].textContent).toContain('Apagada');
  });

  it('⛔ NEGATIVA — el código mal formado no deja agregar la zona', async () => {
    await render();
    c.zonaNueva = { name: 'Patio', code: 'Patio Maniobras' };
    expect(c.zonaValida()).toBe(false);
    c.agregarZona();
    expect(api['createZone']).not.toHaveBeenCalled();
    c.zonaNueva = { name: 'Patio', code: 'patio_maniobras' };
    expect(c.zonaValida()).toBe(true);
    c.agregarZona();
    expect(api['createZone']).toHaveBeenCalledWith({ name: 'Patio', code: 'patio_maniobras' });
  });

  it('apagar/encender manda sólo active (no borra) y encender la pregunta de zona en una cola manda asks_zone', async () => {
    await render();
    c.alternarZona('z1', true);
    expect(api['updateZone']).toHaveBeenCalledWith('z1', { active: false });
    c.alternarZona('z2', false);
    expect(api['updateZone']).toHaveBeenCalledWith('z2', { active: true });
    c.cambiarPreguntaZona('q1', false, true);
    expect(api['updateQueue']).toHaveBeenCalledWith('q1', { asks_zone: true });
    c.cambiarPreguntaZona('q1', true, true); // sin cambio → no llama
    expect(api['updateQueue']).toHaveBeenCalledTimes(1);
  });
});
