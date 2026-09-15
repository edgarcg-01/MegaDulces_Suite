/**
 * SM.35 — La identidad del turno de caja, en UN solo lugar.
 *
 * Existia escrita tres veces a mano (armarComparacion, list, porCajera) y solo
 * una estaba bien. Las otras dos restaban el cajon contra el esperado del turno
 * COMPLETO —que incluye el efectivo que ya salio en sangrias— y publicaban el
 * retiro como faltante. Medido en prod sobre 11 cierres: la pantalla sumaba
 * $387,085.43 de faltante contra -$13,564.57 real, y marcaba en rojo 11 de 11
 * filas. Las tres de arriba cuadraban al centavo (-$0.30, +$0.01, +$9.77).
 *
 * ── La identidad
 *
 *     suma de retiros + cajon contado = esperado
 *
 * El retiro NO es excepcional: se lleva $26,307 en promedio de los turnos que
 * cruzan el limite de la caja, y 94.8% de esos turnos tienen uno. El sistema
 * esta disenado para que el cajon no tenga el dinero del dia. Restarlo directo
 * acusa a una cajera honesta de un faltante del tamano de sus sangrias.
 *
 * ── Dos diferencias, no una
 *
 * diff_kepler sale del PROPIO desglose de Kepler (c15 - (c43+c44+c48)) y existe
 * para TODOS los cortes, sin que nadie arquee. diff_real usa NUESTRO conteo
 * ciego y solo existe donde alguien conto. Se verificaron uno contra otro: en
 * los 7 turnos donde nuestro conteo coincidio con el cajon declarado por Kepler,
 * los dos dan el MISMO numero al centavo (-0.30 / 9.77 / 0.01 / 69.52 / 953.83 /
 * 0.15 / 0.27). Dos caminos independientes al mismo valor.
 *
 * ── Lo que NO se usa como arbitro
 *
 * c25 (contado) y c35 (diff) quedan solo informativos, por medicion:
 *   - c35 = c15 - c25 en el 100% de 3,844 cortes, o sea es una resta y no una
 *     medicion: no aporta informacion independiente.
 *   - c25 = c15 exacto en el 75.8% de los turnos, 1,700 de ellos CON retiro, o
 *     sea que cuando Kepler dice "cuadrado" muchas veces significa que se
 *     escribio el esperado en la casilla del contado.
 * Consecuencia medida: Kepler publica $699,811 de faltante y su propio desglose
 * implica $2,698,325. Hay 1,066 turnos (30.0%) por $2,204,552 que salen como
 * cuadrados y su desglose los contradice — eso es kepler_enmascaro, y ahora se
 * detecta sin necesidad de arqueo.
 */

/** Diferencia (en pesos) desde la cual un descuadre se considera real. */
export const CUADRE_UMBRAL = 50;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** El corte tal como lo guarda analytics.cash_cuts (o lo trae el ODS). */
export interface CorteKepler {
  efectivo_esperado?: unknown;   // c15 — esperado del turno COMPLETO (incluye lo retirado)
  efectivo_contado?: unknown;    // c25 — DECLARADO. Informativo, nunca arbitro
  efectivo_diff?: unknown;       // c35 — resta de los dos de arriba. Informativo
  arqueo_billetes?: unknown;     // c43
  arqueo_monedas?: unknown;      // c44
  efectivo_retirado?: unknown;   // c48 — lo que salio en sangrias
  cash_limit?: unknown;          // c46 — umbral que dispara la sangria
}

/** Por que una diferencia no se puede afirmar. null = si se puede. */
export type MotivoNoMedible = 'sin_esperado' | 'sin_desglose' | 'sin_conteo' | null;

export interface CuadreTurno {
  esperado: number | null;
  /** Cajon declarado por Kepler (c43+c44). null si no mando desglose. */
  cajon_kepler: number | null;
  /** Nuestro conteo ciego del cajon. null si nadie conto. */
  cajon_contado: number | null;
  retiros_contados: number;
  /** Salio del cajon y no lo contamos. Se acepta la cifra de Kepler, marcada. */
  retiros_sin_verificar: number;
  retirado_kepler: number;
  /** Cajon + retiros contados + retiros sin verificar. */
  contado_total: number | null;
  /**
   * Diferencia segun el DESGLOSE de Kepler. Existe para todos los cortes.
   * Positivo = faltante. Negativo = sobrante.
   */
  diff_kepler: number | null;
  /** Diferencia con NUESTRO conteo. Solo donde alguien arqueo. */
  diff_real: number | null;
  /** El mejor disponible: el nuestro si existe, si no el de Kepler. */
  diff: number | null;
  /** false = no se puede afirmar una diferencia. Nunca se dibuja como 0. */
  medible: boolean;
  motivo: MotivoNoMedible;
  /** Que porcion del efectivo del turno paso por manos que contaron. */
  cobertura: number | null;
  /** Lo que Kepler PUBLICA (c35). Informativo: es una resta, no una medicion. */
  diff_publicado: number | null;
  kepler_contado: number | null;
  /** c43+c44+c48 vs c25: cuando no cierra, el total declarado va por su cuenta. */
  kepler_desglose_cuadra: boolean | null;
  kepler_desglose_faltante: number | null;
  /** Kepler dio el corte por cuadrado y la diferencia disponible lo contradice. */
  kepler_enmascaro: boolean;
}

