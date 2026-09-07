import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, model, signal, viewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { TooltipModule } from 'primeng/tooltip';

/** Una hoja del expediente. Coincide en forma con `ProofFile` (compras) sin acoplarse a él. */
export interface DocViewerFile {
  url: string;
  name?: string | null;
  role?: string | null;
  /** `image` · `pdf` · `raw` · un mime. Si falta, se deduce de la extensión de la URL. */
  kind?: string | null;
}

/** Pasos de zoom. Discretos a propósito: un slider en un escaneo no sirve para nada. */
const ZOOMS = [50, 75, 100, 125, 150, 200, 300, 400] as const;

/**
 * `[RE.17.1]` — **Visor de documento** compartido (DESIGN §O.1 + §datos densos 8).
 *
 * El expediente de una recepción se decide comparando el papel del proveedor contra las cifras.
 * Hasta acá cada pantalla resolvía el papel por su cuenta con un `<iframe>` pelado de 64vh: sin
 * elegir hoja, sin zoom, sin rotar, sin páginas y sin manera de agrandarlo. Una remisión escrita
 * a mano y escaneada torcida no se lee así.
 *
 * **Sin librería nueva** (checklist 3 + 16, y la decisión de licencia de PrimeNG está abierta):
 *
 *  - **PDF** → el visor nativo del navegador, manejado por *fragment params* (`#page`, `#zoom`,
 *    `#view`). Chrome/Edge (PDFium) y Firefox (pdf.js) los honran, también al cambiar el hash de
 *    un documento ya cargado. Si un navegador los ignorara, **su propia barra sigue ahí**: la
 *    degradación es a "como estaba antes", nunca a "no se puede leer".
 *  - **Imagen** → `transform` CSS (el navegador no ofrece nada) dentro de un escenario con
 *    scroll, así el zoom se acompaña de paneo.
 *  - **Rotar** → `transform` en el envoltorio, para los dos. Es lo único que el fragment no cubre.
 *
 * **Pantalla completa por Fullscreen API y no por `position: fixed`**: este visor vive dentro del
 * `SidePeek`, cuyo panel tiene `transform: translateX(...)` — un ancestro transformado es bloque
 * contenedor de sus descendientes fijos, así que un overlay "a pantalla completa" quedaría
 * atrapado dentro del cajón. `requestFullscreen()` escapa de eso y del apilamiento. Si el
 * navegador lo rechaza (permisos, iframe sandbox), cae a expandirse dentro de su contenedor.
 *
 * `@container` y no `@media` (checklist 9): el mismo visor se embebe en el aside angosto de la
 * bandeja de revisión y en el side-peek ancho de Órdenes.
 */
