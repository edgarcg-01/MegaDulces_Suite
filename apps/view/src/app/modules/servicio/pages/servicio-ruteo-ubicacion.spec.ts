import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdConfigResponse, SdQueueMemberDto, SdRoutingRuleDto } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { SdQueueMembersComponent } from '../sd-queue-members.component';
import { ServicioConfiguracionComponent } from './servicio-configuracion.component';

/**
 * `[MS.7.10]` Ruteo por ubicación y responsable por omisión. Lo que se defiende:
 *  · una regla puede disparar SÓLO por ubicación (antes necesitaba categoría o palabras) y manda la ubicación al guardar;
 *  · una regla sin categoría, palabras NI ubicación sigue sin poderse guardar;
 *  · la lista dice la ubicación de cada regla;
 *  · el responsable por omisión se elige sólo entre MIEMBROS que pueden atender, y manda `null` para quitarlo;
 *  · lo que el servidor rechaza se muestra con su razón y no avisa de un éxito que no hubo.
 */
const CFG: SdConfigResponse = {
  settings: {
    business_days: [1, 2, 3, 4, 5, 6], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City',
    auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8, unassigned_alert_minutes: 60,
  },
  policies: [],
  queues: [{ id: 'q1', code: 'mantenimiento', name: 'Mantenimiento', department_code: null, active: true, sort_order: 10, priority_model: 'riesgo_operacion', asks_zone: true, default_assignee_id: null, default_assignee_name: null }],
  zones: [], fields: [], categories: [],
};
const REGLA_UBIC: SdRoutingRuleDto = {
  id: 'r1', name: 'Todo lo de Oficinas', keywords: [], category_id: null, category_name: null, warehouse_code: 'OF', warehouse_name: 'Oficinas Corporativas',
  assignee_id: 'u-pedro', assignee_name: 'Pedro', assignee_username: 'pedro', assignee_ok: true, sort_order: 10, active: true,
};

