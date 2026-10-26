import { describe, expect, it, vi } from 'vitest';
import { movimientoPorTecla, moverEntreCampos, pasoPorTecla, type TeclaPaso } from './captura-teclado.util';

const T = (key: string, m: Partial<TeclaPaso> = {}): TeclaPaso =>
  ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...m });

describe('[AB.41] movimientoPorTecla — qué tecla cambia de renglón', () => {
  it('↓ y Enter van al siguiente; ↑ y Shift+Enter al anterior', () => {
    expect(movimientoPorTecla(T('ArrowDown'))).toBe(1);
    expect(movimientoPorTecla(T('Enter'))).toBe(1);
    expect(movimientoPorTecla(T('ArrowUp'))).toBe(-1);
    expect(movimientoPorTecla(T('Enter', { shiftKey: true }))).toBe(-1);
  });
  it('⛔ Alt + ↑ ↓ son PASO, no movimiento (no pueden hacer las dos cosas)', () => {
    expect(movimientoPorTecla(T('ArrowUp', { altKey: true }))).toBe(0);
    expect(pasoPorTecla(T('ArrowUp', { altKey: true }))).toBe(1);
    expect(movimientoPorTecla(T('ArrowDown', { altKey: true }))).toBe(0);
    expect(pasoPorTecla(T('ArrowDown', { altKey: true }))).toBe(-1);
  });
  it('← → y los dígitos no mueven', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', '5', 'Tab']) expect(movimientoPorTecla(T(k))).toBe(0);
  });
  it('ninguna tecla mueve Y da paso a la vez', () => {
    const teclas = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];
    const mods: Partial<TeclaPaso>[] = [{}, { altKey: true }, { shiftKey: true }, { ctrlKey: true }];
    for (const k of teclas) for (const m of mods) {
      expect(movimientoPorTecla(T(k, m)) !== 0 && pasoPorTecla(T(k, m)) !== 0).toBe(false);
    }
  });
});

describe('[AB.41] moverEntreCampos — recorre la columna en el orden en que se ve', () => {
  /** jsdom no maqueta: `offsetParent` es siempre null. Se simula «visible» por campo. */
  function columna(n: number, ocultos: number[] = []) {
    const raiz = document.createElement('div');
    const campos = Array.from({ length: n }, (_, i) => {
      const el = document.createElement('input');
      el.className = 'q';
      Object.defineProperty(el, 'offsetParent', { get: () => (ocultos.includes(i) ? null : raiz) });
      raiz.appendChild(el);
      return el;
    });
    document.body.appendChild(raiz);
    return { raiz, campos };
  }
  const ev = (key: string, target: HTMLElement, m: Partial<KeyboardEvent> = {}) =>
    ({ key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...m }) as unknown as KeyboardEvent;

  it('↓ pasa al siguiente y lo deja seleccionado; ↑ regresa', () => {
    const { raiz, campos } = columna(3);
    campos[0].value = '12';
    expect(moverEntreCampos(ev('ArrowDown', campos[0]), raiz, 'input.q')).toBe(true);
    expect(document.activeElement).toBe(campos[1]);
    expect(moverEntreCampos(ev('ArrowUp', campos[1]), raiz, 'input.q')).toBe(true);
    expect(document.activeElement).toBe(campos[0]);
    raiz.remove();
  });

  it('salta los ocultos y los deshabilitados', () => {
    const { raiz, campos } = columna(4, [1]);
    campos[2].disabled = true;
    moverEntreCampos(ev('Enter', campos[0]), raiz, 'input.q');
    expect(document.activeElement).toBe(campos[3]);
    raiz.remove();
  });

  it('⛔ en el borde no da la vuelta, pero sí corta lo nativo (el ↓ no resta 1 al número)', () => {
    const { raiz, campos } = columna(2);
    campos[1].focus();
    const e = ev('ArrowDown', campos[1]);
    expect(moverEntreCampos(e, raiz, 'input.q')).toBe(true);
    expect(document.activeElement).toBe(campos[1]);
    expect(e.preventDefault).toHaveBeenCalled();
    raiz.remove();
  });

  it('una tecla que no mueve no toca nada', () => {
    const { raiz, campos } = columna(2);
    const e = ev('ArrowRight', campos[0]);
    expect(moverEntreCampos(e, raiz, 'input.q')).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    raiz.remove();
  });
});
