/**
 * ⭐ `[CGS.35]` **Lo que hay en caja, rubro por rubro**: el efectivo del cajón, la caja fuerte (CAOS),
 * los dólares, los cheques y los papeles. Tal como lo publica `GET /finance/cash-ledger/posicion`.
 *
 * Cada rubro dice tres cosas por separado: lo ÚLTIMO que alguien contó (con su fuente y su hora),
 * lo que se movió DESDE entonces, y lo que debería haber AHORA. El estado de «ahora» nunca se
 * esconde (ADR-056):
 *
 *  · `medido`     — es lo último contado y la Suite no registra movimientos de ese rubro desde
 *                   entonces (dólares, cheques, papeles): vale lo contado, con su fecha.
 *  · `derivado`   — lo último contado más los movimientos registrados después.
 *  · `parcial`    — derivado, pero hubo movimientos que no se pueden sumar (p. ej. un vaciado de la
 *                   caja fuerte): la cifra se publica y se dice qué le falta.
 *  · `imposible`  — la cuenta da un número que no puede ser (un cajón no debe dinero): no se publica
 *                   la cifra como respuesta; se dice por qué.
 *  · `no_medido`  — no hay de dónde sacarlo.
 */
export type RubroCaja = 'efectivo' | 'caja_fuerte' | 'dolares' | 'cheques' | 'papeles';
export type EstadoPosicion = 'medido' | 'derivado' | 'parcial' | 'imposible' | 'no_medido';

export interface PosicionRubro {
  rubro: RubroCaja;
  etiqueta: string;
  /** Lo último contado. `monto` siempre en MXN; para dólares además `usd` y `tipo_cambio`. */
  ultimo: { monto: number | null; usd?: number | null; tipo_cambio?: number | null; fuente: string; at: string | null } | null;
  /** Lo que se movió desde ese conteo, ya con signo para este rubro. `null` = no se lleva el registro. */
  desde: { entra: number; sale: number; detalle: string } | null;
  ahora: { monto: number | null; usd?: number | null; estado: EstadoPosicion; nota: string };
}

export interface PosicionCajaDto {
  /** Instante ISO del cálculo. */
  calculado_at: string;
  rubros: PosicionRubro[];
  /**
   * La suma de lo que SÍ se puede afirmar ahora, en MXN. `completo = false` cuando algún rubro quedó
   * fuera (imposible o no medido): la suma no es «todo lo que hay», y `fuera` dice cuáles faltan.
   */
  total: { monto: number; completo: boolean; fuera: RubroCaja[] };
}
