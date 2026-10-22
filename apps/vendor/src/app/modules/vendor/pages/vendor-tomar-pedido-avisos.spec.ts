// `[MCP.3.5]` Tomar pedido: la cantidad que se quedaba en 0 sin mensaje, y la tarjeta más limpia.
//
// Reporte de ruta (2026-10-20): el vendedor tocaba "+" y la cantidad volvía a 0 sin que nada
// dijera por qué. Tres causas, cada una con su prueba:
//   1. la pantalla declaraba su PROPIO MessageService y no tenía <p-toast>: todo aviso se perdía;
//   2. un flush sin pedido (el pedido aún naciendo) borraba la cantidad pendiente;
//   3. una lectura vieja del pedido que llegaba tarde pisaba a la nueva.
// La prueba monta la pantalla real con un doble de VendorService (mismo patrón que
// vendor-catalogo-instantaneo.spec.ts) y un MessageService del lado del "shell" (la raíz del
// TestBed), que es el único que en la app real pinta el toast.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, Subject, of, throwError } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', sales_units_30d: 10 };
// Con alta rotación (la tarjeta ya NO la anuncia) y con escalera de mayoreo (que desde [MCP.3.6] sí).
const kinder = {
  ...base, id: 'a', product_id: 'a', product_name: 'Kinder Delice 10P', sku: '1', price: 17,
  stock_available: 50, rotation_tier: 'alta', tiers: [{ min_qty: 3, price: 13.69 }],
};
const serenata = { ...base, id: 'b', product_id: 'b', product_name: 'Serenata de Amor 825g', sku: '2', price: 123.75, stock_available: 0 };

type Resp = unknown | (() => Observable<unknown>);

function montar(extra: Record<string, Resp> = {}) {
  const respuestas: Record<string, Resp> = {
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
      return () => {
        const r = respuestas[prop];
        return typeof r === 'function' ? (r as () => Observable<unknown>)() : of(prop in respuestas ? r : null);
      };
    },
  }) as unknown as VendorService;
  const avisos: { severity?: string; summary?: string; detail?: string }[] = [];
  const shellToast = { add: (m: { severity?: string; summary?: string; detail?: string }) => avisos.push(m) };
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      // El MessageService del shell /vendor (vendor-shell.component.ts, el que tiene <p-toast>).
      { provide: MessageService, useValue: shellToast },
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
  return { fixture, cmp, avisos, el: fixture.nativeElement as HTMLElement };
}

/** La fila del catálogo de un producto (por su nombre). */
function fila(el: HTMLElement, nombre: string): HTMLElement | undefined {
  return Array.from(el.querySelectorAll<HTMLElement>('.prod')).find((r) => r.textContent?.includes(nombre));
}

type Privado = {
  flushQty(): Observable<void>;
  reloadCart(after?: () => void): void;
  pendingQty(): Map<string, number>;
};

