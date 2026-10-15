// `[VTK.9]` Al buscar en Tomar pedido, cada resultado dice cuánto trae la caja.
//
// Pedido de ruta (2026-10-14): el cliente pregunta «¿cuántas trae la caja?» y el vendedor tenía
// que adivinarlo del selector de medida. La prueba monta la pantalla real con un doble de
// VendorService y mira lo que se PINTA, no sólo la función.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import type { PriceRow } from '../../portal/portal.service';

function dobleApi(respuestas: Record<string, unknown>): VendorService {
  return new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return () => of(prop in respuestas ? respuestas[prop] : null);
      },
    },
  ) as unknown as VendorService;
}

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, stock_available: 50, currency: 'MXN' };

/** Escalera de Kepler de la sucursal con caja: PZA → PAQ de 12 → CJA de 144. */
const conCaja = {
  ...base,
  id: 'pr1',
  product_id: 'p1',
  product_name: 'Paleta Payaso',
  sku: '1001',
  price: 5,
  sales_units_30d: 300,
  rungs: [
    { rung: 'base', unit: 'PZA', factor: 1, price: 5, volume_min_qty: null, volume_price: null },
    { rung: 'pack', unit: 'PAQ', factor: 12, price: 55, volume_min_qty: null, volume_price: null },
    { rung: 'box', unit: 'CJA', factor: 144, price: 600, volume_min_qty: null, volume_price: null },
  ],
  units: [
    { unit: 'PZA', factor: 1 },
    { unit: 'PAQ', factor: 12 },
    { unit: 'CJA', factor: 144 },
  ],
  units_source: 'kepler_ladder',
} as unknown as PriceRow;

/** La escalera vino y NO declara caja: sólo pieza y paquete. */
const sinCaja = {
  ...base,
  id: 'pr2',
  product_id: 'p2',
  product_name: 'Paleta Vero Mango',
  sku: '1002',
  price: 3,
  sales_units_30d: 200,
  rungs: [
    { rung: 'base', unit: 'PZA', factor: 1, price: 3, volume_min_qty: null, volume_price: null },
    { rung: 'pack', unit: 'PAQ', factor: 40, price: 110, volume_min_qty: null, volume_price: null },
  ],
  units: [
    { unit: 'PZA', factor: 1 },
    { unit: 'PAQ', factor: 40 },
  ],
  units_source: 'kepler_ladder',
} as unknown as PriceRow;

/** Bulto de 20 kg sin escalera de sucursal: se reconoce por rótulo. */
const bulto = {
  ...base,
  id: 'pr3',
  product_id: 'p3',
  product_name: 'Paleta de cajeta granel',
  sku: '1003',
  price: 60,
  sales_units_30d: 100,
  units: [
    { unit: 'KG', factor: 1 },
    { unit: 'BTO', factor: 20 },
  ],
} as unknown as PriceRow;

