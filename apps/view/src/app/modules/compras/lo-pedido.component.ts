import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { forkJoin } from 'rxjs';
import { ComprasService, type RequisitionEstado, type RequisitionRow } from './compras.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { SidePeekComponent } from '../../shared/components/side-peek/side-peek.component';
import { SucursalPipe } from '../../shared/pipes/sucursal.pipe';
import { LoadStateComponent } from '../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../shared/components/metric-strip/metric-strip.component';

/**
 * `[PQ.28]` **«Lo pedido»: lo que salió de Pedido, sin salir de Pedido.**
 *
 * Una sola ventana en lugar de dos pantallas (Edgar, 2026-10-29: «la menor cantidad de interfaces
 * posibles y la menor interacción humana… que todo esté a la mano»; y «abruma a la gente la
 * interfaz»). Antes, después de generar había que ir a Requisiciones —4 pestañas, 2 vistas— a
 * aprobar, y a la ficha de cada una a ver si salió a Kepler.
 *
 * Arriba, SÓLO si hay: lo que espera aprobación (con D1 sólo queda ahí lo que generó alguien sin
 * permiso de autorizar, o lo que frenó un costo movido > 5 %). Abajo: lo reciente, con lo que pasó
 * en Kepler ESCRITO —requisición, OC, recibida o el motivo—. La consulta completa sigue en
 * `/compras/requisiciones` (D3), a un enlace.
 */
