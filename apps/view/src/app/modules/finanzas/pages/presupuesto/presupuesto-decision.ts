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
 * `[PVI.21]` **La proyección de `ExpenseConcentration`, alineada al contrato del carril de Gastos.**
 *
 * ⚠️ **No calcula nada.** Son los campos de `ExpenseConcentration`
 * (`libs/contracts/src/http/budget-expense-plan.contract.ts`, `[PU.VG.11]`) que esta pantalla
 * pinta, con **sus nombres exactos**, para que el día que `feat/pu-selector` entre a `main` el
 * reemplazo sea cambiar el `import` y borrar este bloque — no una traducción de campos.
 *
 * ── ⛔ Qué se borró acá, y por qué ──────────────────────────────────────────────────────────
 *
 * Vivían `fraseConcentracion()` y mi propio `universo: string` + `parte_de`. Los dos quedaron
 * obsoletos el mismo día: `[PU.VG.11]` ya publica **`ExpenseUniverse` como unión discriminada**
 * —no se puede publicar un bloque sin declarar si el conjunto está completo o es un recorte— y
 * **la frase la emite el SERVIDOR** (`ExpenseConcentrationPhrase`), justamente para que las dos
 * mitades del módulo no digan la misma idea con dos gramáticas.
 *
 * ⇒ Mi constructor de frases habría sido el séptimo artefacto duplicado del día. Se va.
 *
 * ⭐ Y su `menores` —la frase inversa, dónde NO mirar— **salió de esta pantalla**: ellos lo citan
 * como tomado de acá. O sea que el intercambio fue en los dos sentidos.
 */

/** Universo completo: el conjunto ES el total. */
export interface UniversoCompleto { nombre: string; completo: true }

/** Universo recortado: hay que decir de qué es recorte y qué fracción es. */
export interface UniversoRecorte {
  nombre: string;
  completo: false;
  de: string;
  /** `null` = no se pudo medir. NUNCA 0. */
  pct: number | null;
}

export type Universo = UniversoCompleto | UniversoRecorte;

export interface FilaConcentracion {
  id: string | null;
  concepto: string;
  /** `null` = no medible. NUNCA 0 para decir «no sé». */
  monto: number | null;
  pct: number | null;
  acumulado: number | null;
}

/** La frase que emite el servidor. `es_ausencia` separa «no hay» de «no se pudo medir». */
export interface FraseConcentracion {
  titular: string;
  detalle: string | null;
  /** Dónde NO mirar. `null` cuando no hay cola que declarar. */
  inversa: string | null;
  es_ausencia: boolean;
}

/** Las que no mueven la aguja, contadas por el servidor. */
export interface MenoresConcentracion {
  filas: number;
  monto: number | null;
  pct: number | null;
}

export interface VistaConcentracion {
  universo: Universo;
  frase: FraseConcentracion;
  total: number | null;
  filas: readonly FilaConcentracion[];
  /** Mínimo de filas cuya suma ALCANZA `umbral_pct`: la que CRUZA la línea. */
  partidas_80: number | null;
  /** El corte que define `partidas_80`. Viaja para que nadie lo asuma. */
  umbral_pct: number;
  pct_mayor: number | null;
  menores: MenoresConcentracion;
  /** Debajo de esto una fila es cola. ⛔ Viaja: si la pantalla lo clavara, su cola y la del
   *  servidor podrían discrepar y las dos se verían bien. */
  umbral_menor_pct: number;
  /** Cuántas filas no traen monto legible. Se declaran; no entran al total. */
  sin_monto: number;
}

/** Las tres bandas en que se parte la lista. Juntas tienen que dar el total: hay un test. */
export interface BandasConcentracion {
  /** Las que cruzan el umbral, nombradas una por una. */
  cabeza: readonly FilaConcentracion[];
  /** ⛔ Las del medio. Existen y antes se CAÍAN de la pantalla: $45.5 M invisibles. */
  medio: readonly FilaConcentracion[];
  /** Las que aportan menos de `umbral_menor_pct` cada una. */
  cola: readonly FilaConcentracion[];
}

/**
 * `[PVI.20]` **Parte la lista en tres bandas SIN perder ninguna fila.**
 *
 * ⛔ El defecto que esto cierra, encontrado por la auditoría del carril de Gastos: la pantalla
 * pintaba las de cabeza y contaba las de cola, y **dejaba caer 2 entidades por $45,514,824 en
 * silencio**. Peor: la frase «2 entidades aportan menos del 5 %» invitaba a leer todo lo que no
 * estaba arriba como chico, cuando las omitidas eran **2.3× más grandes** que las declaradas
 * chicas.
 *
 * ⚠️ `[PVI.21]` El umbral de cola sale del DATO (`umbral_menor_pct`), no de una constante local:
 * si la pantalla lo clavara en 5 y el servidor cambiara el suyo, su `menores` y esta `cola`
 * dirían números distintos del mismo hecho **y las dos se verían bien**.
 *
 * Las filas sin monto legible van a `medio` con su `null` a la vista: declararlas es el punto.
 */
export function bandas(v: VistaConcentracion | null | undefined): BandasConcentracion {
  const filas = v?.filas ?? [];
  const corte = v?.partidas_80 ?? 0;
  const umbral = v?.umbral_menor_pct ?? 0;
  const cabeza = filas.slice(0, corte);
  const resto = filas.slice(corte);
  const esCola = (f: FilaConcentracion) => f.pct !== null && f.pct < umbral;
  return { cabeza, medio: resto.filter((f) => !esCola(f)), cola: resto.filter(esCola) };
}

/** Suma de los montos legibles de una banda. `null` si ninguno lo es. */
export function sumaBanda(filas: readonly FilaConcentracion[]): number | null {
  const ms = filas.map((f) => f.monto).filter((m): m is number => m !== null);
  return ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) * 100) / 100 : null;
}

/**
 * `[PVI.21]` **De qué es recorte este universo**, en una línea.
 *
 * ⛔ Es **formato**, no gramática: la frase del bloque la emite el servidor. Esto sólo rotula el
 * universo que el contrato ya declaró — y por eso no puede inventar uno: con la unión
 * discriminada, un recorte sin `de` no compila.
 */
export function leyendaUniverso(v: VistaConcentracion | null | undefined): string | null {
  const u = v?.universo;
  if (!u) return null;
  if (u.completo) return u.nombre;
  const p = u.pct === null ? null : Math.round(u.pct * 10) / 10;
  return p === null ? `${u.nombre} — parte de ${u.de}` : `${u.nombre} — ${p} % de ${u.de}`;
}
