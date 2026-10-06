import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MultitareaService } from '../../../core/services/multitarea.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, InventoryCount, Warehouse, AssignableUser, AbcSummary } from '../comercial.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { forkJoin } from 'rxjs';

/**
 * Los estados en que un folio todavía ocupa su almacén. `open` y `ready_to_reconcile`
 * están en el CHECK de la tabla pero ningún escritor del backend los produce hoy
 * (medido 2026-10-06); se dejan porque el CHECK los admite y un folio viejo podría traerlos.
 */
const ACTIVOS = ['open', 'counting', 'review', 'ready_to_reconcile'];

/**
 * `[IC.13]` Cuánto silencio convierte un folio en "sin avanzar".
 *
 * ⚠️ Es una **convención de pantalla, no un umbral medido**: no hay registro de cuánto
 * tarda normalmente un conteo acá (los 6 folios de prod se cancelaron todos). Vive como
 * constante con nombre justamente para que se vea que alguien la eligió y se pueda
 * discutir, en vez de quedar como un `24 * 3600 * 1000` suelto adentro de un `if`.
 */
const HORAS_SIN_AVANZAR = 24;
/** A partir de acá el aviso pasa de ámbar a rojo. Misma salvedad que el de arriba. */
const DIAS_ABANDONADO = 7;

/**
 * Lista de folios de inventario + apertura de uno nuevo (supervisor).
 */
