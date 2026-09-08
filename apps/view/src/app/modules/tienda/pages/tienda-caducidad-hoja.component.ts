import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';

import { ComercialService, ExpiryHoja } from '../../comercial/comercial.service';
import { clasificarPlazo, plazoSeverity, Plazo } from '../../comercial/expiry-plazo';
import { formatExpiryEcho } from '../../almacen/shared/expiry-short';

/**
 * **La hoja del expediente** — el formato imprimible de UNA caducidad.
 *
 * Cada producto que se da de alta genera esta hoja, con folio propio
 * (`CAD-03-2026-00001`) y quién la levantó, archivada bajo su sucursal. Es el
 * papel que reemplaza al de la carpeta: se imprime, se firma y se archiva.
 *
 * **Por qué CSS de impresión y no un PDF armado a mano:** la hoja ES un
 * documento, y el diálogo de impresión del navegador ya ofrece "Guardar como
 * PDF" en cualquier equipo — sin dependencias nuevas, sin paginar tablas a mano
 * y sin depender del almacenamiento de archivos del servidor (los `S3_*` están
 * vacíos hoy, que es lo mismo que tiene sin subir las fotos de evidencia).
 * Mismo patrón que `/tienda/etiquetas`.
 *
 * `@media print` esconde el chrome de la app (sidebar, header, botones) y deja
 * solo el documento, en A4 con márgenes reales.
 */
