import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installRowNavGuard, bajarAlPrimerRenglon, volverAlBuscador } from './row-nav';

/**
 * `[KBD.1]` Las pruebas están escritas contra el DEFECTO, no contra la implementación: cada
 * bloque de abajo reproduce una tecla que hoy se pierde dentro de una fila seleccionable.
 *
 * ⚠️ El montaje imita el de PrimeNG a propósito — `tr[data-p-selectable-row="true"]` con un
 * listener de `keydown` en la FILA, que es exactamente dónde lo pone `SelectableRow`. Si la
 * prueba inventara su propio montaje, pasaría en verde sobre algo que no existe.
 */
function montar(html: string): { tr: HTMLElement; vistos: string[]; limpiar: () => void } {
  document.body.innerHTML = `<table><tbody>${html}</tbody></table>`;
  const tr = document.querySelector('tr') as HTMLElement;
  const vistos: string[] = [];
  // El manejador de PrimeNG: en la FILA, sin mirar event.target.
  const h = (e: Event) => vistos.push((e as KeyboardEvent).key);
  tr.addEventListener('keydown', h);
  return { tr, vistos, limpiar: () => tr.removeEventListener('keydown', h) };
}

const tecla = (el: Element, key: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));

describe('installRowNavGuard — las teclas que PrimeNG le roba a un campo de la fila', () => {
  let desinstalar: () => void;
  beforeEach(() => { desinstalar = installRowNavGuard(document); });
  afterEach(() => { desinstalar(); document.body.innerHTML = ''; });

  describe('⛔ el defecto medido: 9 de 13 archivos con pSelectableRow tienen controles en línea', () => {
    it('Space NO llega a la fila: hoy impide escribir un espacio', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="text"></td></tr>');
      tecla(tr.querySelector('input')!, 'Space');
      expect(vistos).toEqual([]);
    });

    it('Enter NO llega a la fila: hoy abre el detalle en vez de confirmar', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="text"></td></tr>');
      tecla(tr.querySelector('input')!, 'Enter');
      expect(vistos).toEqual([]);
    });

    it('Home/End NO llegan: hoy saltan de fila en vez de mover el cursor del texto', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="text"></td></tr>');
      tecla(tr.querySelector('input')!, 'Home');
      tecla(tr.querySelector('input')!, 'End');
      expect(vistos).toEqual([]);
    });

    it('↑↓ en una columna de CAPTURA no llegan: es la colisión con DESIGN D.5', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="number"></td></tr>');
      tecla(tr.querySelector('input')!, 'ArrowDown');
      expect(vistos).toEqual([]);
    });

    it('un textarea queda protegido igual', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><textarea></textarea></td></tr>');
      tecla(tr.querySelector('textarea')!, 'Space');
      expect(vistos).toEqual([]);
    });

    it('contenteditable también: no es un INPUT y mirar tagName no alcanzaba', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><div contenteditable="true"></div></td></tr>');
      const div = tr.querySelector('div') as HTMLElement;
      // jsdom no deriva isContentEditable del atributo; se fija a mano para probar la rama.
      Object.defineProperty(div, 'isContentEditable', { value: true });
      tecla(div, 'Space');
      expect(vistos).toEqual([]);
    });

    it('el combo de PrimeNG (role=combobox) se queda sus flechas', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><div role="combobox"></div></td></tr>');
      tecla(tr.querySelector('[role=combobox]')!, 'ArrowDown');
      expect(vistos).toEqual([]);
    });
  });

  describe('⛔ lo que NO se puede romper: la navegación tiene que seguir funcionando', () => {
    it('la tecla apretada EN LA FILA (sin campo) sí llega — es la navegación normal', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td>texto</td></tr>');
      tecla(tr, 'ArrowDown');
      expect(vistos).toEqual(['ArrowDown']);
    });

    it('un checkbox NO se protege: ahí Space debe marcar, y las flechas son de la fila', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="checkbox"></td></tr>');
      tecla(tr.querySelector('input')!, 'ArrowDown');
      expect(vistos).toEqual(['ArrowDown']);
    });

    it('un botón dentro de la fila tampoco: no captura texto', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><button>x</button></td></tr>');
      tecla(tr.querySelector('button')!, 'ArrowDown');
      expect(vistos).toEqual(['ArrowDown']);
    });

    it('una tecla que PrimeNG no toca pasa de largo aunque venga de un input', () => {
      const { tr, vistos } = montar('<tr data-p-selectable-row="true"><td><input type="text"></td></tr>');
      tecla(tr.querySelector('input')!, 'KeyA');
      expect(vistos).toEqual(['KeyA']);
    });

    it('un input FUERA de una fila navegable no se toca: el buscador de arriba sigue intacto', () => {
      document.body.innerHTML = '<input id="q" type="text">';
      const visto: string[] = [];
      document.body.addEventListener('keydown', (e) => visto.push((e as KeyboardEvent).key));
      tecla(document.getElementById('q')!, 'ArrowDown');
      expect(visto).toEqual(['ArrowDown']);
    });
  });
});

describe('bajarAlPrimerRenglon — el salto que existía en 1 de 153 pantallas', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('baja a la primera fila navegable', () => {
    document.body.innerHTML =
      '<input id="q"><table><tbody><tr data-p-selectable-row="true" tabindex="0"><td>a</td></tr></tbody></table>';
    expect(bajarAlPrimerRenglon(document)).toBe(true);
    expect(document.activeElement?.tagName).toBe('TR');
  });

  it('con la lista vacía devuelve false y NO mueve el foco: mandarlo a la nada deja sin salida', () => {
    document.body.innerHTML = '<input id="q"><table><tbody></tbody></table>';
    const q = document.getElementById('q') as HTMLElement;
    q.focus();
    expect(bajarAlPrimerRenglon(document)).toBe(false);
    expect(document.activeElement).toBe(q);
  });

  it('⚠️ con DOS tablas, el alcance decide: sin acotar baja a la del documento, no a la tuya', () => {
    document.body.innerHTML =
      '<table id="detalle"><tbody><tr data-p-selectable-row="true" tabindex="0" id="otra"><td>x</td></tr></tbody></table>' +
      '<div id="lista"><table><tbody><tr data-p-selectable-row="true" tabindex="0" id="mia"><td>y</td></tr></tbody></table></div>';
    bajarAlPrimerRenglon(document);
    expect(document.activeElement?.id).toBe('otra');       // sin acotar: la del documento
    bajarAlPrimerRenglon(document.getElementById('lista'));
    expect(document.activeElement?.id).toBe('mia');        // acotado: la que el buscador filtra
  });
});

describe('volverAlBuscador — la mitad que casi siempre falta', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('devuelve el foco y deja el texto seleccionado, para que teclear lo reemplace', () => {
    document.body.innerHTML = '<input id="q" value="chocolate">';
    const q = document.getElementById('q') as HTMLInputElement;
    expect(volverAlBuscador(q)).toBe(true);
    expect(document.activeElement).toBe(q);
    expect(q.selectionStart).toBe(0);
    expect(q.selectionEnd).toBe('chocolate'.length);
  });

  it('sin buscador devuelve false en vez de tirar', () => {
    expect(volverAlBuscador(null)).toBe(false);
  });
});
