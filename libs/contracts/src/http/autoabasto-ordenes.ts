/**
 * `[AB.NI.2]` **Cómo se parte un pedido en las órdenes en que se va a armar.**
 *
 * Primitivo PURO (ADR-056: una sola implementación, en `libs/`, que usan el servidor y la
 * pantalla). No toca base, no toca reloj, no toca `Intl` con locale variable.
 *
 * El orden lo fijó Edgar el 2026-11-22, textual: «primero agrupa por unidad (hoy ya agrupado),
 * luego agrupa por línea, y finalmente ordena los renglones por alfabético», y «así sólo agrupa
 * las líneas hasta que tope los 70 renglones».
 *
 *   1. **Unidad** — una orden no mezcla unidades, porque el armado se hace por unidad… salvo la
 *      **cola**, ver `MINIMO_RENGLONES_UNIDAD`.
 *   2. **Línea** (fabricante) — alfabética dentro de la orden.
 *   3. **Renglón** — alfabético por nombre dentro de la línea.
 *   4. **Corte** — a `TOPE_RENGLONES_ORDEN` renglones, **siempre al terminar una línea**: una
 *      línea nunca se parte en dos órdenes, aunque ella sola pase del tope.
 *
 * ⛔ Lo que NO puede salir se separa ANTES de armar: un renglón sin unidad en la ficha de Kepler
 * tira el documento entero en el ERP. Medido el 2026-11-23 en `RQ-2026-03239`: 21 de 294.
 * Devolverlos aparte es lo que permite que los otros 273 sí salgan.
 *
 * Medido el 2026-11-23 contra prod (sólo lectura), `RQ-2026-03239` (Morelia Madero → Morelia
 * Abastos, 294 renglones, $158,502.59): 102 líneas, la más grande de 12 renglones. O sea que el
 * tope de 70 **casi nunca corta una familia**: apila treinta o cuarenta líneas chicas hasta topar.
 * Por eso la pantalla dice «una orden no mezcla unidades» y NO promete «pedidos por familia».
 */

/**
 * El tope de renglones por orden. Lo pidió Edgar el 2026-11-22 para «controlar el tamaño de los
 * pedidos». Es un tope, no una meta: una orden puede cerrar con menos si la línea siguiente no cabe.
 */
export const TOPE_RENGLONES_ORDEN = 70;

/**
 * ⭐ **El mínimo para que una unidad merezca documento propio.** Debajo de esto la unidad es
 * **cola**, y las colas se juntan en una sola orden (`UNIDAD_MIXTA`).
 *
 * **D1, decidida por Edgar el 2026-11-24** («sí, júntalos»), después de medir que su pedido real
 * producía **tres documentos para once renglones** (KG 8, BTO 2, CUB 1).
 *
 * El número **no se eligió a ojo**. Medido el 2026-11-24 en prod, sólo lectura, sobre las **26
 * requisiciones de sucursal de 30+ renglones** de los últimos 60 días (**86 bloques** unidad ×
 * documento):
 *
 *   · renglones por bloque: p10 = 1 · p25 = 2 · **p50 = 11** · p75 = 25 · p90 = 36 · máx 166
 *     → la mitad de los bloques está en 11 o menos;
 *   · con el umbral en 12, la cola son el **52.3 % de los documentos** y sólo el **10.3 % de los
 *     renglones**: más de la mitad del papeleo por una décima parte de la mercancía;
 *   · ahorra **20 de 86 órdenes** (23 %) sin tocar un solo renglón de lo que se pide.
 *
 * ⛔ **Un umbral más bajo no cumplía lo decidido:** con 5 u 8, el KG de Morelia Madero (8
 * renglones) se habría quedado con documento propio, que es justo lo que Edgar mandó evitar.
 *
 * ⚠️ Sólo PAQ y CJA aparecen en los 26 documentos; KG en 16, PZA en 12, y BTO, CUB y un rótulo
 * basura de la ficha (`500`) en uno cada uno. Por eso la regla es **por tamaño medido, no por una
 * lista de unidades principales**: una lista se queda vieja, y una sucursal donde KG pese se
 * quedaría sin su documento.
 */
