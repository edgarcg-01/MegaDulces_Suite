/**
 * `[ETQ-PRES.0]` UN PRECIO TAMBIÉN VIAJA CON SU UNIDAD — la presentación como dato (ADR-056 · VU.0).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * `quantity-unit.contract.ts` (VU.0) ya estableció la regla para las CANTIDADES:
 *
 *   *"Una cantidad que no dice su unidad no es un dato, es un número."*
 *
 * Nunca se aplicó a los PRECIOS. Y es el mismo error, con el mismo costo. La etiquetera modela
 * tres cajones con nombre fijo —`piece_*`, `pack_*`, `box_*`— y el ERP modela una LISTA de
 * presentaciones. Forzar la lista dentro de tres cajones rotulados a mano produjo, medido en
 * prod el 2026-09-24, cinco defectos que son **uno solo**:
 *
 *   · `KG`/`CUB`/`BTO`/`SER` no llegan a la etiqueta — 202 SKUs × 9 plazas = **1,980 ranuras**,
 *     todas con precio cargado. El cajón se elige comparando el nombre contra los literales
 *     `'PAQ'` y `'CJA'`; cualquier otra unidad cae fuera y desaparece sin avisar.
 *   · El mayoreo de CAJA no existe — **6,826 SKUs**. El cajón `box_*` guarda `kdii.c92`, que es
 *     el precio de MOSTRADOR, y nunca fue a buscar el peldaño de esa presentación. Medido en
 *     `95717`: la etiqueta imprime $2,985.90 y el ERP cobra **$2,879.65 desde 3 cajas**.
 *   · "MAYOREO $1.35" con la pieza a $26.01 — **61 SKUs**. El peldaño se eligió por un rótulo
 *     intermedio (`bp.key`), no por ser **la misma** presentación que el precio con el que se
 *     compara.
 *   · "25 kg · $57.88" — **111 SKUs × 9**. El contenido sale de un regex sobre el NOMBRE del
 *     producto (que describe el bulto) y el precio sale de la unidad base (500 g). Los dos viajan
 *     solos y los aparea el componente. El peor caso mide **50×**.
 *   · Una cubeta imprimiría "CAJA 50 PAQUETES": la palabra está escrita en el HTML porque el
 *     número llegó sin su unidad.
 *
 * ⭐ Las tres guardas que se iban a escribir para tapar esto —banda de razón mayoreo/lista,
 * árbitro de costo, chequeo de conmensurabilidad del contenido— son tres formas de preguntar
 * *"¿estos dos números hablan de lo mismo?"*. **Esa pregunta no debería poder hacerse.** Cuando
 * cada precio carga su unidad, la respuesta es estructural y la guarda sobra.
 *
 * ── La forma ────────────────────────────────────────────────────────────────────────────────
 *
 * Una PRESENTACIÓN es la unidad en la que el ERP publica un precio. Lleva su rótulo, su factor
 * contra la base, su contenido DERIVADO del factor (no del nombre) y su propio peldaño de
 * mayoreo — leído del renglón de **esa misma unidad**, así que es conmensurable por construcción.
 *
 * ⚠️ `unidad` es texto libre, igual que `QtyUnitLabel` y por la misma razón medida: Kepler guarda
 * GRAMAJES (`500`, `250`, `400`) donde debería ir una unidad, y mapearlos a un enum es inventar
 * una unidad que la fuente no declaró. Se guarda lo que dice el ERP; el consumidor decide si lo
 * entiende, y si no lo entiende **lo declara**, no lo traduce.
 *
 * ⛔ Ninguno de estos campos se rellena con un default. `precio_lista` en `null` significa que el
 * ERP no publica precio para esa presentación — **no significa cero**, y `mayoreo_precio` en
 * `null` no significa "sin descuento": significa que no hay peldaño registrado.
 */

import type { QtyUnitLabel } from './quantity-unit.contract';

/**
 * Por qué una presentación existe. Importa porque no todas vienen del mismo lado, y medido en
 * prod (rama 01, 2026-09-24) **ninguno de los dos lados es superset del otro**:
 *
 *   17,102 presentaciones están en `kdii` **y** en la escalera
 *    1,493 sólo en `kdii` .............. tiene precio de lista, no tiene peldaño de mayoreo
 *    1,662 sólo en la escalera ......... tiene mayoreo, y `kdii` no le publica precio de lista
 *
 * Por eso la lista es la UNIÓN de ambos. Tomar uno solo —que es lo que hace el modelo de tres
 * cajones— pierde datos en los dos sentidos.
 */
