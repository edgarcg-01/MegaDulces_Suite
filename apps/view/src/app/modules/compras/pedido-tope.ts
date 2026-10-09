import { diasInventario, roundSeed, SeedRedondeado } from './pedido-redondeo';

/**
 * `[RA.45D]` — **No se pide un producto que quede con más de 45 días de cobertura.**
 *
 * Regla de Edgar (2026-10-08, punto 1 de tres): *"no podemos pedir un producto con mas de 45 dias
 * de cobertura"*.
 *
 * ---
 *
 * ## Lo que se midió antes de escribir esto (prod, 2026-10-08)
 *
 * ⭐ **La fórmula del motor NO era el problema.** El sugerido es
 * `demanda × cobertura − existencia − tránsito`, así que por construcción nunca deja más días que
 * la cobertura que se le pidió: con `cov = 30` salieron **0 casos** por encima.
 *
 * ⛔ **Lo rompe el redondeo a caja cerrada.** Un sugerido de 0.6 cajas se redondea a 1 caja, y si
 * esa caja trae 20 piezas sobre una venta de 4 al mes, la sucursal queda con medio año de
 * inventario. Medido sobre los 7,881 renglones con sugerido:
 *
 * | | renglones | % | pesos |
 * |---|---:|---:|---:|
 * | quedan arriba de 45 d después de redondear | **3,301** | 41.9% | $2,900,000 |
 * | …de ésos, donde **UNA sola caja ya pasa** 45 d | **2,643** | 33.5% | $2,270,000 |
 *
 * ⚠️ En esos 2,643 el tope no significa "pedí menos": significa **no comprar**, o comprar en
 * piezas sueltas. Por eso esta función **cae a piezas** antes de rendirse — el proveedor ya acepta
 * piezas (la pantalla las propone desde `[RA-PRO.51]`), así que rendirse directo a 0 habría
 * dejado sin surtir a sucursales que sí podían pedir 3 piezas.
 *
 * ⛔ **Y hay un tercer caso, el más grande de todos**, que esta función NO puede arreglar:
 * **8,023 de 15,927 pares SKU×almacén (50.4%) ya pasan los 45 días SIN pedir nada** —
 * **$36,290,904** de inventario. Ahí el tope sólo puede decir la verdad: el sugerido es 0 y el
 * motivo es que ya sobra. Comprar menos no baja ese inventario; eso es punto 2.
 *
 * ⚠️ **133 de 737 canales de compra (18%) tienen cadencia + lead mayor a 45 días** (el peor,
 * 146.5 d). Para ésos el tope y la cadencia se contradicen de frente: si al proveedor se le compra
 * cada 90 días, 45 días de cobertura garantizan quedarse sin producto 45 días. Esta función los
 * topa igual —la regla es la regla— pero lo **declara** con motivo propio, porque el arreglo de
 * fondo es la cadencia, no el pedido.
 *
 * ---
 *
 * ## Lo que esta función NO hace
 *
 * ⛔ **No topa lo que no puede medir.** Sin venta no hay días de cobertura contra qué comparar
 * (dividir por cero daría infinito, y "infinitos días" se leería como "recortá todo"). Lo mismo si
 * el peldaño de unidad de esa sucursal está contradicho (`[U.2]`): su existencia en cajas no es
 * verdad, así que los días tampoco lo serían. En los dos casos devuelve el sugerido **intacto** y
 * `dias: null` — ADR-056: lo que no se midió se declara, no se dibuja.
 *
 * ⭐ Es importante que sea así y no al revés: topar con una medición falsa recorta compras reales
 * por un número inventado, y nadie lo notaría nunca.
 */

/** El tope, en días de cobertura. Una línea: es la regla de negocio, no una constante enterrada. */
export const TOPE_COBERTURA_DIAS = 45;

/** Por qué el tope tocó (o no tocó) este renglón. */
export type MotivoTope =
  /** El sugerido ya cabía: no se tocó nada. */
  | null
  /** Se recortó para no pasar el tope. Sigue habiendo algo que pedir. */
  | 'recortado'
  /** La existencia SOLA ya pasa el tope: lo correcto es no comprar. */
  | 'ya_pasa_sin_pedir'
  /** Hay espacio, pero no alcanza ni para una pieza. */
  | 'no_cabe'
  /** No se pudo medir la cobertura (sin venta, o peldaño de unidad contradicho). NO se topó. */
  | 'sin_medir';

export interface SeedTopado extends SeedRedondeado {
  /** Lo que el motor sugería ANTES del tope, en cajas. Se conserva para poder explicar el recorte. */
  sugerido: number;
  /** Días de cobertura que deja el seed final. `null` = no medible. */
  dias: number | null;
  /** Días que ya tiene la sucursal SIN pedir nada. `null` = no medible. */
  diasHoy: number | null;
  motivo: MotivoTope;
}

