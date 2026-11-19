import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdRequestDetail, SdStatus } from '@megadulces/contracts';
import { ServiceDeskService } from './service-desk.service';
import { SdRequestDetailComponent } from './sd-request-detail.component';

/**
 * `[MSP.3]` La ficha en un área como Presupuestos y Requerimientos. Lo que se defiende:
 *  · el dictamen se ve (también para quien reportó) con texto e icono, no sólo color; sin dictamen dice «Pendiente»;
 *  · ⛔ sin dictamen NO se ofrece «Marcar resuelta» (el servidor daría 409) y se explica por qué;
 *  · ⛔ sólo la coordinación ve «Autorizar» / «No autorizar»; el motivo es obligatorio para confirmar;
 *  · ⛔ «Generar orden de servicio» sólo con dictamen AUTORIZADO y la solicitud tomada; ofrece sólo las áreas de la lista de la cola;
 *  · ⛔ con Mantenimiento pide «¿hay riesgo?» antes de habilitar el envío;
 *  · las órdenes se listan con su folio, área y estado; una orden dice de qué solicitud viene;
 *  · CONTROL: un ticket de TI no muestra nada de esto.
 */

const t = (status: SdStatus, over: Partial<SdRequestDetail> = {}): SdRequestDetail => ({
  id: 'p1', folio: 'SRV-2026-00100', queue_id: 'qp', queue_name: 'Presupuestos y Requerimientos', category_id: 'cp', category_name: 'Gastos operativos',
  title: 'Cortina rota', priority: null, priority_suggested: null, impact: 'yo', blocks_work: false, pause_reason: null, is_test: false, status,
  requester_id: 'u1', requester_name: 'Encargada Centro', warehouse_code: '03', warehouse_name: '8 Esquinas', zone_code: null, zone_name: null,
  assigned_to: status === 'nuevo' ? null : 'ue', assigned_to_name: status === 'nuevo' ? null : 'Ernesto', assigned_at: null,
  created_at: '2026-11-18T15:00:00.000Z', updated_at: '2026-11-18T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
  description: 'No baja la cortina', requester_department_code: null, requester_position_code: 'encargado_sucursal', channel: 'web',
  resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
  messages: [], attachments: [], links: [], time_logged_minutes: 0, time_entries: [],
  decision: null, requires_decision: true, parent: null, work_orders: [], ...over,
});

