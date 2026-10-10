/**
 * `[PVI.19]` — **Lo que la superficie de DECIDIR afirma.** Answer-first, separado de lo que dibuja.
 *
 * ── ⛔ `[PVI.20]` Qué se BORRÓ de este archivo, y por qué ────────────────────────────────────
 *
 * Acá vivía `concentracion()`. **Era el sexto artefacto duplicado del día**: el carril de Gastos
 * ya tenía `libs/finance/src/lib/budget/budget-concentration.ts` (`[PU.VG.10]`), con su contrato
 * `ExpenseConcentration` en `libs/contracts` y su candado de 173 líneas. Lo mío llegó después y no
 * lo vi porque estaba en una rama sin mergear.
 *
 * Decisión del usuario: **gana el suyo**. El de ellos es mejor donde importa — declara `cobertura`
 * (cuántas partidas sin monto, sin responsable, sin clase) y **no tira ninguna fila en silencio**,
 * que es justo el defecto que la auditoría encontró en el mío.
 *
 * ⇒ Este archivo se queda sólo con lo que NO estaba duplicado: el veredicto de llegada y el costo
 * de no firmar. La concentración ahora **entra al componente como dato**, calculada por el
 * primitivo único.
 *
 * ── ⛔ Y el error de fondo que la auditoría destapó, que no era de código ────────────────────
 *
 * Mi superficie titulaba la concentración como «el hecho que la tabla escondía», medida sobre el
 * canal **Mostrador**. Verificado contra prod el 2026-10-09 sobre el ejercicio COMPLETO:
 *
 *     Mostrador solo   mayor 34.8 %   ← el recorte que elegí
 *     Ingreso entero   mayor 20.32 %  · 9 de 33 cruzan el 80 %   → NO está concentrado
 *     Gasto            mayor 55.50 %  · 4 de 14 cruzan el 80 %   → SÍ lo está
 *
 * O sea que mostré **el único recorte donde la concentración se ve alta** y lo llamé el hallazgo.
 * El hecho real es la **asimetría**: el ingreso está repartido y el gasto cuelga de una partida.
 *
 * ⚠️ Y una precisión sobre esa asimetría: está en **la mayor**, no en la forma de Pareto. Cruzan
 * el 80 % 9 de 33 (27 %) contra 4 de 14 (29 %) — casi igual. Lo que cambia es el renglón de
 * arriba, 20 % contra 55 %: es riesgo de punto único, no de reparto.
 *
 * Por eso el componente ahora **exige declarar el universo** y de qué es recorte: un bloque que
 * muestra una parte y no dice de qué, miente aunque cada cifra esté bien.
 */

export type ClaveLlegada = 'sin_real' | 'sin_meta' | 'adelante' | 'en_linea' | 'atras';

export interface Llegada {
  clave: ClaveLlegada;
  /** La frase SIEMPRE existe: o dice cómo vamos, o dice por qué no se puede decir. */
  frase: string;
  tono: 'ok' | 'warn' | 'bad' | 'muted';
  /** Qué hace falta para poder contestar. Vacío cuando ya se contesta. */
  falta: readonly string[];
}

/** Dentro de esta banda, cumplir no es ir adelante ni atrás: es ir en línea. */
export const BANDA_EN_LINEA = 0.02;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const pct = (x: number): string => `${Math.round(x * 1000) / 10} %`;

/**
 * `[PVI.19]` **¿Vamos a llegar?** — la única pregunta que una pantalla de decidir abre contestando.
 *
 * ⛔ Cuando no se puede contestar, **lo dice y dice qué falta**. Medido: `real_available` es
 * `false` y la cobertura real es 0 %, así que la respuesta honesta es «todavía no se puede» con el
 * nombre de lo que falta — no un cumplimiento de 0 %, que se lee como un desastre, ni un guion,
 * que se lee como que la pantalla está rota.
 */
