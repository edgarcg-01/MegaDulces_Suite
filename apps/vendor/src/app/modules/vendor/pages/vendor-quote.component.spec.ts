import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import { VendorQuoteComponent } from './vendor-quote.component';
import { VendorService } from '../vendor.service';
import { VendorQuoteService } from '../vendor-quote.service';
import type { PriceRow } from '../../portal/portal.service';
import type { CotizacionDetalle } from '../cotizacion';
import { ChecadorPreciosService, type ClaveDeCodigo } from '../checador-precios.service';

/**
 * `[MCP.12]` Cotizar en la app del vendedor, montada de verdad con los servidores simulados: el
 * precio lo pone el servidor de cotizaciones, la cotización nace con el primer producto, el
 * documento dice lo mismo que la cotización, y (MCP.34) «Pasar a venta» lo hace el servidor en un paso.
 */
const paleta = {
  id: 'pr-1', product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', sku: '30117', price: 9.8, price_list_id: 'pl1',
  rungs: [{ rung: 'base', unit: 'PZA', factor: 1, price: 9.8 }, { rung: 'box', unit: 'CJA', factor: 24, price: 228 }],
} as unknown as PriceRow;
const mazapan = { id: 'pr-2', product_id: 'p2', product_name: 'MAZAPAN GIGANTE 50 G', sku: '13205', price: 6.2, price_list_id: 'pl1' } as unknown as PriceRow;

const COT = (lineas: CotizacionDetalle['lines'] = []): CotizacionDetalle => ({
  id: 'q1', code: 'COT-2026-00147', status: 'draft', valid_until: '2026-11-10',
  total: lineas.reduce((s, l) => s + Number(l.line_total), 0), recipient_name: 'ABARROTES CARMELITA', created_by_name: 'Vendedor Prueba', lines: lineas,
});
/** La respuesta del servidor a «Pasar a venta» (MCP.34): hoy cobra $240 lo que se cotizó en $228. */
const PASO = (b: { requested_delivery_date: string; dry_run?: boolean }) => ({
  quote_id: 'q1', quote_code: 'COT-2026-00147', quote_total: 228, order_id: 'o50', order_code: 'PD-2026-00050', order_total: 240,
  requested_delivery_date: b.requested_delivery_date, sin_producto: [] as string[], ya_existia: false, dry_run: b.dry_run === true,
});
const manana = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(Date.now() + 86_400_000));
const renPaleta = { id: 'l1', line_number: 1, product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', product_sku: '30117', requested_text: null,
  quantity: 1, qty_unit: 'CJA', qty_factor: 24, unit_price: 228, line_total: 228, parent_line_number: null };

