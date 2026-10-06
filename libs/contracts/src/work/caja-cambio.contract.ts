/**
 * `[CG.38]` El cambio en Caja General: lo que ENTRA y lo que SALE de un mismo acto.
 *
 * ── Qué pedía el negocio
 *
 * Edgar, 2026-10-06: *"la morralla se cuenta por denominación, además, la persona encargada
 * normalmente da cambio. tenemos que agregar ese apartado y hacerlo que sea un proceso rápido
 * sin perder un dato en el arqueo"*. Al preguntar qué pasa físicamente, la respuesta fue **las
 * tres cosas a la vez**: devuelve cambio al que paga, hace canjes (un billete por morralla) y
 * mantiene un fondo para poder darlo.
 *
 * ── Por qué es UN mecanismo y no tres
 *
 * Las tres son el mismo hecho con distinto neto:
 *
 *   | lo que pasa               | entra  | sale | neto   |
 *   |---------------------------|--------|------|--------|
 *   | cobro normal              | 4,830  | —    | 4,830  |
 *   | devuelve cambio al pagador| 5,000  | 170  | 4,830  |
 *   | canje billete -> morralla |   500  | 500  |     0  |
 *
 * O sea: **todo acto de caja tiene una composición que entra y otra que sale**, y el neto es la
 * resta. El cobro de siempre es el caso en que no sale nada. Por eso no hay tres formularios:
 * hay un desglose con dos columnas.
 *
 * ── La regla que evita perder el dato
 *
 * ⭐ **Un canje cuyas dos mitades no coinciden NO es un canje: es un descuadre.** Si alguien
 * declara que entregó $500 en morralla contra un billete de $500 y las piezas suman $480, eso
 * son $20 que salieron de la caja y nadie va a volver a ver. El motor lo NOMBRA con su monto en
 * vez de aceptarlo callado — que es exactamente lo que pidió el pedido.
 *
 * ⚠️ Y la asimetría del redondeo: se compara contra un épsilon de centavo porque `numeric` y el
 * punto flotante no dan lo mismo, no porque se tolere una diferencia de negocio. Un centavo de
 * tolerancia es redondeo; un peso es dinero.
 */

import { totalDenominaciones } from '../money/denominations';

/**
 * De qué lado del acto está esta pila de billetes y monedas.
 *
 * ⚠️ `'recibido'` es el default en la base a propósito: **todo lo ya capturado es dinero que
 * entró**, así que la columna nueva no puede cambiarle el significado a un solo arqueo viejo.
 */
export type FlujoDenominacion = 'recibido' | 'devuelto';

export const FLUJOS_DENOMINACION: readonly FlujoDenominacion[] = ['recibido', 'devuelto'];

/** Un conteo por denominación, con la LLAVE del catálogo (no el valor). `{"500":3,"20m":4}`. */
export type ConteoPorLlave = Record<string, number>;

/**
 * Tolerancia del cuadre: un centavo. Espejo de `ARQUEO_EPSILON` de la pantalla.
 * Existe por el redondeo de `numeric`, no para perdonar diferencias de negocio.
 */
export const CAMBIO_EPSILON = 0.005;

export interface ResultadoCambio {
  /** Lo que suma la pila que entró, incluida su morralla suelta. */
  entra: number;
  /** Lo que suma la pila que se devolvió. */
  sale: number;
  /** `entra − sale`. Es el monto del movimiento. */
  neto: number;
  /**
   * Llaves que el catálogo compartido no reconoce, de los dos lados.
   *
   * ⛔ Se ENUMERAN, no se ignoran: una llave que nadie reconoce es dinero que no se contó, y
   * sumarla como 0 daría un total más chico que el dinero real. ADR-056.
   */
  desconocidas: string[];
  /**
   * Por qué este desglose no se puede guardar, o `null` si se puede.
   * Es texto para la persona, no un código: lo lee quien está contando.
   */
  problema: string | null;
}

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Evalúa un acto de caja con sus dos pilas.
 *
 * @param recibido   piezas por llave de lo que entró
 * @param devuelto   piezas por llave de lo que salió (el cambio que se dio)
 * @param morralla   lo suelto que entró y no se desglosa (monedas de menos de 50¢)
 * @param esCanje    si el acto declara ser un canje, en cuyo caso las dos mitades deben coincidir
 */
