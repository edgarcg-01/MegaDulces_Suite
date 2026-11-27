/**
 * `[PQ.160]` — **Editar las cantidades de una orden de compra (`X-A-35`) en Kepler, con las fórmulas de Kepler.**
 *
 * Sin base de datos a propósito (como `kepler-oc-cancelacion.ts`): la REGLA (¿se puede?), el CÁLCULO (¿cómo queda?)
 * y las SENTENCIAS (¿qué se escribe?) se prueban solas en `kepler-oc-edicion.spec.ts`; el adaptador sólo lee,
 * decide con esto y ejecuta.
 *
 * ── Lo que depende de la cantidad, medido ──────────────────────────────────────────────────────────────────
 * Son las columnas que la Suite ya escribe al crear la OC (`kepler-requisition-sink.adapter.ts`, `[KR.17]`
 * `[PQ.21]` `[PQ.22]`), con su invariante medida en los renglones de Kepler:
 *   renglón `kdm2`: `c9` cantidad en unidad base = `c56 × c58` · `c13` importe = round(`c9 × c12`, 2) ·
 *                   `c24` pendiente = `c9` (nada recibido) · `c31` = `c9` en las OC que salen de requisición ·
 *                   `c56` cantidad en la presentación (`c55`) · `c51` pedida = `c56` donde se escribe.
 *   encabezado `kdm1`: `c14` IVA = Σ round(`c13 × c17 / 100`, 2) · `c15` IEPS = Σ round(`c13 × c18 / 100`, 2) ·
 *                      `c16` total = Σ`c13` + IVA + IEPS · `c42` saldo = `c16` (abierta, sin pagos).
 * El 2026-11-26, sobre las OC abiertas sin vale de 90 días: las escritas por la Suite cumplen las fórmulas en
 * 160 de 161; las capturadas en Kepler, en 25 de 40 (el resto trae descuento u otra cuenta). Por eso la regla
 * COMPRUEBA las fórmulas en el documento ANTES de editarlo: si Kepler no las cumple ahí, no se adivina —se
 * dice que se edite en Kepler—.
 *
 * ── Lo que esto se niega a hacer (fail-closed) ─────────────────────────────────────────────────────────────
 *  · OC que no está en `N`, o con un vale vivo, o con algo recibido (`c24 ≠ c9`), o con saldo ≠ total.
 *  · Agregar o quitar renglones, o cambiar costos: no se midió qué hace Kepler; se hace allá.
 *  · Cantidad 0 o negativa (quitar un renglón): igual.
 * ⚠️ La requisición de la que salió NO se toca: queda con su cantidad original. Kepler tampoco la cambia al
 *    editar la OC en su pantalla (no se observó lo contrario); el motivo de la diferencia queda en la Suite.
 */

import { OC_EDITAR_MOTIVO_MIN } from '@megadulces/contracts';

import { llave, TABLAS_KEPLER, type Sentencia, type Tablas } from './kepler-oc-cancelacion';
import { textoKepler } from './kepler-texto';

/** Un renglón de la OC, ya plano y numérico, como lo lee el adaptador. */
export interface RenglonOcKepler {
  renglon: number;
  sku: string;
  nombre: string;
  /** `c55` (o `c11`). */
  unidad: string;
  /** `c9`: unidad base. */
  cantidad_base: number;
  /** `c12`: costo de la unidad base. */
  costo_base: number;
  /** `c13`. */
  importe: number;
  /** `c17` y `c18`, en %. */
  iva: number;
  ieps: number;
  /** `c24`: pendiente por recibir. */
  pendiente: number;
  /** `c31` (null si viene vacío). */
  c31: number | null;
  /** `c51` y `c56`, tal como los guarda Kepler (TEXTO). */
  c51: string;
  c56: string;
  /** `c58`: piezas por presentación. */
  factor: number;
}

export interface OcParaEditar {
  serie: string;
  folio: string;
  /** `c43`. */
  estado: string;
  /** `c13` (descuento del encabezado), `c14`, `c15`, `c16`, `c42`. */
  descuento: number;
  iva: number;
  ieps: number;
  total: number;
  saldo: number;
  renglones: RenglonOcKepler[];
}

