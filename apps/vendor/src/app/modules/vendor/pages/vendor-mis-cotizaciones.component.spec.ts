import { RouteDayService } from '../route-day.service';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter, type ParamMap } from '@angular/router';
import { MessageService } from 'primeng/api';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { VendorMisCotizacionesComponent } from './vendor-mis-cotizaciones.component';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { VendorQuoteComponent } from './vendor-quote.component';
import { VendorQuoteService } from '../vendor-quote.service';
import { VendorService } from '../vendor.service';
import { PresaleStatusService } from '../presale-status.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { type CotizacionDeLista, diaMes, estadoDeCotizacion, motivoDeFalla, vigenciaDe } from '../mis-cotizaciones';
import { hoyMx } from '../mis-pedidos-dia';

/**
 * `[MCP.16]` La pestaña «Cotizaciones» de «Pedidos» en la app del vendedor. Lo que importa: que diga la
 * verdad (vacío ≠ error ≠ sin señal ≠ sin permiso ≠ sin sucursal), que no corte la lista en silencio,
 * que abrir una lleve a la pantalla de cotizar con su id, y que la pestaña la mande la URL.
 */

const fila = (p: Partial<CotizacionDeLista> = {}): CotizacionDeLista => ({
  id: 'q1', code: 'COT-2026-00147', status: 'draft', customer_id: 'c1', recipient_name: 'Cliente Prueba',
  quote_date: '2026-11-10', valid_until: '2026-11-25', days_to_expiry: 15, total: '1234.5',
  order_code: null, kepler_folio: null, ...p,
});

const TEXTOS = { generico: 'No se pudo.', sinPermiso: 'Sin permiso.' };

// ─────────────────────────────────────────────────────────────────────────────
// Las reglas, sin Angular
// ─────────────────────────────────────────────────────────────────────────────