@Component({
  selector: 'app-doc-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgClass, TooltipModule],
  template: `
    <div class="dv" [class.is-grown]="grown()" tabindex="0" (keydown)="onKey($event)"
         role="group" [attr.aria-label]="'Visor de documento' + (actual()?.name ? ': ' + actual()!.name : '')">

      <header class="dv-bar">
        @if (files().length > 1) {
          <!-- Las hojas son pestañas de verdad: el expediente de una factura son 2–4 hojas y
               elegir cuál se mira ES parte del trabajo. -->
          <div class="dv-tabs" role="tablist" aria-label="Hojas del expediente">
            @for (f of files(); track f.url; let i = $index) {
              <button type="button" role="tab" class="dv-tab" [class.on]="i === idx()"
                      [attr.aria-selected]="i === idx()" [attr.tabindex]="i === idx() ? 0 : -1"
                      (click)="ver(i)" [pTooltip]="f.name || ''" tooltipPosition="bottom">
                <i class="pi" [ngClass]="esImagenDe(f) ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
                <span class="dv-tab-t">{{ etiqueta(f, i) }}</span>
              </button>
            }
          </div>
        } @else if (actual(); as f) {
          <span class="dv-name" [attr.title]="f.name || ''">
            <i class="pi" [ngClass]="esImagen() ? 'pi-image' : 'pi-file-pdf'" aria-hidden="true"></i>
            <span class="dv-tab-t">{{ f.name || (esImagen() ? 'foto' : 'PDF') }}</span>
          </span>
        }

        <span class="dv-sp"></span>

        @if (actual()) {
          <div class="dv-ctl" role="group" aria-label="Controles">
            @if (!esImagen()) {
              <div class="dv-grp">
                <button type="button" class="dv-b" [disabled]="pagina() <= 1" (click)="irPagina(pagina() - 1)"
                        aria-label="Página anterior" pTooltip="Página anterior (←)" tooltipPosition="bottom">
                  <i class="pi pi-chevron-left" aria-hidden="true"></i>
                </button>
                <!-- Sin total: no se puede saber cuántas páginas tiene un PDF sin montar un
                     parser. Inventar un "de N" sería peor que no decirlo. -->
                <span class="dv-pg" aria-live="polite">pág. <b>{{ pagina() }}</b></span>
                <button type="button" class="dv-b" (click)="irPagina(pagina() + 1)"
                        aria-label="Página siguiente" pTooltip="Página siguiente (→)" tooltipPosition="bottom">
                  <i class="pi pi-chevron-right" aria-hidden="true"></i>
                </button>
              </div>
            }

            <div class="dv-grp">
              <button type="button" class="dv-b" [disabled]="!puedeAlejar()" (click)="zoomOut()"
                      aria-label="Alejar" pTooltip="Alejar (−)" tooltipPosition="bottom">
                <i class="pi pi-search-minus" aria-hidden="true"></i>
              </button>
              <button type="button" class="dv-z" (click)="ajustar()"
                      [attr.aria-label]="'Zoom ' + etiquetaZoom() + '. Volver a ajustar'"
                      pTooltip="Ajustar al ancho (0)" tooltipPosition="bottom">{{ etiquetaZoom() }}</button>
              <button type="button" class="dv-b" [disabled]="!puedeAcercar()" (click)="zoomIn()"
                      aria-label="Acercar" pTooltip="Acercar (+)" tooltipPosition="bottom">
                <i class="pi pi-search-plus" aria-hidden="true"></i>
              </button>
            </div>

            <div class="dv-grp">
              <button type="button" class="dv-b" [class.on]="rot() !== 0" (click)="rotar()"
                      [attr.aria-label]="'Rotar. Ahora en ' + rot() + ' grados'"
                      pTooltip="Rotar 90° (R)" tooltipPosition="bottom">
                <i class="pi pi-replay dv-flip" aria-hidden="true"></i>
              </button>
              <button type="button" class="dv-b" [class.on]="grown()" (click)="alternarGrande()"
                      [attr.aria-label]="grown() ? 'Salir de pantalla completa' : 'Ver a pantalla completa'"
                      [pTooltip]="grown() ? 'Salir (Esc)' : 'Pantalla completa (F)'" tooltipPosition="bottom">
                <i class="pi" [ngClass]="grown() ? 'pi-window-minimize' : 'pi-window-maximize'" aria-hidden="true"></i>
              </button>
              <a class="dv-b" [href]="actual()!.url" target="_blank" rel="noopener"
                 aria-label="Abrir en una pestaña nueva" pTooltip="Abrir en pestaña" tooltipPosition="bottom">
                <i class="pi pi-external-link" aria-hidden="true"></i>
              </a>
            </div>
          </div>
        }
      </header>

      <div class="dv-stage" #stage [class.is-rot]="rot() === 90 || rot() === 270">
        @if (!actual()) {
          <!-- Empty operacional (§Operations 4): dice qué falta y qué hacer, no "sin datos". -->
          <div class="dv-empty">
            <i class="pi pi-file" aria-hidden="true"></i>
            <p class="dv-empty-t">{{ emptyTitle() }}</p>
            <p class="dv-empty-s">{{ emptyHint() }}</p>
          </div>
        } @else if (roto()) {
          <div class="dv-empty">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <p class="dv-empty-t">No se pudo abrir la hoja</p>
            <p class="dv-empty-s">El enlace pudo haber vencido. Recargá la pantalla, o abrila en una pestaña.</p>
            <a class="dv-empty-a" [href]="actual()!.url" target="_blank" rel="noopener">Abrir en pestaña</a>
          </div>
        } @else if (esImagen()) {
          <img class="dv-img" [src]="actual()!.url" [alt]="actual()!.name || 'Documento de la entrada'"
               [style.transform]="cssTransform()" (error)="roto.set(true)" />
        } @else {
          <!-- La llave del bucle es la URL de la hoja: el iframe se recrea al CAMBIAR de hoja,
               no al mover el zoom (ahí sólo cambia el fragment, que es navegación interna). -->
          @for (k of [claveHoja()]; track k) {
            <iframe class="dv-frame" [src]="safeSrc()" [style.transform]="cssTransform()"
                    [title]="actual()!.name || 'Documento de la entrada'" (error)="roto.set(true)"></iframe>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 0; height: 100%; }

    .dv {
      container-type: inline-size;
      display: flex; flex-direction: column; min-height: 0; height: 100%;
      border: 1px solid var(--border-color); border-radius: var(--r-md, .75rem);
      background: var(--card-bg); overflow: hidden;
    }
    .dv:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }

    /* Pantalla completa: la clase sólo pinta; quien saca el elemento de su contenedor es la
       Fullscreen API. Cuando ésta no está disponible, la clase is-grown sin :fullscreen deja
       igual un visor mucho más alto dentro de su propio panel — degradación útil, no rota. */
    .dv.is-grown { border-radius: 0; min-height: 70vh; }
    .dv:fullscreen { border: 0; border-radius: 0; background: var(--card-bg); }

    /* ── barra ─────────────────────────────────────────────────────────── */
    .dv-bar {
      display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;
      padding: var(--sp-1) var(--sp-2);
      border-bottom: 1px solid var(--border-color); background: var(--card-bg); flex: none;
    }
    .dv-sp { flex: 1 1 auto; }

    .dv-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; }
    .dv-tab, .dv-name {
      display: inline-flex; align-items: center; gap: var(--sp-1);
      max-width: 12rem; padding: .25rem .45rem;
      font-size: var(--fs-xs); color: var(--text-muted);
      background: none; border: 0; border-radius: var(--r-sm, .5rem); cursor: pointer;
      white-space: nowrap;
    }
    .dv-name { cursor: default; }
    .dv-tab-t { overflow: hidden; text-overflow: ellipsis; }
    .dv-tab:hover { background: var(--overlay-hover); color: var(--text-main); }
    .dv-tab.on { color: var(--text-main); font-weight: 600; background: var(--overlay-selected); }
    .dv-tab:focus-visible, .dv-b:focus-visible, .dv-z:focus-visible {
      outline: 2px solid var(--action); outline-offset: 1px;
    }

    .dv-ctl { display: flex; align-items: center; gap: var(--sp-2); }
    /* Los controles se agrupan por trabajo (páginas · zoom · vista) y el hairline separa los
       grupos: 8 iconos en fila corrida se leen como una sola papilla. */
    .dv-grp { display: flex; align-items: center; gap: 1px; }
    .dv-grp + .dv-grp { padding-left: var(--sp-2); border-left: 1px solid var(--border-color); }

    .dv-b {
      display: inline-flex; align-items: center; justify-content: center;
      width: 1.75rem; height: 1.75rem;
      color: var(--text-muted); background: none; border: 0; border-radius: var(--r-sm, .5rem);
      cursor: pointer; text-decoration: none;
      transition: background var(--dur-micro, 120ms) var(--ease-out), color var(--dur-micro, 120ms) var(--ease-out);
    }
    .dv-b:hover:not(:disabled) { background: var(--overlay-hover); color: var(--text-main); }
    .dv-b:disabled { opacity: .35; cursor: default; }
    .dv-b.on { color: var(--action); background: var(--overlay-selected); }
    .dv-b .pi { font-size: .8rem; }
    /* El icono de "recargar" gira al revés que la rotación que aplica: espejado queda horario. */
    .dv-flip { transform: scaleX(-1); }

    .dv-z, .dv-pg {
      min-width: 3.1rem; padding: 0 .3rem;
      font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-micro); color: var(--text-muted); text-align: center;
      background: none; border: 0; cursor: pointer; white-space: nowrap;
    }
    .dv-pg { cursor: default; }
    .dv-pg b { color: var(--text-main); }
    .dv-z:hover { color: var(--text-main); }

    /* ── escenario ─────────────────────────────────────────────────────── */
    /* Fondo tokenizado y NO un negro con alpha: sobre tema oscuro un #00000010 no existe, y
       el marco de la hoja desaparecía justo donde tiene que contrastar con el papel blanco. */
    .dv-stage {
      flex: 1 1 auto; min-height: 0; position: relative;
      display: flex; align-items: center; justify-content: center;
      padding: var(--sp-2); overflow: auto;
      background: var(--surface-ground);
    }
    .dv-frame {
      width: 100%; height: 100%; min-height: 22rem; border: 0; border-radius: var(--r-sm, .5rem);
      /* La hoja es blanca en los dos temas: es papel, no superficie de la app. */
      background: #fff;
      transform-origin: center center;
      transition: transform var(--dur-short, 150ms) var(--ease-out);
    }
    .dv-img {
      max-width: 100%; max-height: 100%; object-fit: contain;
      border-radius: var(--r-sm, .5rem); background: #fff;
      transform-origin: center center;
      transition: transform var(--dur-short, 150ms) var(--ease-out);
    }
    /* Rotado a 90/270 el alto útil es el ancho: sin esto la hoja se sale del escenario. */
    .dv-stage.is-rot .dv-frame { width: 100%; height: 100%; }

    @media (prefers-reduced-motion: reduce) {
      .dv-frame, .dv-img { transition: none; }
    }

    .dv-empty {
      display: flex; flex-direction: column; align-items: center; gap: var(--sp-1);
      color: var(--text-faint); text-align: center; padding: var(--sp-4);
    }
    .dv-empty .pi { font-size: 1.4rem; }
    .dv-empty-t { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); font-weight: 600; }
    .dv-empty-s { margin: 0; font-size: var(--fs-xs); max-width: 26rem; }
    .dv-empty-a { margin-top: var(--sp-2); font-size: var(--fs-xs); color: var(--action); }

    /* Angosto (aside de la bandeja): las etiquetas de hoja se van y quedan los iconos, que es
       lo que sobrevive. Es container y no media: el mismo visor va en un panel de 24rem y en
       un side-peek de 60rem dentro de la MISMA ventana. */
    @container (max-width: 30rem) {
      .dv-tab { max-width: 2rem; padding: .25rem; }
      .dv-tab-t { display: none; }
      .dv-name .dv-tab-t { display: inline; max-width: 8rem; }
      .dv-grp + .dv-grp { padding-left: var(--sp-1); }
      .dv-z, .dv-pg { min-width: 2.6rem; }
    }
  `],
})
export class DocViewerComponent {
  /** Hojas del expediente, en el orden en que se subieron. */
  readonly files = input<DocViewerFile[]>([]);
  /** Hoja visible. `model` para que la pantalla pueda dirigirlo (ej. "mostrame la factura"). */
  readonly idx = model(0);
  readonly emptyTitle = input('Sin hoja para mostrar');
  readonly emptyHint = input('Elegí una hoja del expediente para verla acá.');

