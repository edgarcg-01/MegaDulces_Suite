import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.7.7]` Qué se pregunta al reportar lo dicta el MODELO de la cola (`priority_model`), no su nombre. Lo que se defiende:
 *  · una cola de impacto pregunta lo de siempre (a cuántas personas afecta + me impide trabajar) y NO manda el riesgo;
 *  · una cola de riesgo pregunta «¿hay riesgo para personas?» y «¿detiene la operación?» — y NO el impacto;
 *  · ⛔ en una cola de riesgo no se puede enviar SIN contestar si hay riesgo: «no hay riesgo» no se adivina por omisión;
 *  · lo que viaja al servidor es lo que se preguntó.
 */
const CATALOGO: SdCatalogResponse = {
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI', priority_model: 'impacto', asks_zone: false },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'riesgo_operacion', asks_zone: true },
  ],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false },
    { id: 'c-mto', queue_id: 'q-mto', code: 'plomeria', name: 'Plomería', default_priority: 'media', requires_branch: false },
  ],
  zones: [],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};

describe('[MS.7.7] ServicioSolicitudesComponent — qué se pregunta según el modelo de la cola', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';

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

  it('⭐ una cola de IMPACTO pregunta lo de siempre y no pregunta el riesgo', async () => {
    await render();
    elegir('c-ti');
    expect(c.modeloRiesgo()).toBe(false);
    expect(texto()).toContain('¿A cuántas personas afecta?');
    expect(texto()).toContain('Me impide trabajar');
    expect(texto()).not.toContain('¿Hay riesgo para personas?');
  });

  it('⭐ una cola de RIESGO pregunta el riesgo y si detiene la operación, y NO el impacto', async () => {
    await render();
    elegir('c-mto');
    expect(c.modeloRiesgo()).toBe(true);
    expect(texto()).toContain('¿Hay riesgo para personas?');
    expect(texto()).toContain('¿Detiene la operación?');
    expect(texto()).not.toContain('¿A cuántas personas afecta?');
  });

  it('cambiar de categoría cambia las preguntas (la cola manda, no la pantalla)', async () => {
    await render();
    elegir('c-mto');
    elegir('c-ti');
    expect(texto()).toContain('¿A cuántas personas afecta?');
    expect(texto()).not.toContain('¿Hay riesgo para personas?');
  });

  it('⛔ NEGATIVA — en una cola de riesgo NO se puede enviar sin contestar si hay riesgo (no se adivina «no hay riesgo»)', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Fuga en el baño';
    expect(c.form.safety_risk).toBeNull();
    expect(c.puedeEnviar()).toBe(false);
    c.form.safety_risk = false; // «No» es una respuesta; «sin contestar» no
    expect(c.puedeEnviar()).toBe(true);
    c.form.safety_risk = true;
    expect(c.puedeEnviar()).toBe(true);
  });

  it('CONTROL: en una cola de impacto el riesgo NO se exige para enviar', async () => {
    await render();
    elegir('c-ti');
    c.form.title = 'Reporte lento';
    expect(c.form.safety_risk).toBeNull();
    expect(c.puedeEnviar()).toBe(true);
  });

  it('⭐ lo que viaja es lo que se preguntó: en riesgo manda safety_risk y detiene la operación (impacto fijo en «yo»)', async () => {
    await render();
    elegir('c-mto');
    c.form.title = 'Cortocircuito en la bodega';
    c.form.safety_risk = true;
    c.form.blocks_work = true;
    c.form.impact = 'red'; // aunque hubiera quedado un impacto de otra categoría, no viaja
    const dto = await enviar();
    expect(dto).toMatchObject({ category_id: 'c-mto', safety_risk: true, blocks_work: true, impact: 'yo' });
    expect(dto).not.toHaveProperty('priority');
  });

  it('⛔ y en una cola de impacto NO viaja el riesgo (aunque el formulario lo traiga de antes)', async () => {
    await render();
    elegir('c-mto');
    c.form.safety_risk = true;
    elegir('c-ti');
    c.form.title = 'Reporte lento';
    c.form.impact = 'sucursal';
    const dto = await enviar();
    expect(dto['safety_risk']).toBeUndefined();
    expect(dto).toMatchObject({ category_id: 'c-ti', impact: 'sucursal' });
  });
});