describe('mis-cotizaciones · reglas (MCP.16)', () => {
  it('una abierta se dice por su vigencia; una cerrada, por el estado del servidor', () => {
    expect(estadoDeCotizacion({ status: 'draft', days_to_expiry: 15 })).toEqual({ texto: 'Vigente', tono: 'ok' });
    expect(estadoDeCotizacion({ status: 'sent', days_to_expiry: 0 })).toEqual({ texto: 'Vence hoy', tono: 'warn' });
    expect(estadoDeCotizacion({ status: 'draft', days_to_expiry: -3 })).toEqual({ texto: 'Vencida', tono: 'warn' });
    expect(estadoDeCotizacion({ status: 'accepted', days_to_expiry: -30 })).toEqual({ texto: 'Aceptada', tono: 'ok' });
    expect(estadoDeCotizacion({ status: 'rejected', days_to_expiry: 4 })).toEqual({ texto: 'Rechazada', tono: 'bad' });
    expect(estadoDeCotizacion({ status: 'expired', days_to_expiry: -1 })).toEqual({ texto: 'Vencida', tono: 'warn' });
    expect(estadoDeCotizacion({ status: 'cancelled', days_to_expiry: 4 })).toEqual({ texto: 'Cancelada', tono: 'neutral' });
    // Un estado que el servidor agregue mañana se muestra tal cual, no se adivina.
    expect(estadoDeCotizacion({ status: 'en_revision', days_to_expiry: 4 })).toEqual({ texto: 'en_revision', tono: 'neutral' });
  });

  it('la vigencia: hasta cuándo vale, cuándo venció, o a qué pedido fue a parar', () => {
    const hoy = new Date(2026, 10, 10);
    expect(vigenciaDe(fila(), hoy)).toBe(`vale hasta el ${diaMes('2026-11-25', hoy)}`);
    expect(vigenciaDe(fila({ days_to_expiry: 0 }), hoy)).toBe('vence hoy');
    expect(vigenciaDe(fila({ days_to_expiry: -2, valid_until: '2026-11-08' }), hoy)).toBe(`venció el ${diaMes('2026-11-08', hoy)}`);
    expect(vigenciaDe(fila({ status: 'accepted', kepler_folio: '02-778', order_code: 'PD-1' }), hoy)).toBe('pedido en Kepler 02-778');
    expect(vigenciaDe(fila({ status: 'accepted', order_code: 'PD-2026-00072' }), hoy)).toBe('pedido PD-2026-00072');
    expect(vigenciaDe(fila({ status: 'cancelled' }), hoy)).toBe('');
  });

  it('la fecha corta lleva año sólo si no es el de hoy, y una fecha mala no inventa nada', () => {
    const hoy = new Date(2026, 10, 10);
    expect(diaMes('2026-11-10', hoy)).not.toContain('2026');
    expect(diaMes('2025-12-31', hoy)).toContain('2025');
    expect(diaMes('2025-12-31', hoy)).toContain('31');
    expect(diaMes(null, hoy)).toBe('');
    expect(diaMes('10/11/2026', hoy)).toBe('');
  });

  it('⭐ una lectura que falla: sin señal ≠ sin permiso ≠ lo que diga el servidor', () => {
    expect(motivoDeFalla({ status: 500 }, TEXTOS, false).tipo).toBe('sin_senal');
    expect(motivoDeFalla({ status: 0 }, TEXTOS, true).tipo).toBe('sin_senal');
    // El 504 sin cuerpo es el del service worker (no llegó al servidor).
    expect(motivoDeFalla({ status: 504, error: null }, TEXTOS, true).tipo).toBe('sin_senal');
    // Un 504 CON mensaje de Nest sí viene del servidor.
    expect(motivoDeFalla({ status: 504, error: { message: 'Kepler no respondió' } }, TEXTOS, true)).toEqual({ texto: 'Kepler no respondió', tipo: 'servidor' });
    expect(motivoDeFalla({ status: 403, error: { message: 'Forbidden resource' } }, TEXTOS, true)).toEqual({ texto: 'Sin permiso.', tipo: 'sin_permiso' });
    expect(motivoDeFalla({ status: 400, error: { message: ['uno', 'dos'] } }, TEXTOS, true).texto).toBe('uno · dos');
    expect(motivoDeFalla({ status: 500 }, TEXTOS, true)).toEqual({ texto: 'No se pudo.', tipo: 'servidor' });
    // Al leer no se dice «no se guardó» (eso es de una escritura).
    expect(motivoDeFalla({ status: 0 }, TEXTOS, true).texto).not.toContain('guard');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La pantalla, montada de verdad con los servidores simulados
// ─────────────────────────────────────────────────────────────────────────────

type Lista = { rows: CotizacionDeLista[]; total: number };

function montar(o: { lista?: Lista | object; listaMas?: Lista; branches?: object | Error; clientes?: { data: unknown[]; total: number } } = {}) {
  const quotes = {
    list: vi.fn((opts: { offset?: number }) => {
      const r = (opts?.offset ?? 0) > 0 ? o.listaMas : o.lista;
      return r && !('status' in r) ? of(r) : throwError(() => r ?? { status: 500 });
    }),
    branches: vi.fn(() => (o.branches instanceof Error ? throwError(() => o.branches) : of(o.branches ?? { branches: ['01'], resolvable: true }))),
  };
  const vendor = { listCustomers: vi.fn(() => of(o.clientes ?? { data: [], total: 0 })) };
  TestBed.configureTestingModule({
    imports: [VendorMisCotizacionesComponent],
    providers: [provideRouter([]), { provide: VendorQuoteService, useValue: quotes }, { provide: VendorService, useValue: vendor }],
  });
  const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fix = TestBed.createComponent(VendorMisCotizacionesComponent);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => (el.textContent || '').replace(/\s+/g, ' ');
  const boton = (t: string) => Array.from(el.querySelectorAll('button')).find((b) => (b.textContent || '').includes(t)) as HTMLButtonElement | undefined;
  return { fix, el, texto, boton, quotes, vendor, nav, cmp: fix.componentInstance };
}

describe('VendorMisCotizacionesComponent · mis cotizaciones (MCP.16)', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('⭐ pinta las cotizaciones del servidor: cliente, folio, vigencia y total (numeric que llega como texto)', () => {
    const { texto, quotes } = montar({ lista: { rows: [fila(), fila({ id: 'q2', code: 'COT-2026-00140', recipient_name: 'Tienda Prueba', status: 'cancelled', total: 98 })], total: 2 } });
    expect(quotes.list).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(texto()).toContain('Cliente Prueba');
    expect(texto()).toContain('COT-2026-00147');
    expect(texto()).toContain('Vigente');
    expect(texto()).toContain('vale hasta el');
    expect(texto()).toContain('$1,234.50');
    expect(texto()).toContain('Tienda Prueba');
    expect(texto()).toContain('Cancelada');
    expect(texto()).not.toContain('Aún no tienes');
    expect(texto()).not.toContain('Mostrando');
  });

  it('⭐ tocar una cotización abre la pantalla de cotizar con su id (?cot=) y de dónde viene', () => {
    const { boton, nav } = montar({ lista: { rows: [fila()], total: 1 } });
    boton('Cliente Prueba')!.click();
    expect(nav).toHaveBeenCalledWith(['/vendor/cotizar', 'c1'], { queryParams: { cot: 'q1', desde: 'cotizaciones' } });
  });

  it('una cotización sin cliente de la app no se puede abrir aquí, y lo dice', () => {
    const { boton, nav, texto } = montar({ lista: { rows: [fila({ customer_id: null, recipient_name: 'Contacto Prueba' })], total: 1 } });
    const b = boton('Contacto Prueba')!;
    expect(b.disabled).toBe(true);
    b.click();
    expect(nav).not.toHaveBeenCalled();
    expect(texto()).toContain('Se hizo fuera de la app');
  });

  it('⭐ vacío ≠ error: sin cotizaciones lo dice; un error del servidor lo dice distinto y deja reintentar', () => {
    const vacio = montar({ lista: { rows: [], total: 0 } });
    expect(vacio.texto()).toContain('Aún no tienes cotizaciones');
    expect(vacio.el.querySelector('[role="alert"]')).toBeNull();
    expect(vacio.quotes.branches).toHaveBeenCalledTimes(1);
    expect(vacio.boton('Nueva cotización')).toBeTruthy();
    TestBed.resetTestingModule();

    const mal = montar({ lista: { status: 500, error: { message: 'Algo tronó en el servidor' } } });
    expect(mal.texto()).toContain('Algo tronó en el servidor');
    expect(mal.texto()).not.toContain('Aún no tienes');
    expect(mal.el.querySelector('[role="alert"]')).not.toBeNull();
    expect(mal.quotes.branches).not.toHaveBeenCalled();
    mal.boton('Reintentar')!.click();
    expect(mal.quotes.list).toHaveBeenCalledTimes(2);
  });

  it('⭐ sin señal se dice «Sin señal», no como error del servidor', () => {
    const { texto, boton, quotes, fix } = montar({ lista: { status: 0 } });
    expect(texto()).toContain('Sin señal');
    expect(texto()).not.toContain('No se pudieron cargar tus cotizaciones');
    expect(texto()).not.toContain('Aún no tienes');
    boton('Reintentar')!.click();
    fix.detectChanges();
    expect(quotes.list).toHaveBeenCalledTimes(2);
  });

  it('sin permiso (403) lo dice y no ofrece «Nueva cotización»', () => {
    const { texto, boton } = montar({ lista: { status: 403, error: { message: 'Forbidden resource' } } });
    expect(texto()).toContain('no tiene permiso para ver cotizaciones');
    expect(texto()).not.toContain('Forbidden');
    expect(boton('Nueva cotización')).toBeUndefined();
  });

  it('lista vacía porque el usuario no tiene sucursal (COT.19): no dice «aún no tienes»', () => {
    const { texto, boton } = montar({ lista: { rows: [], total: 0 }, branches: { branches: [], resolvable: true } });
    expect(texto()).toContain('no tiene sucursal para cotizar');
    expect(texto()).not.toContain('Aún no tienes');
    expect(boton('Nueva cotización')).toBeUndefined();
    TestBed.resetTestingModule();
    // Si no se pudo preguntar, queda el vacío normal (la lista sí respondió).
    const sinSaber = montar({ lista: { rows: [], total: 0 }, branches: new Error('red') });
    expect(sinSaber.texto()).toContain('Aún no tienes cotizaciones');
  });

  it('⭐ la lista topada lo DICE (mostrando N de M) y trae las que siguen sin repetir', () => {
    const { texto, boton, quotes, fix } = montar({
      lista: { rows: [fila(), fila({ id: 'q2', code: 'COT-2026-00146' })], total: 73 },
      listaMas: { rows: [fila({ id: 'q2', code: 'COT-2026-00146' }), fila({ id: 'q3', code: 'COT-2026-00100' })], total: 73 },
    });
    expect(texto()).toContain('Mostrando 2 de 73');
    boton('Ver 50 más')!.click();
    fix.detectChanges();
    expect(quotes.list).toHaveBeenLastCalledWith({ limit: 50, offset: 2 });
    expect(texto()).toContain('Mostrando 3 de 73');
    // La repetida no se pinta dos veces.
    expect(texto().split('COT-2026-00146').length - 1).toBe(1);
  });

  it('un total que no llega no se dibuja como $0.00', () => {
    const { texto } = montar({ lista: { rows: [fila({ total: null })], total: 1 } });
    expect(texto()).not.toContain('$0.00');
    expect(texto()).toContain('—');
  });

  it('«Nueva cotización» busca entre los clientes de SU ruta y abre la pantalla de cotizar con el elegido', () => {
    vi.useFakeTimers();
    const { boton, fix, vendor, nav, texto } = montar({
      lista: { rows: [], total: 0 },
      clientes: { data: [{ id: 'cli-1', code: 'C0001', name: 'Cliente Prueba' }], total: 41 },
    });
    boton('Nueva cotización')!.click();
    vi.advanceTimersByTime(300);
    fix.detectChanges();
    expect(vendor.listCustomers).toHaveBeenCalledWith({ search: undefined, pageSize: 30, scope: 'mine' });
    expect(texto()).toContain('Mostrando 1 de 41');
    boton('C0001')!.click();
    expect(nav).toHaveBeenCalledWith(['/vendor/cotizar', 'cli-1'], { queryParams: { desde: 'cotizaciones' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// «Pedidos» con su pestaña Cotizaciones: la manda la URL
// ─────────────────────────────────────────────────────────────────────────────

describe('VendorMisPedidosComponent · pestaña Pedidos | Cotizaciones (MCP.16)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function montarPedidos(ver: string | null) {
    const qp = new BehaviorSubject<ParamMap>(convertToParamMap(ver ? { ver } : {}));
    const presale = {
      // [MCP.20] El «hoy» del servidor = el del equipo: si no, la pantalla se mueve a ese día y pide una vez más.
      status: vi.fn(() => of({ today: hoyMx(), data: [], unseen_reports: 1 })),
      markSeen: vi.fn(() => of({ updated: 1 })),
      unseen: vi.fn(() => of({ unseen_reports: 1 })),
    };
    const quotes = { list: vi.fn(() => of({ rows: [fila()], total: 1 })), branches: vi.fn(() => of({ branches: ['01'], resolvable: true })) };
    TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: qp.value }, queryParamMap: qp.asObservable() } },
        { provide: PresaleStatusService, useValue: presale },
        { provide: VendorQuoteService, useValue: quotes },
        { provide: VendorService, useValue: { listCustomers: vi.fn(() => of({ data: [], total: 0 })), orderById: vi.fn(() => of(null)) } },
        // [MCP.19] El recuento del día y la cola del celular (se miden en vendor-recuento-dia.spec.ts).
        { provide: RecuentoDiaService, useValue: { dia: vi.fn(() => throwError(() => ({ error: { message: 'sin servidor en la prueba' } }))) } },
        { provide: OfflineOrderService, useValue: { pendingSummaries: vi.fn(() => Promise.resolve([])) } },
        // [MCP.21] Corregir/cancelar avisan con el toast; «Terminar mi día» lee la ruta del día.
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: RouteDayService, useValue: { today: vi.fn(() => of({ state: 'sin_iniciar' })) } },
      ],
    });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const pestana = (t: string) => Array.from(el.querySelectorAll('.mp-seg button')).find((b) => (b.textContent || '').trim() === t) as HTMLButtonElement;
    return { fix, el, qp, presale, quotes, nav, pestana };
  }

  it('sin parámetro se ve «Pedidos», marcado, y no se piden cotizaciones', () => {
    const { el, pestana, presale, quotes } = montarPedidos(null);
    expect(pestana('Pedidos').getAttribute('aria-pressed')).toBe('true');
    expect(pestana('Cotizaciones').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('app-vendor-mis-cotizaciones')).toBeNull();
    expect(presale.status).toHaveBeenCalledTimes(1);
    expect(quotes.list).not.toHaveBeenCalled();
  });

  it('⭐ ?ver=cotizaciones abre la pestaña Cotizaciones y NO pide los pedidos (no marca el reporte como visto)', () => {
    const { el, pestana, presale, quotes } = montarPedidos('cotizaciones');
    expect(pestana('Cotizaciones').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('app-vendor-mis-cotizaciones')).not.toBeNull();
    expect(el.textContent).toContain('Mis cotizaciones');
    expect(quotes.list).toHaveBeenCalledTimes(1);
    expect(presale.status).not.toHaveBeenCalled();
    expect(presale.markSeen).not.toHaveBeenCalled();
  });

  it('⭐ tocar la pestaña cambia la URL (sin apilar historial) y la pantalla sigue a la URL', () => {
    const { fix, el, qp, pestana, presale, nav } = montarPedidos(null);
    pestana('Cotizaciones').click();
    expect(nav).toHaveBeenCalledWith(['/vendor/mis-pedidos'], { queryParams: { ver: 'cotizaciones' }, replaceUrl: true });
    qp.next(convertToParamMap({ ver: 'cotizaciones' }));
    fix.detectChanges();
    expect(el.querySelector('app-vendor-mis-cotizaciones')).not.toBeNull();
    // De vuelta a Pedidos: se vuelven a pedir.
    pestana('Pedidos').click();
    expect(nav).toHaveBeenLastCalledWith(['/vendor/mis-pedidos'], { queryParams: {}, replaceUrl: true });
    qp.next(convertToParamMap({}));
    fix.detectChanges();
    expect(el.querySelector('app-vendor-mis-cotizaciones')).toBeNull();
    expect(presale.status).toHaveBeenCalledTimes(2);
  });

  it('un valor raro en ?ver= cae en «Pedidos» (no deja la pantalla en blanco)', () => {
    const { pestana, el } = montarPedidos('cualquier-cosa');
    expect(pestana('Pedidos').getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toContain('Mis pedidos');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La flecha de la pantalla de cotizar regresa a donde se abrió
// ─────────────────────────────────────────────────────────────────────────────

describe('VendorQuoteComponent · regresar a Mis cotizaciones (MCP.16)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function montarCotizar(query: Record<string, string>) {
    const vendor = {
      getCustomer: vi.fn(() => of({ id: 'c1', code: 'C0001', name: 'Cliente Prueba' })),
      myStockSources: vi.fn(() => of({ sucursal: { id: 'w1', code: '01', name: 'Sucursal Prueba' }, camioneta: null })),
      catalogInstant: vi.fn(() => of({ priceListId: 'pl1', prices: [], origen: 'servidor', at: Date.now() })),
    };
    const quotes = { get: vi.fn(() => of({ id: 'q1', code: 'COT-2026-00147', status: 'draft', valid_until: '2026-11-25', total: 0, lines: [] })) };
    TestBed.configureTestingModule({
      imports: [VendorQuoteComponent],
      providers: [
        provideRouter([]),
        { provide: VendorService, useValue: vendor },
        { provide: VendorQuoteService, useValue: quotes },
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap(query) } } },
      ],
    });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fix = TestBed.createComponent(VendorQuoteComponent);
    fix.detectChanges();
    return { cmp: fix.componentInstance, nav };
  }

  it('abierta desde «Mis cotizaciones», la flecha regresa a esa pestaña', () => {
    const { cmp, nav } = montarCotizar({ cot: 'q1', desde: 'cotizaciones' });
    cmp.volver();
    expect(nav).toHaveBeenCalledWith(['/vendor/mis-pedidos'], { queryParams: { ver: 'cotizaciones' } });
  });

  it('abierta desde «Tomar pedido» (sin «desde»), sigue regresando a «Tomar pedido»', () => {
    const { cmp, nav } = montarCotizar({ cot: 'q1' });
    cmp.volver();
    expect(nav).toHaveBeenCalledWith(['/vendor/take-order', 'c1']);
  });
});