function montar(o: { sucursal?: unknown; checador?: { claveDeCodigo: (c: string, s: string | null) => Promise<ClaveDeCodigo> } } = {}) {
  const vendor = {
    getCustomer: vi.fn(() => of({ id: 'c1', code: 'CLI-1', name: 'ABARROTES CARMELITA', phone: '443 123 4567' })),
    myStockSources: vi.fn(() => of({ sucursal: 'sucursal' in o ? o.sucursal : { id: 'w1', code: '01', name: 'Padre Hidalgo' }, camioneta: null })),
    catalogInstant: vi.fn(() => of({ priceListId: 'pl1', prices: [paleta, mazapan], origen: 'servidor', at: Date.now() })),
    ensureDraftForCustomer: vi.fn(() => of({ id: 'o1' })),
    addLine: vi.fn(() => of({ id: 'ol1' })),
  };
  const quotes = {
    create: vi.fn(() => of({ id: 'q1', code: 'COT-2026-00147', valid_until: '2026-11-10' })),
    addLine: vi.fn(() => of({})),
    updateLine: vi.fn(() => of({})),
    removeLine: vi.fn(() => of({})),
    get: vi.fn(() => of(COT([renPaleta]))),
    pasarAVenta: vi.fn((_id: string, b: { requested_delivery_date: string; dry_run?: boolean }) => of(PASO(b))),
  };
  const toast = { add: vi.fn() };
  TestBed.configureTestingModule({
    imports: [VendorQuoteComponent],
    providers: [
      provideRouter([]),
      { provide: VendorService, useValue: vendor },
      { provide: VendorQuoteService, useValue: quotes },
      { provide: MessageService, useValue: toast },
      ...(o.checador ? [{ provide: ChecadorPreciosService, useValue: o.checador }] : []),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fix = TestBed.createComponent(VendorQuoteComponent);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => (el.textContent || '').replace(/\s+/g, ' ');
  const boton = (t: string) => Array.from(el.querySelectorAll('button')).find((b) => (b.textContent || '').includes(t)) as HTMLButtonElement | undefined;
  return { fix, el, texto, boton, vendor, quotes, toast, cmp: fix.componentInstance };
}

describe('VendorQuoteComponent · cotizar al cliente (MCP.12)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('abre con el catálogo de la sucursal, SKU a la vista y aviso de que no es pedido', () => {
    const { texto } = montar();
    expect(texto()).toContain('Cotización · ABARROTES CARMELITA');
    expect(texto()).toContain('Precios de Padre Hidalgo');
    expect(texto()).toContain('No es un pedido');
    expect(texto()).toContain('SKU 30117');
  });

  it('⭐ el primer + crea la cotización (route_visit, su sucursal) y cotiza en la unidad elegida; el precio es el del servidor', () => {
    const { cmp, fix, quotes, texto } = montar();
    cmp.elegirUnidad(paleta, 'CJA');
    cmp.mover(paleta, 1);
    fix.detectChanges();
    expect(quotes.create).toHaveBeenCalledWith({ customer_id: 'c1', source_branch: '01', warehouse_id: 'w1', contact_phone: '443 123 4567' });
    expect(quotes.addLine).toHaveBeenCalledWith('q1', { sku: '30117', quantity: 1, rung: 'box' });
    expect(texto()).toContain('$228.00 c/u · $228.00');
    expect(texto()).toContain('1 producto');
  });

  it('con renglón: + cambia la cantidad y llegar a 0 lo quita', () => {
    const { cmp, quotes } = montar();
    cmp.cot.set(COT([renPaleta]));
    cmp.mover(paleta, 1);
    expect(quotes.updateLine).toHaveBeenCalledWith('q1', 'l1', { quantity: 2, rung: 'box' });
    cmp.mover(paleta, -1);
    expect(quotes.removeLine).toHaveBeenCalledWith('q1', 'l1');
    expect(quotes.create).not.toHaveBeenCalled();
  });

  it('el documento dice folio, cliente, productos, total y vigencia; WhatsApp va al número del cliente', () => {
    const { cmp, fix, texto, el } = montar();
    cmp.cot.set(COT([renPaleta]));
    cmp.vista.set('doc');
    fix.detectChanges();
    expect(texto()).toContain('COT-2026-00147');
    expect(texto()).toContain('Para: ABARROTES CARMELITA');
    expect(texto()).toContain('1 CJA');
    expect(texto()).toContain('válidos hasta el 10 nov 2026');
    const wa = el.querySelector('a.cq-btn-ok') as HTMLAnchorElement;
    expect(wa.href).toContain('https://wa.me/524431234567?text=');
    expect(decodeURIComponent(wa.href)).toContain('PALETA PAYASO GRANDE (SKU 30117)');
  });

  it('⛔ sin sucursal de surtido no se cotiza y se dice por qué', () => {
    const { cmp, fix, quotes, texto } = montar({ sucursal: null });
    cmp.mover(paleta, 1);
    fix.detectChanges();
    expect(quotes.create).not.toHaveBeenCalled();
    expect(texto()).toContain('no tiene sucursal de surtido');
  });

  it('⛔ si el servidor rechaza (p. ej. la sucursal no es suya) se muestra su mensaje', () => {
    const { cmp, fix, quotes, texto } = montar();
    quotes.create.mockReturnValueOnce(throwError(() => ({ error: { message: 'No puedes cotizar en la sucursal 01.' } })));
    cmp.mover(paleta, 1);
    fix.detectChanges();
    expect(texto()).toContain('No puedes cotizar en la sucursal 01.');
  });
});

