import { BadRequestException } from '@nestjs/common';
import { DEPARTAMENTO_SIN, type FiltroExpediente } from '@megadulces/contracts';

/** Un día de calendario real (`2026-02-30` no lo es aunque cumpla el patrón). */
function diaValido(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/**
 * `[GX.72]` Lee el filtro del Expediente desde la query string.
 *
 * ⛔ Un filtro inválido se **rechaza** (400), no se ignora. Ignorarlo devolvería los vales de
 * todas las fechas con la pantalla creyendo que filtró: KPIs de un periodo rotulados con otro,
 * que es peor que un error visible.
 *
 * Vacío o ausente = sin ese filtro. El departamento se recorta (la pantalla lo manda tal cual
 * vino en las opciones, pero una URL armada a mano puede traer espacios).
 */
export function filtroExpedienteDesdeQuery(q: {
  desde?: string | null;
  hasta?: string | null;
  departamento?: string | null;
}): FiltroExpediente {
  const desde = String(q.desde ?? '').trim() || null;
  const hasta = String(q.hasta ?? '').trim() || null;
  const departamento = String(q.departamento ?? '').trim() || null;

  if (desde && !diaValido(desde)) throw new BadRequestException(`fecha «desde» inválida: ${desde} (se espera AAAA-MM-DD)`);
  if (hasta && !diaValido(hasta)) throw new BadRequestException(`fecha «hasta» inválida: ${hasta} (se espera AAAA-MM-DD)`);
  // Comparación de texto: con AAAA-MM-DD el orden alfabético ES el orden de fechas.
  if (desde && hasta && desde > hasta) {
    throw new BadRequestException(`el rango de fechas está al revés: desde ${desde} es posterior a hasta ${hasta}`);
  }
  return { desde, hasta, departamento };
}

/** `true` si el filtro pide los vales SIN departamento. */
export const pideSinDepartamento = (f: FiltroExpediente): boolean => f.departamento === DEPARTAMENTO_SIN;
