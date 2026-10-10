import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MSH.3]` «Nueva solicitud» hacia un área CONFIDENCIAL sin prioridad (RH). Lo que se defiende:
 *  · ⛔ se avisa ANTES de escribir que será confidencial, con quién la verá y quién no — y sólo en esa área;
 *  · ⛔ no se pregunta impacto, bloqueo ni riesgo (no hay prioridad a la que aplicarlos) y no se promete que «el sistema propone la prioridad»;
 *  · lo enviado no lleva un «Me impide trabajar» arrastrado de otra área;
 *  · TI sigue exactamente igual (control).
 */
const CATALOGO: SdCatalogResponse = {
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-rh', code: 'rh', name: 'Recursos Humanos', priority_model: 'impacto', asks_zone: false, confidential: true, uses_priority: false, sla_enabled: false },
  ],
  zones: [],
  fields: [],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'caja', name: 'Caja', default_priority: 'media', requires_branch: false },
    { id: 'c-rh', queue_id: 'q-rh', code: 'queja', name: 'Queja', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};

describe('[MSH.3] ServicioSolicitudesComponent — área confidencial', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render() {
    api = { mine: vi.fn(() => of({ rows: [], total: 0 })), catalog: vi.fn(() => of(CATALOGO)), create: vi.fn(() => of({ id: 'n' })), detail: vi.fn(() => NEVER) };
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
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ al elegir RH aparece el aviso de confidencialidad con el nombre del área', async () => {
    await render();
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    fix.detectChanges();
    expect(c.confidencial()).toBe(true);
    expect(texto()).toContain('Esta solicitud será confidencial');
    expect(texto()).toContain('equipo de Recursos Humanos');
    expect(texto()).toContain('no verá su contenido');
  });

  it('⛔ NEGATIVA — en RH no se pregunta impacto, bloqueo ni la promesa de prioridad', async () => {
    await render();
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    fix.detectChanges();
    expect(c.usaPrioridad()).toBe(false);
    expect(texto()).not.toContain('¿A cuántas personas afecta?');
    expect(texto()).not.toContain('Me impide trabajar');
    expect(texto()).not.toContain('¿Hay riesgo para personas?');
    expect(texto()).not.toContain('La prioridad la propone el sistema');
  });

  it('⭐ CONTROL — TI conserva sus preguntas y NO muestra el aviso confidencial', async () => {
    await render();
    c.elegirArea('q-ti');
    c.elegirCategoria('c-ti');
    fix.detectChanges();
    expect(c.confidencial()).toBe(false);
    expect(c.usaPrioridad()).toBe(true);
    expect(texto()).not.toContain('será confidencial');
    expect(texto()).toContain('¿A cuántas personas afecta?');
    expect(texto()).toContain('Me impide trabajar');
    expect(texto()).toContain('La prioridad la propone el sistema');
  });

  it('⛔ lo enviado a RH no arrastra un «Me impide trabajar» marcado antes en otra área', async () => {
    await render();
    c.elegirArea('q-ti');
    c.elegirCategoria('c-ti');
    c.form.blocks_work = true;
    c.form.impact = 'red';
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    c.form.title = 'Una queja';
    c.enviar();
    await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
    const dto = api.create.mock.calls[0][0];
    expect(dto.blocks_work).toBe(false);
    expect(dto.impact).toBe('yo');
  });

  it('⭐ y se puede enviar sin responder nada de prioridad', async () => {
    await render();
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    c.form.title = 'Una queja';
    expect(c.puedeEnviar()).toBe(true);
  });
});
