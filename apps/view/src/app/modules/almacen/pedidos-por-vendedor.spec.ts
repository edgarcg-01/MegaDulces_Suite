import { SIN_VENDEDOR, agruparPorVendedor } from './pedidos-por-vendedor';

/** `[MCP.14]` Pedidos separados por vendedor, en orden de folio; los vendedores por el que llegó primero. */
const P = (code: string, seller_name: string | null, at: string) => ({ code, seller_name, at });
const llegada = (p: { at: string }) => p.at;

describe('agruparPorVendedor', () => {
  it('separa por vendedor y dentro de cada uno ordena por folio, aunque haya llegado en otro orden', () => {
    const g = agruparPorVendedor([
      P('PD-2026-00399', 'Vendedor B', '2026-11-09T17:51:00Z'),
      P('PD-2026-00377', 'Vendedor B', '2026-11-09T15:56:00Z'),
      P('PD-2026-00382', 'Vendedor B', '2026-11-09T16:32:00Z'),
      P('PD-2026-00376', 'Vendedor A', '2026-11-09T15:34:00Z'),
      P('PD-2026-00392', 'Vendedor A', '2026-11-09T17:00:00Z'),
    ], llegada);
    expect(g.map((x) => [x.vendedor, x.pedidos.map((p) => p.code.slice(-3))])).toEqual([
      ['Vendedor A', ['376', '392']],
      ['Vendedor B', ['377', '382', '399']],
    ]);
  });

  it('el primer grupo es el del pedido que llegó primero (se surte por orden de llegada)', () => {
    const g = agruparPorVendedor([P('PD-1', 'Zeta', '2026-11-09T10:00:00Z'), P('PD-2', 'Alfa', '2026-11-09T11:00:00Z')], llegada);
    expect(g.map((x) => x.vendedor)).toEqual(['Zeta', 'Alfa']);
  });

  it('NEGATIVO: sin vendedor no se esconde ni se mezcla: va al final con su rótulo', () => {
    const g = agruparPorVendedor([P('PD-1', null, '2026-11-09T09:00:00Z'), P('PD-2', '  ', '2026-11-09T09:30:00Z'), P('PD-3', 'Alfa', '2026-11-09T12:00:00Z')], llegada);
    expect(g.map((x) => [x.vendedor, x.pedidos.length])).toEqual([['Alfa', 1], [SIN_VENDEDOR, 2]]);
  });

  it('vacío da vacío', () => {
    expect(agruparPorVendedor([], llegada)).toEqual([]);
  });
});