export function llegada(
  meta: number | null,
  real: number | null,
  opciones?: { periodosSinMeta?: number; realDisponible?: boolean },
): Llegada {
  const m = num(meta);
  const r = num(real);
  const sinMeta = opciones?.periodosSinMeta ?? 0;
  const falta: string[] = [];

  if (m === null || m <= 0) {
    return {
      clave: 'sin_meta',
      frase: 'Todavía no hay meta capturada: no hay contra qué medir.',
      tono: 'muted',
      falta: ['meta del ejercicio'],
    };
  }
  if (r === null || opciones?.realDisponible === false) {
    if (sinMeta > 0) falta.push(`meta de ${sinMeta} período${sinMeta === 1 ? '' : 's'}`);
    falta.push('venta real del ejercicio');
    return {
      clave: 'sin_real',
      frase: 'Todavía no se puede decir si vamos a llegar: el ejercicio no tiene venta real cargada.',
      tono: 'muted',
      falta,
    };
  }

  const avance = r / m;
  /*
   * ⚠️ Se redondea ANTES de comparar contra la banda. Sin esto, `1000 → 1020` da un desvío de
   * `0.02000000000000002` y el borde documentado como inclusivo queda afuera: la frase saltaría de
   * «en línea» a «arriba del plan» por un error de representación, no por el dinero.
   */
  const desvio = Math.round((avance - 1) * 1e9) / 1e9;
  if (Math.abs(desvio) <= BANDA_EN_LINEA) {
    return { clave: 'en_linea', frase: `Vamos en línea con el plan (${pct(avance)} de la meta).`, tono: 'ok', falta: [] };
  }
  if (desvio > 0) {
    return { clave: 'adelante', frase: `Vamos ${pct(desvio)} arriba del plan.`, tono: 'ok', falta: [] };
  }
  return {
    clave: 'atras',
    frase: `Vamos ${pct(-desvio)} abajo del plan.`,
    // Hasta 10 % abajo vigila; más que eso exige acción. El corte es política y vive acá.
    tono: -desvio > 0.1 ? 'bad' : 'warn',
    falta: [],
  };
}

/**
 * `[PVI.19]` **Lo que cuesta no decidir hoy**, en una frase.
 *
 * Una cola sin consecuencia escrita no se atiende. `null` cuando no hay nada esperando — y eso NO
 * se pinta como «todo al día»: que no haya cola puede ser que nadie mandó nada, que es peor, y esa
 * distinción la hace quien tiene las dos cifras (`firmas-pendientes` publica `vacia_porque`).
 */
export function costoDeNoFirmar(items: number, monto: number | null): string | null {
  if (!items) return null;
  const m = num(monto);
  const dinero = m === null ? null : m.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  return dinero
    ? `${items} obligaciones por ${dinero} no pueden entrar al Calendario de pagos hasta que se autoricen.`
    : `${items} obligaciones no pueden entrar al Calendario de pagos hasta que se autoricen.`;
}

/**
 * `[PVI.20]` **Lo que el componente necesita de la concentración, y nada más.**
 *
 * ⚠️ **Es una proyección, no una segunda implementación**: acá no se calcula nada. Son los campos
 * de `ExpenseConcentration` (`libs/contracts/src/http/budget-expense-plan.contract.ts`, `[PU.VG.10]`)
 * que esta pantalla pinta, más los DOS que la auditoría exigió agregar y que todavía no están en
 * el contrato porque vive en una rama sin mergear.
 *
 * ⇒ El día que `feat/pu-selector` entre a `main`, **esto se borra** y el `input` se tipa con el
 * import real. Se deja declarado acá y no en un comentario suelto para que el reemplazo sea una
 * línea y no una arqueología.
 */
export interface FilaConcentracion {
  id: string | null;
  concepto: string;
  /** `null` = no medible. NUNCA 0 para decir «no sé». */
  monto: number | null;
  pct: number | null;
  acumulado: number | null;
}

export interface VistaConcentracion {
  total: number | null;
  filas: readonly FilaConcentracion[];
  /** Mínimo de partidas cuya suma ALCANZA el 80 %: la que CRUZA la línea, no la última de abajo. */
  partidas_80: number | null;
  pct_mayor: number | null;
  /** Cuántas partidas no traen monto legible. Se declaran; no entran al total. */
  sin_monto: number;
  /**
   * ⛔ **De qué es esta concentración.** Obligatorio: un bloque que muestra una parte y no dice de
   * qué, miente aunque cada cifra esté bien. Fue el hallazgo principal de la auditoría.
   */
  universo: string;
  /** `null` cuando el universo ES el total. Si es un recorte, de qué y qué parte. */
  parte_de: { de: string; pct: number } | null;
}

