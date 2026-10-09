import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import type { PriceChangeRow, PriceNoticeRecipientsDto, PriceNoticeShareResultDto, PriceNoticeShareStatus } from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { EtiquetasService } from '../etiquetas.service';
import { cambiosACsv, nombreArchivoCambios } from '../cambios-csv';

/** Qué le dice la pantalla a quien manda, por cada plaza. Cada estado trae su motivo: un «no se envió» sin razón no se corrige. */
const TEXTO_ESTADO: Record<PriceNoticeShareStatus, string> = {
  enviado: 'Enviado',
  sin_cambios: 'Ese día no hubo cambios: no se envió',
  sin_dato: 'La bitácora todavía no llega a ese día: no se envió',
  repetido: 'Ya la avisaste hace unos minutos',
  plaza_invalida: 'No disponible para ti',
};

/**
 * `[ETQ-AVISOS.3]` Compartir la lista de «Cambios de precio» — sólo para quien tiene
 * `STORE_LABELS_COMPARTIR` (Compras). Dos acciones:
 *
 *  · **Avisar a sucursales**: elige las plazas, agrega una nota y el aviso llega a su campana.
 *  · **Descargar la lista** (CSV): la misma que muestra la pantalla, para llevarla fuera de la Suite.
 *
 * El botón no existe para quien no tiene el permiso. Se esconde y NO se deshabilita: un botón gris
 * le dice a una cajera que hay algo que ella no puede hacer, y no es un trabajo suyo.
 *
 * Sin WhatsApp ni correo, a propósito: no hay un canal real detrás y un botón que fingiera enviar
 * sería peor que no tenerlo.
 */
