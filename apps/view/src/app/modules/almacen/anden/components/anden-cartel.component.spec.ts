import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../shared/util/print-isolated', () => ({ printIsolated: vi.fn() }));

import { printIsolated } from '../../../../shared/util/print-isolated';
import { AndenCartelComponent, type CartelUbicacion } from './anden-cartel.component';

/**
 * `[UB.RF.12]` El cartel de ubicación en sus dos tamaños. En la TIENDA un cartel de media carta le quita
 * vista al producto: va una etiqueta chica para el canto del anaquel, con el mismo CODE128 del código que lee
 * la pantalla «Ubicar productos». `[UB.RF.14]` Esa etiqueta sale en la TSC TE200, rollo amarillo, 3 por fila.
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

  it('⭐ etiqueta: una por ubicación, con su código y su código de barras, y el botón dice cuántas filas de la TSC', async () => {
    const { fix, el } = montar(U(31), 'etiqueta');
    await fix.whenStable();
    await Promise.resolve();
    const etiquetas = el.querySelectorAll('.ct-et');
    expect(etiquetas.length).toBe(31);
    expect(etiquetas[0].querySelector('.ct-et-code')?.textContent?.trim()).toBe('TA011');
    expect(etiquetas[0].querySelector('.ct-et-arriba')?.textContent?.trim()).toBe('01 · Tienda · nivel 1');
    expect(etiquetas[0].querySelector('svg.ct-bar')?.getAttribute('data-code')).toBe('TA011');
    expect(el.querySelector('.ct-cartel')).toBeNull();
    expect(el.textContent).toContain('Imprimir las 31 etiquetas (11 filas de la TSC)');
    expect(el.textContent).toContain('rollo amarillo');
  });

  it('⭐ imprime a la TSC TE200: una hoja de 100 × 48 mm por fila de 3, con la etiquetera compartida', () => {
    const { fix } = montar(U(4), 'etiqueta');
    fix.componentInstance.imprimir();
    expect(printIsolated).toHaveBeenCalledTimes(1);
    const o = vi.mocked(printIsolated).mock.calls[0][0];
    expect(o.page).toBe('size: 100mm 48mm; margin: 0;');
    expect(o.html.match(/class="et-fila"/g)).toHaveLength(2);
    expect(o.html).toContain('TA014');
    expect(o.css).toContain('.et{box-sizing:border-box;width:32mm');
  });

  it('NEGATIVA: la hoja carta tipo 5160 ya no existe en el formato etiqueta', () => {
    const { fix } = montar(U(3), 'etiqueta');
    fix.componentInstance.imprimir();
    const o = vi.mocked(printIsolated).mock.calls[0][0];
    expect(o.page).not.toContain('letter');
    expect(o.css).not.toContain('66.675mm');
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
