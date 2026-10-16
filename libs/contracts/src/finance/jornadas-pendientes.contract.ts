/**
 * `[CGP-L.4]` Lo que devuelve `GET finance/cash-ledger/cortes/jornadas-pendientes`: los días del
 * cajón con movimientos y sin corte, de la más vieja a la más nueva. Es lo que la pantalla ofrece
 * cerrar, y en ese orden: el servidor rechaza abrir un día anterior a un corte que ya existe.
 *
 * Lo comparten el servidor (tipo de retorno) y la pantalla (ADR-052): antes la pantalla declaraba
 * su propia copia y el servidor no tipaba el retorno.
 */
export interface JornadasPendientes {
  sucursal: string;
  /** Hoy en México (`YYYY-MM-DD`): la jornada de hoy no se lista, todavía no termina. */
  hoy: string;
  /** El primer día con corte. Antes de eso no hay jornada que reclamar. */
  inicio_libro: string | null;
  /** De la más vieja a la más nueva. */
  jornadas: Array<{ fecha: string; movimientos: number }>;
  /**
   * `solo_cajon`: la sucursal no es la del cajón (00) y no tiene jornadas. Se DECLARA para que la
   * lista vacía no se lea como «todo al día».
   */
  alcance: 'cajon' | 'solo_cajon';
}