@Component({
  selector: 'app-cambios-compartir',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, DialogModule],
  styles: [`
    .ccs-bloque { display:flex; flex-direction:column; gap:.55rem; padding:.2rem 0 .9rem; }
    .ccs-bloque + .ccs-bloque { border-top:1px solid var(--border-color); padding-top:.9rem; }
    .ccs-bloque h3 { margin:0; font-size:var(--fs-sm); font-weight:var(--fw-bold); color:var(--fg-1); }
    .ccs-ayuda { margin:0; font-size:var(--fs-xs); color:var(--fg-2); line-height:1.4; }
    .ccs-plazas { display:flex; flex-direction:column; border:1px solid var(--border-color); border-radius:var(--radius-sm); max-height:15rem; overflow:auto; }
    .ccs-plaza { display:flex; align-items:center; gap:.6rem; padding:.35rem .6rem; border-bottom:1px solid var(--border-color); font-size:var(--fs-sm); color:var(--fg-1); cursor:pointer; min-height:var(--row-h-md); }
    .ccs-plaza:last-child { border-bottom:0; }
    .ccs-plaza.is-off { color:var(--fg-3); cursor:not-allowed; }
    .ccs-plaza input { inline-size:1rem; block-size:1rem; accent-color:var(--action); }
    .ccs-plaza .nom { flex:1 1 auto; min-width:0; }
    .ccs-plaza .meta { font-size:var(--fs-xs); color:var(--fg-2); white-space:nowrap; }
    .ccs-plaza .meta.is-warn { color:var(--warn-fg); }
    .ccs-nota { width:100%; min-height:4.5rem; resize:vertical; padding:.5rem .6rem; border:1px solid var(--border-color); border-radius:var(--radius-sm); background:var(--card-bg); color:var(--fg-1); font-size:var(--fs-sm); font-family:inherit; }
    .ccs-nota:focus-visible { outline:2px solid var(--focus-ring); outline-offset:1px; }
    .ccs-cont { font-size:var(--fs-xs); color:var(--fg-3); text-align:right; }
    .ccs-acciones { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
    .ccs-res { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:.2rem; font-size:var(--fs-sm); }
    .ccs-res li { display:flex; gap:.5rem; color:var(--fg-1); }
    .ccs-res li.is-ok .est { color:var(--ok-fg); }
    .ccs-res li.is-no .est { color:var(--warn-fg); }
    .ccs-res .pl { font-weight:var(--fw-bold); min-width:7rem; }
    .ccs-error { margin:0; font-size:var(--fs-sm); color:var(--bad-fg); }
  `],
  template: `
    @if (puede()) {
      <p-button label="Compartir" icon="pi pi-share-alt" size="small" [text]="true" (onClick)="abrir()" />

      <p-dialog header="Compartir cambios de precio" [modal]="true" [visible]="abierto()"
                (visibleChange)="abierto.set($event)" [style]="{ width: '34rem', maxWidth: '94vw' }"
                [draggable]="false" appendTo="body">
        <section class="ccs-bloque">
          <h3>Descargar la lista</h3>
          <p class="ccs-ayuda">
            La lista del <b>{{ fecha() }}</b>{{ plaza() ? ' de la tienda ' + plaza() : '' }}, como la ves en pantalla
            (una fila por producto y presentación). Se abre en Excel.
          </p>
          <div class="ccs-acciones">
            <p-button label="Descargar CSV" icon="pi pi-download" size="small" [outlined]="true"
                      [disabled]="!hayLista()" (onClick)="descargar()" />
            @if (!hayLista()) { <span class="ccs-ayuda">No hay cambios que descargar en esta vista.</span> }
          </div>
        </section>

        <section class="ccs-bloque">
          <h3>Avisar a sucursales</h3>
          <p class="ccs-ayuda">
            Le llega a quien ve la etiquetera de esa tienda, en su campana de notificaciones, con el resumen del
            <b>{{ fecha() }}</b> y un enlace a la lista.
          </p>

          @if (cargando()) {
            <p class="ccs-ayuda" role="status">Buscando sucursales…</p>
          } @else if (falloPlazas()) {
            <p class="ccs-error" role="alert">No se pudo leer la lista de sucursales. Cierra y vuelve a intentar.</p>
          } @else {
            <div class="ccs-plazas" role="group" aria-label="Sucursales a avisar">
              @for (p of plazas(); track p.plaza) {
                <label class="ccs-plaza" [class.is-off]="!disponible(p)">
                  <input type="checkbox" [checked]="elegida(p.plaza)" [disabled]="!disponible(p)"
                         (change)="alternar(p.plaza)" [attr.aria-label]="'Avisar a ' + (p.nombre || p.plaza)" />
                  <span class="nom">{{ p.nombre || ('Plaza ' + p.plaza) }} <span class="meta">· {{ p.plaza }}</span></span>
                  @if (!disponible(p)) {
                    <span class="meta is-warn">bitácora hasta {{ p.ultimo_dia }}</span>
                  } @else if (p.destinatarios === 0) {
                    <span class="meta is-warn" title="Nadie tiene esta tienda asignada: sólo lo verá quien tenga alcance sobre todas.">nadie con tienda asignada</span>
                  } @else {
                    <span class="meta">{{ p.destinatarios }} {{ p.destinatarios === 1 ? 'persona' : 'personas' }}</span>
                  }
                </label>
              }
            </div>
            <div class="ccs-acciones">
              <p-button label="Todas las disponibles" size="small" [text]="true" (onClick)="elegirTodas()" />
              <p-button label="Ninguna" size="small" [text]="true" (onClick)="elegidas.set([])" />
            </div>
          }

          <label class="ccs-ayuda" for="ccs-nota">Nota para las sucursales (opcional)</label>
          <textarea id="ccs-nota" class="ccs-nota" maxlength="500" [ngModel]="nota()" (ngModelChange)="nota.set($event)"
                    placeholder="Por ejemplo: reimprime primero los de caja"></textarea>
          <div class="ccs-cont">{{ nota().length }}/500</div>

          <div class="ccs-acciones">
            <p-button [label]="'Enviar aviso' + (elegidas().length ? ' (' + elegidas().length + ')' : '')" icon="pi pi-send"
                      size="small" [disabled]="!elegidas().length || enviando()" [loading]="enviando()" (onClick)="enviar()" />
          </div>

          @if (falloEnvio()) { <p class="ccs-error" role="alert">{{ falloEnvio() }}</p> }

          @if (resultados().length) {
            <ul class="ccs-res" role="status" aria-label="Resultado del envío">
              @for (r of resultados(); track r.plaza) {
                <li [class.is-ok]="r.estado === 'enviado'" [class.is-no]="r.estado !== 'enviado'">
                  <span class="pl">{{ nombreDe(r.plaza) }}</span>
                  <span class="est">{{ textoDe(r) }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <ng-template #footer>
          <p-button label="Cerrar" [text]="true" (onClick)="abierto.set(false)" />
        </ng-template>
      </p-dialog>
    }
  `,
})
export class CambiosCompartirComponent {
  private readonly svc = inject(EtiquetasService);
  private readonly perms = inject(PermissionsService);

