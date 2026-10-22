// `[MCP.3.6]` Tomar pedido: «cuando estoy sumando las cantidades se llega a trabar».
//
// Causa medida con esta prueba (estaba ROJA antes del arreglo): al volcar los toques al
// servidor, `flushQty` BORRABA la cantidad optimista en el mismo instante en que mandaba el
// PUT. Mientras el PUT y la relectura del pedido iban en vuelo (en ruta, con datos móviles,
// uno o dos segundos), la fila volvía a mostrar la cantidad VIEJA del servidor: el número
// «saltaba para atrás». Y si el vendedor seguía tocando "+", subía desde ese número viejo,
// así que sus toques se perdían y al final se mandaba una cantidad MENOR a la que tocó.
// Además, un segundo volcado salía en paralelo al primero (dos PUT al mismo renglón que la
// red puede entregar en cualquier orden).
//
// Hipótesis descartadas con prueba: los botones +/− NO se deshabilitan por una petición en
// vuelo, y NO sale un PUT por toque (el debounce los junta en uno).
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, Subject, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import type { OrderLine } from '../../portal/portal.service';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', sales_units_30d: 10 };
const kinder = {
  ...base, id: 'a', product_id: 'a', product_name: 'Kinder Delice 10P', sku: '1', price: 17,
  stock_available: 50, tiers: [{ min_qty: 3, price: 13.69 }],
};
const serenata = { ...base, id: 'b', product_id: 'b', product_name: 'Serenata de Amor 825g', sku: '2', price: 123.75, stock_available: 9 };

type Fn = (...args: unknown[]) => Observable<unknown>;

function linea(q: number, unit = 17): OrderLine {
  return { id: 'l1', product_id: 'a', quantity: q, line_subtotal: unit * q, line_tax: 0, unit_price: unit } as unknown as OrderLine;
}

/** Monta la pantalla con un doble de VendorService que registra cada llamada con sus argumentos. */
function montar(extra: Record<string, unknown> = {}) {
  const llamadas: Record<string, unknown[][]> = {};
  const respuestas: Record<string, unknown> = {
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'C1', name: 'Super San Juan', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices: [kinder, serenata], origen: 'servidor', at: Date.now() },
    catalogForCustomer: { priceListId: 'pl1', prices: [kinder, serenata] },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
    ...extra,
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args: unknown[]) => {
        (llamadas[prop] ??= []).push(args);
        const r = respuestas[prop];
        return typeof r === 'function' ? (r as Fn)(...args) : of(prop in respuestas ? r : null);
      };
    },
  }) as unknown as VendorService;
  const avisos: { severity?: string; summary?: string; detail?: string }[] = [];
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      { provide: MessageService, useValue: { add: (m: { severity?: string }) => avisos.push(m) } },
      { provide: VendorService, useValue: api },
      { provide: ConnectivityService, useValue: { isOnline: () => true } },
      { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve(), cacheCustomer: () => Promise.resolve() } },
      { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fixture = TestBed.createComponent(VendorTakeOrderComponent);
  fixture.detectChanges();
  const cmp = fixture.componentInstance;
  return { fixture, cmp, llamadas, avisos, el: fixture.nativeElement as HTMLElement };
}

function fila(el: HTMLElement, nombre: string): HTMLElement | undefined {
  return Array.from(el.querySelectorAll<HTMLElement>('.prod')).find((r) => r.textContent?.includes(nombre));
}

/** Pedido ya con Kinder en 1 (servidor). PUT y relectura controlados a mano. */
function conRenglon() {
  let servidor = 1;
  const puts: Subject<unknown>[] = [];
  const t = montar({
    updateLine: (_o: unknown, _l: unknown, q: unknown) => {
      const s = new Subject<unknown>();
      puts.push(s);
      // Cuando el PUT termina bien, el servidor ya guarda la cantidad nueva.
      return new Observable((sub) => s.subscribe({
        next: (v) => { servidor = Number(q); sub.next(v); },
        error: (e) => sub.error(e),
        complete: () => sub.complete(),
      }));
    },
    orderById: () => of({ id: 'o1', lines: [linea(servidor, servidor >= 3 ? 13.69 : 17)] }),
  });
  t.cmp.cartOrderId.set('o1');
  t.cmp.cartLines.set([linea(1)]);
  const p = t.cmp.prices().find((x) => x.product_id === 'a')!;
  const terminarPut = (i: number) => { puts[i].next({}); puts[i].complete(); };
  return { ...t, p, puts, terminarPut, servidor: () => servidor };
}

