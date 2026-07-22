import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { SkeletonModule } from 'primeng/skeleton';

/**
 * DESIGN §6/§13 — estado de carga unificado para Operations. Resuelve el anti-patrón
 * `error === empty` (un 500 pintaba el mismo panel "Sin datos" que un periodo vacío),
 * peligroso en finanzas. Renderiza UNO de tres estados y proyecta el contenido real
 * cuando hay data:
 *   loading → filas skeleton (nunca spinner de bloque)
 *   error   → banner tokenizado + botón Reintentar
 *   empty   → icono + título + microcopy + CTA opcional
 * Uso:
 *   <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!rows().length"
 *       emptyTitle="Sin movimientos" emptyHint="No hay movimientos para este periodo."
 *       emptyCta="Subir estado de cuenta" (retry)="reload()" (cta)="upload()">
 *     <p-table ...></p-table>
 *   </app-load-state>
 */
@Component({
  selector: 'app-load-state',
  standalone: true,
  imports: [ButtonModule, SkeletonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) {
      <div class="ls-sk" aria-busy="true" aria-live="polite">
        @for (r of skRows(); track $index) {
          <div class="ls-sk-row"><p-skeleton height="1rem" [style]="{ width: skWidth($index) }"></p-skeleton></div>
        }
      </div>
    } @else if (error()) {
      <div class="ls-error" role="alert">
        <i class="pi pi-exclamation-triangle ls-error-ic" aria-hidden="true"></i>
        <div class="ls-error-txt">
          <p class="ls-error-title">{{ errorTitle() }}</p>
          <p class="ls-error-detail">{{ error() }}</p>
        </div>
        <button pButton type="button" class="p-button-sm p-button-outlined" icon="pi pi-refresh"
                label="Reintentar" (click)="retry.emit()"></button>
      </div>
    } @else if (isEmpty()) {
      <div class="ls-empty">
        <i class="pi {{ emptyIcon() }} ls-empty-ic" aria-hidden="true"></i>
        <p class="ls-empty-title">{{ emptyTitle() }}</p>
        @if (emptyHint()) { <p class="ls-empty-hint">{{ emptyHint() }}</p> }
        @if (emptyCta()) {
          <button pButton type="button" class="p-button-sm" [icon]="emptyCtaIcon()"
                  [label]="emptyCta()!" (click)="cta.emit()"></button>
        }
      </div>
    } @else {
      <ng-content></ng-content>
    }
  `,
  styles: [`
    :host { display: block; }
    .ls-sk { display: flex; flex-direction: column; gap: .55rem; padding: .5rem 0; }
    .ls-sk-row { min-height: var(--row-h-md, 40px); display: flex; align-items: center; }
    .ls-error {
      display: flex; align-items: center; gap: .85rem; padding: 1rem 1.15rem;
      border: 1px solid var(--bad-border, var(--border-color)); border-radius: var(--r-md, 12px);
      background: color-mix(in srgb, var(--bad-fg) 8%, var(--card-bg));
    }
    .ls-error-ic { font-size: 1.25rem; color: var(--bad-fg); flex: none; }
    .ls-error-txt { flex: 1 1 auto; min-width: 0; }
    .ls-error-title { margin: 0; font-weight: var(--fw-bold, 700); color: var(--text-main); font-size: .9rem; }
    .ls-error-detail { margin: .15rem 0 0; color: var(--text-muted); font-size: .8rem; }
    .ls-empty {
      display: flex; flex-direction: column; align-items: center; text-align: center;
      gap: .5rem; padding: 2.5rem 1.5rem; color: var(--text-muted);
    }
    .ls-empty-ic { font-size: 1.9rem; color: var(--text-faint); }
    .ls-empty-title { margin: 0; font-weight: var(--fw-bold, 700); color: var(--text-main); font-size: .95rem; }
    .ls-empty-hint { margin: 0; font-size: .82rem; color: var(--text-muted); max-width: 30rem; }
    .ls-empty button, .ls-error button { margin-top: .35rem; }
  `],
})
export class LoadStateComponent {
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly isEmpty = input(false);
  readonly skeletonRows = input(6);
  readonly errorTitle = input('No se pudo cargar la información');
  readonly emptyIcon = input('pi-inbox');
  readonly emptyTitle = input('Sin datos');
  readonly emptyHint = input<string | null>(null);
  readonly emptyCta = input<string | null>(null);
  readonly emptyCtaIcon = input('pi pi-plus');

  readonly retry = output<void>();
  readonly cta = output<void>();

  readonly skRows = computed(() => Array.from({ length: Math.max(1, this.skeletonRows()) }));

  /** Ancho variado por fila para que el skeleton no se vea de bloque uniforme. */
  skWidth(i: number): string {
    const widths = ['100%', '92%', '96%', '84%', '98%', '88%'];
    return widths[i % widths.length];
  }
}
