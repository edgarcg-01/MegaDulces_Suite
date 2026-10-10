/**
 * `[PVI.19]` — **La superficie de DECIDIR: lo que se afirma, separado de lo que se dibuja.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * La pantalla de Ventas abre con una tabla de 9 renglones y 8 columnas, de las cuales 4 están
 * vacías. Eso está bien para quien ARMA el presupuesto. Para quien lo FIRMA es una herramienta
 * cruda donde debería haber una conclusión: es el antipatrón que `DESIGN.md §Q.1` (answer-first)
 * marca como falla de review — *«si lo primero que ve el usuario es una tabla en vez de la lectura
 * del periodo, falló»*.
 *
 * ⭐ **El hecho que la tabla esconde**, medido sobre el ejercicio real (2026-10-09, los 9 renglones
 * de Mostrador cuadran al centavo con su subtotal $353,538,587.63):
 *
 *     Morelia Abastos   $122,891,216.83   = 34.8 % de TODO el canal
 *     + PH + Canindo + 8 Esquinas         = 81.6 % entre CUATRO
 *     Yurécuaro + Zamora Centro           =  5.5 % entre dos
 *
 * Un tercio del canal vive en la fila 8 de una lista, con la misma altura de renglón y la misma
 * tipografía que una entidad veinte veces más chica. La concentración **es** el dato ejecutivo y
 * la tabla le da peso visual uniforme. Esto lo calcula y lo nombra.
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 *
 * ⛔ No contesta *«¿qué cambió desde que miré?»*. Esa pregunta necesita una foto anterior y **no
 * existe**: no hay snapshot de la meta por entidad. Se DECLARA como hueco con nombre en vez de
 * inventar un delta contra el arranque del año, que se leería como movimiento y no lo es
 * (ADR-056). El día que haya historia, entra acá y no en la pantalla.
 *
 * ⛔ No dibuja. Devuelve números y frases; el componente decide la forma. Por eso se puede probar.
 */

/** Un renglón de la tabla de ventas, tal como lo sirve `sales-comparison`. */
export interface FilaVenta {
  label: string;
  channel_label: string;
  entity_key: string | null;
  /** `true` en los subtotales por canal. ⛔ Ver `concentracion`: incluirlos duplica el total. */
  is_rollup: boolean;
  meta: number | null;
  real: number | null;
}

export interface EntidadConcentracion {
  label: string;
  channel_label: string;
  entity_key: string | null;
  meta: number;
  /** Su parte del total, 0..1. */
  share: number;
  /** Lo acumulado hasta este renglón inclusive, 0..1. */
  acumulado: number;
}

export interface Concentracion {
  /** Entidades HOJA ordenadas de mayor a menor. Nunca subtotales. */
  entidades: EntidadConcentracion[];
  total: number;
  /** Cuántas entidades hacen falta para cubrir `UMBRAL_CONCENTRACION` del total. */
  cuantas: number;
  de_cuantas: number;
  mayor: EntidadConcentracion | null;
  /** Las que juntas no llegan a `UMBRAL_COLA` del total. */
  cola: EntidadConcentracion[];
  /** ⛔ `null` cuando no hay con qué afirmar nada. Nunca una frase sobre un conjunto vacío. */
  lectura: string | null;
}

/**
 * Dónde se corta «las pocas que cargan el plan».
 *
 * 0.80 es la convención de Pareto y se deja explícita y en un solo lugar para que mover el corte
 * sea una decisión visible, no un número suelto adentro de un `filter`.
 */
export const UMBRAL_CONCENTRACION = 0.8;
/** Debajo de esto, una entidad es cola: su desempeño no mueve el total. */
export const UMBRAL_COLA = 0.05;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const pct = (x: number): string => `${Math.round(x * 1000) / 10} %`;

/**
 * `[PVI.19]` **Quién carga el plan.**
 *
 * ⛔ **Los `is_rollup` se excluyen, y es la primera trampa del renglón.** La tabla trae
 * «Subtotal Mostrador» como una fila más; sumarla con sus ocho hijas **duplica el canal** y manda
 * todos los porcentajes a la mitad. El defecto no se vería: los números seguirían ordenados y
 * sumando a algo.
 *
 * ⛔ Una `meta` ausente se SALTA, no entra como 0. Una entidad sin meta capturada no es una
 * entidad que planea vender cero, y meterla al denominador diluye a todas las demás.
 */
export function concentracion(filas: readonly FilaVenta[] | null | undefined): Concentracion {
  const hojas = (filas ?? [])
    .filter((f) => f && !f.is_rollup)
    .map((f) => ({ f, meta: num(f.meta) }))
    .filter((x): x is { f: FilaVenta; meta: number } => x.meta !== null && x.meta > 0)
    .sort((a, b) => b.meta - a.meta);

  const total = hojas.reduce((s, x) => s + x.meta, 0);
  if (!hojas.length || total <= 0) {
    return { entidades: [], total: 0, cuantas: 0, de_cuantas: 0, mayor: null, cola: [], lectura: null };
  }

  let acum = 0;
  const entidades: EntidadConcentracion[] = hojas.map(({ f, meta }) => {
    acum += meta;
    return {
      label: f.label,
      channel_label: f.channel_label,
      entity_key: f.entity_key,
      meta,
      share: meta / total,
      acumulado: acum / total,
    };
  });

  // La primera que ALCANZA el umbral ya está adentro: con 34.8 % + 16.4 % + ... el corte cae
  // dentro de una entidad, y redondear hacia abajo diría «tres» de un 81.6 % que necesita cuatro.
  const idx = entidades.findIndex((e) => e.acumulado >= UMBRAL_CONCENTRACION);
  const cuantas = idx === -1 ? entidades.length : idx + 1;
  const cola = entidades.filter((e) => e.share < UMBRAL_COLA);
  const mayor = entidades[0];

  const lectura =
    `${mayor.label} es el ${pct(mayor.share)} de ${mayor.channel_label}. ` +
    `${cuantas} de ${entidades.length} entidades cargan el ${pct(entidades[cuantas - 1].acumulado)} del plan.`;

  return { entidades, total, cuantas, de_cuantas: entidades.length, mayor, cola, lectura };
}

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

/**
 * `[PVI.19]` **¿Vamos a llegar?** — la única pregunta que una pantalla de decidir abre contestando.
 *
 * ⛔ Cuando no se puede contestar, **lo dice y dice qué falta**. Medido hoy: `real_available` es
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
   * «en línea» a «arriba del plan» por un error de representación, no por el dinero. Nueve
   * decimales son ~una millonésima de punto porcentual: muy por debajo de cualquier peso real.
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
