import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TableModule } from 'primeng/table';
import { ComercialService, RoutePromoResult } from '../comercial.service';

/**
 * RR-PROMO — Agente AI de incentivos de ruta. Pegás el ENUNCIADO de la mecánica en lenguaje
 * natural (ej "RD: $6.00 por cada venta de choyitas /40 cód:97192, solo clientes distintos…") y
 * Haiku lo traduce a una regla; el backend calcula el pago por ruta con SQL determinista.
 * El LLM nunca hace la aritmética (ADR-016). Card embebida en /comercial/ventas-por-ruta.
 */
@Component({
  selector: 'app-comercial-route-promo',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, DatePickerModule, TableModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rp card-premium card-flat">
      <button type="button" class="rp-head" (click)="open.set(!open())" [attr.aria-expanded]="open()">
        <span class="rp-title"><i class="pi pi-sparkles" aria-hidden="true"></i> Incentivo por enunciado (AI)</span>
        <span class="rp-hint">Pegá la mecánica de la promo tal cual — calcula el pago por ruta</span>
        <i class="pi rp-caret" [class.pi-chevron-down]="!open()" [class.pi-chevron-up]="open()" aria-hidden="true"></i>
      </button>

      @if (open()) {
        <div class="rp-body">
          <div class="rp-input">
            <textarea [(ngModel)]="enunciado" rows="2" class="rp-ta"
              placeholder='Ej: RD: $6.00 por cada venta de choyitas 14 gr./40 cód:97192, solo participan clientes distintos a los que se les vendió una o más piezas'></textarea>
            <div class="rp-controls">
              <div class="rp-field">
                <label>Mes</label>
                <p-datepicker [(ngModel)]="monthDate" view="month" dateFormat="MM yy" [showIcon]="true" appendTo="body" />
              </div>
              <button pButton size="small" [loading]="loading()" (click)="run()" [disabled]="!enunciado.trim()">
                <span class="p-button-icon p-button-icon-left pi pi-calculator" aria-hidden="true"></span>
                <span class="p-button-label">Calcular</span>
              </button>
            </div>
          </div>

          @if (res(); as r) {
            <!-- Regla interpretada (transparencia: el usuario valida lo que entendió el AI) -->
            <div class="rp-rule">
              <div class="rp-chips">
                <span class="rp-chip"><b>{{ r.product?.nombre || r.rule.producto_texto || '—' }}</b>@if (r.product) { · {{ r.product.sku }} }</span>
                <span class="rp-chip">\${{ r.rule.rate | number:'1.2-2' }} / {{ r.base_label.toLowerCase() }}</span>
                <span class="rp-chip">{{ r.rule.canal === 'ruta' ? 'Ruta (RD)' : 'Todos los canales' }}</span>
                <span class="rp-chip rp-chip-mut">{{ r.period.label }}</span>
              </div>
              @if (r.rule.supuestos) { <p class="rp-note"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ r.rule.supuestos }}</p> }

              @if (r.candidates?.length) {
                <div class="rp-amb">
                  <span>Producto ambiguo — elegí el SKU:</span>
                  <p-select [options]="r.candidates" optionLabel="nombre" optionValue="sku" [(ngModel)]="pickSku"
                            placeholder="Seleccioná" appendTo="body" styleClass="w-full" />
                  <button pButton size="small" severity="secondary" (click)="run(pickSku)" [disabled]="!pickSku">Recalcular</button>
                </div>
              }
            </div>

            @if (r.rows.length) {
              <div class="rp-topbar">
                <div class="rp-totals">
                  <div class="rp-kpi"><span class="k-lbl">Pago total</span><span class="k-val">{{ r.total_payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Clientes</span><span class="k-val">{{ r.total_clientes | number }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Piezas</span><span class="k-val">{{ r.total_piezas | number:'1.0-2' }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Importe</span><span class="k-val">{{ r.total_importe | currency:'MXN':'symbol-narrow':'1.0-0' }}</span></div>
                  <div class="rp-kpi"><span class="k-lbl">Rutas</span><span class="k-val">{{ r.rows.length }}</span></div>
                </div>
                <div class="rp-dl">
                  <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl()==='xlsx'" (click)="download('xlsx')"><span class="p-button-icon p-button-icon-left pi pi-file-excel" aria-hidden="true"></span><span class="p-button-label">XLSX</span></button>
                  <button pButton size="small" severity="secondary" [outlined]="true" [loading]="dl()==='pdf'" (click)="download('pdf')"><span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF</span></button>
                </div>
              </div>

              <table class="rp-tbl">
                <thead><tr><th>Ruta</th><th class="n">Clientes</th><th class="n">Piezas</th><th class="n">Importe</th><th class="n">Pago</th></tr></thead>
                <tbody>
                  @for (row of r.rows; track row.label) {
                    <tr><td>{{ row.label }}</td><td class="n">{{ row.clientes | number }}</td><td class="n">{{ row.piezas | number:'1.0-2' }}</td><td class="n">{{ row.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td><td class="n b">{{ row.payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr>
                  }
                </tbody>
                <tfoot><tr><td>TOTAL</td><td class="n">{{ r.total_clientes | number }}</td><td class="n">{{ r.total_piezas | number:'1.0-2' }}</td><td class="n">{{ r.total_importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td><td class="n b">{{ r.total_payout | currency:'MXN':'symbol-narrow':'1.2-2' }}</td></tr></tfoot>
              </table>

              @if (r.clientes_detalle.length) {
                <button type="button" class="rp-detog" (click)="showDetail.set(!showDetail())">
                  <i class="pi" [class.pi-chevron-right]="!showDetail()" [class.pi-chevron-down]="showDetail()" aria-hidden="true"></i>
                  Clientes que participaron ({{ r.clientes_detalle.length }})
                </button>
                @if (showDetail()) {
                  <table class="rp-tbl rp-det">
                    <thead><tr><th>Ruta</th><th>Cliente</th><th>Nombre</th><th class="n">Piezas</th><th class="n">Importe</th></tr></thead>
                    <tbody>
                      @for (c of r.clientes_detalle; track $index) {
                        <tr><td>{{ c.route_label }}</td><td class="mono">{{ c.cliente }}</td><td>{{ c.nombre }}</td><td class="n">{{ c.piezas | number:'1.0-2' }}</td><td class="n">{{ c.importe | currency:'MXN':'symbol-narrow':'1.0-2' }}</td></tr>
                      }
                    </tbody>
                  </table>
                }
              }
            } @else {
              <p class="rp-empty">{{ r.note }}</p>
            }
          } @else if (err()) {
            <p class="rp-err"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ err() }}</p>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; margin-bottom:1rem; }
    .rp { overflow:hidden; }
    .rp-head { display:flex; align-items:center; gap:.75rem; width:100%; padding:.85rem 1.1rem; background:none; border:none;
      cursor:pointer; text-align:left; color:var(--text-main); }
    .rp-title { font-weight:700; font-size:.9rem; display:inline-flex; align-items:center; gap:.5rem; white-space:nowrap; }
    .rp-title .pi-sparkles { color:var(--action); }
    .rp-hint { flex:1; font-size:.78rem; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .rp-caret { color:var(--text-muted); font-size:.75rem; }
    .rp-body { padding:0 1.1rem 1.1rem; display:flex; flex-direction:column; gap:1rem; }
    .rp-input { display:flex; flex-direction:column; gap:.6rem; }
    .rp-ta { width:100%; resize:vertical; font-size:.85rem; padding:.6rem .7rem; border:1px solid var(--border-color);
      border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font-family:inherit; }
    .rp-ta:focus { outline:none; border-color:var(--action); box-shadow:0 0 0 2px var(--action-ring); }
    .rp-controls { display:flex; align-items:flex-end; gap:1rem; }
    .rp-field { display:flex; flex-direction:column; gap:.3rem; }
    .rp-field > label { font-size:.72rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.03em; }
    .rp-rule { display:flex; flex-direction:column; gap:.5rem; }
    .rp-chips { display:flex; flex-wrap:wrap; gap:.4rem; }
    .rp-chip { font-size:.78rem; padding:.2rem .55rem; border-radius:var(--r-sm); background:var(--layout-bg);
      border:1px solid var(--border-color); color:var(--text-main); }
    .rp-chip-mut { color:var(--text-muted); }
    .rp-note { font-size:.76rem; color:var(--text-muted); display:flex; gap:.4rem; align-items:baseline; margin:0; }
    .rp-amb { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; font-size:.82rem; padding:.6rem .7rem;
      background:var(--layout-bg); border:1px solid var(--border-color); border-radius:var(--r-sm); }
    .rp-amb p-select { min-width:16rem; }
    .rp-topbar { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; flex-wrap:wrap; padding:.4rem 0; }
    .rp-dl { display:flex; gap:.5rem; }
    .rp-detog { margin-top:.5rem; background:none; border:none; color:var(--action); font-size:.82rem; font-weight:600;
      cursor:pointer; display:inline-flex; align-items:center; gap:.4rem; padding:.3rem 0; }
    .rp-det { margin-top:.4rem; }
    .rp-tbl .mono { font-family:var(--font-mono); font-size:.76rem; }
    .rp-totals { display:flex; gap:1.5rem; padding:.4rem 0; flex-wrap:wrap; }
    .rp-kpi { display:flex; flex-direction:column; gap:.15rem; }
    .rp-kpi .k-lbl { font-size:.7rem; color:var(--text-faint); text-transform:uppercase; letter-spacing:.03em; }
    .rp-kpi .k-val { font-size:1.35rem; font-weight:700; color:var(--text-main); line-height:1.1; }
    .rp-tbl { width:100%; border-collapse:separate; border-spacing:0; font-size:.82rem; }
    .rp-tbl th, .rp-tbl td { padding:.34rem .6rem; border-bottom:1px solid var(--border-color); text-align:left; }
    .rp-tbl thead th { background:var(--layout-bg); font-weight:700; font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:var(--text-muted); }
    .rp-tbl .n { text-align:right; font-variant-numeric:tabular-nums; }
    .rp-tbl .b { font-weight:700; }
    .rp-tbl tfoot td { font-weight:700; background:var(--surface-selected-bg); border-top:2px solid var(--border-color); }
    .rp-empty, .rp-err { font-size:.82rem; color:var(--text-muted); margin:0; display:flex; gap:.4rem; align-items:baseline; }
    .rp-err { color:var(--bad-fg); }
  `],
})
export class RoutePromoComponent {
  private readonly svc = inject(ComercialService);
  private readonly destroyRef = inject(DestroyRef);

  readonly open = signal(false);
  readonly loading = signal(false);
  readonly dl = signal<'' | 'xlsx' | 'pdf'>('');
  readonly showDetail = signal(false);
  readonly res = signal<RoutePromoResult | null>(null);
  readonly err = signal<string | null>(null);
  enunciado = '';
  pickSku: string | null = null;
  private lastBody: { enunciado: string; from: string; to: string; sku?: string } | null = null;
  // Default = mes anterior cerrado (igual que sell-out).
  monthDate: Date = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);

  private iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  run(sku?: string | null): void {
    const enunciado = this.enunciado.trim();
    if (!enunciado) return;
    const d = this.monthDate;
    const from = this.iso(new Date(d.getFullYear(), d.getMonth(), 1));
    const to = this.iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    this.lastBody = { enunciado, from, to, sku: sku || undefined };
    this.loading.set(true);
    this.err.set(null);
    this.svc.routePromo(this.lastBody)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.res.set(r); this.pickSku = null; this.loading.set(false); },
        error: (e) => { this.res.set(null); this.err.set(e?.error?.message || 'No se pudo calcular'); this.loading.set(false); },
      });
  }

  download(fmt: 'xlsx' | 'pdf'): void {
    if (!this.lastBody || !this.res()?.rows.length) return;
    this.dl.set(fmt);
    this.svc.routePromoDownload(this.lastBody, fmt)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (resp) => {
          this.dl.set('');
          const cd = resp.headers.get('content-disposition') || '';
          const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
          const plain = /filename="?([^";]+)"?/i.exec(cd);
          const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `incentivo.${fmt}`;
          const url = URL.createObjectURL(resp.body!);
          const a = document.createElement('a');
          a.href = url; a.download = name; a.click();
          URL.revokeObjectURL(url);
        },
        error: () => { this.dl.set(''); },
      });
  }
}
