/**
 * `[MCP.3.13]` Cómo se dice en pantalla que un pedido es parte de un pedido agrupado (el pedido del
 * vendedor que se surte en varias sucursales de la zona). Cada parte se cobra en el Kepler de SU
 * sucursal y todo el cobro se entrega en la caja de la sucursal del pedido principal.
 */
export interface FilaAgrupable {
  code: string;
  branch: string | null;
  group_code?: string | null;
  group_main_branch?: string | null;
  group_parts?: number | null;
  group_branches?: string[] | null;
}

/** Una línea corta para la lista; `null` = pedido suelto (o grupo de uno solo). */
export function textoGrupo(r: FilaAgrupable): string | null {
  if (!r.group_code || (r.group_parts ?? 0) < 2) return null;
  if (r.group_code !== r.code) return 'Parte de ' + r.group_code + ' · se cobra en ' + (r.branch || '—');
  const suc = (r.group_branches ?? []).join(', ');
  return 'Pedido agrupado · ' + r.group_parts + ' pedidos' + (suc ? ' en ' + suc : '');
}

/** Dónde se entrega el dinero de este pedido, si es de un grupo y no es la caja de su sucursal. */
export function cajaDelGrupo(r: FilaAgrupable): string | null {
  if (!r.group_code || (r.group_parts ?? 0) < 2 || !r.group_main_branch) return null;
  return r.group_main_branch !== r.branch ? r.group_main_branch : null;
}
