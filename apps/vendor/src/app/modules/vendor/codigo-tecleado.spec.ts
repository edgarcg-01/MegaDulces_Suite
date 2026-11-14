import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodigoTecleado, ESPERA_CODIGO_TECLEADO_MS, pareceCodigoDeBarras } from './codigo-tecleado';

describe('pareceCodigoDeBarras [BU.4.1]', () => {
  it.each(['7501079221165', '75010792', '840004096513', '006001', ' 7501079221165 ', 'C14055', 'c00066'])('«%s» es código', (t) => {
    expect(pareceCodigoDeBarras(t)).toBe(true);
  });
  it.each(['', '14055', '00066', 'coca 600', 'gomitas', '7501 0792', 'C1405', '750107922116512345'])('«%s» NO es código', (t) => {
    expect(pareceCodigoDeBarras(t)).toBe(false);
  });
});

describe('CodigoTecleado [BU.4.1]', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('teclear un EAN dígito a dígito consulta UNA vez, al dejar de teclear, con el código completo', () => {
    const resolver = vi.fn();
    const c = new CodigoTecleado(resolver);
    let texto = '';
    for (const d of '7501079221165') {
      texto += d;
      c.alTeclear(texto);
      vi.advanceTimersByTime(80);
    }
    expect(resolver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ESPERA_CODIGO_TECLEADO_MS);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith('7501079221165');
  });

  it('Enter (la pistola) resuelve ya y no repite al vencer la espera', () => {
    const resolver = vi.fn();
    const c = new CodigoTecleado(resolver);
    c.alTeclear('7501079221165');
    expect(c.alConfirmar('7501079221165')).toBe(true);
    vi.advanceTimersByTime(ESPERA_CODIGO_TECLEADO_MS * 2);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('un nombre o una clave no se resuelven como código, y borrar el código cancela lo pendiente', () => {
    const resolver = vi.fn();
    const c = new CodigoTecleado(resolver);
    expect(c.alConfirmar('coca 600')).toBe(false);
    expect(c.alConfirmar('14055')).toBe(false);
    c.alTeclear('7501079221165');
    c.alTeclear('750107922116 coca');
    vi.advanceTimersByTime(ESPERA_CODIGO_TECLEADO_MS * 2);
    expect(resolver).not.toHaveBeenCalled();
  });
});
