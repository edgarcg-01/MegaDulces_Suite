import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdRequestDetail, SdRequestRow, SdStatsResponse, SdStatus } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { SdRequestDetailComponent } from '../sd-request-detail.component';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioBandejaComponent } from './servicio-bandeja.component';

/**
 * `[MS.7.12]` Tickets de prueba en pantalla. Lo que se defiende:
 *  · el botón existe sólo para la coordinación, dice lo que va a hacer según el estado actual y está en el DOM;
 *  · confirmar manda lo CONTRARIO de lo que el ticket es hoy (marcar ↔ quitar) y el motivo opcional, recortado;
 *  · el motivo es opcional (no bloquea) y el diálogo explica qué deja de contar;
 *  · el ticket de prueba lleva su etiqueta en la ficha y en la bandeja;
 *  · lo que el servidor rechaza se muestra con su razón.
 */
const T = (status: SdStatus, is_test: boolean): SdRequestDetail => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q', queue_name: 'TI', category_id: 'c', category_name: 'Caja', title: 'Prueba de tickets', priority: 'media', priority_suggested: 'media',
  impact: 'yo', blocks_work: false, pause_reason: null, is_test, status, requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null, zone_code: null, zone_name: null,
  assigned_to: null, assigned_to_name: null, assigned_at: null, created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
  description: '', requester_department_code: null, requester_position_code: null, channel: 'web', resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
  messages: [], attachments: [], time_logged_minutes: 0, time_entries: [],
} as unknown as SdRequestDetail);

describe('[MS.7.12] ficha — marcar como prueba', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let c: SdRequestDetailComponent;
  let fix: ReturnType<typeof TestBed.createComponent<SdRequestDetailComponent>>;
  const dom = () => fix.nativeElement as HTMLElement;
  const botones = () => Array.from(dom().querySelectorAll('button')).map((b) => b.textContent?.trim());

  async function render(inicial: SdRequestDetail, coord: boolean, markTest?: ReturnType<typeof vi.fn>) {
    api = {
      detail: vi.fn(() => of(inicial)),
      markTest: markTest ?? vi.fn((_id: string, b: { is_test: boolean }) => of(T('nuevo', b.is_test))),
      agents: vi.fn(() => of([])),
    };
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 't1');
    fix.componentRef.setInput('agent', true);
    fix.componentRef.setInput('coord', coord);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    c = fix.componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el botón está en el DOM sólo para la coordinación, y dice lo que va a hacer según el estado', async () => {
    await render(T('nuevo', false), true);
    expect(botones()).toContain('Marcar como prueba');
    TestBed.resetTestingModule();
    await render(T('nuevo', true), true);
    expect(botones()).toContain('Quitar marca de prueba');
    expect(botones()).not.toContain('Marcar como prueba');
    TestBed.resetTestingModule();
    await render(T('nuevo', false), false);
    expect(botones()).not.toContain('Marcar como prueba');
  });

  it('⭐ sirve también con lo CERRADO o cancelado (el caso típico: «era de prueba» ya cerrado) y manda lo mismo', async () => {
    for (const s of ['cerrado', 'cancelado'] as SdStatus[]) {
      await render(T(s, false), true);
      expect(botones()).toContain('Marcar como prueba');
      c.modo.set('prueba');
      fix.detectChanges();
      expect(dom().textContent).toContain('NO cuenta en reportes, tablero');
      c.ejecutarModo();
      expect(api['markTest']).toHaveBeenCalledWith('t1', { is_test: true, reason: undefined });
      TestBed.resetTestingModule();
    }
  });

  it('⛔ y en un ticket final, sin ser coordinación, NO aparece el botón', async () => {
    await render(T('cerrado', false), false);
    expect(botones()).not.toContain('Marcar como prueba');
  });

  it('⭐ confirmar manda lo CONTRARIO de lo que es hoy, con el motivo recortado', async () => {
    await render(T('nuevo', false), true);
    c.modo.set('prueba');
    c.notaModo.set('  prueba del flujo  ');
    c.ejecutarModo();
    expect(api['markTest']).toHaveBeenCalledWith('t1', { is_test: true, reason: 'prueba del flujo' });
    TestBed.resetTestingModule();
    await render(T('nuevo', true), true);
    c.modo.set('prueba');
    c.ejecutarModo();
    expect(api['markTest']).toHaveBeenCalledWith('t1', { is_test: false, reason: undefined });
  });

  it('el motivo es opcional: el diálogo no bloquea el botón Confirmar sin escribirlo', async () => {
    await render(T('nuevo', false), true);
    c.modo.set('prueba');
    fix.detectChanges();
    expect(c.nota_obligatoria()).toBe(false);
    const confirmar = Array.from(dom().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Confirmar') as HTMLButtonElement | undefined;
    expect(confirmar?.disabled).toBe(false);
  });

  it('el diálogo explica qué deja de contar (para que nadie lo marque a ciegas)', async () => {
    await render(T('nuevo', false), true);
    c.modo.set('prueba');
    fix.detectChanges();
    const t = dom().textContent ?? '';
    expect(t).toContain('NO cuenta en reportes, tablero');
    TestBed.resetTestingModule();
    await render(T('nuevo', true), true);
    c.modo.set('prueba');
    fix.detectChanges();
    expect(dom().textContent).toContain('vuelve a contar');
  });

  it('el ticket de prueba lleva su etiqueta en la ficha; el normal no', async () => {
    await render(T('nuevo', true), true);
    expect(dom().querySelector('.sd-test')?.textContent).toContain('Prueba');
    TestBed.resetTestingModule();
    await render(T('nuevo', false), true);
    expect(dom().querySelector('.sd-test')).toBeNull();
  });

  it('⛔ si el servidor lo rechaza (409: ya estaba marcada) se muestra SU razón', async () => {
    const rechaza = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'La solicitud ya está marcada como de prueba' } })));
    await render(T('nuevo', false), true, rechaza);
    c.modo.set('prueba');
    c.ejecutarModo();
    expect(c.error()).toContain('ya está marcada como de prueba');
  });
});

describe('[MS.7.12] bandeja — la etiqueta de prueba', () => {
  it('⭐ el ticket de prueba se ve en la lista con su etiqueta y el normal no', async () => {
    const fila = (id: string, is_test: boolean) => ({
      id, folio: `SRV-${id}`, queue_id: 'q', queue_name: 'TI', category_id: 'c', category_name: 'Caja', title: `Ticket ${id}`, priority: 'media', priority_suggested: 'media', impact: 'yo',
      blocks_work: false, pause_reason: null, is_test, status: 'nuevo', requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null, zone_code: null, zone_name: null,
      assigned_to: null, assigned_to_name: null, assigned_at: null, created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
      sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
    }) as unknown as SdRequestRow;
    const stats: SdStatsResponse = { open_total: 2, unassigned: 2, first_response_breached: 0, resolution_breached: 0, by_status: {}, by_priority: {}, queues: [{ id: 'q', name: 'TI' }] };
    const api = { inbox: vi.fn(() => of({ rows: [fila('a', true), fila('b', false)], total: 2 })), stats: vi.fn(() => of(stats)), catalog: vi.fn(() => NEVER), agents: vi.fn(() => NEVER), detail: vi.fn(() => NEVER) };
    await TestBed.configureTestingModule({
      imports: [ServicioBandejaComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => false } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: new BehaviorSubject(convertToParamMap({})).asObservable() } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ServicioBandejaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const filas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('tbody tr'));
    expect(filas[0].querySelector('.prueba')).not.toBeNull();
    expect(filas[1].querySelector('.prueba')).toBeNull();
    TestBed.resetTestingModule();
  });
});
