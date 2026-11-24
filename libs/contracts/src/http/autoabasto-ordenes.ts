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
 *   1. **Unidad** — una orden NO mezcla unidades, porque el armado se hace por unidad.
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
  renglones: T[];
}

/** Una orden: un documento que se arma completo, en UNA unidad. */
export interface OrdenArmada<T extends RenglonArmable> {
  /** 1-based, en el orden en que se presentan y se van a armar. */
  numero: number;
  /** La unidad de la orden. Todas sus líneas y renglones van en ella. */
  unidad: string;
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

export interface PedidoArmado<T extends RenglonArmable> {
  ordenes: OrdenArmada<T>[];
  /** Lo que no puede salir. Se separa antes de armar: un renglón así tira el documento en Kepler. */
  fuera: RenglonFuera<T>[];
  /** Renglones que SÍ pueden salir. Es la cuenta que debe llevar el botón primario. */
  renglones_que_salen: number;
  /** Resumen por unidad, en el mismo orden en que se presentan las órdenes. */
  por_unidad: { unidad: string; renglones: number; lineas: number; ordenes: number; valor: number | null }[];
}

export interface OpcionesArmado {
  /** Renglones por orden. Default `TOPE_RENGLONES_ORDEN`. Un tope ≤ 0 se trata como «sin tope». */
  tope?: number;
}

/**
 * Comparación de texto **estable y sin dependencia de locale del entorno**.
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

/**
 * Arma el pedido en las órdenes en que se va a surtir.
 *
 * @param renglones todos los renglones del pedido a UN destino. El llamador ya filtró el destino.
 * @param opciones  `tope` de renglones por orden.
 */
export function armarOrdenes<T extends RenglonArmable>(
  renglones: readonly T[],
  opciones: OpcionesArmado = {},
): PedidoArmado<T> {
  const topeCrudo = opciones.tope ?? TOPE_RENGLONES_ORDEN;
  const tope = Number.isFinite(topeCrudo) && topeCrudo > 0 ? Math.floor(topeCrudo) : Infinity;

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
  const unidades = [...porUnidad.keys()].sort((a, b) => {
    const ca = [...(porUnidad.get(a) as Map<string, T[]>).values()].reduce((n, v) => n + v.length, 0);
    const cb = [...(porUnidad.get(b) as Map<string, T[]>).values()].reduce((n, v) => n + v.length, 0);
    return cb - ca || comparaTexto(a, b);
  });

  const ordenes: OrdenArmada<T>[] = [];
  const porUnidadResumen: PedidoArmado<T>['por_unidad'] = [];

  for (const unidad of unidades) {
    const lineasMapa = porUnidad.get(unidad) as Map<string, T[]>;
    const bandas: BandaLinea<T>[] = [...lineasMapa.entries()]
      .map(([linea, rs]) => ({
        linea,
        renglones: [...rs].sort((a, b) => comparaTexto(a.nombre ?? '', b.nombre ?? '')
          || comparaTexto(a.product_id ?? '', b.product_id ?? '')),
      }))
      .sort((a, b) => comparaTexto(a.linea, b.linea));

    const ordenesDeEstaUnidad: BandaLinea<T>[][] = [];
    let actual: BandaLinea<T>[] = [];
    let cuenta = 0;
    for (const banda of bandas) {
      // El corte es al TERMINAR una línea: si la línea no cabe y ya hay algo, se cierra la orden.
      // Una línea que ella sola pasa del tope NO se parte — se va sola en su orden.
      if (cuenta > 0 && cuenta + banda.renglones.length > tope) {
        ordenesDeEstaUnidad.push(actual);
        actual = [];
        cuenta = 0;
      }
      actual.push(banda);
      cuenta += banda.renglones.length;
    }
    if (actual.length) ordenesDeEstaUnidad.push(actual);

    let renglonesUnidad = 0;
    let valorUnidad: number | null = null;
    for (const bandasOrden of ordenesDeEstaUnidad) {
      const planos = bandasOrden.flatMap((b) => b.renglones);
      const { valor, sin_valuar } = sumaValor(planos);
      ordenes.push({
        numero: ordenes.length + 1,
        unidad,
        bandas: bandasOrden,
        renglones: planos.length,
        valor,
        sin_valuar,
      });
      renglonesUnidad += planos.length;
      if (valor != null) valorUnidad = (valorUnidad ?? 0) + valor;
    }

    porUnidadResumen.push({
      unidad,
      renglones: renglonesUnidad,
      lineas: bandas.length,
      ordenes: ordenesDeEstaUnidad.length,
      valor: valorUnidad == null ? null : Math.round(valorUnidad * 100) / 100,
    });
  }

  return {
    ordenes,
    fuera,
    renglones_que_salen: ordenes.reduce((n, o) => n + o.renglones, 0),
    por_unidad: porUnidadResumen,
  };
}

/** Rótulo corto del motivo por el que un renglón no puede salir. Para la pantalla. */
export const MOTIVO_FUERA_LABEL: Record<RenglonFuera<RenglonArmable>['motivo'], string> = {
  sin_unidad: 'Sin unidad en la ficha de Kepler',
};
