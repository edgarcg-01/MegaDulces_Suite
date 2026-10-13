// Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el archivo
// NO CARGUE y reporte 0 tests en vez de fallar — el total de la suite sigue creciendo y nadie se
// entera de que no corren. (Lección de `[CG.38.1]`, misma trampa que en row-nav.spec.)
import { installToolbarNav } from './toolbar-nav';

/**
 * Las pruebas están escritas contra el DEFECTO que el archivo existe para evitar, no contra su
 * implementación. El montaje imita lo que PrimeNG pinta: `<button>` reales dentro del contenedor.
 */
function montar(n = 3): { barra: HTMLElement; botones: HTMLElement[]; activados: string[]; limpiar: () => void } {
  const chips = Array.from({ length: n }, (_, i) => `<button id="b${i}">chip ${i}</button>`).join('');
  document.body.innerHTML = `<div role="toolbar" aria-label="atajos">${chips}</div>`;
  const barra = document.querySelector('[role="toolbar"]') as HTMLElement;
  const botones = Array.from(document.querySelectorAll('button')) as HTMLElement[];
  const activados: string[] = [];
  for (const b of botones) b.addEventListener('click', () => activados.push(b.id));
  const limpiar = installToolbarNav(document);
  return { barra, botones, activados, limpiar };
}

function flecha(el: HTMLElement, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('installToolbarNav', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('deja UNA sola parada de tabulador en la barra (roving tabindex)', () => {
    const { botones, limpiar } = montar(4);
    expect(botones.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(botones[0].tabIndex).toBe(0);
    expect(botones.slice(1).every((b) => b.tabIndex === -1)).toBe(true);
    limpiar();
  });

  it('la flecha mueve el foco a la acción siguiente', () => {
    const { botones, limpiar } = montar();
    botones[0].focus();
    flecha(botones[0], 'ArrowRight');
    expect(document.activeElement).toBe(botones[1]);
    expect(botones[1].tabIndex).toBe(0);
    expect(botones[0].tabIndex).toBe(-1);
    limpiar();
  });

  /**
   * ⛔ LA PRUEBA QUE JUSTIFICA EL ARCHIVO. Su hermano `installRadioGroupNav` termina en
   * `.click()` porque en un radiogroup la selección sigue al foco. Acá eso llenaría la captura
   * en cada flecha: recorrer diez chips dejaría el formulario con los datos del décimo sin que
   * nadie lo haya elegido. Si alguien «unifica» los dos archivos, esto se pone rojo.
   */
  it('mover NO activa: la flecha nunca dispara la acción', () => {
    const { botones, activados, limpiar } = montar(3);
    botones[0].focus();
    flecha(botones[0], 'ArrowRight');
    flecha(botones[1], 'ArrowRight');
    flecha(botones[2], 'ArrowLeft');
    expect(activados).toEqual([]);
    limpiar();
  });

  it('Home y End van a los extremos, y en el extremo no da la vuelta', () => {
    const { botones, limpiar } = montar(4);
    botones[0].focus();
    flecha(botones[0], 'End');
    expect(document.activeElement).toBe(botones[3]);
    flecha(botones[3], 'ArrowRight');           // ya está en el último
    expect(document.activeElement).toBe(botones[3]);
    flecha(botones[3], 'Home');
    expect(document.activeElement).toBe(botones[0]);
    flecha(botones[0], 'ArrowLeft');            // ya está en el primero
    expect(document.activeElement).toBe(botones[0]);
    limpiar();
  });

  it('salta las acciones deshabilitadas', () => {
    document.body.innerHTML =
      '<div role="toolbar"><button id="a">a</button><button id="b" disabled>b</button><button id="c">c</button></div>';
    const limpiar = installToolbarNav(document);
    const a = document.getElementById('a') as HTMLElement;
    const c = document.getElementById('c') as HTMLElement;
    a.focus();
    flecha(a, 'ArrowRight');
    expect(document.activeElement).toBe(c);
    limpiar();
  });

  it('no toca una barra que se administra sola (data-nav=manual)', () => {
    document.body.innerHTML =
      '<div role="toolbar" data-nav="manual"><button id="a">a</button><button id="b">b</button></div>';
    const limpiar = installToolbarNav(document);
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    expect(a.tabIndex).toBe(0);
    expect(b.tabIndex).toBe(0);                 // no se le puso roving
    a.focus();
    flecha(a, 'ArrowRight');
    expect(document.activeElement).toBe(a);     // tampoco se mueve
    limpiar();
  });

  it('no se mete con las flechas fuera de una toolbar', () => {
    document.body.innerHTML = '<input id="x" /><div role="toolbar"><button id="a">a</button></div>';
    const limpiar = installToolbarNav(document);
    const x = document.getElementById('x') as HTMLInputElement;
    x.focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    x.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);    // el cursor del campo sigue siendo del campo
    expect(document.activeElement).toBe(x);
    limpiar();
  });
});
