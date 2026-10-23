import { cajaDelGrupo, textoGrupo } from './pedido-agrupado.util';

/** `[MCP.3.13]` Lo que la mesa y la caja dicen de un pedido agrupado. */
describe('pedido agrupado en pantalla', () => {
  const parte = { code: 'PD-2', branch: '05', group_code: 'PD-1', group_main_branch: '01', group_parts: 2, group_branches: ['01', '05'] };
  const principal = { ...parte, code: 'PD-1', branch: '01' };

  it('la parte dice de qué pedido es y dónde se cobra', () => {
    expect(textoGrupo(parte)).toBe('Parte de PD-1 · se cobra en 05');
    expect(cajaDelGrupo(parte)).toBe('01');
  });
  it('el principal dice cuántos pedidos y en qué sucursales', () => {
    expect(textoGrupo(principal)).toBe('Pedido agrupado · 2 pedidos en 01, 05');
    expect(cajaDelGrupo(principal)).toBeNull();
  });
  it('negativa: un pedido suelto (o un grupo al que le cancelaron las partes) no dice nada', () => {
    expect(textoGrupo({ code: 'PD-9', branch: '01' })).toBeNull();
    expect(textoGrupo({ ...parte, group_parts: 1 })).toBeNull();
    expect(cajaDelGrupo({ code: 'PD-9', branch: '01', group_code: null })).toBeNull();
  });
});