describe('Tomar pedido · sumar cantidades sin trabarse [MCP.3.6]', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('cada toque sube el número AL INSTANTE y sale UN solo PUT ~400 ms después del último', () => {
    const { cmp, p, llamadas } = conRenglon();
    for (let i = 0; i < 5; i++) cmp.incProduct(p);
    expect(cmp.cartQty('a')).toBe(6);
    vi.advanceTimersByTime(399);
    expect(llamadas['updateLine'] ?? []).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(llamadas['updateLine']).toHaveLength(1);
    expect(llamadas['updateLine'][0][2]).toBe(6);
  });

  it('⭐ con el PUT en vuelo la fila NO salta para atrás a la cantidad vieja del servidor', async () => {
    const { cmp, p, fixture, el, llamadas } = conRenglon();
    cmp.incProduct(p);
    cmp.incProduct(p);
    cmp.incProduct(p); // 4
    vi.advanceTimersByTime(400); // sale el PUT; el servidor todavía dice 1
    expect(llamadas['updateLine']).toHaveLength(1);
    fixture.detectChanges();
    await Promise.resolve(); // ngModel escribe el input en una microtarea
    expect(cmp.cartQty('a')).toBe(4);
    const input = fila(el, 'Kinder')!.querySelector<HTMLInputElement>('input.qin')!;
    expect(Number(input.value)).toBe(4);
  });

  it('⭐ los toques que caen mientras el PUT va en vuelo NO se pierden', () => {
    const { cmp, p, llamadas, terminarPut, servidor } = conRenglon();
    cmp.incProduct(p);
    cmp.incProduct(p);
    cmp.incProduct(p); // 4
    vi.advanceTimersByTime(400); // PUT(4) en vuelo
    cmp.incProduct(p); // el vendedor sigue tocando: debe ser 5, no 2
    expect(cmp.cartQty('a')).toBe(5);
    vi.advanceTimersByTime(400);
    // No sale un segundo PUT al mismo renglón mientras el primero no vuelve.
    expect(llamadas['updateLine']).toHaveLength(1);
    terminarPut(0);
    vi.advanceTimersByTime(400);
    expect(llamadas['updateLine']).toHaveLength(2);
    expect(llamadas['updateLine'][1][2]).toBe(5);
    terminarPut(1);
    vi.advanceTimersByTime(400);
    expect(servidor()).toBe(5);
    expect(cmp.cartQty('a')).toBe(5);
  });

  it('al volver el servidor, la fila queda en lo que el servidor guardó (sin cantidad colgada)', () => {
    const { cmp, p, terminarPut } = conRenglon();
    cmp.incProduct(p);
    cmp.incProduct(p); // 3
    vi.advanceTimersByTime(400);
    terminarPut(0);
    expect(cmp.cartLines()[0].quantity).toBe(3);
    expect(cmp.cartQty('a')).toBe(3);
    expect(cmp.totalPendiente()).toBe(false);
  });

  it('regresar al número anterior mientras la relectura viaja SÍ se manda al servidor', () => {
    const lecturas: Subject<unknown>[] = [];
    const puts: unknown[][] = [];
    const { cmp } = montar({
      updateLine: (...a: unknown[]) => { puts.push(a); return of({}); },
      orderById: () => { const s = new Subject<unknown>(); lecturas.push(s); return s; },
    });
    cmp.cartOrderId.set('o1');
    cmp.cartLines.set([linea(1)]);
    const p = cmp.prices().find((x) => x.product_id === 'a')!;
    cmp.incProduct(p); // 2
    vi.advanceTimersByTime(400); // PUT(2) vuelve bien; la relectura queda en vuelo
    expect(puts.map((a) => a[2])).toEqual([2]);
    cmp.decProduct(p); // de vuelta a 1 (lo que dice el renglón viejo)
    expect(cmp.cartQty('a')).toBe(1);
    vi.advanceTimersByTime(400);
    expect(puts.map((a) => a[2])).toEqual([2, 1]);
  });

  it('los botones +/− nunca se deshabilitan por una petición en vuelo', () => {
    const { cmp, p, fixture, el } = conRenglon();
    cmp.incProduct(p);
    vi.advanceTimersByTime(400); // PUT en vuelo
    fixture.detectChanges();
    const f = fila(el, 'Kinder')!;
    expect(f.querySelector<HTMLButtonElement>('button[aria-label="Más"]')!.disabled).toBe(false);
    expect(f.querySelector<HTMLButtonElement>('button[aria-label="Menos"]')!.disabled).toBe(false);
    expect(f.querySelector('.p-progress-spinner, .overlay, [aria-busy="true"]')).toBeNull();
  });

  it('⭐ si el servidor rechaza el cambio: se dice en la fila y la cantidad vuelve a la del servidor', () => {
    const { cmp, p, fixture, el, puts } = conRenglon();
    cmp.incProduct(p);
    cmp.incProduct(p); // 3
    vi.advanceTimersByTime(400);
    puts[0].error({ status: 409, error: { message: 'Sin existencias para surtir 3' } });
    vi.advanceTimersByTime(400);
    fixture.detectChanges();
    expect(cmp.cartQty('a')).toBe(1);
    expect(fila(el, 'Kinder')!.querySelector('.row-err')?.textContent).toContain('Sin existencias para surtir 3');
  });
});