export const MINIMO_RENGLONES_UNIDAD = 12;

/** Rótulo de la orden que junta las colas. No es una unidad de Kepler: es un documento mixto. */
export const UNIDAD_MIXTA = 'otras unidades';

/** Rótulo de la unidad cuando la ficha de Kepler no la trae. No se inventa una. */
export const SIN_UNIDAD = '(sin unidad)';

/** Lo mínimo que `armarOrdenes` necesita de un renglón. Deliberadamente chico: cualquier
 *  renglón de pedido (plan vivo o requisición guardada) lo cumple. */
export interface RenglonArmable {
  /** Identificador estable del renglón. Se usa para desempatar y para que el orden sea total. */
  product_id: string;
  /** Nombre del producto, tal como lo trae Kepler. Es la tercera llave de orden. */
  nombre: string;
  /**
   * La línea (fabricante) del producto, de `analytics.v_erp_product_lines`. `null` cuando el
   * catálogo no la resuelve: **no se rellena con un default**, se agrupa bajo `SIN_LINEA`.
   */
  linea: string | null;
  /** La unidad en que SALE el renglón (`a_pedir.unidad`). `null` = Kepler no la rotula. */
  unidad: string | null;
  /** Costo del renglón. `null` = no se puede valuar; la orden lo declara, no lo suma como 0. */
  valor?: number | null;
}

/** Rótulo del grupo cuando el producto no tiene línea en el catálogo del ERP. */
export const SIN_LINEA = '(sin línea)';

/** Una línea (fabricante) dentro de una orden, con sus renglones ya alfabéticos. */
export interface BandaLinea<T extends RenglonArmable> {
  linea: string;
  /**
   * La unidad REAL de los renglones de esta banda. En una orden normal es la de la orden; en la
   * orden mixta (`UNIDAD_MIXTA`) es lo que distingue un grupo de otro, y la pantalla la muestra.
   */
  unidad: string;
  renglones: T[];
}

/** Una orden: un documento que se arma completo. */
export interface OrdenArmada<T extends RenglonArmable> {
  /** 1-based, en el orden en que se presentan y se van a armar. */
  numero: number;
  /** Rótulo de la orden: la unidad, o `UNIDAD_MIXTA` cuando junta las colas. */
  unidad: string;
  /** Las unidades REALES que lleva. Una sola en las órdenes normales; varias en la mixta. */
  unidades: string[];
  /** `true` sólo en la orden que junta las colas. La pantalla dice cuáles son. */
  mixta: boolean;
  bandas: BandaLinea<T>[];
  renglones: number;
  /** Suma de `valor`. `null` si NINGÚN renglón se pudo valuar. */
  valor: number | null;
  /** Cuántos renglones de la orden no se pudieron valuar. `0` = la suma está completa. */
  sin_valuar: number;
}

/** Un renglón que no puede salir, con el motivo en palabras. */
export interface RenglonFuera<T extends RenglonArmable> {
  renglon: T;
  motivo: 'sin_unidad';
}

/** Resumen por unidad REAL, aunque varias compartan documento. */
export interface ResumenUnidad {
  unidad: string;
  renglones: number;
  lineas: number;
  /** Órdenes propias. `0` cuando la unidad viaja en la orden mixta. */
  ordenes: number;
  /** `true` si no alcanzó `MINIMO_RENGLONES_UNIDAD` y viaja con las demás colas. */
  mixta: boolean;
  valor: number | null;
}

export interface PedidoArmado<T extends RenglonArmable> {
  ordenes: OrdenArmada<T>[];
  /** Lo que no puede salir. Se separa antes de armar: un renglón así tira el documento en Kepler. */
  fuera: RenglonFuera<T>[];
  /** Renglones que SÍ pueden salir. Es la cuenta que debe llevar el botón primario. */
  renglones_que_salen: number;
  /** Resumen por unidad real, en el mismo orden en que se presentan las órdenes. */
  por_unidad: ResumenUnidad[];
}