function montar() {
  const api = dobleApi({
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'CLI-1', name: 'Super San Juan', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogForCustomer: { priceListId: 'pl1', prices: [conCaja, sinCaja, bulto] },
    // Cuando entre [VTK.11] (#415) la pantalla abre con catalogInstant; el doble responde a los dos.
    catalogInstant: { priceListId: 'pl1', prices: [conCaja, sinCaja, bulto], origen: 'servidor', at: Date.now() },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
  });
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
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
  /** Texto del renglón de contenido de la fila cuyo nombre contiene `nombre`, o null. */
  const contenidoDe = (nombre: string): string | null => {
    const fila = Array.from(el.querySelectorAll('.prod')).find((f) => f.querySelector('.pn')?.textContent?.includes(nombre));
    const c = fila?.querySelector('.box-c');
    return c ? (c.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  /** Elige la unidad en la fila del producto (como tocar el chip). */
  const elegir = (nombre: string, unidad: string) => {
    const cmp = fixture.componentInstance;
    const p = cmp.prices().find((x) => x.product_name.includes(nombre));
    if (!p) throw new Error('sin producto ' + nombre);
    cmp.setUnit(p, unidad);
    fixture.detectChanges();
  };
  /** Texto de la línea de la caja elegida en la fila de `nombre`, o null. */
  const cajaElegidaDe = (nombre: string): string | null => {
    const fila = Array.from(el.querySelectorAll('.prod')).find((f) => f.querySelector('.pn')?.textContent?.includes(nombre));
    const c = fila?.querySelector('.box-sel');
    return c ? (c.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  return { fixture, el, buscar, contenidoDe, elegir, cajaElegidaDe };
}

describe('Tomar pedido · contenido de la caja al buscar', () => {
  it('⭐ al buscar, la fila dice cuántos paquetes y piezas trae la caja', () => {
    const { buscar, contenidoDe } = montar();
    buscar('paleta payaso');
    expect(contenidoDe('Paleta Payaso')).toBe('1 CJA trae 12 PAQ · 144 PZA');
  });

  it('se va actualizando con lo que se teclea (todas las coincidencias, cada una con su caja)', () => {
    const { buscar, contenidoDe, el } = montar();
    buscar('paleta');
    expect(el.querySelectorAll('.prod').length).toBe(3);
    expect(contenidoDe('Paleta Payaso')).toBe('1 CJA trae 12 PAQ · 144 PZA');
    expect(contenidoDe('granel')).toBe('1 BTO trae 20 KG');
    // Prueba negativa: la escalera de la sucursal NO declara caja → no se inventa con el PAQ de 40.
    expect(contenidoDe('Vero Mango')).toBeNull();

    buscar('paleta payaso');
    expect(el.querySelectorAll('.prod').length).toBe(1);
    expect(el.querySelectorAll('.box-c').length).toBe(1);
  });

  it('sin búsqueda (catálogo y habituales) la fila no cambia', () => {
    const { el, buscar } = montar();
    expect(el.textContent).toContain('Catálogo · más vendidos');
    expect(el.querySelectorAll('.prod').length).toBeGreaterThan(0);
    expect(el.querySelector('.box-c')).toBeNull();
    // Y al borrar la búsqueda desaparece.
    buscar('paleta');
    expect(el.querySelector('.box-c')).not.toBeNull();
    buscar('');
    expect(el.querySelector('.box-c')).toBeNull();
  });
});

describe('[VTK.12] Tomar pedido · al elegir caja, cuántas piezas trae', () => {
  it('⭐ sin buscar, al elegir CJA la fila dice cuántas piezas trae la caja', () => {
    const { elegir, cajaElegidaDe } = montar();
    // Prueba negativa: con la unidad por defecto (la más chica) no aparece.
    expect(cajaElegidaDe('Paleta Payaso')).toBeNull();
    elegir('Paleta Payaso', 'CJA');
    expect(cajaElegidaDe('Paleta Payaso')).toBe('1 CJA = 144 PZA');
  });

  it('al volver a pieza o paquete desaparece', () => {
    const { elegir, cajaElegidaDe } = montar();
    elegir('Paleta Payaso', 'CJA');
    elegir('Paleta Payaso', 'PAQ');
    expect(cajaElegidaDe('Paleta Payaso')).toBeNull();
  });

  it('⭐ con cantidad en el pedido, dice también cuántas piezas lleva', () => {
    const { fixture, elegir, cajaElegidaDe } = montar();
    fixture.componentInstance.cartLines.set([{ product_id: 'p1', quantity: 288 } as never]);
    elegir('Paleta Payaso', 'CJA');
    expect(cajaElegidaDe('Paleta Payaso')).toBe('1 CJA = 144 PZA · en el pedido 288 PZA');
  });

  it('la unidad base es la del producto: un bulto dice kilos', () => {
    const { elegir, cajaElegidaDe } = montar();
    elegir('granel', 'BTO');
    expect(cajaElegidaDe('granel')).toBe('1 BTO = 20 KG');
  });

  it('⭐ sin caja declarada, elegir el paquete más grande no inventa una caja', () => {
    const { elegir, cajaElegidaDe } = montar();
    elegir('Vero Mango', 'PAQ');
    expect(cajaElegidaDe('Vero Mango')).toBeNull();
  });

  it('en la búsqueda no se repite: ahí ya está la línea de la caja', () => {
    const { buscar, elegir, cajaElegidaDe, contenidoDe } = montar();
    buscar('paleta payaso');
    elegir('Paleta Payaso', 'CJA');
    expect(contenidoDe('Paleta Payaso')).toBe('1 CJA trae 12 PAQ · 144 PZA');
    expect(cajaElegidaDe('Paleta Payaso')).toBeNull();
  });
});