describe('Tomar pedido · precio normal y de mayoreo en la tarjeta [MCP.3.6]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ por default muestra los DOS precios: el normal y el de mayoreo con su condición', () => {
    const { fixture, el } = montar();
    fixture.detectChanges();
    const k = fila(el, 'Kinder')!;
    expect(k.querySelector('.pr')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('$17.00 c/u');
    expect(k.querySelector('.may')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Mayoreo (3+): $13.69 c/u');
    // Sin cantidad todavía, nada se marca como aplicado.
    expect(k.querySelector('.may.on')).toBeNull();
    expect(k.querySelector('.pr.off')).toBeNull();
  });

  it('un producto SIN mayoreo muestra sólo el normal (nunca $0.00)', () => {
    const { fixture, el } = montar();
    fixture.detectChanges();
    const s = fila(el, 'Serenata')!;
    expect(s.querySelector('.pr')?.textContent).toContain('$123.75');
    expect(s.querySelector('.may')).toBeNull();
    expect(s.textContent).not.toContain('$0.00');
  });

  it('un «mayoreo» que no es más barato que el normal no se anuncia', () => {
    const caro = { ...kinder, tiers: [{ min_qty: 3, price: 17 }] };
    const { fixture, el } = montar({ catalogInstant: { priceListId: 'pl1', prices: [caro], origen: 'servidor', at: Date.now() } });
    fixture.detectChanges();
    expect(fila(el, 'Kinder')!.querySelector('.may')).toBeNull();
  });

  it('⭐ se resalta SÓLO cuando el servidor cobra mayoreo en el renglón, no cuando el celular llega a 3', () => {
    const { cmp, fixture, el } = montar();
    cmp.cartOrderId.set('o1');
    // 3 piezas, pero el servidor las cobró a precio normal: no se dice «aplicado».
    cmp.cartLines.set([linea(3, 17)]);
    fixture.detectChanges();
    expect(fila(el, 'Kinder')!.querySelector('.may.on')).toBeNull();
    // El servidor las cobró a 13.69: ahora sí, con icono y texto (no sólo color).
    cmp.cartLines.set([linea(3, 13.69)]);
    fixture.detectChanges();
    const k = fila(el, 'Kinder')!;
    expect(k.querySelector('.may.on')?.textContent).toContain('aplicado');
    expect(k.querySelector('.may.on .pi-check-circle')).not.toBeNull();
    expect(k.querySelector('.pr.off')).not.toBeNull();
  });

  it('con un cambio de cantidad sin confirmar, no se afirma que el mayoreo aplica', () => {
    vi.useFakeTimers();
    try {
      const { cmp, fixture, el } = montar({ updateLine: () => new Subject<unknown>() });
      cmp.cartOrderId.set('o1');
      cmp.cartLines.set([linea(3, 13.69)]);
      const p = cmp.prices().find((x) => x.product_id === 'a')!;
      cmp.decProduct(p); // 2, todavía sin mandar
      fixture.detectChanges();
      expect(fila(el, 'Kinder')!.querySelector('.may.on')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
