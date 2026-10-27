/**
 * [E.29] Cambiar de sucursal vuelve a preciar la bandeja.
 *
 * Medido el 2026-10-26: la bandeja de alta mostró OSITOS 99686 ×1 PAQ en «Lista $132.46» y la
 * cotización guardada (COT-2026-00030, Padre Hidalgo) salió con la promoción del 6 %, $124.51.
 * La promoción sólo existe en dos sucursales y el selector no volvía a pedir precios: cada
 * renglón conservaba el de la sucursal con la que se agregó.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { MessageService } from 'primeng/api';
import { Subject, of, throwError } from 'rxjs';

import { ItemBandeja, TeleventaQuoteNewComponent } from './televenta-quote-new.component';
import { PricedLine, QuotesService, WholesaleCustomer } from '../quotes.service';

const OSITOS: ItemBandeja = {
  id: 'r1', sku: '99686', name: 'OSITOS BACK PACK JELLY', barcode: null, content: null,
  rung: 'base', unit_label: 'PAQ', factor: null, quantity: 1,
  unit_price: 132.46, line_total: 132.46, price_source: 'list',
  base_unit: 'PAQ', pack_size: null, list_price: 132.46, pasos: '', explicacion: '',
};

const previa = (branch: string, unit_price: number | null, price_source: string): PricedLine => ({
  sku: '99686', product_id: 'p1', name: 'OSITOS', branch, rung: 'base', unit_label: 'PAQ', unit_factor: null,
  quantity: 1, list_price: 132.46, unit_price, price_source, line_total: unit_price, tax_rate: 0.16,
  tax_basis: 'ficha', iva_rate: 0.16, ieps_rate: 0.08, availability: 'ok', applied: [], not_applied: [],
  free_goods: null, unpriced_reason: null, warnings: [],
});

describe('TeleventaQuoteNewComponent — la bandeja sigue a la sucursal', () => {
  let respuestas: Record<string, Subject<PricedLine>>;
  let pedidas: Array<{ branch: string; sku: string; quantity: number; rung?: string }>;

  beforeEach(() => {
    respuestas = {};
    pedidas = [];
    const svc: Partial<QuotesService> = {
      pricePreview: (input) => {
        pedidas.push(input);
        respuestas[input.branch] = new Subject<PricedLine>();
        return respuestas[input.branch].asObservable();
      },
      listSalespersons: () => of([]),
      stock: (branch: string) => of({ branch, stock_as_of: null, items: [] }),
    };
    TestBed.configureTestingModule({
      imports: [TeleventaQuoteNewComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        MessageService,
        { provide: QuotesService, useValue: svc },
      ],
    });
  });

  function conBandeja(suc: string) {
    const c = TestBed.createComponent(TeleventaQuoteNewComponent).componentInstance;
    c.sucursal.set(suc);
    c.bandeja.set([{ ...OSITOS }]);
    return c;
  }

  it('al cambiar de sucursal, cada renglón se cotiza con la NUEVA', () => {
    const c = conBandeja('02');
    c.onSucursalChange('01');
    expect(pedidas).toEqual([{ branch: '01', sku: '99686', quantity: 1, rung: 'base' }]);
    respuestas['01'].next(previa('01', 124.51, 'promo_qty'));
    expect(c.bandeja()[0]).toMatchObject({ unit_price: 124.51, line_total: 124.51, price_source: 'promo_qty' });
  });

  it('si el motor no responde, el renglón se declara Sin precio y no suma — no conserva el de la otra sucursal', () => {
    const c = conBandeja('02');
    (TestBed.inject(QuotesService) as Partial<QuotesService>).pricePreview = () => throwError(() => new Error('500'));
    c.onSucursalChange('01');
    expect(c.bandeja()[0]).toMatchObject({ unit_price: null, line_total: 0, price_source: 'unknown' });
    expect(c.renglonesBandeja()[0].importe).toBeNull();
    expect(c.totalBandeja()).toBe(0);
  });

  it('una respuesta tardía de la sucursal anterior no pisa la actual', () => {
    const c = conBandeja('02');
    c.onSucursalChange('01');
    c.onSucursalChange('03');
    respuestas['03'].next(previa('03', 132.46, 'list'));
    respuestas['01'].next(previa('01', 124.51, 'promo_qty')); // llega después: ya no es la sucursal activa
    expect(c.bandeja()[0]).toMatchObject({ unit_price: 132.46, price_source: 'list' });
  });

  it('con % de cliente, el importe del renglón es el de la hoja: su parte del %, y la suma da el total al centavo', () => {
    const c = conBandeja('01');
    const peelerz: ItemBandeja = { ...OSITOS, id: 'r2', sku: '43103', unit_label: 'CJA', unit_price: 739.2, line_total: 739.2, list_price: 739.21 };
    c.bandeja.set([peelerz, { ...OSITOS }]);
    const terminos = (sucursal: string, pct: string | null) =>
      ({ sucursal, credit_limit: null, payment_days: null, discount_1_pct: pct, discount_2_pct: null, zone_code: null, group_code: null });
    c.cliente.set({ customer_code: 'C1088', name: 'SUPER DE LA PAZ', phone: null, rfc: null, address_1: null, state: null,
      branches: [terminos('01', '2'), terminos('02', null)], terms_vary_by_branch: true } as WholesaleCustomer);
    // 871.66 × 0.98 = 854.2268 → 854.23; pisos 724.41 + 129.81 = 854.22 y el centavo va a la fracción mayor.
    expect(c.renglonesBandeja().map((r) => r.neto)).toEqual([724.42, 129.81]);
    expect(c.totalBandeja()).toBe(854.23);
    // El % es el de la sucursal: en una sin descuento, el importe es el del renglón.
    c.sucursal.set('02');
    expect(c.renglonesBandeja().map((r) => r.neto)).toEqual([null, null]);
  });

  it('elegir un cliente de otra sucursal también vuelve a preciar (antes cambiaba la sucursal en silencio)', () => {
    const c = conBandeja('02');
    c.misRamas.set({ mode: 'all', branches: null, writable: null, default_branch: null, resolvable: true });
    const cliente = { customer_code: 'C1', name: 'Cliente PH', phone: null, rfc: null, address_1: null, state: null,
      branches: [{ sucursal: '01', credit_limit: null, payment_days: null, discount_1_pct: null, discount_2_pct: null, zone_code: null, group_code: null }],
      terms_vary_by_branch: false } as WholesaleCustomer;
    c.elegirCliente(cliente);
    expect(c.sucursal()).toBe('01');
    expect(pedidas.map((p) => p.branch)).toEqual(['01']);
  });
});
