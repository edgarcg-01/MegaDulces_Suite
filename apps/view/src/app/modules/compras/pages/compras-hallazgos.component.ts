import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ComprasService, ReplenishmentFinding, FindingSeverity, FindingKind } from '../compras.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

/**
 * RA.8 — Bandeja de hallazgos de reabastecimiento. El scanner nocturno detecta lo
 * crítico (agotados clase A / bajo reorden) y lo deja aquí; el comprador lo trabaja.
 * Superficie Operations (PrimeNG denso, quiet-luxury).
 */
@Component({
  selector: 'app-compras-hallazgos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in hz-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Hallazgos de reabastecimiento</h1>
          <p class="surf-page-sub">Lo que el motor detectó crítico: agotados clase A y productos bajo punto de reorden. El scan corre cada noche.</p>
        </div>
        <div class="hz-head-actions">
          <button pButton type="button" label="Escanear ahora" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
        </div>
      </header>

      <div class="hz-filters">
        <p-select [options]="statusOpts" [(ngModel)]="fStatus" (onChange)="reload()" optionLabel="label" optionValue="value" styleClass="hz-sel"></p-select>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="reload()" optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true" styleClass="hz-sel"></p-select>
        <span class="hz-count">{{ total() | number }} hallazgo(s)</span>
      </div>

      <p-table [value]="rows()" [loading]="loading()" [scrollable]="true" scrollHeight="flex"
               styleClass="p-datatable-sm hz-table">
        <ng-template pTemplate="header">
          <tr>
            <th>Severidad</th><th>SKU</th><th>Producto</th><th>Almacén</th><th>ABC</th>
            <th class="hz-r">Existencia</th><th class="hz-r">Reorden</th><th class="hz-r">OC a recibir</th>
            <th class="hz-r">Sugerido</th><th class="hz-r">Costo est.</th><th>Proveedor</th><th>Detectado</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-f>
          <tr>
            <td><p-tag [value]="sevLabel(f.severity)" [severity]="sevTag(f.severity)"></p-tag></td>
            <td class="hz-mono">{{ f.sku }}</td>
            <td>{{ f.nombre }}</td>
            <td class="hz-muted">{{ f.warehouse_code }}</td>
            <td class="hz-muted">{{ f.abc_class || '—' }}</td>
            <td class="hz-r" [class.hz-bad]="f.on_hand <= 0">{{ f.on_hand | number:'1.0-0' }}</td>
            <td class="hz-r hz-muted">{{ f.reorder_point | number:'1.0-0' }}</td>
            <td class="hz-r">{{ f.in_transit > 0 ? (f.in_transit | number:'1.0-0') : '—' }}</td>
            <td class="hz-r hz-strong">{{ f.suggested_qty | number:'1.0-0' }}</td>
            <td class="hz-r">{{ money(f.suggested_cost) }}</td>
            <td class="hz-muted">{{ f.supplier_name || '—' }}</td>
            <td class="hz-muted">{{ f.first_seen_at | date:'dd/MM/yy' }}</td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="12" class="hz-empty">Sin hallazgos {{ fStatus === 'open' ? 'abiertos' : '' }}. Corre "Escanear ahora" para detectar.</td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .hz-head-actions { display: flex; gap: .5rem; align-items: center; }
    .hz-filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    .hz-sel { min-width: 12rem; }
    .hz-count { color: var(--text-muted, #8a8580); font-size: .82rem; margin-left: auto; }
    .hz-table { font-size: .82rem; }
    .hz-r { text-align: right; font-variant-numeric: tabular-nums; }
    .hz-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .hz-muted { color: var(--text-muted, #8a8580); }
    .hz-strong { font-weight: 700; }
    .hz-bad { color: var(--red-600, #dc2626); font-weight: 600; }
    .hz-empty { color: var(--text-muted, #8a8580); padding: 1rem; text-align: center; }
  `],
})
export class ComprasHallazgosComponent implements OnInit {
  private readonly api = inject(ComprasService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  rows = signal<ReplenishmentFinding[]>([]);
  total = signal(0);
  loading = signal(false);
  scanning = signal(false);

  fStatus = 'open';
  fKind = '';
  statusOpts = [{ label: 'Abiertos', value: 'open' }, { label: 'Resueltos', value: 'resolved' }];
  kindOpts = [
    { label: 'Agotado (clase A)', value: 'agotado_abc' },
    { label: 'Bajo reorden', value: 'bajo_reorden' },
  ];

  ngOnInit(): void { this.reload(); }

  reload(): void {
    this.loading.set(true);
    this.api.findings({ status: this.fStatus, kind: this.fKind || undefined, pageSize: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar los hallazgos.' }); },
      });
  }

  scan(): void {
    this.scanning.set(true);
    this.api.scanNow().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Scan completo', detail: `${r.findings} hallazgo(s) activos` }); this.reload(); },
      error: (e) => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo escanear.' }); },
    });
  }

  money(v: number | string | null | undefined) { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  sevLabel(s: FindingSeverity) { return ({ critica: 'Crítica', alta: 'Alta', media: 'Media' } as Record<FindingSeverity, string>)[s]; }
  sevTag(s: FindingSeverity): Sev { return ({ critica: 'danger', alta: 'warn', media: 'secondary' } as Record<FindingSeverity, Sev>)[s]; }
  kindLabel(k: FindingKind) { return ({ agotado_abc: 'Agotado A', bajo_reorden: 'Bajo reorden' } as Record<FindingKind, string>)[k]; }
}
