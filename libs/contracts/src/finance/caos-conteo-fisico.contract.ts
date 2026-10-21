/**
 * `[CGS.22]` **El conteo físico de la caja fuerte CAOS**, tal como lo publica la API.
 *
 * Una persona cuenta billete por billete, A CIEGAS (no ve lo que la máquina dice hasta guardar), y
 * el servidor lo compara contra la referencia del momento. `referencia_total = null` = no había
 * contra qué comparar (la máquina no publicaba su saldo): la diferencia es `null`, nunca 0.
 */
export interface CaosConteoPieza { denominacion: number; piezas: number }

export interface CaosConteoFisicoDto {
  id: string;
  /** Instante ISO. */
  contado_at: string;
  contado_por: string | null;
  piezas: CaosConteoPieza[];
  total: number;
  referencia_total: number | null;
  /** `maquina` = la lectura del aparato · `foto_mas_movimientos` = la última lectura más lo posterior. */
  referencia_origen: string | null;
  referencia_parcial: boolean | null;
  diferencia: number | null;
  nota: string | null;
}

/** Las denominaciones que maneja la caja fuerte: billetes, sin monedas. */
export const DENOMINACIONES_CAOS: readonly number[] = [1000, 500, 200, 100, 50, 20] as const;