describe('[MCP.26] Cotización · buscar por palabras y dictando', () => {
  const ventana = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  afterEach(() => {
    TestBed.resetTestingModule();
    delete ventana.SpeechRecognition;
    delete ventana.webkitSpeechRecognition;
  });
  const nombres = (cmp: VendorQuoteComponent) => cmp.visibles().map((p) => p.product_name);

  it('⭐ cada palabra, en cualquier orden: «50 mazapan gigante» encuentra «MAZAPAN GIGANTE 50 G»', () => {
    const { cmp } = montar();
    cmp.busqueda.set('50 mazapan gigante');
    expect(nombres(cmp)).toEqual(['MAZAPAN GIGANTE 50 G']);
    // Prueba negativa del criterio anterior (la frase entera pegada): con él esto no encontraba nada.
    expect('MAZAPAN GIGANTE 50 G 13205'.includes('50 MAZAPAN GIGANTE')).toBe(false);
  });

  it('sin acentos y por SKU: «mazapán» y «30117» encuentran su producto', () => {
    const { cmp } = montar();
    cmp.busqueda.set('mazapán');
    expect(nombres(cmp)).toEqual(['MAZAPAN GIGANTE 50 G']);
    cmp.busqueda.set('payaso 30117');
    expect(nombres(cmp)).toEqual(['PALETA PAYASO GRANDE']);
  });

  it('⭐ dictar «mazapán gigante de cincuenta gramos» deja la búsqueda convertida en el campo y lo encuentra', () => {
    ventana.SpeechRecognition = class {
      lang = ''; interimResults = false; continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error?: string }) => void) | null = null;
      start(): void {
        this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: 'mazapán gigante de cincuenta gramos' }, isFinal: true }] });
        this.onend?.();
      }
      stop(): void { this.onend?.(); }
    };
    const { cmp, fix, el } = montar();
    el.querySelector<HTMLButtonElement>('app-dictar-busqueda button')!.click();
    fix.detectChanges();
    expect(cmp.busqueda()).toBe('mazapán gigante 50 g');
    expect(el.querySelector<HTMLInputElement>('.cq-search input')!.value).toBe('mazapán gigante 50 g');
    expect(nombres(cmp)).toEqual(['MAZAPAN GIGANTE 50 G']);
  });

  it('⛔ sin permiso del micrófono se dice debajo del buscador', () => {
    ventana.SpeechRecognition = class {
      lang = ''; interimResults = false; continuous = false;
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error?: string }) => void) | null = null;
      start(): void { this.onerror?.({ error: 'not-allowed' }); this.onend?.(); }
      stop(): void { this.onend?.(); }
    };
    const { fix, el } = montar();
    el.querySelector<HTMLButtonElement>('app-dictar-busqueda button')!.click();
    fix.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('no dio permiso para usar el micrófono');
  });
});

// [BU.4.1] El rótulo dice «Buscar producto o código» y el filtro sólo miraba nombre y SKU: un código de
// barras tecleado o de pistola daba cero resultados. Ahora se traduce a su clave como en Tomar pedido.
describe('[BU.4.1] Cotización · código de barras tecleado o de pistola', () => {
  afterEach(() => TestBed.resetTestingModule());
  const nombres = (cmp: VendorQuoteComponent) => cmp.visibles().map((p) => p.product_name);
  function conTraductor(r: ClaveDeCodigo) {
    const checador = { claveDeCodigo: vi.fn(async () => r) };
    return { ...montar({ checador }), checador };
  }
  function pistola(el: HTMLElement, valor: string): void {
    const input = el.querySelector<HTMLInputElement>('.cq-search input[type="search"]')!;
    input.value = valor;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  }

  it('⭐ el código + Enter encuentra su producto y dice cuál es', async () => {
    const { cmp, el, fix, texto, checador } = conTraductor({ estado: 'hallado', clave: '13205', nombre: 'MAZAPAN GIGANTE 50 G', ambiguo: false });
    pistola(el, '7501000112233');
    await fix.whenStable();
    fix.detectChanges();
    expect(checador.claveDeCodigo).toHaveBeenCalledTimes(1);
    expect(checador.claveDeCodigo).toHaveBeenCalledWith('7501000112233', '01');
    expect(nombres(cmp)).toEqual(['MAZAPAN GIGANTE 50 G']);
    expect(texto()).toContain('Código 7501000112233: MAZAPAN GIGANTE 50 G (clave 13205).');
  });

  it('⛔ [negativa] código que Kepler no tiene: cero resultados y se DICE por qué', async () => {
    const { cmp, el, fix, texto } = conTraductor({ estado: 'no_esta' });
    pistola(el, '7500000000000');
    await fix.whenStable();
    fix.detectChanges();
    expect(nombres(cmp)).toEqual([]);
    expect(texto()).toContain('El código 7500000000000 no está en el catálogo de Kepler.');
  });

  it('⛔ [negativa] sin respuesta y sin copia: «no se pudo confirmar», no «no existe»', async () => {
    const { el, fix, texto } = conTraductor({ estado: 'no_se_pudo' });
    pistola(el, '7500000000000');
    await fix.whenStable();
    fix.detectChanges();
    expect(texto()).toContain('No se pudo confirmar de qué producto es 7500000000000');
    expect(texto()).not.toContain('no está en el catálogo');
  });

  it('una palabra con Enter no va al traductor', () => {
    const { el, checador } = conTraductor({ estado: 'no_se_pudo' });
    pistola(el, 'mazapan');
    expect(checador.claveDeCodigo).not.toHaveBeenCalled();
  });
});

