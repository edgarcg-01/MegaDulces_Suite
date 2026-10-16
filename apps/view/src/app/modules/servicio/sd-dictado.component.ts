import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { GrabadorVoz, MAX_SEGUNDOS_DICTADO, blobABase64, entornoNavegador, mensajeErrorMicrofono, mensajeErrorTranscripcion, mmss } from '../../shared/voz/grabador-voz';
import { ServiceDeskService, sdError } from './service-desk.service';

/**
 * `[MS.DICTADO]` Dictar la descripción de una solicitud: se graba, se transcribe y el TEXTO se entrega a quien
 * lo usa (`texto`), que lo agrega a lo que ya estaba escrito. No envía nada: la persona lo revisa y lo corrige.
 *
 *  · El audio no se guarda: viaja una vez al servidor, se transcribe y se descarta.
 *  · Sin `queueId` (aún no eligió el área) no se puede dictar: el servidor decide por el área, y en una
 *    confidencial lo rechaza. Quien lo usa tampoco lo pinta ahí.
 *  · Si el navegador no puede grabar, no se pinta nada: escribir sigue funcionando igual.
 */
@Component({
  selector: 'sd-dictado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule],
  template: `
    @if (soportado) {
      <div class="sdd">
        <div class="sdd-fila">
          <p-button [label]="etiqueta()" [icon]="icono()" [outlined]="estado() !== 'grabando'" [severity]="estado() === 'grabando' ? 'danger' : 'secondary'"
                    size="small" [loading]="estado() === 'transcribiendo'" [disabled]="!queueId() || estado() === 'transcribiendo'"
                    (onClick)="alternar()" [attr.aria-pressed]="estado() === 'grabando'" />
          @if (estado() === 'grabando') {
            <span class="sdd-tiempo" role="timer" aria-label="Tiempo grabado">{{ tiempo() }} / {{ limite }}</span>
            <p-button label="Cancelar" [text]="true" size="small" severity="secondary" (onClick)="cancelar()" />
          }
        </div>
        <p class="sdd-hint">{{ pista() }}</p>
        @if (error()) {
          <p class="sdd-err" role="alert">{{ error() }}</p>
        }
      </div>
    }
  `,
  styles: [`
    .sdd { display: flex; flex-direction: column; gap: var(--sp-1); }
    .sdd-fila { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .sdd-tiempo { font-size: var(--fs-xs); color: var(--bad-fg); font-variant-numeric: tabular-nums; }
    .sdd-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sdd-err { margin: 0; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-xs); background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
  `],
})
export class SdDictadoComponent {
  private readonly api = inject(ServiceDeskService);
  private readonly destroyRef = inject(DestroyRef);

  /** El área en la que se levanta la solicitud (el servidor decide por ella). */
  readonly queueId = input<string | null>(null);
  /** El texto transcrito, ya sin espacios sobrantes. */
  readonly texto = output<string>();

  readonly estado = signal<'inactivo' | 'grabando' | 'transcribiendo'>('inactivo');
  readonly segundos = signal(0);
  readonly error = signal<string | null>(null);
  readonly limite = mmss(MAX_SEGUNDOS_DICTADO);

  private readonly entorno = entornoNavegador();
  private readonly grabador = this.entorno
    ? new GrabadorVoz(this.entorno, {
        alCorrer: (s) => this.segundos.set(s),
        alLlegarAlLimite: () => void this.terminar(),
      })
    : null;

  readonly soportado = this.grabador !== null;
  readonly tiempo = computed(() => mmss(this.segundos()));
  readonly etiqueta = computed(() => (this.estado() === 'grabando' ? 'Terminar y escribir' : this.estado() === 'transcribiendo' ? 'Escribiendo…' : 'Dictar'));
  readonly icono = computed(() => (this.estado() === 'grabando' ? 'pi pi-stop-circle' : 'pi pi-microphone'));
  readonly pista = computed(() =>
    this.estado() === 'grabando' ? 'Habla con calma. Toca «Terminar y escribir» cuando acabes.' : 'Puedes dictar en lugar de escribir. El audio no se guarda y el texto lo puedes corregir antes de enviar.',
  );

  constructor() {
    // Si se cierra el formulario con el micrófono abierto, se suelta.
    this.destroyRef.onDestroy(() => this.grabador?.cancelar());
  }

  alternar(): void {
    if (this.estado() === 'grabando') void this.terminar();
    else if (this.estado() === 'inactivo') void this.empezar();
  }

  cancelar(): void {
    this.grabador?.cancelar();
    this.estado.set('inactivo');
    this.segundos.set(0);
  }

  private async empezar(): Promise<void> {
    if (!this.grabador || !this.queueId()) return;
    this.error.set(null);
    this.segundos.set(0);
    try {
      await this.grabador.iniciar();
      this.estado.set('grabando');
    } catch (e) {
      this.error.set(mensajeErrorMicrofono(e));
    }
  }

  private async terminar(): Promise<void> {
    if (!this.grabador || this.estado() !== 'grabando') return;
    const queueId = this.queueId();
    const grabacion = await this.grabador.detener();
    this.segundos.set(0);
    if (!grabacion || !queueId) {
      this.estado.set('inactivo');
      this.error.set('No se grabó audio. Intenta de nuevo.');
      return;
    }
    this.estado.set('transcribiendo');
    let audio: string;
    try {
      audio = await blobABase64(grabacion.blob);
    } catch {
      this.estado.set('inactivo');
      this.error.set('No se pudo leer la grabación. Intenta de nuevo.');
      return;
    }
    this.api
      .transcribe({ queue_id: queueId, audio, mime: grabacion.mime })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.estado.set('inactivo');
          const t = (r?.text ?? '').trim();
          if (r?.error) this.error.set(mensajeErrorTranscripcion(r.error));
          else if (!t) this.error.set('No se entendió el audio. Intenta de nuevo, más cerca del micrófono.');
          else this.texto.emit(t);
        },
        error: (e) => {
          this.estado.set('inactivo');
          this.error.set(sdError(e, mensajeErrorTranscripcion('stt_error')));
        },
      });
  }
}