export interface OpcionesArmado {
  /** Renglones por orden. Default `TOPE_RENGLONES_ORDEN`. Un tope ≤ 0 se trata como «sin tope». */
  tope?: number;
  /**
   * Renglones mínimos para que una unidad tenga documento propio. Default
   * `MINIMO_RENGLONES_UNIDAD`. Un mínimo ≤ 1 apaga el junte: cada unidad va por su lado.
   */
  minimoPorUnidad?: number;
}

/**
 * Comparación de texto **estable y sin dependencia del locale del entorno**.
 *
 * ⚠️ No se usa `localeCompare` sin locale fijo: el servidor (Node con ICU completo) y el navegador
 * pueden ordenar distinto, y entonces la orden 1 de la pantalla no es la orden 1 del documento.
 * Se normaliza el acento y se compara en mayúsculas; el `||` final hace el orden TOTAL.
 */
function comparaTexto(a: string, b: string): number {
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const x = n(a);
  const y = n(b);
  return x < y ? -1 : x > y ? 1 : (a < b ? -1 : a > b ? 1 : 0);
}

/** Suma de valores que distingue «cero» de «no se pudo valuar». */
function sumaValor<T extends RenglonArmable>(renglones: T[]): { valor: number | null; sin_valuar: number } {
  let total = 0;
  let conValor = 0;
  let sinValuar = 0;
  for (const r of renglones) {
    const v = r.valor;
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; conValor++; }
    else sinValuar++;
  }
  return { valor: conValor ? Math.round(total * 100) / 100 : null, sin_valuar: sinValuar };
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Cuántos renglones hay en un mapa de línea → renglones. */
function cuantos<T>(lineas: Map<string, T[]> | undefined): number {
  let n = 0;
  for (const v of (lineas?.values() ?? [])) n += v.length;
  return n;
}

/**
 * Arma el pedido en las órdenes en que se va a surtir.
 *
 * @param renglones todos los renglones del pedido a UN destino. El llamador ya filtró el destino.
 * @param opciones  `tope` de renglones por orden y `minimoPorUnidad` para la cola.
 */
