/**
 * `[BFU.7.1]` **La cuenta contable de Kepler de un movimiento del banco, y su categoría** (motor de categoría, E7).
 *
 * Un retiro del banco liquida documentos de Kepler: por el pareo de la conciliación (pago `X-D` → `kdxf` → lo que
 * aplica) o por el pago del Calendario (sus renglones → el documento `kdxe`). Si el documento es una entrada de compra
 * (tipo 20) la cuenta es 511; si es un gasto (tipo 10), sus renglones (`kdm6`) traen cuenta, importe y departamento.
 *
 * De esos renglones, la cuenta del movimiento es:
 *  1. la del renglón cuyo importe es EXACTAMENTE el del movimiento (un gasto con varias cuentas pagado por partes), o
 *  2. la de mayor importe (y se declara `mixta` si hubo más de una categoría).
 * La categoría sale del mapeo `finance.category_kepler_accounts` por el prefijo MÁS LARGO (`611-003` antes que `611`).
 *
 * Medido contra el árbitro (la categoría que Tesorería puso en el libro, ago–oct 2026): 93.6 % de 3,994; placebo
 * (documentos barajados) 36.4 %.
 */

export interface RenglonDeKepler {
  /** Cuenta de Kepler (`kdc126`): `611-006`, `511`… `null` si el documento no trae renglones. */
  cuenta: string | null;
  importe: number;
  /** Departamento del renglón (`kdm6.c16` → `kdc3`): sucursal y área. */
  departamento?: string | null;
}

export type MapaDeCuentas = ReadonlyArray<readonly [prefijo: string, categoria: string]>;

/** La categoría de una cuenta por el prefijo más largo del mapeo; `null` si ninguno la cubre. */
export function categoriaDeCuenta(cuenta: string | null | undefined, mapa: MapaDeCuentas): string | null {
  const c = String(cuenta ?? '').trim();
  if (!c) return null;
  let mejor: { largo: number; cat: string } | null = null;
  for (const [prefijo, cat] of mapa) {
    if ((c === prefijo || c.startsWith(`${prefijo}-`)) && (!mejor || prefijo.length > mejor.largo)) {
      mejor = { largo: prefijo.length, cat };
    }
  }
  return mejor?.cat ?? null;
}

export type CuentaDelMovimiento =
  | { categoria: string; cuenta: string; departamento: string | null; por: 'importe_exacto' | 'mayor_importe'; mixta: boolean }
  | { categoria: null; motivo: 'cuenta_sin_categoria'; cuenta: string; departamento: string | null }
  | { categoria: null; motivo: 'documento_sin_cuenta' };

const centavos = (v: number) => Math.round(Number(v || 0) * 100);

/** De los renglones de Kepler de un movimiento, su cuenta y su categoría. `null` si no hay renglones (no hay documento). */
export function cuentaDelMovimiento(renglones: readonly RenglonDeKepler[], importe: number, mapa: MapaDeCuentas): CuentaDelMovimiento | null {
  if (!renglones.length) return null;
  const conCuenta = renglones.filter((r) => r.cuenta && String(r.cuenta).trim());
  if (!conCuenta.length) return { categoria: null, motivo: 'documento_sin_cuenta' };
  const exacto = conCuenta.filter((r) => centavos(r.importe) === centavos(importe));
  // Por categoría (no por cuenta): dos subcuentas de la misma categoría no hacen «mixta».
  // El renglón más grande de cada categoría da su cuenta y su departamento; el importe es la suma.
  const porCategoria = new Map<string, { importe: number; mayor: number; cuenta: string; departamento: string | null }>();
  for (const r of conCuenta) {
    const k = categoriaDeCuenta(r.cuenta, mapa) ?? `?${String(r.cuenta).trim()}`;
    const a = porCategoria.get(k) ?? { importe: 0, mayor: -Infinity, cuenta: '', departamento: null };
    a.importe += Number(r.importe || 0);
    if (Number(r.importe || 0) > a.mayor) Object.assign(a, { mayor: Number(r.importe || 0), cuenta: String(r.cuenta).trim(), departamento: r.departamento ?? null });
    porCategoria.set(k, a);
  }
  const elegido = exacto.length === 1
    ? { cuenta: String(exacto[0].cuenta).trim(), departamento: exacto[0].departamento ?? null, por: 'importe_exacto' as const }
    : (() => {
      const [, top] = Array.from(porCategoria.entries()).sort((a, b) => b[1].importe - a[1].importe)[0];
      return { cuenta: top.cuenta, departamento: top.departamento, por: 'mayor_importe' as const };
    })();
  const categoria = categoriaDeCuenta(elegido.cuenta, mapa);
  if (!categoria) return { categoria: null, motivo: 'cuenta_sin_categoria', cuenta: elegido.cuenta, departamento: elegido.departamento };
  return { categoria, cuenta: elegido.cuenta, departamento: elegido.departamento, por: elegido.por, mixta: elegido.por === 'mayor_importe' && porCategoria.size > 1 };
}
