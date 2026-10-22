// `[MCP.3.7]` Protocolo de visitas, del lado del vendedor.
//
// Lo que importa: (1) cerca de un cliente aparece la tarjeta «Llegaste · a N m» con nombre, dirección y
// «Abrir cliente», sin texto de relleno; (2) abrir al cliente REGISTRA la visita con la ubicación ya
// tomada; (3) si falla se dice (no se da por registrada); (4) «El cliente no pidió nada» pide el
// motivo y cierra la visita sin pedido; «otro» exige el texto; (5) un cliente ya visitado hoy no
// registra otra visita al abrirlo.
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import { VendorService } from '../vendor.service';
import { RouteDayService } from '../route-day.service';
import { AuthService } from '../../../core/services/auth.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { VendorRouteHomeComponent, arrivalDetail } from './vendor-route-home.component';
import { noSaleIsValid } from '../visit-protocol';

const LUPITA = {
  id: 'c1', code: 'C1', name: 'ABARROTES LUPITA', visited_today: false, pending_count: 0,
  pending_total: 0, has_preventa_pending: false, ordered_today: false, pending_orders: [],
};
const CERCA = { id: 'c1', code: 'C1', name: 'ABARROTES LUPITA', address: 'Av. Juárez 12, Centro', latitude: 19.4, longitude: -99.1, distance_m: 23 };

async function montar(o: { checkIn?: unknown; home?: unknown[]; nearby?: unknown[] } = {}) {
  const vendor = {
    home: vi.fn(() => of(o.home ?? [LUPITA])),
    myOrdersToday: vi.fn(() => of([])),
    dayPickState: vi.fn(() => of(null)),
    nearbyCustomers: vi.fn(() => of(o.nearby ?? [CERCA])),
    checkIn: vi.fn(() => (o.checkIn instanceof Error ? throwError(() => o.checkIn) : of(o.checkIn ?? { id: 'v1', distance_m: 23 }))),
    finishVisit: vi.fn(() => of({ id: 'v1' })),
  };
  const geo = { supported: true, getCurrentPosition: vi.fn(async () => ({ lat: 19.4001, lng: -99.1, accuracy: 8 })) };
  await TestBed.configureTestingModule({
    imports: [VendorRouteHomeComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: VendorService, useValue: vendor },
      { provide: GeolocationService, useValue: geo },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1', username: 'Rosa' }) } },
      {
        provide: RouteDayService,
        useValue: { today: () => of({ id: 'rd1', work_date: '2026-10-21', state: 'en_ruta', started_at: '2026-10-21T14:00:00Z', finished_at: null, visited: 0, orders: 0, total: 0 }) },
      },
    ],
  }).compileComponents();
  const fix = TestBed.createComponent(VendorRouteHomeComponent);
  fix.detectChanges();
  await fix.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: string) =>
    Array.from(el.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement | undefined;
  const asentar = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      fix.detectChanges();
    }
  };
  return { fix, el, texto, boton, vendor, geo, asentar };
}

describe('Protocolo de visitas (MCP.3.7)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ cerca de un cliente: tarjeta «Llegaste · a N m» con nombre, dirección y «Abrir cliente»; sin relleno', async () => {
    const { texto, boton } = await montar();
    expect(texto()).toContain('Llegaste · a 23 m del cliente');
    expect(texto()).toContain('ABARROTES LUPITA');
    expect(texto()).toContain('Av. Juárez 12, Centro');
    expect(boton('Abrir cliente')).toBeDefined();
    expect(texto()).not.toContain('para registrar la visita');
  });

  it('⭐ «Abrir cliente» registra la visita con la ubicación ya tomada (sin volver a esperar al GPS)', async () => {
    const { boton, vendor, geo, texto, asentar } = await montar();
    const tomas = geo.getCurrentPosition.mock.calls.length;
    boton('Abrir cliente')!.click();
    await asentar();
    expect(vendor.checkIn).toHaveBeenCalledTimes(1);
    expect(vendor.checkIn).toHaveBeenCalledWith('c1', { latitude: 19.4001, longitude: -99.1 });
    expect(geo.getCurrentPosition.mock.calls.length).toBe(tomas);
    expect(texto()).toContain('Visita registrada');
    expect(texto()).toContain('a 23 m');
  });

  it('⛔ si no se pudo registrar, se dice y se ofrece Reintentar (no se da por hecha)', async () => {
    const { boton, texto, asentar, vendor } = await montar({ checkIn: new Error('500') });
    boton('Abrir cliente')!.click();
    await asentar();
    expect(texto()).toContain('No se pudo registrar la visita');
    expect(texto()).not.toContain('Visita registrada');
    boton('Reintentar')!.click();
    await asentar();
    expect(vendor.checkIn).toHaveBeenCalledTimes(2);
  });

  it('un cliente ya visitado hoy no registra otra visita al abrirlo', async () => {
    const { el, vendor, asentar, texto } = await montar({ home: [{ ...LUPITA, visited_today: true, last_visit_at: '2026-10-21T16:05:00Z' }], nearby: [] });
    el.querySelector<HTMLButtonElement>('button.client')!.click();
    await asentar();
    expect(vendor.checkIn).not.toHaveBeenCalled();
    expect(texto()).toContain('Visita registrada');
  });

  it('⭐ «El cliente no pidió nada» pide el motivo y cierra la visita sin pedido', async () => {
    const { boton, el, vendor, asentar, texto } = await montar();
    boton('Abrir cliente')!.click();
    await asentar();
    boton('El cliente no pidió nada')!.click();
    await asentar();
    expect(texto()).toContain('¿Por qué no pidió nada?');
    const ok = boton('Cerrar visita sin pedido')!;
    expect(ok.disabled).toBe(true);
    const radio = Array.from(el.querySelectorAll<HTMLInputElement>('input[type=radio]')).find((r) => r.value === 'sin_recursos')!;
    radio.click();
    await asentar();
    expect(boton('Cerrar visita sin pedido')!.disabled).toBe(false);
    boton('Cerrar visita sin pedido')!.click();
    await asentar();
    expect(vendor.finishVisit).toHaveBeenCalledWith('c1', { had_order: false, had_ticket: false, no_sale_reason: 'sin_recursos', notes: undefined });
    expect(texto()).not.toContain('¿Por qué no pidió nada?');
  });

  it('«Otro motivo» exige escribir qué pasó', () => {
    expect(noSaleIsValid('otro', '')).toBe(false);
    expect(noSaleIsValid('otro', '  a ')).toBe(false);
    expect(noSaleIsValid('otro', 'se mudó')).toBe(true);
    expect(noSaleIsValid('cerrado', '')).toBe(true);
    expect(noSaleIsValid(null, 'algo')).toBe(false);
  });

  it('el detalle de la llegada declara lo que no se pudo medir', () => {
    expect(arrivalDetail({ id: 'v', distance_m: 12 })).toBe(' · a 12 m');
    expect(arrivalDetail({ id: 'v', distance_m: null })).toBe(' · sin ubicación para medir la distancia');
    expect(arrivalDetail({ id: 'v', location: { location_set: true } as never })).toBe(' · se guardó la ubicación del cliente');
    expect(arrivalDetail(null)).toBe(' · sin ubicación para medir la distancia');
  });
});
