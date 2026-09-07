import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { PendingExpiryLine, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** Un plazo corto es riesgo inmediato: entra y hay que sacarlo casi de inmediato. */
const PLAZO_RIESGOSO_DIAS = 30;
/** Intermedio: sirve, pero hay que traerlo vigilado. */
const PLAZO_INTERMEDIO_DIAS = 90;

/**
 * WMS-REC (ADR-044, revisión Opción A) — **Caducidades · Por fechar**.
 *
 * La cola de trabajo del bodeguero, y nada más que eso: la mercancía a la que
 * recepción ya le dio luz verde entró a inventario SIN fecha (lote `NA`), y acá
 * se le pone lote y caducidad. Poner la fecha reclasifica `NA` → lote fechado:
 * el total del inventario no se mueve, sólo se vuelve trazable.
 *
 * Por qué existe esta pantalla separada del vale: son dos trabajos distintos, de
 * dos personas y dos momentos. Recepción verifica que llegó lo que dice el papel
 * (y aprueba); el bodeguero acomoda y lee las etiquetas. Antes había que hacer
 * ambos en la misma sesión, lo que obligaba a tener el vale abierto mientras
 * alguien recorría la tarima.
 *
 * Se ordena por antigüedad —lo que lleva más días esperando primero— porque el
 * costo de no saber cuándo vence algo crece con el tiempo que lleva en el piso.
 */
@Component({
  selector: 'app-almacen-caducidades-por-fechar',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule,
    InputTextModule, DialogModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caducidades · Por fechar</h1>
          <p class="surf-page-sub">
            Mercancía ya aprobada en recepción que está en existencia sin fecha. Lo más viejo esperando, primero.
          </p>
        </div>
        <div class="cpf-head-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseFilter" optionLabel="label" optionValue="value"
            (onChange)="load()" styleClass="cpf-wh" placeholder="Todos los almacenes"></p-select>
          <button pButton [text]="true" size="small" severity="secondary" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span> Actualizar
          </button>
        </div>
      </header>

      @if (rows().length) {
        <div class="cpf-summary" role="status">
          <span><strong>{{ rows().length }}</strong> renglón(es) por fechar</span>
          <span class="cpf-dot" aria-hidden="true">·</span>
          <span><strong>{{ totalPendiente() }}</strong> unidades sin trazabilidad</span>
          @if (totalRetenido() > 0) {
            <span class="cpf-dot" aria-hidden="true">·</span>
            <span><strong>{{ totalRetenido() }}</strong> retenidas por autorizar</span>
          }
          @if (masViejo() > 0) {
            <span class="cpf-dot" aria-hidden="true">·</span>
            <span>el más viejo lleva <strong>{{ masViejo() }}</strong> día(s)</span>
          }
        </div>
      }

      <p-table [value]="rows()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra"
        [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25" [rowsPerPageOptions]="[25,50,100]">
        <ng-template #header>
          <tr>
            <th style="width:6.5rem">Espera</th>
            <th style="width:7.5rem">SKU</th>
            <th>Producto</th>
            <th style="width:8rem" class="surf-num">Por fechar</th>
            <th style="width:8rem" class="surf-num">Retenido</th>
            <th style="width:8rem" class="surf-num">Recibido</th>
            <th style="width:9rem">Vale</th>
            <th style="width:9rem">Almacén</th>
            <th style="width:8rem"></th>
          </tr>
        </ng-template>
        <ng-template #body let-r>
          <tr>
            <td><p-tag [value]="r.dias_esperando + ' d'" [severity]="esperaSeverity(r.dias_esperando)"></p-tag></td>
            <td class="surf-mono">{{ r.sku || '—' }}</td>
            <td>{{ r.product_name || '—' }}</td>
            <td class="surf-num"><strong>{{ r.pending_qty }}</strong></td>
            <td class="surf-num">
              @if (r.held_qty > 0) {
                <p-tag [value]="r.held_qty" severity="danger"
                  pTooltip="Ya tiene fecha pero quedó retenida: un supervisor debe autorizarla"></p-tag>
              } @else { <span class="surf-muted">—</span> }
            </td>
            <td class="surf-num surf-muted">{{ r.received_qty }}</td>
            <td class="surf-mono">{{ r.vale_folio }}</td>
            <td>{{ r.warehouse_code || r.warehouse_name || '—' }}</td>
            <td>
              @if (canCapture() && r.pending_qty > 0) {
                <button pButton size="small" (click)="abrirDeclarar(r)">
                  <span class="p-button-icon p-button-icon-left pi pi-calendar-plus" aria-hidden="true"></span> Fechar
                </button>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="comm-empty-cell">
            <div class="comm-empty">
              <div class="comm-empty-icon"><i class="pi pi-check-circle" aria-hidden="true"></i></div>
              <h3>Nada esperando fecha</h3>
              <p>Toda la mercancía aprobada en recepción tiene su lote y caducidad declarados.</p>
            </div>
          </td></tr>
        </ng-template>
      </p-table>

      <!-- Declarar lote + caducidad de un renglón -->
      <p-dialog [(visible)]="declararVisible" [modal]="true" [style]="{ width: '30rem' }" header="Declarar caducidad">
        @if (sel()) {
          <div class="cpf-form">
            <div class="cpf-ficha">
              <div><span>Producto</span><strong>{{ sel()!.product_name || sel()!.sku }}</strong></div>
              <div><span>Vale</span><strong class="surf-mono">{{ sel()!.vale_folio }}</strong></div>
              <div><span>Falta fechar</span><strong>{{ sel()!.pending_qty }}</strong></div>
            </div>

            <label for="cpf-lote">Lote</label>
            <input id="cpf-lote" pInputText [(ngModel)]="lote" placeholder="Como viene en la etiqueta" />

            <label for="cpf-vence">Caducidad</label>
            <input id="cpf-vence" pInputText type="date" [(ngModel)]="vence" />
            @if (plazo() !== null) {
              <p class="cpf-plazo" [class]="'cpf-plazo--' + clasificacion()">
                <i class="pi" [class.pi-check-circle]="clasificacion() === 'bueno'"
                   [class.pi-exclamation-triangle]="clasificacion() === 'intermedio'"
                   [class.pi-times-circle]="clasificacion() === 'malo'" aria-hidden="true"></i>
                {{ plazo() }} días de vida · {{ etiquetaPlazo() }}
              </p>
            }

            <label for="cpf-cant">Cantidad de este lote</label>
            <input id="cpf-cant" pInputText type="number" [(ngModel)]="cantidad"
              [min]="1" [max]="sel()!.pending_qty" step="1" />
            <p class="cpf-hint">
              Si la tarima trae varios lotes, se declara uno por vez: el renglón sigue en la lista con lo que falte.
            </p>
          </div>
        }
        <ng-template #footer>
          <button pButton [text]="true" severity="secondary" (click)="declararVisible = false">Cancelar</button>
          <button pButton [disabled]="!puedeGuardar() || guardando()" (click)="guardar()">
            <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Guardar
          </button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .cpf-head-actions { display:flex; align-items:center; gap:.5rem; }
    .cpf-wh { min-width:14rem; }
    .cpf-summary {
      display:flex; align-items:center; gap:.5rem; flex-wrap:wrap;
      font-size:.8125rem; color:var(--surf-text-muted, #6b7280);
      padding:.5rem .75rem; margin-bottom:.5rem;
      background:var(--surf-panel, #fafaf9); border:1px solid var(--surf-border, #e7e5e4); border-radius:.5rem;
    }
    .cpf-dot { opacity:.5; }
    .cpf-form { display:flex; flex-direction:column; gap:.375rem; }
    .cpf-form label { font-size:.75rem; font-weight:600; margin-top:.5rem; }
    .cpf-ficha { display:grid; gap:.25rem; padding:.625rem .75rem; margin-bottom:.5rem;
      background:var(--surf-panel, #fafaf9); border:1px solid var(--surf-border, #e7e5e4); border-radius:.5rem; }
    .cpf-ficha > div { display:flex; justify-content:space-between; gap:1rem; font-size:.8125rem; }
    .cpf-ficha span { color:var(--surf-text-muted, #6b7280); }
    .cpf-plazo { display:flex; align-items:center; gap:.375rem; margin:.25rem 0 0; font-size:.75rem; font-weight:600; }
    .cpf-plazo--bueno { color:#16a34a; }
    .cpf-plazo--intermedio { color:#d97706; }
    .cpf-plazo--malo { color:#dc2626; }
    .cpf-hint { margin:.375rem 0 0; font-size:.6875rem; color:var(--surf-text-muted, #6b7280); }
  `],
})
export class AlmacenCaducidadesPorFecharComponent implements OnInit {
  private readonly api = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly comercial = inject(ComercialService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);


  readonly rows = signal<PendingExpiryLine[]>([]);
  readonly loading = signal(false);
  readonly guardando = signal(false);
  readonly warehouses = signal<Warehouse[]>([]);
  readonly sel = signal<PendingExpiryLine | null>(null);

  warehouseFilter: string | null = null;
  declararVisible = false;
  lote = '';
  vence = '';
  cantidad = 1;

  readonly warehouseOptions = computed(() => [
    { label: 'Todos los almacenes', value: null },
    ...this.warehouses().map((w) => ({ label: `${w.code} — ${w.name}`, value: w.id })),
  ]);

  readonly totalPendiente = computed(() => this.rows().reduce((a, r) => a + Number(r.pending_qty), 0));
  readonly totalRetenido = computed(() => this.rows().reduce((a, r) => a + Number(r.held_qty || 0), 0));
  readonly masViejo = computed(() => this.rows().reduce((a, r) => Math.max(a, Number(r.dias_esperando) || 0), 0));

  // Mismo criterio que la hoja de anaquel: manage-all o el permiso puntual del JWT.
  private readonly puedeCapturar =
    this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR];
  canCapture = () => this.puedeCapturar;

  /**
   * Días de vida que le quedan al producto contados desde hoy.
   *
   * Se compara texto `YYYY-MM-DD` convertido a UTC a mediodía, no `new Date()` del
   * input: construir la fecha en zona local corre el día a la anterior según la hora
   * y el resultado saldría desfasado por uno.
   */
  // Métodos, no `computed`: `vence` lo escribe `[(ngModel)]` sobre un campo plano,
  // no una señal, así que un computed nunca se invalidaría y el semáforo no
  // aparecería jamás. Como método se reevalúa en cada ciclo de detección.
  plazo(): number | null {
    const v = (this.vence || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const hoy = new Date();
    const hoyUtc = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 12);
    const [y, m, d] = v.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d, 12) - hoyUtc) / 86400000);
  }

  clasificacion(): 'bueno' | 'intermedio' | 'malo' {
    const p = this.plazo();
    if (p === null) return 'bueno';
    if (p < PLAZO_RIESGOSO_DIAS) return 'malo';
    if (p < PLAZO_INTERMEDIO_DIAS) return 'intermedio';
    return 'bueno';
  }

  etiquetaPlazo(): string {
    switch (this.clasificacion()) {
      case 'malo': return 'plazo corto — sacarlo pronto';
      case 'intermedio': return 'plazo intermedio — vigilar';
      default: return 'buen plazo';
    }
  }

  /** La espera se pinta como riesgo: a más días sin fecha, peor. */
  esperaSeverity(dias: number): 'success' | 'warn' | 'danger' {
    if (dias >= 7) return 'danger';
    if (dias >= 2) return 'warn';
    return 'success';
  }

  puedeGuardar(): boolean {
    const s = this.sel();
    return !!s && !!this.lote.trim() && this.plazo() !== null && this.cantidad > 0 && this.cantidad <= s.pending_qty;
  }

  ngOnInit(): void {
    this.comercial.listWarehouses(true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (w: Warehouse[]) => this.warehouses.set(w || []),
      error: () => this.warehouses.set([]),
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .pendingExpiry({ warehouse_id: this.warehouseFilter || undefined, limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r: PendingExpiryLine[]) => { this.rows.set(r || []); this.loading.set(false); },
        error: (e: any) => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar', detail: e?.error?.message || 'Error' });
        },
      });
  }

  abrirDeclarar(r: PendingExpiryLine): void {
    this.sel.set(r);
    this.lote = '';
    this.vence = '';
    this.cantidad = Number(r.pending_qty) || 1;
    this.declararVisible = true;
  }

  guardar(): void {
    const s = this.sel();
    if (!s || !this.puedeGuardar()) return;
    this.guardando.set(true);
    this.auditor
      .evaluate({
        warehouse_id: s.warehouse_id,
        product_id: s.product_id,
        receiving_line_id: s.line_id,
        source_ref: s.source_ref || undefined,
        supplier_code: s.supplier_code || undefined,
        quantity: this.cantidad,
        confirmed_lot: this.lote.trim(),
        confirmed_expiry: this.vence.slice(0, 10),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cap: { verdict?: string; rule_broken?: string | null }) => {
          this.guardando.set(false);
          this.declararVisible = false;
          // El veredicto del auditor se comunica tal cual: rojo NO entra a FEFO
          // hasta que un supervisor lo libere, y eso el bodeguero tiene que saberlo.
          const rojo = cap.verdict === 'red';
          this.toast.add({
            severity: rojo ? 'warn' : 'success',
            summary: rojo ? 'Queda pendiente de autorización' : 'Caducidad declarada',
            detail: rojo
              ? `${this.cantidad} unidades marcadas ${cap.rule_broken || 'fuera de política'} — un supervisor debe autorizarlas`
              : `${this.cantidad} unidades en lote ${this.lote.trim()}`,
          });
          this.load();
        },
        error: (e: any) => {
          this.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Error' });
        },
      });
  }
}