  private readonly sanitizer = inject(DomSanitizer);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly stage = viewChild<ElementRef<HTMLElement>>('stage');

  /** `null` = ajustar al ancho (default). Un número = porcentaje explícito. */
  private readonly zoom = signal<number | null>(null);
  readonly rot = signal(0);
  readonly pagina = signal(1);
  readonly grown = signal(false);
  readonly roto = signal(false);

  readonly actual = computed<DocViewerFile | null>(() => this.files()[this.idx()] ?? null);
  readonly esImagen = computed(() => { const f = this.actual(); return !!f && this.esImagenDe(f); });
  /** Cambia sólo al cambiar de hoja: es la llave que recrea el `<iframe>`. */
  readonly claveHoja = computed(() => this.actual()?.url ?? '');

  constructor() {
    // Cambiar de hoja arranca de cero: el zoom y la rotación de la anterior no dicen nada de
    // ésta, y heredarlos se siente como que el visor "se descompuso".
    effect(() => {
      this.claveHoja();
      this.zoom.set(null);
      this.rot.set(0);
      this.pagina.set(1);
      this.roto.set(false);
    });

    // El botón y la tecla dejan de mentir si el usuario sale del modo pantalla completa con la
    // Escape del navegador (que no llega como keydown a la página).
    const el = this.host.nativeElement as HTMLElement;
    const onFs = () => this.grown.set(document.fullscreenElement === this.viewerEl());
    el.ownerDocument.addEventListener('fullscreenchange', onFs);
    inject(DestroyRef).onDestroy(() => el.ownerDocument.removeEventListener('fullscreenchange', onFs));
  }

