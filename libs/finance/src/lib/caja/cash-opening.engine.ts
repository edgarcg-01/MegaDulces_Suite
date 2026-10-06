/**
 * `[CG.39]` Con qué arranca la caja — y de dónde salió ese número.
 *
 * ── El problema, medido
 *
 * `abrir()` hacía `fondo_inicial: input.fondo_inicial ?? 0`, la columna era `NOT NULL DEFAULT 0`
 * y **nada ligaba el arranque de hoy con el cierre de ayer**. Así que el punto de partida del
 * saldo era lo que alguien escribiera, o cero.
 *
 * ⭐ Y el cero no es neutro: afirma *"la caja arrancó vacía"*. Si hay fondo para dar cambio —y
 * lo hay, Edgar lo confirmó— eso es imposible, y cada peso del fondo se va del `esperado` para
 * reaparecer como sobrante en el arqueo. Un faltante y un sobrante del mismo tamaño, todos los
 * días, que nadie puede explicar.
 *
 * ── La regla
 *
 * **El estado inicial de hoy ES el conteo final de ayer.** No se teclea: se PROPONE desde el
 * último corte cerrado de esa sucursal, con su folio y su fecha a la vista, y la persona lo
 * confirma contando. Si no hay corte anterior, el motor **no inventa un cero**: devuelve
 * `sin_medir` y dice por qué.
 *
 * Sin Angular, sin HTTP, sin SQL: para que se pueda probar de verdad.
 */

import { totalDenominaciones, type ConteoPorLlave } from '@megadulces/contracts';

export type OrigenFondo = 'cierre_anterior' | 'contado' | 'sin_medir';

/** El último corte cerrado de la sucursal, tal como vive en la tabla. */
export interface CorteCerrado {
  folio: string;
  fecha: string;
  /** Lo que se contó al cerrar. `null` si se cerró sin conteo. */
  contado: number | null;
  /** El desglose del cierre, por llave del catálogo. */
  denominaciones?: ConteoPorLlave | null;
}

export interface FondoSugerido {
  /** Lo que se propone como arranque. `null` cuando NO se pudo medir — nunca 0. */
  monto: number | null;
  origen: OrigenFondo;
  /** El desglose propuesto, para que la reja arranque llena y contar sea confirmar. */
  denominaciones: ConteoPorLlave;
  /** De dónde salió, en llano. Es lo que se le muestra a la persona. */
  procedencia: string;
  /**
   * Lo que esta propuesta NO cubre. Se enumera en vez de omitirse: un hueco callado se lee
   * como que no hay hueco.
   */
  limites: string[];
}

/**
 * Propone el arranque de la caja desde el último corte cerrado.
 *
 * ⚠️ `previo` es `null` cuando no hay ninguno. Ese caso NO devuelve `monto: 0` — devuelve
 * `null` con `origen: 'sin_medir'`, que es lo que ADR-056 pide y lo que distingue *"la caja
 * arrancó vacía"* de *"nadie sabe con qué arrancó"*.
 */
export function fondoSugerido(previo: CorteCerrado | null | undefined): FondoSugerido {
  if (!previo) {
    return {
      monto: null,
      origen: 'sin_medir',
      denominaciones: {},
      procedencia: 'No hay un corte anterior de esta sucursal: nadie sabe con qué quedó la caja.',
      limites: ['Hay que contar el efectivo y declararlo. Sin eso, el esperado del corte no significa nada.'],
    };
  }

  const limites: string[] = [];
  const dens = previo.denominaciones ?? {};
  const t = totalDenominaciones(dens);

  if (t.desconocidas.length) {
    limites.push(
      'El cierre anterior trae denominaciones que el catálogo no reconoce (' +
      t.desconocidas.join(', ') + '): esas piezas no se pudieron sumar.',
    );
  }

  // ⛔ El conteo total y su desglose pueden no coincidir: el desglose es lo que se tecleó pieza
  //    por pieza, y `contado` es lo que se selló. Si difieren, la diferencia se NOMBRA — es
  //    dinero del que no sabemos la forma, y la reja de apertura va a arrancar incompleta.
  const contado = previo.contado;
  if (contado !== null && contado !== undefined && Object.keys(dens).length) {
    const d = redondea(contado - t.total);
    if (Math.abs(d) > 0.005) {
      limites.push(
        'El cierre anterior selló ' + contado.toFixed(2) + ' pero su desglose suma ' +
        t.total.toFixed(2) + ': faltan ' + Math.abs(d).toFixed(2) +
        ' sin forma conocida (probablemente morralla suelta).',
      );
    }
  }

  // El monto manda el conteo sellado; el desglose sirve para precargar la reja.
  const monto = contado !== null && contado !== undefined ? redondea(contado) : (
    Object.keys(dens).length ? t.total : null
  );

  if (monto === null) {
    return {
      monto: null,
      origen: 'sin_medir',
      denominaciones: {},
      procedencia: 'El corte ' + previo.folio + ' del ' + previo.fecha + ' se cerró SIN conteo.',
      limites: [...limites, 'Hay que contar el efectivo: no hay de dónde heredar el arranque.'],
    };
  }

  return {
    monto,
    origen: 'cierre_anterior',
    denominaciones: { ...dens },
    procedencia: 'Es con lo que quedó el corte ' + previo.folio + ' del ' + previo.fecha + '.',
    limites,
  };
}

/**
 * Compara lo que la persona contó al abrir contra lo que se proponía.
 *
 * ⭐ Una diferencia acá no es un error de captura: **es efectivo que apareció o desapareció con
 * la caja cerrada**, y es de las pocas señales que distinguen un descuadre de operación de uno
 * de custodia. Por eso se devuelve con su monto, no como un booleano.
 */
export function cuadreApertura(
  sugerido: number | null,
  contado: number | null,
): { estado: 'sin_medir' | 'cuadra' | 'difiere'; diferencia: number | null; texto: string } {
  if (sugerido === null || contado === null) {
    return {
      estado: 'sin_medir',
      diferencia: null,
      texto: sugerido === null
        ? 'No hay con qué comparar: no se sabe con qué quedó el corte anterior.'
        : 'Todavía no se contó el efectivo de apertura.',
    };
  }
  const d = redondea(contado - sugerido);
  if (Math.abs(d) <= 0.005) {
    return { estado: 'cuadra', diferencia: 0, texto: 'La caja arrancó con lo mismo que quedó al cerrar.' };
  }
  return {
    estado: 'difiere',
    diferencia: d,
    texto: d > 0
      ? 'Hay ' + d.toFixed(2) + ' MÁS que al cerrar el corte anterior. Con la caja cerrada entró efectivo que nadie registró.'
      : 'Faltan ' + Math.abs(d).toFixed(2) + ' contra el cierre anterior. Con la caja cerrada salió efectivo que nadie registró.',
  };
}

function redondea(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
