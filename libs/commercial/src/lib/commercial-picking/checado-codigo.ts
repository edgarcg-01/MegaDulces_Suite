/**
 * `[GP.4]` De un código escaneado a producto + unidad + factor, con el catálogo de Kepler de la
 * sucursal (`kepler_ods.kdii`). Puro: lo usa el checado y se prueba sin base.
 *
 * Decode verificado (`ERP_KEPLER.md` §3.y.4, capturas de `78158` y `06001`):
 *
 * | Unidad | Nombre · factor | Casillas de código |
 * |---|---|---|
 * | Base | `c11` · 1 | `c7`, `c93`, `c102` |
 * | Dos | `c80` · `c81` | `c82`, `c95`, `c96` |
 * | Tres | `c83` · `c84` | `c85` (y el `C`+clave impreso al reetiquetar) |
 *
 * ⚠️ Sólo coincidencia EXACTA: en `06001` la casilla base trae `006001` y la del paquete `06001`.
 * Quitar ceros a la izquierda confundiría la pieza con el paquete.
 */

export interface KdiiFila {
  sku: string;
  nombre: string | null;
  u1: string | null;
  u2: string | null;
  f2: number | null;
  u3: string | null;
  f3: number | null;
  base: Array<string | null>;
  dos: Array<string | null>;
  tres: Array<string | null>;
}

export interface CodigoResuelto {
  sku: string;
  nombre: string | null;
  unidad: string | null;
  /** Cuántas unidades base trae lo escaneado. */
  factor: number;
}

export type ResultadoCodigo =
  | { tipo: 'ok'; resuelto: CodigoResuelto }
  | { tipo: 'desconocido' }
  | { tipo: 'ambiguo'; candidatos: string[] };

const limpio = (v: string | null | undefined): string => String(v ?? '').trim().toUpperCase();

/** La unidad del código dentro de UN producto, o null si el código no es de él. */
export function unidadDelCodigo(f: KdiiFila, codigo: string): CodigoResuelto | null {
  const c = limpio(codigo);
  if (!c) return null;
  const en = (xs: Array<string | null>): boolean => xs.some((x) => limpio(x) === c);
  if (en(f.base)) return { sku: f.sku, nombre: f.nombre, unidad: f.u1, factor: 1 };
  if (en(f.dos) && (f.f2 ?? 0) > 0) return { sku: f.sku, nombre: f.nombre, unidad: f.u2, factor: Number(f.f2) };
  const etiquetaCaja = `C${limpio(f.sku)}`;
  if ((en(f.tres) || c === etiquetaCaja) && (f.f3 ?? 0) > 0) return { sku: f.sku, nombre: f.nombre, unidad: f.u3, factor: Number(f.f3) };
  return null;
}

/**
 * Resuelve un código contra las filas candidatas de la sucursal. Si varios productos lo comparten,
 * gana el que va en el pedido; si aun así hay más de uno, es ambiguo (no se adivina).
 */
export function resolverCodigo(codigo: string, filas: KdiiFila[], skusDelPedido: Set<string>): ResultadoCodigo {
  const hallados = new Map<string, CodigoResuelto>();
  for (const f of filas) {
    const r = unidadDelCodigo(f, codigo);
    if (r && !hallados.has(r.sku)) hallados.set(r.sku, r);
  }
  if (!hallados.size) return { tipo: 'desconocido' };
  const todos = [...hallados.values()];
  if (todos.length === 1) return { tipo: 'ok', resuelto: todos[0] };
  const delPedido = todos.filter((r) => skusDelPedido.has(r.sku));
  if (delPedido.length === 1) return { tipo: 'ok', resuelto: delPedido[0] };
  return { tipo: 'ambiguo', candidatos: (delPedido.length ? delPedido : todos).map((r) => r.sku) };
}

/** La unidad MAYOR del producto (la caja): la de mayor factor > 1. null = sólo se vende suelto. */
export function unidadMayor(f: KdiiFila): { unidad: string | null; factor: number } | null {
  const opciones = [
    { unidad: f.u3, factor: Number(f.f3 ?? 0) },
    { unidad: f.u2, factor: Number(f.f2 ?? 0) },
  ].filter((o) => o.factor > 1);
  if (!opciones.length) return null;
  return opciones.sort((a, b) => b.factor - a.factor)[0];
}
