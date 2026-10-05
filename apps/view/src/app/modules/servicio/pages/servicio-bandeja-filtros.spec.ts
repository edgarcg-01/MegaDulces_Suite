import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { NEVER, Subject, of } from 'rxjs';
import { vi } from 'vitest';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioBandejaComponent } from './servicio-bandeja.component';

/**
 * `[MS.3.16]` Filtrar y ordenar la bandeja. Lo que se defiende:
 *  · cada filtro viaja al SERVIDOR con el nombre que éste entiende (no se filtran sólo las 100 filas que ya llegaron);
 *  · un clic en una columna ordena en el servidor, un segundo clic invierte y un tercero vuelve al orden por urgencia;
 *  · `aria-sort` dice la verdad (lo lee un lector de pantalla);
 *  · «Limpiar filtros» quita todo menos el alcance de los chips, y no aparece si no hay nada que limpiar;
 *  · un rango de fechas al revés no se manda (se arrastra el otro extremo);
 *  · una respuesta vieja que llega tarde NO pisa a la nueva (clics seguidos).
 */
describe('[MS.3.16] ServicioBandejaComponent — filtros y orden', () => {
  let fix: ComponentFixture<ServicioBandejaComponent>;
  let c: ServicioBandejaComponent;
  let api: { inbox: ReturnType<typeof vi.fn>; stats: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; agents: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };

  const fila = (id: string) => ({ id, folio: `SRV-2026-${id}`, title: `t${id}`, category_name: 'x', priority: 'media', status: 'nuevo', sla: null }) as never;

  async function render(inbox = vi.fn(() => of({ rows: [], total: 0 }))) {
    api = {
      inbox,
      stats: vi.fn(() => NEVER),
      catalog: vi.fn(() => of({ queues: [], impacts: [], categories: [{ id: 'cat-1', name: 'Impresoras' }, { id: 'cat-2', name: 'Red' }] })),
      agents: vi.fn(() => of([{ user_id: 'u-2', username: 'zeta', name: 'Zoe Zapata', open_count: 0 }, { user_id: 'u-1', username: 'ana', name: null, open_count: 1 }])),
      detail: vi.fn(() => NEVER),
    };
    await TestBed.configureTestingModule({
      imports: [ServicioBandejaComponent],
      providers: [
        { provide: ServiceDeskService, useValue: api },
        { provide: PermissionsService, useValue: { has: () => false } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) }, queryParamMap: NEVER } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ServicioBandejaComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  const ultima = () => api.inbox.mock.calls[api.inbox.mock.calls.length - 1][0] as Record<string, unknown>;
  const el = () => fix.nativeElement as HTMLElement;

  afterEach(() => TestBed.resetTestingModule());

  it('sin filtros ni orden NO manda sort/dir ni filtros: manda el orden por urgencia de siempre', async () => {
    await render();
    const q = ultima();
    expect(q['sort']).toBeUndefined();
    expect(q['dir']).toBeUndefined();
    for (const k of ['status', 'category_id', 'assigned_to', 'warehouse_code', 'from', 'to']) expect(q[k]).toBeUndefined();
  });

  it('⭐ cada filtro viaja al servidor con su nombre', async () => {
    await render();
    c.setFiltro('estado', 'en_proceso');
    c.setFiltro('categoria', 'cat-2');
    c.setFiltro('atiende', 'u-1');
    c.setFiltro('ubic', 'OF');
    c.setDesde('2026-10-01');
    c.setHasta('2026-10-05');
    expect(ultima()).toMatchObject({ status: 'en_proceso', category_id: 'cat-2', assigned_to: 'u-1', warehouse_code: 'OF', from: '2026-10-01', to: '2026-10-05' });
  });

  it('«Sin asignar» se manda como assigned_to=none', async () => {
    await render();
    c.setFiltro('atiende', 'none');
    expect(ultima()['assigned_to']).toBe('none');
  });

  it('las opciones de «Quien atiende» traen «Sin asignar» primero y luego las personas por nombre (con respaldo al usuario)', async () => {
    await render();
    expect(c.atienden().map((o) => o.label)).toEqual(['Sin asignar', 'ana', 'Zoe Zapata']);
  });

  it('⭐ un clic ordena en el servidor con la dirección natural; el segundo invierte; el tercero quita el orden', async () => {
    await render();
    c.ordenar('plazo');
    expect(ultima()).toMatchObject({ sort: 'plazo', dir: 'asc' });
    c.ordenar('plazo');
    expect(ultima()).toMatchObject({ sort: 'plazo', dir: 'desc' });
    c.ordenar('plazo');
    expect(ultima()['sort']).toBeUndefined();
    expect(ultima()['dir']).toBeUndefined();
  });

  it('prioridad arranca de lo más urgente (desc) y cambiar de columna reinicia la dirección', async () => {
    await render();
    c.ordenar('prioridad');
    expect(ultima()).toMatchObject({ sort: 'prioridad', dir: 'desc' });
    c.ordenar('folio');
    expect(ultima()).toMatchObject({ sort: 'folio', dir: 'asc' });
  });

  it('⭐ aria-sort dice la verdad en el encabezado', async () => {
    await render();
    c.ordenar('plazo');
    fix.detectChanges();
    const ths = Array.from(el().querySelectorAll('th'));
    const plazo = ths.find((t) => t.textContent?.includes('Plazo')) as HTMLElement;
    const folio = ths.find((t) => t.textContent?.includes('Folio')) as HTMLElement;
    expect(plazo.getAttribute('aria-sort')).toBe('ascending');
    expect(folio.getAttribute('aria-sort')).toBe('none');
    c.ordenar('plazo');
    fix.detectChanges();
    expect(plazo.getAttribute('aria-sort')).toBe('descending');
  });

  it('el clic real en el encabezado ordena', async () => {
    await render();
    const btn = Array.from(el().querySelectorAll('th button')).find((b) => b.textContent?.includes('Estado')) as HTMLButtonElement;
    btn.click();
    expect(ultima()).toMatchObject({ sort: 'estado', dir: 'asc' });
  });

  it('«Limpiar filtros» no aparece si no hay nada que limpiar, y al usarla quita filtros y orden pero deja el alcance', async () => {
    await render();
    expect(el().querySelector('.sb-limpiar')).toBeNull();
    c.setScope('mine');
    c.setFiltro('estado', 'nuevo');
    c.ordenar('folio');
    fix.detectChanges();
    expect(el().querySelector('.sb-limpiar')).not.toBeNull();
    c.limpiar();
    fix.detectChanges();
    const q = ultima();
    expect(q['scope']).toBe('mine');
    for (const k of ['status', 'sort', 'dir', 'priority']) expect(q[k]).toBeUndefined();
    expect(el().querySelector('.sb-limpiar')).toBeNull();
  });

  it('⛔ NEGATIVA — un rango al revés no se manda: se arrastra el otro extremo', async () => {
    await render();
    c.setHasta('2026-10-01');
    c.setDesde('2026-10-05');
    expect(ultima()).toMatchObject({ from: '2026-10-05', to: '2026-10-05' });
    c.setHasta('2026-09-20');
    expect(ultima()).toMatchObject({ from: '2026-09-20', to: '2026-09-20' });
  });

  it('⭐ una respuesta vieja que llega tarde NO pisa a la nueva', async () => {
    const lenta = new Subject<{ rows: never[]; total: number }>();
    const inbox = vi.fn()
      .mockReturnValueOnce(of({ rows: [], total: 0 })) // carga inicial
      .mockReturnValueOnce(lenta) // clic 1: tarda
      .mockReturnValueOnce(of({ rows: [fila('2')], total: 1 })); // clic 2: rápida
    await render(inbox);
    c.ordenar('folio');
    c.ordenar('folio');
    expect(c.rows().length).toBe(1);
    lenta.next({ rows: [fila('1'), fila('9')], total: 2 });
    expect(c.rows().length).toBe(1);
    expect(c.total()).toBe(1);
  });

  it('el botón de filtros (teléfono) cuenta los filtros puestos, para no esconder que hay uno activo, y abre/cierra la sección', async () => {
    await render();
    expect(c.nFiltros()).toBe(0);
    c.setFiltro('estado', 'nuevo');
    c.ordenar('folio');
    expect(c.nFiltros()).toBe(2);
    fix.detectChanges();
    const btn = el().querySelector('.sb-filtros-toggle') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toContain('2');
    btn.click();
    fix.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(el().querySelector('.sb-filtros')?.classList.contains('abierto')).toBe(true);
  });

  it('el mensaje de «vacío» dice que hay filtros cuando los hay', async () => {
    await render();
    c.setFiltro('categoria', 'cat-1');
    fix.detectChanges();
    expect(el().querySelector('.vacio')?.textContent).toContain('Ninguna solicitud con estos filtros');
  });
});
