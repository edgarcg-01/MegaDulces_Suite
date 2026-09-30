import type { Knex } from 'knex';

/**
 * `[PR.E0b]` — **El resolvedor ÚNICO de la meta de margen.**
 *
 * Vive acá y no dentro de un servicio porque **dos** lo necesitan
 * (`commercial-profitability` y `commercial-intelligence`), y un primitivo con dos
 * implementaciones diverge — es la regla R6 de ADR-059, y el repo ya la pagó: el 15 % estaba
 * clavado en **tres** archivos distintos y ninguno persistía nada.
 *
 * ⛔ **Recibe el `trx`, no lo crea.** `TenantKnexService.run()` **no se anida** (la RLS forzada
 * depende de la variable de sesión que abre esa transacción), así que el llamador resuelve dentro
 * de la suya.
 *
 * ⭐ **Devuelve la PROCEDENCIA junto al número.** Un default *medido* no es un default
 * *autorizado*: la pantalla tiene que poder decir «así se opera hoy, nadie lo firmó».
 */
export interface MargenObjetivo {
  /** El % de margen bruto sobre la venta. */
  target: number;
  /**
   * `override_url` · `manual` · `default_medido` · `auto`
   * · `hardcoded_fallback_sin_tabla` (falta la migración 20260929170000 en este destino)
   * · `hardcoded_fallback_sin_fila` (la tabla está pero sin la fila default)
   */
  target_source: string;
  /** `true` = lo fijó un humano; un recalculador automático NO debe pisarlo (ADR-021/076). */
  target_locked: boolean;
  /** El piso. ⛔ Hoy **NULL a propósito**: ver `minimo_motivo` y la decisión D13. */
  target_min: number | null;
  /** Por qué el piso está vacío. Se muestra, no se esconde. */
  min_motivo: string | null;
}

/** El valor que había clavado en el código antes de esta tabla. Se conserva como red, DECLARADO. */
export const MARGIN_TARGET_FALLBACK = 15;

/**
 * Resuelve la meta con la cascada **producto > categoría > proveedor > default**.
 *
 * @param trx        la transacción del llamador (con el tenant ya en sesión)
 * @param explicito  override venido de la URL; gana sobre la tabla y se marca como tal
 * @param scope      ámbito para la cascada; sin él resuelve la fila default del tenant
 */
export async function resolveMarginTarget(
  trx: Knex,
  explicito?: number,
  scope: { productId?: string; categoria?: string; supplierCode?: string } = {},
): Promise<MargenObjetivo> {
  const n = Number(explicito);
  if (Number.isFinite(n) && n > 0 && n < 100) {
    return {
      target: n, target_source: 'override_url', target_locked: false,
      target_min: null, min_motivo: null,
    };
  }

  try {
    const vigente = (q: Knex.QueryBuilder) => q
      .where('vigencia_desde', '<=', trx.fn.now())
      .andWhere((w) => w.whereNull('vigencia_hasta').orWhere('vigencia_hasta', '>', trx.fn.now()));

    /**
     * ⭐ La cascada se recorre de lo ESPECÍFICO a lo general y se corta en el primer acierto.
     * El CHECK `margin_targets_un_solo_ambito` garantiza que una fila no puede tener dos ejes,
     * así que acá no hay que desempatar nada — la ambigüedad se prohibió en la tabla.
     */
    const niveles: Array<[string, string | undefined]> = [
      ['product_id', scope.productId],
      ['categoria', scope.categoria],
      ['supplier_code', scope.supplierCode],
    ];
    for (const [col, val] of niveles) {
      if (!val) continue;
      const [row] = await vigente(
        trx('commercial.margin_targets')
          .select('margen_objetivo', 'margen_minimo', 'minimo_motivo', 'source', 'manual_lock')
          .where(col, val),
      ).orderBy('vigencia_desde', 'desc').limit(1);
      if (row?.margen_objetivo != null) return desdeFila(row);
    }

    const [def] = await vigente(
      trx('commercial.margin_targets')
        .select('margen_objetivo', 'margen_minimo', 'minimo_motivo', 'source', 'manual_lock')
        .whereNull('product_id').whereNull('categoria').whereNull('supplier_code'),
    ).orderBy('vigencia_desde', 'desc').limit(1);
    if (def?.margen_objetivo != null) return desdeFila(def);
  } catch {
    // La migración 20260929170000 no está en este destino. ⛔ No se traga en silencio:
    // el llamador recibe la fuente y puede mostrarla.
    return {
      target: MARGIN_TARGET_FALLBACK, target_source: 'hardcoded_fallback_sin_tabla',
      target_locked: false, target_min: null, min_motivo: null,
    };
  }

  return {
    target: MARGIN_TARGET_FALLBACK, target_source: 'hardcoded_fallback_sin_fila',
    target_locked: false, target_min: null, min_motivo: null,
  };
}

function desdeFila(row: any): MargenObjetivo {
  return {
    target: Number(row.margen_objetivo),
    target_source: String(row.source ?? 'default_medido'),
    target_locked: !!row.manual_lock,
    target_min: row.margen_minimo == null ? null : Number(row.margen_minimo),
    min_motivo: row.minimo_motivo ?? null,
  };
}