export interface EntradaEdicion {
  oc: OcParaEditar | null;
  /** Coincidencias por sucursal + folio (más de una = serie ambigua). */
  coincidencias: number;
  /** Vales (`X-A-37`) vivos que apuntan a la OC. */
  vales_vivos: string[];
}

export interface CambioPedido { renglon: number; cantidad: number }

/** El renglón como queda: lo que se escribe, y lo que estaba para el `WHERE` y para la Suite. */
export interface RenglonEditado {
  renglon: number;
  sku: string;
  unidad: string;
  /** En la presentación. */
  antes: number;
  despues: number;
  /** `c9` antes y después. */
  base_antes: number;
  base_despues: number;
  importe_antes: number;
  importe_despues: number;
  /** ¿Se actualizan `c31` y `c51`? Sólo si seguían la regla (`c31 = c9`, `c51 = c56`). */
  con_c31: boolean;
  con_c51: boolean;
  c56_antes: string;
  c56_despues: string;
}

export interface PlanEdicion {
  sucursal: string;
  serie: string;
  folio: string;
  renglones: RenglonEditado[];
  /** Encabezado antes (para el `WHERE`) y después. */
  total_antes: number;
  saldo_antes: number;
  iva: number;
  ieps: number;
  total: number;
}

export type DecisionEdicion = { ok: true; plan: PlanEdicion } | { ok: false; motivo: string };

const r2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100;
/** Cantidad comparable (Kepler guarda `double precision`): 4 decimales bastan para «es igual». */
const q4 = (v: number): number => Math.round((Number(v) || 0) * 10000) / 10000;
const ESTADO_OC: Record<string, string> = { N: 'pendiente', R: 'con recepción parcial', F: 'surtida', C: 'cancelada' };

export function motivoEdicionValido(motivo: string | null | undefined): { ok: true; valor: string } | { ok: false; motivo: string } {
  const v = (motivo ?? '').replace(/\s+/g, ' ').trim();
  if (v.length < OC_EDITAR_MOTIVO_MIN) {
    return { ok: false, motivo: `Escribe por qué cambian las cantidades (al menos ${OC_EDITAR_MOTIVO_MIN} letras): queda en la Suite junto a la OC` };
  }
  return { ok: true, valor: v.slice(0, 500) };
}