export function evaluarCambio(
  recibido: ConteoPorLlave | null | undefined,
  devuelto: ConteoPorLlave | null | undefined,
  morralla = 0,
  esCanje = false,
): ResultadoCambio {
  const e = totalDenominaciones(recibido);
  const s = totalDenominaciones(devuelto);
  const suelta = Number(morralla) || 0;

  const entra = r2(e.total + suelta);
  const sale = r2(s.total);
  const neto = r2(entra - sale);
  const desconocidas = [...e.desconocidas, ...s.desconocidas];

  return { entra, sale, neto, desconocidas, problema: problemaDe(entra, sale, neto, desconocidas, esCanje) };
}

function problemaDe(
  entra: number,
  sale: number,
  neto: number,
  desconocidas: string[],
  esCanje: boolean,
): string | null {
  // El dinero que no se reconoce va PRIMERO: cualquier otra cifra de abajo ya está mal.
  if (desconocidas.length) {
    return 'No se reconocen estas denominaciones: ' + desconocidas.join(', ') +
      '. Son piezas que no se pudieron contar.';
  }

  if (esCanje) {
    // ⭐ La regla que da nombre a la fase. Un canje que no cuadra es dinero que se fue.
    const d = r2(entra - sale);
    if (Math.abs(d) > CAMBIO_EPSILON) {
      return d > 0
        ? 'Un canje tiene que dar lo mismo de los dos lados. Entraron ' + d.toFixed(2) +
          ' de más: esa diferencia se queda en la caja y no está registrada como ingreso.'
        : 'Un canje tiene que dar lo mismo de los dos lados. Salieron ' + Math.abs(d).toFixed(2) +
          ' de más: ese dinero se fue de la caja y nadie lo va a volver a ver.';
    }
    if (entra === 0) return 'Un canje sin piezas de ningún lado no es un canje.';
    return null;
  }

  // Un movimiento normal: no se puede devolver más de lo que entró.
  if (neto < -CAMBIO_EPSILON) {
    return 'Estás devolviendo ' + Math.abs(neto).toFixed(2) + ' más de lo que entró. ' +
      'Si lo que querías era un canje, marcalo como canje.';
  }
  // ⚠️ Neto exactamente cero en un movimiento normal: no es un error de captura, es un canje
  // sin marcar. Se dice, porque guardarlo con monto 0 lo deja fuera de todo cuadre.
  if (sale > 0 && Math.abs(neto) <= CAMBIO_EPSILON) {
    return 'Entró y salió lo mismo. Eso es un canje, no un movimiento: marcalo como canje.';
  }
  return null;
}

/**
 * Pasa un conteo por llave a la forma `{ denominacion, piezas }` que la tabla guarda hoy.
 *
 * ⛔ Convive con `denom_key` a propósito y NO es duplicación por descuido: la columna numérica
 * es la que permite sumar en SQL sin que la base tenga que conocer el catálogo, que vive en
 * TypeScript. La identidad de la fila es la LLAVE; el valor es derivado, y la migración le pone
 * un CHECK de pares para que el derivado **no pueda mentir**.
 */
export function aFilasDenominacion(
  conteo: ConteoPorLlave | null | undefined,
  valorDeLlave: (k: string) => number | null,
): Array<{ denom_key: string; denominacion: number; piezas: number }> {
  const filas: Array<{ denom_key: string; denominacion: number; piezas: number }> = [];
  for (const [k, v] of Object.entries(conteo || {})) {
    const piezas = Number(v);
    if (!Number.isFinite(piezas) || piezas <= 0) continue;   // 0 piezas es no haberlo capturado
    const valor = valorDeLlave(k);
    if (valor === null) continue;                            // lo desconocido ya lo reportó evaluarCambio
    filas.push({ denom_key: k, denominacion: valor, piezas });
  }
  return filas;
}
