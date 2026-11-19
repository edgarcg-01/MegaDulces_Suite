import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../shared/util/print-isolated', () => ({ printIsolated: vi.fn() }));

import { printIsolated } from '../../../../shared/util/print-isolated';
import { AndenCartelComponent, type CartelUbicacion } from './anden-cartel.component';

/**
 * `[UB.RF.12]` El cartel de ubicación en sus dos tamaños. En la TIENDA un cartel de media carta le quita
 * vista al producto: va una etiqueta chica (6.7 × 2.5 cm, 30 por hoja carta, tipo 5160) para el canto del
 * anaquel, con el mismo CODE128 del código que lee la pantalla «Ubicar productos».
 */

const U = (n: number): CartelUbicacion[] =>
  Array.from({ length: n }, (_, i) => ({ code: `TA0${String(11 + i).padStart(2, '0')}`.slice(0, 5), label: 'Tienda · nivel 1', almacen: '01' }));

function montar(ubicaciones: CartelUbicacion[], formato?: 'cartel' | 'etiqueta') {
  TestBed.configureTestingModule({ imports: [AndenCartelComponent] });
  const fix = TestBed.createComponent(AndenCartelComponent);
  fix.componentRef.setInput('ubicaciones', ubicaciones);
  if (formato) fix.componentRef.setInput('formato', formato);
  fix.detectChanges();
  return { fix, el: fix.nativeElement as HTMLElement };
}

describe('[UB.RF.12] cartel de ubicación · etiqueta chica para la tienda', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.mocked(printIsolated).mockClear();
  });

  it('⭐ etiqueta: una por ubicación, con su código y su código de barras, y el botón dice cuántas hojas', async () => {
    const { fix, el } = montar(U(31), 'etiqueta');
    await fix.whenStable();
    await Promise.resolve();
    const etiquetas = el.querySelectorAll('.ct-et');
    expect(etiquetas.length).toBe(31);
    expect(etiquetas[0].querySelector('.ct-et-code')?.textContent?.trim()).toBe('TA011');
    expect(etiquetas[0].querySelector('svg.ct-bar')?.getAttribute('data-code')).toBe('TA011');
    expect(el.querySelector('.ct-cartel')).toBeNull();
    expect(el.textContent).toContain('Imprimir las 31 etiquetas (2 hojas)');
    expect(el.textContent).toContain('30 por hoja carta');
  });

  it('⭐ imprime en hoja carta, 3 columnas de 66.675 mm con los márgenes de la hoja de etiquetas', () => {
    const { fix } = montar(U(3), 'etiqueta');
    fix.componentInstance.imprimir();
    expect(printIsolated).toHaveBeenCalledTimes(1);
    const o = vi.mocked(printIsolated).mock.calls[0][0];
    expect(o.page).toBe('size: letter portrait; margin: 12.7mm 4.7625mm 12.6mm 4.7625mm;');
    expect(o.html.startsWith('<div class="ct-hoja-et">')).toBe(true);
    expect(o.css).toContain('grid-template-columns:repeat(3,66.675mm)');
    expect(o.css).toContain('column-gap:3.175mm');
    expect(o.css).toContain('height:25.4mm');
  });

  it('las medidas caben en la hoja carta: 215.9 mm de ancho y 10 renglones en 279.4 mm', () => {
    const ancho = 3 * 66.675 + 2 * 3.175 + 2 * 4.7625;
    const alto = 10 * 25.4 + 12.7 + 12.6;
    expect(Math.abs(ancho - 215.9)).toBeLessThan(0.001);
    expect(alto).toBeLessThanOrEqual(279.4);
  });

  it('NEGATIVA: sin formato sigue siendo el cartel de media carta de la bodega, dos por hoja', () => {
    const { fix, el } = montar(U(2));
    expect(el.querySelectorAll('.ct-cartel').length).toBe(2);
    expect(el.querySelector('.ct-et')).toBeNull();
    expect(el.textContent).toContain('Imprimir los 2 carteles');
    fix.componentInstance.imprimir();
    const o = vi.mocked(printIsolated).mock.calls[0][0];
    expect(o.page).toBe('size: letter portrait; margin: 0;');
    expect(o.html).not.toContain('ct-hoja-et');
  });
});
