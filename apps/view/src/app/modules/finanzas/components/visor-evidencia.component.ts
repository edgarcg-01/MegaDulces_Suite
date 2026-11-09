import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, computed, effect, inject, input, model, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { CommonModule } from '@angular/common';
import { SafeResourceUrl } from '@angular/platform-browser';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';

/**
 * Un archivo del expediente, listo para pintar. Lo arma el visor del vale (`vale-gasto-peek`).
 *
 * ⚠️ `safeUrl` se sanitiza UNA vez allá: hacerlo en la plantilla recrearía el `iframe` en cada
 * ciclo de detección y el PDF se recargaría solo, sin parar.
 */
export interface DocEvidencia {
  role: string;
  label: string;
  url: string;
  isPdf: boolean;
  /** `[GX.33]` Ni imagen ni PDF: el navegador no lo pinta. Se ofrece abrirlo aparte. */
  esOtro: boolean;
  safeUrl: SafeResourceUrl | null;
  /** `[GX.99]` El PDF para la vista del panel: la página entera, sin barras. Opcional. */
  safeUrlVista?: SafeResourceUrl | null;
  /** `[GX.87]` Sólo en evidencia adicional: por qué se agregó, quién y cuándo. */
  nota: string | null;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_PASO = 0.25;

/**
 * `[GX.99]` — **La evidencia en grande.** Pedido del usuario (2026-11-06): «que cuando revisen la
 * evidencia se muestre en ventana, no como se muestra ahora». Antes cada archivo se pintaba a lo
 * ancho del panel lateral, uno debajo de otro: para leer una factura había que bajar el panel y
 * no se podía acercar.
 *
 * Un visor a casi toda la pantalla, dentro de la app: el archivo en grande, flechas para pasar al
 * siguiente, acercar/alejar y girar (las fotos del vale llegan de lado), la tira de miniaturas, y
 * «abrir aparte» para quien prefiere otra pestaña. Teclado: ← → cambian de archivo, + − acercan,
 * 0 vuelve al tamaño, R gira, Esc cierra (y regresa al vale).
 *
 * No decide ni pide nada: recibe los archivos ya firmados y en qué índice abrir.
 */
@Component({
  selector: 'app-visor-evidencia',
  standalone: true,
  imports: [CommonModule, DialogModule, ButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="open()" (visibleChange)="open.set($event)" [modal]="true" [draggable]="false" [resizable]="false"
              [dismissableMask]="true" [closeOnEscape]="true" appendTo="body" styleClass="ve-dialog"
              [style]="{ width: '96vw', height: '94vh', maxWidth: '96vw' }" [contentStyle]="{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%' }">
      <ng-template #header>
        <div class="ve-head">
          <div class="ve-titulo">
            <strong>{{ actual()?.label ?? 'Evidencia' }}</strong>
            <span class="ve-cuenta">{{ indice() + 1 }} de {{ docs().length }}</span>
            @if (titulo()) { <span class="ve-sub">{{ titulo() }}</span> }
          </div>
          @if (actual(); as d) {
            <div class="ve-herr" role="toolbar" aria-label="Herramientas del visor">
              @if (!d.isPdf && !d.esOtro) {
                <button pButton type="button" class="p-button-text p-button-sm" (click)="alejar()" [disabled]="zoom() <= zoomMin"
                        aria-label="Alejar (tecla −)"><i class="pi pi-search-minus" aria-hidden="true"></i></button>
                <button type="button" class="ve-zoom" (click)="tamanoNormal()" aria-label="Tamaño normal (tecla 0)">{{ (zoom() * 100) | number: '1.0-0' }}%</button>
                <button pButton type="button" class="p-button-text p-button-sm" (click)="acercar()" [disabled]="zoom() >= zoomMax"
                        aria-label="Acercar (tecla +)"><i class="pi pi-search-plus" aria-hidden="true"></i></button>
                <button pButton type="button" class="p-button-text p-button-sm" (click)="girar()"
                        aria-label="Girar (tecla R)"><i class="pi pi-replay" aria-hidden="true"></i></button>
              }
              <a class="ve-aparte" [href]="d.url" target="_blank" rel="noopener">
                <i class="pi pi-external-link" aria-hidden="true"></i>&nbsp;Abrir aparte
              </a>
            </div>
          }
        </div>
      </ng-template>

      @if (actual(); as d) {
        <div class="ve-cuerpo">
          @if (d.nota) { <p class="ve-nota">Agregada después: {{ d.nota }}</p> }
          <div class="ve-escena">
            @if (docs().length > 1) {
              <button type="button" class="ve-flecha izq" (click)="anterior()" aria-label="Archivo anterior (←)">
                <i class="pi pi-chevron-left" aria-hidden="true"></i>
              </button>
            }
            <div class="ve-lienzo" [class.zoom]="zoom() > 1">
              @if (d.isPdf) {
                <iframe [src]="d.safeUrl" [title]="d.label"></iframe>
              } @else if (d.esOtro) {
                <!-- [GX.33] Un documento que el navegador no pinta: se dice y se ofrece abrirlo. -->
                <a class="ve-otro" [href]="d.url" target="_blank" rel="noopener">
                  <i class="pi pi-file" aria-hidden="true"></i>
                  <span>Este documento no se puede ver aquí. Ábrelo aparte para revisarlo.</span>
                </a>
              } @else if (fallidos().has(d.url)) {
                <!-- Que la imagen no cargue NO es que no exista: se dice cuál de las dos. -->
                <p class="ve-fallo">No se pudo mostrar el archivo. Prueba «Abrir aparte».</p>
              } @else {
                <img [src]="d.url" [alt]="d.label" (error)="fallo(d.url)"
                     [style.transform]="'rotate(' + giro() + 'deg)'"
                     [style.width]="zoom() > 1 ? (zoom() * 100) + '%' : null" />
              }
            </div>
            @if (docs().length > 1) {
              <button type="button" class="ve-flecha der" (click)="siguiente()" aria-label="Archivo siguiente (→)">
                <i class="pi pi-chevron-right" aria-hidden="true"></i>
              </button>
            }
          </div>

          @if (docs().length > 1) {
            <div class="ve-tira" role="list" aria-label="Archivos del vale">
              @for (x of docs(); track x.url; let i = $index) {
                <button type="button" role="listitem" class="ve-mini" [class.on]="i === indice()"
                        [attr.aria-current]="i === indice() ? 'true' : null" (click)="ir(i)" [attr.aria-label]="'Ver ' + x.label">
                  @if (x.isPdf) { <i class="pi pi-file-pdf" aria-hidden="true"></i> }
                  @else if (x.esOtro) { <i class="pi pi-file" aria-hidden="true"></i> }
                  @else { <img [src]="x.url" alt="" loading="lazy" /> }
                  <span>{{ x.label }}</span>
                </button>
              }
            </div>
          }
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: contents; }
    .ve-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); width: 100%; flex-wrap: wrap; }
    .ve-titulo { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; }
    .ve-titulo strong { font-size: var(--fs-body); }
    .ve-cuenta { font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums; }
    .ve-sub { font-size: var(--fs-xs); color: var(--fg-3); font-family: var(--font-mono); }
    .ve-herr { display: flex; align-items: center; gap: var(--sp-1); margin-right: var(--sp-2); }
    .ve-zoom { border: 1px solid var(--border-color); background: transparent; border-radius: var(--r-sm); padding: 2px 8px;
      font: inherit; font-size: var(--fs-xs); color: var(--fg-2); font-variant-numeric: tabular-nums; cursor: pointer; min-width: 3.5rem; }
    .ve-aparte { font-size: var(--fs-sm); color: var(--action); margin-left: var(--sp-2); white-space: nowrap; }
    .ve-zoom:focus-visible, .ve-aparte:focus-visible, .ve-flecha:focus-visible, .ve-mini:focus-visible {
      outline: 2px solid var(--focus-ring); outline-offset: 2px; }

    .ve-cuerpo { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--layout-bg); }
    .ve-nota { margin: 0; padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--fg-2); border-bottom: 1px solid var(--border-color); }
    .ve-escena { flex: 1; min-height: 0; position: relative; display: flex; align-items: stretch; }
    .ve-lienzo { flex: 1; min-width: 0; overflow: auto; display: flex; align-items: center; justify-content: center; padding: var(--sp-3); }
    .ve-lienzo.zoom { align-items: flex-start; justify-content: flex-start; }
    .ve-lienzo img { max-width: 100%; max-height: 100%; object-fit: contain; transition: transform 200ms ease; background: var(--card-bg); }
    .ve-lienzo.zoom img { max-width: none; max-height: none; }
    .ve-lienzo iframe { width: 100%; height: 100%; border: 0; background: var(--card-bg); }
    .ve-otro { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-5); font-size: var(--fs-sm);
      color: var(--fg-2); border: 1px dashed var(--border-color); border-radius: var(--r-md); text-decoration: none; }
    .ve-otro .pi { font-size: 1.6rem; }
    .ve-fallo { font-size: var(--fs-sm); color: var(--warn-soft-fg); }

    .ve-flecha { align-self: center; flex: none; width: 2.75rem; height: 2.75rem; margin: 0 var(--sp-2); border-radius: 50%;
      border: 1px solid var(--border-color); background: var(--card-bg); color: var(--fg-1); cursor: pointer;
      display: grid; place-items: center; }
    .ve-flecha:hover { border-color: var(--action); color: var(--action); }

    .ve-tira { display: flex; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); overflow-x: auto;
      border-top: 1px solid var(--border-color); background: var(--card-bg); }
    .ve-mini { flex: none; width: 6.5rem; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 4px;
      border: 1px solid var(--border-color); border-radius: var(--r-sm); background: transparent; cursor: pointer;
      font: inherit; font-size: var(--fs-nano); color: var(--fg-2); }
    .ve-mini img { width: 100%; height: 3.5rem; object-fit: cover; border-radius: 2px; }
    .ve-mini .pi { font-size: 1.6rem; height: 3.5rem; display: grid; place-items: center; color: var(--fg-3); }
    .ve-mini span { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
    .ve-mini.on { border-color: var(--action); color: var(--fg-1); box-shadow: inset 0 0 0 1px var(--action); }

    @media (prefers-reduced-motion: reduce) { .ve-lienzo img { transition: none; } }
  `],
})
export class VisorEvidenciaComponent {
  readonly open = model(false);
  readonly docs = input<readonly DocEvidencia[]>([]);
  /** En qué archivo abrir; el visor lo mueve con las flechas. */
  readonly indice = model(0);
  /** Para saber de qué vale es sin cerrar el visor (folio · importe). */
  readonly titulo = input<string>('');

  readonly zoomMin = ZOOM_MIN;
  readonly zoomMax = ZOOM_MAX;
  readonly zoom = signal(1);
  readonly giro = signal(0);
  private readonly fallidosSet = signal<ReadonlySet<string>>(new Set());
  readonly fallidos = this.fallidosSet.asReadonly();

  readonly actual = computed<DocEvidencia | null>(() => {
    const d = this.docs();
    if (!d.length) return null;
    return d[Math.min(Math.max(0, this.indice()), d.length - 1)];
  });

  constructor() {
    // Cada archivo arranca derecho y a su tamaño: el acercamiento de una foto no se arrastra a la siguiente.
    effect(() => { this.indice(); this.zoom.set(1); this.giro.set(0); }, { allowSignalWrites: true });
    /**
     * Esc cierra SÓLO el visor y regresa al vale. El panel lateral (y el diálogo) también escuchan
     * Esc en el documento: medido en la maqueta, un Esc cerraba los dos y la persona perdía el vale.
     * Por eso se toma en la fase de CAPTURA, antes que ellos, y se detiene ahí.
     */
    const doc = inject(DOCUMENT);
    const alEsc = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !this.open()) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.open.set(false);
    };
    doc.addEventListener('keydown', alEsc, true);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('keydown', alEsc, true));
  }

  ir(i: number): void {
    const n = this.docs().length;
    if (n) this.indice.set(((i % n) + n) % n);
  }
  anterior(): void { this.ir(this.indice() - 1); }
  siguiente(): void { this.ir(this.indice() + 1); }
  acercar(): void { this.zoom.update((z) => Math.min(ZOOM_MAX, z + ZOOM_PASO)); }
  alejar(): void { this.zoom.update((z) => Math.max(ZOOM_MIN, z - ZOOM_PASO)); }
  tamanoNormal(): void { this.zoom.set(1); }
  girar(): void { this.giro.update((g) => (g + 90) % 360); }
  fallo(url: string): void { this.fallidosSet.update((s) => new Set(s).add(url)); }

  /** El teclado sólo manda mientras el visor está abierto, y no le roba teclas a un campo de texto. */
  @HostListener('document:keydown', ['$event'])
  tecla(ev: KeyboardEvent): void {
    if (!this.open()) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const d = this.actual();
    const imagen = !!d && !d.isPdf && !d.esOtro;
    switch (ev.key) {
      case 'ArrowLeft': this.anterior(); break;
      case 'ArrowRight': this.siguiente(); break;
      case '+': case '=': if (imagen) this.acercar(); else return; break;
      case '-': if (imagen) this.alejar(); else return; break;
      case '0': if (imagen) this.tamanoNormal(); else return; break;
      case 'r': case 'R': if (imagen) this.girar(); else return; break;
      default: return;
    }
    ev.preventDefault();
  }
}
