import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdConfigResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.7.4]` Campos propios por cola. Lo que se defiende:
 *  · el formulario pide los campos de la cola de la categoría elegida (y no los de otra);
 *  · ⛔ un campo OBLIGATORIO sin contestar no deja enviar — «No» cuenta como respuesta, un texto en blanco no;
 *  · la foto obligatoria exige un archivo (no un valor);
 *  · lo que viaja es sólo lo contestado de la cola elegida; cambiar de categoría descarta lo de la otra;
 *  · la configuración deriva el código de la pregunta, valida las opciones y manda sólo lo que cambió.
 */
const CATALOGO: SdCatalogResponse = {
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI', priority_model: 'impacto', asks_zone: false, default_assignee_id: null, default_assignee_name: null },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'impacto', asks_zone: false, default_assignee_id: null, default_assignee_name: null },
  ],
  zones: [],
  fields: [
    { code: 'afecta', queue_id: 'q-mto', label: '¿Afecta a clientes?', type: 'boolean', required: true, options: [] },
    { code: 'tipo_falla', queue_id: 'q-mto', label: 'Tipo de falla', type: 'select', required: false, options: ['Eléctrica', 'Hidráulica'] },
    { code: 'equipo', queue_id: 'q-mto', label: 'Equipo', type: 'text', required: true, options: [] },
    { code: 'foto', queue_id: 'q-mto', label: 'Foto de la falla', type: 'photo', required: true, options: [] },
  ],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false },
    { id: 'c-mto', queue_id: 'q-mto', code: 'plomeria', name: 'Plomería', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};

describe('[MS.7.4] formulario — los campos propios de la cola', () => {
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
  const enviar = async () => { c.enviar(); await vi.waitFor(() => expect(api.create).toHaveBeenCalled()); return api.create.mock.calls[api.create.mock.calls.length - 1][0] as Record<string, unknown>; };
  const archivo = () => new File(['x'], 'falla.png', { type: 'image/png' });

  afterEach(() => TestBed.resetTestingModule());

  it('⭐ pide los campos de la cola de la categoría elegida, y una cola sin campos no pide nada', async () => {
    await render();
    elegir('c-mto');
    expect(c.camposCola().map((f) => f.code)).toEqual(['afecta', 'tipo_falla', 'equipo', 'foto']);
    expect(texto()).toContain('¿Afecta a clientes?');
    expect(texto()).toContain('Tipo de falla');
    elegir('c-ti');
    expect(c.camposCola()).toEqual([]);
    expect(texto()).not.toContain('¿Afecta a clientes?');
  });

  it('⛔ NEGATIVA — un campo obligatorio sin contestar no deja enviar (sí/no, texto y foto)', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Fuga';
    expect(c.puedeEnviar()).toBe(false);
    c.extraForm['afecta'] = false; // «No» es una respuesta
    expect(c.puedeEnviar()).toBe(false); // falta el texto
    c.extraForm['equipo'] = '   '; // en blanco no cuenta
    expect(c.puedeEnviar()).toBe(false);
    c.extraForm['equipo'] = 'Compresor';
    expect(c.puedeEnviar()).toBe(false); // falta la foto obligatoria
    expect(c.fotoRequerida()?.label).toBe('Foto de la falla');
    c.archivos.set([archivo()]);
    expect(c.puedeEnviar()).toBe(true);
  });

  it('CONTROL: en una cola sin campos obligatorios se envía como siempre', async () => {
    await render();
    elegir('c-ti');
    c.form.title = 'Reporte lento';
    expect(c.puedeEnviar()).toBe(true);
    expect(c.fotoRequerida()).toBeNull();
  });

  it('⭐ lo que viaja es sólo lo contestado: «No» viaja, lo opcional vacío no, y la foto no va en `extra`', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Fuga';
    c.extraForm['afecta'] = false;
    c.extraForm['equipo'] = '  Compresor 2  ';
    c.archivos.set([archivo()]);
    const dto = await enviar();
    expect(dto['extra']).toEqual({ afecta: false, equipo: 'Compresor 2' });
  });

  it('⛔ al cambiar de categoría a otra cola, lo contestado de la anterior NO viaja', async () => {
    await render();
    elegir('c-mto');
    c.extraForm['afecta'] = true;
    c.extraForm['equipo'] = 'X';
    elegir('c-ti');
    c.form.title = 'Reporte lento';
    const dto = await enviar();
    expect(dto['extra']).toBeUndefined();
  });
});

describe('[MS.7.4] configuración — los campos propios de la cola', () => {
  const CFG: SdConfigResponse = {
    settings: {
      business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
      auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
    },
    policies: [],
    queues: [{ id: 'q1', code: 'mantenimiento', name: 'Mantenimiento', department_code: null, active: true, sort_order: 10, priority_model: 'riesgo_operacion', asks_zone: true, default_assignee_id: null, default_assignee_name: null }],
    zones: [],
    categories: [],
    fields: [
      { id: 'f1', queue_id: 'q1', code: 'afecta', label: '¿Afecta a clientes?', type: 'boolean', required: true, options: [], sort_order: 10, active: true },
      { id: 'f2', queue_id: 'q1', code: 'tipo_falla', label: 'Tipo de falla', type: 'select', required: false, options: ['Eléctrica', 'Hidráulica'], sort_order: 20, active: false },
    ],
  };
  let fix: ComponentFixture<ServicioConfiguracionComponent>;
  let c: ServicioConfiguracionComponent;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [] })),
      agents: vi.fn(() => of([])),
      createField: vi.fn(() => of(CFG)),
      updateField: vi.fn(() => of(CFG)),
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

  it('lista los campos de la cola (también el apagado) con su tipo y estado', async () => {
    await render();
    const t = (fix.nativeElement as HTMLElement).textContent ?? '';
    expect(t).toContain('¿Afecta a clientes?');
    expect(t).toContain('Tipo de falla');
    expect(t).toContain('Eléctrica, Hidráulica');
    expect(c.camposDe('q1')).toHaveLength(2);
    expect(c.camposDe('otra-cola')).toHaveLength(0);
  });

  it('el código se deriva de la pregunta: sin acentos, minúsculas y guion bajo', () => {
    TestBed.configureTestingModule({ imports: [ServicioConfiguracionComponent], providers: [{ provide: ServiceDeskService, useValue: { config: () => NEVER, routing: () => NEVER, agents: () => NEVER } }] });
    const x = TestBed.createComponent(ServicioConfiguracionComponent).componentInstance;
    expect(x.codigoDe('¿Afecta a clientes?')).toBe('afecta_a_clientes');
    expect(x.codigoDe('Tipo de falla')).toBe('tipo_de_falla');
    expect(x.codigoDe('3 fases')).toBe('c_3_fases'); // debe empezar con letra
    expect(/^[a-z][a-z0-9_]{0,29}$/.test(x.codigoDe('a'.repeat(60)))).toBe(true);
  });

  it('⛔ NEGATIVA — no se puede agregar sin pregunta, ni un «opciones» con una sola opción o repetidas', async () => {
    await render();
    const f = c.campoForm('q1');
    expect(c.campoValido('q1')).toBe(false); // sin pregunta
    f.label = 'Tipo';
    expect(c.campoValido('q1')).toBe(true); // sí/no por defecto
    f.type = 'select';
    f.options = 'sola';
    expect(c.campoValido('q1')).toBe(false);
    f.options = 'A, A';
    expect(c.campoValido('q1')).toBe(false);
    f.options = 'A, B';
    expect(c.campoValido('q1')).toBe(true);
    c.agregarCampo('q1');
    expect(api['createField']).toHaveBeenCalledWith('q1', { code: 'tipo', label: 'Tipo', type: 'select', required: false, options: ['A', 'B'] });
  });

  it('un campo que no es de opciones no manda lista; apagar/obligatoria mandan sólo lo que cambió', async () => {
    await render();
    const f = c.campoForm('q1');
    f.label = 'Equipo';
    f.type = 'text';
    f.options = 'basura';
    c.agregarCampo('q1');
    expect(api['createField']).toHaveBeenCalledWith('q1', { code: 'equipo', label: 'Equipo', type: 'text', required: false, options: undefined });
    c.alternarCampo('f1', true);
    expect(api['updateField']).toHaveBeenCalledWith('f1', { active: false });
    c.cambiarRequerido('f1', true, false);
    expect(api['updateField']).toHaveBeenCalledWith('f1', { required: false });
    c.cambiarRequerido('f1', true, true); // sin cambio → no llama
    expect(api['updateField']).toHaveBeenCalledTimes(2);
  });
});
