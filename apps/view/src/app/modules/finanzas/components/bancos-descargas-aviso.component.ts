import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { ArchivosDelBanco } from '../bank.service';

type CuentaDelBanco = ArchivosDelBanco['cuentas'][number];

/** El día anterior a `hoy` (YYYY-MM-DD), sin pasar por la zona horaria del navegador. */
export function diaAnterior(hoy: string): string {
  const [y, m, d] = hoy.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d - 1));
  return f.toISOString().slice(0, 10);
}

/** Cuentas con lector cuya descarga no llega a `ayer` (o que nunca se ha subido). Una cuenta sin lector no entra: no se puede subir. */
export function cuentasAtrasadas(cuentas: readonly CuentaDelBanco[], ayer: string): CuentaDelBanco[] {
  return cuentas.filter((c) => c.con_lector && (!c.hasta || c.hasta < ayer));
}

/**
 * `[CB.59]` El aviso de arriba del Cierre: si alguna cuenta no tiene la descarga del banco hasta ayer,
 * es lo primero que se ve, con el camino a «Estados de cuenta». Con todo al día no ocupa lugar.
 * Lo que no se pudo leer se dice; no se calla como si todo estuviera al día (ADR-056).
 * Los datos los lee la pantalla de Bancos una vez (también dan el número de la pestaña).
 */
@Component({
  selector: 'bancos-descargas-aviso',
  standalone: true,
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <p class="da da--muted" role="status"><i class="pi pi-question-circle" aria-hidden="true"></i> No se pudo leer qué descargas del banco faltan.</p>
    } @else if (atrasadas().length) {
      <div class="da" role="status">
        <i class="pi pi-file-import" aria-hidden="true"></i>
        <span class="da-txt"><b>Faltan descargas del banco:</b> {{ atrasadas().length }} de {{ conLector() }} cuentas no llegan a ayer ({{ ayerCorto() }}) —
          {{ nombres() }}</span>
        <button pButton type="button" class="p-button-sm p-button-outlined" (click)="irA.emit()">
          <span class="p-button-label">Subir descargas</span></button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .da { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font-size: var(--fs-sm); color: var(--text-main); }
    .da > .pi { color: var(--warn-soft-fg); }
    .da--muted { color: var(--text-muted); }
    .da--muted > .pi { color: var(--text-muted); }
    .da-txt { flex: 1 1 auto; min-width: 0; }
    @media (max-width: 40rem) { .da { flex-wrap: wrap; } }
  `],
})
export class BancosDescargasAvisoComponent {
  readonly irA = output<void>();
  /** null = todavía no llega. */
  readonly cuentas = input<CuentaDelBanco[] | null>(null);
  readonly error = input(false);
  /** La fecha de hoy en México; se inyecta en las pruebas. */
  readonly hoy = signal(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));

  readonly ayer = computed(() => diaAnterior(this.hoy()));
  readonly ayerCorto = computed(() => { const [, m, d] = this.ayer().split('-'); return `${d}/${m}`; });
  readonly atrasadas = computed(() => cuentasAtrasadas(this.cuentas() ?? [], this.ayer()));
  readonly conLector = computed(() => (this.cuentas() ?? []).filter((c) => c.con_lector).length);
  readonly nombres = computed(() => {
    const a = this.atrasadas().map((c) => c.alias);
    return a.length > 4 ? `${a.slice(0, 4).join(', ')} y ${a.length - 4} más` : a.join(', ');
  });

}
