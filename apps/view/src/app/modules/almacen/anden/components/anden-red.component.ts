import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { OpAnden } from '../anden-offline';

/** Un vale detenido porque el servidor rechazó algo de su cola. */
export interface ValeDetenido {
  key: string;
  error: string;
}

/**
 * `[WMS-REC.20]` Andén · **cómo está la conexión y qué falta mandar**.
 *
 * Tres estados, y sólo se pinta si hay algo que decir:
 *  - **sin conexión**: lo que se hace se guarda en el equipo y se manda solo al volver;
 *  - **por mandar / mandando**: cuánto hay en la cola;
 *  - **detenido**: el servidor rechazó algo de un vale. No se reintenta solo (no lo arreglaría):
 *    se ofrece reintentar —después de arreglar la causa— o descartar, que pide confirmación
 *    porque lo capturado sin red se pierde.
 */
@Component({
  selector: 'app-anden-red',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!online() || pendientes() > 0 || detenidos().length) {
      <section class="rd" [class.rd-off]="!online()" role="status" aria-live="polite">
        <p class="rd-lin">
          @if (!online()) {
            <b>Sin conexión.</b> Lo que hagas se guarda en este equipo y se manda solo al volver la red.
            @if (paqueteAl()) { Vales del equipo al {{ hora(paqueteAl()!) }}. }
          } @else if (enviando()) {
            <b>Mandando…</b> {{ pendientes() | number }} {{ pendientes() === 1 ? 'cosa' : 'cosas' }} hechas sin conexión.
          } @else if (pendientes() > 0) {
            <b>{{ pendientes() | number }} por mandar.</b> Se reintenta sola.
          }
          @if (online() && pendientes() > 0 && !enviando()) {
            <button type="button" class="rd-bt" (click)="enviar.emit()">Mandar ahora</button>
          }
        </p>
        @for (d of detenidos(); track d.key) {
          <div class="rd-det" role="alert">
            <p><b>Un vale no se pudo mandar:</b> {{ d.error }}</p>
            @if (confirmando() === d.key) {
              <p class="rd-conf">Se pierde lo capturado sin conexión en ese vale. ¿Descartarlo?</p>
              <div class="rd-bts">
                <button type="button" class="rd-bt rd-malo" (click)="descartar.emit(d.key); confirmando.set(null)">Sí, descartar</button>
                <button type="button" class="rd-bt" (click)="confirmando.set(null)">No</button>
              </div>
            } @else {
              <div class="rd-bts">
                <button type="button" class="rd-bt" (click)="reintentar.emit(d.key)">Reintentar</button>
                <button type="button" class="rd-bt" (click)="confirmando.set(d.key)">Descartar</button>
              </div>
            }
          </div>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .rd {
      display: flex; flex-direction: column; gap: var(--sp-2); margin-bottom: var(--sp-3);
      padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
      background: var(--surface-ground); border: 1px solid var(--border-color);
      font-size: var(--fs-xs); color: var(--text-main); line-height: 1.45;
    }
    .rd-off { background: var(--warn-soft-bg); border-color: transparent; }
    .rd-lin { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); }
    .rd-det { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-2);
      border-top: 1px solid var(--border-color); }
    .rd-det p { margin: 0; color: var(--bad-fg); }
    .rd-det .rd-conf { color: var(--text-main); }
    .rd-bts { display: flex; gap: var(--sp-2); }
    .rd-bt {
      min-height: 36px; padding: 0 var(--sp-3); cursor: pointer; font: inherit; font-weight: var(--fw-bold);
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-sm);
    }
    .rd-bt:hover { border-color: var(--action); }
    .rd-bt:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .rd-malo { color: var(--bad-fg); }
  `],
})
export class AndenRedComponent {
  readonly online = input(true);
  readonly enviando = input(false);
  readonly pendientes = input(0);
  /** Lo que el servidor rechazó, por vale. */
  readonly errores = input<OpAnden[]>([]);
  /** Cuándo se bajaron los vales que el equipo usa sin red (ISO). */
  readonly paqueteAl = input<string | null>(null);

  readonly enviar = output<void>();
  readonly reintentar = output<string>();
  readonly descartar = output<string>();

  /** El vale cuyo descarte se está confirmando. */
  readonly confirmando = signal<string | null>(null);

  /** Un renglón por vale, con el primer rechazo: es el que detiene a los demás. */
  readonly detenidos = computed<ValeDetenido[]>(() => {
    const vistos = new Map<string, ValeDetenido>();
    for (const o of [...this.errores()].sort((a, b) => a.seq - b.seq))
      if (!vistos.has(o.valeKey)) vistos.set(o.valeKey, { key: o.valeKey, error: o.error || 'El servidor lo rechazó.' });
    return [...vistos.values()];
  });

  hora(iso: string): string {
    try {
      // 24 horas: en 12 horas sale "12:40 p.m." y el punto final de la frase quedaba doble.
      return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' }).format(new Date(iso));
    } catch {
      return iso.slice(11, 16);
    }
  }
}
