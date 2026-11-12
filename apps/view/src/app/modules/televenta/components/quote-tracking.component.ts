import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { QuotesService, type PasoSeguimiento, type SeguimientoCotizacion } from '../quotes.service';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `2026-11-11` → «11 nov» · `2026-11-11 16:49` → «11 nov 16:49». */
export function fechaCorta(v: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/.exec(v ?? '');
  if (!m) return v ?? '';
  return `${Number(m[3])} ${MESES[Number(m[2]) - 1]}${m[4] ? ' ' + m[4] : ''}`;
}

/**
 * La respuesta en una línea: dónde va el pedido y qué sigue. Lo primero que el vendedor viene a buscar.
 * Una factura cancelada sin refactura se dice: es justo el caso que hay que vigilar (Canindo, 06UD4101-0001823).
 */
export function respuesta(pasos: PasoSeguimiento[]): { ahora: string; sigue: string | null } {
  const hechos = pasos.filter((p) => p.hecho);
  const ultimo = hechos[hechos.length - 1];
  const siguiente = pasos.find((p) => !p.hecho) ?? null;
  if (!ultimo) return { ahora: 'Sin avance en Kepler', sigue: null };
  const fac = pasos.find((p) => p.clave === 'facturado');
  const cancelada = fac && !fac.hecho ? fac.documentos.find((d) => d.cancelado) : undefined;
  const ahora = `${ultimo.titulo}${ultimo.cuando ? ' · ' + fechaCorta(ultimo.cuando) : ''}`;
  if (cancelada) return { ahora, sigue: `La factura ${cancelada.documento} se canceló y falta refacturar` };
  return { ahora, sigue: siguiente ? `Sigue: ${siguiente.titulo.toLowerCase()}` : null };
}

/**
 * `[GP.9.1]` Seguimiento del pedido de la cotización: Pedido → Autorizado → Surtido → Checado →
 * Embarcado → Facturado, debajo de «Pedido en Kepler». Contesta UNA pregunta: ¿dónde va mi pedido?
 *
 * Jerarquía: primario = el paso en que va (y qué sigue) · secundario = la lista de pasos con su
 * fecha y documento · terciario = quién (clave de Kepler) y las notas de lo que Kepler no guarda.
 * Arriba de todo, sólo si existen, lo que pide actuar: un pedido que quizá no es éste, y los
 * hallazgos abiertos de la revisión TM (factura distinta al embarque, caja cambiada).
 *
 * Nada se rellena: sin hora en Kepler no hay hora; sin responsable se dice «Kepler no registró quién».
 */
