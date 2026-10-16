import { escalera, rotuloCrudo, type Presentacion } from './qty-units';

/**
 * `[VTK.9]` Cuanto trae la caja, dicho en las presentaciones que el vendedor ya conoce.
 *
 * Pedido de ruta (2026-10-14): al buscar un producto, el vendedor tiene que ver cuantos
 * paquetes / piezas trae la caja sin abrir la ficha ni hacer la cuenta. El cliente pregunta
 * "¿cuantas trae?" y hoy la respuesta solo existia en el factor del selector.
 *
 * La caja NO siempre se llama CJA. Medido en prod (sucursal 02, 2026-10-14) sobre la escalera
 * de Kepler (`v_label_presentations`, factor > 1): CJA 8,396 · BTO 167 · CUB 3. Por eso se
 * prefiere la caja que DECLARA la escalera de la sucursal (peldaño `box` del catalogo) y solo
 * sin escalera se reconoce por rotulo.
 *
 * Regla de honestidad (ADR-056): una presentacion menor que no cabe EXACTA en la caja no se
 * pinta con decimales ("4.17 PAQ" no es algo que se pueda entregar). Se omite y queda la cuenta
 * en unidad base, que siempre es exacta. Medido: 1 de 382 SKUs con paquete y caja no divide.
 * Sin caja declarada no se pinta nada: no hay un cero que dibujar.
 */

export interface ParteCaja {
  unit: string;
  qty: number;
}

export interface ContenidoCaja {
  /** Rotulo de la caja tal como se pinta en el selector (CJA, BTO, CUB). */
  caja: string;
  /** Unidades base que trae. */
  factor: number;
  /** De la presentacion mayor a la menor; la ultima es la unidad base. */
  partes: ParteCaja[];
}

/** Rotulos que son "la unidad mayor" cuando no viene la escalera de la sucursal. */
const ROTULOS_CAJA = new Set(['CJA', 'CAJA', 'CJ', 'BTO', 'CUB']);

/** Cuando la unidad base no viaja en la escalera (peldaño sin precio), se nombra asi. */
export const UNIDAD_BASE_SIN_ROTULO = 'unidades';

/**
 * @param units      Presentaciones del SKU (las del selector).
 * @param declarada  La caja que declara la escalera de Kepler de la sucursal:
 *                   - objeto  = esa es la caja;
 *                   - `null`  = la escalera vino y NO declara caja → no hay contenido que mostrar;
 *                   - `undefined` = no vino escalera → se reconoce por rotulo.
 */
export function contenidoCaja(
  units: readonly Presentacion[] | null | undefined,
  declarada?: { unit: string; factor: number } | null,
): ContenidoCaja | null {
  const esc = escalera(units);
  let caja: Presentacion | null = null;

  if (declarada === null) return null;
  if (declarada) {
    const f = Math.floor(Number(declarada.factor));
    if (!Number.isFinite(f) || f <= 1) return null;
    caja =
      esc.find((u) => rotuloCrudo(u) === String(declarada.unit).trim() && Math.floor(u.factor) === f) ??
      { unit: String(declarada.unit).trim(), factor: f };
  } else {
    const candidatas = esc.filter(
      (u) => Math.floor(u.factor) > 1 && ROTULOS_CAJA.has(rotuloCrudo(u).toUpperCase()),
    );
    caja = candidatas.sort((a, b) => b.factor - a.factor)[0] ?? null;
  }
  if (!caja || !caja.unit) return null;

  const factor = Math.floor(caja.factor);
  const partes: ParteCaja[] = esc
    .filter((u) => {
      const f = Math.floor(u.factor);
      return f >= 1 && f < factor && factor % f === 0;
    })
    .sort((a, b) => b.factor - a.factor)
    .map((u) => ({ unit: u.unit, qty: factor / Math.floor(u.factor) }));

  // La unidad base siempre cabe exacta: si la escalera no la trajo, se dice igual la cuenta.
  if (!partes.some((p) => p.qty === factor)) {
    partes.push({ unit: UNIDAD_BASE_SIN_ROTULO, qty: factor });
  }
  return { caja: caja.unit, factor, partes };
}
