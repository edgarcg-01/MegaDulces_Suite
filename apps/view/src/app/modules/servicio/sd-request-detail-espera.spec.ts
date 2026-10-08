import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { SdPauseReason, SdRequestDetail, SdStatus } from '@megadulces/contracts';
import { ServiceDeskService } from './service-desk.service';
import { SdRequestDetailComponent } from './sd-request-detail.component';

/**
 * `[MS.7.9]` Poner en espera lleva el MOTIVO. Lo que se defiende:
 *  · ⛔ sin elegir qué se espera no se confirma (y no se manda nada al servidor);
 *  · lo que viaja es el estado, la nota y el motivo elegido;
 *  · con cualquier otro estado el motivo NO viaja;
 *  · la ficha dice qué se espera mientras el ticket está en espera.
 */
const t = (status: SdStatus, pause_reason: SdPauseReason | null = null): SdRequestDetail => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q', queue_name: 'Mantenimiento', category_id: 'c', category_name: 'Plomería',
  title: 'Fuga', priority: 'alta', priority_suggested: 'alta', impact: 'yo', blocks_work: false, pause_reason, status,
  requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null, zone_code: null, zone_name: null,
  assigned_to: 'u2', assigned_to_name: 'Ubaldo', assigned_at: null,
  created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: status === 'en_espera', first_breached: false, resolution_breached: false, used_ratio: null },
  description: '', requester_department_code: null, requester_position_code: null, channel: 'web',
  resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
  messages: [], attachments: [], time_logged_minutes: 0, time_entries: [],
} as unknown as SdRequestDetail);

describe('[MS.7.9] SdRequestDetailComponent — poner en espera con motivo', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let c: SdRequestDetailComponent;
  let fix: ReturnType<typeof TestBed.createComponent<SdRequestDetailComponent>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(inicial: SdRequestDetail) {
    api = { detail: vi.fn(() => of(inicial)), status: vi.fn((_id: string, b: { status: SdStatus }) => of(t(b.status))), agents: vi.fn(() => of([])) };
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 't1');
    fix.componentRef.setInput('agent', true);
    fix.componentRef.setInput('coord', false);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    c = fix.componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ NEGATIVA — sin elegir qué se espera NO se confirma ni se manda nada', async () => {
    await render(t('en_proceso'));
    c.pedirEstado('en_espera');
    fix.detectChanges();
    expect(texto()).toContain('¿Qué se espera?');
    c.ejecutarModo();
    expect(api['status']).not.toHaveBeenCalled();
  });

  it('⭐ con el motivo elegido viaja el estado, la nota y el motivo', async () => {
    await render(t('en_proceso'));
    c.pedirEstado('en_espera');
    c.motivoPausa.set('proveedor');
    c.notaModo.set('  Espero la pieza  ');
    c.ejecutarModo();
    expect(api['status']).toHaveBeenCalledWith('t1', { status: 'en_espera', note: 'Espero la pieza', pause_reason: 'proveedor' });
  });

  it('⛔ con otro estado (resolver) el motivo NO viaja, aunque haya quedado uno elegido', async () => {
    await render(t('en_proceso'));
    c.pedirEstado('en_espera');
    c.motivoPausa.set('refaccion');
    c.cerrarModo(); // volver limpia el motivo
    expect(c.motivoPausa()).toBeNull();
    c.pedirEstado('resuelto');
    c.notaModo.set('Listo');
    c.ejecutarModo();
    expect(api['status']).toHaveBeenCalledWith('t1', { status: 'resuelto', note: 'Listo', pause_reason: undefined });
  });

  it('la ficha dice qué se espera mientras está en espera, y no dice nada si no hay motivo', async () => {
    await render(t('en_espera', 'refaccion'));
    expect(texto()).toContain('Esperando una refacción');
    TestBed.resetTestingModule();
    await render(t('en_proceso'));
    expect(texto()).not.toContain('En espera');
  });
});
