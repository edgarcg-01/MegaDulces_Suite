import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse, SdRequestDetail, SdRequestRow, SdStatsResponse, SdStatus, SdTransferResult } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { SdRequestDetailComponent } from '../sd-request-detail.component';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioBandejaComponent } from './servicio-bandeja.component';

/**
 * `[MS.7.16]` La bandeja y la ficha por cola. Lo que se defiende:
 *  · el selector de área aparece sólo si la persona lee MÁS de una cola, y ofrece sólo las que el servidor dice;
 *  · elegir una cola la manda al servidor (`queue_id`) y «Limpiar» la quita;
 *  · las filas llevan la etiqueta de su área (cuando hay varias) y el motivo de la espera;
 *  · ⭐ «Transferir a otra área»: sólo la coordinación, no con lo resuelto, ofrece sólo áreas con categorías y NO la actual,
 *    pide categoría y motivo, y lo que viaja es lo elegido;
 *  · tras trasladar la ficha se CIERRA y la bandeja lo dice (quien traslada ya no ve el ticket);
 *  · lo que el servidor rechaza se muestra con su razón.
 */
const STATS = (queues: { id: string; name: string }[]): SdStatsResponse => ({ open_total: 1, unassigned: 1, first_response_breached: 0, resolution_breached: 0, by_status: {}, by_priority: {}, queues });
const FILA = (over: Partial<SdRequestRow> = {}): SdRequestRow => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q-mto', queue_name: 'Mantenimiento', category_id: 'c', category_name: 'Plomería', title: 'Fuga', priority: 'alta',
  priority_suggested: 'alta', impact: 'yo', blocks_work: false, pause_reason: null, status: 'nuevo', requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null,
  zone_code: null, zone_name: null, assigned_to: null, assigned_to_name: null, assigned_at: null, created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null }, ...over,
} as unknown as SdRequestRow);

describe('[MS.7.16] bandeja — por cola', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>;
  let c: ServicioBandejaComponent;
  let fix: ReturnType<typeof TestBed.createComponent<ServicioBandejaComponent>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(colas: { id: string; name: string }[], rows: SdRequestRow[] = [FILA()]) {
    api = {
      inbox: vi.fn(() => of({ rows, total: rows.length })),
      stats: vi.fn(() => of(STATS(colas))),
      catalog: vi.fn(() => NEVER),
      agents: vi.fn(() => NEVER),
      detail: vi.fn(() => NEVER),
    };
    await TestBed.configureTestingModule({
      imports: [ServicioBandejaComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => false } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: new BehaviorSubject(convertToParamMap({})).asObservable() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioBandejaComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ con UNA sola cola no hay selector de área ni etiqueta en las filas (TI como siempre)', async () => {
    await render([{ id: 'q-ti', name: 'TI' }], [FILA({ queue_name: 'TI' })]);
    expect(c.hayVariasColas()).toBe(false);
    expect((fix.nativeElement as HTMLElement).querySelector('p-select[ariaLabel="Filtrar por área"]')).toBeNull();
    expect(texto()).not.toContain('TI ·');
  });

  it('⭐ con varias colas ofrece SÓLO las que el servidor dijo y etiqueta cada fila con su área', async () => {
    await render([{ id: 'q-ti', name: 'TI' }, { id: 'q-mto', name: 'Mantenimiento' }]);
    expect(c.hayVariasColas()).toBe(true);
    expect(c.colas().map((q) => q.name)).toEqual(['TI', 'Mantenimiento']);
    expect(texto()).toContain('Mantenimiento · Plomería');
  });

  it('⭐ elegir una cola la manda al servidor; sin elegir no manda `queue_id`; «Limpiar» la quita', async () => {
    await render([{ id: 'q-ti', name: 'TI' }, { id: 'q-mto', name: 'Mantenimiento' }]);
    expect(c.consulta().queue_id).toBeUndefined();
    c.setCola('q-mto');
    expect(api['inbox']).toHaveBeenLastCalledWith(expect.objectContaining({ queue_id: 'q-mto' }));
    expect(c.hayFiltros()).toBe(true);
    c.limpiar();
    expect(c.cola()).toBeNull();
    expect(api['inbox']).toHaveBeenLastCalledWith(expect.not.objectContaining({ queue_id: 'q-mto' }));
  });

  it('la fila de un ticket en espera dice qué se espera', async () => {
    await render([{ id: 'q-ti', name: 'TI' }], [FILA({ status: 'en_espera', pause_reason: 'refaccion', queue_name: 'TI' })]);
    expect(texto()).toContain('Esperando una refacción');
  });

  it('⭐ tras un traslado la ficha se cierra, se refresca y se dice a dónde fue', async () => {
    await render([{ id: 'q-ti', name: 'TI' }, { id: 'q-mto', name: 'Mantenimiento' }]);
    c.abrir('t1');
    const res: SdTransferResult = { id: 't1', folio: 'SRV-2026-00001', queue_id: 'q-mto', queue_name: 'Mantenimiento', category_name: 'Plomería', status: 'nuevo' };
    const antes = api['inbox'].mock.calls.length;
    c.alTrasladar(res);
    fix.detectChanges();
    expect(c.selId()).toBeNull();
    expect(api['inbox'].mock.calls.length).toBe(antes + 1);
    expect(texto()).toContain('SRV-2026-00001 se trasladó a Mantenimiento');
  });
});

