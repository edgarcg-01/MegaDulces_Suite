import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.7.15]` «Nueva solicitud»: primero el ÁREA, luego las categorías de ESA área. Lo que se defiende:
 *  · con varias áreas se pregunta el área y las categorías son sólo las de esa área (no una lista mezclada);
 *  · ⛔ sin área elegida no hay categorías que elegir;
 *  · con UNA sola área no se pregunta (TI sigue como siempre);
 *  · cambiar de área descarta la categoría, los campos propios y la zona de la anterior;
 *  · elegir una categoría por código deja el área coherente;
 *  · un área sin categorías no se ofrece.
 */
const DOS_AREAS: SdCatalogResponse = {
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-mto', code: 'mantenimiento', name: 'Mantenimiento', priority_model: 'impacto', asks_zone: true, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-vacia', code: 'vacia', name: 'Sin categorías', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
  ],
  zones: [{ code: 'bodega', name: 'Bodega' }],
  fields: [{ code: 'equipo', queue_id: 'q-mto', label: 'Equipo', type: 'text', required: true, options: [] }],
  categories: [
    { id: 'c-ti-1', queue_id: 'q-ti', code: 'reportes', name: 'Reportes', default_priority: 'baja', requires_branch: false },
    { id: 'c-ti-2', queue_id: 'q-ti', code: 'caja', name: 'Caja', default_priority: 'media', requires_branch: false },
    { id: 'c-mto-1', queue_id: 'q-mto', code: 'plomeria', name: 'Plomería', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
};
const UNA_AREA: SdCatalogResponse = { ...DOS_AREAS, queues: [DOS_AREAS.queues[0]], categories: DOS_AREAS.categories.filter((k) => k.queue_id === 'q-ti'), fields: [] };

describe('[MS.7.15] ServicioSolicitudesComponent — área y luego categoría', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  let api: { mine: ReturnType<typeof vi.fn>; catalog: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> };
  const texto = () => (fix.nativeElement as HTMLElement).textContent ?? '';

  async function render(catalogo: SdCatalogResponse) {
    api = { mine: vi.fn(() => of({ rows: [], total: 0 })), catalog: vi.fn(() => of(catalogo)), create: vi.fn(() => of({ id: 'n' })), detail: vi.fn(() => NEVER) };
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

  it('⭐ con varias áreas pregunta el área, y no ofrece las que no tienen categorías', async () => {
    await render(DOS_AREAS);
    expect(c.hayVariasAreas()).toBe(true);
    expect(texto()).toContain('¿A qué área?');
    expect(c.areas().map((a) => a.name)).toEqual(['TI (Sistemas)', 'Mantenimiento']);
  });

  it('⛔ NEGATIVA — sin área elegida no hay categorías que elegir', async () => {
    await render(DOS_AREAS);
    expect(c.areaEfectiva()).toBeNull();
    expect(c.categoriasDelArea()).toEqual([]);
    expect(texto()).toContain('Primero elige el área');
  });

  it('⭐ elegida el área, las categorías son SÓLO las de esa área', async () => {
    await render(DOS_AREAS);
    c.elegirArea('q-mto');
    expect(c.categoriasDelArea().map((k) => k.name)).toEqual(['Plomería']);
    c.elegirArea('q-ti');
    expect(c.categoriasDelArea().map((k) => k.name)).toEqual(['Reportes', 'Caja']);
  });

  it('⭐ con UNA sola área no se pregunta: ya está elegida y se ven sus categorías (TI como siempre)', async () => {
    await render(UNA_AREA);
    expect(c.hayVariasAreas()).toBe(false);
    expect(texto()).not.toContain('¿A qué área?');
    expect(c.areaEfectiva()).toBe('q-ti');
    expect(c.categoriasDelArea().map((k) => k.name)).toEqual(['Reportes', 'Caja']);
  });

  it('⛔ cambiar de área descarta la categoría, los campos propios y la zona de la anterior', async () => {
    await render(DOS_AREAS);
    c.elegirArea('q-mto');
    c.elegirCategoria('c-mto-1');
    c.extraForm['equipo'] = 'Compresor';
    c.form.zone_code = 'bodega';
    c.elegirArea('q-ti');
    expect(c.form.category_id).toBeNull();
    expect(c.categoriaId()).toBeNull();
    expect(c.extraForm).toEqual({});
    expect(c.form.zone_code).toBeNull();
    c.form.title = 'Algo';
    expect(c.puedeEnviar()).toBe(false); // sin categoría no se envía
  });

  it('elegir la MISMA área otra vez no borra lo ya elegido', async () => {
    await render(DOS_AREAS);
    c.elegirArea('q-mto');
    c.elegirCategoria('c-mto-1');
    c.elegirArea('q-mto');
    expect(c.form.category_id).toBe('c-mto-1');
  });

  it('elegir una categoría por código deja el área coherente (deep-link, pruebas, otra pantalla)', async () => {
    await render(DOS_AREAS);
    c.elegirCategoria('c-mto-1');
    expect(c.areaId()).toBe('q-mto');
    expect(c.categoriasDelArea().map((k) => k.id)).toEqual(['c-mto-1']);
  });

  it('nueva() limpia el área para que la siguiente solicitud empiece de cero', async () => {
    await render(DOS_AREAS);
    c.elegirCategoria('c-mto-1');
    c.nueva();
    expect(c.areaId()).toBeNull();
    expect(c.categoriasDelArea()).toEqual([]);
  });
});