@Component({
  selector: 'app-comercial-inventory-sessions',
  standalone: true,
  imports: [RouterLink, 
    CommonModule, FormsModule, RouterModule,
    ButtonModule, TableModule, TagModule, SelectModule, DialogModule, ToggleSwitchModule, InputNumberModule, MultiSelectModule, ToastModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>


      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Inventarios físicos</h1>
          <p class="surf-page-sub">
            <b>{{ counts().length }}</b> folio{{ counts().length === 1 ? '' : 's' }}
            @if (hayTope()) { <span class="in-sub-note">· tope de la lista, puede haber más</span> }
            @if (activos() > 0) { <span class="in-sub-note">· <b>{{ activos() }}</b> en curso</span> }
            @if (congelando() > 0) { <span class="in-sub-warn">· <b>{{ congelando() }}</b> congelando su almacén</span> }
          </p>
        </div>
        <div class="in-head-actions">
          <button pButton size="small" (click)="openDialog()"><span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Abrir folio</span></button>
          <button pButton [text]="true" severity="secondary" size="small" (click)="load()" [loading]="loading()" aria-label="Recargar"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      <p-table [value]="counts()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [scrollable]="true">
        <ng-template #header>
          <tr>
            <th scope="col">Folio</th><th scope="col">Almacén</th><th scope="col">Tipo</th>
            <th scope="col">Avance</th><th scope="col">Estado</th>
            <th scope="col">Inicio</th><th scope="col">Última actividad</th>
            <th scope="col"><span class="sr-only">Acciones</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-c>
          <tr
            class="comm-row-clickable"
            role="button"
            tabindex="0"
            [attr.aria-label]="'Abrir folio ' + c.folio"
            [routerLink]="multitarea.enlaceDetalle(['/almacen/inventory/sessions', c.id])"
            (keydown.enter)="goToFolio(c.id)"
            (keydown.space)="$event.preventDefault(); goToFolio(c.id)">
            <td class="in-mono"><a class="surf-cell-link" [routerLink]="multitarea.enlaceDetalle(['/almacen/inventory/sessions', c.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()">{{ c.folio }}</a></td>
            <td>{{ c.warehouse_code }} · {{ c.warehouse_name }}</td>
            <td>{{ c.type === 'full' ? 'Total' : 'Cíclico' }}</td>

            <!-- [IC.13] El avance es la única columna que responde "¿esto va?". -->
            <td class="in-avance-cell">
              @if (!c.items_total) {
                <span class="in-dim" title="El folio no tiene SKUs en el snapshot de apertura">Sin snapshot</span>
              } @else {
                <div class="in-bar" [attr.aria-hidden]="true"><span [style.width.%]="pct(c)"></span></div>
                <span class="in-avance-txt" [class.in-avance-cero]="!c.items_counted">
                  {{ c.items_counted | number }} / {{ c.items_total | number }}
                  <span class="in-dim">({{ pct(c) | number:'1.0-1' }}%)</span>
                </span>
              }
            </td>

            <td>
              <p-tag [value]="statusLabel(c.status)" [severity]="statusSeverity(c.status)"></p-tag>
              <!-- Congelado se marca SIEMPRE que el folio esté vivo, no recién a las 24 h:
                   es el dato que explica por qué el almacén no se mueve. -->
              @if (estaCongelando(c)) {
                <span class="in-chip in-chip-frio" title="Este folio bloquea pedidos y ajustes en su almacén mientras siga abierto"><i class="pi pi-lock" aria-hidden="true"></i> Congelado</span>
              }
              @if (alerta(c); as a) {
                <span class="in-chip" [class.in-chip-rojo]="a.grave" [class.in-chip-ambar]="!a.grave" [title]="a.detalle"><i class="pi pi-clock" aria-hidden="true"></i> {{ a.etiqueta }}</span>
              }
            </td>

            <td>{{ c.started_at ? (c.started_at | date:'short') : '—' }}</td>

            <!-- NULL = nadie contó nunca. No se disfraza con started_at. -->
            <td [title]="c.last_count_at ? (c.last_count_at | date:'medium') : 'Sin un solo escaneo registrado'">
              @if (c.last_count_at) {
                {{ hace(c.last_count_at) }}
              } @else {
                <span class="in-dim">Sin conteos</span>
              }
            </td>

            <td>
              <a pButton size="small" [text]="true" [routerLink]="multitarea.enlaceDetalle(['/almacen/inventory/sessions', c.id])" [target]="multitarea.target()" (click)="$event.stopPropagation()"><span class="p-button-icon p-button-icon-left pi pi-arrow-right" aria-hidden="true"></span><span class="p-button-label">Abrir</span></a>
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="comm-empty-cell">
            <div class="comm-empty">
              <i class="pi pi-clipboard comm-empty-icon"></i>
              <span>No hay folios. Abrí uno para empezar a contar.</span>
            </div>
          </td></tr>
        </ng-template>
      </p-table>

      <!-- Dialog: abrir folio -->
      <p-dialog [(visible)]="dialogVisible" header="Abrir folio de inventario" [modal]="true"
                [draggable]="false" [dismissableMask]="true"
                [style]="{ width: '92vw', maxWidth: '460px' }"
                [contentStyle]="{ maxHeight: '72vh', overflow: 'auto' }"
                [breakpoints]="{ '640px': '96vw' }">
        <div class="in-form">
          <label>Almacén</label>
          <!-- Forma explícita, NO banana-in-a-box + (ngModelChange): los dos handlers LEEN
               la señal que acaban de cambiar, y con el banana el orden dependería del orden
               de los atributos. Acá el .set() corre primero porque está escrito primero. -->
          <p-select [options]="warehouses()" [ngModel]="formWarehouse()" (ngModelChange)="formWarehouse.set($event); onAlmacenChange()" optionLabel="label" optionValue="id" placeholder="Elegí el almacén" styleClass="in-w-full" [filter]="true" appendTo="body"></p-select>

          <label>Tipo de conteo</label>
          <p-select [options]="typeOptions" [ngModel]="formType()" (ngModelChange)="formType.set($event); onTipoChange()" optionLabel="label" optionValue="value" styleClass="in-w-full" appendTo="body"></p-select>

          <!-- [IC.13] El cíclico de verdad: acotado por clase ABC. Antes esta opción
               mandaba un folio TOTAL con la etiqueta "parcial" y congelaba la sucursal. -->
          @if (formType() === 'cycle') {
            <label>Clase ABC a contar</label>
            @if (abcCargando()) {
              <small class="in-dim">Leyendo la clasificación ABC del almacén…</small>
            } @else if (!formWarehouse()) {
              <small class="in-dim">Elegí primero el almacén.</small>
            } @else if (abcTotal() === 0) {
              <div class="in-aviso">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <span>Este almacén <b>no tiene clasificación ABC</b>, así que no se puede acotar el conteo.
                  Corré <b>Recalcular ABC</b> en la pestaña <b>Cíclico (ABC)</b>, o abrí un conteo <b>Total</b>.</span>
              </div>
            } @else {
              <p-select [options]="abcOptions()" [(ngModel)]="formAbcClass" optionLabel="label" optionValue="value"
                        styleClass="in-w-full" appendTo="body"></p-select>
              <label>Tope de SKUs en el folio</label>
              <p-inputnumber [(ngModel)]="formMaxItems" [min]="1" [max]="2000" [showButtons]="true" styleClass="in-w-full"></p-inputnumber>
              <small>Toma los de mayor valor anual de la clase elegida. El folio cuenta <b>sólo</b> esos SKUs.</small>
            }
          }

          <div class="in-toggle-row">
            <p-toggleswitch [(ngModel)]="formFreeze"></p-toggleswitch>
            <div>
              <span class="in-toggle-label">Congelar movimientos</span>
              @if (formType() === 'cycle') {
                <small>Bloquea pedidos/ajustes en todo el almacén. <b>En un conteo cíclico normalmente va apagado</b> — se cuenta sin parar la operación.</small>
              } @else {
                <small>Bloquea pedidos/ajustes en este almacén durante el conteo (recomendado).</small>
              }
            </div>
          </div>
          <div class="in-toggle-row">
            <p-toggleswitch [(ngModel)]="formBlind"></p-toggleswitch>
            <div>
              <span class="in-toggle-label">Doble conteo ciego</span>
              <small>Cada SKU lo cuentan dos personas distintas; las diferencias escalan a reconteo.</small>
            </div>
          </div>

          <label>Umbral de recuento (%)</label>
          <p-inputnumber [(ngModel)]="formThreshold" [min]="0" [max]="100" [maxFractionDigits]="2" styleClass="in-w-full"></p-inputnumber>
          <small>0 = sin umbral. Si dos conteos coinciden pero difieren del teórico más que este %, el SKU queda como discrepancia (recuento/revisión) en vez de auto-resolverse.</small>

          @if (canAssign()) {
            <label>Contadores (quiénes van a contar)</label>
            <p-multiselect [options]="counterOpts()" [(ngModel)]="selCounters" optionLabel="label" optionValue="value"
                           placeholder="Todos los que tengan permiso (folio abierto)" [filter]="true" display="chip"
                           styleClass="in-w-full" appendTo="body" scrollHeight="45vh"
                           [panelStyle]="{ maxWidth: '92vw' }"></p-multiselect>
            <label>Supervisores responsables</label>
            <p-multiselect [options]="supervisorOpts()" [(ngModel)]="selSupervisors" optionLabel="label" optionValue="value"
                           placeholder="Sin asignar" [filter]="true" display="chip"
                           styleClass="in-w-full" appendTo="body" scrollHeight="45vh"
                           [panelStyle]="{ maxWidth: '92vw' }"></p-multiselect>
          }
        </div>
        <ng-template #footer>
          <button pButton [text]="true" severity="secondary" (click)="dialogVisible.set(false)"><span class="p-button-label">Cancelar</span></button>
          <button pButton [loading]="opening()" [disabled]="!puedeAbrir()" (click)="open()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Abrir</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    /* Tokens de libs/design-tokens/tokens.css, SIN fallback de color: un fallback acá
       clavaría el valor de modo claro y en dark se leería mal. Los nombres se verificaron
       contra el archivo: --danger-soft-* y --surface-3 NO existen; son
       --bad-soft-* y --hover-bg. */
    .in-mono { font-family: var(--font-mono, monospace); font-weight: 600; }
    .in-dim { color: var(--text-muted); }
    .in-sub-note { color: var(--text-muted); }
    .in-sub-warn { color: var(--warn-soft-fg); font-weight: 600; }

    .in-chip { display: inline-flex; align-items: center; gap: .25rem; margin-left: .4rem; font-size: .72rem; font-weight: 600; padding: .1rem .4rem; border-radius: var(--r-pill, 999px); white-space: nowrap; }
    .in-chip i { font-size: .7rem; }
    .in-chip-ambar { color: var(--warn-soft-fg); background: var(--warn-soft-bg); }
    .in-chip-rojo { color: var(--bad-soft-fg); background: var(--bad-soft-bg); }
    .in-chip-frio { color: var(--info-soft-fg); background: var(--info-soft-bg); }

    .in-avance-cell { min-width: 9.5rem; }
    .in-bar { height: 4px; border-radius: var(--r-pill, 999px); background: var(--hover-bg); overflow: hidden; margin-bottom: .2rem; }
    .in-bar > span { display: block; height: 100%; background: var(--action); }
    .in-avance-txt { font-size: .75rem; font-variant-numeric: tabular-nums; }
    .in-avance-cero { color: var(--warn-soft-fg); font-weight: 600; }

    .in-aviso { display: flex; gap: .5rem; align-items: flex-start; font-size: .78rem; line-height: 1.35; color: var(--warn-soft-fg); background: var(--warn-soft-bg); padding: .5rem .6rem; border-radius: var(--r-md, 8px); }
    .in-aviso i { margin-top: .1rem; }

    .in-head-actions { display: flex; gap: .5rem; }
    .in-form { display: flex; flex-direction: column; gap: .4rem; }
    .in-form label { font-size: .8rem; font-weight: 600; color: var(--text-muted, #78716c); margin-top: .6rem; }
    :host ::ng-deep .in-w-full { width: 100%; }
    .in-toggle-row { display: flex; gap: .75rem; align-items: flex-start; margin-top: .9rem; }
    .in-toggle-label { font-weight: 600; display: block; }
    .in-toggle-row small { color: var(--text-muted, #78716c); }
  `],
})
export class ComercialInventorySessionsComponent {
  /** `[MT.3]` Con la preferencia prendida, el detalle abre en otra ventana. */
  readonly multitarea = inject(MultitareaService);

  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  counts = signal<InventoryCount[]>([]);
  warehouses = signal<{ id: string; label: string }[]>([]);
  loading = signal(false);
  opening = signal(false);
  dialogVisible = signal(false);

  formWarehouse = signal<string | null>(null);
  formType = signal<'full' | 'cycle'>('full');
  formFreeze = signal(true);
  formBlind = signal(true);
  formThreshold = signal(0);
  /** `[IC.13]` Sólo aplican al folio cíclico. */
  formAbcClass = signal<'A' | 'B' | 'C'>('A');
  formMaxItems = signal(100);
  abcResumen = signal<AbcSummary | null>(null);
  abcCargando = signal(false);

  /** `[IC.13]` El tope de `listCounts`. Si la lista viene llena, lo decimos. */
  private readonly TOPE_LISTA = 200;
  hayTope = computed(() => this.counts().length >= this.TOPE_LISTA);
  activos = computed(() => this.counts().filter((c) => ACTIVOS.includes(c.status)).length);
  congelando = computed(() => this.counts().filter((c) => this.estaCongelando(c)).length);

  abcTotal = computed(() => {
    const s = this.abcResumen();
    if (!s?.by_class) return 0;
    return (['A', 'B', 'C'] as const).reduce((a, k) => a + (s.by_class[k]?.count ?? 0), 0);
  });
  abcOptions = computed(() => {
    const s = this.abcResumen();
    return (['A', 'B', 'C'] as const)
      .map((k) => ({ k, n: s?.by_class?.[k]?.count ?? 0 }))
      .filter((x) => x.n > 0)
      .map((x) => ({ label: `Clase ${x.k} — ${x.n.toLocaleString('es-MX')} SKUs`, value: x.k }));
  });

  /**
   * Se puede abrir cuando hay almacén y —si es cíclico— hay una clase ABC real que contar.
   * Sin esto el botón mandaba al backend un folio cíclico que `[IC.13]` ahora rechaza, y
   * la persona sólo veía un error.
   */
  puedeAbrir = computed(() => {
    if (!this.formWarehouse()) return false;
    if (this.formType() === 'cycle') {
      if (this.abcCargando() || this.abcTotal() === 0) return false;
      if (!this.abcOptions().some((o) => o.value === this.formAbcClass())) return false;
    }
    return true;
  });

  /**
   * `[IC.13]` Era un `signal(...)` evaluado **una sola vez en el constructor**. `AuthService`
   * reemplaza `user()` cuando `me/access` contesta (`[ID.21]`), así que si el initializer de
   * 3 s expiraba y el mapa fresco llegaba después, esto quedaba mal hasta recargar la página.
   * Como `computed`, sigue al mapa.
   */
  canAssign = computed(() => this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR] === true);
  counterOpts = signal<{ label: string; value: string }[]>([]);
  supervisorOpts = signal<{ label: string; value: string }[]>([]);
  selCounters = signal<string[]>([]);
  selSupervisors = signal<string[]>([]);

  typeOptions = [
    { label: 'Total (todo el almacén)', value: 'full' },
    // `[IC.13]` Decía "Cíclico (parcial)" y mandaba un folio TOTAL. El rótulo ahora nombra
    // lo que de verdad acota el folio, que es la clase ABC.
    { label: 'Cíclico (por clase ABC)', value: 'cycle' },
  ];

  constructor() {
    this.load();
  }

  goToFolio(id: string) {
    this.router.navigate(['/almacen/inventory/sessions', id]);
  }

  load() {
    this.loading.set(true);
    this.svc.listInventoryCounts()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (c) => { this.counts.set(c); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar folios' }); },
      });
  }

  openDialog() {
    if (!this.warehouses().length) {
      this.svc.listWarehouses()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (ws: Warehouse[]) => this.warehouses.set(ws.map((w) => ({ id: w.id, label: `${w.code} · ${w.name}` }))),
        });
    }
    if (this.canAssign() && !this.counterOpts().length) {
      const opt = (u: AssignableUser) => ({ label: `${u.nombre || u.username} (${u.role_name})`, value: u.id });
      this.svc.inventoryAssignableUsers('counter').pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (us) => this.counterOpts.set(us.map(opt)) });
      this.svc.inventoryAssignableUsers('supervisor').pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (us) => this.supervisorOpts.set(us.map(opt)) });
    }
    this.selCounters.set([]);
    this.selSupervisors.set([]);
    this.dialogVisible.set(true);
  }

  /** `[IC.13]` El cíclico se acota con la clasificación ABC del almacén elegido. */
  onAlmacenChange() {
    this.abcResumen.set(null);
    if (this.formType() === 'cycle') this.cargarAbc();
  }

  onTipoChange() {
    // El cíclico NO congela por default — es su razón de ser: contar sin parar la
    // operación. El total sí. Mismo criterio que `openCycleCount` en el backend.
    this.formFreeze.set(this.formType() !== 'cycle');
    if (this.formType() === 'cycle') this.cargarAbc();
  }

  private cargarAbc() {
    const wh = this.formWarehouse();
    if (!wh || this.abcResumen()) return;
    this.abcCargando.set(true);
    this.svc.abcSummary(wh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s: AbcSummary) => {
          this.abcResumen.set(s);
          this.abcCargando.set(false);
          // Si la clase elegida no existe en este almacén, caer a la primera que sí.
          const opts = this.abcOptions();
          if (opts.length && !opts.some((o) => o.value === this.formAbcClass()))
            this.formAbcClass.set(opts[0].value);
        },
        // Un error de lectura NO se disfraza de "este almacén no tiene ABC": se deja el
        // resumen en null y `puedeAbrir()` frena, con el aviso de arriba.
        error: () => {
          this.abcCargando.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se pudo leer la clasificación ABC', detail: 'Probá de nuevo o abrí un conteo Total.' });
        },
      });
  }

  open() {
    const warehouse_id = this.formWarehouse();
    if (!warehouse_id || !this.puedeAbrir()) return;
    this.opening.set(true);
    const esCiclico = this.formType() === 'cycle';
    const peticion = esCiclico
      ? this.svc.openCycleInventoryCount({
          warehouse_id,
          abc_class: this.formAbcClass(),
          max_items: this.formMaxItems(),
          freeze_movements: this.formFreeze(),
          blind_double_count: this.formBlind(),
          recount_threshold_pct: this.formThreshold(),
        })
      : this.svc.openInventoryCount({
          warehouse_id,
          type: 'full',
          freeze_movements: this.formFreeze(),
          blind_double_count: this.formBlind(),
          recount_threshold_pct: this.formThreshold(),
        });
    peticion
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          const counters = this.selCounters();
          const supervisors = this.selSupervisors();
          const reqs: ReturnType<ComercialService['inventorySetAssignments']>[] = [];
          if (this.canAssign() && counters.length) reqs.push(this.svc.inventorySetAssignments(r.id, 'counter', counters));
          if (this.canAssign() && supervisors.length) reqs.push(this.svc.inventorySetAssignments(r.id, 'supervisor', supervisors));
          const finish = () => {
            this.opening.set(false);
            this.dialogVisible.set(false);
            const asg = counters.length || supervisors.length ? ` · ${counters.length} contadores, ${supervisors.length} supervisores` : '';
            // Se nombra el alcance real: era justo lo que el folio "cíclico" no decía.
            const alcance = esCiclico ? `cíclico clase ${this.formAbcClass()}` : 'total del almacén';
            this.toast.add({
              severity: 'success',
              summary: `Folio ${r.folio} abierto`,
              detail: `${r.expected_items} SKUs · ${alcance}${this.formFreeze() ? ' · almacén congelado' : ''}${asg}`,
            });
            this.formWarehouse.set(null);
            this.abcResumen.set(null);
            this.load();
          };
          if (reqs.length) {
            forkJoin(reqs).subscribe({
              next: finish,
              error: () => {
                this.opening.set(false);
                this.dialogVisible.set(false);
                this.toast.add({ severity: 'warn', summary: `Folio ${r.folio} abierto, pero falló la asignación`, detail: 'Asignalos desde el detalle del folio.' });
                this.load();
              },
            });
          } else {
            finish();
          }
        },
        error: (e) => {
          this.opening.set(false);
          this.toast.add({ severity: 'warn', summary: 'No se abrió', detail: e?.error?.message || 'Error' });
        },
      });
  }

  /** % de SKUs con al menos un conteo. 0 si el folio no tiene snapshot. */
  pct(c: InventoryCount): number {
    const t = c.items_total ?? 0;
    if (!t) return 0;
    return Math.min(100, ((c.items_counted ?? 0) / t) * 100);
  }

  /** Folio vivo que además bloquea pedidos y ajustes en su almacén. */
  estaCongelando(c: InventoryCount): boolean {
    return c.freeze_movements === true && ACTIVOS.includes(c.status);
  }

  /**
   * `[IC.13]` El aviso de la fila. **Dos ausencias distintas, dos avisos distintos:**
   *
   * - `Sin conteos` — el folio está abierto y **nadie escaneó nunca**. Lo arregla quien
   *   asigna personal. Es el caso `INV-2026-00008`: 3,664 SKUs, 0 contados, 6 días.
   * - `Sin avanzar` — alguien contó y después se frenó. Lo arregla quien supervisa.
   *
   * Antes esto era un solo badge calculado contra `started_at`, o sea contra *cuándo se
   * abrió*: un conteo de tres días que avanza normal salía "Estancado" desde la hora 25 y
   * no podía volver a limpio nunca. Ahora se mide contra el **último escaneo real**.
   */
  alerta(c: InventoryCount): { etiqueta: string; detalle: string; grave: boolean } | null {
    if (!ACTIVOS.includes(c.status)) return null;
    const frio = this.estaCongelando(c) ? ' El almacén está congelado mientras tanto.' : '';

    if (!c.items_counted) {
      // Sin un solo conteo. Se mide desde la apertura porque no hay otra cosa que medir.
      const desde = c.started_at ? Date.parse(c.started_at) : NaN;
      if (!Number.isFinite(desde)) return null;
      const horas = (Date.now() - desde) / 3_600_000;
      if (horas < HORAS_SIN_AVANZAR) return null;
      return {
        etiqueta: `Sin conteos ${this.hace(c.started_at!, false)}`,
        detalle: `Abierto ${this.hace(c.started_at!)} y todavía sin un solo escaneo de los ${(c.items_total ?? 0).toLocaleString('es-MX')} SKUs.${frio}`,
        grave: horas / 24 >= DIAS_ABANDONADO,
      };
    }

    if (!c.last_count_at) return null; // contados > 0 sin fecha: no se inventa una
    const horas = (Date.now() - Date.parse(c.last_count_at)) / 3_600_000;
    if (!Number.isFinite(horas) || horas < HORAS_SIN_AVANZAR) return null;
    return {
      etiqueta: `Sin avanzar ${this.hace(c.last_count_at, false)}`,
      detalle: `Último escaneo ${this.hace(c.last_count_at)}; van ${(c.items_counted ?? 0).toLocaleString('es-MX')} de ${(c.items_total ?? 0).toLocaleString('es-MX')} SKUs.${frio}`,
      grave: horas / 24 >= DIAS_ABANDONADO,
    };
  }

  /** "hace 3 d" / "3 d". Devuelve '—' si la fecha no se puede leer. */
  hace(iso: string, conPrefijo = true): string {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const min = Math.max(0, Math.round(ms / 60_000));
    const txt =
      min < 60 ? `${min} min`
      : min < 60 * 48 ? `${Math.round(min / 60)} h`
      : `${Math.round(min / 1440)} d`;
    return conPrefijo ? `hace ${txt}` : txt;
  }

  statusLabel(s: string): string {
    return {
      open: 'Abierto', counting: 'Contando', review: 'Revisión',
      ready_to_reconcile: 'Por reconciliar', reconciled: 'Reconciliado', cancelled: 'Cancelado',
    }[s] || s;
  }

  statusSeverity(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    if (s === 'reconciled') return 'success';
    if (s === 'cancelled') return 'secondary';
    if (s === 'review' || s === 'ready_to_reconcile') return 'warn';
    return 'info';
  }
}
