import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, NEVER, of } from 'rxjs';
import { vi } from 'vitest';
import type { SdCatalogResponse } from '@megadulces/contracts';
import { ServiceDeskService } from '../service-desk.service';
import { ServicioSolicitudesComponent } from './servicio-solicitudes.component';

/**
 * `[MS.DICTADO]` En «Nueva solicitud»:
 *  · el dictado se ofrece en un área normal y lo dictado se AGREGA a lo escrito (no lo reemplaza);
 *  · en un área confidencial NO se ofrece (el audio lo procesa un servicio externo) — y TI sigue igual (control);
 *  · sin área elegida tampoco.
 */
const catalogo = (): SdCatalogResponse => ({
  queues: [
    { id: 'q-ti', code: 'ti', name: 'TI (Sistemas)', priority_model: 'impacto', asks_zone: false, confidential: false, uses_priority: true, sla_enabled: true },
    { id: 'q-rh', code: 'rh', name: 'Recursos Humanos', priority_model: 'impacto', asks_zone: false, confidential: true, uses_priority: false, sla_enabled: false },
  ],
  zones: [],
  fields: [],
  categories: [
    { id: 'c-ti', queue_id: 'q-ti', code: 'caja', name: 'Caja', default_priority: 'media', requires_branch: false },
    { id: 'c-rh', queue_id: 'q-rh', code: 'queja', name: 'Queja', default_priority: 'media', requires_branch: false },
  ],
  impacts: ['yo', 'varios', 'sucursal', 'red'],
});

describe('[MS.DICTADO] ServicioSolicitudesComponent', () => {
  let fix: ComponentFixture<ServicioSolicitudesComponent>;
  let c: ServicioSolicitudesComponent;
  const hayDictado = () => (fix.nativeElement as HTMLElement).querySelector('sd-dictado') !== null;

  beforeEach(async () => {
    const api = { mine: vi.fn(() => of({ rows: [], total: 0 })), catalog: vi.fn(() => of(catalogo())), create: vi.fn(() => of({ id: 'n' })), detail: vi.fn(() => NEVER) };
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
  });
  afterEach(() => TestBed.resetTestingModule());

  it('sin área elegida no se ofrece dictar', () => {
    fix.detectChanges();
    expect(c.puedeDictar()).toBe(false);
    expect(hayDictado()).toBe(false);
  });

  it('⭐ en un área normal se ofrece', () => {
    c.elegirArea('q-ti');
    c.elegirCategoria('c-ti');
    fix.detectChanges();
    expect(c.puedeDictar()).toBe(true);
    expect(hayDictado()).toBe(true);
  });

  it('⛔ NEGATIVA — en un área confidencial NO se ofrece', () => {
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    fix.detectChanges();
    expect(c.confidencial()).toBe(true);
    expect(c.puedeDictar()).toBe(false);
    expect(hayDictado()).toBe(false);
  });

  it('⛔ NEGATIVA — cambiar de un área normal a una confidencial lo retira', () => {
    c.elegirArea('q-ti');
    c.elegirCategoria('c-ti');
    fix.detectChanges();
    expect(hayDictado()).toBe(true);
    c.elegirArea('q-rh');
    c.elegirCategoria('c-rh');
    fix.detectChanges();
    expect(hayDictado()).toBe(false);
  });

  it('lo dictado se AGREGA a lo ya escrito, sin pegar palabras', () => {
    c.form.description = 'No me abre el sistema';
    c.agregarDictado('desde esta mañana');
    expect(c.form.description).toBe('No me abre el sistema desde esta mañana');
  });

  it('dictar sobre un campo vacío lo llena', () => {
    c.form.description = '';
    c.agregarDictado('  hola  ');
    expect(c.form.description).toBe('hola');
  });
});
