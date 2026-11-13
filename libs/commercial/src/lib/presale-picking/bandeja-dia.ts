/**
 * `[MCP.24]` El día que pide una bandeja de preventa (surtidor o caja) con `?date=YYYY-MM-DD`.
 *
 * Sin `date`, la bandeja es la viva de siempre. Con `date`, trae ese día COMPLETO (también lo cerrado), para
 * que el surtidor y la caja revisen días anteriores sin mezclarlos con hoy (pedido de David, 2026-11-12).
 */

/** Un `?date=` mal escrito: la bandeja responde 400 en vez de abrir «hoy» en silencio. */
export class DiaInvalido extends Error {}

/** El día pedido (`YYYY-MM-DD`, fecha real del calendario); `null` = no pidió ninguno. */
export function diaDeConsulta(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new DiaInvalido('La fecha debe ser un día real con la forma AAAA-MM-DD.');
  }
  return s;
}