describe('[MS.7.16] ficha — Transferir a otra área', () => {
  const CAT: SdCatalogResponse = {
    queues: [
      { id: 'q-ti', code: 'ti', name: 'TI', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
      { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'impacto', asks_zone: true, confidential: false, uses_priority: true, sla_enabled: true },
      { id: 'q-vacia', code: 'vacia', name: 'Sin categorías', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    ],
    zones: [], fields: [],
    categories: [
      { id: 'c-ti', queue_id: 'q-ti', code: 'a', name: 'Caja', default_priority: 'media', requires_branch: false },
      { id: 'c-mto', queue_id: 'q-mto', code: 'b', name: 'Plomería', default_priority: 'media', requires_branch: false },
    ],
    impacts: ['yo', 'varios', 'sucursal', 'red'],
  };
  const T = (status: SdStatus): SdRequestDetail => ({
    id: 't1', folio: 'SRV-2026-00001', queue_id: 'q-ti', queue_name: 'TI', category_id: 'c-ti', category_name: 'Caja', title: 'No abre', priority: 'alta', priority_suggested: 'alta',
    impact: 'yo', blocks_work: false, pause_reason: null, status, requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null, zone_code: null, zone_name: null,
    assigned_to: null, assigned_to_name: null, assigned_at: null, created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
    sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null },
    description: '', requester_department_code: null, requester_position_code: null, channel: 'web', resolved_at: null, resolution_note: null, closed_at: null, close_reason: null, reopened_count: 0,
    messages: [{ id: 'm1', kind: 'transfer', visibility: 'public', author_id: 'u2', author_label: 'Ubaldo', body: 'Es de infraestructura', meta: { from_queue: 'TI', to_queue: 'Mantenimiento' }, created_at: '2026-10-02T15:10:00.000Z' }],
    attachments: [], time_logged_minutes: 0, time_entries: [],
  } as unknown as SdRequestDetail);

  let api: Record<string, ReturnType<typeof vi.fn>>;
  let c: SdRequestDetailComponent;
  let fix: ReturnType<typeof TestBed.createComponent<SdRequestDetailComponent>>;
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(status: SdStatus, coord: boolean, transfer?: ReturnType<typeof vi.fn>) {
    api = { detail: vi.fn(() => of(T(status))), catalog: vi.fn(() => of(CAT)), transfer: transfer ?? vi.fn(() => of({ id: 't1', folio: 'SRV-2026-00001', queue_id: 'q-mto', queue_name: 'Mantenimiento', category_name: 'Plomería', status: 'nuevo' } as SdTransferResult)), agents: vi.fn(() => of([])) };
    await TestBed.configureTestingModule({ imports: [SdRequestDetailComponent], providers: [{ provide: ServiceDeskService, useValue: api }] }).compileComponents();
    fix = TestBed.createComponent(SdRequestDetailComponent);
    fix.componentRef.setInput('id', 't1');
    fix.componentRef.setInput('agent', true);
    fix.componentRef.setInput('coord', coord);
    const emitidos: SdTransferResult[] = [];
    fix.componentInstance.trasladada.subscribe((x) => emitidos.push(x));
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    c = fix.componentInstance;
    return emitidos;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ sólo la coordinación lo ve, y no con lo resuelto o cerrado', async () => {
    await render('en_proceso', true);
    expect(c.puedeTransferir()).toBe(true);
    TestBed.resetTestingModule();
    await render('en_proceso', false);
    expect(c.puedeTransferir()).toBe(false);
    TestBed.resetTestingModule();
    for (const s of ['resuelto', 'cerrado', 'cancelado'] as SdStatus[]) {
      await render(s, true);
      expect(c.puedeTransferir()).toBe(false);
      TestBed.resetTestingModule();
    }
  });

  it('⭐ el BOTÓN está en el DOM para quien coordina y atiende, y no para quien sólo coordina el formulario de otra persona', async () => {
    await render('en_proceso', true);
    const botones = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(botones).toContain('Transferir a otra área');
    TestBed.resetTestingModule();
    await render('en_proceso', false);
    expect(Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent?.trim())).not.toContain('Transferir a otra área');
    TestBed.resetTestingModule();
    await render('resuelto', true);
    expect(Array.from((fix.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent?.trim())).not.toContain('Transferir a otra área');
  });

  it('⭐ ofrece sólo áreas con categorías y NO la actual; las categorías son las del área elegida', async () => {
    await render('nuevo', true);
    c.pedirTraslado();
    expect(api['catalog']).toHaveBeenCalledTimes(1);
    expect(c.areasDestino().map((a) => a.name)).toEqual(['Mantenimiento']); // ni TI (actual) ni la que no tiene categorías
    expect(c.categoriasDestino()).toEqual([]);
    c.elegirDestino('q-mto');
    expect(c.categoriasDestino().map((k) => k.name)).toEqual(['Plomería']);
  });

  it('⛔ NEGATIVA — sin área, categoría y motivo no se manda nada', async () => {
    await render('nuevo', true);
    c.pedirTraslado();
    c.ejecutarModo();
    expect(api['transfer']).not.toHaveBeenCalled();
    c.elegirDestino('q-mto');
    c.destinoCategoria.set('c-mto');
    c.ejecutarModo(); // falta el motivo
    expect(api['transfer']).not.toHaveBeenCalled();
  });

  it('⭐ con todo, manda lo elegido y avisa a la bandeja (la ficha ya no es suya)', async () => {
    const emitidos = await render('en_proceso', true);
    c.pedirTraslado();
    c.elegirDestino('q-mto');
    c.destinoCategoria.set('c-mto');
    c.notaModo.set('  Es una fuga, no de sistemas  ');
    c.ejecutarModo();
    expect(api['transfer']).toHaveBeenCalledWith('t1', { queue_id: 'q-mto', category_id: 'c-mto', reason: 'Es una fuga, no de sistemas' });
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0].queue_name).toBe('Mantenimiento');
    expect(c.modo()).toBeNull();
  });

  it('⛔ cambiar de área descarta la categoría elegida (era de otra); volver a elegir la misma no', async () => {
    await render('nuevo', true);
    c.pedirTraslado();
    c.elegirDestino('q-mto');
    c.destinoCategoria.set('c-mto');
    c.elegirDestino('q-mto');
    expect(c.destinoCategoria()).toBe('c-mto');
    c.elegirDestino('q-vacia');
    expect(c.destinoCategoria()).toBeNull();
  });

  it('⛔ si el servidor lo rechaza (409: nadie atiende esa área) se muestra SU razón y no se emite nada', async () => {
    const rechaza = vi.fn(() => throwError(() => new HttpErrorResponse({ status: 409, error: { message: 'Nadie atiende hoy esa área: la solicitud quedaría sin que nadie la vea.' } })));
    const emitidos = await render('nuevo', true, rechaza);
    c.pedirTraslado();
    c.elegirDestino('q-mto');
    c.destinoCategoria.set('c-mto');
    c.notaModo.set('x');
    c.ejecutarModo();
    expect(c.error()).toContain('Nadie atiende hoy esa área');
    expect(emitidos).toHaveLength(0);
  });

  it('el hilo lee el traslado como frase (de→a y el motivo) y la ficha dice la cola', async () => {
    await render('nuevo', true);
    expect(texto()).toContain('Trasladada de TI a Mantenimiento · Es de infraestructura');
    expect(texto()).toContain('Cola'); // la ficha ya dice en qué cola está (y por tanto en qué área)
  });
});
