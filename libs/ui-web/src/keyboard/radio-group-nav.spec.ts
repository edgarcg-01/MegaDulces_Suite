// Sin `import ... from 'vitest'`: la config usa `globals: true` (misma trampa que row-nav.spec).
import { installRadioGroupNav } from './radio-group-nav';

/**
 * `[GP.RF.38]` El teclado de los `role="radio"` sin teclado propio. Este archivo no tenía pruebas, y
 * Surtir lo midió en el navegador (2026-11-18): **la flecha no elegía nada**. La causa: el listener
 * escribía `tabIndex` (que pone el ATRIBUTO `tabindex`) y su propio criterio de «este grupo se
 * administra solo» —que alguna opción traiga `tabindex`— lo tomaba desde ese momento como ajeno.
 * O sea que a todo grupo que el listener tocaba, el listener lo dejaba de atender.
 *
 * El montaje imita al componente: el clic marca la opción (`aria-checked`), como en Surtir.
 */
function montar(n = 3, propio = false): { grupo: HTMLElement; ops: HTMLElement[]; clics: string[]; limpiar: () => void } {
  const ops = Array.from({ length: n }, (_, i) =>
    `<button id="r${i}" role="radio" aria-checked="${i === 0}"${propio ? ` tabindex="${i === 0 ? 0 : -1}"` : ''}>op ${i}</button>`).join('');
  document.body.innerHTML = `<div role="radiogroup" aria-label="Pedidos de">${ops}</div>`;
  const grupo = document.querySelector('[role="radiogroup"]') as HTMLElement;
  const botones = Array.from(document.querySelectorAll('[role="radio"]')) as HTMLElement[];
  const clics: string[] = [];
  for (const b of botones) {
    b.addEventListener('click', () => {
      clics.push(b.id);
      for (const o of botones) o.setAttribute('aria-checked', String(o === b));
    });
  }
  const limpiar = installRadioGroupNav(document);
  return { grupo, ops: botones, clics, limpiar };
}

const flecha = (el: HTMLElement, key: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); };
const tic = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('installRadioGroupNav', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('deja UNA parada de tabulador: la opción elegida', () => {
    const { ops, limpiar } = montar(3);
    expect(ops.map((o) => o.tabIndex)).toEqual([0, -1, -1]);
    limpiar();
  });

  /** ⛔ LA PRUEBA DEL DEFECTO: con el código anterior la flecha no hacía nada (ni foco ni elección). */
  it('la flecha mueve el foco Y elige (en un radiogroup la selección sigue al foco)', () => {
    const { ops, clics, limpiar } = montar(3);
    ops[0].focus();
    flecha(ops[0], 'ArrowRight');
    expect(document.activeElement).toBe(ops[1]);
    expect(clics).toEqual(['r1']);
    expect(ops[1].getAttribute('aria-checked')).toBe('true');
    flecha(ops[1], 'End');
    expect(document.activeElement).toBe(ops[2]);
    expect(clics).toEqual(['r1', 'r2']);
    limpiar();
  });

  it('en los extremos no da la vuelta', () => {
    const { ops, clics, limpiar } = montar(2);
    ops[0].focus();
    flecha(ops[0], 'ArrowLeft');
    expect(document.activeElement).toBe(ops[0]);
    expect(clics).toEqual([]);
    limpiar();
  });

  /** ⛔ Segundo defecto: tras elegir con el dedo o el mouse, el Tab seguía entrando por la opción vieja. */
  it('tras un clic, la parada de tabulador pasa a la elegida', async () => {
    const { ops, limpiar } = montar(3);
    ops[2].click();
    await tic();
    expect(ops.map((o) => o.tabIndex)).toEqual([-1, -1, 0]);
    limpiar();
  });

  it('un grupo que aparece después también queda con una parada y con flechas', async () => {
    const { limpiar } = montar(1);
    const nuevo = document.createElement('div');
    nuevo.setAttribute('role', 'radiogroup');
    nuevo.innerHTML = '<button role="radio" aria-checked="false">a</button><button role="radio" aria-checked="true">b</button>';
    document.body.appendChild(nuevo);
    await tic();
    const [a, b] = Array.from(nuevo.querySelectorAll('button')) as HTMLElement[];
    expect([a.tabIndex, b.tabIndex]).toEqual([-1, 0]);
    b.focus();
    flecha(b, 'ArrowLeft');
    expect(document.activeElement).toBe(a);
    limpiar();
  });

  /** NEGATIVA: el grupo que trae su propio `tabindex` (app-segmented) se deja en paz: ni foco ni clic. */
  it('NEGATIVA: un grupo que se administra solo no se toca', () => {
    const { ops, clics, limpiar } = montar(3, true);
    ops[0].focus();
    flecha(ops[0], 'ArrowRight');
    expect(document.activeElement).toBe(ops[0]);
    expect(clics).toEqual([]);
    expect(ops.map((o) => o.tabIndex)).toEqual([0, -1, -1]);
    limpiar();
  });
});
