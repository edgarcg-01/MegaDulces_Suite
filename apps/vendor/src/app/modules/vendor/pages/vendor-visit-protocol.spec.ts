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

async function montar(o: { checkIn?: unknown; home?: unknown[]; nearby?: unknown[]; hoy?: unknown[] } = {}) {
  const vendor = {
    home: vi.fn(() => of(o.home ?? [LUPITA])),
    myOrdersToday: vi.fn(() => of(o.hoy ?? [])),
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

describe('[MCP.21] cada renglón de Mi ruta dice cómo va el cliente', () => {
  afterEach(() => TestBed.resetTestingModule());
  const ayer = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const ahora = new Date().toISOString();
  const cli = (id: string, extra: Record<string, unknown> = {}) => ({ ...LUPITA, id, code: id, name: `CLIENTE ${id}`, ...extra });
  const renglon = (el: HTMLElement, nombre: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button.client')).find((b) => b.textContent?.includes(nombre));
  const textoDe = (b: Element | undefined) => b?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('⭐ los cuatro estados, en palabras, y ningún «·» en el círculo (en prod ningún cliente tiene orden de visita)', async () => {
    const { el } = await montar({
      nearby: [],
      home: [
        cli('A'),
        cli('B', { visited_today: true }),
        cli('C', { visited_today: true, no_sale_reason_today: 'con_inventario' }),
        cli('D', { visited_today: true, ordered_today: true }),
        cli('E', { ordered_today: true }),
      ],
      hoy: [{ id: 'o1', customer_id: 'D', status: 'confirmed', total: '274.81' }],
    });
    expect(textoDe(renglon(el, 'CLIENTE A'))).toContain('Sin visita');
    expect(textoDe(renglon(el, 'CLIENTE B'))).toContain('Visitado, sin cerrar');
    expect(textoDe(renglon(el, 'CLIENTE C'))).toContain('No pidió · Todavía tiene producto');
    expect(textoDe(renglon(el, 'CLIENTE D'))).toContain('Pedido hoy $274.81');
    // E pidió hoy, pero no se lo levantó esta vendedora: no inventa un monto.
    expect(textoDe(renglon(el, 'CLIENTE E'))).toMatch(/Pedido hoy$/);
    for (const seq of Array.from(el.querySelectorAll('button.client .seq'))) expect(seq.textContent?.trim()).not.toBe('·');
    expect(renglon(el, 'CLIENTE A')?.querySelector('.seq')?.textContent?.trim()).toBe('');
    expect(renglon(el, 'CLIENTE D')?.querySelector('.seq .pi-check')).toBeTruthy();
  });

  it('el pedido de hoy no se repite como «por entregar»; lo de días anteriores sí, y la preventa con SU monto', async () => {
    const { el } = await montar({
      nearby: [],
      home: [
        cli('H', { ordered_today: true, pending_count: 1, pending_total: 100, pending_orders: [{ id: 'h', code: 'PD-1', status: 'confirmed', total: 100, created_at: ahora }] }),
        cli('V', {
          pending_count: 2, pending_total: 1300, has_preventa_pending: true,
          pending_orders: [
            { id: 'v', code: 'PD-2', status: 'confirmed', total: '300', created_at: ayer, is_preventa: true },
            { id: 'w', code: 'PD-3', status: 'confirmed', total: 1000, created_at: ayer },
          ],
        }),
      ],
      hoy: [{ id: 'h', customer_id: 'H', status: 'confirmed', total: 100 }],
    });
    expect(textoDe(renglon(el, 'CLIENTE H'))).not.toContain('por entregar');
    const v = textoDe(renglon(el, 'CLIENTE V'));
    expect(v).toContain('Preventa $300.00');
    expect(v).toContain('1 anterior por entregar');
  });

  it('al cerrar «no pidió», su renglón lo dice sin recargar la ruta', async () => {
    const { boton, el, asentar, vendor } = await montar({ nearby: [] });
    renglon(el, 'ABARROTES LUPITA')!.click();
    await asentar();
    boton('El cliente no pidió nada')!.click();
    await asentar();
    Array.from(el.querySelectorAll<HTMLInputElement>('input[type=radio]')).find((r) => r.value === 'sin_recursos')!.click();
    await asentar();
    boton('Cerrar visita sin pedido')!.click();
    await asentar();
    expect(vendor.home).toHaveBeenCalledTimes(1);
    expect(textoDe(renglon(el, 'ABARROTES LUPITA'))).toContain('No pidió · No tiene dinero');
  });

  it('«Capturar exhibición» ya no es un renglón de la hoja: va junto a Llamar y WhatsApp', async () => {
    const { el, asentar } = await montar({ nearby: [], home: [{ ...LUPITA, phone: '4441234567' }] });
    renglon(el, 'ABARROTES LUPITA')!.click();
    await asentar();
    const fila = el.querySelector('.sheet .contact');
    expect(fila?.textContent).toContain('Llamar');
    expect(fila?.textContent).toContain('Capturar exhibición');
    expect(Array.from(el.querySelectorAll('.sheet .action')).some((b) => b.textContent?.includes('Capturar exhibición'))).toBe(false);
  });
});