/** La cantidad en la presentación que Kepler guarda en `c56`, como número (o `null` si no se puede leer). */
export const presentacion = (r: Pick<RenglonOcKepler, 'c56'>): number | null => {
  const n = Number(String(r.c56 ?? '').trim());
  return String(r.c56 ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

/** Impuestos y total de un conjunto de renglones, con la fórmula de Kepler. */
export function totalesKepler(rs: Array<Pick<RenglonOcKepler, 'importe' | 'iva' | 'ieps'>>): { subtotal: number; iva: number; ieps: number; total: number } {
  let subtotal = 0, iva = 0, ieps = 0;
  for (const r of rs) {
    subtotal += r.importe;
    iva += r2(r.importe * r.iva / 100);
    ieps += r2(r.importe * r.ieps / 100);
  }
  return { subtotal: r2(subtotal), iva: r2(iva), ieps: r2(ieps), total: r2(subtotal + iva + ieps) };
}

/**
 * ¿Se puede editar ESTA OC? (sin cambios todavía). La misma revisión para ofrecer el botón y para escribir:
 * el estado, los vales, lo recibido, y que el documento cumpla las fórmulas que se van a usar.
 */
export function revisarOcEditable(e: EntradaEdicion): { ok: true; oc: OcParaEditar } | { ok: false; motivo: string } {
  if (e.coincidencias === 0 || !e.oc) return { ok: false, motivo: 'Kepler no tiene esa orden de compra en esa sucursal' };
  if (e.coincidencias > 1) return { ok: false, motivo: `Kepler tiene ${e.coincidencias} órdenes con ese folio en la sucursal: no se sabe cuál editar` };
  const oc = e.oc;
  if (oc.estado !== 'N') {
    return { ok: false, motivo: `La OC está ${ESTADO_OC[oc.estado] ?? `en estado ${oc.estado}`}: sólo se editan las pendientes` };
  }
  if (e.vales_vivos.length) {
    return { ok: false, motivo: `La OC ya tiene vale de entrada (${e.vales_vivos.slice(0, 3).join(', ')}): ya se recibió algo; edítala en Kepler` };
  }
  if (!oc.renglones.length) return { ok: false, motivo: 'La OC no tiene renglones' };
  for (const r of oc.renglones) {
    const pres = presentacion(r);
    if (q4(r.pendiente) !== q4(r.cantidad_base)) {
      return { ok: false, motivo: `El renglón ${r.renglon} (${r.sku}) ya tiene algo recibido: edítala en Kepler` };
    }
    if (!(r.factor > 0) || pres === null || q4(pres * r.factor) !== q4(r.cantidad_base)) {
      return { ok: false, motivo: `El renglón ${r.renglon} (${r.sku}) no guarda su cantidad como se midió (presentación × empaque ≠ cantidad): edítala en Kepler` };
    }
    if (r2(r.cantidad_base * r.costo_base) !== r2(r.importe)) {
      return { ok: false, motivo: `El importe del renglón ${r.renglon} (${r.sku}) no es cantidad × costo (¿descuento?): edítala en Kepler` };
    }
  }
  if (r2(oc.descuento) !== 0) return { ok: false, motivo: 'La OC trae descuento en el encabezado: no se midió cómo lo recalcula Kepler; edítala allá' };
  const t = totalesKepler(oc.renglones);
  if (t.total !== r2(oc.total)) {
    return { ok: false, motivo: `El total de la OC (${r2(oc.total)}) no es la suma de sus renglones con impuestos (${t.total}): edítala en Kepler` };
  }
  if (r2(oc.saldo) !== r2(oc.total)) return { ok: false, motivo: 'La OC tiene saldo distinto de su total (¿pagos o anticipos aplicados en Kepler?): edítala allá' };
  return { ok: true, oc };
}

/** ¿Se puede, y cómo queda? Rechaza con su porqué si la OC no es editable o los cambios no son válidos. */
export function decidirEdicionOc(sucursal: string, e: EntradaEdicion, cambios: CambioPedido[]): DecisionEdicion {
  const rev = revisarOcEditable(e);
  if (!rev.ok) return rev;
  const oc = rev.oc;
  if (!Array.isArray(cambios) || !cambios.length) return { ok: false, motivo: 'No cambiaste ninguna cantidad' };
  const vistos = new Set<number>();
  const porRenglon = new Map(oc.renglones.map((r) => [r.renglon, r]));
  const editados: RenglonEditado[] = [];
  for (const c of cambios) {
    const r = porRenglon.get(Number(c.renglon));
    if (!r) return { ok: false, motivo: `La OC no tiene renglón ${c.renglon}` };
    if (vistos.has(r.renglon)) return { ok: false, motivo: `El renglón ${r.renglon} viene dos veces` };
    vistos.add(r.renglon);
    const nueva = Number(c.cantidad);
    if (!Number.isFinite(nueva) || nueva <= 0) {
      return { ok: false, motivo: `La cantidad del renglón ${r.renglon} (${r.sku}) tiene que ser mayor que cero; para quitar un renglón, edítala en Kepler` };
    }
    // Kepler guarda la presentación como texto con dos decimales (`textoKepler`): más decimales desalinearían c56 de c9.
    if (r2(nueva) !== nueva) return { ok: false, motivo: `La cantidad del renglón ${r.renglon} admite hasta 2 decimales` };
    const antes = presentacion(r) as number;
    if (q4(nueva) === q4(antes)) continue;
    const baseNueva = q4(nueva * r.factor);
    editados.push({
      renglon: r.renglon, sku: r.sku, unidad: r.unidad,
      antes, despues: nueva, base_antes: r.cantidad_base, base_despues: baseNueva,
      importe_antes: r2(r.importe), importe_despues: r2(baseNueva * r.costo_base),
      con_c31: r.c31 !== null && q4(r.c31) === q4(r.cantidad_base),
      con_c51: String(r.c51 ?? '').trim() !== '' && String(r.c51).trim() === String(r.c56).trim(),
      c56_antes: String(r.c56).trim(), c56_despues: textoKepler(nueva),
    });
  }
  if (!editados.length) return { ok: false, motivo: 'Las cantidades son las mismas que ya tiene la OC' };
  const nuevos = oc.renglones.map((r) => {
    const ed = editados.find((x) => x.renglon === r.renglon);
    return ed ? { ...r, importe: ed.importe_despues } : r;
  });
  const t = totalesKepler(nuevos);
  return {
    ok: true,
    plan: {
      sucursal, serie: oc.serie, folio: oc.folio, renglones: editados,
      total_antes: r2(oc.total), saldo_antes: r2(oc.saldo), iva: t.iva, ieps: t.ieps, total: t.total,
    },
  };
}

/**
 * Las sentencias, en orden. Cada `UPDATE` repite en su `WHERE` lo que se leyó (cantidad, importe, pendiente;
 * estado y total del encabezado): si alguien la tocó en Kepler entre la lectura y la escritura, afecta 0 filas y
 * todo se deshace en vez de pisar su cambio.
 */
export function sentenciasEdicion(p: PlanEdicion, t: Tablas = TABLAS_KEPLER): Sentencia[] {
  const k = [p.sucursal, p.serie, p.folio];
  const out: Sentencia[] = p.renglones.map((r) => {
    // `[KR.16]` Un parámetro, un tipo: `c9`/`c24`/`c31` son double precision, `c13` numeric, `c51`/`c56` varchar (medido en 00, 03, 08).
    const sets = ['c9 = $5::float8', 'c13 = $6::numeric', 'c24 = $5::float8', 'c56 = $7::text'];
    if (r.con_c31) sets.push('c31 = $5::float8');
    if (r.con_c51) sets.push('c51 = $7::text');
    return {
      que: `renglón ${r.renglon} (${r.sku})`,
      sql: `UPDATE ${t.kdm2} SET ${sets.join(', ')}
             WHERE ${llave('35', 1)} AND c7::int = $4::int
               AND round(c9::numeric, 4) = $8::numeric AND round(c13::numeric, 2) = $9::numeric AND round(c24::numeric, 4) = $8::numeric AND btrim(c56::text) = $10::text`,
      params: [...k, r.renglon, r.base_despues, r.importe_despues, r.c56_despues, r.base_antes, r.importe_antes, r.c56_antes],
      esperadas: 1,
    };
  });
  out.push({
    que: 'encabezado de la OC',
    sql: `UPDATE ${t.kdm1} SET c14 = $4::numeric, c15 = $5::numeric, c16 = $6::numeric, c42 = $6::numeric
           WHERE ${llave('35', 1)} AND btrim(c43) = 'N' AND round(c16::numeric, 2) = $7::numeric AND round(c42::numeric, 2) = $8::numeric`,
    params: [...k, p.iva, p.ieps, p.total, p.total_antes, p.saldo_antes],
    esperadas: 1,
  });
  return out;
}

/** Los permisos que `kepler_push` necesita para el plan, como expresiones `has_column_privilege`. */
export function permisosEdicion(p: PlanEdicion): string[] {
  const col = (tab: string, c: string) => `has_column_privilege(current_user, 'md.${tab}', '${c}', 'UPDATE')`;
  const ren = new Set(['c9', 'c13', 'c24', 'c56']);
  if (p.renglones.some((r) => r.con_c31)) ren.add('c31');
  if (p.renglones.some((r) => r.con_c51)) ren.add('c51');
  return [...[...ren].map((c) => col('kdm2', c)), ...['c14', 'c15', 'c16', 'c42'].map((c) => col('kdm1', c))];
}
