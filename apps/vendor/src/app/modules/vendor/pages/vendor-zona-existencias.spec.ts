// `[MCP.3.12]` En cada producto de Tomar pedido, la existencia de las sucursales de la zona.
//
// Pedido de David (2026-10-23): «que vean las existencias de cada sucursal en un tamaño discreto
// pero visible». La prueba monta la pantalla real con un doble de VendorService y mira lo que se
// PINTA: la tira, en la unidad elegida, «—» para sin dato, y el aviso cuando no se pudo leer.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { NEVER, of, throwError } from 'rxjs';
import type { VendorZoneStockResponse } from '@megadulces/contracts';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import { ariaZona, chipsDeZona, edadZona } from '../zona-existencias';
import type { PriceRow } from '../../portal/portal.service';

const ZONA: VendorZoneStockResponse = {
  zone: 'La Piedad',
  warehouses: [
    { id: 'w2', code: '02', short: 'LPA', name: 'La Piedad Abastos', mine: true, as_of: '2026-10-23T19:00:00Z' },
    { id: 'w1', code: '01', short: 'PH', name: 'Padre Hidalgo', mine: false, as_of: '2026-10-23T19:05:00Z' },
    { id: 'w3', code: '03', short: '8ES', name: '8 Esquinas', mine: false, as_of: '2026-10-23T18:50:00Z' },
    { id: 'w4', code: '04', short: 'YU', name: 'Yurécuaro', mine: false, as_of: null },
  ],
  // Pulparindo: 0 en la mía, 280 piezas en PH (= 14 CJA de 20), 120 en 8ES, sin renglón en YU.
  stock: { p1: [0, 280, 120, null] },
  unmeasured_reason: null,
};

describe('chipsDeZona / edadZona · [MCP.3.12]', () => {
  it('⭐ en la unidad elegida, «—» para sin dato, la mía marcada', () => {
    const c = chipsDeZona(ZONA, 'p1', 20)!;
    expect(c.map((x) => `${x.short} ${x.texto}`)).toEqual(['LPA 0', 'PH 14', '8ES 6', 'YU —']);
    expect(c.map((x) => x.mine)).toEqual([true, false, false, false]);
    expect(chipsDeZona(ZONA, 'p1', 1)!.map((x) => x.texto)).toEqual(['0', '280', '120', '—']);
  });

  it('⛔ no se pinta lo que no se puede afirmar o no aporta', () => {
    expect(chipsDeZona(null, 'p1', 1)).toBeNull();
    expect(chipsDeZona({ ...ZONA, unmeasured_reason: 'sin zona' }, 'p1', 1)).toBeNull();
    expect(chipsDeZona({ ...ZONA, warehouses: [ZONA.warehouses[0]], stock: { p1: [3] } }, 'p1', 1)).toBeNull();
    expect(chipsDeZona(ZONA, 'otro', 1)).toBeNull();
  });

  it('el lector de pantalla oye nombres completos y «sin dato»', () => {
    const t = ariaZona(chipsDeZona(ZONA, 'p1', 20)!, 'CJA');
    expect(t).toBe('Existencias en tu zona, en CJA: La Piedad Abastos (tu sucursal) 0, Padre Hidalgo 14, 8 Esquinas 6, Yurécuaro sin dato');
  });

  it('la edad es la de la OTRA sucursal más vieja (la mía no cuenta)', () => {
    expect(edadZona(ZONA, Date.parse('2026-10-23T19:12:00Z'))).toBe('hace 22 min');
    expect(edadZona({ ...ZONA, warehouses: ZONA.warehouses.map((w) => ({ ...w, as_of: null })) }, Date.now())).toBeNull();
  });
});

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, stock_available: 0, currency: 'MXN' };
const pulparindo = {
  ...base,
  id: 'pr1',
  product_id: 'p1',
  product_name: 'Pulparindo 20 pz',
  sku: '2001',
  price: 2.5,
  sales_units_30d: 300,
  rungs: [
    { rung: 'base', unit: 'PZA', factor: 1, price: 2.5, volume_min_qty: null, volume_price: null },
    { rung: 'box', unit: 'CJA', factor: 20, price: 45, volume_min_qty: null, volume_price: null },
  ],
  units: [
    { unit: 'PZA', factor: 1 },
    { unit: 'CJA', factor: 20 },
  ],
  units_source: 'kepler_ladder',
} as unknown as PriceRow;
const sinZona = { ...pulparindo, id: 'pr2', product_id: 'p2', product_name: 'Mazapan 30 pz', sku: '2002' } as unknown as PriceRow;

