// `[MCP.3.16]` Tomar pedido: el ESTADO de la existencia de cada producto y el bloqueo al agregar.
//
// Regla de David con su PM (2026-10-27), por producto y por sucursal:
//   · con registro y cantidad > 0  → «Existencias: N CJA» (o «5 pzas» si no completa una caja);
//   · con registro y <= 0          → ROJO «Sin existencias» — bloquea agregar;
//   · sin registro (al día)        → GRIS «Sin existencias en LPA», al final del catálogo — bloquea;
//   · lectura vieja o fallida      → GRIS «Sin dato de existencia» — NO bloquea.
// Al bloquear, se dice quién de la zona sí tiene, o que nadie de la zona tiene.
//
// Monta la pantalla real con un doble de VendorService (patrón de vendor-zona-existencias.spec.ts)
// y mira lo que se PINTA y lo que se llama al servidor. Cada regla lleva su prueba negativa.
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, of, throwError } from 'rxjs';
import { bloqueaAgregar, type StockState, type VendorZoneStockResponse } from '@megadulces/contracts';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import { PortalService, type PriceRow } from '../../portal/portal.service';
import {
  alternativasEnZona,
  cantidadEnUnidad,
  chipsDeZona,
  estadoEnZona,
  mensajeBloqueo,
  nadieEnZona,
} from '../zona-existencias';

const AHORA = new Date().toISOString();
const HACE_7H = new Date(Date.now() - 7 * 3_600_000).toISOString();
const HACE_1H = new Date(Date.now() - 1 * 3_600_000).toISOString();

const w = (id: string, code: string, short: string, name: string, mine: boolean, stale = false) => ({
  id, code, short, name, mine, stale, as_of: AHORA, checked_at: AHORA,
});
/** La Piedad, contrato nuevo: LPA es la mía. Pulparindo: 0 en LPA, 280 piezas en PH, 120 en 8ES, YU sin registro. */
const ZONA: VendorZoneStockResponse = {
  zone: 'La Piedad',
  warehouses: [
    w('w2', '02', 'LPA', 'La Piedad Abastos', true),
    w('w1', '01', 'PH', 'Padre Hidalgo', false),
    w('w3', '03', '8ES', '8 Esquinas', false),
    w('w4', '04', 'YU', 'Yurécuaro', false),
  ],
  stock: { p1: [0, 280, 120, null], p4: [0, 0, 30, null] },
  unmeasured_reason: null,
};
/** La misma zona con PH vieja: su celda viene en null y es «sin dato». */
const ZONA_PH_VIEJA: VendorZoneStockResponse = {
  ...ZONA,
  warehouses: ZONA.warehouses.map((x) => (x.short === 'PH' ? { ...x, stale: true } : x)),
  stock: { p1: [0, null, 120, null] },
};

const rungs = [
  { rung: 'base', unit: 'PZA', factor: 1, price: 2.5, volume_min_qty: null, volume_price: null },
  { rung: 'box', unit: 'CJA', factor: 20, price: 45, volume_min_qty: null, volume_price: null },
];
const units = [{ unit: 'PZA', factor: 1 }, { unit: 'CJA', factor: 20 }];
const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', price: 2.5, rungs, units, units_source: 'kepler_ladder' };
function prod(id: string, nombre: string, state: StockState | undefined, stock: number | null, checked: string | null = AHORA): PriceRow {
  return {
    ...base, id: 'pr-' + id, product_id: id, product_name: nombre, sku: id,
    stock_available: stock,
    ...(state === undefined ? {} : { stock_state: state, stock_checked_at: checked, stock_twin_product_id: null }),
  } as unknown as PriceRow;
}
// El orden del arreglo es el «más vendido primero» del servidor; Mazapán va primero A PROPÓSITO
// (no se maneja) para probar que la pantalla lo manda al final sin mover a los demás.
const mazapan = prod('p2', 'Mazapan 30 pz', 'no_se_maneja', null);
const kinder = prod('p3', 'Kinder Delice', 'con_existencia', 50);
const pulparindo = prod('p1', 'Pulparindo 20 pz', 'agotado', 0);
const gomitas = prod('p4', 'Gomitas Panditas', 'sin_dato', null);
const bubulubu = prod('p5', 'Bubulubu', 'con_existencia', 5);

