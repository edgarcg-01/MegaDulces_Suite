/**
 * [E.29] Con % de cliente, la columna Importe pinta lo que dice la hoja (el neto) y de dónde sale.
 * Antes pintaba el renglón de Kepler, antes del %, mientras el PDF del mismo folio traía el neto:
 * GOMA PEELERZ × 1 CJA con 2 % se veía $739.20 en pantalla y $724.42 en el papel.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { QuoteLinesTableComponent, RenglonTabla } from './quote-lines-table.component';

const PEELERZ: RenglonTabla = {
  id: 'r1', numero: 1, nombre: 'GOMA PEELERZ UVA 85G / 1', sku: '43103', sinCasar: false, regaloDe: null, notaRegalo: null,
  unidad: 'CJA', factor: 24, cantidad: 1, editable: false, admiteFraccion: false, existencia: null,
  lista: 739.21, precio: 739.2, desglose: [], fuente: 'list', dtoPct: null, pasos: '', explicacion: '',
  importe: 739.2, neto: null, sinRedondear: null,
};

function deDondeSale(renglones: RenglonTabla[], clientePct: number | null): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(QuoteLinesTableComponent);
  f.componentRef.setInput('renglones', renglones);
  f.componentRef.setInput('clientePct', clientePct);
  f.detectChanges();
  const celda = (f.nativeElement as HTMLElement).querySelector('td[data-label="De dónde sale"]');
  return Array.from(celda?.querySelectorAll('.p-tag-label, .dto, .pasos') ?? []).map((e) => (e.textContent ?? '').trim()).join(' | ');
}

function pintar(renglones: RenglonTabla[], clientePct: number | null): string {
  TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(QuoteLinesTableComponent);
  f.componentRef.setInput('renglones', renglones);
  f.componentRef.setInput('clientePct', clientePct);
  f.detectChanges();
  const celda = (f.nativeElement as HTMLElement).querySelector('td[data-label="Importe"]');
  const texto = (e: Element | null | undefined): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  // El neto y el «antes» van en dos renglones (display:block): se leen por separado.
  const antes = celda?.querySelector('.imp-antes');
  return antes ? `${texto(celda?.querySelector('.p-unit-main'))} | ${texto(antes)}` : texto(celda);
}

describe('QuoteLinesTableComponent — Importe con el % del cliente', () => {
  it('con % de cliente pinta el neto y, abajo, el renglón de Kepler antes del %', () => {
    expect(pintar([{ ...PEELERZ, neto: 724.42 }], 2)).toBe('$724.42 | $739.20 − 2 % cliente');
  });

  it('sin % de cliente pinta el importe tal cual', () => {
    expect(pintar([PEELERZ], null)).toBe('$739.20');
  });

  it('«De dónde sale» dice el centavo de Kepler y, si hay, el descuento del cliente', () => {
    const r: RenglonTabla = {
      ...PEELERZ, neto: 724.42, sinRedondear: 739.21, desglose: [{ cantidad: 24, unidad: 'PAQ', precio: 30.8 }],
    };
    expect(deDondeSale([r], 2)).toBe(
      'Lista | Kepler redondea por PAQ a centavos: $739.21 → 24 × $30.80 = $739.20 | Descuento del cliente | −2%',
    );
    // Sin % de cliente: sólo la lista y el redondeo.
    expect(deDondeSale([{ ...r, neto: null }], null)).toBe(
      'Lista | Kepler redondea por PAQ a centavos: $739.21 → 24 × $30.80 = $739.20',
    );
  });
});

describe('QuoteLinesTableComponent — [E.30] el SKU va con el producto', () => {
  function celdaProducto(r: RenglonTabla): string {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [QuoteLinesTableComponent], providers: [provideZonelessChangeDetection()] });
    const f = TestBed.createComponent(QuoteLinesTableComponent);
    f.componentRef.setInput('renglones', [r]);
    f.detectChanges();
    const celda = (f.nativeElement as HTMLElement).querySelector('td.dt-id');
    // Cada pieza por separado: Angular quita el espacio entre los <span>, y en pantalla van en renglones.
    return Array.from(celda?.querySelectorAll('.p-name, .p-sku, .sin-casar') ?? []).map((e) => (e.textContent ?? '').trim()).join(' | ');
  }

  it('un renglón del catálogo dice su SKU debajo del nombre', () => {
    expect(celdaProducto(PEELERZ)).toBe('GOMA PEELERZ UVA 85G / 1 | SKU 43103');
  });

  it('NEGATIVA: un renglón sin casar no inventa SKU', () => {
    expect(celdaProducto({ ...PEELERZ, sku: null, sinCasar: true, nombre: 'gomitas raras' })).toBe('gomitas raras | sin casar con el catálogo');
  });
});
