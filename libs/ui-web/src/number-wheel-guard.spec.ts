import { installNumberWheelGuard } from './number-wheel-guard';

/**
 * El caso 4 es la PRUEBA NEGATIVA y no es decorativa: sin ella, los casos 1-3 pasarían igual si
 * jsdom simplemente no moviera el foco nunca. Desinstalar la guarda y comprobar que el foco AHORA
 * sobrevive al wheel es lo que demuestra que el verde de arriba lo produce nuestro código.
 */
describe('installNumberWheelGuard', () => {
  let uninstall: () => void;

  const mk = (type: string): HTMLInputElement => {
    const el = document.createElement('input');
    el.type = type;
    document.body.appendChild(el);
    return el;
  };
  const wheel = (el: Element): void => {
    el.dispatchEvent(new Event('wheel', { bubbles: true }));
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    uninstall = installNumberWheelGuard(document);
  });
  afterEach(() => uninstall());

  it('1. suelta el foco de un input[type=number] enfocado (el incremento no llega a ocurrir)', () => {
    const num = mk('number');
    num.focus();
    expect(document.activeElement).toBe(num);

    wheel(num);

    expect(document.activeElement).not.toBe(num);
  });

  it('2. NO toca un input de texto enfocado (la guarda es sólo para number)', () => {
    const txt = mk('text');
    txt.focus();

    wheel(txt);

    expect(document.activeElement).toBe(txt);
  });

  it('3. NO roba el foco cuando la rueda pasa sobre un number que NO está enfocado', () => {
    const num = mk('number');
    const txt = mk('text');
    txt.focus();

    wheel(num);

    expect(document.activeElement).toBe(txt);
  });

  it('4. PRUEBA NEGATIVA: desinstalada, el foco sobrevive al wheel', () => {
    uninstall();
    uninstall = () => undefined;

    const num = mk('number');
    num.focus();

    wheel(num);

    expect(document.activeElement).toBe(num);
  });
});
