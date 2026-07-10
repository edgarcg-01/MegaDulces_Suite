import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ComprasService, NetworkNode } from '../compras.service';

/**
 * RA-PRO.6 — Red de abasto (DRP). Define el árbol CEDIS→sucursal: de qué almacén se
 * surte cada sucursal por traspaso. Los que no se surten de nadie son CEDIS (compran a
 * proveedores) y el motor los planea sobre la demanda dependiente de sus sucursales.
 * Superficie Operations.
 */
@Component({
  selector: 'app-compras-red',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cr-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Red de abasto</h1>
          <p class="surf-page-sub">De qué almacén se surte cada sucursal. Los almacenes sin origen son CEDIS: compran a proveedores y el motor los planea sobre la demanda de la red que abastecen.</p>
        </div>
      </header>

      <div class="cr-kpis">
        <div class="cr-kpi"><span class="cr-kpi-val">{{ cedisNodes().length }}</span><span class="cr-kpi-lbl">CEDIS</span></div>
        <div class="cr-kpi"><span class="cr-kpi-val">{{ branchNodes().length }}</span><span class="cr-kpi-lbl">Sucursales surtidas</span></div>
        <div class="cr-kpi"><span class="cr-kpi-val">{{ unlinked().length }}</span><span class="cr-kpi-lbl">Sin origen</span></div>
      </div>

      <p-table [value]="nodes()" [loading]="loading()" styleClass="p-datatable-sm cr-table">
        <ng-template pTemplate="header">
          <tr><th>Almacén</th><th>Rol</th><th>Se surte de</th></tr>
        </ng-template>
        <ng-template pTemplate="body" let-n>
          <tr>
            <td><span class="cr-mono">{{ n.code }}</span> <span class="cr-muted">{{ n.name }}</span></td>
            <td>
              @if (n.is_cedis) { <p-tag value="CEDIS" severity="contrast"></p-tag> }
              @else if (n.source_warehouse_id) { <span class="cr-muted">Sucursal</span> }
              @else { <span class="cr-muted">— sin definir</span> }
            </td>
            <td>
              <p-select [options]="sourceOptsFor(n)" [(ngModel)]="n.source_warehouse_id" (onChange)="save(n)"
                        optionLabel="label" optionValue="value" placeholder="Proveedores (es CEDIS)" [showClear]="true" styleClass="cr-sel"></p-select>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage"><tr><td colspan="3" class="cr-empty">Sin almacenes.</td></tr></ng-template>
      </p-table>
      <p class="cr-foot">El reorden del CEDIS se recalcula en el proceso nocturno con la demanda agregada de sus sucursales (media Σ, varianza combinada).</p>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cr-kpis { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .cr-kpi { display: flex; flex-direction: column; gap: .15rem; padding: .7rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); min-width: 8rem; }
    .cr-kpi-val { font-size: 1.35rem; font-weight: 700; line-height: 1; }
    .cr-kpi-lbl { font-size: .72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
    .cr-table { font-size: .84rem; max-width: 60rem; }
    .cr-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .8rem; }
    .cr-muted { color: var(--text-muted); }
    .cr-sel { min-width: 16rem; }
    .cr-empty { color: var(--text-muted); padding: 1rem; text-align: center; }
    .cr-foot { font-size: .72rem; color: var(--text-muted); margin-top: .5rem; }
  `],
})
export class ComprasRedComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  nodes = signal<NetworkNode[]>([]);
  loading = signal(false);

  cedisNodes = computed(() => this.nodes().filter((n) => n.is_cedis));
  branchNodes = computed(() => this.nodes().filter((n) => !!n.source_warehouse_id));
  unlinked = computed(() => this.nodes().filter((n) => !n.source_warehouse_id && !n.is_cedis));

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.networkTopology().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.nodes.set(r); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo cargar la red.' }); },
    });
  }

  /** Opciones de origen para un almacén: todos menos él mismo. */
  sourceOptsFor(n: NetworkNode): { label: string; value: string }[] {
    return this.nodes().filter((w) => w.id !== n.id).map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id }));
  }

  save(n: NetworkNode): void {
    this.api.setWarehouseSource(n.id, n.source_warehouse_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Guardado', detail: n.code }); this.load(); },
      error: (e) => { this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); this.load(); },
    });
  }
}
