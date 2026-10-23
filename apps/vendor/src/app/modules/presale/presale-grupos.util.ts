import type { LoadGuide, PresaleOrderRow } from '@megadulces/contracts';

/**
 * `[MCP.3.13]` Pedido agrupado en el celular de quien reparte: el pedido del vendedor que se surte en
 * varias sucursales de la zona llega como varios pedidos (uno por sucursal, «partes»). Quien reparte
 * pasa a recoger a cada sucursal, los carga juntos y entrega todo el cobro en la caja del pedido.
 */

/** Un pedido es de un grupo de verdad (con más de un pedido vivo). */
export const esDeGrupo = (p: { group_id?: string | null; group_parts?: number | null }): boolean =>
  !!p.group_id && (p.group_parts ?? 0) > 1;

/**
 * Ordena para que las partes de un mismo grupo queden juntas (el principal primero) y respeta el
 * orden del servidor para todo lo demás: el grupo entra donde aparece su primer pedido.
 */
export function juntarGrupos(pedidos: readonly PresaleOrderRow[]): PresaleOrderRow[] {
  const out: PresaleOrderRow[] = [];
  const vistos = new Set<string>();
  for (const p of pedidos) {
    if (!esDeGrupo(p)) { out.push(p); continue; }
    const g = p.group_id as string;
    if (vistos.has(g)) continue;
    vistos.add(g);
    const del = pedidos.filter((x) => x.group_id === g);
    out.push(...del.filter((x) => x.id === g), ...del.filter((x) => x.id !== g));
  }
  return out;
}

/** Los ids de pedidos disponibles que van juntos con éste (él incluido). */
export function companeros(p: PresaleOrderRow, disponibles: readonly PresaleOrderRow[]): string[] {
  if (!esDeGrupo(p)) return [p.id];
  return disponibles.filter((x) => x.group_id === p.group_id).map((x) => x.id);
}

/**
 * Aviso en la tarjeta de un pedido de un grupo:
 *  · la parte de otra sucursal → «Recolectar en 05: 3 productos»;
 *  · el de la sucursal del pedido → «Parte de este pedido sale de 05».
 */
export function avisoGrupo(p: PresaleOrderRow): string | null {
  if (!esDeGrupo(p)) return null;
  if (p.branch && p.group_main_branch && p.branch !== p.group_main_branch) {
    return 'Recolectar en ' + p.branch + ': ' + p.lines + (p.lines === 1 ? ' producto' : ' productos');
  }
  const otras = (p.group_branches ?? []).filter((b) => b !== p.branch);
  return otras.length ? 'Parte de este pedido sale de ' + otras.join(', ') : null;
}

/**
 * Lo que falta recoger en OTRA sucursal (no la del pedido), por sucursal: de sus guías abiertas o
 * impresas, las partes que siguen en camino. Para «Mis guías».
 */
export function recoleccion(guias: readonly LoadGuide[]): Array<{ branch: string; productos: number; pedidos: number; grupos: string[] }> {
  const por = new Map<string, { productos: number; pedidos: number; grupos: Set<string> }>();
  for (const g of guias) {
    if (g.status !== 'abierta' && g.status !== 'impresa') continue;
    for (const o of g.orders) {
      if (o.status !== 'cargado' || o.order_cancelled || !esDeGrupo(o) || !o.group_main_branch || o.group_main_branch === g.branch) continue;
      const acc = por.get(g.branch) ?? { productos: 0, pedidos: 0, grupos: new Set<string>() };
      acc.productos += Number(o.lines ?? 0);
      acc.pedidos += 1;
      if (o.group_code) acc.grupos.add(o.group_code);
      por.set(g.branch, acc);
    }
  }
  return [...por.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([branch, a]) => ({ branch, productos: a.productos, pedidos: a.pedidos, grupos: [...a.grupos].sort() }));
}
