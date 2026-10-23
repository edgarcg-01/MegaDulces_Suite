import { ChangeDetectionStrategy, Component, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ArchivoDropDirective } from '../../shared/directives/archivo-drop.directive';
import { optimizarImagenes } from './image-compress';
import { MAX_ARCHIVOS, MAX_ENLACES, avisoRechazados, revisarEnlace, separar, unirArchivos } from './adjuntos';

/**
 * `[MS.ADJ.3.3]` Lo que se le ADJUNTA a una solicitud o a un mensaje: archivos (arrastrados desde el escritorio, de la cámara o
 * del selector) y enlaces de Google. Una sola pieza para el alta y para el hilo: antes cada pantalla repetía el selector, la lista
 * de pendientes y las reglas.
 *
 * Es sólo la ENTRADA: deja `archivos` (File[]) y `enlaces` (string[]) en lo que le pasa el padre (`model`) y el padre arma el envío.
 * Sólo imágenes y PDF (D1); lo demás se comparte con un enlace de Google. El servidor vuelve a validar todo.
 */
@Component({
  selector: 'app-sd-adjuntos',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, ArchivoDropDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="adj" appArchivoDrop #zona="appArchivoDrop" (soltados)="agregar($event)" role="group" aria-label="Archivos y enlaces adjuntos">
      <div class="adj-bar">
        <p-button icon="pi pi-camera" label="Cámara" severity="secondary" [outlined]="true" size="small" (onClick)="cam.click()" />
        <input #cam type="file" hidden accept="image/*" capture="environment" (change)="elegir($event)" />
        <p-button icon="pi pi-paperclip" label="Adjuntar" severity="secondary" [outlined]="true" size="small" (onClick)="fi.click()" />
        <input #fi type="file" hidden multiple accept="image/*,application/pdf" (change)="elegir($event)" />
        <p-button icon="pi pi-link" label="Enlace de Google" severity="secondary" [outlined]="true" size="small" [disabled]="enlaces().length >= maxEnlaces" (onClick)="abrirEnlace()" />
      </div>

      @if (zona.encima()) {
        <p class="adj-drop" role="status"><i class="pi pi-upload" aria-hidden="true"></i> Suelta aquí para adjuntar</p>
      } @else {
        <p class="adj-hint">Arrastra aquí fotos o PDF (hasta {{ maxArchivos }}). Documentos de Word, Excel o PowerPoint: compártelos con un enlace de Google.</p>
      }

      @if (pidiendoEnlace()) {
        <div class="adj-enlace">
          <input pInputText type="url" class="adj-url" [ngModel]="textoEnlace()" (ngModelChange)="textoEnlace.set($event)" (keydown.enter)="agregarEnlace(); $event.preventDefault()"
                 placeholder="https://docs.google.com/… o https://drive.google.com/…" aria-label="Enlace de Google" autocomplete="off" />
          <p-button label="Agregar" size="small" (onClick)="agregarEnlace()" />
          <p-button label="Cancelar" size="small" [text]="true" severity="secondary" (onClick)="pidiendoEnlace.set(false)" />
          <p class="adj-hint">Quien atiende sólo podrá abrirlo si lo compartiste con su cuenta o con «cualquier persona con el enlace».</p>
        </div>
      }

      @if (optimizando()) { <p class="adj-hint" role="status">Optimizando las fotos…</p> }
      @if (aviso(); as a) { <p class="adj-aviso" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ a }}</p> }

      @if (archivos().length || enlaces().length) {
        <ul class="adj-pend">
          @for (f of archivos(); track f.name + f.size) {
            <li><i class="pi pi-paperclip" aria-hidden="true"></i> <span class="adj-nombre">{{ f.name }}</span> <small>{{ tam(f.size) }}</small>
              <p-button icon="pi pi-times" [text]="true" size="small" severity="secondary" [ariaLabel]="'Quitar ' + f.name" (onClick)="quitarArchivo(f)" /></li>
          }
          @for (u of enlaces(); track u) {
            <li><i class="pi pi-link" aria-hidden="true"></i> <span class="adj-nombre">{{ u }}</span>
              <p-button icon="pi pi-times" [text]="true" size="small" severity="secondary" [ariaLabel]="'Quitar enlace ' + u" (onClick)="quitarEnlace(u)" /></li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .adj { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md); }
    .adj.arrastrando { border-style: solid; border-color: var(--action); background: var(--overlay-hover); }
    .adj-bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .adj-hint, .adj-drop, .adj-aviso { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .adj-drop { color: var(--text-main); font-weight: 600; display: flex; align-items: center; gap: var(--sp-2); }
    .adj-aviso { color: var(--text-main); display: flex; align-items: flex-start; gap: var(--sp-2); }
    .adj-enlace { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .adj-url { flex: 1 1 18rem; min-width: 0; }
    .adj-pend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-xs); color: var(--text-muted); }
    .adj-pend li { display: flex; align-items: center; gap: var(--sp-1); min-width: 0; }
    .adj-nombre { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  `],
})
export class SdAdjuntosComponent {
  readonly archivos = model<File[]>([]);
  readonly enlaces = model<string[]>([]);
  /** Mientras se achican las fotos el padre no debe dejar enviar (se mandaría el archivo sin achicar). */
  readonly optimizando = model(false);

  readonly maxArchivos = MAX_ARCHIVOS;
  readonly maxEnlaces = MAX_ENLACES;
  readonly aviso = signal<string | null>(null);
  readonly pidiendoEnlace = signal(false);
  readonly textoEnlace = signal('');

  elegir(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const nuevos = Array.from(input.files ?? []);
    input.value = '';
    this.agregar(nuevos);
  }

  /** Por el selector, la cámara o al soltar: la misma regla. */
  agregar(nuevos: File[]): void {
    const { buenos, malos } = separar(nuevos);
    this.aviso.set(malos.length ? avisoRechazados(malos) : null);
    if (!buenos.length) return;
    this.optimizando.set(true);
    // Las fotos de teléfono (3–15 MB) se achican ANTES de subir: ver `image-compress.ts`. Lo que no se pueda, sube original.
    optimizarImagenes(buenos)
      .catch(() => buenos)
      .then((listos) => {
        const { lista, excedio } = unirArchivos(this.archivos(), listos);
        if (excedio) this.aviso.set(`Máximo ${MAX_ARCHIVOS} archivos por envío.`);
        this.archivos.set(lista);
      })
      .finally(() => this.optimizando.set(false));
  }

  quitarArchivo(f: File): void {
    this.archivos.update((a) => a.filter((x) => x !== f));
  }

  abrirEnlace(): void {
    this.aviso.set(null);
    this.textoEnlace.set('');
    this.pidiendoEnlace.set(true);
  }

  agregarEnlace(): void {
    const r = revisarEnlace(this.textoEnlace());
    if (!r.ok) {
      this.aviso.set(r.motivo);
      return;
    }
    if (this.enlaces().length >= MAX_ENLACES) {
      this.aviso.set(`Máximo ${MAX_ENLACES} enlaces por envío.`);
      return;
    }
    this.aviso.set(null);
    if (!this.enlaces().includes(r.url)) this.enlaces.update((l) => [...l, r.url]);
    this.textoEnlace.set('');
    this.pidiendoEnlace.set(false);
  }

  quitarEnlace(u: string): void {
    this.enlaces.update((l) => l.filter((x) => x !== u));
  }

  tam(bytes: number): string {
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
}