@Component({
  selector: 'app-quote-tracking',
  standalone: true,
  imports: [CurrencyPipe, RouterModule, ButtonModule, LoadStateComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="seg" aria-labelledby="seg-titulo">
      <div class="seg-head">
        <h3 id="seg-titulo" class="seg-titulo">Seguimiento del pedido</h3>
        @if (dato(); as d) { <app-freshness-pill measures="fetch" [since]="d.leido_en" /> }
        <button pButton type="button" class="p-button-text p-button-sm seg-recargar" [disabled]="cargando()"
                (click)="cargar()" aria-label="Volver a leer el seguimiento de Kepler">
          <span class="p-button-icon pi pi-refresh" [class.pi-spin]="cargando()" aria-hidden="true"></span>
        </button>
      </div>

      <app-load-state [loading]="cargando() && !dato()" [error]="error()" [skeletonRows]="6"
                      errorTitle="No se pudo leer el seguimiento" [isEmpty]="vacio()"
                      emptyIcon="pi-clock" emptyTitle="Kepler todavía no trae el pedido"
                      emptyHint="Se escribió en Kepler; la réplica lo trae en unos minutos. Vuelve a leer en un momento."
                      (retry)="cargar()">
        @if (dato(); as d) {
          @if (d.pedido?.identidad === 'dudosa') {
            <p class="seg-aviso seg-aviso--warn" role="alert">
              <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
              <span>El pedido {{ d.pedido!.documento }} ya no trae esta cotización en sus comentarios y es de otro cliente:
                alguien lo editó en Kepler o no es el mismo pedido. Revísalo antes de darlo por bueno.</span>
            </p>
          }
          @for (h of d.hallazgos; track $index) {
            <p class="seg-aviso seg-aviso--bad" role="status">
              <i class="pi pi-flag" aria-hidden="true"></i>
              <span><b>{{ h.titulo }}</b> {{ h.resumen }}
                @if (h.importe !== null) { <span class="seg-num">· en juego {{ h.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> }</span>
            </p>
          }

          @if (resp(); as r) {
            <p class="seg-ahora">{{ r.ahora }}</p>
            @if (r.sigue) { <p class="seg-sigue" [class.seg-sigue--bad]="r.sigue.startsWith('La factura')">{{ r.sigue }}</p> }
          }

          <ol class="seg-pasos">
            @for (p of d.pasos; track p.clave) {
              <li class="seg-paso" [class.is-hecho]="p.hecho">
                <i class="pi seg-ic" [class.pi-check-circle]="p.hecho" [class.pi-circle]="!p.hecho" aria-hidden="true"></i>
                <div class="seg-cuerpo">
                  <div class="seg-linea">
                    <span class="seg-nombre">{{ p.titulo }}<span class="sr-only">{{ p.hecho ? ': hecho' : ': pendiente' }}</span></span>
                    @if (p.cuando) { <span class="seg-cuando">{{ fecha(p.cuando) }}</span> }
                  </div>
                  @if (p.quien) { <span class="seg-quien">{{ p.quien }}</span> }
                  @else if (p.sin_responsable) { <span class="seg-quien">Kepler no registró quién</span> }
                  @for (doc of p.documentos; track doc.documento) {
                    <span class="seg-doc" [class.is-cancelado]="doc.cancelado">
                      @if (p.clave === 'facturado' && !doc.cancelado && veFacturas()) {
                        <a class="mono" [routerLink]="['/telemarketing/documentos']" [queryParams]="{ doc: d.pedido!.sucursal + doc.documento }"
                           [attr.aria-label]="'Abrir la factura ' + doc.documento + ' en Facturación TM'">{{ doc.documento }}</a>
                      } @else {
                        <span class="mono">{{ doc.documento }}</span>
                      }
                      @if (doc.cancelado) { <span class="seg-tag">cancelada</span> }
                      @else if (p.clave === 'facturado' && doc.importe !== null) {
                        <span class="seg-num">{{ doc.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
                      }
                    </span>
                  }
                </div>
              </li>
            }
          </ol>
          <p class="seg-nota">Kepler no guarda la hora del surtido ni del checado; aparece cuando el almacén los marca en la Suite.
            Quién se muestra como la clave que capturó Kepler.</p>
        }
      </app-load-state>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .seg { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border-top: 1px solid var(--border-color); }
    .seg-head { display: flex; align-items: center; gap: var(--sp-2); }
    .seg-titulo { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--text-muted); flex: 1 1 auto; }
    .seg-recargar { flex: none; }
    .seg-ahora { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--text-main); font-variant-numeric: tabular-nums; }
    .seg-sigue { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
    .seg-sigue--bad { color: var(--bad-fg); font-weight: var(--fw-medium); }
    .seg-aviso { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0; padding: var(--sp-2) var(--sp-3);
                 border-radius: var(--r-sm); font-size: var(--fs-sm); line-height: 1.4; }
    .seg-aviso i { margin-top: 2px; flex: none; }
    .seg-aviso--warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); border: 1px solid var(--warn-border); }
    .seg-aviso--bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); border: 1px solid var(--bad-border); }
    .seg-pasos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .seg-paso { display: flex; gap: var(--sp-2); align-items: flex-start; color: var(--text-faint); }
    .seg-paso.is-hecho { color: var(--text-main); }
    .seg-ic { margin-top: 2px; flex: none; font-size: var(--fs-sm); }
    .seg-paso.is-hecho .seg-ic { color: var(--ok-fg); }
    .seg-cuerpo { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
    .seg-linea { display: flex; gap: var(--sp-2); justify-content: space-between; align-items: baseline; }
    .seg-nombre { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
    .seg-cuando { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .seg-quien { font-size: var(--fs-xs); color: var(--text-muted); }
    .seg-doc { display: flex; gap: var(--sp-2); align-items: baseline; font-size: var(--fs-xs); flex-wrap: wrap; }
    .seg-doc.is-cancelado .mono { text-decoration: line-through; color: var(--text-faint); }
    .seg-tag { font-size: var(--fs-xs); color: var(--bad-fg); font-weight: var(--fw-medium); }
    .seg-num { font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .seg-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-faint); line-height: 1.4; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  `],
})
export class QuoteTrackingComponent implements OnInit {
  private readonly svc = inject(QuotesService);
  private readonly perms = inject(PermissionsService);

  readonly quoteId = input.required<string>();

  readonly dato = signal<SeguimientoCotizacion | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** Kepler aún no trae el pedido (la réplica tarda minutos): estado vacío, no error. */
  readonly vacio = computed(() => !!this.dato()?.pendiente_replica);
  readonly resp = computed(() => {
    const d = this.dato();
    return d && d.pasos.length ? respuesta(d.pasos) : null;
  });
  /** La factura abre en Facturación TM sólo para quien puede entrar ahí; a los demás se les muestra el folio. */
  readonly veFacturas = computed(() => this.perms.has(Permission.COMMERCIAL_SALES_DOCS_VER));

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.svc.tracking(this.quoteId()).subscribe({
      next: (r) => { this.dato.set(r); this.error.set(null); this.cargando.set(false); },
      error: (err) => { this.error.set(err?.error?.message || 'El servidor no respondió.'); this.cargando.set(false); },
    });
  }

  fecha(v: string | null): string {
    return fechaCorta(v);
  }
}
