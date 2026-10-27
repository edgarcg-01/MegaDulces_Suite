/**
 * `[AB.40]` **Un solo motor de cantidad** para Autoabasto y Compras (D20, PM 2026-10-26).
 *
 * La regla firmada: se pide por demanda × días, y **ningún renglón deja más de 45 días de cobertura**.
 * Hasta hoy el tope vivía sólo en `/compras/pedido` (`[RA.45D]`, `apps/view/.../pedido-tope.ts`, en
 * cajas y del lado del navegador) y Autoabasto no tenía ninguno. Aquí vive UNA vez, en unidad BASE,
 * para que el servidor de Autoabasto la aplique hoy y Compras la adopte después (`[AB.40b]`).
 *
 * Lo que `[RA.45D]` midió y se conserva:
 *  · la fórmula demanda × días casi nunca pasa el tope por sí sola: lo pasa el REDONDEO (una caja
 *    cerrada de 180 piezas sobre una venta chica son meses de inventario);
 *  · al recortar se baja a la unidad mayor ENTERA que cabe, y si no cabe ni una, a la menor —
 *    rendirse directo a 0 dejaría sin surtir lo que sí podía pedirse en piezas;
 *  · lo que no se puede medir NO se topa (sin venta, o con la unidad dudosa): topar con un número
 *    inventado recorta compras reales sin que nadie lo vea (ADR-056).
 * Y lo que Autoabasto aporta: **lo que ya viene cuenta como existencia** para el tope (pedido abierto
 * a la matriz y embarcado sin recibir). Sin eso, el tope dejaría pedir otra vez lo que está en camino.
 */
import type { EscaleraUnidades, RedondeoPedido } from './autoabasto-pedido.contract';

/** El tope, en días de cobertura. La regla de negocio en una línea (Edgar, `[RA.45D]`, 2026-10-08). */
export const TOPE_COBERTURA_DIAS = 45;
/** Días por mes del convenio del comprador (su Excel): 30 d de venta ÷ 30.4 = venta diaria. */
export const DIAS_POR_MES = 30.4;

export type MotivoTope =
  /** Ya cabía: no se tocó. */
  | null
  /** Se recortó para no pasar el tope; sigue habiendo algo que pedir. */
  | 'recortado'
  /** Lo que hay (más lo que ya viene) ya pasa el tope: lo correcto es no pedir. */
  | 'ya_pasa_sin_pedir'
  /** Hay espacio, pero no alcanza ni para una unidad de la menor. */
  | 'no_cabe'
  /** No se pudo medir la cobertura (sin venta o unidad dudosa): NO se topó. */
  | 'sin_medir';

export interface EntradaTope {
  /** Venta de 30 días, en unidad base (sin temporada: los días se miden contra el ritmo de hoy). */
  venta30Base: number | null;
  /** Existencia, en unidad base. */
  existenciaBase: number;
  /** Lo que ya viene y se resta (pedido abierto + embarcado sin recibir), en unidad base. */
  vieneBase: number;
  /** La unidad de este almacén está contradicha: la existencia no es verdad y los días tampoco. */
  noConfiable?: boolean;
  topeDias?: number;
}

/** Días que aguanta lo que hay más lo que ya viene (más `pedidoBase`). `null` = no medible. */
export function diasDeCobertura(e: EntradaTope, pedidoBase = 0): number | null {
  const v = Number(e.venta30Base);
  if (e.noConfiable || !(v > 0)) return null;
  return ((Number(e.existenciaBase) || 0) + (Number(e.vieneBase) || 0) + (Number(pedidoBase) || 0)) * DIAS_POR_MES / v;
}

/** Cuánto cabe pedir, en unidad base, sin pasar el tope. `null` = no medible (no se topa). */
export function cabeBajoTope(e: EntradaTope): number | null {
  const v = Number(e.venta30Base);
  if (e.noConfiable || !(v > 0)) return null;
  const tope = e.topeDias ?? TOPE_COBERTURA_DIAS;
  return v * tope / DIAS_POR_MES - (Number(e.existenciaBase) || 0) - (Number(e.vieneBase) || 0);
}

const EPS = 1e-9;

export interface RedondeoTopado {
  redondeo: RedondeoPedido;
  motivo: MotivoTope;
  /** Lo que se pedía antes del tope, en base (para explicar el recorte). */
  antes_base: number;
  /** Días que deja lo pedido; `null` = no medible. */
  dias: number | null;
  /** Días que ya hay sin pedir nada; `null` = no medible. */
  dias_hoy: number | null;
}

/**
 * Topa un renglón YA redondeado (`redondearPedido`). Si pasa el tope, baja hacia abajo en la misma
 * escalera: unidades mayores enteras que caben; si no cabe ni una, la unidad menor entera; si
 * tampoco, nada. Nunca sube: el tope sólo recorta.
 */
