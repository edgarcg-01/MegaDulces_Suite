import { CanDeactivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { CountFocusService } from '../services/count-focus.service';

/**
 * Confirma antes de abandonar la pantalla de conteo si hay una jornada activa
 * (modo foco). No bloquea de forma dura — pide confirmación para evitar salidas
 * accidentales a mitad de un conteo. Tocar "Terminar conteo" apaga el modo
 * foco, así que ahí ya no pregunta.
 */
export const countFocusGuard: CanDeactivateFn<unknown> = () => {
  const focus = inject(CountFocusService);
  if (!focus.active()) return true;
  return confirm(
    'Tenés un conteo en curso. Si salís ahora se interrumpe.\n¿Querés abandonar el conteo?',
  );
};
