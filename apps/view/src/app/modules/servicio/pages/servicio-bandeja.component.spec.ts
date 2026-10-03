import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioBandejaComponent } from './servicio-bandeja.component';

/**
 * `[MS.3.6]` La bandeja entiende de dónde viene el enlace. Lo que se defiende:
 *  · `?scope=mine` (el renglón «A tu nombre» de Mi trabajo) abre en «Mías», no en «Sin asignar», que es lo que quiere ver
 *    quien reparte y no quien viene a trabajar lo que ya le dieron;
 *  · un alcance inventado se IGNORA: la bandeja abre como siempre en vez de pedirle al servidor algo que respondería 400;
 *  · el alcance se fija antes de la primera carga — una sola petición, no «Sin asignar» y luego «Mías» en carrera;
 *  · estando ya en la bandeja, un enlace nuevo (cambia sólo el parámetro; Angular reutiliza el componente) la mueve;
 *  · `?id=` (la campana) sigue abriendo esa ficha.
 */
describe('[MS.3.6] ServicioBandejaComponent — ?scope= e ?id=', () => {
  let fix: ComponentFixture<ServicioBandejaComponent>;
  let c: ServicioBandejaComponent;
  let params$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let api: { inbox: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };

  async function render(query: Record<string, string> = {}) {
    params$ = new BehaviorSubject(convertToParamMap(query));
    api = {
      inbox: vi.fn(() => of({ rows: [], total: 0 })),
      stats: vi.fn(() => NEVER),
      detail: vi.fn(() => NEVER), // la ficha embebida pide su ticket; aquí no importa qué responda
    };
    await TestBed.configureTestingModule({
      imports: [ServicioBandejaComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => false } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) }, queryParamMap: params$.asObservable() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioBandejaComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  const alcancesPedidos = () => api.inbox.mock.calls.map((a) => (a[0] as { scope: string }).scope);

  afterEach(() => TestBed.resetTestingModule());

  it('sin parámetros abre en «Sin asignar»', async () => {
    await render();
    expect(c.scope()).toBe('unassigned');
    expect(alcancesPedidos()).toEqual(['unassigned']);
  });

  it('⭐ ?scope=mine abre en «Mías» con UNA sola petición (no «Sin asignar» y luego «Mías»)', async () => {
    await render({ scope: 'mine' });
    expect(c.scope()).toBe('mine');
    expect(alcancesPedidos()).toEqual(['mine']);
  });

  it('un alcance inventado se ignora: abre como siempre y no se lo pide al servidor', async () => {
    await render({ scope: 'todo-lo-del-mundo' });
    expect(c.scope()).toBe('unassigned');
    expect(alcancesPedidos()).toEqual(['unassigned']);
  });

  it('⭐ ya dentro de la bandeja, un enlace nuevo con otro alcance la mueve', async () => {
    await render();
    params$.next(convertToParamMap({ scope: 'waiting' }));
    await fix.whenStable();
    expect(c.scope()).toBe('waiting');
    expect(alcancesPedidos()).toEqual(['unassigned', 'waiting']);
  });

  it('el mismo alcance dos veces no recarga (no hay parpadeo al pulsar el enlace estando ya ahí)', async () => {
    await render({ scope: 'mine' });
    params$.next(convertToParamMap({ scope: 'mine' }));
    await fix.whenStable();
    expect(alcancesPedidos()).toEqual(['mine']);
  });

  it('?id= abre esa ficha (el aviso de la campana)', async () => {
    await render({ id: 'abc-123' });
    expect(c.selId()).toBe('abc-123');
    expect(c.scope()).toBe('unassigned');
  });
});
