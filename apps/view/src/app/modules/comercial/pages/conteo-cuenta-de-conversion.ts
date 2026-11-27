/**
 * `[ICR.M6]` **La cuenta que se le muestra a quien cuenta en cajas, antes de aceptar.**
 *
 * Vive fuera del componente a propósito: la pantalla del contador arrastra `@zxing/browser` y
 * Capacitor, así que no se puede montar en una prueba. Acá la aritmética se ejerce de verdad,
 * con sus casos límite, en vez de comprobar por `grep` que el bloque existe.
 *
 * ## Por qué existe
 *
 * Contar en cajas multiplica el error por el factor, y **ninguna base de datos sabe cuántas
 * piezas trae la caja que está físicamente en el anaquel**. Medido en prod el 2026-11-27 para
 * Yurécuaro: **1,905 de 2,024** artículos tienen factor de caja, y de los 133 con código de
 * barras de caja el factor del catálogo y el del ERP discrepan en **123 de 134** comparaciones
 * contra 11 que coinciden. Si alguien cuenta 3 cajas, la caja real trae 12 y el sistema cree
 * 24, se registran 72 donde hay 36: **un error de una caja son 24 unidades**.
 *
 * Por eso la multiplicación no se hace a escondidas: se escribe con el factor suelto, que es
 * lo único que la persona puede cotejar contra la caja que tiene en la mano.
 */

/** Una unidad en que se puede contar un producto, con su factor contra la nativa. */
export interface UnidadParaContar {
  unit: string;
  /** Unidades NATIVAS por cada una de ésta. La nativa vale 1. */
  factor: number;
  /** `true` si es la del código que viene con el SKU: la unidad del teórico. */
  es_nativa: boolean;
}

/** Lo que tecleó la persona, por cuánto se multiplica y qué queda escrito en el folio. */
export interface CuentaDeConversion {
  /** Lo que la persona tecleó, en la unidad que eligió. */
  cantidad: number;
  /** La unidad que eligió (`CJA`, `BTO`…), tal como la nombra el catálogo. */
  unidad: string;
  /** Unidades nativas por cada una de las que eligió. */
  factor: number;
  /** La unidad del teórico, en la que se guarda. */
  nativa: string;
  /** `cantidad × factor`: lo que se va a escribir. */
  total: number;
}

/**
 * Devuelve la cuenta a mostrar, o `null` cuando **no hay nada que afirmar**.
 *
 * Los cinco casos en que devuelve `null` son tan importantes como el cálculo:
 *
 * | Caso | Por qué no se muestra nada |
 * |---|---|
 * | Sin cantidad tecleada | Todavía no hay cuenta que hacer |
 * | La unidad elegida no está en la lista | No se adivina a qué equivale |
 * | Se cuenta en la unidad NATIVA | No hay conversión: lo tecleado es lo que se guarda |
 * | Factor 1 (o no positivo) | Multiplicar por uno no es una cuenta que verificar |
 * | ⛔ **No hay unidad nativa conocida** | 15 % de los artículos no tienen código primario; sin la unidad del teórico no hay contra qué convertir, y **rellenarla sería inventar el factor**, que es justo el defecto que esto previene |
 */
export function cuentaDeConversion(
  cantidad: number | null | undefined,
  unidadElegida: string | null | undefined,
  unidades: readonly UnidadParaContar[] | null | undefined,
): CuentaDeConversion | null {
  if (cantidad === null || cantidad === undefined || !Number.isFinite(cantidad)) return null;
  const lista = unidades ?? [];
  const elegida = lista.find((u) => u.unit === unidadElegida);
  if (!elegida || elegida.es_nativa) return null;
  const nativa = lista.find((u) => u.es_nativa);
  if (!nativa) return null;
  if (!(elegida.factor > 0) || elegida.factor === 1) return null;
  return {
    cantidad,
    unidad: elegida.unit,
    factor: elegida.factor,
    nativa: nativa.unit,
    total: cantidad * elegida.factor,
  };
}
