import {
  analizarStack, capturarStack, LIMITE_CAPTURA, MARCOS_RECURSION, VUELTAS_RECURSION,
} from './pedido-recursion';

/**
 * `[RA-PERF.6]` — el candado que al guard viejo le faltó.
 *
 * El guard de `money()` vivió 69 días en prod sin poder disparar, y lo que lo habría destapado el
 * primer día es exactamente el primer bloque de abajo: **forzar una recursión real y comprobar que
 * el instrumento la ve**. Es ADR-056 aplicado a un instrumento: un gate sin prueba negativa es una
 * intención.
 */
describe('[RA-PERF.6] capturarStack — la profundidad medida es la REAL', () => {
  /** Recursión de verdad: `n` marcos anidados, y en el fondo se mide. */
  function hondo(n: number, medir: () => string): string {
    return n > 0 ? hondo(n - 1, medir) : medir();
  }

  it('⛔ EL BUG: `new Error().stack` sin subir el límite ve 11 marcos donde hay 500', () => {
    const crudo = hondo(500, () => (new Error().stack || ''));
    expect(crudo.split('\n').length).toBeLessThan(20);
    // Y por eso `> 300` jamás era verdad: ésta es la línea que el guard viejo evaluaba.
    expect(crudo.split('\n').length > MARCOS_RECURSION).toBe(false);
  });

  it('subiendo el límite, 500 marcos reales se ven como cientos', () => {
    const { marcos } = analizarStack(hondo(500, capturarStack));
    expect(marcos).toBeGreaterThan(MARCOS_RECURSION);
  });

  it('deja `Error.stackTraceLimit` como estaba (no contamina al resto de la app)', () => {
    const antes = (Error as { stackTraceLimit?: number }).stackTraceLimit;
    capturarStack();
    expect((Error as { stackTraceLimit?: number }).stackTraceLimit).toBe(antes);
  });

  it('un stack somero NO se confunde con recursión (el falso positivo que importa)', () => {
    expect(analizarStack(capturarStack()).recursion).toBe(false);
  });

  it('el límite de captura alcanza para cruzar el umbral con margen', () => {
    expect(LIMITE_CAPTURA).toBeGreaterThan(MARCOS_RECURSION);
  });
});

describe('[RA-PERF.6] analizarStack — re-entrada: la señal sin umbral', () => {
  const marco = (nombre: string) => `    at ComprasPedidoRealComponent.${nombre} (main.js:1:1)`;
  const armar = (...nombres: string[]) => ['Error', ...nombres.map(marco)].join('\n');

  it('money una sola vez = composición normal, no recursión', () => {
    const d = analizarStack(armar('money', 'pedidoTipicoTxt', 'render'));
    expect(d.vueltas).toBe(1);
    expect(d.recursion).toBe(false);
  });

  it('money dos veces (pedidoTipicoTitle → pedidoTipicoTxt → money) todavía NO es recursión', () => {
    expect(analizarStack(armar('money', 'pedidoTipicoTxt', 'money', 'render')).recursion).toBe(false);
  });

  it(`money ${VUELTAS_RECURSION} veces SÍ es re-entrada, con stack corto y todo`, () => {
    const d = analizarStack(armar('money', 'x', 'money', 'y', 'money'));
    expect(d.vueltas).toBe(VUELTAS_RECURSION);
    expect(d.marcos).toBeLessThan(MARCOS_RECURSION);   // el umbral de marcos NO la habría visto
    expect(d.recursion).toBe(true);
  });

  it('`moneyCorto` no cuenta como vuelta de `money`', () => {
    expect(analizarStack(armar('moneyCorto', 'moneyCorto', 'moneyCorto')).vueltas).toBe(0);
  });

  it('un marcador sin punto delante (un nombre de archivo) no cuenta', () => {
    expect(analizarStack('Error\n    at money.spec.ts:3:1').vueltas).toBe(0);
  });

  it('la cima trae los primeros marcos para saber quién llama a quién', () => {
    expect(analizarStack(armar('money', 'detailRows', 'render')).cima).toContain('detailRows');
  });

  it('un stack vacío no revienta ni declara recursión', () => {
    expect(analizarStack('').recursion).toBe(false);
  });
});
