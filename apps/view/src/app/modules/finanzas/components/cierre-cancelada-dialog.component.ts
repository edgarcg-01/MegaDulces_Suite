import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import { faltaEnLaNotaDeRevision, importeDelVale, lecturaDeLaCancelada, NOTA_REVISION_MAX } from '@megadulces/contracts';
import { ComprobacionesService, type ValeEsperaKepler } from '../comprobaciones.service';
import { money } from '../../../shared/util';

/** `[PGP.123]` G.UI.1e — Cómo se cierra el caso de una cancelada. */
export type ModoCierre = 'revisar' | 'ligar' | 'repetido';

/** Lo que avisa al terminar: la página vuelve a pedir la cola. */
export interface CierreHecho {
  modo: ModoCierre;
  id: string;
  /** El folio al que quedó ligado (sólo al ligar). */
  folio: string | null;
}

/**
 * `[PGP.123]` G.UI.1e — **Cerrar el caso de una cancelada en Kepler** (pedido de Francisco, 2026-11-16: «la Suite lo
 * contesta sola y una persona lo confirma»). Tres salidas, cada una con lo que la Suite ya averiguó a la vista:
 *
 *   · **Ligar** el vale a su recaptura: la que propone la pista (una sola, del mismo acreedor y total, sin vale);
 *   · **Rechazar por repetido**: la recaptura ya tiene su propio vale; es el rechazo de siempre, con su motivo;
 *   · **«Ya lo revisé»**: con lo que se hizo o por qué se queda así; queda en el vale con el nombre y la fecha.
 *
 * Como el diálogo de evidencia adicional: sin cierre implícito, y «Cancelar» con algo escrito pregunta antes de tirarlo
 * (DESIGN.md §8). El botón dice lo que falta mientras falte.
 */