/** Absorbe el ruido de flotante de convertir cajas ↔ piezas (3.0000000004 es 3). */
const EPS = 1e-9;

/**
 * El sugerido del motor, redondeado como siempre y **topado** para que no deje más de
 * `topeDias` días de cobertura.
 *
 * @param ped        sugerido del motor, en cajas
 * @param uxc        unidades base por caja en esta plaza
 * @param exis       existencia de ESTA sucursal, en cajas
 * @param venta30    venta de 30 días de ESTA sucursal, en cajas
 * @param noConfiable el peldaño de unidad de esta sucursal está contradicho (`[U.2]`)
 */
export function roundSeedConTope(
  ped: number,
  uxc: number,
  exis: number,
  venta30: number,
  noConfiable = false,
  topeDias = TOPE_COBERTURA_DIAS,
): SeedTopado {
  const base = roundSeed(ped, uxc);
  const sugerido = Math.max(0, Number(ped) || 0);
  const factor = uxc > 0 ? uxc : 1;
  const e = Math.max(0, Number(exis) || 0);

  const diasHoy = diasInventario(e, venta30, 0, noConfiable);
  // No medible → se devuelve el sugerido TAL CUAL. Topar con un número que no existe recortaría
  // compras legítimas sin que nadie pudiera verlo.
  if (diasHoy == null) return { ...base, sugerido, dias: null, diasHoy: null, motivo: 'sin_medir' };

  // Nada que pedir: el tope no tiene nada que hacer, pero los días sí se publican.
  if (!(base.cajas > 0)) {
    return { ...base, sugerido, dias: diasHoy, diasHoy, motivo: null };
  }

  // Cuántas cajas caben sin pasar el tope. Mismo convenio de 30.4 días/mes que `diasInventario`,
  // porque si los dos no usan el mismo divisor el recorte no cuadra con los días que se muestran.
  const cajasQueCaben = (Number(venta30) || 0) * topeDias / 30.4 - e;

  if (base.cajas <= cajasQueCaben + EPS) {
    return { ...base, sugerido, dias: diasInventario(e, venta30, base.cajas, noConfiable), diasHoy, motivo: null };
  }

  // Hay que recortar. Se baja a PIEZAS enteras y de ahí se reconstruye, nunca al revés: redondear
  // cajas hacia abajo primero tiraría a 0 un renglón que sí podía pedir 3 piezas.
  const pzQueCaben = Math.floor(cajasQueCaben * factor + EPS);
  if (pzQueCaben <= 0) {
    const motivo: MotivoTope = diasHoy >= topeDias ? 'ya_pasa_sin_pedir' : 'no_cabe';
    return { cajas: 0, unit: 'caja', sugerido, dias: diasHoy, diasHoy, motivo };
  }

  const cajasEnteras = Math.floor(pzQueCaben / factor);
  const final: SeedRedondeado = cajasEnteras >= 1
    ? { cajas: cajasEnteras, unit: 'caja' }
    : { cajas: pzQueCaben / factor, unit: 'pieza' };

  return { ...final, sugerido, dias: diasInventario(e, venta30, final.cajas, noConfiable), diasHoy, motivo: 'recortado' };
}

/**
 * La frase que ve el comprador. Va en el renglón, no en un documento: un recorte sin motivo a la
 * vista se lee como un error del sistema, y el comprador lo "corrige" a mano.
 */
export function textoTope(t: SeedTopado, topeDias = TOPE_COBERTURA_DIAS): string {
  const d = (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('es-MX'));
  switch (t.motivo) {
    case 'recortado':
      return `Recortado por el tope de ${topeDias} días: el motor sugería ${t.sugerido.toLocaleString('es-MX', { maximumFractionDigits: 1 })} cj, que dejaban más de ${topeDias} días. Así queda en ${d(t.dias)}.`;
    case 'ya_pasa_sin_pedir':
      return `No se pide: la sucursal ya tiene ${d(t.diasHoy)} días de cobertura, por encima del tope de ${topeDias}.`;
    case 'no_cabe':
      return `No se pide: con ${d(t.diasHoy)} días en piso, ni una pieza más cabe bajo el tope de ${topeDias} días.`;
    case 'sin_medir':
      return 'Sin tope: no hay venta con qué medir la cobertura, o el peldaño de unidad de esta sucursal está contradicho.';
    default:
      return t.dias == null ? '' : `Queda con ${d(t.dias)} días de cobertura.`;
  }
}