/**
 * Cuadra un turno. cajonContado en null = nadie arqueo (el caso normal en 3,500
 * de 3,551 cortes) y entonces solo se puede hablar de diff_kepler.
 */
export function cuadreTurno(
  cut: CorteKepler,
  opts: { cajonContado?: number | null; retirosContados?: number } = {},
): CuadreTurno {
  const esperado = num(cut.efectivo_esperado);
  const billetes = num(cut.arqueo_billetes);
  const monedas = num(cut.arqueo_monedas);
  const retiradoKepler = num(cut.efectivo_retirado) ?? 0;
  const keplerContado = num(cut.efectivo_contado);
  const diffPublicado = num(cut.efectivo_diff);

  const cajonContado = opts.cajonContado == null ? null : r2(Number(opts.cajonContado));
  const retirosContados = r2(Number(opts.retirosContados || 0));
  // Lo que salio y no contamos. Se acepta la palabra de Kepler para poder cerrar
  // la ecuacion, pero va aparte: un faltante real y "no lo contamos" son cosas
  // distintas y no pueden sumar al mismo numero.
  const sinVerificar = r2(Math.max(0, retiradoKepler - retirosContados));

  const cajonKepler = billetes == null && monedas == null
    ? null : r2((billetes ?? 0) + (monedas ?? 0));

  // esperado en 0 no es "cuadro": es un turno sin esperado (apertura fallida, o
  // el feed todavia no lo trajo). Devolver 0 lo haria pasar por cuadrado.
  const hayEsperado = esperado != null && esperado > 0;

  const diffKepler = hayEsperado && cajonKepler != null
    ? r2((esperado as number) - (cajonKepler + retiradoKepler)) : null;

  const contadoTotal = cajonContado == null
    ? null : r2(cajonContado + retirosContados + sinVerificar);
  const diffReal = hayEsperado && contadoTotal != null
    ? r2((esperado as number) - contadoTotal) : null;

  const diff = diffReal ?? diffKepler;

  let motivo: MotivoNoMedible = null;
  if (!hayEsperado) motivo = 'sin_esperado';
  else if (diff == null) motivo = cajonKepler == null ? 'sin_desglose' : 'sin_conteo';

  const sumaKepler = (cajonKepler ?? 0) + retiradoKepler;
  const desgloseCuadra = keplerContado != null && cajonKepler != null
    ? Math.abs(sumaKepler - keplerContado) < 1 : null;

  return {
    esperado: hayEsperado ? esperado : null,
    cajon_kepler: cajonKepler,
    cajon_contado: cajonContado,
    retiros_contados: retirosContados,
    retiros_sin_verificar: sinVerificar,
    retirado_kepler: r2(retiradoKepler),
    contado_total: contadoTotal,
    diff_kepler: diffKepler,
    diff_real: diffReal,
    diff,
    medible: diff != null,
    motivo,
    cobertura: hayEsperado && cajonContado != null
      ? Math.min(1, r2((cajonContado + retirosContados) / (esperado as number))) : null,
    diff_publicado: diffPublicado,
    kepler_contado: keplerContado,
    kepler_desglose_cuadra: desgloseCuadra,
    kepler_desglose_faltante: desgloseCuadra === false && keplerContado != null
      ? r2(keplerContado - sumaKepler) : null,
    // El enmascaramiento se juzga contra la MEJOR diferencia disponible, no
    // contra c35 (que por construccion concuerda consigo mismo).
    kepler_enmascaro: diffPublicado != null && diff != null
      && Math.abs(diffPublicado) < CUADRE_UMBRAL && Math.abs(diff) >= CUADRE_UMBRAL,
  };
}

/**
 * La caja pide sangria? El umbral es c46 y el disparo esta medido: por debajo
 * del limite hay retiro en 2.4-14.1% de los turnos; al cruzarlo salta a 70.8%,
 * y arriba de 150% del limite es 99.1%.
 *
 * OJO: cajonEstimado es una ESTIMACION (c49 - c48), no un conteo. Acierta el
 * cajon final dentro de $50 en el 54.4% de los turnos, con sesgo +$671 porque no
 * incluye el fondo inicial. Sirve para DISPARAR el aviso; no se publica como
 * cifra ni alimenta ninguna diferencia.
 */
export function pideRetiro(cajonEstimado: number | null, limite: number | null): boolean {
  if (cajonEstimado == null || limite == null || limite <= 0) return false;
  return cajonEstimado >= limite;
}
