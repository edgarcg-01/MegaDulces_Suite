import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import type { LoadGuide, LoadGuidesResponse } from '@megadulces/contracts';
import { money } from '../../../shared/util/money.util';
import { AlmacenPreventaService } from '../almacen-preventa.service';

const pad = (n: number): string => String(n).padStart(2, '0');
const hoyMx = (): string => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return d + '/' + m + '/' + y;
};

/**
 * `[MCP.5]` Guías de carga de preventa, para la CAJA (Fase MCP, ADR-089).
 *
 * El repartidor o el vendedor pesca en su celular los pedidos que se lleva; aquí la cajera ve las
 * guías del día de su sucursal (una por repartidor y ruta) y las imprime para que él las firme
 * (D8). La primera impresión congela la guía; después se reimprime la misma foto.
 */
@Component({
  selector: 'app-almacen-preventa-guias',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TagModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head gc-head">
        <div class="gc-head-text">
          <h1>Guías de carga</h1>
          <span class="gc-meta">Pedidos de preventa que cada repartidor pescó · se imprime una guía por ruta y la firma quien se lleva la carga</span>
        </div>
        <div class="gc-actions">
          <label class="gc-fecha" for="gc-fecha"><span class="muted">Día</span>
            <input pInputText id="gc-fecha" type="date" [ngModel]="fecha()" (ngModelChange)="pickFecha($event)" />
          </label>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="gc-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gc-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }
      @if (msg(); as m) { <p class="gc-msg" [class.gc-bad]="m.mal" role="status">{{ m.texto }}</p> }

      @if (loading() && !data()) { <div class="gc-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="gc-skel-row"></div> }</div> }
      @else if (data(); as d) {
        @if (!d.data.length) {
          <div class="gc-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Nadie ha pescado pedidos de preventa el {{ dmy(d.date) }}. Las guías aparecen aquí cuando el repartidor carga pedidos en su celular.</span></div>
        } @else {
          <div class="gc-foot" aria-label="Resumen del día">
            <span><b class="num">{{ d.data.length }}</b> {{ d.data.length === 1 ? 'guía' : 'guías' }}</span>
            <span><b class="num">{{ porImprimir() }}</b> por imprimir</span>
            <span><b class="num">{{ totalPedidos() }}</b> pedidos</span>
            <span><b class="num">{{ money(totalDia()) }}</b> a liquidar</span>
          </div>
          <div class="gc-list">
            @for (g of d.data; track g.id) {
              <section class="gc-card" [attr.aria-labelledby]="'gc-h-' + g.id">
                <div class="gc-card-h">
                  <div class="gc-card-t">
                    <h2 [id]="'gc-h-' + g.id"><span class="mono">{{ g.folio }}</span> · {{ g.sales_route }}</h2>
                    <span class="muted">{{ g.rider_name || '—' }} · {{ g.branch }} {{ g.branch_name || '' }}</span>
                  </div>
                  <div class="gc-card-r">
                    <p-tag [value]="g.status === 'impresa' ? 'Impresa' : 'Por imprimir'" [severity]="g.status === 'impresa' ? 'success' : 'warn'" class="gc-tag" />
                    <b class="num">{{ money(g.total) }}</b>
                    <button pButton type="button" class="p-button-sm" [class.p-button-outlined]="g.status === 'impresa'" [loading]="imprimiendo() === g.id" [disabled]="!!imprimiendo() || !g.orders.length" (click)="imprimir(g)">
                      <span class="p-button-icon pi pi-print" aria-hidden="true"></span><span class="p-button-label">{{ g.status === 'impresa' ? 'Reimprimir' : 'Imprimir guía' }}</span>
                    </button>
                  </div>
                </div>
                @if (g.status === 'impresa') {
                  <p class="gc-hint">Impresa {{ fechaHora(g.printed_at) }}@if (g.printed_by_name) { por {{ g.printed_by_name }} }@if (g.print_count > 1) { · {{ g.print_count - 1 }} {{ g.print_count === 2 ? 'reimpresión' : 'reimpresiones' }} }. Lo que el repartidor pesque después va en una guía nueva.</p>
                }
                <table class="gc-tbl">
                  <thead><tr><th>Pedido</th><th>Cliente</th><th>Entrega</th><th>Documento Kepler</th><th class="ta-r">Importe</th></tr></thead>
                  <tbody>
                    @for (o of g.orders; track o.order_id) {
                      <tr>
                        <td class="mono">{{ o.code }}</td>
                        <td>{{ o.customer_name || '—' }}@if (o.customer_erp_code) { <span class="muted mono"> · {{ o.customer_erp_code }}</span> }</td>
                        <td class="mono">{{ dmy(o.requested_delivery_date) }}</td>
                        <td class="mono" [class.muted]="!o.folio_digital">{{ o.folio_digital || 'se elige al entregar' }}</td>
                        <td class="ta-r num">{{ money(o.document_total ?? o.total) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          </div>
          <p class="gc-hint">El importe es el del documento de Kepler cuando ya está ligado; si no, el del pedido.</p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .gc-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .gc-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .gc-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .gc-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .gc-fecha { display:inline-flex; align-items:center; gap:.4rem; font-size:var(--fs-sm); }
    .gc-fecha input { height:2.25rem; }
    .gc-foot { display:flex; flex-wrap:wrap; gap:.25rem 1.1rem; padding:.45rem .85rem; margin-bottom:.6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-xs); color:var(--text-muted); }
    .gc-foot b { color:var(--text-main); font-weight:600; }
    .gc-list { display:flex; flex-direction:column; gap:.75rem; }
    .gc-card { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.7rem .85rem; min-width:0; }
    .gc-card-h { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; flex-wrap:wrap; }
    .gc-card-t { display:flex; flex-direction:column; gap:.15rem; min-width:0; }
    .gc-card-t h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .gc-card-t .muted { font-size:var(--fs-sm); }
    .gc-card-r { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; }
    .gc-tbl { width:100%; border-collapse:collapse; margin-top:.5rem; font-size:var(--fs-sm); }
    .gc-tbl th { text-align:left; font-size:var(--fs-xs); color:var(--text-muted); font-weight:600; padding:.3rem .4rem; border-bottom:1px solid var(--border-color); }
    .gc-tbl td { padding:.3rem .4rem; border-bottom:1px dashed var(--border-color); }
    .gc-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.4rem 0 0; }
    .gc-msg { font-size:var(--fs-sm); margin:.2rem 0 .6rem; }
    .gc-bad { color:var(--bad-fg); font-weight:600; }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .gc-tag, :host ::ng-deep .gc-tag .p-tag { font-size:var(--fs-nano); }
    .gc-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .gc-errbox .pi { color:var(--bad-fg); } .gc-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .gc-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .gc-empty .pi { font-size:var(--fs-lg); }
    .gc-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .gc-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:gc-pulse 1.4s ease-in-out infinite; }
    @keyframes gc-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .gc-skel-row { animation:none; } }
  `],
})
export class AlmacenPreventaGuiasComponent implements OnInit {
  private readonly api = inject(AlmacenPreventaService);
  private readonly destroyRef = inject(DestroyRef);
  private listSub: Subscription | null = null;

  readonly skel = Array.from({ length: 4 });
  readonly money = money;
  readonly dmy = dmy;

  readonly fecha = signal(hoyMx());
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<LoadGuidesResponse | null>(null);
  readonly imprimiendo = signal<string | null>(null);
  readonly msg = signal<{ texto: string; mal: boolean } | null>(null);

  readonly porImprimir = computed(() => (this.data()?.data ?? []).filter((g) => g.status === 'abierta').length);
  readonly totalPedidos = computed(() => (this.data()?.data ?? []).reduce((t, g) => t + g.orders.length, 0));
  readonly totalDia = computed(() => (this.data()?.data ?? []).reduce((t, g) => t + g.total, 0));

  ngOnInit(): void {
    this.reload();
    this.destroyRef.onDestroy(() => this.listSub?.unsubscribe());
  }

  pickFecha(v: string): void {
    if (!v) return;
    this.fecha.set(v);
    this.msg.set(null);
    this.reload();
  }

  /** La última consulta manda: una anterior que llegue tarde se cancela. */
  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.listSub?.unsubscribe();
    this.listSub = this.api.listGuides(this.fecha()).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar las guías de carga.'); },
    });
  }

  imprimir(g: LoadGuide): void {
    // La ventana se abre YA, dentro del clic: abrirla al llegar el PDF la bloquearía el navegador.
    const win = window.open('', '_blank');
    this.imprimiendo.set(g.id);
    this.msg.set(null);
    this.api.printGuide(g.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.imprimiendo.set(null);
        const url = URL.createObjectURL(res.body as Blob);
        if (win) {
          win.location.href = url;
        } else {
          this.msg.set({ texto: 'El navegador bloqueó la ventana: permite las ventanas emergentes de este sitio para ver la guía.', mal: true });
        }
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        const folio = res.headers.get('X-Guia-Folio') || g.folio;
        if (win) this.msg.set({ texto: (g.status === 'impresa' ? 'Reimpresión de ' : 'Guía ') + folio + ' lista para imprimir y firmar.', mal: false });
        this.reload();
      },
      error: (e: HttpErrorResponse) => {
        this.imprimiendo.set(null);
        win?.close();
        this.msg.set({ texto: this.errorTexto(e), mal: true });
      },
    });
  }

  /** Con responseType blob, el mensaje del servidor llega como Blob: no se puede leer de forma síncrona. */
  private errorTexto(e: HttpErrorResponse): string {
    if (e.status === 409) return 'La guía cambió o ya no se puede imprimir. Actualiza la lista.';
    if (e.status === 404) return 'Esa guía ya no está disponible para tu sucursal.';
    return 'No se pudo generar la guía.';
  }

  fechaHora(isoTs: string | null): string {
    if (!isoTs) return '—';
    return new Date(isoTs).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