const CATALOGO: SdCatalogResponse = {
  queues: [
    { id: 'qp', code: 'presupuestos', name: 'Presupuestos y Requerimientos', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: false, sla_enabled: false, requires_description: true, requires_decision: true, work_order_queue_codes: ['mantenimiento', 'ti'] },
    { id: 'qm', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'riesgo_operacion', asks_zone: true, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'qt', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'qc', code: 'compras', name: 'Compras', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
  ],
  categories: [
    { id: 'cm', queue_id: 'qm', code: 'cortinas', name: 'Cortinas', default_priority: 'media', requires_branch: false },
    { id: 'ct', queue_id: 'qt', code: 'equipo', name: 'Equipo', default_priority: 'media', requires_branch: false },
    { id: 'cc', queue_id: 'qc', code: 'precio', name: 'Precio', default_priority: 'media', requires_branch: false },
  ],
  zones: [], fields: [], impacts: ['yo', 'varios', 'sucursal', 'red'],
};

function makeApi(initial: SdRequestDetail) {
  return {
    detail: vi.fn(() => of(initial)),
    catalog: vi.fn(() => of(CATALOGO)),
    decision: vi.fn((_id: string, b: { decision: 'autorizado' | 'no_autorizado'; note: string }) => of(t('en_proceso', { decision: { decision: b.decision, note: b.note, decided_by_name: 'Ernesto', decided_at: '2026-11-18T16:00:00.000Z' } }))),
    workOrder: vi.fn(() => of(t('en_espera', { pause_reason: 'orden_servicio' }))),
    take: vi.fn(() => of(t('asignado'))),
    status: vi.fn((_id: string, b: { status: SdStatus }) => of(t(b.status))),
    agents: vi.fn(() => of([])),
  };
}

describe('[MSP.3] SdRequestDetailComponent — Presupuestos y Requerimientos', () => {
  let fix: ComponentFixture<SdRequestDetailComponent>;
  let api: ReturnType<typeof makeApi>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const boton = (label: string) => Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

  async function render(ticket: SdRequestDetail, agent = true, coord = true) {
    api = makeApi(ticket);
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 'p1');
    fix.componentRef.setInput('agent', agent);
    fix.componentRef.setInput('coord', coord);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ sin dictamen: dice «Pendiente», NO ofrece «Marcar resuelta» y explica por qué', async () => {
    await render(t('en_proceso'));
    expect(texto()).toContain('Dictamen');
    expect(texto()).toContain('Pendiente');
    expect(boton('Marcar resuelta')).toBeUndefined();
    expect(texto()).toContain('primero hace falta el dictamen');
  });

  it('⭐ CONTROL: con dictamen SÍ ofrece «Marcar resuelta», y el dictamen se lee con texto (no sólo color)', async () => {
    await render(t('en_proceso', { decision: { decision: 'no_autorizado', note: 'Sin presupuesto este mes', decided_by_name: 'Ernesto', decided_at: '2026-11-18T16:00:00.000Z' } }));
    expect(boton('Marcar resuelta')).toBeDefined();
    expect(texto()).toContain('No autorizado');
    expect(texto()).toContain('Sin presupuesto este mes');
    expect(texto()).toContain('Ernesto');
  });

  it('⭐ la coordinación autoriza: el motivo es obligatorio y se envía con la decisión', async () => {
    await render(t('en_proceso'));
    boton('Autorizar')!.click();
    fix.detectChanges();
    const confirmar = () => Array.from(el().querySelectorAll('.sd-modo button')).find((b) => b.textContent?.trim() === 'Autorizar') as HTMLButtonElement;
    expect(confirmar().disabled).toBe(true);
    fix.componentInstance.notaDictamen.set('Hay presupuesto en el rubro');
    fix.detectChanges();
    expect(confirmar().disabled).toBe(false);
    confirmar().click();
    expect(api.decision).toHaveBeenCalledWith('p1', { decision: 'autorizado', note: 'Hay presupuesto en el rubro' });
  });

  it('⛔ quien reportó ve el dictamen pero NO los botones para darlo ni para generar órdenes', async () => {
    await render(t('en_proceso', { decision: { decision: 'autorizado', note: 'ok', decided_by_name: 'Ernesto', decided_at: '2026-11-18T16:00:00.000Z' } }), false, false);
    expect(texto()).toContain('Autorizado');
    const conAutoriz = () => Array.from(el().querySelectorAll('button')).filter((b) => /autoriz/i.test(b.textContent ?? ''));
    expect(conAutoriz()).toEqual([]);
    expect(boton('Generar orden de servicio')).toBeUndefined();
    // Y sin dictamen todavía: tampoco se le ofrece darlo.
    TestBed.resetTestingModule();
    await render(t('en_proceso'), false, false);
    expect(texto()).toContain('Pendiente');
    expect(conAutoriz()).toEqual([]);
  });

  it('⛔ «Generar orden de servicio» NO aparece sin dictamen autorizado ni con la solicitud sin tomar', async () => {
    await render(t('en_proceso'));
    expect(boton('Generar orden de servicio')).toBeUndefined();
    TestBed.resetTestingModule();
    await render(t('en_proceso', { decision: { decision: 'no_autorizado', note: 'no', decided_by_name: 'E', decided_at: '2026-11-18T16:00:00.000Z' } }));
    expect(boton('Generar orden de servicio')).toBeUndefined();
    TestBed.resetTestingModule();
    await render(t('nuevo', { decision: { decision: 'autorizado', note: 'ok', decided_by_name: 'E', decided_at: '2026-11-18T16:00:00.000Z' } }));
    expect(boton('Generar orden de servicio')).toBeUndefined();
  });

  it('⭐ autorizada y tomada: ofrece SÓLO las áreas de la lista (no Compras), y Mantenimiento pide «¿hay riesgo?»', async () => {
    await render(t('en_proceso', { decision: { decision: 'autorizado', note: 'ok', decided_by_name: 'E', decided_at: '2026-11-18T16:00:00.000Z' } }));
    const c = fix.componentInstance;
    expect(boton('Generar orden de servicio')).toBeDefined();
    expect(c.areasOrden().map((q) => q.code).sort()).toEqual(['mantenimiento', 'ti']);
    boton('Generar orden de servicio')!.click();
    fix.detectChanges();
    c.elegirAreaOrden('qm');
    c.ordenCategoria.set('cm');
    c.ordenInstr.set('Cambiar la cortina');
    fix.detectChanges();
    expect(c.ordenPideRiesgo()).toBe(true);
    expect(c.ordenLista()).toBe(false); // falta contestar el riesgo
    c.ordenRiesgo.set(false);
    expect(c.ordenLista()).toBe(true);
    c.generarOrden();
    expect(api.workOrder).toHaveBeenCalledWith('p1', { queue_id: 'qm', category_id: 'cm', instructions: 'Cambiar la cortina', title: undefined, safety_risk: false });
  });

  it('CONTROL: a TI no pide riesgo', async () => {
    await render(t('en_proceso', { decision: { decision: 'autorizado', note: 'ok', decided_by_name: 'E', decided_at: '2026-11-18T16:00:00.000Z' } }));
    const c = fix.componentInstance;
    c.elegirAreaOrden('qt');
    c.ordenCategoria.set('ct');
    c.ordenInstr.set('Instalar equipo');
    expect(c.ordenPideRiesgo()).toBe(false);
    expect(c.ordenLista()).toBe(true);
  });

  it('⭐ lista las órdenes con folio, área y estado; con órdenes en marcha ya no se ofrece cambiar el dictamen', async () => {
    await render(t('en_espera', {
      pause_reason: 'orden_servicio',
      decision: { decision: 'autorizado', note: 'ok', decided_by_name: 'E', decided_at: '2026-11-18T16:00:00.000Z' },
      work_orders: [{ id: 'o1', folio: 'SRV-2026-00101', queue_name: 'Mantenimiento', category_name: 'Cortinas', status: 'en_proceso', assigned_to_name: 'Jorge', created_at: '2026-11-18T17:00:00.000Z', resolved_at: null, resolution_note: null }],
    }));
    expect(texto()).toContain('SRV-2026-00101');
    expect(texto()).toContain('Mantenimiento · Cortinas');
    expect(texto()).toContain('Atiende Jorge');
    expect(texto()).toContain('Esperando su orden de servicio');
    expect(boton('Cambiar a no autorizado')).toBeUndefined();
  });

  it('⭐ una orden dice de qué solicitud viene', async () => {
    await render(t('nuevo', { queue_name: 'Mantenimiento', requires_decision: false, parent: { id: 'p0', folio: 'SRV-2026-00099', queue_name: 'Presupuestos y Requerimientos' } }));
    expect(texto()).toContain('Viene de');
    expect(texto()).toContain('SRV-2026-00099');
  });

  it('⭐ CONTROL: un ticket de TI no muestra dictamen ni órdenes', async () => {
    await render(t('en_proceso', { queue_name: 'TI', requires_decision: false }));
    expect(texto()).not.toContain('Dictamen');
    expect(texto()).not.toContain('Órdenes de servicio');
    expect(boton('Marcar resuelta')).toBeDefined();
  });
});
