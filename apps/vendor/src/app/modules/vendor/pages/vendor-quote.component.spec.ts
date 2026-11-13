import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import { VendorQuoteComponent } from './vendor-quote.component';
import { VendorService } from '../vendor.service';
import { VendorQuoteService } from '../vendor-quote.service';
import type { PriceRow } from '../../portal/portal.service';
import type { CotizacionDetalle } from '../cotizacion';

/**
 * `[MCP.12]` Cotizar en la app del vendedor, montada de verdad con los servidores simulados: el
 * precio lo pone el servidor de cotizaciones, la cotización nace con el primer producto, el
 * documento dice lo mismo que la cotización, y «Convertir en pedido» pasa los renglones al borrador.
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
const renPaleta = { id: 'l1', line_number: 1, product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', product_sku: '30117', requested_text: null,
  quantity: 1, qty_unit: 'CJA', qty_factor: 24, unit_price: 228, line_total: 228, parent_line_number: null };

function montar(o: { sucursal?: unknown } = {}) {
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
  };
  const toast = { add: vi.fn() };
  TestBed.configureTestingModule({
    imports: [VendorQuoteComponent],
    providers: [
      provideRouter([]),
      { provide: VendorService, useValue: vendor },
      { provide: VendorQuoteService, useValue: quotes },
      { provide: MessageService, useValue: toast },
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

  it('⭐ convertir en pedido: los renglones pasan al borrador en su unidad y abre «Tomar pedido»', () => {
    const { cmp, vendor } = montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    cmp.cot.set(COT([renPaleta]));
    cmp.convertir();
    expect(vendor.ensureDraftForCustomer).toHaveBeenCalledWith('c1', 'w1', 'route');
    expect(vendor.addLine).toHaveBeenCalledWith('o1', 'p1', 1, { qty_unit: 'CJA', qty_factor: 24 });
    expect(nav).toHaveBeenCalledWith(['/vendor/take-order', 'c1']);
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