function montar(zona: () => unknown, espias: Record<string, (...a: unknown[]) => unknown> = {}) {
  const respuestas: Record<string, unknown> = {
    myStockSources: { sucursal: { id: 'w2', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'CLI-1', name: 'Abarrotes Lupita', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogForCustomer: { priceListId: 'pl1', prices: [pulparindo, sinZona] },
    catalogInstant: { priceListId: 'pl1', prices: [pulparindo, sinZona], origen: 'servidor', at: Date.now() },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
    // Tras guardar un renglón la pantalla relee el pedido.
    orderById: { id: 'o1', lines: [] },
  };
  const api = new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (prop === 'myZoneStock') return zona;
        if (prop in espias) return espias[prop];
        return () => of(prop in respuestas ? respuestas[prop] : null);
      },
    },
  ) as unknown as VendorService;
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: VendorService, useValue: api },
      { provide: ConnectivityService, useValue: { isOnline: () => true } },
      { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve() } },
      { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(VendorTakeOrderComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const buscar = (t: string) => {
    fixture.componentInstance.searchTerm.set(t);
    fixture.detectChanges();
  };
  const filaDe = (nombre: string) =>
    Array.from(el.querySelectorAll('.prod')).find((f) => f.querySelector('.pn')?.textContent?.includes(nombre));
  const tiraDe = (nombre: string): string | null => {
    const z = filaDe(nombre)?.querySelector('.zs');
    if (!z) return null;
    // Cada chip por separado: el espacio entre ellos lo pone el CSS (gap), no el texto.
    return Array.from(z.querySelectorAll('.zs-c, .zs-u')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()).join(' ');
  };
  const aviso = () => Array.from(el.querySelectorAll('.cat-age')).map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim());
  return { fixture, el, buscar, filaDe, tiraDe, aviso, cmp: fixture.componentInstance };
}