describe('Tomar pedido · avisos que sí llegan [MCP.3.5]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ si el servidor rechaza el renglón: el aviso llega al toast del shell y queda pegado a la fila', () => {
    const { cmp, avisos, fixture, el } = montar({
      ensureDraftForCustomer: { id: 'o1' },
      addLine: () => throwError(() => ({ status: 400, error: { message: 'El producto no tiene precio en tu lista' } })),
    });
    const p = cmp.prices().find((x) => x.product_id === 'a')!;
    cmp.incProduct(p);
    fixture.detectChanges();
    // La cantidad sí vuelve a 0 (el renglón no existe)…
    expect(cmp.cartQty('a')).toBe(0);
    // …pero ya no en silencio: el toast del shell lo recibió con el motivo del servidor.
    const err = avisos.find((a) => a.severity === 'error');
    expect(err?.detail).toBe('El producto no tiene precio en tu lista');
    // Y queda escrito bajo la fila, que el toast se va solo.
    expect(fila(el, 'Kinder')?.querySelector('.row-err')?.textContent).toContain('El producto no tiene precio en tu lista');
    expect(fila(el, 'Serenata')?.querySelector('.row-err')).toBeNull();
  });

  it('el aviso de la fila se limpia en el siguiente intento que sí entra', () => {
    let falla = true;
    const { cmp, fixture, el } = montar({
      ensureDraftForCustomer: { id: 'o1' },
      addLine: () => (falla ? throwError(() => ({ status: 0 })) : of({})),
      orderById: { id: 'o1', lines: [{ id: 'l1', product_id: 'a', quantity: 1, line_subtotal: 17, line_tax: 0, unit_price: 17 }] },
    });
    const p = cmp.prices().find((x) => x.product_id === 'a')!;
    cmp.incProduct(p);
    fixture.detectChanges();
    expect(fila(el, 'Kinder')?.querySelector('.row-err')?.textContent).toContain('Sin conexión');
    falla = false;
    cmp.incProduct(p);
    fixture.detectChanges();
    expect(fila(el, 'Kinder')?.querySelector('.row-err')).toBeNull();
    expect(cmp.cartQty('a')).toBe(1);
  });

  it('⭐ un flush sin pedido mientras el pedido está naciendo NO borra la cantidad pendiente', () => {
    const naciendo = new Subject<{ id: string }>();
    const { cmp } = montar({ ensureDraftForCustomer: () => naciendo });
    const p = cmp.prices().find((x) => x.product_id === 'a')!;
    cmp.incProduct(p); // crea: pendiente = 1, pedido todavía sin id
    cmp.incProduct(p); // el vendedor sigue tocando: pendiente = 2
    expect(cmp.cartQty('a')).toBe(2);
    let completo = false;
    (cmp as unknown as Privado).flushQty().subscribe(() => (completo = true));
    expect(completo).toBe(true);
    // Prueba negativa del defecto: antes esto quedaba en 0 sin ningún mensaje.
    expect(cmp.cartQty('a')).toBe(2);
    expect((cmp as unknown as Privado).pendingQty().get('a')).toBe(2);
  });

  it('entre "el servidor creó el renglón" y "el carrito ya lo trae", un flush no tira la cantidad', () => {
    const lectura = new Subject<unknown>();
    const { cmp } = montar({ ensureDraftForCustomer: { id: 'o1' }, addLine: { id: 'l1' }, orderById: () => lectura });
    const p = cmp.prices().find((x) => x.product_id === 'a')!;
    cmp.incProduct(p); // creado en el servidor; la recarga del carrito sigue en vuelo
    cmp.incProduct(p); // el vendedor sube a 2 antes de que vuelva
    (cmp as unknown as Privado).flushQty().subscribe();
    expect(cmp.cartQty('a')).toBe(2);
  });

  it('⭐ una lectura vieja del pedido que llega tarde no pisa a la nueva', () => {
    const lecturas: Subject<unknown>[] = [];
    const { cmp } = montar({ orderById: () => { const s = new Subject<unknown>(); lecturas.push(s); return s; } });
    cmp.cartOrderId.set('o1');
    const priv = cmp as unknown as Privado;
    let despues = 0;
    priv.reloadCart(() => despues++);
    priv.reloadCart(() => despues++);
    const linea = (q: number) => ({ id: 'l1', product_id: 'a', quantity: q, line_subtotal: 17 * q, line_tax: 0, unit_price: 17 });
    lecturas[1].next({ id: 'o1', lines: [linea(5)] });
    lecturas[0].next({ id: 'o1', lines: [linea(1)] }); // la vieja, tarde
    expect(cmp.cartLines().map((l) => Number(l.quantity))).toEqual([5]);
    // `after` se sigue llamando en las dos (submit depende de eso).
    expect(despues).toBe(2);
  });

  it('si la lectura del pedido falla, se avisa en vez de quedarse callado', () => {
    const { cmp, avisos } = montar({ orderById: () => throwError(() => ({ status: 0 })) });
    cmp.cartOrderId.set('o1');
    (cmp as unknown as Privado).reloadCart();
    expect(avisos.some((a) => a.summary === 'No se pudo actualizar el pedido')).toBe(true);
  });
});

describe('Tomar pedido · tarjeta de producto [MCP.3.5]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('las tarjetas ya no anuncian «Alta rotación» (el mayoreo volvió en [MCP.3.6], en su propio renglón)', () => {
    const { fixture, el } = montar();
    fixture.detectChanges();
    const k = fila(el, 'Kinder');
    expect(k).toBeTruthy();
    const filas = Array.from(el.querySelectorAll('.prod')).map((r) => r.textContent ?? '').join(' ');
    expect(filas).not.toMatch(/rotaci/i);
  });

  it('no aparece la palabra «stock» en lo que ve el vendedor: dice «existencias»', () => {
    const { fixture, el } = montar();
    fixture.detectChanges();
    expect(el.textContent ?? '').not.toMatch(/stock/i);
    expect(fila(el, 'Kinder')?.querySelector('.stk')?.textContent?.trim()).toBe('Existencias: 50');
    expect(fila(el, 'Serenata')?.querySelector('.stk')?.textContent?.trim()).toBe('Sin existencias');
  });
});
