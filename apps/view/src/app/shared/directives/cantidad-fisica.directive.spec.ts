import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CantidadFisicaDirective } from './cantidad-fisica.directive';

/**
 * `[IC.F8][IC.F9]` — **Candado de la captura de una cantidad contada.**
 *
 * ## Alcance de lo que afirma
 *
 * ⛔ **No monta `p-inputnumber` de verdad**, y no podría: `ArrowDown` sobre un `input` con 34 deja
 * **34 en jsdom** y **33 en Chrome**, así que una prueba que mirara el número saldría verde exista
 * o no el arreglo. Lo que sí se puede afirmar sin navegador, y es el mecanismo entero del arreglo:
 * **el evento de la flecha nunca llega al escucha que PrimeNG pone en el `<input>`**, y el Enter sí.
 *
 * El doble suplente (`PrimeNgFalso`) imita las dos piezas que importan de PrimeNG 22.1.4: un
 * `<input>` adentro con su propio escucha de `keydown`, y un `click` que **deshace la selección**
 * (su `onInputClick` → `initCursor`). Sin esa segunda pieza, F8 saldría verde sin estar arreglado.
 */
@Component({
  selector: 'p-inputnumber',
  standalone: true,
  template: '<input type="text" />',
})
class PrimeNgFalso {}

@Component({
  standalone: true,
  imports: [PrimeNgFalso, CantidadFisicaDirective],
  template: `
    <p-inputnumber appCantidadFisica class="con"></p-inputnumber>
    <p-inputnumber class="sin"></p-inputnumber>
  `,
})
class Anfitrion {}

describe('[IC.F8][IC.F9] la cantidad contada: ni la flecha la cambia ni corregirla concatena', () => {
  function montar() {
    const fix = TestBed.createComponent(Anfitrion);
    fix.detectChanges();
    const raiz = fix.nativeElement as HTMLElement;
    const campo = (cual: 'con' | 'sin') =>
      raiz.querySelector(`p-inputnumber.${cual} input`) as HTMLInputElement;
    /** El escucha que PrimeNG pone en el `<input>`: cuenta qué teclas le llegan. */
    const espiarPrimeNg = (el: HTMLInputElement) => {
      const recibidas: string[] = [];
      el.addEventListener('keydown', (ev) => recibidas.push((ev as KeyboardEvent).key));
      return recibidas;
    };
    const tecla = (el: HTMLInputElement, key: string) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return { fix, campo, espiarPrimeNg, tecla };
  }

  it('CONTROL — sin la directiva, la flecha SÍ llega a PrimeNG (el instrumento mide algo)', () => {
    const { campo, espiarPrimeNg, tecla } = montar();
    const el = campo('sin');
    const recibidas = espiarPrimeNg(el);
    tecla(el, 'ArrowDown');
    expect(recibidas).toEqual(['ArrowDown']);
  });

  it('⛔ la flecha NO llega a PrimeNG: no hay spin, el número no cambia', () => {
    const { campo, espiarPrimeNg, tecla } = montar();
    const el = campo('con');
    const recibidas = espiarPrimeNg(el);
    tecla(el, 'ArrowDown');
    tecla(el, 'ArrowUp');
    expect(recibidas).toEqual([]);
  });

  it('el Enter SIGUE llegando: registrar el conteo no se rompe', () => {
    const { campo, espiarPrimeNg, tecla } = montar();
    const el = campo('con');
    const recibidas = espiarPrimeNg(el);
    tecla(el, 'Enter');
    tecla(el, '3');
    expect(recibidas).toEqual(['Enter', '3']);
  });

  it('al enfocar se selecciona TODO: teclear 3 sobre 75 deja 3, no 753', () => {
    const { campo } = montar();
    const el = campo('con');
    el.value = '75';
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 2]);
  });

  it('⭐ y el clic de PrimeNG, que DESHACE la selección, no gana', () => {
    const { campo } = montar();
    const el = campo('con');
    el.value = '75';
    // `onInputClick` → `initCursor()`: colapsa la selección. Va en el <input>, o sea ANTES
    // que el nuestro, que escucha en el <p-inputnumber>.
    el.addEventListener('click', () => el.setSelectionRange(2, 2));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 2]);
  });

  it('PRUEBA NEGATIVA — sin la directiva, enfocar no selecciona nada', () => {
    const { campo } = montar();
    const el = campo('sin');
    el.value = '75';
    el.setSelectionRange(2, 2);
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect([el.selectionStart, el.selectionEnd]).toEqual([2, 2]);
  });
});