@Component({
  selector: 'app-tienda-caducidad-hoja',
  standalone: true,
  imports: [CommonModule, ButtonModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="hoja-wrap">
      <!-- Barra de acciones: no se imprime -->
      <div class="hoja-bar no-print">
        <button pButton [text]="true" severity="secondary" size="small" (click)="volver()">
          <span class="p-button-icon p-button-icon-left pi pi-arrow-left" aria-hidden="true"></span> Volver
        </button>
        <div class="hoja-bar-right">
          @if (hoja(); as h) {
            <button pButton size="small" (click)="imprimir()">
              <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span> Imprimir / Guardar PDF
            </button>
          }
        </div>
      </div>

      @if (cargando()) {
        <div class="hoja-skel no-print" aria-hidden="true"></div>
      } @else if (error()) {
        <div class="hoja-error no-print" role="alert">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <div>
            <h2>No se pudo abrir la hoja</h2>
            <p>{{ error() }}</p>
          </div>
        </div>
      } @else if (hoja(); as h) {
        <!-- ═══════════ El documento ═══════════ -->
        <article class="hoja" [attr.aria-label]="'Hoja de caducidad ' + (h.folio || '')">
          <header class="hoja-head">
            <div class="hoja-head-org">
              <strong class="hoja-org">MEGA DULCES</strong>
              <span class="hoja-doc">Control de Caducidades — Hoja de producto</span>
            </div>
            <div class="hoja-head-folio">
              <span class="hoja-folio-lbl">Folio</span>
              <strong class="hoja-folio">{{ h.folio || '—' }}</strong>
            </div>
          </header>

          <!-- Identificación: sucursal + fecha + quién. Es lo que hace archivable la hoja. -->
          <section class="hoja-ident">
            <div class="hoja-f">
              <span class="hoja-f-lbl">Sucursal</span>
              <span class="hoja-f-val">{{ h.warehouse_name || '—' }} <code>{{ h.warehouse_code }}</code></span>
            </div>
            <div class="hoja-f">
              <span class="hoja-f-lbl">Fecha de levantamiento</span>
              <span class="hoja-f-val hoja-mono">{{ fecha(h.review_date) }}</span>
            </div>
            <div class="hoja-f">
              <span class="hoja-f-lbl">Levantó</span>
              <span class="hoja-f-val">{{ h.levantada_por || h.responsible_name || '—' }}</span>
            </div>
            <div class="hoja-f">
              <span class="hoja-f-lbl">Ubicación</span>
              <span class="hoja-f-val">{{ h.location || '—' }}</span>
            </div>
          </section>

          <!-- El producto y su caducidad: el cuerpo de la hoja -->
          <section class="hoja-body">
            <h2 class="hoja-h2">Producto</h2>
            <table class="hoja-tbl">
              <tbody>
                <tr>
                  <th scope="row">Descripción</th>
                  <td>{{ h.product_name || h.product_name_raw || '—' }}</td>
                </tr>
                <tr>
                  <th scope="row">SKU / Código</th>
                  <td class="hoja-mono">{{ h.sku || h.product_code_raw || '—' }}</td>
                </tr>
                <tr>
                  <th scope="row">Marca</th>
                  <td>{{ h.brand_name || '—' }}</td>
                </tr>
                <tr>
                  <th scope="row">Cantidad</th>
                  <td><span class="hoja-mono hoja-strong">{{ h.quantity }}</span> {{ h.unit || 'pz' }}</td>
                </tr>
                <tr>
                  <th scope="row">Fecha de caducidad</th>
                  <td><span class="hoja-mono hoja-strong">{{ fecha(h.expiry_date) }}</span></td>
                </tr>
                <tr>
                  <th scope="row">Plazo</th>
                  <td>
                    @if (plazo(); as pz) {
                      <strong>{{ pz.title }}</strong> — {{ pz.detail }}
                      <span class="no-print"><p-tag [value]="pz.title" [severity]="sev(pz.level)"></p-tag></span>
                    } @else { — }
                  </td>
                </tr>
                <tr>
                  <th scope="row">Estado físico</th>
                  <td>{{ condicion(h.condition) }}</td>
                </tr>
                <tr>
                  <th scope="row">Observaciones</th>
                  <td>{{ h.observations || '—' }}</td>
                </tr>
                <tr>
                  <th scope="row">Acción / seguimiento</th>
                  <td>{{ h.action || '—' }}</td>
                </tr>
                <tr>
                  <th scope="row">Evidencia fotográfica</th>
                  <td>
                    @if (h.files?.length) { Sí — {{ h.files?.length }} archivo(s) adjunto(s) }
                    @else { No se adjuntó }
                  </td>
                </tr>
                <tr>
                  <th scope="row">Reflejado en inventario</th>
                  <td>
                    @if (h.fed_to_fefo) {
                      Sí — <span class="hoja-mono">{{ h.fefo_qty }}</span> {{ h.unit || 'pz' }} quedaron fechados en el control de caducidad (FEFO)
                    } @else {
                      No — la hoja queda como registro; no movió inventario
                    }
                  </td>
                </tr>
              </tbody>
            </table>

            <!-- La foto se imprime si la hay: es la evidencia del expediente. -->
            @if (h.files?.length) {
              <div class="hoja-fotos">
                @for (f of h.files; track f.url) {
                  @if (f.preview_url || f.url) {
                    <figure class="hoja-foto">
                      <img [src]="f.preview_url || f.url" alt="Evidencia de la caducidad" />
                      <figcaption>Evidencia · {{ h.folio }}</figcaption>
                    </figure>
                  }
                }
              </div>
            }
          </section>

          <!-- Firmas: lo que convierte el registro en expediente -->
          <footer class="hoja-firmas">
            <div class="hoja-firma">
              <span class="hoja-firma-line" aria-hidden="true"></span>
              <span class="hoja-firma-lbl">Quien levantó</span>
              <span class="hoja-firma-nom">{{ h.levantada_por || h.responsible_name || '' }}</span>
            </div>
            <div class="hoja-firma">
              <span class="hoja-firma-line" aria-hidden="true"></span>
              <span class="hoja-firma-lbl">Encargado de sucursal</span>
              <span class="hoja-firma-nom">&nbsp;</span>
            </div>
          </footer>

          <p class="hoja-pie">
            Hoja generada por el sistema el {{ ahora() }} · registro capturado el {{ fechaHora(h.created_at) }} ·
            documento interno de control, sin valor fiscal.
          </p>
        </article>
      }
    </div>
  `,
  styles: [`
    .hoja-wrap { display: grid; gap: 1rem; }
    .hoja-bar { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }

    .hoja-skel { height: 60vh; border-radius: var(--r-md, 8px); background: color-mix(in oklab, var(--ink, #000) 5%, transparent); }
    .hoja-error { display: flex; gap: .9rem; align-items: flex-start; padding: 1rem; border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); }
    .hoja-error > i { font-size: 1.4rem; color: var(--tone-bad, var(--text-muted)); }
    .hoja-error h2 { margin: 0 0 .25rem; font-size: var(--fs-md, 1rem); }
    .hoja-error p { margin: 0; color: var(--c-text-2, var(--text-muted)); font-size: var(--fs-sm, .85rem); }

    /* ── El documento. En pantalla se ve como una hoja; al imprimir ES la hoja. ── */
    .hoja {
      max-width: 48rem; margin: 0 auto; padding: 2rem;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md, 8px);
    }

    .hoja-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
      padding-bottom: .75rem; border-bottom: 2px solid var(--text-main);
    }
    .hoja-head-org { display: grid; gap: .15rem; }
    .hoja-org { font-size: 1.15rem; font-weight: 800; letter-spacing: .02em; }
    .hoja-doc { font-size: var(--fs-sm, .85rem); color: var(--c-text-2, var(--text-muted)); }
    .hoja-head-folio { display: grid; gap: .1rem; justify-items: end; text-align: right; }
    .hoja-folio-lbl { font-size: var(--fs-xs, .7rem); text-transform: uppercase; letter-spacing: .08em; color: var(--c-text-3, var(--text-muted)); }
    .hoja-folio { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: 1.05rem; }

    .hoja-ident {
      display: grid; gap: .6rem 1.25rem; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      padding: .9rem 0; border-bottom: 1px solid var(--border-color);
    }
    .hoja-f { display: grid; gap: .1rem; }
    .hoja-f-lbl { font-size: var(--fs-xs, .7rem); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-3, var(--text-muted)); }
    .hoja-f-val { font-size: var(--fs-sm, .9rem); }
    .hoja-f-val code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--c-text-2, var(--text-muted)); }

    .hoja-body { padding-top: .9rem; }
    .hoja-h2 { margin: 0 0 .5rem; font-size: var(--fs-sm, .85rem); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-3, var(--text-muted)); }

    .hoja-tbl { width: 100%; border-collapse: collapse; }
    .hoja-tbl th, .hoja-tbl td {
      text-align: left; vertical-align: top; padding: .45rem .5rem;
      border-bottom: 1px solid var(--border-color); font-size: var(--fs-sm, .9rem);
    }
    .hoja-tbl th {
      width: 12rem; font-weight: 600; color: var(--c-text-2, var(--text-muted));
      background: color-mix(in oklab, var(--ink, #000) 3%, transparent);
    }
    .hoja-mono { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
    .hoja-strong { font-weight: 700; }

    .hoja-fotos { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1rem; }
    .hoja-foto { margin: 0; display: grid; gap: .25rem; }
    .hoja-foto img { max-width: 14rem; max-height: 14rem; object-fit: contain; border: 1px solid var(--border-color); border-radius: var(--r-sm, 4px); }
    .hoja-foto figcaption { font-size: var(--fs-xs, .7rem); color: var(--c-text-3, var(--text-muted)); }

    .hoja-firmas { display: grid; gap: 2rem; grid-template-columns: 1fr 1fr; margin-top: 3rem; }
    .hoja-firma { display: grid; gap: .2rem; text-align: center; }
    .hoja-firma-line { display: block; height: 1px; background: var(--text-main); margin-bottom: .35rem; }
    .hoja-firma-lbl { font-size: var(--fs-xs, .7rem); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-3, var(--text-muted)); }
    .hoja-firma-nom { font-size: var(--fs-sm, .85rem); }

    .hoja-pie { margin: 1.5rem 0 0; font-size: var(--fs-xs, .7rem); color: var(--c-text-3, var(--text-muted)); text-align: center; }

    /* ═══════════ Impresión ═══════════
       El navegador imprime la página entera, así que hay que apagar el chrome de
       la app. Los colores se fuerzan a tinta sobre papel: los tokens de tema
       oscuro imprimirían un rectángulo negro y gastarían el tóner de la tienda. */
    @media print {
      .no-print { display: none !important; }
      .hoja {
        max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0;
        background: #fff; color: #000;
      }
      .hoja-head { border-bottom-color: #000; }
      .hoja-ident, .hoja-tbl th, .hoja-tbl td { border-color: #999; }
      .hoja-tbl th { background: #f2f2f2; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .hoja-doc, .hoja-f-lbl, .hoja-h2, .hoja-firma-lbl, .hoja-pie, .hoja-foto figcaption, .hoja-f-val code { color: #444; }
      .hoja-firma-line { background: #000; }
      /* La hoja no se debe partir a la mitad ni dejar la firma huérfana. */
      .hoja-tbl tr, .hoja-foto, .hoja-firmas { break-inside: avoid; }
      .hoja-firmas { margin-top: 2.5rem; }
    }
  `],
})
export class TiendaCaducidadHojaComponent {
  private readonly svc = inject(ComercialService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly hoja = signal<ExpiryHoja | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');

  readonly plazo = computed<Plazo | null>(() => {
    const h = this.hoja();
    return h ? clasificarPlazo(this.ymd(h.expiry_date)) : null;
  });

  constructor() {
    // Acepta folio (`CAD-03-2026-00001`) o el id del renglón: el folio es lo que
    // alguien tiene a mano cuando llega con la hoja impresa de la carpeta.
    const key = this.route.snapshot.paramMap.get('folioOrId') || '';
    if (!key) { this.cargando.set(false); this.error.set('No se indicó qué hoja abrir.'); return; }

    this.svc.getExpiryHoja(key)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (h) => { this.hoja.set(h); this.cargando.set(false); },
        error: (e) => {
          this.cargando.set(false);
          this.error.set(e?.error?.message || 'No existe una hoja con ese folio, o es de otra sucursal.');
        },
      });
  }

  imprimir(): void { if (typeof window !== 'undefined') window.print(); }
  volver(): void { this.router.navigate(['/tienda/caducidades/expediente']); }

  ymd(v: string | null | undefined): string {
    const s = String(v || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }
  fecha(v: string | null | undefined): string { return formatExpiryEcho(this.ymd(v)) || '—'; }
  sev(l: Plazo['level']) { return plazoSeverity(l); }

  condicion(c: string | null | undefined): string {
    if (c === 'bueno') return 'Bueno';
    if (c === 'regular') return 'Regular';
    if (c === 'malo') return 'Malo';
    return 'No declarado';
  }

  /** Fecha + hora es-MX. La TZ ya viene normalizada del backend. */
  fechaHora(v: string | null | undefined): string {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  }
  ahora(): string { return new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }); }
}