export type PresentacionOrigen =
  /** La unidad base del catálogo (`kdii.c11`). Su precio es `c90`. Factor 1 por definición. */
  | 'base'
  /** Una de las dos ranuras de unidad alterna de `kdii` (`c80`/`c81`/`c91` o `c83`/`c84`/`c92`). */
  | 'ranura'
  /** Sólo aparece en `kdpv_prod_util`: el ERP le pone peldaño de mayoreo pero no precio de lista. */
  | 'escalera';

/**
 * Una presentación con su precio. **Todo lo que la etiqueta imprime de una unidad sale de acá**,
 * para que sea imposible aparear el precio de una con el contenido de otra.
 */
export interface PresentacionPrecio {
  /** Rótulo tal como lo nombra el ERP: `PZA`, `PAQ`, `CJA`, `KG`, `CUB`, `BTO`, `500`… */
  unidad: QtyUnitLabel;
  /** Cuántas unidades base entran en ésta. La base vale 1. Nunca `null`: sin factor no hay presentación. */
  factor: number;
  /** De dónde salió — ver `PresentacionOrigen`. */
  origen: PresentacionOrigen;
  /**
   * Contenido de ESTA presentación, derivado de `factor × contenido de la base`.
   * `null` cuando el contenido de la base no se conoce — **nunca se cae al nombre del producto**,
   * que es de dónde salió el "25 kg · $57.88".
   */
  contenido: string | null;
  /** Precio de lista de esta presentación. `null` = el ERP no lo publica (no es cero). */
  precio_lista: number | null;
  /** Precio del peldaño de mayoreo de ESTA MISMA unidad. `null` = no hay peldaño registrado. */
  mayoreo_precio: number | null;
  /** Desde cuántas unidades aplica ese peldaño. `null` cuando `mayoreo_precio` lo está. */
  mayoreo_desde: number | null;
  /**
   * ⭐ Veredicto sobre si el mayoreo es creíble **contra el precio de lista de esta misma
   * presentación** — no contra el de otra, que es el error que producía "$1.35 vs $26.01".
   *
   * Ternario a propósito (ADR-056): un booleano no puede decir "no sé".
   */
  mayoreo_veredicto: MayoreoVeredicto;
}

/**
 * ⭐ Tres estados, no dos. `sin_arbitro` NO es `ok`.
 *
 * Medido en prod: de 9,731 presentaciones cuyo mayoreo viene de otra presentación, **6,358 (65%)
 * no tienen con qué compararse** porque el ERP no publica precio de lista para esa unidad.
 * Llamarlas `ok` sería el `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional.
 */
export type MayoreoVeredicto =
  /** Hay precio de lista de la misma unidad y el mayoreo cae en una banda creíble. */
  | 'ok'
  /** Hay con qué comparar y NO cuadra: el peldaño está en otra escala. No se publica el precio. */
  | 'incoherente'
  /** No hay precio de lista de esta unidad: no se puede arbitrar. Se declara, no se esconde. */
  | 'sin_arbitro'
  /** No hay peldaño para esta presentación. */
  | 'sin_mayoreo';

/**
 * Banda en la que un mayoreo es creíble, como fracción del precio de lista de SU MISMA unidad.
 *
 * Medido en prod (2026-09-24, 62,201 presentaciones con ambos lados comparables):
 *   395 por debajo de 0.50 .... el peldaño está en otra escala (el caso `44228`: $1.35 vs $26.01)
 *   60,667 dentro de la banda . descuento de volumen real
 *   1,139 por encima de 1.00 .. el "mayoreo" sale MÁS CARO que comprar de a uno
 *
 * ⚠️ El piso NO es un umbral de gusto: un descuento de volumen por encima del 50% no existe en
 * este catálogo, y por debajo de eso lo que hay es una unidad distinta disfrazada. El techo es
 * aritmético: si el mayoreo supera a la lista, no es mayoreo.
 */
export const MAYOREO_BANDA = { piso: 0.5, techo: 1.0 } as const;

/** ¿Se puede imprimir este mayoreo? Sólo `ok`. Los otros tres se declaran distinto en pantalla. */
export function mayoreoPublicable(p: Pick<PresentacionPrecio, 'mayoreo_veredicto'>): boolean {
  return p.mayoreo_veredicto === 'ok';
}

/**
 * La presentación más grande con precio — la candidata natural al renglón de volumen.
 * Devuelve `null` si ninguna tiene precio, en vez de caer a la base (que sería inventar).
 */
export function presentacionMayor(ps: readonly PresentacionPrecio[]): PresentacionPrecio | null {
  const conPrecio = ps.filter((p) => p.precio_lista != null && p.factor > 1);
  if (!conPrecio.length) return null;
  return conPrecio.reduce((a, b) => (b.factor > a.factor ? b : a));
}
