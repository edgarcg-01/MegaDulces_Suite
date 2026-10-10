import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdRequestRow, SdStatsResponse } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioBandejaComponent } from './servicio-bandeja.component';

/**
 * `[MSH.3]` La bandeja con tickets CONFIDENCIALES. Lo que se defiende:
 *  · ⛔ la fila en VISTA LIMITADA (administrador) se rotula «Solicitud confidencial» y NO muestra categoría, persona ni prioridad;
 *  · ⛔ un área sin prioridad no pinta chip de prioridad ni «Sin plazo»;
 *  · la marca «Confidencial» aparece en las filas que la traen;
 *  · una fila normal queda como siempre (control).
 */
const STATS = (queues: { id: string; name: string }[]): SdStatsResponse => ({ open_total: 1, unassigned: 1, first_response_breached: 0, resolution_breached: 0, by_status: {}, by_priority: {}, queues });
const FILA = (over: Partial<SdRequestRow> = {}): SdRequestRow => ({
  id: 't1', folio: 'SRV-2026-00001', queue_id: 'q-mto', queue_name: 'Mantenimiento', category_id: 'c', category_name: 'Plomería', title: 'Fuga', priority: 'alta',
  priority_suggested: 'alta', impact: 'yo', blocks_work: false, pause_reason: null, status: 'nuevo', requester_id: 'u1', requester_name: 'Ana', warehouse_code: null, warehouse_name: null,
  zone_code: null, zone_name: null, assigned_to: null, assigned_to_name: null, assigned_at: null, created_at: '2026-10-02T15:00:00.000Z', updated_at: '2026-10-02T15:00:00.000Z',
  sla: { first_response_due_at: null, due_at: null, first_responded_at: null, paused: false, first_breached: false, resolution_breached: false, used_ratio: null }, ...over,
} as unknown as SdRequestRow);

describe('[MSH.3] bandeja — confidencial', () => {
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

  const LIMITADA = FILA({ basic: true, confidential: true, title: '', category_name: null, requester_name: null, priority: null, priority_suggested: null, queue_name: 'Recursos Humanos' } as Partial<SdRequestRow>);

  it('⭐ la fila limitada se rotula neutra, con su folio y la marca de confidencial', async () => {
    await render([{ id: 'q-rh', name: 'Recursos Humanos' }], [LIMITADA]);
    expect(texto()).toContain('SRV-2026-00001');
    expect(texto()).toContain('Solicitud confidencial');
    expect(texto()).toContain('Confidencial');
  });

  it('⛔ NEGATIVA — la fila limitada no muestra prioridad ni plazo (sólo «—»), y no inventa categoría o persona', async () => {
    await render([{ id: 'q-rh', name: 'Recursos Humanos' }], [LIMITADA]);
    const fila = (fix.nativeElement as HTMLElement).querySelector('tbody tr') as HTMLElement;
    expect(fila.querySelector('.pri')).toBeNull();
    expect(fila.querySelector('.sin')).not.toBeNull();
    expect(fila.querySelector('.sla')?.textContent?.trim()).toBe('—');
    expect(fila.textContent).not.toContain('Sin plazo');
    expect(fila.textContent).not.toContain('Ana');
  });

  it('⛔ NEGATIVA — un área sin prioridad (fila completa, para el equipo) tampoco pinta chip de prioridad', async () => {
    await render([{ id: 'q-rh', name: 'Recursos Humanos' }], [FILA({ priority: null, confidential: true, title: 'Queja' } as Partial<SdRequestRow>)]);
    const fila = (fix.nativeElement as HTMLElement).querySelector('tbody tr') as HTMLElement;
    expect(fila.querySelector('.pri')).toBeNull();
    expect(fila.textContent).toContain('Queja');
    expect(fila.textContent).not.toContain('Sin plazo');
  });

  it('⭐ CONTROL — una fila normal conserva su chip de prioridad y no lleva la marca', async () => {
    await render([{ id: 'q-ti', name: 'TI' }], [FILA()]);
    const fila = (fix.nativeElement as HTMLElement).querySelector('tbody tr') as HTMLElement;
    expect(fila.querySelector('.pri')?.textContent?.trim()).toBe('Alta');
    expect(fila.textContent).not.toContain('Confidencial');
  });
});
