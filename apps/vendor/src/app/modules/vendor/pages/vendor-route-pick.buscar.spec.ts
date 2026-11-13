// `[MCP.26]` «Elegir ruta»: el buscador encuentra por cada palabra, en cualquier orden y sin acentos,
// en ruta, zona o vendedor. Antes buscaba la frase entera en un solo campo.
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { AuthService } from '../../../core/services/auth.service';
import { VendorRoutePickComponent } from './vendor-route-pick.component';

const op = (route_id: string, route: string, zone: string | null, vendor: string, hoy = true) => ({
  route_id, route, zone, scheduled_today: hoy, days: [1], vendors: [{ username: vendor, today: hoy, is_me: false }], customers: 30,
});

function montar() {
  const vendor = {
    dayPickState: vi.fn(() => of({
      can_pick: true, current: null, agenda_today: [],
      options: [
        op('r1', 'VECINAL 3', 'PIEDAD ORIENTE', 'prueba.uno'),
        op('r2', 'MAYOREO 7', 'ZAMORA', 'prueba.dos', false),
        op('r3', 'VECINAL 12', 'PEÑITAS', 'prueba.tres'),
      ],
    })),
  };
  TestBed.configureTestingModule({
    imports: [VendorRoutePickComponent],
    providers: [
      provideRouter([]),
      { provide: MessageService, useValue: { add: () => undefined } },
      { provide: VendorService, useValue: vendor },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'prueba.uno' }) } },
    ],
  });
  const fix = TestBed.createComponent(VendorRoutePickComponent);
  fix.detectChanges();
  const cmp = fix.componentInstance;
  const rutas = () => [...cmp.todayOpts(), ...cmp.otherOpts()].map((o) => o.route);
  return { cmp, rutas };
}

describe('[MCP.26] Elegir ruta · buscar por palabras', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sin texto se ven todas', () => {
    const { rutas } = montar();
    expect(rutas()).toEqual(['VECINAL 3', 'VECINAL 12', 'MAYOREO 7']);
  });

  it('⭐ palabras de dos campos y en otro orden: «12 vecinal» y «vecinal uno»', () => {
    const { cmp, rutas } = montar();
    cmp.search.set('12 vecinal');
    expect(rutas()).toEqual(['VECINAL 12']);
    cmp.search.set('vecinal uno');
    expect(rutas()).toEqual(['VECINAL 3']);
  });

  it('sin acentos: «penitas» encuentra la zona PEÑITAS', () => {
    const { cmp, rutas } = montar();
    cmp.search.set('penitas');
    expect(rutas()).toEqual(['VECINAL 12']);
  });

  it('prueba negativa: una palabra que no está en ninguna deja la lista vacía', () => {
    const { cmp, rutas } = montar();
    cmp.search.set('vecinal zamora');
    expect(rutas()).toEqual([]);
  });
});