describe('Tomar pedido · existencias de la zona [MCP.3.12]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ el producto muestra la tira de su zona, y cambia con la unidad elegida', () => {
    const { buscar, tiraDe, cmp, fixture } = montar(() => of(ZONA));
    buscar('pulparindo');
    expect(tiraDe('Pulparindo')).toMatch(/^LPA 0 PH \d+ 8ES \d+ YU — (PZA|CJA)$/);
    const p = cmp.prices().find((x) => x.product_id === 'p1')!;
    cmp.setUnit(p, 'CJA');
    fixture.detectChanges();
    expect(tiraDe('Pulparindo')).toBe('LPA 0 PH 14 8ES 6 YU — CJA');
    cmp.setUnit(p, 'PZA');
    fixture.detectChanges();
    expect(tiraDe('Pulparindo')).toBe('LPA 0 PH 280 8ES 120 YU — PZA');
  });

  it('un producto sin existencia en la zona no lleva tira; el aviso dice de cuándo es', () => {
    const { buscar, tiraDe, aviso } = montar(() => of(ZONA));
    buscar('mazapan');
    expect(tiraDe('Mazapan')).toBeNull();
    expect(aviso().some((t) => t.startsWith('Zona La Piedad: existencias de las otras sucursales'))).toBe(true);
  });

  it('⛔ si la zona no se pudo leer: ninguna tira y se dice, nunca ceros', () => {
    const { buscar, tiraDe, aviso } = montar(() => throwError(() => ({ status: 500 })));
    buscar('pulparindo');
    expect(tiraDe('Pulparindo')).toBeNull();
    expect(aviso()).toContain('No se pudo leer la existencia de las otras sucursales de tu zona');
  });

  it('⛔ sin zona declarada: el motivo, sin tira', () => {
    const { buscar, tiraDe, aviso } = montar(() =>
      of({ zone: null, warehouses: [], stock: {}, unmeasured_reason: 'No tienes sucursal de surtido asignada.' }));
    buscar('pulparindo');
    expect(tiraDe('Pulparindo')).toBeNull();
    expect(aviso()).toContain('Otras sucursales: No tienes sucursal de surtido asignada.');
  });

  it('⭐ [MCP.3.13] sin renglón: tocar PH la deja elegida y el «+» crea el renglón CON esa sucursal', () => {
    const addLine = vi.fn(() => of({ id: 'l1', product_id: 'p1', quantity: 20 }));
    const { buscar, filaDe, cmp, fixture } = montar(() => of(ZONA), {
      addLine,
      ensureDraftForCustomer: () => of({ id: 'o1' }),
    });
    buscar('pulparindo');
    const ph = Array.from(filaDe('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('PH')) as HTMLButtonElement;
    ph.click();
    fixture.detectChanges();
    expect(ph.getAttribute('aria-checked')).toBe('true');
    const p = cmp.prices().find((x) => x.product_id === 'p1')!;
    cmp.incProduct(p);
    expect(addLine).toHaveBeenCalled();
    expect((addLine.mock.calls[0] as unknown[])[4]).toBe('w1');
  });

  it('⭐ [MCP.3.13] con renglón: tocar PH lo MUEVE a esa sucursal (updateLine con origen)', () => {
    const updateLine = vi.fn(() => of({}));
    const { buscar, filaDe, cmp, fixture } = montar(() => of(ZONA), { updateLine });
    cmp.cartOrderId.set('o1');
    cmp.cartLines.set([{ id: 'l1', order_id: 'o1', product_id: 'p1', line_number: 1, quantity: 40, unit_price: 2.5, tax_rate: 0, discount_percent: 0, line_subtotal: 100, line_tax: 0, line_total: 100, source_warehouse_id: null }]);
    buscar('pulparindo');
    const ph = Array.from(filaDe('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('PH')) as HTMLButtonElement;
    ph.click();
    fixture.detectChanges();
    expect(updateLine).toHaveBeenCalledWith('o1', 'l1', 40, undefined, 'w1');
  });

  it('⛔ [MCP.3.13] tocar la sucursal en la que ya está no manda nada', () => {
    const updateLine = vi.fn(() => of({}));
    const { buscar, filaDe, cmp } = montar(() => of(ZONA), { updateLine });
    cmp.cartOrderId.set('o1');
    cmp.cartLines.set([{ id: 'l1', order_id: 'o1', product_id: 'p1', line_number: 1, quantity: 40, unit_price: 2.5, tax_rate: 0, discount_percent: 0, line_subtotal: 100, line_tax: 0, line_total: 100, source_warehouse_id: 'w1' }]);
    buscar('pulparindo');
    const ph = Array.from(filaDe('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('PH')) as HTMLButtonElement;
    expect(ph.getAttribute('aria-checked')).toBe('true');
    ph.click();
    expect(updateLine).not.toHaveBeenCalled();
  });

  it('[MCP.3.13] el carrito dice dónde se surte: «LPA (1) · PH (1)»; todo de la mía = sin resumen', () => {
    const { cmp } = montar(() => of(ZONA));
    const base = { order_id: 'o1', line_number: 1, quantity: 1, unit_price: 1, tax_rate: 0, discount_percent: 0, line_subtotal: 1, line_tax: 0, line_total: 1 };
    cmp.cartLines.set([{ ...base, id: 'a', product_id: 'p2', source_warehouse_id: null }]);
    expect(cmp.surteEn()).toBeNull();
    cmp.cartLines.set([
      { ...base, id: 'a', product_id: 'p2', source_warehouse_id: null },
      { ...base, id: 'b', product_id: 'p1', source_warehouse_id: 'w1', source_warehouse_short: 'PH' },
    ]);
    expect(cmp.surteEn()!.map((g) => `${g.label} (${g.n})`)).toEqual(['LPA (1)', 'PH (1)']);
  });

  it('la zona tarda o no responde: la pantalla abre igual (no espera a la zona)', () => {
    const { buscar, filaDe } = montar(() => NEVER);
    buscar('pulparindo');
    expect(filaDe('Pulparindo')).toBeTruthy();
  });
});
