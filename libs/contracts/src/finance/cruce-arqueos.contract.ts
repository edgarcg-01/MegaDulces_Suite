import type { Freshness } from '../http/provenance.contract';

/**
 * ⭐⭐ `[CGS.2]` — **La forma del cruce de arqueos, escrita UNA vez.**
 *
 * `GET /finance/caja-control/cruce` compara, día por día, el corte que selló la Suite contra el
 * arqueo de cierre que capturó Control. Este archivo es el contrato de esa respuesta.
 *
 * ## ⛔ Por qué es un contrato y no dos interfaces parecidas
 *
 * La pantalla de Arqueos vivía con su propia copia de estos tipos. Mientras el servicio no los
 * publicara, **la copia era una declaración de fe**: el día que el backend agregara un estado o
 * volviera nulo un campo, el frontend seguiría compilando en verde y pintando otra cosa. Es el
 * defecto que ADR-052 nombra y que la compuerta de boundary cobra — y acá tenía un costo
 * concreto: este endpoint publica **nulos que significan «no se midió»**, y un tipo que los
 * declare `number` los convierte en ceros en la pantalla sin que nadie se entere.
 */

/**
 * ⛔ **CUATRO estados, no dos** (ADR-056). Los dos del medio son huecos SIMÉTRICOS, no descuadres:
 *
 *  · `cuadran`    — los dos conteos dan lo mismo al centavo.
 *  · `difieren`   — los dos contaron y no coinciden. Lo único que es un descuadre.
 *  · `sin_corte`  — Control cerró y la Suite no selló corte ese día.
 *  · `sin_arqueo` — la Suite selló corte y Control no cerró ese día.
 *
 * ⚠️ Ninguno de los dos huecos entra en la suma de diferencias: pintarlos como descuadre del
 * tamaño del arqueo entero mandaría a buscar efectivo que nadie perdió.
 */
export type EstadoCruceArqueo = 'cuadran' | 'difieren' | 'sin_corte' | 'sin_arqueo';

/**
 * Una pieza de la reja, con lo que contó cada sistema.
 *
 * ⛔ `clave` es la identidad de la pieza y **el valor no lo es**: $20 existe como billete (`b20`)
 * y como moneda (`m20`), y $100 igual. Una pantalla que las etiquete sólo por su valor muestra
 * «$20» dos veces con cifras distintas, y si las usa como clave de lista, las funde.
 */
export interface CruceArqueoDenominacion {
  /** La columna de Control: `b1000`, `b500`, …, `m50c`, `m5c`. */
  clave: string;
  tipo: 'billete' | 'moneda';
  valor: number;
  /** Piezas que contó Control. `null` = **no cerró ese día**; no es cero. */
  control: number | null;
  /** Piezas que contó la Suite. `null` = esa denominación no existe en su reja. */
  suite: number | null;
  /** `null` cuando falta alguno de los dos lados: una resta contra un hueco no es una diferencia. */
  dif_piezas: number | null;
  dif_importe: number | null;
  /** `'control'` = la Suite no tiene dónde capturar esa pieza, así que esa parte no se cruza. */
  solo_en: string | null;
}

export interface CruceArqueoLadoControl {
  folio: string | null;
  /** `null` = Control no capturó arqueo de cierre ese día. ⛔ Nunca 0: cero afirmaría que contó. */
  efectivo: number | null;
  /** ¿La suma de las piezas de ese ticket da su propio total? `null` = no se pudo evaluar. */
  cuadra_ticket: boolean | null;
  hora: string | null;
}

export interface CruceArqueoLadoSuite {
  folio: string;
  estado: string;
  /** Lo que se contó al cerrar. `null` = el corte existe pero nadie selló un conteo. */
  contado: number | null;
  /**
   * ⚠️ Lo que el libro CALCULABA que debía haber. Va como contraste, nunca como juez: es un
   * derivado (fondo + ingresos − gastos − depósitos ± CAOS), no un conteo.
   */
  esperado: number | null;
  diferencia: number | null;
  /** La segunda llave. `false` = se cerró y nadie lo autorizó. */
  autorizado: boolean;
  cerro: string | null;
}

export interface CruceArqueoDia {
  /** `YYYY-MM-DD`. */
  fecha: string;
  control: CruceArqueoLadoControl;
  suite: CruceArqueoLadoSuite | null;
  cruce: { estado: EstadoCruceArqueo; diferencia: number | null };
  desglose: CruceArqueoDenominacion[];
}

export interface CruceArqueosResponse {
  rows: CruceArqueoDia[];
  limit: number;
  fuente: string;
  frescura: Freshness | null;
}