describe('[MS.7.10] configuración — reglas con ubicación', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let fix: ReturnType<typeof TestBed.createComponent<ServicioConfiguracionComponent>>;
  let c: ServicioConfiguracionComponent;

  async function render() {
    api = {
      config: vi.fn(() => of(CFG)),
      routing: vi.fn(() => of({ rules: [REGLA_UBIC] })),
      agents: vi.fn(() => of([])),
      createRouting: vi.fn(() => of({ rules: [REGLA_UBIC] })),
      updateRouting: vi.fn(() => of({ rules: [REGLA_UBIC] })),
    };
    await TestBed.configureTestingModule({ imports: [ServicioConfiguracionComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(ServicioConfiguracionComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ la lista dice la ubicación de la regla', async () => {
    await render();
    expect((fix.nativeElement as HTMLElement).textContent).toContain('Oficinas Corporativas');
  });

  it('⭐ una regla sólo por UBICACIÓN ya es válida y la ubicación viaja', async () => {
    await render();
    c.formRegla = { name: ' Oficinas ', assignee_id: 'u-pedro', category_id: null, warehouse_code: 'OF', sort_order: 20, keywords: '' };
    expect(c.reglaValida()).toBe(true);
    c.guardarRegla();
    expect(api['createRouting']).toHaveBeenCalledWith({ name: 'Oficinas', assignee_id: 'u-pedro', category_id: null, warehouse_code: 'OF', sort_order: 20, keywords: [] });
  });

  it('⛔ NEGATIVA — sin categoría, palabras NI ubicación NO es válida', async () => {
    await render();
    c.formRegla = { name: 'x', assignee_id: 'u-pedro', category_id: null, warehouse_code: null, sort_order: 20, keywords: ' , ' };
    expect(c.reglaValida()).toBe(false);
  });

  it('editar una regla rellena también su ubicación', async () => {
    await render();
    c.editarRegla(REGLA_UBIC);
    expect(c.formRegla.warehouse_code).toBe('OF');
    expect(c.ubicaciones.some((u) => u.code === 'OF')).toBe(true);
    expect(c.ubicaciones.some((u) => u.code === 'EC')).toBe(true);
  });
});

describe('[MS.7.10] miembros — responsable por omisión', () => {
  const COORD: SdQueueMemberDto = { user_id: 'u-coord', username: 'ubaldo', name: 'Ubaldo', role: 'coordinador', can_attend: true, can_coordinate: true };
  const TEC: SdQueueMemberDto = { user_id: 'u-tec', username: 'tec1', name: 'Técnico', role: 'tecnico', can_attend: true, can_coordinate: false };
  const FUERA: SdQueueMemberDto = { user_id: 'u-off', username: 'exagente', name: null, role: 'tecnico', can_attend: false, can_coordinate: false };

  async function render(opts: { puede?: boolean; actual?: string | null; updateQueue?: ReturnType<typeof vi.fn> } = {}) {
    const api = {
      queueMembers: vi.fn(() => of({ queue_id: 'q-1', members: [COORD, TEC, FUERA], can_manage: opts.puede ?? true })),
      queueCandidates: vi.fn(() => of([])),
      updateQueue: opts.updateQueue ?? vi.fn(() => of(CFG)),
    };
    await TestBed.configureTestingModule({ imports: [SdQueueMembersComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    const fix = TestBed.createComponent(SdQueueMembersComponent);
    fix.componentRef.setInput('queueId', 'q-1');
    fix.componentRef.setInput('defaultAssigneeId', opts.actual ?? null);
    const c = fix.componentInstance;
    const emitido: SdConfigResponse[] = [];
    c.configChange.subscribe((x) => emitido.push(x));
    fix.detectChanges();
    c.alternar();
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return { fix, c, api, emitido };
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ sólo se ofrece a MIEMBROS que pueden atender (no a quien perdió el permiso)', async () => {
    const { c } = await render();
    expect(c.opcionesResponsable().map((o) => o.user_id)).toEqual(['u-coord', 'u-tec']);
  });

  it('⭐ elegir a alguien lo manda al servidor y devuelve la configuración nueva', async () => {
    const { c, api, emitido } = await render();
    c.cambiarResponsable('u-tec');
    expect(api.updateQueue).toHaveBeenCalledWith('q-1', { default_assignee_id: 'u-tec' });
    expect(emitido).toHaveLength(1);
    expect(c.aviso()).toContain('Responsable por omisión');
  });

  it('quitarlo manda null y lo dice (lo sin regla queda «Sin asignar»)', async () => {
    const { c, api } = await render({ actual: 'u-tec' });
    c.cambiarResponsable(null);
    expect(api.updateQueue).toHaveBeenCalledWith('q-1', { default_assignee_id: null });
    expect(c.aviso()).toContain('Sin asignar');
  });

  it('elegir al que ya está no llama al servidor', async () => {
    const { c, api } = await render({ actual: 'u-tec' });
    c.cambiarResponsable('u-tec');
    expect(api.updateQueue).not.toHaveBeenCalled();
  });

  it('⛔ si el servidor lo rechaza se muestra SU razón y no hay aviso de éxito', async () => {
    const rechaza = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 400, error: { message: 'El responsable por omisión debe ser un miembro de esta cola que pueda atender solicitudes' } })));
    const { c, emitido } = await render({ updateQueue: rechaza });
    c.cambiarResponsable('u-coord');
    expect(c.error()).toContain('debe ser un miembro de esta cola');
    expect(c.aviso()).toBeNull();
    expect(emitido).toHaveLength(0);
  });

  it('sin permiso de administrar sólo se LEE: dice quién es y no ofrece el selector', async () => {
    const { fix } = await render({ puede: false, actual: 'u-tec' });
    const t = (fix.nativeElement as HTMLElement).textContent ?? '';
    expect(t).toContain('Responsable por omisión');
    expect(t).toContain('Técnico');
    expect((fix.nativeElement as HTMLElement).querySelector('.qm-default')).toBeNull();
  });
});
