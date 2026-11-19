import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Injector, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';
import { ButtonModule } from 'primeng/button';

/**
 * ⭐ `[LE.6.34]` **El «Cancelar» de una ventana con algo capturado adentro: pregunta antes de tirarlo.**
 *
 * Auditoría del 2026-11-18 (modern-web-guidance «dialog»: *«DO use `closedby="none"` with an explicit
 * confirmation step for dirty forms»*): en Caja General doce ventanas de conteo —el arqueo, el recuento a
 * ciegas, cerrar el corte, el conteo del día, pagar, recibir…— se cerraban con Esc, con la X o con
 * «Cancelar» y al reabrir las piezas contadas volvían a cero. Contar dinero dos veces es el retrabajo más
 * caro de la caja.
 *
 * Uso, en el pie del `p-dialog` en lugar del botón «Cancelar», y con la ventana sin cierre propio mientras
 * esté sucia (este componente atiende el Esc de SU ventana y pregunta):
 *
 *   <p-dialog [closable]="!sucio()" [closeOnEscape]="!sucio()" …>
 *     <ng-template #footer>
 *       <app-descartar-cambios [sucio]="sucio()" (cerrar)="cerrarX()" />
 *       <p-button label="Guardar" … />
 *     </ng-template>
 *   </p-dialog>
 *
 * Sin nada capturado se comporta como un «Cancelar» normal. Con algo, muestra la pregunta en su lugar y el
 * foco cae en «Seguir contando»: un segundo Esc o Enter no descarta nada.
 */
@Component({
  selector: 'app-descartar-cambios',
  standalone: true,
  imports: [ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'dc-host' },
  template: `
    @if (!preguntando()) {
      <p-button [label]="etiqueta()" severity="secondary" [text]="true" [disabled]="bloqueado()" (onClick)="pedir()"
                data-testid="dc-cancelar" />
    } @else {
      <span class="dc-pregunta" role="alert" data-testid="dc-pregunta">
        <span class="dc-texto">¿Descartar? {{ texto() }}</span>
        <button #btnSeguir type="button" class="dc-btn dc-btn--main" (click)="seguir()" data-testid="dc-seguir">{{ textoSeguir() }}</button>
        <button type="button" class="dc-btn" (click)="descartar()" data-testid="dc-descartar">Descartar</button>
      </span>
    }
  `,
  styles: [`
    :host { display: inline-flex; align-items: center; }
    .dc-pregunta { display: inline-flex; align-items: center; gap: var(--sp-2, 0.5rem); flex-wrap: wrap;
      padding: var(--sp-1, 0.25rem) var(--sp-2, 0.5rem); border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg); }
    .dc-texto { font-size: var(--fs-sm, 0.875rem); color: var(--text-main); }
    .dc-btn { min-height: 32px; padding: 0 0.75rem; border-radius: var(--r-sm, 8px); font: inherit; font-size: var(--fs-sm, 0.875rem);
      cursor: pointer; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main); }
    .dc-btn--main { border-color: var(--action); background: var(--action); color: var(--action-contrast, #fff); }
    .dc-btn:focus-visible { outline: 2px solid var(--focus-ring, var(--action)); outline-offset: 2px; }
    @media (pointer: coarse) { .dc-btn { min-height: 44px; } }
  `],
})
export class DescartarCambiosComponent {
  /** Hay algo capturado que se perdería al cerrar. */
  readonly sucio = input(false);
  /** Mientras se guarda, cancelar no hace nada (cerrar a medio envío pierde el resultado). */
  readonly bloqueado = input(false);
  readonly etiqueta = input('Cancelar');
  readonly texto = input('Se pierde lo que contaste.');
  readonly textoSeguir = input('Seguir contando');
  /** La persona decidió cerrar (sin nada capturado, o confirmando el descarte). */
  readonly cerrar = output<void>();

  protected readonly preguntando = signal(false);
  private readonly seguirBtn = viewChild<ElementRef<HTMLButtonElement>>('btnSeguir');
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);

  pedir(): void {
    if (this.bloqueado()) return;
    if (!this.sucio()) { this.cerrar.emit(); return; }
    this.preguntando.set(true);
    afterNextRender(() => this.seguirBtn()?.nativeElement.focus(), { injector: this.injector });
  }

  seguir(): void { this.preguntando.set(false); }

  descartar(): void {
    this.preguntando.set(false);
    this.cerrar.emit();
  }

  /**
   * El Esc de SU ventana (la ventana tiene `closeOnEscape` apagado mientras está sucia). Un Esc de otra ventana
   * o de un desplegable abierto adentro (que ya lo atendió: `defaultPrevented`) no es suyo.
   */
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(evento: Event): void {
    const ev = evento as KeyboardEvent;
    if (ev.defaultPrevented || this.bloqueado()) return;
    const ventana = (this.el.nativeElement as HTMLElement).closest('.p-dialog');
    const destino = ev.target instanceof Element ? ev.target : null;
    if (!ventana || !destino || !ventana.contains(destino)) return;
    if (this.preguntando()) { this.seguir(); ev.preventDefault(); return; }
    if (!this.sucio()) return;   // limpia: la cierra PrimeNG con su propio Esc
    ev.preventDefault();
    this.pedir();
  }
}
