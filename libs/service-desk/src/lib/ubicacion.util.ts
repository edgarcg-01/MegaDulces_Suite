/**
 * `[MS.7.10]` Normaliza el código de una UBICACIÓN que llega de afuera (el alta de un ticket, una regla de asignación). Un solo lugar
 * para las dos: si cada una validara a su manera, una regla podría quedar apuntando a una ubicación que ningún ticket puede tener.
 */
import { BadRequestException } from '@nestjs/common';
import { KEPLER_BRANCH_NAMES } from '@megadulces/platform-core';
import { ubicacionExtra } from './domain/ubicaciones';

/** `null` = sin ubicación. Lanza 400 si el código no es una ubicación conocida. */
export function normalizarUbicacion(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  // `[MS.3.14]` Una ubicación que no es sucursal (oficinas corporativas, estacionamiento) es válida y se guarda en su código canónico.
  const extra = ubicacionExtra(c);
  if (extra) return extra;
  // Sólo el espacio de códigos vigente de Kepler (00–08): '30','32','50' son eras de Wincaja ya cerradas.
  if (!/^0[0-8]$/.test(c) || !(c in KEPLER_BRANCH_NAMES)) throw new BadRequestException('Ubicación desconocida');
  return c;
}