  private viewerEl(): HTMLElement | null {
    return (this.host.nativeElement as HTMLElement).querySelector('.dv');
  }

  esImagenDe(f: DocViewerFile): boolean {
    const k = (f.kind || '').toLowerCase();
    if (k === 'image' || /(jpe?g|png|webp|gif)/.test(k)) return true;
    if (k === 'pdf' || k === 'raw') return false;
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url || '');
  }

  /** Nombre corto para la pestaña: el rol dice más que `escaneo_0004821.pdf`. */
  etiqueta(f: DocViewerFile, i: number): string {
    const rol = (f.role || '').replace(/_/g, ' ').trim();
    if (rol && rol !== 'evidencia') return rol;
    return f.name || `Hoja ${i + 1}`;
  }

  ver(i: number): void { this.idx.set(i); }

  // ── zoom / rotación / páginas ────────────────────────────────────────
  etiquetaZoom(): string { const z = this.zoom(); return z == null ? 'ajus.' : `${z}%`; }
  private nivel(): number {
    const z = this.zoom();
    return z == null ? ZOOMS.indexOf(100) : Math.max(0, ZOOMS.findIndex((v) => v >= z));
  }
  puedeAcercar(): boolean { return this.nivel() < ZOOMS.length - 1; }
  puedeAlejar(): boolean { return this.zoom() == null || this.nivel() > 0; }
  zoomIn(): void { if (this.puedeAcercar()) this.zoom.set(ZOOMS[this.nivel() + 1]); }
  zoomOut(): void {
    if (this.zoom() == null) { this.zoom.set(ZOOMS[Math.max(0, ZOOMS.indexOf(100) - 1)]); return; }
    if (this.nivel() > 0) this.zoom.set(ZOOMS[this.nivel() - 1]);
  }
  ajustar(): void { this.zoom.set(null); this.stage()?.nativeElement.scrollTo({ top: 0, left: 0 }); }
  rotar(): void { this.rot.set((this.rot() + 90) % 360); }
  irPagina(n: number): void { this.pagina.set(Math.max(1, n)); }

  /** Escala + giro. En PDF la escala la lleva el fragment; acá va sólo el giro. */
  cssTransform(): string {
    const giro = this.rot() ? `rotate(${this.rot()}deg)` : '';
    if (!this.esImagen()) return giro || 'none';
    const z = this.zoom();
    const escala = z == null ? '' : `scale(${z / 100})`;
    return [giro, escala].filter(Boolean).join(' ') || 'none';
  }

  /**
   * URL + fragment para el visor nativo. `bypassSecurityTrustResourceUrl` es seguro acá: la URL
   * viene prefirmada por nuestro backend, **nunca** de input del usuario (checklist 10).
   */
  safeSrc(): SafeResourceUrl | null {
    const f = this.actual();
    if (!f) return null;
    const z = this.zoom();
    const frag = [
      `page=${this.pagina()}`,
      z == null ? 'view=FitH' : `zoom=${z}`,
      // La barra nativa se queda: es la red de seguridad si el navegador ignorara el fragment.
      'toolbar=1',
    ].join('&');
    return this.sanitizer.bypassSecurityTrustResourceUrl(`${f.url.split('#')[0]}#${frag}`);
  }

  // ── pantalla completa ────────────────────────────────────────────────
  alternarGrande(): void {
    const el = this.viewerEl();
    if (!el) return;
    if (document.fullscreenElement === el) { void document.exitFullscreen?.(); return; }
    // `.then/.catch` y no `await`: si el navegador la rechaza (sandbox, política de permisos),
    // el visor igual crece dentro de su panel en vez de no hacer nada.
    const p = el.requestFullscreen?.();
    if (p) p.then(() => this.grown.set(true)).catch(() => this.grown.set(true));
    else this.grown.set(!this.grown());
  }

  // ── teclado (§7 keyboard-first) ──────────────────────────────────────
  /**
   * Todo lo que este visor atiende **deja de burbujear**. Las pantallas que lo embeben tienen
   * sus propios atajos de una tecla en `document` —en la bandeja de revisión, `r` devuelve la
   * factura a la sucursal— y sin esto, rotar la hoja abriría el diálogo de devolución.
   */
  onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    const pdf = !this.esImagen();
    const tomar = () => { e.preventDefault(); e.stopPropagation(); };

    if (k === '+' || k === '=') { tomar(); this.zoomIn(); return; }
    if (k === '-' || k === '_') { tomar(); this.zoomOut(); return; }
    if (k === '0') { tomar(); this.ajustar(); return; }
    if (k === 'r' || k === 'R') { tomar(); this.rotar(); return; }
    if (k === 'f' || k === 'F') { tomar(); this.alternarGrande(); return; }
    if (k === 'ArrowLeft') {
      tomar();
      if (pdf) this.irPagina(this.pagina() - 1); else this.ver(Math.max(0, this.idx() - 1));
      return;
    }
    if (k === 'ArrowRight') {
      tomar();
      if (pdf) this.irPagina(this.pagina() + 1); else this.ver(Math.min(this.files().length - 1, this.idx() + 1));
      return;
    }
    // Escape sólo se consume cuando hay algo que cerrar acá: si burbujeara, el side-peek que
    // contiene al visor se cerraría junto con el modo grande y se pierde el expediente por
    // querer achicar la hoja. Sin modo grande, Escape es del contenedor.
    if (k === 'Escape' && this.grown()) { tomar(); this.alternarGrande(); }
  }
}