describe('[MCP.34] [MCP.35] Cotización · existencia y pasar a venta', () => {
  afterEach(() => TestBed.resetTestingModule());
  const enDoc = (m: ReturnType<typeof montar>, cot = COT([renPaleta])) => { m.cmp.cot.set(cot); m.cmp.vista.set('doc'); m.fix.detectChanges(); };

  it('MCP.35 cada producto dice su existencia en la unidad que se cotiza; sin lectura dice «Sin dato», no 0', () => {
    const m2 = montar();
    expect(m2.texto()).toContain('Sin dato de existencia');
    m2.cmp.prices.set([{ ...paleta, stock_state: 'con_existencia', stock_available: 50, stock_checked_at: new Date().toISOString() } as PriceRow, mazapan]);
    m2.fix.detectChanges();
    expect(m2.texto()).toContain('Existencias: 50 pzas');
    m2.cmp.elegirUnidad(paleta, 'CJA');
    m2.fix.detectChanges();
    expect(m2.texto()).toContain('Existencias: 2 CJA');
  });

  it('⭐ MCP.34 un toque: vista previa con el total de HOY (sin guardar), y Confirmar manda el pedido con el día', () => {
    const m = montar();
    enDoc(m);
    m.boton('Pasar a venta')!.click();
    m.fix.detectChanges();
    expect(m.quotes.pasarAVenta).toHaveBeenCalledWith('q1', { requested_delivery_date: manana, dry_run: true });
    expect(m.texto()).toContain('Cotizaste $228.00');
    expect(m.texto()).toContain('Con los precios de hoy: $240.00');
    expect(m.texto()).toContain('Sube $12.00 desde que cotizaste');
    m.boton('Confirmar venta')!.click();
    m.fix.detectChanges();
    expect(m.quotes.pasarAVenta).toHaveBeenLastCalledWith('q1', { requested_delivery_date: manana });
    expect(m.texto()).toContain('Ya es venta: pedido PD-2026-00050');
    expect(m.boton('Pasar a venta')).toBeUndefined();
    expect(m.toast.add).toHaveBeenCalledWith(expect.objectContaining({ severity: 'success' }));
  });

  it('cambiar el día vuelve a calcular con ese día', () => {
    const m = montar();
    enDoc(m);
    m.cmp.abrirVenta();
    m.cmp.elegirDia('2099-01-05');
    expect(m.quotes.pasarAVenta).toHaveBeenLastCalledWith('q1', { requested_delivery_date: '2099-01-05', dry_run: true });
  });

  it('⛔ [negativa] el servidor la rechaza: se dice su motivo y no se puede confirmar', () => {
    const m = montar();
    m.quotes.pasarAVenta.mockReturnValueOnce(throwError(() => ({ status: 409, error: { message: 'Esta cotización es de telemarketing: se vuelve pedido desde Telemarketing, no desde la app.' } })));
    enDoc(m);
    m.boton('Pasar a venta')!.click();
    m.fix.detectChanges();
    expect(m.texto()).toContain('es de telemarketing');
    expect(m.boton('Confirmar venta')!.disabled).toBe(true);
  });

  it('⛔ [negativa] sin señal se dice que necesita conexión (no un error genérico)', () => {
    const m = montar();
    m.quotes.pasarAVenta.mockReturnValueOnce(throwError(() => ({ status: 0 })));
    enDoc(m);
    m.boton('Pasar a venta')!.click();
    m.fix.detectChanges();
    expect(m.texto()).toContain('Sin señal: pasar a venta necesita conexión');
  });

  it('una cotización que ya es venta no ofrece pasarla otra vez y dice su pedido', () => {
    const m = montar();
    enDoc(m, { ...COT([renPaleta]), status: 'accepted', order_id: 'o50', order_code: 'PD-2026-00050' });
    expect(m.boton('Pasar a venta')).toBeUndefined();
    expect(m.texto()).toContain('Ya es venta: pedido PD-2026-00050');
  });
});
