import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { AVISO_RONDA_PIE, AVISO_RONDA_TITULO, rondaDeRevision, type EstadoRonda } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * [GX.86] El aviso de las rondas de revisión de gastos.
 *
 * NO bloquea nada: subir un gasto es libre a cualquier hora (decisión del usuario). Lo primero que
 * se lee es justo eso; la segunda línea cambia con la hora y le dice a la persona en qué ronda se
 * revisa SU gasto. El horario completo va abajo, en gris.
 *
 * Una sola pieza para las tres puertas de alta (captura, link y el diálogo «Adjuntar evidencia»):
 * si viviera copiada, la primera en desfasarse diría otro horario.
 *
 * Quien aprueba no lo ve: no es su aviso. El link de captura no tiene sesión, así que ahí siempre
 * se ve (no hay permisos que lo oculten).
 */
@Component({
  selector: 'app-aviso-ronda-gastos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="ar" role="note">
        <i class="pi pi-check-circle" aria-hidden="true"></i>
        <div>
          <div class="ar-t">{{ titulo }}</div>
          <div class="ar-d">{{ ronda().linea }}</div>
          <div class="ar-p">{{ pie }}</div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .ar { display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-md); border: 1px solid var(--info-border);
      background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .ar .pi { font-size: var(--fs-body); margin-top: 2px; }
    .ar-t { font-size: var(--fs-sm); font-weight: var(--fw-bold); }
    .ar-d { font-size: var(--fs-sm); color: var(--fg-1); margin-top: 2px; }
    .ar-p { font-size: var(--fs-xs); color: var(--fg-3); margin-top: var(--sp-1); }
  `],
})
export class AvisoRondaGastosComponent {
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  /** En la página pública del link no hay sesión: se muestra siempre. */
  readonly publico = input(false);

  readonly titulo = AVISO_RONDA_TITULO;
  readonly pie = AVISO_RONDA_PIE;

  /** Se recalcula cada 30 s: con la pantalla abierta, a las 10:00 cambia sola de línea. */
  readonly ronda = signal<EstadoRonda>(rondaDeRevision());

  /** Quien aprueba no lo ve (los roles de plataforma pasan dentro de `has`). */
  readonly visible = computed(() => this.publico() || !this.perms.has(Permission.FINANCE_EXPENSES_COMPROBAR));

  constructor() {
    const reloj = setInterval(() => this.ronda.set(rondaDeRevision()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(reloj));
  }
}
