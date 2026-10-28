import type { LoadGuide, LoadGuideOrderRow, PresaleOrderRow } from '@megadulces/contracts';
import { avisoGrupo, companeros, juntarGrupos, recoleccion } from './presale-grupos.util';

/** `[MCP.3.13]` El celular de quien reparte con pedidos agrupados (uno por sucursal, «partes»). */
const pedido = (id: string, extra: Partial<PresaleOrderRow> = {}): PresaleOrderRow =>
  ({ id, code: 'PD-' + id, branch: '01', lines: 2, group_id: null, group_parts: null, ...extra }) as PresaleOrderRow;

const grupo = { group_id: 'm', group_code: 'PD-m', group_main_branch: '01', group_parts: 2, group_branches: ['01', '05'] };

describe('presale-grupos', () => {
  const principal = pedido('m', { ...grupo });
  const parte = pedido('p', { ...grupo, branch: '05', lines: 3 });

  it('las partes de un grupo quedan juntas, el principal primero, en el lugar del primero que aparece', () => {
    const r = juntarGrupos([pedido('a'), parte, pedido('b'), principal]);
    expect(r.map((x) => x.id)).toEqual(['a', 'm', 'p', 'b']);
  });

  it('elegir una parte mueve a las demás disponibles del grupo; un pedido suelto va solo', () => {
    expect(companeros(parte, [pedido('a'), principal, parte])).toEqual(['m', 'p']);
    expect(companeros(pedido('a'), [pedido('a'), principal])).toEqual(['a']);
  });

  it('aviso: la parte dice dónde recolectar y cuántos productos; el principal, de dónde sale lo demás', () => {
    expect(avisoGrupo(parte)).toBe('Recolectar en 05: 3 productos');
    expect(avisoGrupo(principal)).toBe('Parte de este pedido sale de 05');
    expect(avisoGrupo(pedido('a'))).toBeNull();
    // negativa: un "grupo" de uno solo (le cancelaron las partes) no avisa nada
    expect(avisoGrupo(pedido('m', { ...grupo, group_parts: 1 }))).toBeNull();
  });

  it('«Mis guías»: lo que falta recoger por sucursal, sin contar la del pedido ni lo ya entregado', () => {
    const renglon = (order_id: string, extra: Partial<LoadGuideOrderRow>): LoadGuideOrderRow =>
      ({ order_id, code: 'PD-' + order_id, status: 'cargado', order_cancelled: false, ...grupo, lines: 3, ...extra }) as LoadGuideOrderRow;
    const guia = (branch: string, status: LoadGuide['status'], orders: LoadGuideOrderRow[]): LoadGuide =>
      ({ id: branch + status, folio: 'G' + branch, status, branch, orders }) as LoadGuide;
    const r = recoleccion([
      guia('01', 'abierta', [renglon('m', { lines: 4 })]),
      guia('05', 'impresa', [renglon('p', {}), renglon('q', { status: 'entregado' }), renglon('x', { group_id: null })]),
      guia('06', 'liquidada', [renglon('z', {})]),
    ]);
    expect(r).toEqual([{ branch: '05', productos: 3, pedidos: 1, grupos: ['PD-m'] }]);
  });
});
