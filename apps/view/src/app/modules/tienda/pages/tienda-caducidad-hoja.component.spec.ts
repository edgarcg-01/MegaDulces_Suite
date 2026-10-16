import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, ExpiryHoja } from '../../comercial/comercial.service';
import { TiendaCaducidadHojaComponent } from './tienda-caducidad-hoja.component';

/**
 * `[P2.6.12]` La hoja que se IMPRIME y se archiva no puede decir «Sí» cuando sólo se fechó una parte.
 * Es el papel que firma el encargado: el renglón «Reflejado en inventario» es evidencia.
 */
const hoja = (extra: Partial<ExpiryHoja>): ExpiryHoja => ({
  id: 'l1', folio: 'CAD-03-2026-00001', review_id: 'r1', review_date: '2026-10-16',
  product_id: 'p1', product_name_raw: 'Mazapán', quantity: '10.000', unit: 'caja', expiry_date: '2027-03-15',
  warehouse_code: '03', warehouse_name: '8 Esquinas', files: [], ...extra,
} as ExpiryHoja);

describe('TiendaCaducidadHojaComponent · «Reflejado en inventario»', () => {
  let fix: ComponentFixture<TiendaCaducidadHojaComponent>;

  async function montar(h: ExpiryHoja): Promise<string> {
    await TestBed.configureTestingModule({
      imports: [TiendaCaducidadHojaComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ folioOrId: h.folio ?? 'x' }) } } },
        { provide: ComercialService, useValue: { getExpiryHoja: () => of(h) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaCaducidadHojaComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const fila = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('tr'))
      .find((tr) => tr.querySelector('th')?.textContent?.includes('Reflejado en inventario'));
    return (fila?.querySelector('td')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  it('⭐ se fechó todo → «Sí — se fecharon 10 cajas…»', async () => {
    expect(await montar(hoja({ fed_to_fefo: true, fefo_qty: '10.000' })))
      .toBe('Sí — se fecharon 10 cajas en el control de caducidad (FEFO)');
  });

  it('⭐ se fechó una PARTE → «Parcial», con cuánto de cuánto y cuánto quedó sin fechar (nunca «Sí»)', async () => {
    const txt = await montar(hoja({ fed_to_fefo: true, fefo_qty: '4.000' }));
    expect(txt).toMatch(/^Parcial — se fecharon 4 de 10 cajas/);
    expect(txt).toContain('quedaron 6 sin fechar');
    expect(txt).not.toMatch(/^Sí/);
  });

  it('no se movió nada → «No», con el motivo', async () => {
    expect(await montar(hoja({ fed_to_fefo: false, fefo_qty: '0.000', product_id: null })))
      .toBe('No — la hoja queda como registro; no movió inventario (el producto no está en el catálogo)');
  });
});