export function toparRedondeo(r: RedondeoPedido, esc: EscaleraUnidades | null, e: EntradaTope): RedondeoTopado {
  const antes = Math.max(0, Number(r.cantidad_base) || 0);
  const diasHoy = diasDeCobertura(e);
  const cabe = cabeBajoTope(e);
  const sale = (redondeo: RedondeoPedido, motivo: MotivoTope): RedondeoTopado =>
    ({ redondeo, motivo, antes_base: antes, dias: diasDeCobertura(e, redondeo.cantidad_base), dias_hoy: diasHoy });

  if (cabe == null) return { redondeo: r, motivo: 'sin_medir', antes_base: antes, dias: null, dias_hoy: null };
  if (!(antes > 0) || antes <= cabe + EPS) return sale(r, null);

  const nada = (): RedondeoPedido => ({ ...r, regla: 'nada', cantidad: 0, cantidad_base: 0 });
  const tope = e.topeDias ?? TOPE_COBERTURA_DIAS;
  const sinNada = () => sale(nada(), diasHoy != null && diasHoy >= tope ? 'ya_pasa_sin_pedir' : 'no_cabe');
  if (!(cabe > 0)) return sinNada();

  // Sin escalera no hay unidades que respetar: se deja lo que cabe, con dos decimales (como la entrada).
  if (!esc || r.regla === 'sin_escalera') {
    const q = Math.floor(cabe * 100) / 100;
    return q > 0 ? sale({ ...r, cantidad: q, cantidad_base: q }, 'recortado') : sinNada();
  }

  const f2 = esc.f2 && esc.f2 > 1 ? esc.f2 : null;
  const f3 = esc.f3 && esc.f3 > 1 ? esc.f3 : null;
  const mayor = f3 ?? f2;
  // Una sola unidad (base o granel sin caja): unidades enteras que caben.
  if (!mayor) {
    const n = Math.floor(cabe + EPS);
    return n > 0 ? sale({ ...r, cantidad: n, cantidad_base: n, factor: 1 }, 'recortado') : sinNada();
  }
  const menor = f3 && f2 ? f2 : 1;
  const etiquetaMayor = f3 ? esc.u3_label : esc.u2_label;
  const etiquetaMenor = f3 && f2 ? esc.u2_label : esc.unit_base;
  const cajas = Math.floor(cabe / mayor + EPS);
  if (cajas >= 1) {
    return sale({ ...r, regla: 'cajas', clase: 'mayor', cantidad: cajas, unidad: etiquetaMayor, cantidad_base: cajas * mayor, factor: mayor }, 'recortado');
  }
  const n = Math.floor(cabe / menor + EPS);
  return n > 0
    ? sale({ ...r, regla: 'menor', clase: 'menor', cantidad: n, unidad: etiquetaMenor, cantidad_base: n * menor, factor: menor }, 'recortado')
    : sinNada();
}

// ── [AB.40c] Un solo costo ────────────────────────────────────────────────────────────────────

/** Más allá de esta razón entre los dos costos, ninguno se cree: el valor se declara sin medir. */
export const RAZON_COSTO_CONTRADICHO = 2;

/**
 * El costo por unidad BASE con que se valúa un renglón: el de la caja del plan (`caja_cost ÷ factor`),
 * que es el mismo que viaja a Compras en la requisición y el que usa `/compras/pedido`. Medido el
 * 2026-10-26 sobre 19,289 renglones con venta: el 80 % cuadra a ±3 % con el costo de existencia de
 * Kepler (`kdik.c16`), el 17 % difiere 3–18 % (dos costos válidos) y **106 difieren 2× o más**, por
 * dos defectos distintos — un `kdik.c16` roto ($0.0005 la pieza) o un `caja_cost` que en realidad es
 * por pieza (la familia 33xxx, caja de 100). Como ninguno de los dos es siempre el bueno, cuando se
 * contradicen así **no se elige**: `null`, y el renglón dice «sin medir» (ADR-056).
 *
 * @param cajaCost  costo de una caja del plan (`replenishment_plan.caja_cost`).
 * @param factor    unidades base por esa caja en el almacén.
 * @param costoErp  costo por unidad base de Kepler (testigo). `null` = sin testigo: se usa la caja.
 */
export function costoUnicoBase(cajaCost: number | null, factor: number, costoErp: number | null): number | null {
  const cc = Number(cajaCost);
  const f = Math.max(1, Number(factor) || 0);
  if (!(cc > 0)) return null;
  const porBase = cc / f;
  const testigo = Number(costoErp);
  if (testigo > 0) {
    const r = porBase / testigo;
    if (r > RAZON_COSTO_CONTRADICHO || r < 1 / RAZON_COSTO_CONTRADICHO) return null;
  }
  return porBase;
}

/** La frase del renglón: un recorte sin motivo a la vista se lee como error y se «corrige» a mano. */
export function textoTopeBase(
  t: Pick<RedondeoTopado, 'antes_base' | 'dias' | 'dias_hoy'> & { motivo: MotivoTope | 'unidad_dudosa' },
  unidadBase: string | null, topeDias = TOPE_COBERTURA_DIAS,
): string {
  const d = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('es-MX'));
  const u = unidadBase ?? 'unidades';
  switch (t.motivo) {
    case 'unidad_dudosa':
      return 'No se pide: la unidad de este producto en este almacén está en duda (la caja no cuadra con el costo), así que lo que «falta» tampoco es seguro. Se corrige la unidad y vuelve solo.';
    case 'recortado':
      return `Recortado por el tope de ${topeDias} días: lo que faltaba (${Math.round(t.antes_base).toLocaleString('es-MX')} ${u}) dejaba más de ${topeDias} días. Así queda en ${d(t.dias)}.`;
    case 'ya_pasa_sin_pedir':
      return `No se pide: con lo que hay y lo que ya viene son ${d(t.dias_hoy)} días, por encima del tope de ${topeDias}.`;
    case 'no_cabe':
      return `No se pide: con ${d(t.dias_hoy)} días entre lo que hay y lo que ya viene, ni una unidad más cabe bajo el tope de ${topeDias}.`;
    case 'sin_medir':
      return 'Sin tope: no hay venta con qué medir la cobertura, o la unidad de este almacén está en duda.';
    default:
      return t.dias == null ? '' : `Queda con ${d(t.dias)} días de cobertura.`;
  }
}