export function armarOrdenes<T extends RenglonArmable>(
  renglones: readonly T[],
  opciones: OpcionesArmado = {},
): PedidoArmado<T> {
  const topeCrudo = opciones.tope ?? TOPE_RENGLONES_ORDEN;
  const tope = Number.isFinite(topeCrudo) && topeCrudo > 0 ? Math.floor(topeCrudo) : Infinity;
  const minCrudo = opciones.minimoPorUnidad ?? MINIMO_RENGLONES_UNIDAD;
  const minimo = Number.isFinite(minCrudo) && minCrudo > 1 ? Math.floor(minCrudo) : 0;

  const fuera: RenglonFuera<T>[] = [];
  /** unidad → línea → renglones */
  const porUnidad = new Map<string, Map<string, T[]>>();

  for (const r of renglones ?? []) {
    if (!r) continue;
    // ⛔ Sin unidad no se arma: el ERP rechaza el documento entero, no sólo el renglón.
    const u = typeof r.unidad === 'string' ? r.unidad.trim() : '';
    if (!u) { fuera.push({ renglon: r, motivo: 'sin_unidad' }); continue; }

    const l = typeof r.linea === 'string' && r.linea.trim() ? r.linea.trim() : SIN_LINEA;
    let lineas = porUnidad.get(u);
    if (!lineas) { lineas = new Map(); porUnidad.set(u, lineas); }
    const lista = lineas.get(l);
    if (lista) lista.push(r); else lineas.set(l, [r]);
  }

  // Las unidades, por peso: la que más renglones tiene se arma primero. Empate → alfabético, que
  // hace el orden TOTAL y la salida reproducible.
  const unidades = [...porUnidad.keys()].sort((a, b) =>
    cuantos(porUnidad.get(b)) - cuantos(porUnidad.get(a)) || comparaTexto(a, b));

  // ⭐ D1 (Edgar, 2026-11-24): las unidades que no llegan al mínimo no merecen documento propio y
  // se juntan en UNA orden. ⛔ Con una sola cola NO se junta nada: renombrarla «otras unidades»
  // escondería su unidad real sin ahorrar un solo documento.
  const colas = minimo > 0 ? unidades.filter((u) => cuantos(porUnidad.get(u)) < minimo) : [];
  const seJuntan = colas.length > 1 ? new Set(colas) : new Set<string>();
  const propias = unidades.filter((u) => !seJuntan.has(u));
  const cola = colas.length > 1 ? colas : [];

  /** Las bandas de una unidad, ya ordenadas por línea y por nombre. */
  const bandasDe = (unidad: string): BandaLinea<T>[] =>
    [...(porUnidad.get(unidad) as Map<string, T[]>).entries()]
      .map(([linea, rs]) => ({
        linea,
        unidad,
        renglones: [...rs].sort((a, b) => comparaTexto(a.nombre ?? '', b.nombre ?? '')
          || comparaTexto(a.product_id ?? '', b.product_id ?? '')),
      }))
      .sort((a, b) => comparaTexto(a.linea, b.linea));

  /** Parte una lista de bandas en órdenes, cortando siempre al TERMINAR una banda. */
  const partir = (bandas: BandaLinea<T>[]): BandaLinea<T>[][] => {
    const out: BandaLinea<T>[][] = [];
    let actual: BandaLinea<T>[] = [];
    let n = 0;
    for (const banda of bandas) {
      // Una línea que ella sola pasa del tope NO se parte: se va sola en su orden.
      if (n > 0 && n + banda.renglones.length > tope) { out.push(actual); actual = []; n = 0; }
      actual.push(banda);
      n += banda.renglones.length;
    }
    if (actual.length) out.push(actual);
    return out;
  };

  const ordenes: OrdenArmada<T>[] = [];
  const resumen = new Map<string, ResumenUnidad>();

  const empujar = (bandasOrden: BandaLinea<T>[], rotulo: string, mixta: boolean): void => {
    const planos = bandasOrden.flatMap((b) => b.renglones);
    const { valor, sin_valuar } = sumaValor(planos);
    ordenes.push({
      numero: ordenes.length + 1,
      unidad: rotulo,
      unidades: [...new Set(bandasOrden.map((b) => b.unidad))],
      mixta,
      bandas: bandasOrden,
      renglones: planos.length,
      valor,
      sin_valuar,
    });
  };

  const anotar = (unidad: string, bandas: BandaLinea<T>[], ordenesPropias: number, mixta: boolean): void => {
    const { valor } = sumaValor(bandas.flatMap((b) => b.renglones));
    resumen.set(unidad, {
      unidad,
      renglones: cuantos(porUnidad.get(unidad)),
      lineas: bandas.length,
      ordenes: ordenesPropias,
      mixta,
      valor: valor == null ? null : r2(valor),
    });
  };

  // ── Las unidades con documento propio, por peso ──
  for (const unidad of propias) {
    const bandas = bandasDe(unidad);
    const trozos = partir(bandas);
    for (const t of trozos) empujar(t, unidad, false);
    anotar(unidad, bandas, trozos.length, false);
  }

  // ── La cola, al FINAL y en un solo documento: es lo último que se arma ──
  if (cola.length > 1) {
    // Dentro de la mixta se conserva la jerarquía: unidad → línea → alfabético. Así la mercancía
    // de la misma unidad sigue junta aunque el documento sea mixto.
    const bandasMixta = cola.flatMap((u) => bandasDe(u))
      .sort((a, b) => comparaTexto(a.unidad, b.unidad) || comparaTexto(a.linea, b.linea));
    for (const t of partir(bandasMixta)) empujar(t, UNIDAD_MIXTA, true);
    for (const unidad of cola) anotar(unidad, bandasDe(unidad), 0, true);
  }

  return {
    ordenes,
    fuera,
    renglones_que_salen: ordenes.reduce((n, o) => n + o.renglones, 0),
    // El resumen sigue el orden de presentación: primero las propias por peso, la cola al final.
    por_unidad: [...propias, ...cola].map((u) => resumen.get(u) as ResumenUnidad),
  };
}

/** Rótulo corto del motivo por el que un renglón no puede salir. Para la pantalla. */
export const MOTIVO_FUERA_LABEL: Record<RenglonFuera<RenglonArmable>['motivo'], string> = {
  sin_unidad: 'Sin unidad en la ficha de Kepler',
};