@Component({
  selector: 'app-cierre-cancelada-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, TextareaModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="open()" [modal]="true" [closable]="false" [closeOnEscape]="false"
              [style]="{ width: '34rem', maxWidth: '95vw' }" [draggable]="false" [header]="titulo()">
      @if (vale(); as v) {
        <div class="cc-form">
          <p class="cc-vale">
            <span class="cc-mono">XA1501-{{ v.folio_solicitud || '?' }}</span>
            · {{ v.proveedor || 'sin proveedor' }} · <span class="cc-mono">{{ money(monto()) }}</span>
          </p>
          <!-- Lo que la Suite averiguó sola: se decide con eso a la vista. -->
          <p class="cc-pista">{{ pista().dinero }}@if (pista().recaptura) { · {{ pista().recaptura }}}</p>
          @switch (modo()) {
            @case ('ligar') {
              <p class="cc-hint">El vale pasa a la solicitud <b class="cc-mono">XA1501-{{ folio() }}</b>, del mismo acreedor y con el mismo
                total. Deja de verse aquí y sigue su camino con la solicitud nueva: si falta autorizarla, aparece en «Esperan a Kepler».</p>
            }
            @case ('repetido') {
              <p class="cc-hint">La recaptura <b class="cc-mono">XA1501-{{ folio() }}</b> ya tiene su propio vale. Si es el mismo gasto, éste
                sobra: rechazarlo lo saca de la lista y le avisa a quien lo capturó, con el motivo.</p>
              <label class="cc-lbl" for="cc-texto">Motivo del rechazo <b class="cc-req" aria-hidden="true">*</b><span class="sr-only">(obligatorio)</span></label>
              <textarea pTextarea id="cc-texto" rows="2" class="cc-txt" [maxlength]="max" [(ngModel)]="textoV" (ngModelChange)="texto.set($event)"></textarea>
            }
            @default {
              <label class="cc-lbl" for="cc-texto">¿Qué se hizo, o por qué se queda así? <b class="cc-req" aria-hidden="true">*</b><span class="sr-only">(obligatorio)</span></label>
              <textarea pTextarea id="cc-texto" rows="3" class="cc-txt" [maxlength]="max" [(ngModel)]="textoV" (ngModelChange)="texto.set($event)"
                        placeholder="Ej. se volvió a capturar en Kepler como XA1501-0010200"></textarea>
              <em class="cc-hint">Queda en el vale con tu nombre y la fecha, y el caso sale de la lista.</em>
            }
          }
          @if (error()) { <div class="cc-err" role="alert">{{ error() }}</div> }
        </div>
      }

      <ng-template #footer>
        @if (confirmClose()) {
          <span class="cc-confirm">Hay algo escrito. ¿Descartarlo?</span>
          <button pButton type="button" text (click)="confirmClose.set(false)"><span class="p-button-label">Seguir</span></button>
          <button pButton type="button" severity="danger" text (click)="cerrar()"><span class="p-button-label">Descartar</span></button>
        } @else {
          <button pButton type="button" text [disabled]="saving()" (click)="pedirCerrar()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" [severity]="modo() === 'repetido' ? 'danger' : undefined" [loading]="saving()"
                  [disabled]="!!falta() || saving()" (click)="enviar()" [title]="falta() || etiqueta()">
            <span class="p-button-label">{{ falta() ? 'Falta: ' + falta() : etiqueta() }}</span></button>
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .cc-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .cc-vale { margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .cc-mono { font-family: var(--font-mono); }
    .cc-pista { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .cc-hint { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .cc-lbl { font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cc-req { color: var(--bad-soft-fg); }
    .cc-txt { width: 100%; }
    .cc-err { font-size: var(--fs-sm); color: var(--bad-soft-fg); padding: var(--sp-2);
      border: 1px solid var(--bad-border, var(--border-color)); border-radius: var(--r-sm); }
    .cc-confirm { font-size: var(--fs-sm); color: var(--fg-1); margin-right: auto; }
  `],
})
export class CierreCanceladaDialogComponent {
  private readonly svc = inject(ComprobacionesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = model(false);
  /** La cancelada cuyo caso se cierra. */
  readonly vale = input<ValeEsperaKepler | null>(null);
  readonly modo = input<ModoCierre>('revisar');
  /** El folio de la recaptura (al ligar o al rechazar por repetido). */
  readonly folio = input<string | null>(null);
  readonly hecho = output<CierreHecho>();

  readonly max = NOTA_REVISION_MAX;
  readonly money = money;
  readonly texto = signal('');
  textoV = '';
  readonly error = signal('');
  readonly saving = signal(false);
  readonly confirmClose = signal(false);

  readonly pista = computed(() => lecturaDeLaCancelada(this.vale()?.pista_cancelada));
  readonly monto = computed(() => {
    const v = this.vale();
    return v ? importeDelVale({ importe: v.importe, importe_capturado: v.importe_capturado, kepler_estado: v.hallazgo ? 'C' : v.kepler_estado }).importe : 0;
  });
  readonly titulo = computed(() => ({ ligar: 'Ligar el vale a su recaptura', repetido: 'Rechazar el vale por repetido', revisar: 'Ya lo revisé' })[this.modo()]);
  readonly etiqueta = computed(() => ({
    ligar: `Ligar a XA1501-${this.folio() ?? ''}`, repetido: 'Rechazar el vale', revisar: 'Guardar y cerrar el caso',
  })[this.modo()]);

  /** Lo que falta, con la MISMA regla que el servidor: si la pantalla deja pasar algo, el servidor contesta igual. */
  readonly falta = computed<string | null>(() => {
    const m = this.modo();
    if (m === 'ligar') return this.folio() ? null : 'No hay recaptura que ligar';
    if (m === 'repetido') return this.texto().trim().length < 3 ? 'el motivo del rechazo' : null;
    const f = faltaEnLaNotaDeRevision(this.texto());
    return f ? 'qué se hizo o por qué se queda así' : null;
  });

  constructor() {
    // Al abrir OTRO caso, lo escrito para el anterior no se arrastra. El rechazo por repetido nace con su motivo.
    effect(() => {
      const v = this.vale();
      const m = this.modo();
      const f = this.folio();
      this.textoV = m === 'repetido' && v ? `Repetido: la recaptura XA1501-${f ?? ''} ya tiene su vale` : '';
      this.texto.set(this.textoV);
      this.error.set('');
      this.saving.set(false);
      this.confirmClose.set(false);
    }, { allowSignalWrites: true });
  }

  pedirCerrar(): void {
    const inicial = this.modo() === 'repetido' ? `Repetido: la recaptura XA1501-${this.folio() ?? ''} ya tiene su vale` : '';
    if (this.texto().trim() && this.texto() !== inicial) { this.confirmClose.set(true); return; }
    this.cerrar();
  }

  cerrar(): void {
    this.confirmClose.set(false);
    this.open.set(false);
  }

  enviar(): void {
    const v = this.vale();
    if (!v || this.falta() || this.saving()) return;
    const m = this.modo();
    const f = this.folio();
    const llamada: Observable<unknown> = m === 'ligar' ? this.svc.ligarCancelada(v.id, f ?? '')
      : m === 'repetido' ? this.svc.reject(v.id, this.texto().trim())
        : this.svc.revisarCancelada(v.id, this.texto().trim());
    this.saving.set(true);
    this.error.set('');
    llamada.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.hecho.emit({ modo: m, id: v.id, folio: m === 'ligar' ? f : null });
        this.cerrar();
      },
      error: (e: { error?: { message?: string | string[] } }) => {
        this.saving.set(false);
        const msg = e?.error?.message;
        this.error.set((Array.isArray(msg) ? msg.join(' · ') : msg) || 'No se pudo guardar: vuelve a intentar');
      },
    });
  }
}