@Component({
  selector: 'app-lo-pedido',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink, ButtonModule, InputTextModule, TableModule, SidePeekComponent, SucursalPipe, LoadStateComponent, FreshnessPillComponent, MetricStripComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible) {
    <button pButton type="button" class="p-button-sm p-button-text lp-btn" (click)="abrir()"
            [attr.aria-label]="'Lo pedido' + (porAprobar().length ? ', ' + porAprobar().length + ' por aprobar' : '')">
      <span class="p-button-icon p-button-icon-left pi pi-inbox" aria-hidden="true"></span>
      <span class="p-button-label">Lo pedido</span>
      @if (porAprobar().length) { <span class="lp-n">{{ porAprobar().length }} por aprobar</span> }
    </button>

    <app-side-peek [open]="abierto()" (openChange)="abierto.set($event)" [width]="760" title="Lo pedido">
      <!-- dt-scope: el panel es angosto; la tabla responde a SU ancho, no al de la ventana. -->
      <div class="lp dt-scope">
        <div class="lp-top">
          <app-metric-strip [items]="cifras()" [instant]="true" density="compact" ariaLabel="Lo pedido, en cifras"></app-metric-strip>
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
        </div>
        <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!porAprobar().length && !recientes().length"
                        emptyTitle="Todavía no hay nada pedido" emptyHint="Lo que generes en Pedido aparece aquí, con su estado en Kepler."
                        (retry)="cargar()">
          @if (porAprobar().length) {
            <section class="lp-sec">
              <div class="lp-sec-h">
                <h3>Por aprobar · {{ dinero(totalPorAprobar()) }}</h3>
                @if (puedeAutorizar) {
                  <button pButton type="button" class="p-button-sm" [disabled]="ocupado()" (click)="aprobar(porAprobar())">
                    <span class="p-button-label">Aprobar {{ porAprobar().length === 1 ? 'la' : 'las ' + porAprobar().length }} y enviar a Kepler</span>
                  </button>
                }
              </div>
              @if (!puedeAutorizar) { <p class="lp-muted">Las aprueba quien tiene permiso de autorizar compras.</p> }
              <p-table [value]="porAprobar()" dataKey="id" size="small" class="surf-table surf-table--plain">
                <ng-template #body let-r>
                  <tr>
                    <td class="lp-mono"><a [routerLink]="['/compras/requisiciones', r.id]">{{ r.folio }}</a></td>
                    <td>{{ r.warehouse_name || (r.warehouse_code | sucursal) }}</td>
                    <td>{{ que(r) }}@if (r.requested_by_branch) { <span class="lp-muted"> · la pidió la sucursal</span> }</td>
                    <td class="lp-r">{{ dinero(r.total_cost) }}</td>
                    <td class="lp-acc">
                      @if (puedeAutorizar) {
                        @if (rechazando() === r.id) {
                          <input pInputText type="text" class="lp-motivo" [(ngModel)]="motivo" placeholder="Motivo"
                                 [attr.aria-label]="'Motivo para rechazar ' + r.folio" (keyup.enter)="rechazar(r)" />
                          <button pButton type="button" class="p-button-sm p-button-text p-button-danger" [disabled]="ocupado() || (r.requested_by_branch && !motivo.trim())" (click)="rechazar(r)"><span class="p-button-label">Rechazar</span></button>
                          <button pButton type="button" class="p-button-sm p-button-text" (click)="rechazando.set(null)"><span class="p-button-label">Cancelar</span></button>
                        } @else {
                          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="aprobar([r])"><span class="p-button-label">Aprobar</span></button>
                          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="ocupado()" (click)="rechazando.set(r.id); motivo = ''"><span class="p-button-label">Rechazar</span></button>
                        }
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            </section>
          }

          <section class="lp-sec">
            <div class="lp-sec-h"><h3>Lo reciente</h3><a routerLink="/compras/requisiciones" class="lp-link">Ver todo</a></div>
            @if (!recientes().length) {
              <p class="lp-muted">Todavía no hay documentos aprobados.</p>
            } @else {
              <p-table [value]="recientes()" dataKey="id" size="small" class="surf-table surf-table--plain">
                <ng-template #header>
                  <tr><th>Folio</th><th>Sucursal</th><th>Qué</th><th class="lp-r">Costo</th><th>Estado</th><th>En Kepler</th></tr>
                </ng-template>
                <ng-template #body let-r>
                  <tr>
                    <td class="lp-mono"><a [routerLink]="['/compras/requisiciones', r.id]">{{ r.folio }}</a></td>
                    <td>{{ r.warehouse_name || (r.warehouse_code | sucursal) }}</td>
                    <td>{{ que(r) }}</td>
                    <td class="lp-r">{{ dinero(r.total_cost) }}</td>
                    <td>{{ estado(r.estado) }}</td>
                    <td [class.lp-mal]="malEnKepler(r)">{{ enKepler(r) }}</td>
                  </tr>
                </ng-template>
              </p-table>
              @if (totalRecientes() > recientes().length) {
                <p class="lp-muted">Son los {{ recientes().length }} más recientes de {{ totalRecientes() | number }}. El resto, en «Ver todo».</p>
              }
            }
          </section>
        </app-load-state>
      </div>
    </app-side-peek>
    }
  `,
  styles: [`
    :host { display: inline-block; }
    .lp-top { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
    .lp-n { margin-left: .4rem; font-weight: 700; color: var(--fg-1); }
    .lp { display: flex; flex-direction: column; gap: var(--sp-6, 1.5rem); }
    .lp-sec-h { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .5rem; }
    .lp-sec-h h3 { margin: 0; font-size: var(--fs-body); font-weight: 700; color: var(--fg-1); }
    .lp-t { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
    .lp-t th { text-align: left; font-weight: 600; color: var(--fg-2); padding: .35rem .5rem; border-bottom: 1px solid var(--border); }
    .lp-t td { padding: .45rem .5rem; border-bottom: 1px solid var(--border); vertical-align: top; color: var(--fg-1); }
    .lp-r { text-align: right; white-space: nowrap; }
    .lp-mono { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 600; white-space: nowrap; }
    .lp-acc { white-space: nowrap; text-align: right; }
    .lp-motivo { width: 12rem; }
    .lp-muted { color: var(--fg-2); font-size: var(--fs-sm); margin: .25rem 0; }
    .lp-mal { color: var(--bad-fg); }
    .lp-link { font-size: var(--fs-sm); }
  `],
})
export class LoPedidoComponent {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly perms = inject(PermissionsService);
  /** Mismo criterio que la bandeja: la clave, o el god-mode de plataforma (ADR-054). */
  readonly puedeAutorizar = this.perms.isAdmin() || this.perms.has(Permission.COMPRAS_REQUISICIONES_AUTORIZAR);
  /** Sin `COMPRAS_REQUISICIONES_VER` el endpoint contesta 403: no se ofrece lo que no se puede ver. */
  readonly visible = this.perms.isAdmin() || this.perms.has(Permission.COMPRAS_REQUISICIONES_VER);

  readonly abierto = signal(false);
  readonly cargando = signal(false);
  readonly ocupado = signal(false);
  readonly error = signal<string | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  readonly porAprobar = signal<RequisitionRow[]>([]);
  readonly recientes = signal<RequisitionRow[]>([]);
  readonly totalRecientes = signal(0);
  readonly rechazando = signal<string | null>(null);
  motivo = '';
  readonly totalPorAprobar = computed(() => this.porAprobar().reduce((a, r) => a + (Number(r.total_cost) || 0), 0));
  /** El veredicto primero (Q.1), sin color: dónde está lo pedido. Sobre lo que trajo la ventana. */
  readonly cifras = computed<MetricStripItem[]>(() => {
    const rec = this.recientes();
    const n = (e: RequisitionEstado) => rec.filter((r) => r.estado === e).length;
    return [
      { label: 'Por aprobar', value: this.porAprobar().length, sub: this.dinero(this.totalPorAprobar()) },
      { label: 'Aprobadas sin OC', value: rec.filter((r) => r.estado === 'approved').length },
      { label: 'Ordenadas', value: n('ordered') },
      { label: 'Recibidas', value: n('received') },
    ];
  });

  constructor() { this.cargar(); }

  abrir(): void { if (!this.visible) return; this.abierto.set(true); this.cargar(); }
  /** Lo llama Pedido después de generar un lote: el conteo del botón se pone al día. */
  refrescar(): void { this.cargar(); }

  cargar(): void {
    if (!this.visible) return;
    this.cargando.set(this.cargadoEn() === null);
    this.error.set(null);
    forkJoin({
      pend: this.api.listRequisitions({ estado: 'pending_approval', pageSize: 200 }),
      todo: this.api.listRequisitions({ pageSize: 100 }),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: ({ pend, todo }) => {
        this.porAprobar.set(pend.rows);
        const rec = todo.rows.filter((r) => r.estado !== 'pending_approval' && r.estado !== 'draft');
        this.recientes.set(rec);
        this.totalRecientes.set(Math.max(rec.length, (todo.total || 0) - (pend.total || 0)));
        this.cargadoEn.set(new Date());
        this.cargando.set(false);
      },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message || 'error del servidor'); },
    });
  }

  aprobar(rs: RequisitionRow[]): void {
    if (!rs.length) return;
    this.ocupado.set(true);
    const folio = new Map(rs.map((r) => [r.id, r.folio] as const));
    this.api.bulkRequisiciones(rs.map((r) => r.id), 'approve').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.toast.add({
          severity: r.fallas.length ? 'warn' : 'success', life: 10000,
          summary: `${r.hechas} aprobada(s) y en camino a Kepler`,
          detail: r.fallas.map((f) => `${folio.get(f.id) ?? f.id}: ${f.motivo}`).join(' · ') || undefined,
        });
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.toast.add({ severity: 'error', life: 12000, summary: 'No se aprobó', detail: e?.error?.message || 'error del servidor' }); },
    });
  }

  rechazar(r: RequisitionRow): void {
    const m = this.motivo.trim();
    if (r.requested_by_branch && !m) return;
    this.ocupado.set(true);
    this.api.bulkRequisiciones([r.id], 'reject', m || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => {
        this.ocupado.set(false); this.rechazando.set(null);
        if (x.fallas.length) this.toast.add({ severity: 'error', life: 12000, summary: `${r.folio} no se rechazó`, detail: x.fallas[0].motivo });
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.toast.add({ severity: 'error', life: 12000, summary: 'No se rechazó', detail: e?.error?.message || 'error del servidor' }); },
    });
  }

  que(r: RequisitionRow): string {
    return r.source_type === 'branch'
      ? `Traspaso desde ${r.source_warehouse_name || r.source_warehouse_code || 'otra sucursal'}`
      : (r.supplier_name || 'Varios proveedores');
  }

  estado(e: RequisitionEstado): string {
    return ({ draft: 'Borrador', pending_approval: 'Por aprobar', approved: 'Aprobada', ordered: 'Ordenada', received: 'Recibida', cancelled: 'Cancelada' } as const)[e] ?? e;
  }

  /** Lo que pasó en Kepler, en palabras. El motivo de una falla va completo: es lo que hay que arreglar. */
  /** Rojo SÓLO para lo que no salió y hay que arreglar. */
  malEnKepler(r: RequisitionRow): boolean { return !!r.kepler_error && !r.kepler_folio && !r.oc_folio; }

  enKepler(r: RequisitionRow): string {
    if (r.kepler_folio) return `Requisición ${r.kepler_folio}${r.oc_folio ? ` · OC ${r.oc_folio}` : r.source_type === 'branch' ? '' : ' · sin OC todavía'}`;
    if (r.oc_folio) return `OC ${r.oc_folio}`;
    if (r.kepler_error) return r.kepler_error;
    if (r.estado === 'approved') return 'por enviar';
    if (r.estado === 'cancelled') return '—';
    return 'sin dato';
  }

  dinero(n: number | string | null | undefined): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n) || 0);
  }
}
