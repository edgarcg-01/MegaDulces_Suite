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

/**
 * Unidades CERRADAS: cada una es un bulto `CJ` con su etiqueta "n/N" (`FASE_GP` §2.5: cajas, bultos o
 * cubetas). Medido en prod (sucursal 01): Kepler usa exactamente `CJA`, `BTO` y `CUB`. Todo lo
 * demás (PAQ, PZA, KG, 500, 250…) es paquetería y va a la caja P. Se decide por el NOMBRE y no por
 * "el factor más grande": un producto sin caja tendría su paquete como "mayor", y uno que se vende
 * por caja (base = CJA, factor 1) se metería a la caja P.
 */
export const UNIDADES_CERRADAS: ReadonlySet<string> = new Set(['CJA', 'BTO', 'CUB']);

export function esCerrada(unidad: string | null | undefined): boolean {
  return UNIDADES_CERRADAS.has(String(unidad ?? '').trim().toUpperCase());
}

/** La unidad cerrada del producto (la de mayor factor entre CJA/BTO/CUB). null = sólo paquetería. */
export function unidadMayor(f: KdiiFila): { unidad: string | null; factor: number } | null {
  const opciones = [
    { unidad: f.u3, factor: Number(f.f3 ?? 0) },
    { unidad: f.u2, factor: Number(f.f2 ?? 0) },
    { unidad: f.u1, factor: 1 },
  ].filter((o) => o.factor > 0 && esCerrada(o.unidad));
  if (!opciones.length) return null;
  return opciones.sort((x, y) => y.factor - x.factor)[0];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[NP.7.L.9a]` El levantamiento: qué PELDAÑO tiene la persona en la mano.
//
// A diferencia del checado, aquí el factor no decide si el código «existe»: un código que está en la
// casilla de la Unidad Dos con `c81` en 0/1 («Kepler no lo capturó», ERP_KEPLER §2.1.1) sigue siendo
// de ese producto y de ese peldaño. Si se exigiera el factor, saldría «no existe» y se abriría un alta
// duplicada (§10b.7 punto 3 del plan). El factor se reporta aparte, `null` si no está capturado.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type Peldano = 'base' | 'dos' | 'tres';

/** El peldaño del código dentro de UN producto (Base > Dos > Tres, `C`+clave = Tres), sin mirar factores. */
export function peldanoDelCodigo(f: KdiiFila, codigo: string): Peldano | null {
  const c = limpio(codigo);
  if (!c) return null;
  const en = (xs: Array<string | null>): boolean => xs.some((x) => limpio(x) === c);
  if (en(f.base)) return 'base';
  if (en(f.dos)) return 'dos';
  if (en(f.tres) || c === `C${limpio(f.sku)}`) return 'tres';
  return null;
}

export interface EscaneoResuelto {
  sku: string;
  nombre: string | null;
  peldano: Peldano;
  /** Rótulo de Kepler tal cual (`PAQ`, `CJA`…): informativo, NO dice el nivel físico. */
  unidad: string | null;
  /** Unidades base que trae ese peldaño; `null` si Kepler no lo tiene capturado (0 o vacío). */
  factor: number | null;
}

export type ResultadoEscaneo =
  | { tipo: 'ok'; resuelto: EscaneoResuelto }
  | { tipo: 'desconocido' }
  | { tipo: 'ambiguo'; candidatos: string[] };

/**
 * Resuelve un escaneo del levantamiento. Sin pedido que desempate: si dos productos comparten el
 * código, es ambiguo y NO se captura (va a Incidencias, §10b.3 punto 1).
 */
export function resolverEscaneo(codigo: string, filas: KdiiFila[]): ResultadoEscaneo {
  const hallados = new Map<string, EscaneoResuelto>();
  for (const f of filas) {
    const p = peldanoDelCodigo(f, codigo);
    if (!p || hallados.has(f.sku)) continue;
    const crudo = p === 'base' ? 1 : p === 'dos' ? f.f2 : f.f3;
    const factor = crudo != null && Number(crudo) > 0 ? Number(crudo) : null;
    const unidad = p === 'base' ? f.u1 : p === 'dos' ? f.u2 : f.u3;
    hallados.set(f.sku, { sku: f.sku, nombre: f.nombre, peldano: p, unidad, factor });
  }
  if (!hallados.size) return { tipo: 'desconocido' };
  const todos = [...hallados.values()];
  if (todos.length === 1) return { tipo: 'ok', resuelto: todos[0] };
  return { tipo: 'ambiguo', candidatos: todos.map((r) => r.sku).sort() };
}
