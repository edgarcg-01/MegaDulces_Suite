import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { textoDeJustificante, type OrderJustification } from '@megadulces/contracts';

const hora = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * `[MCP.18]` «Por qué cambió este pedido»: lo que corrigió o canceló la vendedora, lo que quitó el
 * surtidor y lo que dejó la caja, con quién, a qué hora y el motivo. Lo guardado sin motivo dice
 * «Sin motivo registrado» (nunca se inventa). Sin cambios no se pinta nada.
 *
 * ⚠️ La vendedora lo ve en su app con su propia cáscara (las dos apps no comparten componentes): lo
 * que se comparte es el texto, `textoDeJustificante` de `@megadulces/contracts`.
 */
@Component({
  selector: 'app-justificantes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (filas().length) {
      <section class="jf" [attr.aria-labelledby]="idBase() + '-t'">
        <h3 class="jf-t" [id]="idBase() + '-t'"><i class="pi pi-history" aria-hidden="true"></i> {{ titulo() }}</h3>
        <ul class="jf-l">
          @for (f of filas(); track $index) {
            <li>
              <!-- Los espacios van DENTRO de las expresiones: Angular quita los que hay entre etiquetas, y
                   un lector de pantalla leería «pedido.Motivo». -->
              <span class="jf-q">{{ f.quien }}{{ f.hora ? ' · ' + f.hora : '' }}</span>{{ ' ' + f.que + '. ' }}<span class="jf-m" [class.jf-sin]="f.sinMotivo">Motivo: {{ f.motivo }}</span>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .jf { margin: var(--sp-2) 0; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .jf-t { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); display: flex; align-items: center; gap: var(--sp-1); }
    .jf-l { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-main); }
    .jf-q { font-weight: 700; margin-right: var(--sp-1); }
    .jf-m { display: block; color: var(--text-main); }
    .jf-sin { color: var(--text-muted); font-style: italic; }
  `],
})
export class JustificantesComponent {
  readonly items = input<readonly OrderJustification[] | null | undefined>([]);
  readonly titulo = input('Por qué cambió este pedido');
  readonly idBase = input('jf');
  /** Sólo los de ciertos roles (p. ej. al surtir, lo que corrigió la vendedora). Vacío = todos. */
  readonly soloDe = input<ReadonlyArray<OrderJustification['actor']>>([]);

  readonly filas = computed(() => {
    const solo = this.soloDe();
    return (this.items() ?? [])
      .filter((j) => !solo.length || solo.includes(j.actor))
      .map((j) => ({ ...textoDeJustificante(j), hora: j.at ? hora.format(new Date(j.at)) : '', sinMotivo: j.reason === null }));
  });
}
