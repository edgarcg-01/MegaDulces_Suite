import { Injectable, signal } from '@angular/core';

/**
 * Modo foco del conteo físico (Fase I.6). Cuando un contador tiene una jornada
 * activa, se setea `active=true`: el layout oculta el nav y el CanDeactivate
 * guard pide confirmación antes de abandonar la pantalla de conteo. Evita que
 * el contador navegue a otra interfaz a mitad de un conteo en curso.
 */
@Injectable({ providedIn: 'root' })
export class CountFocusService {
  /** Hay una jornada de conteo activa → modo foco. */
  readonly active = signal(false);

  start() {
    this.active.set(true);
  }

  stop() {
    this.active.set(false);
  }
}
