import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { ComprasService, OpenOcRow, OpenOcResponse } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * RA-PRO.45 — Órdenes de compra abiertas en Kepler (X-A-35 sin X-A-40), por antigüedad.
 *
 * La vista INVERSA de la columna "En camino" del pedido. En Kepler la OC se captura al recibir
 * (81% del CEDIS cierra el mismo día), así que una que sigue abierta no es pipeline: es un
 * documento estancado que hay que cerrar o cancelar. El motor ya dejó de creerles —esta pantalla
 * es para que alguien las barra del ERP—.
 *
 * Superficie Operations (PrimeNG denso, quiet-luxury).
 */
@Component({
  selector: 'app-compras-oc-abiertas',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in oa-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Órdenes abiertas en Kepler</h1>
          <p class="surf-page-sub">Órdenes de compra sin orden de entrada. En Kepler la orden se captura al recibir, así que una que lleva semanas abierta casi nunca se surte: hay que cerrarla o cancelarla.</p>
        </div>
      </header>

      <!-- Resumen: cuánto papel hay y cuánto de eso sigue realmente en juego. -->
      <div class="oa-kpis">
        <div class="oa-kpi">
          <span class="oa-k">Órdenes abiertas</span>
          <span class="oa-v">{{ total() | number }}</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Valor en papel</span>
          <span class="oa-v">{{ money(totalValor()) }}</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Se espera que llegue</span>
          <span class="oa-v oa-ok">{{ money(valorEsperado()) }}</span>
          <span class="oa-s">{{ pctEsperado() }}% del papel</span>
        </div>
        <div class="oa-kpi">
          <span class="oa-k">Para barrer (+30 d)</span>
          <span class="oa-v oa-bad">{{ viejas() | number }}</span>
          <span class="oa-s">{{ money(valorViejas()) }}</span>
        </div>
      </div>

      <div class="oa-filters">
        <p-select [options]="edadOpts" [(ngModel)]="fMinDays" (onChange)="reload()"
                  optionLabel="label" optionValue="value" styleClass="oa-sel" appendTo="body"></p-select>
        <p-select [options]="sucOpts" [(ngModel)]="fSuc" (onChange)="reload()"
                  optionLabel="label" optionValue="value" placeholder="Todas las sucursales"
                  [showClear]="true" styleClass="oa-sel" appendTo="body"></p-select>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()">
          <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
          <span class="p-button-label">Actualizar</span>
        </button>
        <span class="oa-count">{{ rows().length | number }} de {{ total() | number }}</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               styleClass="p-datatable-sm oa-table">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Suc.</th><th>Proveedor</th><th>Fecha</th>
            <th class="oa-r">Abierta</th><th>Estatus</th>
            <th class="oa-r">Líneas</th><th class="oa-r">Valor</th><th class="oa-r">Prob. de llegar</th>
          </tr>
        </ng-template>
        <ng-template #body let-o>
          <tr>
            <td class="oa-mono">{{ o.folio }}</td>
            <td class="oa-mono oa-muted">{{ o.almacen }}</td>
            <td>{{ o.proveedor || '—' }}</td>
            <td class="oa-muted">{{ o.fecha_oc | date:'dd/MM/yy' }}</td>
            <td class="oa-r"><span [class]="edadCls(o)">{{ o.dias }} d</span></td>
            <td><p-tag [value]="estLabel(o.estatus)" [severity]="estSev(o.estatus)" styleClass="oa-tag"></p-tag></td>
            <td class="oa-r oa-muted">{{ o.lineas | number }}</td>
            <td class="oa-r oa-strong">{{ money(o.valor) }}</td>
            <td class="oa-r">
              @if (o.prob === null) { <span class="oa-muted">—</span> }
              @else { <span [class]="probCls(o)" [title]="probTitle(o)">{{ o.prob }}%</span> }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="oa-empty">No hay órdenes de compra abiertas con ese filtro.</td></tr>
        </ng-template>
      </p-table>

      <!-- La curva es el criterio con el que el motor pesa cada orden: mostrarla evita que la
           columna "Prob." parezca un número inventado. -->
      @if (curva().length) {
        <p class="oa-foot">
          Probabilidad medida sobre las órdenes de hace 180–400 días, ya resueltas:
          @for (c of curva(); track c.edad) {<span class="oa-cv">{{ c.edad }} d → <strong>{{ c.pct }}%</strong></span>}
          Es la misma curva con la que el pedido descuenta lo que viene en camino.
        </p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .oa-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .5rem; margin-bottom: .85rem; }
    .oa-kpi { display: flex; flex-direction: column; gap: .1rem; padding: .6rem .75rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--surface-1, transparent); }
    .oa-k { font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); font-weight: 600; }
    .oa-v { font-size: 1.25rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .oa-s { font-size: .72rem; color: var(--text-muted); }
    .oa-ok { color: var(--ok-fg); }
    .oa-bad { color: var(--bad-fg); }
    .oa-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .oa-sel { min-width: 12rem; }
    .oa-count { color: var(--text-muted); font-size: .82rem; margin-left: auto; }
    .oa-table { font-size: .82rem; }
    .oa-r { text-align: right; font-variant-numeric: tabular-nums; }
    .oa-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .oa-muted { color: var(--text-muted); }
    .oa-strong { font-weight: 700; }
    .oa-edad-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-edad-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-bad { color: var(--bad-fg); font-weight: 700; }
    .oa-prob-warn { color: var(--warn-fg); font-weight: 600; }
    .oa-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .oa-foot { margin-top: .75rem; font-size: .75rem; color: var(--text-muted); line-height: 1.5; }
    .oa-cv { margin: 0 .45rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  `],
})
export class ComprasOcAbiertasComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<OpenOcRow[]>([]);
  readonly total = signal(0);
  readonly totalValor = signal(0);
  readonly valorEsperado = signal(0);
  readonly curva = signal<OpenOcResponse['curva']>([]);
  readonly loading = signal(false);

  fMinDays = 0;
  fSuc = '';
  edadOpts = [
    { label: 'Todas', value: 0 },
    { label: 'Abiertas +8 días', value: 8 },
    { label: 'Abiertas +30 días', value: 31 },
    { label: 'Abiertas +60 días', value: 61 },
  ];
  sucOpts = [
    { label: '00 · CEDIS', value: '00' }, { label: '01 · Padre Hidalgo', value: '01' },
    { label: '02', value: '02' }, { label: '03 · 8 Esquinas', value: '03' },
    { label: '04', value: '04' }, { label: '05', value: '05' }, { label: '06 · Canindo', value: '06' },
  ];

  viejas = computed(() => this.rows().filter((o) => o.dias > 30).length);
  valorViejas = computed(() => this.rows().filter((o) => o.dias > 30).reduce((s, o) => s + o.valor, 0));
  pctEsperado = computed(() => {
    const t = this.totalValor();
    return t > 0 ? Math.round((this.valorEsperado() / t) * 100) : 0;
  });

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.api.openPurchaseOrders({ sucursal: this.fSuc || undefined, min_days: this.fMinDays || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.rows.set(r.rows ?? []);
          this.total.set(r.total ?? 0);
          this.totalValor.set(r.total_valor ?? 0);
          this.valorEsperado.set(r.valor_esperado ?? 0);
          this.curva.set(r.curva ?? []);
          this.loading.set(false);
        },
        // No se traga el error: la tabla queda vacía pero el contador dice 0 y el usuario ve
        // que algo falló al recargar (DESIGN §Ing.UI 6).
        error: () => { this.rows.set([]); this.loading.set(false); },
      });
  }

  edadCls(o: OpenOcRow): string { return o.dias > 30 ? 'oa-edad-bad' : o.dias > 14 ? 'oa-edad-warn' : ''; }
  probCls(o: OpenOcRow): string {
    const p = Number(o.prob ?? 0);
    return p < 25 ? 'oa-prob-bad' : p < 60 ? 'oa-prob-warn' : '';
  }
  probTitle(o: OpenOcRow): string {
    if (o.estatus === 'F' || o.estatus === 'R') return 'Kepler ya la marcó como terminada: la cadena de documentos quedó rota, pero no viene nada.';
    if (o.estatus === 'C') return 'Cancelada en Kepler.';
    return `Históricamente, ${o.prob}% de las órdenes que seguían abiertas a los ${o.dias} días terminaron recibiéndose.`;
  }
  estLabel(s: string): string {
    return ({ N: 'Pendiente', F: 'Finalizada', C: 'Cancelada', R: 'Recibida', A: 'Otro' } as Record<string, string>)[s] || s;
  }
  estSev(s: string): Sev {
    return ({ N: 'secondary', F: 'danger', C: 'danger', R: 'danger', A: 'secondary' } as Record<string, Sev>)[s] || 'secondary';
  }
  money(v: number | string | null | undefined) {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
