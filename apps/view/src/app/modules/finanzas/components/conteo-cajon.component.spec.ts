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

  it('[LE.6.11] se cuenta sin mouse: ↓ / Enter a la pieza siguiente, ↑ a la anterior, y la flecha NO cambia el número', () => {
    const { cmp, el } = montar(1250);
    const campos = [...el.querySelectorAll<HTMLInputElement>('input.cc-in')];
    const tecla = (t: HTMLElement, key: string) => t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    campos[0].focus();
    tecla(campos[0], 'ArrowDown');
    expect(document.activeElement).toBe(campos[1]);
    tecla(campos[1], 'Enter');
    expect(document.activeElement).toBe(campos[2]);
    tecla(campos[2], 'ArrowUp');
    expect(document.activeElement).toBe(campos[1]);
    // NEGATIVA: p-inputnumber usaría ↑ ↓ para sumar o restar una pieza; aquí sólo mueven el foco.
    expect(cmp.piezas()).toEqual({});
    expect(el.querySelector('[data-testid="cc-atajo"]')?.textContent).toContain('entre piezas');
  });

  it('[LE.6.11] desde la última pieza, ↓ sale al siguiente campo (quién recibe, o el botón)', () => {
    const { el } = montar(1250);
    const siguiente = document.createElement('button');
    siguiente.textContent = 'Registrar';
    el.after(siguiente);
    const campos = [...el.querySelectorAll<HTMLInputElement>('input.cc-in')];
    const ultimo = campos[campos.length - 1];
    ultimo.focus();
    ultimo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(siguiente);
    siguiente.remove();
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