type Resp = unknown | ((...a: unknown[]) => Observable<unknown>);

function montar(o: {
  prices?: PriceRow[];
  zona?: () => Observable<unknown>;
  extra?: Record<string, Resp>;
} = {}) {
  const llamadas: Record<string, unknown[][]> = {};
  const prices = o.prices ?? [mazapan, kinder, pulparindo, gomitas, bubulubu];
  const respuestas: Record<string, Resp> = {
    myStockSources: { sucursal: { id: 'w2', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'CLI-1', name: 'Abarrotes Lupita', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices, origen: 'servidor', at: Date.now() },
    catalogForCustomer: { priceListId: 'pl1', prices },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
    orderById: { id: 'o1', lines: [] },
    ensureDraftForCustomer: { id: 'o1' },
    addLine: { id: 'l1' },
    updateLine: {},
    myZoneStock: o.zona ?? (() => of(ZONA)),
    ...(o.extra ?? {}),
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]) => {
        (llamadas[prop] ??= []).push(a);
        const r = respuestas[prop];
        return typeof r === 'function' ? (r as (...x: unknown[]) => Observable<unknown>)(...a) : of(prop in respuestas ? r : null);
      };
    },
  }) as unknown as VendorService;
  const toast = { add: vi.fn() };
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      { provide: MessageService, useValue: toast },
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
  const el = fixture.nativeElement as HTMLElement;
  const pintar = () => fixture.detectChanges();
  const filas = () => Array.from(el.querySelectorAll('.catalog .prod'));
  const fila = (nombre: string) => filas().find((f) => f.querySelector('.pn')?.textContent?.includes(nombre));
  const stk = (nombre: string) => fila(nombre)?.querySelector('.stk') as HTMLElement | null;
  const texto = (e: Element | null | undefined) => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const p = (id: string) => cmp.prices().find((x) => x.product_id === id)!;
  const n = (m: string) => (llamadas[m] ?? []).length;
  const toastDe = (summary: string) => toast.add.mock.calls.map((c) => c[0] as { summary: string; detail: string }).filter((t) => t.summary === summary);
  const resumenes = () => toast.add.mock.calls.map((c) => (c[0] as { summary: string }).summary);
  return { fixture, cmp, el, pintar, fila, filas, stk, texto, p, n, llamadas, toastDe, resumenes };
}

