import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { ComercialService, ExpiryHoja, ExpedienteBranch } from '../../comercial/comercial.service';
import { clasificarPlazo, plazoSeverity, Plazo } from '../../comercial/expiry-plazo';
import { formatExpiryEcho } from '../../almacen/shared/expiry-short';

/**
 * **El expediente de caducidades, archivado por sucursal.**
 *
 * Dos niveles, como una carpeta física:
 *  1. **Portada** — una fila por sucursal (8 Esquinas, Padre Hidalgo, Zamora
 *     Centro, Canindo…) con lo que tiene archivado: hojas, por vencer, vencidos
 *     y cuándo fue la última captura. Aparece solo si la persona tiene alcance de
 *     más de una sucursal; al encargado de una sola no se le pinta un índice de
 *     un solo renglón.
 *  2. **Hojas** — una por producto, con su folio (`CAD-03-2026-00001`), quién la
 *     levantó y el plazo. Click en una abre el formato imprimible.
 *
 * El alcance lo aplica el server (`ScopeService`, dimensión `warehouse`): el
 * encargado ve su sucursal, dirección ve las 7. El filtro de sucursal de esta
 * pantalla acota DENTRO de lo permitido, nunca lo amplía.
 */
@Component({
  selector: 'app-tienda-caducidades-expediente',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TagModule, TableModule,
    SelectModule, InputTextModule, DatePickerModule, ToastModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in exp">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Expediente de caducidades</h1>
          <p class="surf-page-sub">Una hoja por producto, archivada en su sucursal</p>
        </div>
        <div class="exp-head-actions">
          <button pButton [text]="true" severity="secondary" size="small" (click)="irACaptura()">
            <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Registrar caducidad
          </button>
        </div>
      </header>

      <!-- ── Portada: las sucursales ── -->
      @if (mostrarPortada()) {
        <section class="exp-suc">
          <div class="exp-sec-head">
            <h2>Sucursales</h2>
            <span class="exp-sec-sub">Elegí una para ver su expediente</span>
          </div>

          @if (cargandoSuc()) {
            <div class="exp-skel" aria-hidden="true">
              @for (i of [1,2,3,4]; track i) { <div class="exp-skel-card"></div> }
            </div>
          } @else {
            <div class="exp-cards">
              @for (s of sucursales(); track s.id) {
                <button type="button" class="exp-card" [class.on]="warehouseId === s.id" (click)="filtrarSucursal(s)">
                  <span class="exp-card-head">
                    <strong class="exp-card-name">{{ s.name }}</strong>
                    <code class="exp-card-code">{{ s.code }}</code>
                  </span>
                  <span class="exp-card-num">{{ s.hojas }}</span>
                  <span class="exp-card-lbl">{{ s.hojas === 1 ? 'hoja' : 'hojas' }}</span>
                  <span class="exp-card-tags">
                    @if (s.vencidos) { <span class="exp-t exp-t--bad">{{ s.vencidos }} vencidos</span> }
                    @if (s.riesgosos) { <span class="exp-t exp-t--warn">{{ s.riesgosos }} por vencer</span> }
                    @if (!s.vencidos && !s.riesgosos && s.hojas) { <span class="exp-t exp-t--ok">sin riesgo</span> }
                    @if (!s.hojas) { <span class="exp-t">sin capturas</span> }
                  </span>
                  <span class="exp-card-last">
                    @if (s.ultima_captura) { Última: {{ fecha(s.ultima_captura) }} } @else { — }
                  </span>
                </button>
              }
            </div>
          }
        </section>
      }

      <!-- ── Filtros ── -->
      <section class="exp-filtros surf-card">
        <label class="exp-f">
          <span class="exp-f-lbl">Buscar</span>
          <input pInputText [(ngModel)]="search" (keydown.enter)="cargarHojas()"
            placeholder="Folio, producto o SKU" class="exp-full" />
        </label>
        @if (sucursales().length > 1) {
          <label class="exp-f">
            <span class="exp-f-lbl">Sucursal</span>
            <p-select [options]="opcionesSucursal()" [(ngModel)]="warehouseId" optionLabel="label" optionValue="value"
              (onChange)="cargarHojas()" appendTo="body" styleClass="exp-full"></p-select>
          </label>
        }
        <label class="exp-f">
          <span class="exp-f-lbl">Plazo</span>
          <p-select [options]="opcionesPlazo" [(ngModel)]="plazoFiltro" optionLabel="label" optionValue="value"
            (onChange)="cargarHojas()" appendTo="body" styleClass="exp-full"></p-select>
        </label>
        <label class="exp-f">
          <span class="exp-f-lbl">Desde</span>
          <p-datepicker [(ngModel)]="desde" dateFormat="yy-mm-dd" [showButtonBar]="true"
            (onSelect)="cargarHojas()" (onClearClick)="cargarHojas()" appendTo="body" styleClass="exp-full"></p-datepicker>
        </label>
        <label class="exp-f">
          <span class="exp-f-lbl">Hasta</span>
          <p-datepicker [(ngModel)]="hasta" dateFormat="yy-mm-dd" [showButtonBar]="true"
            (onSelect)="cargarHojas()" (onClearClick)="cargarHojas()" appendTo="body" styleClass="exp-full"></p-datepicker>
        </label>
        <div class="exp-f exp-f--btns">
          <button pButton size="small" (click)="cargarHojas()">
            <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span> Buscar
          </button>
          @if (hayFiltros()) {
            <button pButton [text]="true" severity="secondary" size="small" (click)="limpiarFiltros()">Limpiar</button>
          }
        </div>
      </section>

      <!-- ── Las hojas ── -->
      <section class="exp-hojas">
        <div class="exp-sec-head">
          <h2>Hojas</h2>
          <span class="exp-sec-sub">
            @if (total()) { {{ total() }} {{ total() === 1 ? 'hoja archivada' : 'hojas archivadas' }} }
          </span>
        </div>

        <p-table [value]="hojas()" [loading]="cargandoHojas()" styleClass="p-datatable-sm surf-table"
          [scrollable]="true" [paginator]="total() > 25" [rows]="25" [rowsPerPageOptions]="[25, 50, 100]">
          <ng-template #header>
            <tr>
              <th scope="col">Folio</th>
              <th scope="col">Producto</th>
              <th scope="col" class="num">Cantidad</th>
              <th scope="col">Vence</th>
              <th scope="col">Plazo</th>
              <th scope="col">Sucursal</th>
              <th scope="col">Levantó</th>
              <th scope="col">Fecha</th>
              <th scope="col"></th>
            </tr>
          </ng-template>
          <ng-template #body let-h>
            <tr class="exp-row" (click)="abrir(h)" tabindex="0" (keydown.enter)="abrir(h)">
              <td><span class="exp-mono exp-folio">{{ h.folio || '—' }}</span></td>
              <td class="exp-prod">
                <span class="exp-prod-name">{{ h.product_name || h.product_name_raw || h.product_code_raw || '—' }}</span>
                @if (h.sku) { <code class="exp-mono exp-sku">{{ h.sku }}</code> }
              </td>
              <td class="num"><span class="exp-mono">{{ h.quantity }}</span> {{ h.unit || 'pz' }}</td>
              <td><span class="exp-mono">{{ fecha(h.expiry_date) }}</span></td>
              <td>
                @if (plazoDe(h); as pz) { <p-tag [value]="pz.title" [severity]="sev(pz.level)"></p-tag> }
                @else { — }
              </td>
              <td class="exp-suc-cell">{{ h.warehouse_name || '—' }}</td>
              <td>{{ h.levantada_por || '—' }}</td>
              <td><span class="exp-mono">{{ fecha(h.review_date) }}</span></td>
              <td class="num">
                <button pButton [text]="true" size="small" severity="secondary"
                  (click)="abrir(h); $event.stopPropagation()" [attr.aria-label]="'Abrir la hoja ' + (h.folio || '')">
                  <span class="p-button-icon pi pi-file" aria-hidden="true"></span>
                </button>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="9" class="comm-empty-cell">
              <div class="comm-empty">
                <div class="comm-empty-icon"><i class="pi pi-folder-open" aria-hidden="true"></i></div>
                @if (hayFiltros()) {
                  <h3>Nada con esos filtros</h3>
                  <p>Probá con otro rango de fechas, otro plazo, o limpiá los filtros.</p>
                } @else {
                  <h3>El expediente está vacío</h3>
                  <p>Cada producto que se registre en Caducidades genera acá su hoja, con folio propio.</p>
                }
              </div>
            </td></tr>
          </ng-template>
        </p-table>
      </section>
    </div>
  `,
  styles: [`
    .exp { display: grid; gap: 1rem; container-type: inline-size; }
    .exp-head-actions { display: flex; gap: .5rem; align-items: center; }

    .exp-sec-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin-bottom: .5rem; }
    .exp-sec-head h2 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: 700; }
    .exp-sec-sub { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }

    .exp-mono { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }

    /* ── Portada de sucursales ── */
    .exp-cards { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
    .exp-card {
      display: grid; gap: .15rem; text-align: left; padding: .8rem .9rem;
      border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-md, 8px);
      background: var(--card-bg); font: inherit; color: inherit; cursor: pointer;
      transition: transform 150ms ease-out, border-color 150ms ease-out;
    }
    .exp-card:hover { border-color: var(--action, var(--border-color)); }
    .exp-card:active { transform: scale(.99); }
    .exp-card.on { border-left-color: var(--action, currentColor); }
    .exp-card-head { display: flex; align-items: baseline; gap: .4rem; justify-content: space-between; }
    .exp-card-name { font-size: var(--fs-sm, .9rem); }
    .exp-card-code { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .exp-card-num { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: 1.6rem; font-weight: 700; line-height: 1.1; }
    .exp-card-lbl { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .exp-card-tags { display: flex; gap: .3rem; flex-wrap: wrap; margin-top: .3rem; }
    .exp-t { font-size: var(--fs-xs, .68rem); padding: .1rem .4rem; border-radius: var(--r-sm, 4px); border: 1px solid var(--border-color); color: var(--c-text-2, var(--text-muted)); }
    .exp-t--bad { border-color: color-mix(in oklab, var(--tone-bad, #d33) 45%, var(--border-color)); color: var(--tone-bad, inherit); }
    .exp-t--warn { border-color: color-mix(in oklab, var(--tone-warn, #fa0) 45%, var(--border-color)); color: var(--tone-warn, inherit); }
    .exp-t--ok { border-color: color-mix(in oklab, var(--tone-ok, #2f7) 45%, var(--border-color)); color: var(--tone-ok, inherit); }
    .exp-card-last { font-size: var(--fs-xs, .68rem); color: var(--c-text-3, var(--text-muted)); margin-top: .2rem; }

    /* ── Filtros ── */
    .exp-filtros { display: grid; gap: .75rem; padding: .9rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); align-items: end; }
    .exp-f { display: grid; gap: .3rem; min-width: 0; }
    .exp-f--btns { display: flex; gap: .4rem; align-items: center; }
    .exp-f-lbl { font-size: var(--fs-xs, .72rem); color: var(--c-text-2, var(--text-muted)); }
    :host ::ng-deep .exp-full, :host ::ng-deep .exp-full input { width: 100%; }
    .exp-full { width: 100%; }

    /* ── Tabla ── */
    .exp-row { cursor: pointer; }
    .exp-folio { font-weight: 600; }
    .exp-prod { min-width: 0; }
    .exp-prod-name { display: block; overflow-wrap: anywhere; }
    .exp-sku { font-size: var(--fs-xs, .72rem); color: var(--c-text-3, var(--text-muted)); }
    .exp-suc-cell { white-space: nowrap; }

    /* Skeleton dimensionado a la card real → CLS 0. */
    .exp-skel { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
    .exp-skel-card {
      height: 7rem; border-radius: var(--r-md, 8px);
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--ink, #000) 4%, transparent),
        color-mix(in oklab, var(--ink, #000) 8%, transparent),
        color-mix(in oklab, var(--ink, #000) 4%, transparent));
      background-size: 200% 100%; animation: exp-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes exp-shimmer { to { background-position: -200% 0; } }

    @media (prefers-reduced-motion: reduce) {
      .exp-skel-card { animation: none; }
      .exp-card { transition: none; }
    }
  `],
})
export class TiendaCaducidadesExpedienteComponent {
  readonly opcionesPlazo = [
    { label: 'Todos', value: '' },
    { label: 'Vencidos', value: 'vencido' },
    { label: 'Por vencer (≤30d)', value: 'riesgoso' },
    { label: 'Intermedio (31-90d)', value: 'intermedio' },
    { label: 'Buen plazo (>90d)', value: 'bueno' },
  ];

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly sucursales = signal<ExpedienteBranch[]>([]);
  readonly cargandoSuc = signal(true);
  readonly hojas = signal<ExpiryHoja[]>([]);
  readonly total = signal(0);
  readonly cargandoHojas = signal(false);

  warehouseId = '';
  plazoFiltro = '';
  search = '';
  desde: Date | null = null;
  hasta: Date | null = null;

  /** Con una sola sucursal en el alcance, un índice de un renglón es ruido. */
  readonly mostrarPortada = computed(() => this.cargandoSuc() || this.sucursales().length > 1);

  readonly opcionesSucursal = computed(() => [
    { label: 'Todas', value: '' },
    ...this.sucursales().map((s) => ({ label: `${s.name} (${s.code})`, value: s.id })),
  ]);

  readonly hayFiltros = computed(() =>
    !!(this.warehouseId || this.plazoFiltro || this.search.trim() || this.desde || this.hasta));

  constructor() {
    this.svc.expedienteBranches()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.sucursales.set(r.data || []); this.cargandoSuc.set(false); },
        error: () => { this.cargandoSuc.set(false); this.toast.add({ severity: 'error', summary: 'No se pudieron cargar las sucursales' }); },
      });
    this.cargarHojas();
  }

  cargarHojas(): void {
    this.cargandoHojas.set(true);
    this.svc.listExpediente({
      warehouse_id: this.warehouseId || undefined,
      plazo: this.plazoFiltro || undefined,
      search: this.search.trim() || undefined,
      from: this.ymdDe(this.desde),
      to: this.ymdDe(this.hasta),
      pageSize: 100,
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.hojas.set(r.data || []);
          this.total.set(r.pagination?.total ?? (r.data?.length || 0));
          this.cargandoHojas.set(false);
        },
        error: () => { this.cargandoHojas.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el expediente' }); },
      });
  }

  filtrarSucursal(s: ExpedienteBranch): void {
    // Segundo click en la misma card = quitar el filtro.
    this.warehouseId = this.warehouseId === s.id ? '' : s.id;
    this.cargarHojas();
  }

  limpiarFiltros(): void {
    this.warehouseId = '';
    this.plazoFiltro = '';
    this.search = '';
    this.desde = null;
    this.hasta = null;
    this.cargarHojas();
  }

  /** Abre por FOLIO cuando lo hay: la URL queda citable y compartible. */
  abrir(h: ExpiryHoja): void {
    this.router.navigate(['/tienda/caducidades/hoja', h.folio || h.id]);
  }

  irACaptura(): void { this.router.navigate(['/tienda/caducidades']); }

  // ── presentación ──

  private ymdDe(d: Date | null): string | undefined {
    if (!d) return undefined;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private ymd(v: string | null | undefined): string {
    const s = String(v || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  }

  fecha(v: string | null | undefined): string { return formatExpiryEcho(this.ymd(v)) || '—'; }
  plazoDe(h: ExpiryHoja): Plazo | null { return clasificarPlazo(this.ymd(h.expiry_date)); }
  sev(l: Plazo['level']) { return plazoSeverity(l); }
}
