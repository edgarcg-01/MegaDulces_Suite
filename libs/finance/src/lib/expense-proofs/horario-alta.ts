import { ForbiddenException } from '@nestjs/common';
import { horarioAltaGastos } from '@megadulces/contracts';

/**
 * `[GX.86]` El candado del horario de alta, en el SERVIDOR. La pantalla sólo avisa: esconder el
 * botón no basta (una pestaña abierta desde antes, o la API, lo saltan).
 *
 * Una sola función para las dos entradas de alta (usuario con cuenta y link de captura): si
 * viviera copiada en cada una, la primera en olvidarse abriría el hueco.
 */
export function asegurarHorarioAlta(exento: boolean, ahora: Date = new Date()): void {
  if (exento) return;
  const h = horarioAltaGastos(ahora);
  if (!h.abierto) throw new ForbiddenException(h.mensaje);
}
