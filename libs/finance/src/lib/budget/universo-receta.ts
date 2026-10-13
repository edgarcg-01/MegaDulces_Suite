/**
 * `[TES.20]` **La receta de un cociente: los cuatro ejes que lo vuelven reproducible.**
 *
 * ── DE DÓNDE SALE ────────────────────────────────────────────────────────
 *
 * El 2026-10-10, tres carriles produjeron **seis derivaciones del mismo DPO en dos horas**:
 *
 * ```
 *   77.3   numerador de TODA la deuda / denominador de sólo recepciones de mercancía
 *   67.6   ventana de 365 días, con 7 sucursales entrando a mitad
 *   54.6   ventana de 365 días, el mismo problema
 *   48.8   ventana de 90 días, con 3 sucursales entrando
 *   45.9   sucursales 00-05, pero contando los duplicados del CEDIS
 *   51.4   sucursales 00-05, deduplicado
 * ```
 *
 * ⭐ **Las cuatro primeras no estaban mal calculadas: estaban mal declaradas.** Cada una dividía
 * dos universos distintos sin decirlo, y las dos últimas se separan por un filtro
 * (`dup_of_folio`) que **ninguna de las dos mencionó**. Dos consultas correctas, dos números
 * distintos, y nada en la salida permitía saber por qué.
 *
 * ⇒ El defecto no es de aritmética, es de **procedencia**: un cociente sin su receta es
 * irreproducible aunque esté bien calculado. Esta pieza hace que el servicio **se niegue a
 * emitir** cuando los dos lados no coinciden, y que publique la receta **junto a la cifra**.
 *
 * ── LOS CUATRO EJES ──────────────────────────────────────────────────────
 *
 *   1. **sucursales** — qué plazas entran de cada lado
 *   2. **ventana**    — cuántos días cubre el flujo
 *   3. **grupo**      — mercancía / servicios / financieros
 *   4. **deduplicación** — si se honró la marca de duplicado de la fuente
 *
 * ── ⭐ POR QUÉ EL EJE 4 NO EXIGE IGUALDAD ────────────────────────────────
 *
 * La regla ingenua sería «los dos lados deduplicados». **Es incorrecta, y lo decide una
 * medición:** `analytics.erp_goods_receipts` trae duplicados marcados (`dup_of_folio`,
 * $16,772,238.39 en 90 días: el CEDIS registra la recepción de la sucursal), y
 * `analytics.v_supplier_payables` **no los tiene** — se buscó la firma del defecto y da
 * **0 grupos con la sucursal 00**.
 *
 * ⇒ Deduplicar un lado y el otro no **es lo correcto cuando el otro no tiene qué deduplicar**.
 * Lo que nunca es correcto es **dejar duplicados conocidos adentro**. Por eso el eje compara
 * *compatibilidad*, no igualdad: `deduplicado` convive con `sin_duplicados_conocidos`, y
 * `con_duplicados` no convive con nada.
 */

/** Qué se hizo con los duplicados de ESTE lado del cociente. */
export type TratoDuplicados =
  /** La fuente los marca y se excluyeron. */
  | 'deduplicado'
  /** La fuente los marca y **se dejaron adentro**. Nunca es correcto. */
  | 'con_duplicados'
  /** Se buscó la firma del defecto en esta fuente y no aparece. */
  | 'sin_duplicados_conocidos'
  /** No se buscó. Se declara, no se asume. */
  | 'sin_medir';

export interface UniversoReceta {
  /** Códigos de sucursal que entran, **ordenados**: el orden no debe cambiar el veredicto. */
  sucursales: string[];
  /** Días que cubre el lado de flujo. Para un stock a una fecha va `null`. */
  ventana_dias: number | null;
  /** `mercancia` · `servicios` · `financieros` · `todos`. */
  grupo: string;
  dedup: TratoDuplicados;
  /** De dónde salió, para que la receta se pueda re-correr. */
  fuente: string;
}

export interface EjeDesalineado {
  eje: 'sucursales' | 'ventana' | 'grupo' | 'dedup';
  numerador: string;
  denominador: string;
  por_que: string;
}

const lista = (xs: string[]) => [...xs].sort().join(',') || '(vacío)';

/** `deduplicado` y `sin_duplicados_conocidos` son compatibles. Ver el bloque de arriba. */
function dedupIncompatible(n: TratoDuplicados, d: TratoDuplicados): string | null {
  if (n === 'con_duplicados' || d === 'con_duplicados') {
    return 'un lado deja adentro duplicados que su fuente marca: el cociente cuenta dos veces lo que pasó una';
  }
  if (n === 'sin_medir' || d === 'sin_medir') {
    return 'un lado no declara si honró la marca de duplicado de su fuente: no se asume, se mide';
  }
  return null;
}

/**
 * Los ejes en que numerador y denominador **no** describen el mismo universo.
 * Vacío = el cociente se puede emitir.
 */
export function ejesDesalineados(num: UniversoReceta, den: UniversoReceta): EjeDesalineado[] {
  const out: EjeDesalineado[] = [];

  if (lista(num.sucursales) !== lista(den.sucursales)) {
    out.push({
      eje: 'sucursales', numerador: lista(num.sucursales), denominador: lista(den.sucursales),
      por_que: 'el numerador y el denominador no cubren las mismas plazas: el cociente mezcla operaciones distintas',
    });
  }
  // El stock (ventana null) contra un flujo es legítimo: es la forma misma de un DSO/DPO.
  if (num.ventana_dias !== null && den.ventana_dias !== null && num.ventana_dias !== den.ventana_dias) {
    out.push({
      eje: 'ventana', numerador: `${num.ventana_dias} d`, denominador: `${den.ventana_dias} d`,
      por_que: 'dos flujos con ventanas distintas no se dividen: el resultado lo manda la ventana, no el negocio',
    });
  }
  if (num.grupo !== den.grupo) {
    out.push({
      eje: 'grupo', numerador: num.grupo, denominador: den.grupo,
      por_que: 'el numerador incluye familias que el denominador no explica (fue el defecto del 77.3)',
    });
  }
  const dd = dedupIncompatible(num.dedup, den.dedup);
  if (dd) out.push({ eje: 'dedup', numerador: num.dedup, denominador: den.dedup, por_que: dd });

  return out;
}

/** La receta en una línea, para que viaje **junto a la cifra** y no en un comentario. */
export function recetaLegible(num: UniversoReceta, den: UniversoReceta): string {
  const lado = (r: UniversoReceta) =>
    `${r.grupo} · ${lista(r.sucursales)}${r.ventana_dias !== null ? ` · ${r.ventana_dias} d` : ' · stock'} · ${r.dedup}`;
  return `${lado(num)}  ÷  ${lado(den)}`;
}