/** Las tres bandas en que se parte la lista. Juntas tienen que dar el 100 %: hay un test. */
export interface BandasConcentracion {
  /** Las que cruzan el 80 %, nombradas una por una. */
  cabeza: readonly FilaConcentracion[];
  /** ⛔ Las del medio. Existen y antes se CAÍAN de la pantalla: $45.5 M invisibles. */
  medio: readonly FilaConcentracion[];
  /** Las que aportan menos de `UMBRAL_COLA` cada una. */
  cola: readonly FilaConcentracion[];
}

/** Debajo de esto, una partida es cola: su desempeño no mueve el total. */
export const UMBRAL_COLA_PCT = 5;

/**
 * `[PVI.20]` **Parte la lista en tres bandas SIN perder ninguna fila.**
 *
 * ⛔ El defecto que esto cierra, medido por la auditoría: la pantalla pintaba las 4 de cabeza y
 * contaba las 2 de cola — y **dejaba caer 2 entidades por $45,514,824 en silencio**. Peor: la
 * frase «2 entidades aportan menos del 5 %» invitaba a leer todo lo que no estaba arriba como
 * chico, cuando las omitidas eran **2.3× más grandes** que las declaradas chicas.
 *
 * Las filas sin monto legible van a `medio` con su `null` a la vista: declararlas es el punto.
 */
export function bandas(v: VistaConcentracion | null | undefined): BandasConcentracion {
  const filas = v?.filas ?? [];
  const corte = v?.partidas_80 ?? 0;
  const cabeza = filas.slice(0, corte);
  const resto = filas.slice(corte);
  const cola = resto.filter((f) => f.pct !== null && f.pct < UMBRAL_COLA_PCT);
  const medio = resto.filter((f) => !(f.pct !== null && f.pct < UMBRAL_COLA_PCT));
  return { cabeza, medio, cola };
}

/** Suma de los montos legibles de una banda. `null` si ninguno lo es. */
export function sumaBanda(filas: readonly FilaConcentracion[]): number | null {
  const ms = filas.map((f) => f.monto).filter((m): m is number => m !== null);
  return ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

/**
 * `[PVI.20]` **La frase canónica de la concentración**, acordada entre los dos carriles para que
 * dos pantallas del mismo módulo no digan cosas distintas del mismo hecho.
 *
 * Forma: «N partidas cruzan el 80 % de <universo>». ⛔ Nunca «del plan» cuando el universo es un
 * recorte: ése fue el defecto — «4 de 8 cargan el 81.6 % del plan» era de Mostrador; del plan
 * cargan el 47.72 %.
 */
export function fraseConcentracion(v: VistaConcentracion | null | undefined): string | null {
  if (!v || v.partidas_80 === null || !v.filas.length) return null;
  const n = v.partidas_80;
  const de = v.universo;
  const mayor = v.pct_mayor === null ? null : `${Math.round(v.pct_mayor * 10) / 10} %`;
  const base = `${n} partida${n === 1 ? '' : 's'} cruza${n === 1 ? '' : 'n'} el 80 % de ${de}.`;
  return mayor ? `${base} La mayor sola es el ${mayor}.` : base;
}

/**
 * `[PVI.20]` **De qué es recorte este universo.** `null` cuando es el total.
 *
 * Sin esto, «el 81.6 %» y «el 58.5 %» se leen como el mismo denominador. Es la lección de la
 * auditoría convertida en una línea que la pantalla no puede omitir.
 */
export function leyendaUniverso(v: VistaConcentracion | null | undefined): string | null {
  if (!v) return null;
  if (!v.parte_de) return v.universo;
  const p = Math.round(v.parte_de.pct * 10) / 10;
  return `${v.universo} — ${p} % de ${v.parte_de.de}`;
}
