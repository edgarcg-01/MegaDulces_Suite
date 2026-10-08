import { BadRequestException } from '@nestjs/common';

/**
 * `[WMS-REC.19]` La llave de reintento del Andén (`client_uuid`).
 *
 * El equipo le pone un id a cada operación ANTES de mandarla. Si la respuesta se pierde y la
 * reintenta, el servidor devuelve lo que ya existe en vez de duplicarlo. La búsqueda previa cubre
 * el caso normal; estos índices únicos (mig 20261007213847) son el respaldo ante la carrera rara
 * de dos envíos simultáneos — el perdedor choca con `23505` y se le contesta con la fila del ganador.
 */
export const UX_SESIONES_CLIENT_UUID = 'ux_recv_sessions_client_uuid';
export const UX_CAPTURAS_CLIENT_UUID = 'ux_recv_lot_captures_client_uuid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si viene un `client_uuid` y es un UUID. `false` si no viene. Lanza si viene mal formado. */
export function conLlave(clientUuid: string | undefined | null): clientUuid is string {
  if (clientUuid === undefined || clientUuid === null || clientUuid === '') return false;
  if (!UUID.test(clientUuid)) throw new BadRequestException('client_uuid inválido');
  return true;
}

/** ¿El error es el choque de ESTE índice? Otro `23505` (el folio, por ejemplo) no es un reintento. */
export function esChoqueDe(e: unknown, indice: string): boolean {
  const x = e as { code?: string; constraint?: string } | null;
  return x?.code === '23505' && x?.constraint === indice;
}
