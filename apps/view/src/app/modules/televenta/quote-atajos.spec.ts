import { describe, it, expect } from 'vitest';
import { atajoDeTecla } from './quote-atajos';

const tecla = (key: string, o: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: EventTarget | null }> = {}) => ({
  key, code: o.code ?? '', ctrlKey: !!o.ctrlKey, metaKey: !!o.metaKey, altKey: !!o.altKey, target: o.target ?? document.body,
});

describe('[COT.33] atajos del cotizador', () => {
  it('«/» fuera de un campo lleva al buscador', () => {
    expect(atajoDeTecla(tecla('/'))).toEqual({ tipo: 'buscar' });
  });

  it('«/» DENTRO de un campo es texto: no se roba (observaciones, lista del cliente)', () => {
    expect(atajoDeTecla(tecla('/', { target: document.createElement('textarea') }))).toBeNull();
    expect(atajoDeTecla(tecla('/', { target: document.createElement('input') }))).toBeNull();
  });

  it('Alt+1/2/3 eligen la unidad por posición, también desde el teclado numérico', () => {
    expect(atajoDeTecla(tecla('1', { code: 'Digit1', altKey: true }))).toEqual({ tipo: 'unidad', indice: 0 });
    expect(atajoDeTecla(tecla('¡', { code: 'Digit3', altKey: true }))).toEqual({ tipo: 'unidad', indice: 2 });
    expect(atajoDeTecla(tecla('2', { code: 'Numpad2', altKey: true }))).toEqual({ tipo: 'unidad', indice: 1 });
  });

  it('el número sin Alt es una cantidad, y Ctrl+Alt no es atajo', () => {
    expect(atajoDeTecla(tecla('1', { code: 'Digit1' }))).toBeNull();
    expect(atajoDeTecla(tecla('1', { code: 'Digit1', altKey: true, ctrlKey: true }))).toBeNull();
  });

  it('Ctrl+Enter crea sólo donde la pantalla lo permite (el detalle no lo ofrece)', () => {
    expect(atajoDeTecla(tecla('Enter', { ctrlKey: true }), { crear: true })).toEqual({ tipo: 'crear' });
    expect(atajoDeTecla(tecla('Enter', { metaKey: true }), { crear: true })).toEqual({ tipo: 'crear' });
    expect(atajoDeTecla(tecla('Enter', { ctrlKey: true }))).toBeNull();
    expect(atajoDeTecla(tecla('Enter'), { crear: true })).toBeNull();
  });
});
