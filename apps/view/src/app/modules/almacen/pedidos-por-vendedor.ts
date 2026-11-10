/**
 * `[MCP.14]` Los pedidos de preventa **separados por vendedor y en orden de folio**, para Surtir y para la
 * Revisión en caja. Pedido de la operación de rutas vecinales (2026-11-09): «separar los pedidos a revisar
 * por vendedor» y «mostrar un orden de folios capturados por vendedor». Antes era una sola lista por hora de
 * llegada que intercalaba a todos los vendedores.
 *
 * · Dentro de cada vendedor, por folio ascendente: el orden en que los capturó (el folio es un contador
 *   único de toda la empresa, así que entre dos folios de un vendedor caben los de otros).
 * · Los vendedores, por el que llegó primero (se conserva «se surte por orden de llegada», D5 de la fase
 *   MCP): el primer grupo es el que tiene el pedido más viejo. Empate: por nombre.
 * · Sin vendedor va al final, con ese rótulo (no se esconde).
 * Puro: se prueba solo (pedidos-por-vendedor.spec.ts).
 */
export interface GrupoVendedor<T> {
  vendedor: string;
  pedidos: T[];
}

export const SIN_VENDEDOR = 'Sin vendedor';

export function agruparPorVendedor<T extends { seller_name: string | null; code: string }>(
  filas: readonly T[],
  llegada: (f: T) => string | null | undefined,
): GrupoVendedor<T>[] {
  const grupos = new Map<string, T[]>();
  for (const f of filas) {
    const v = (f.seller_name ?? '').trim() || SIN_VENDEDOR;
    const g = grupos.get(v);
    if (g) g.push(f);
    else grupos.set(v, [f]);
  }
  const primera = (xs: T[]): string => xs.map((x) => llegada(x) ?? '').filter(Boolean).sort()[0] ?? '￿';
  return [...grupos.entries()]
    .map(([vendedor, pedidos]) => ({ vendedor, pedidos: [...pedidos].sort((a, b) => a.code.localeCompare(b.code)), primera: primera(pedidos) }))
    .sort((a, b) => {
      if ((a.vendedor === SIN_VENDEDOR) !== (b.vendedor === SIN_VENDEDOR)) return a.vendedor === SIN_VENDEDOR ? 1 : -1;
      return a.primera === b.primera ? a.vendedor.localeCompare(b.vendedor, 'es') : a.primera < b.primera ? -1 : 1;
    })
    .map(({ vendedor, pedidos }) => ({ vendedor, pedidos }));
}