describe('Tomar pedido · estado de la existencia [MCP.3.16]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ los cuatro estados: texto y color', () => {
    const { stk, texto } = montar();
    expect(texto(stk('Kinder'))).toBe('Existencias: 50 pzas');
    expect(stk('Kinder')!.classList).toContain('ok');
    expect(texto(stk('Pulparindo'))).toBe('Sin existencias');
    expect(stk('Pulparindo')!.classList).toContain('bad');
    expect(texto(stk('Mazapan'))).toBe('Sin existencias en LPA');
    expect(stk('Mazapan')!.classList).toContain('nd');
    expect(stk('Mazapan')!.classList).not.toContain('bad');
    expect(texto(stk('Gomitas'))).toBe('Sin dato de existencia');
    expect(stk('Gomitas')!.classList).toContain('nd');
  });

  it('⭐ en cajas: «2 CJA»; si no completa una caja, en piezas y en ámbar (nunca «0 CJA» en verde)', () => {
    const { cmp, pintar, stk, texto, p } = montar({ prices: [bubulubu, prod('p6', 'Duvalin', 'con_existencia', 40)] });
    cmp.setUnit(p('p5'), 'CJA');
    cmp.setUnit(p('p6'), 'CJA');
    pintar();
    expect(texto(stk('Bubulubu'))).toBe('Existencias: 5 pzas');
    expect(stk('Bubulubu')!.classList).toContain('warn');
    expect(stk('Bubulubu')!.classList).not.toContain('ok');
    expect(texto(stk('Duvalin'))).toBe('Existencias: 2 CJA');
    expect(stk('Duvalin')!.classList).toContain('ok');
  });

  it('⛔ negativa: sin stock_state (servidor viejo) la etiqueta es la de siempre', () => {
    const { stk, texto } = montar({ prices: [prod('p3', 'Kinder Delice', undefined, 50), prod('p2', 'Mazapan 30 pz', undefined, 0)] });
    expect(texto(stk('Kinder'))).toBe('Existencias: 50');
    expect(texto(stk('Mazapan'))).toBe('Sin existencias');
    expect(stk('Mazapan')!.classList).toContain('bad');
  });

  it('⛔ una copia guardada con la lectura de hace 7 h se lee «sin dato» y no bloquea; de hace 1 h, sí', () => {
    const viejo = montar({ prices: [prod('p1', 'Pulparindo 20 pz', 'agotado', 0, HACE_7H)] });
    expect(viejo.texto(viejo.stk('Pulparindo'))).toBe('Sin dato de existencia');
    viejo.cmp.incProduct(viejo.p('p1'));
    expect(viejo.n('addLine')).toBe(1);
    TestBed.resetTestingModule();
    const reciente = montar({ prices: [prod('p1', 'Pulparindo 20 pz', 'agotado', 0, HACE_1H)] });
    expect(reciente.texto(reciente.stk('Pulparindo'))).toBe('Sin existencias');
    reciente.cmp.incProduct(reciente.p('p1'));
    expect(reciente.n('addLine')).toBe(0);
  });

  it('⭐ orden: lo que la sucursal no maneja va al final sin mover el orden por venta del resto', () => {
    const { filas, texto } = montar();
    expect(filas().map((f) => texto(f.querySelector('.pn')))).toEqual([
      'Kinder Delice', 'Pulparindo 20 pz', 'Gomitas Panditas', 'Bubulubu', 'Mazapan 30 pz',
    ]);
  });

  it('⛔ negativa del orden: sin stock_state la pantalla no reordena nada', () => {
    const sin = [mazapan, kinder].map((x) => ({ ...x, stock_state: undefined }) as PriceRow);
    const { filas, texto } = montar({ prices: sin });
    expect(filas().map((f) => texto(f.querySelector('.pn')))).toEqual(['Mazapan 30 pz', 'Kinder Delice']);
  });
});

describe('Tomar pedido · la tira de la zona con frescura [MCP.3.16]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ nadie de la zona lo tiene (zona medida, todas al día): «Nadie en tu zona tiene»', () => {
    const { fila, texto } = montar();
    expect(texto(fila('Mazapan')!.querySelector('.zs-none'))).toBe('Nadie en tu zona tiene');
    // El que sí tiene en la zona lleva su tira, no el aviso.
    expect(fila('Pulparindo')!.querySelector('.zs-none')).toBeNull();
  });

  it('⛔ negativa: con una sucursal vieja NO se afirma «nadie tiene»; la vieja sale «—», nunca 0', () => {
    const { fila, texto } = montar({ zona: () => of(ZONA_PH_VIEJA) });
    expect(fila('Mazapan')!.querySelector('.zs-none')).toBeNull();
    const tira = (nombre: string) =>
      Array.from(fila(nombre)!.querySelectorAll('.zs-c, .zs-u')).map((c) => texto(c)).join(' ');
    expect(tira('Mazapan')).toBe('LPA 0 PH — 8ES 0 YU 0 PZA');
    expect(tira('Pulparindo')).toBe('LPA 0 PH — 8ES 120 YU 0 PZA');
  });

  it('⛔ negativa: con un servidor viejo (sin `stale`) no sale «Nadie en tu zona tiene»', () => {
    const vieja = { ...ZONA, warehouses: ZONA.warehouses.map(({ stale: _s, checked_at: _c, ...x }) => x) };
    const { fila } = montar({ zona: () => of(vieja) });
    expect(fila('Mazapan')!.querySelector('.zs-none')).toBeNull();
  });

  it('el aviso de la zona nombra las sucursales sin dato reciente', () => {
    const { el, texto } = montar({ zona: () => of(ZONA_PH_VIEJA) });
    const avisos = Array.from(el.querySelectorAll('.cat-age')).map((x) => texto(x));
    expect(avisos.some((t) => t.includes('sin dato reciente de PH'))).toBe(true);
  });
});

