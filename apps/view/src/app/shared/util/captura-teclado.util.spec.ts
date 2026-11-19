import { describe, expect, it, vi } from 'vitest';
import { columnaPorTecla, movimientoPorTecla, moverEnRenglon, moverEntreCampos, pasoPorTecla, type TeclaPaso } from './captura-teclado.util';

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

describe('[PQ.129.2] columnaPorTecla — Ctrl + ← → cambia de caja en el renglón', () => {
  it('Ctrl+→ / Ctrl+← (y ⌘ en Mac) dan +1 / −1', () => {
    expect(columnaPorTecla(T('ArrowRight', { ctrlKey: true }))).toBe(1);
    expect(columnaPorTecla(T('ArrowLeft', { ctrlKey: true }))).toBe(-1);
    expect(columnaPorTecla(T('ArrowRight', { metaKey: true }))).toBe(1);
  });
  it('⛔ ← → solas siguen siendo PASO (RA-PRO.57), no cambio de columna', () => {
    expect(columnaPorTecla(T('ArrowRight'))).toBe(0);
    expect(pasoPorTecla(T('ArrowRight'))).toBe(1);
    expect(columnaPorTecla(T('ArrowLeft'))).toBe(0);
  });
  it('con Shift o Alt además, nada (Ctrl+Shift+← selecciona texto)', () => {
    expect(columnaPorTecla(T('ArrowRight', { ctrlKey: true, shiftKey: true }))).toBe(0);
    expect(columnaPorTecla(T('ArrowLeft', { ctrlKey: true, altKey: true }))).toBe(0);
    expect(columnaPorTecla(T('ArrowUp', { ctrlKey: true }))).toBe(0);
  });
  it('ninguna tecla cambia de columna Y da paso o mueve de renglón a la vez', () => {
    const teclas = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'];
    const mods: Partial<TeclaPaso>[] = [{}, { altKey: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }];
    for (const k of teclas) for (const m of mods) {
      const c = columnaPorTecla(T(k, m)) !== 0;
      expect(c && (pasoPorTecla(T(k, m)) !== 0 || movimientoPorTecla(T(k, m)) !== 0)).toBe(false);
    }
  });
});

describe('[PQ.129.2] moverEnRenglon — de Traspaso a Pedir sin salir del renglón', () => {
  /** Dos renglones de [traspaso, pedido]; jsdom no maqueta, así que «visible» se simula. */
  function tabla() {
    const t = document.createElement('table');
    const filas = [0, 1].map(() => {
      const tr = t.insertRow();
      return ['tr', 'q'].map((cls) => {
        const el = document.createElement('input');
        el.className = cls;
        Object.defineProperty(el, 'offsetParent', { get: () => t });
        tr.insertCell().appendChild(el);
        return el;
      });
    });
    document.body.appendChild(t);
    return { t, filas };
  }
  const ev = (key: string, target: HTMLElement, m: Partial<KeyboardEvent> = {}) =>
    ({ key, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...m }) as unknown as KeyboardEvent;

  it('Ctrl+→ pasa de Traspaso a Pedir del MISMO renglón y lo deja seleccionado; Ctrl+← regresa', () => {
    const { t, filas } = tabla();
    filas[0][1].value = '7';
    const sel = vi.spyOn(filas[0][1], 'select');
    expect(moverEnRenglon(ev('ArrowRight', filas[0][0], { ctrlKey: true }), 'input.tr, input.q')).toBe(true);
    expect(document.activeElement).toBe(filas[0][1]);
    expect(sel).toHaveBeenCalled();
    expect(moverEnRenglon(ev('ArrowLeft', filas[0][1], { ctrlKey: true }), 'input.tr, input.q')).toBe(true);
    expect(document.activeElement).toBe(filas[0][0]);
    t.remove();
  });

  it('⛔ en el borde no salta al renglón de abajo y NO corta lo nativo', () => {
    const { t, filas } = tabla();
    filas[0][1].focus();
    const e = ev('ArrowRight', filas[0][1], { ctrlKey: true });
    expect(moverEnRenglon(e, 'input.tr, input.q')).toBe(false);
    expect(document.activeElement).toBe(filas[0][1]);       // no se fue a filas[1][0]
    expect(e.preventDefault).not.toHaveBeenCalled();
    t.remove();
  });

  it('una caja deshabilitada no es destino', () => {
    const { t, filas } = tabla();
    filas[1][1].disabled = true;
    filas[1][0].focus();
    expect(moverEnRenglon(ev('ArrowRight', filas[1][0], { ctrlKey: true }), 'input.tr, input.q')).toBe(false);
    expect(document.activeElement).toBe(filas[1][0]);
    t.remove();
  });

  it('→ sin Ctrl no mueve (es paso) y no toca nada', () => {
    const { t, filas } = tabla();
    const e = ev('ArrowRight', filas[0][0]);
    expect(moverEnRenglon(e, 'input.tr, input.q')).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    t.remove();
  });
});
