import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ConteoCajonComponent } from './conteo-cajon.component';

/**
 * Contar lo que sale del cajón (Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo»).
 * Lo que importa: se teclean piezas, el importe se deriva, y el veredicto lo dice en palabras.
 */
function montar(total: number) {
  TestBed.configureTestingModule({ imports: [ConteoCajonComponent], providers: [provideZonelessChangeDetection()] });
  const fx = TestBed.createComponent(ConteoCajonComponent);
  fx.componentRef.setInput('total', total);
  fx.detectChanges();
  return { fx, cmp: fx.componentInstance, el: fx.nativeElement as HTMLElement };
}

describe('ConteoCajonComponent', () => {
  it('sin piezas dice cuánto sale y pide contar; un campo por denominación, con su nombre', () => {
    const { el } = montar(1250);
    expect(el.textContent).toContain('cuenta las piezas que entregas');
    expect(el.querySelectorAll('input').length).toBe(13); // 6 billetes + 6 monedas + morralla
    expect(el.querySelector('[aria-label="Piezas de $1,000"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Piezas de $20 en moneda"]')).not.toBeNull();
  });

  it('[negativa] de menos lo dice con la cifra, y no está listo', () => {
    const { cmp, fx, el } = montar(1250);
    cmp.poner('1000', 1);
    fx.detectChanges();
    expect(cmp.veredicto().ok).toBe(false);
    expect(el.textContent).toContain('faltan $250.00');
  });

  it('cuadra: piezas + morralla = lo que sale; las piezas en cero no quedan', () => {
    const { cmp, fx, el } = montar(1250.39);
    cmp.poner('1000', 1);
    cmp.poner('200', 1);
    cmp.poner('50', 1);
    cmp.poner('20', 0);
    cmp.morralla.set(0.39);
    fx.detectChanges();
    expect(cmp.piezas()).toEqual({ '1000': 1, '200': 1, '50': 1 });
    expect(cmp.veredicto().ok).toBe(true);
    expect(el.textContent).toContain('Cuadra');
  });
});
