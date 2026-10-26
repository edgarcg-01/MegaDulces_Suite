/**
 * [E.29] Con % de cliente, la columna Importe pinta lo que dice la hoja (el neto) y de dónde sale.
 * Antes pintaba el renglón de Kepler, antes del %, mientras el PDF del mismo folio traía el neto:
 * GOMA PEELERZ × 1 CJA con 2 % se veía $739.20 en pantalla y $724.42 en el papel.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';

import { QuoteLinesTableComponent, RenglonTabla } from './quote-lines-table.component';

const PEELERZ: RenglonTabla = {
  id: 'r1', numero: 1, nombre: 'GOMA PEELERZ UVA 85G / 1', sinCasar: false, regaloDe: null, notaRegalo: null,
  unidad: 'CJA', factor: 24, cantidad: 1, editable: false, admiteFraccion: false, existencia: null,
  lista: 739.21, precio: 739.2, desglose: [], fuente: 'list', dtoPct: null, pasos: '', explicacion: '',
  importe: 739.2, neto: null,
};

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
});
