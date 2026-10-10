import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import type { SdRequestDetail, SdStatus } from '@megadulces/contracts';
import { ServiceDeskService } from './service-desk.service';
import { SdRequestDetailComponent } from './sd-request-detail.component';

/**
 * `[MSH.3]` La ficha de un ticket CONFIDENCIAL. Lo que se defiende:
 *  · ⛔ en VISTA LIMITADA (administrador) no se pinta nada del contenido ni acción alguna: sólo folio, área, estado y fechas;
 *  · ⛔ en un área sin prioridad (`priority: null`) no hay chip de prioridad, ni «Afecta», ni selector para cambiarla;
 *  · quien sí es del equipo ve la ficha completa con la marca «Confidencial»;
 *  · un ticket normal queda como siempre (control).
 *
 * (Lo de abajo es el encabezado heredado de `[MS.3.3]`.) `[MS.3.3]` La ficha. Lo que se defiende:
 *  · quien REPORTA ve «Cerrar» / «Sigue fallando» sólo cuando está resuelto, y NUNCA los botones de atención;
 *  · quien ATIENDE ve «Tomar» sólo en un ticket nuevo, y el menú de estados que le corresponde;
 *  · resolver y reabrir EXIGEN nota (el botón no se habilita sin ella);
 *  · una nota interna SÍ admite archivos (`[MS.3.13]`), y la pantalla avisa que tampoco los ve quien reportó;
 *  · lo que el servidor rechaza se muestra con su razón, no como un fallo genérico.
 */

const t = (status: SdStatus, over: Partial<SdRequestDetail> = {}): SdRequestDetail => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q', queue_name: 'TI', category_id: 'c', category_name: 'Sistema de caja',
  title: 'No abre la caja', priority: 'alta', priority_suggested: 'alta', impact: 'sucursal', blocks_work: true, pause_reason: null, is_test: false, status,
  requester_id: 'u1', requester_name: 'Ana', warehouse_code: '02', warehouse_name: 'La Piedad Abastos', zone_code: null, zone_name: null,
  assigned_to: status === 'nuevo' ? null : 'u2', assigned_to_name: status === 'nuevo' ? null : 'Jorge', assigned_at: null,
  created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
  description: 'Sale un error', requester_department_code: null, requester_position_code: null, channel: 'web',
  resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
  messages: [
    { id: 'm1', kind: 'system', visibility: 'public', author_id: 'u1', author_label: 'Ana', body: 'Solicitud creada', meta: {}, created_at: '2026-10-02T15:00:00.000Z' },
    { id: 'm2', kind: 'internal_note', visibility: 'internal', author_id: 'u2', author_label: 'Jorge', body: 'Parece el usuario bloqueado', meta: {}, created_at: '2026-10-02T15:05:00.000Z' },
  ],
  attachments: [], time_logged_minutes: 0, time_entries: [], ...over,
});

function makeApi(initial: SdRequestDetail) {
  return {
    detail: vi.fn(() => of(initial)),
    take: vi.fn(() => of(t('asignado'))),
    status: vi.fn((_id: string, b: { status: SdStatus }) => of(t(b.status))),
    confirm: vi.fn(() => of(t('cerrado'))),
    reopen: vi.fn(() => of(t('en_proceso'))),
    cancel: vi.fn(() => of(t('cancelado'))),
    assign: vi.fn(() => of(t('asignado'))),
    priority: vi.fn(() => of(t('asignado'))),
    logTime: vi.fn(() => of(t('asignado'))),
    message: vi.fn(() => of(t('asignado'))),
    agents: vi.fn(() => of([])),
  };
}

describe('[MSH.3] SdRequestDetailComponent — confidencial', () => {
  let fix: ComponentFixture<SdRequestDetailComponent>;
  const el = () => fix.nativeElement as HTMLElement;
  const texto = () => el().textContent ?? '';
  const botones = () => Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');

  async function render(over: Partial<SdRequestDetail>, agent = true, coord = true) {
    const api = makeApi(t('en_proceso', over));
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 't1');
    fix.componentRef.setInput('agent', agent);
    fix.componentRef.setInput('coord', coord);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  const LIMITADA: Partial<SdRequestDetail> = {
    basic: true, confidential: true, title: '', description: '', category_id: '', category_name: null, requester_id: '', requester_name: null,
    assigned_to: null, assigned_to_name: null, priority: null, priority_suggested: null, messages: [], attachments: [], time_logged_minutes: null, time_entries: null,
  };

  it('⭐ la vista limitada muestra el folio, el área, el estado y la nota de por qué es limitada', async () => {
    await render(LIMITADA);
    expect(texto()).toContain('SRV-2026-00001');
    expect(texto()).toContain('Solicitud confidencial');
    expect(texto()).toContain('Vista limitada');
    expect(texto()).toContain('En proceso');
    expect(texto()).toContain('Área');
  });

  it('⛔ NEGATIVA — la vista limitada NO pinta contenido ni acciones (ni hilo, ni Reportó, ni Atiende, ni botones de atención)', async () => {
    await render({ ...LIMITADA, title: 'texto que no debería verse' });
    const x = texto();
    expect(x).not.toContain('texto que no debería verse');
    expect(x).not.toContain('Reportó');
    expect(x).not.toContain('Atiende');
    expect(x).not.toContain('Seguimiento');
    expect(x).not.toContain('Afecta');
    expect(botones().filter((b) => b)).toEqual([]); // sólo el botón de cerrar (sin texto)
  });

  it('⛔ NEGATIVA — un área sin prioridad (completa, para el equipo) no pinta chip, «Afecta» ni el selector de prioridad', async () => {
    await render({ confidential: true, priority: null, priority_suggested: null });
    expect(texto()).toContain('Confidencial');
    expect(texto()).not.toContain('Afecta');
    expect(el().querySelector('.sd-pri')).toBeNull();
    expect(el().querySelector('[ariaLabel="Cambiar prioridad"], p-select[ariaLabel="Cambiar prioridad"]')).toBeNull();
    expect(texto()).not.toContain('Aplicar prioridad');
    expect(texto()).toContain('Seguimiento'); // pero SÍ ve el hilo: es del equipo
  });

  it('⭐ CONTROL — un ticket normal conserva su chip de prioridad, «Afecta» y el hilo', async () => {
    await render({});
    expect(el().querySelector('.sd-pri')?.textContent?.trim()).toBe('Alta');
    expect(texto()).toContain('Afecta');
    expect(texto()).toContain('Seguimiento');
    expect(texto()).not.toContain('Confidencial');
  });
});