  /** Las filas crudas de la bitácora de la vista actual (el mismo `items` de la pantalla). */
  readonly items = input<readonly PriceChangeRow[]>([]);
  /** La plaza que se está viendo (dos dígitos) o `null` si todavía no eligió. */
  readonly plaza = input<string | null>(null);
  /** El día que se está viendo (`YYYY-MM-DD`). */
  readonly fecha = input<string>('');

  /** El botón no existe para quien no tiene el permiso: se esconde, no se deshabilita. */
  readonly puede = computed(() => this.perms.has(Permission.STORE_LABELS_COMPARTIR));

  readonly abierto = signal(false);
  readonly plazas = signal<PriceNoticeRecipientsDto[]>([]);
  readonly cargando = signal(false);
  readonly falloPlazas = signal(false);
  readonly elegidas = signal<string[]>([]);
  readonly nota = signal('');
  readonly enviando = signal(false);
  readonly falloEnvio = signal<string | null>(null);
  readonly resultados = signal<PriceNoticeShareResultDto[]>([]);

  readonly hayLista = computed(() => this.items().length > 0);

  abrir(): void {
    this.abierto.set(true);
    this.resultados.set([]);
    this.falloEnvio.set(null);
    this.cargando.set(true);
    this.falloPlazas.set(false);
    this.svc.noticeRecipients().subscribe({
      next: (r) => {
        this.plazas.set(r);
        // Arranca con la plaza que se está viendo, si se puede avisar: es lo más probable que quiera.
        const actual = this.plaza();
        this.elegidas.set(actual && r.some((p) => p.plaza === actual && this.disponible(p)) ? [actual] : []);
        this.cargando.set(false);
      },
      // No se puede leer ≠ no hay: se dice, y no se deja enviar a ciegas.
      error: () => { this.falloPlazas.set(true); this.cargando.set(false); },
    });
  }

  /** ¿Se le puede avisar de ESTE día? Si la bitácora de la plaza no llega, no se afirma nada: no es lo mismo que «no hubo». */
  disponible(p: PriceNoticeRecipientsDto): boolean {
    return !p.ultimo_dia || p.ultimo_dia >= this.fecha();
  }

  elegida(plaza: string): boolean { return this.elegidas().includes(plaza); }

  alternar(plaza: string): void {
    this.elegidas.update((l) => (l.includes(plaza) ? l.filter((x) => x !== plaza) : [...l, plaza]));
  }

  elegirTodas(): void {
    this.elegidas.set(this.plazas().filter((p) => this.disponible(p)).map((p) => p.plaza));
  }

  enviar(): void {
    if (!this.elegidas().length || this.enviando()) return;
    this.enviando.set(true);
    this.falloEnvio.set(null);
    this.svc.shareNotices({ plazas: this.elegidas(), fecha: this.fecha(), nota: this.nota().trim() || undefined }).subscribe({
      next: (r) => {
        this.resultados.set(r);
        // Lo que ya salió se quita de la selección: reintentar sólo lo que no salió.
        const salieron = new Set(r.filter((x) => x.estado === 'enviado').map((x) => x.plaza));
        this.elegidas.update((l) => l.filter((p) => !salieron.has(p)));
        this.enviando.set(false);
      },
      error: (e) => {
        this.falloEnvio.set(e?.error?.message ? String(e.error.message) : 'No se pudo enviar el aviso. Intenta de nuevo.');
        this.enviando.set(false);
      },
    });
  }

  nombreDe(plaza: string): string {
    return this.plazas().find((p) => p.plaza === plaza)?.nombre || `Plaza ${plaza}`;
  }

  textoDe(r: PriceNoticeShareResultDto): string {
    return r.estado === 'enviado'
      ? `Enviado · ${r.productos} ${r.productos === 1 ? 'producto' : 'productos'}`
      : TEXTO_ESTADO[r.estado];
  }

  descargar(): void {
    const csv = cambiosACsv(this.items());
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivoCambios(this.plaza(), this.fecha());
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