describe('Tomar pedido · bloqueo al agregar [MCP.3.16]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ agotado en la mía y otra de la zona tiene: no llama al servidor, no cambia la cantidad, y dice quién tiene', () => {
    const { cmp, pintar, fila, texto, p, n, toastDe } = montar();
    cmp.incProduct(p('p1'));
    pintar();
    expect(n('ensureDraftForCustomer')).toBe(0);
    expect(n('addLine')).toBe(0);
    expect(cmp.cartQty('p1')).toBe(0);
    const msg = 'No se puede agregar: no hay existencias en LPA · PH tiene 280 pzas · 8ES tiene 120 pzas';
    expect(texto(fila('Pulparindo')!.querySelector('.row-err'))).toBe(msg);
    expect(toastDe('No se puede agregar').map((t) => t.detail)).toEqual([msg]);
  });

  it('las alternativas se dicen en la unidad que se pide', () => {
    const { cmp, pintar, fila, texto, p } = montar();
    cmp.setUnit(p('p1'), 'CJA');
    cmp.incProduct(p('p1'));
    pintar();
    expect(texto(fila('Pulparindo')!.querySelector('.row-err'))).toBe('No se puede agregar: no hay existencias en LPA · PH tiene 14 CJA · 8ES tiene 6 CJA');
  });

  it('⭐ no se maneja y nadie de la zona tiene: «No se puede agregar un producto que no hay en tu zona»', () => {
    const { cmp, pintar, fila, texto, p, n } = montar();
    cmp.incProduct(p('p2'));
    pintar();
    expect(n('addLine')).toBe(0);
    expect(texto(fila('Mazapan')!.querySelector('.row-err'))).toBe('No se puede agregar un producto que no hay en tu zona');
  });

  it('⛔ negativa: si la zona no se pudo leer, no se afirma «nadie en tu zona»', () => {
    const { cmp, pintar, fila, texto, p, n } = montar({ zona: () => throwError(() => ({ status: 500 })) });
    cmp.incProduct(p('p2'));
    pintar();
    expect(n('addLine')).toBe(0);
    expect(texto(fila('Mazapan')!.querySelector('.row-err'))).toBe('No se puede agregar: no hay existencias en La Piedad Abastos');
  });

  it('⛔ negativa: con existencia SÍ se agrega (y la cantidad mayor a lo que hay no bloquea)', () => {
    const { cmp, p, n, toastDe } = montar();
    cmp.setQtyTyped(p('p3'), 80);
    expect(n('addLine')).toBe(1);
    expect(toastDe('No se puede agregar')).toHaveLength(0);
    expect(toastDe('Pocas existencias hoy').map((t) => t.detail)).toEqual(['Hoy hay 50. Es preventa: se surte al repartir.']);
  });

  it('⭐ sin dato NO bloquea', () => {
    const { cmp, p, n, toastDe } = montar();
    cmp.incProduct(p('p4'));
    expect(n('addLine')).toBe(1);
    expect(toastDe('No se puede agregar')).toHaveLength(0);
  });

  it('⭐ escribir la cantidad desde 0 también se bloquea, y la casilla vuelve a vacío', () => {
    const { cmp, p, n } = montar();
    const input = document.createElement('input');
    input.value = '3';
    cmp.setQtyTyped(p('p1'), '3', input);
    expect(n('addLine')).toBe(0);
    expect(input.value).toBe('');
    expect(cmp.cartQty('p1')).toBe(0);
  });

  it('⭐ elegir en la tira una sucursal que sí tiene destraba el «+» (se surte de allá)', () => {
    const { cmp, pintar, fila, texto, p, llamadas } = montar();
    cmp.incProduct(p('p1'));
    pintar();
    const ochoEs = Array.from(fila('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('8ES')) as HTMLButtonElement;
    ochoEs.click();
    pintar();
    // El error del intento anterior se limpia al elegir una sucursal válida.
    expect(fila('Pulparindo')!.querySelector('.row-err')).toBeNull();
    cmp.incProduct(p('p1'));
    expect(llamadas['addLine']).toHaveLength(1);
    expect(llamadas['addLine'][0][4]).toBe('w3');
    expect(texto(fila('Pulparindo')!.querySelector('button.zs-c.on'))).toContain('8ES');
  });

  it('⛔ elegir una sucursal sin existencias no se deja (sin renglón: no queda elegida; con renglón: no se mueve)', () => {
    const { cmp, pintar, fila, texto, p, n } = montar();
    const yu = () => Array.from(fila('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('YU')) as HTMLButtonElement;
    yu().click();
    pintar();
    expect(yu().getAttribute('aria-checked')).toBe('false');
    expect(texto(fila('Pulparindo')!.querySelector('.row-err'))).toBe('No se puede agregar: no hay existencias en YU · PH tiene 280 pzas · 8ES tiene 120 pzas');
    // Con renglón (surtido de PH), moverlo a YU tampoco llega al servidor.
    cmp.cartOrderId.set('o1');
    cmp.cartLines.set([{ id: 'l1', order_id: 'o1', product_id: 'p1', line_number: 1, quantity: 20, unit_price: 2.5, tax_rate: 0, discount_percent: 0, line_subtotal: 50, line_tax: 0, line_total: 50, source_warehouse_id: 'w1' }]);
    pintar();
    yu().click();
    expect(n('updateLine')).toBe(0);
  });

  it('⭐ «Pocas existencias» se compara contra la sucursal de surtido elegida, no contra la propia', () => {
    const { cmp, pintar, fila, p, toastDe } = montar();
    const chip = (s: string) => Array.from(fila('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith(s)) as HTMLButtonElement;
    chip('8ES').click();
    pintar();
    cmp.setQtyTyped(p('p1'), 200);
    expect(toastDe('Pocas existencias hoy').map((t) => t.detail)).toEqual(['Hoy hay 120 en 8ES. Es preventa: se surte al repartir.']);
  });

  it('⛔ negativa: surtiendo de PH (280), 200 piezas no avisan aunque la propia tenga 0', () => {
    const { cmp, pintar, fila, p, toastDe, n } = montar();
    const ph = Array.from(fila('Pulparindo')!.querySelectorAll('button.zs-c')).find((b) => b.textContent?.startsWith('PH')) as HTMLButtonElement;
    ph.click();
    pintar();
    cmp.setQtyTyped(p('p1'), 200);
    expect(n('addLine')).toBe(1);
    expect(toastDe('Pocas existencias hoy')).toHaveLength(0);
  });

  it('⭐ el 409 SIN_EXISTENCIA con alternativas se dice en la unidad que se pide (el servidor manda unidad base)', () => {
    // El servidor sólo sabe la unidad base: «PH tiene 280», sin rótulo. La tira dice cajas.
    const delServidor = 'No se puede agregar: no hay existencias en LPA · PH tiene 280';
    const bloqueo409 = () => throwError(() => ({
      status: 409,
      error: { code: 'SIN_EXISTENCIA', message: delServidor, product_id: 'p3', product_name: 'Kinder Delice', warehouse_id: 'w2', warehouse_short: 'LPA', state: 'agotado', alternatives: [{ warehouse_id: 'w1', short: 'PH', qty: 280 }] },
    }));
    const { cmp, pintar, fila, texto, p, toastDe } = montar({ extra: { addLine: bloqueo409 } });
    cmp.incProduct(p('p3'));
    pintar();
    const enPiezas = 'No se puede agregar: no hay existencias en LPA · PH tiene 280 pzas';
    expect(texto(fila('Kinder')!.querySelector('.row-err'))).toBe(enPiezas);
    expect(toastDe('No se puede agregar').map((t) => t.detail)).toEqual([enPiezas]);
    expect(cmp.cartQty('p3')).toBe(0);
    TestBed.resetTestingModule();
    // En cajas de 20: 14 CJA, la misma cifra que la tira.
    const cajas = montar({ extra: { addLine: bloqueo409 } });
    cajas.cmp.setUnit(cajas.p('p3'), 'CJA');
    cajas.cmp.incProduct(cajas.p('p3'));
    cajas.pintar();
    expect(cajas.texto(cajas.fila('Kinder')!.querySelector('.row-err'))).toBe('No se puede agregar: no hay existencias en LPA · PH tiene 14 CJA');
  });

  it('⭐ el pedido sugerido deja fuera lo que no se puede agregar, el chip cuenta sólo lo que se carga, y dice qué faltó', () => {
    const frecuentes = [
      { product_id: 'p1', order_count: 3, avg_qty: 2 }, // agotado en LPA → fuera
      { product_id: 'p3', order_count: 3, avg_qty: 4 }, // con existencia → entra
      { product_id: 'p2', order_count: 2, avg_qty: 1 }, // no se maneja → fuera
      { product_id: 'p4', order_count: 2, avg_qty: 1 }, // sin dato → entra (no bloquea)
    ];
    const { cmp, llamadas, toastDe } = montar({
      extra: {
        frequentProducts: frecuentes,
        replaceLines: { order_id: 'o1', added: 1, skipped: [{ product_id: 'p4', reason: 'sin precio' }] },
      },
    });
    expect(cmp.predictedLines().map((l) => l.product_id)).toEqual(['p3', 'p4']);
    cmp.usePrefill();
    // Lo que viaja al servidor es sólo lo que se puede agregar.
    expect((llamadas['replaceLines'][0][1] as Array<{ product_id: string }>).map((l) => l.product_id)).toEqual(['p3', 'p4']);
    const aviso = toastDe('No se cargaron 3 del sugerido');
    expect(aviso).toHaveLength(1);
    expect(aviso[0].detail).toBe('Sin existencias en LPA: Pulparindo 20 pz, Mazapan 30 pz · Gomitas Panditas: sin precio');
  });

  it('⛔ negativa: si todo el sugerido se carga, no hay aviso', () => {
    const { cmp, llamadas, resumenes } = montar({
      extra: { frequentProducts: [{ product_id: 'p3', order_count: 3, avg_qty: 4 }], replaceLines: { order_id: 'o1', added: 1, skipped: [] } },
    });
    expect(cmp.predictedLines()).toHaveLength(1);
    cmp.usePrefill();
    expect(llamadas['replaceLines']).toHaveLength(1);
    expect(resumenes().filter((s) => s.startsWith('No se cargaron'))).toEqual([]);
  });

  it('⛔ el 409 SIN alternativas se muestra con el texto del servidor tal cual (él sabe si midió la zona)', () => {
    const msg = 'No se puede agregar: no hay existencias en LPA · sin dato de 8ES';
    const { cmp, pintar, fila, texto, p } = montar({
      extra: {
        addLine: () => throwError(() => ({
          status: 409,
          error: { code: 'SIN_EXISTENCIA', message: msg, product_id: 'p3', product_name: 'Kinder Delice', warehouse_id: 'w2', warehouse_short: 'LPA', state: 'agotado', alternatives: [] },
        })),
      },
    });
    cmp.incProduct(p('p3'));
    pintar();
    expect(texto(fila('Kinder')!.querySelector('.row-err'))).toBe(msg);
  });

  it('⛔ negativa: un 409 que NO es de existencias sigue el camino de siempre («No se agregó: …»)', () => {
    const { cmp, pintar, fila, texto, p, toastDe } = montar({
      extra: { addLine: () => throwError(() => ({ status: 409, error: { message: 'El pedido ya no es borrador' } })) },
    });
    cmp.incProduct(p('p3'));
    pintar();
    expect(texto(fila('Kinder')!.querySelector('.row-err'))).toBe('No se agregó: El pedido ya no es borrador');
    expect(toastDe('No se puede agregar')).toHaveLength(0);
  });

  it('⛔ sin conexión NO se bloquea (no se sabe de cuándo es el dato) y el aviso lo dice', async () => {
    const lineas: unknown[] = [];
    const ctx = { customer: { id: 'c1', name: 'Abarrotes Lupita', code: 'CLI-1' }, prices: [pulparindo, kinder], warehouseId: 'w2', frequent: [] };
    const draft = { id: 'd1', lines: [] as Array<{ product_id: string; quantity: number }> };
    TestBed.configureTestingModule({
      imports: [VendorTakeOrderComponent],
      providers: [
        provideRouter([]),
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: VendorService, useValue: {} },
        { provide: ConnectivityService, useValue: { isOnline: () => false } },
        {
          provide: OfflineOrderService,
          useValue: {
            getContext: () => Promise.resolve(ctx),
            ensureDraft: () => Promise.resolve(draft),
            getById: () => Promise.resolve(draft),
            buildLine: (pr: PriceRow, q: number) => ({ product_id: pr.product_id, quantity: q }),
            setLines: (_id: string, ls: unknown[]) => { lineas.push(...ls); return Promise.resolve(); },
            toOrderLines: (d: { lines: Array<{ product_id: string; quantity: number }> }) =>
              d.lines.map((l, i) => ({ id: 'x' + i, product_id: l.product_id, quantity: l.quantity, line_subtotal: 0, line_tax: 0, line_total: 0 })),
          },
        },
        { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
      ],
    });
    const fixture = TestBed.createComponent(VendorTakeOrderComponent);
    // La carga sin conexión encadena promesas (contexto → borrador local): se dejan correr.
    const drenar = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    fixture.detectChanges();
    await drenar();
    fixture.detectChanges();
    const cmp = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    expect(cmp.offlineMode()).toBe(true);
    expect(el.querySelector('.offline-banner')?.textContent).toContain('Sin señal no se revisa si hay existencias');
    cmp.incProduct(cmp.prices().find((x) => x.product_id === 'p1')!);
    await drenar();
    expect(lineas).toEqual([{ product_id: 'p1', quantity: 1 }]);
    fixture.detectChanges();
    expect(el.querySelector('.row-err')).toBeNull();
  });
});

describe('zona-existencias · reglas puras [MCP.3.16]', () => {
  it('estado por sucursal: al día con 0 = agotado; celda null al día = no se maneja; vieja = sin dato', () => {
    expect(estadoEnZona(ZONA, 'w1', 'p1')).toBe('con_existencia');
    expect(estadoEnZona(ZONA, 'w2', 'p1')).toBe('agotado');
    expect(estadoEnZona(ZONA, 'w4', 'p1')).toBe('no_se_maneja');
    expect(estadoEnZona(ZONA, 'w1', 'nadie')).toBe('agotado');
    expect(estadoEnZona(ZONA_PH_VIEJA, 'w1', 'p1')).toBe('sin_dato');
    expect(bloqueaAgregar(estadoEnZona(ZONA_PH_VIEJA, 'w1', 'p1'))).toBe(false);
  });

  it('⛔ sin zona, sin medir, servidor viejo o sucursal ajena: null (no bloquea)', () => {
    expect(estadoEnZona(null, 'w1', 'p1')).toBeNull();
    expect(estadoEnZona({ ...ZONA, unmeasured_reason: 'sin zona' }, 'w1', 'p1')).toBeNull();
    const vieja = { ...ZONA, warehouses: ZONA.warehouses.map(({ stale: _s, ...x }) => x) } as unknown as VendorZoneStockResponse;
    expect(estadoEnZona(vieja, 'w2', 'p1')).toBeNull();
    expect(estadoEnZona(ZONA, 'otra', 'p1')).toBeNull();
    expect(bloqueaAgregar(null)).toBe(false);
  });

  it('alternativas: al día y con existencia, mayor primero, máximo 3, sin la bloqueada', () => {
    expect(alternativasEnZona(ZONA, 'p1', 'w2').map((a) => `${a.short} ${a.base}`)).toEqual(['PH 280', '8ES 120']);
    expect(alternativasEnZona(ZONA_PH_VIEJA, 'p1', 'w2').map((a) => a.short)).toEqual(['8ES']);
    const muchas = { ...ZONA, warehouses: [...ZONA.warehouses, w('w5', '05', 'ZAM', 'Zamora', false)], stock: { p1: [0, 5, 9, 7, 3] } };
    expect(alternativasEnZona(muchas, 'p1', 'w2').map((a) => a.short)).toEqual(['8ES', 'YU', 'PH']);
  });

  it('nadieEnZona exige la zona entera al día; chipsDeZona marca «<1» cuando hay piezas sueltas', () => {
    expect(nadieEnZona(ZONA, 'p2')).toBe(true);
    expect(nadieEnZona(ZONA, 'p1')).toBe(false);
    expect(nadieEnZona(ZONA_PH_VIEJA, 'p2')).toBe(false);
    const c = chipsDeZona({ ...ZONA, stock: { p1: [0, 5, 40, null] } }, 'p1', 20)!;
    expect(c.map((x) => x.texto)).toEqual(['0', '<1', '2', '0']);
    expect(c.map((x) => x.cero)).toEqual([true, false, false, true]);
  });

  it('textos: cantidad en la unidad pedida y los tres mensajes de bloqueo', () => {
    expect(cantidadEnUnidad(280, 20, 'CJA', 'PZA')).toBe('14 CJA');
    expect(cantidadEnUnidad(5, 20, 'CJA', 'PZA')).toBe('5 pzas');
    expect(cantidadEnUnidad(1, 1, 'PZA', 'PZA')).toBe('1 pza');
    expect(cantidadEnUnidad(2.5, 1, 'KG', 'KG')).toBe('2.5 KG');
    expect(mensajeBloqueo({ surtido: 'PH', alternativas: [{ short: 'LPA', texto: '14' }], zonaCompleta: true, sinDato: [] }))
      .toBe('No se puede agregar: no hay existencias en PH · LPA tiene 14');
    expect(mensajeBloqueo({ surtido: 'PH', alternativas: [], zonaCompleta: true, sinDato: [] }))
      .toBe('No se puede agregar un producto que no hay en tu zona');
    expect(mensajeBloqueo({ surtido: 'PH', alternativas: [], zonaCompleta: false, sinDato: ['YU'] }))
      .toBe('No se puede agregar: no hay existencias en PH · sin dato de YU');
  });
});

describe('PortalService · el catálogo del vendedor pide stock_state [MCP.3.16]', () => {
  afterEach(() => TestBed.resetTestingModule());
  function montarHttp() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { svc: TestBed.inject(PortalService), http: TestBed.inject(HttpTestingController) };
  }

  it('⭐ con stockState y sucursal manda stock_state=1 y conserva los campos nuevos del renglón', () => {
    const { svc, http } = montarHttp();
    let filas: PriceRow[] = [];
    svc.listPricesForList('pl1', 'w2', { pricedOnly: true, sort: 'sales', stockState: true }).subscribe((r) => (filas = r));
    const req = http.expectOne((r) => r.url.endsWith('/commercial/price-lists/pl1/prices'));
    expect(req.request.params.get('stock_state')).toBe('1');
    req.flush({ data: [{ ...mazapan, stock_twin_product_id: 'p9' }] });
    expect(filas[0].stock_state).toBe('no_se_maneja');
    expect(filas[0].stock_checked_at).toBe(AHORA);
    expect(filas[0].stock_twin_product_id).toBe('p9');
    http.verify();
  });

  it('⛔ negativa: sin la opción (portal, view) o sin sucursal, no se pide', () => {
    const { svc, http } = montarHttp();
    svc.listPricesForList('pl1', 'w2', { pricedOnly: true, sort: 'sales' }).subscribe();
    svc.listPricesForList('pl1', undefined, { stockState: true }).subscribe();
    const reqs = http.match((r) => r.url.endsWith('/commercial/price-lists/pl1/prices'));
    expect(reqs.map((r) => r.request.params.get('stock_state'))).toEqual([null, null]);
    reqs.forEach((r) => r.flush([]));
    http.verify();
  });
});
