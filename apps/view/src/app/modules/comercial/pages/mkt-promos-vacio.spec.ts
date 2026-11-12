import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { MessageService, ConfirmationService } from 'primeng/api';

import { ComercialPromotionsComponent } from './comercial-promotions.component';
import { ComercialErpPromosComponent } from './comercial-erp-promos.component';
import { ComercialService, type ErpPromoRow } from '../comercial.service';
import { throwError } from 'rxjs';

/**
 * `[MKT.7]` Lo que las dos pantallas de Promociones MKT AFIRMAN cuando no hay filas o cuando la
 * consulta falla, y cómo dicen el beneficio de una regla de Kepler.
 *
 * Medido en prod el 2026-11-11: `commercial.promotions` tiene 0 filas, y Mercadotecnia lleva
 * ~90 códigos de promoción por semana en un Excel. «Crea tu primera promoción» mandaba a
 * duplicar a mano lo que ya está en Kepler; y un error se pintaba igual que «no hay».
 */
function montar<T>(cmp: new (...a: never[]) => T) {
  TestBed.configureTestingModule({
    imports: [cmp],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), MessageService, ConfirmationService],
  });
  const fixture = TestBed.createComponent(cmp);
  const http = TestBed.inject(HttpTestingController);
  return { fixture, c: fixture.componentInstance, http };
}

const texto = (el: HTMLElement) => (el.textContent || '').replace(/\s+/g, ' ');

describe('[MKT.7] Promociones (motor de la Suite) · estado vacío', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('vacía: NO dice «Crea tu primera», dice qué lista es y lleva a Promos ERP', () => {
    const { fixture, http } = montar(ComercialPromotionsComponent);
    fixture.detectChanges();
    http.match((r) => r.url.includes('/promotions')).forEach((r) => r.flush({ data: [], pagination: { page: 1, pageSize: 25, total: 0, pageCount: 0 } }));
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(texto(el)).not.toContain('Crea tu primera');
    expect(texto(el)).toContain('Sin promociones');
    const liga = el.querySelector('a[href="/mkt/erp-promos"]');
    expect(liga?.textContent?.trim()).toBe('Promos ERP');
    expect(texto(el)).toContain('0 en total');
  });

  it('si la consulta falla, NO dice «Sin promociones» ni pinta un 0', () => {
    const { fixture, http } = montar(ComercialPromotionsComponent);
    fixture.detectChanges();
    http.match((r) => r.url.includes('/promotions')).forEach((r) => r.flush('x', { status: 500, statusText: 'err' }));
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    const t = texto(fixture.nativeElement as HTMLElement);
    expect(t).toContain('No se pudo cargar');
    expect(t).not.toContain('Sin promociones');
    expect(t).not.toContain('0 en total');
  });
});

describe('[MKT.7] Promos ERP · cómo se dice cada regla', () => {
  afterEach(() => TestBed.resetTestingModule());

  const regla = (o: Partial<ErpPromoRow>): ErpPromoRow => ({
    sku: '88219', product_name: 'GALLETA', promo_type: 'descuento_qty', unit: 'PAQ', threshold: 1,
    threshold_verified: true, benefit_kind: 'pct', benefit: 50, free_product_name: null, free_unit: null,
    valid_from: '2026-10-13', valid_to: '2026-11-13', warehouse_code: 'Morelia Madero', ...o,
  });

  it('el descuento es PORCENTAJE, no pesos', () => {
    const { c } = montar(ComercialErpPromosComponent);
    expect(c.benefitLabel(regla({}))).toBe('50 % de descuento');
    expect(c.benefitLabel(regla({}))).not.toContain('$');
  });

  it('el regalo dice cuánto, en qué presentación y de qué', () => {
    const { c } = montar(ComercialErpPromosComponent);
    expect(c.benefitLabel(regla({ promo_type: 'gratis_qty', benefit_kind: 'free_qty', benefit: 1, free_unit: 'PZA', free_product_name: 'LECHE' })))
      .toBe('Gratis 1 PZA de LECHE');
  });

  it('sin beneficio no se inventa un 0', () => {
    const { c } = montar(ComercialErpPromosComponent);
    expect(c.benefitLabel(regla({ benefit: null }))).toBe('Sin dato');
  });

  it('el umbral va en su presentación; el de monto se declara sin verificar', () => {
    const { c } = montar(ComercialErpPromosComponent);
    expect(c.thresholdLabel(regla({}))).toBe('1 PAQ');
    expect(c.thresholdLabel(regla({ promo_type: 'descuento_monto', threshold: 2, threshold_verified: false }))).toBe('2 (unidad sin verificar)');
  });

  it('el 2106 de Kepler se lee «Sin fin», no como una fecha', () => {
    const { c } = montar(ComercialErpPromosComponent);
    expect(c.validToLabel(regla({ valid_to: '2106-02-28' }))).toBe('Sin fin');
    expect(c.validToLabel(regla({ valid_to: '2026-11-13' }))).toBe('13/11/26');
    expect(c.validToLabel(regla({ valid_to: null }))).toBe('Sin fecha');
  });

  it('si la consulta falla, no dice «Sin reglas vigentes»', async () => {
    TestBed.configureTestingModule({
      imports: [ComercialErpPromosComponent],
      providers: [provideRouter([]), MessageService, { provide: ComercialService, useValue: { erpPromotions: () => throwError(() => new Error('500')) } }],
    });
    const fixture = TestBed.createComponent(ComercialErpPromosComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    const t = texto(fixture.nativeElement as HTMLElement);
    expect(t).toContain('No se pudo leer Kepler');
    expect(t).not.toContain('Sin reglas vigentes');
  });
});
