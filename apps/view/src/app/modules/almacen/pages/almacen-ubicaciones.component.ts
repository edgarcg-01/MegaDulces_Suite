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
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { ProductSearchComponent, ProductHit } from '../../comercial/components/product-search.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { BinLocationService, WarehouseBin, LotLocation, UnlocatedLot } from '../bin-location.service';
import { tipoDeUbicacion, TIPOS_UBICACION } from '../shared/tipo-ubicacion';

/** Una ubicación con lo que la pantalla deriva para poder ordenarla y filtrarla. */
interface UbicacionFila extends WarehouseBin {
  unidades: number;
  tipo: string;
  tipoLabel: string;
}

/**
 * Almacén · **Ubicaciones** — cómo está acomodada la bodega.
 *
 * **Maestro–detalle por ubicación, no una tabla plana de lotes.** La pregunta que
 * se le hace a esta pantalla es *"¿qué hay en el rack 12?"* y *"¿dónde está este
 * producto?"*, y la tabla plana de `lote × posición` que había acá contestaba la
 * segunda a medias y la primera nunca: había que leer 800 renglones buscando un
 * código de bin repetido. Ahora la izquierda son **las ubicaciones** (rack,
 * tarima u otra) y la derecha es **lo que hay adentro**, en orden FEFO.
 *
 * El detalle se pide con `GET /bins/:id/contents`, que existía desde WMS-REC.3 y
 * **ninguna pantalla usaba**. Importa que sea ése y no `GET /locations`: el
 * segundo viene con `LIMIT 1000` sin decirlo, así que en una bodega cargada
 * mostraría un rack a medias sin ningún aviso — el contenido de una ubicación no
 * se puede truncar en silencio.
 *
 * **Quién entra.** La ruta y la pestaña aceptan `INVENTORY_VER` **o**
 * `INVENTORY_RECIBIR`: medido en prod, el rol `almacenista` (4 de los 5 usuarios
 * que reciben mercancía) tiene sólo `RECIBIR`, así que esta pantalla le estaba
 * oculta — acomodaba la tarima y no podía volver a ver dónde la había dejado. No
 * se reparte `INVENTORY_VER` al rol porque ese permiso abre también la consola de
 * **ajustes de stock**, que es otra cosa.
 */
@Component({
  selector: 'app-almacen-ubicaciones',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule,
    InputTextModule, DialogModule, ToastModule, ProductSearchComponent, LoadStateComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ubicaciones</h1>
          <p class="surf-page-sub">Qué hay en cada rack o tarima, y qué falta por acomodar</p>
        </div>
        <div class="ub-head-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseId" optionLabel="label"
            optionValue="value" placeholder="Almacén" (onChange)="reload()" styleClass="ub-w"></p-select>
          <button pButton [text]="true" size="small" severity="secondary" (click)="reload()" [loading]="loading()">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      @if (!warehouseId) {
        <div class="comm-empty">
          <div class="comm-empty-icon"><i class="pi pi-map-marker" aria-hidden="true"></i></div>
          <h3>Elegí un almacén</h3>
          <p>Seleccioná un almacén para ver cómo está acomodado.</p>
        </div>
      } @else {
        <!-- Los tres números que contestan "¿cómo vamos?" sin abrir nada. -->
        <div class="ub-kpis">
          <div class="ub-kpi">
            <span class="ub-kpi-n">{{ filas().length }}</span>
            <span class="ub-kpi-l">ubicaciones</span>
          </div>
          <div class="ub-kpi">
            <span class="ub-kpi-n">{{ conMercancia() }}</span>
            <span class="ub-kpi-l">con mercancía</span>
          </div>
          <div class="ub-kpi" [class.ub-kpi-warn]="porUbicarTotal() > 0">
            <span class="ub-kpi-n">{{ porUbicarTotal() | number }}</span>
            <span class="ub-kpi-l">por acomodar</span>
          </div>
        </div>

        <div class="ub-layout">
          <!-- ── MAESTRO: las ubicaciones ───────────────────────────────── -->
          <section class="ub-left surf-card">
            <div class="ub-side-head">
              <h2 class="ub-h2">Ubicaciones</h2>
              @if (canAssign()) {
                <button pButton [text]="true" size="small" severity="secondary" (click)="binsOpen.set(true)">
                  <span class="p-button-icon p-button-icon-left pi pi-cog" aria-hidden="true"></span> Administrar
                </button>
              }
            </div>

            <input pInputText class="ub-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
              placeholder="Buscar por código o nombre (R-12, Tarima 3…)" />

            <div class="ub-chips" role="group" aria-label="Filtrar por tipo">
              <button type="button" class="ub-chip" [class.ub-chip-on]="tipoFiltro() === ''"
                (click)="tipoFiltro.set('')">Todas</button>
              @for (t of tipos; track t.key) {
                <button type="button" class="ub-chip" [class.ub-chip-on]="tipoFiltro() === t.key"
                  (click)="tipoFiltro.set(t.key)">{{ t.label }}</button>
              }
            </div>

            <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!filasVisibles().length"
              emptyIcon="pi-map-marker"
              [emptyTitle]="filas().length ? 'Nada coincide' : 'Sin ubicaciones todavía'"
              [emptyHint]="filas().length
                ? 'Probá con otro código o quitá el filtro de tipo.'
                : 'Ninguna ubicación dada de alta en este almacén. Se crean desde el Andén al acomodar, o acá con Administrar.'"
              (retry)="reload()">
              <ul class="ub-lista">
                @for (b of filasVisibles(); track b.id) {
                  <li>
                    <button type="button" class="ub-row" [class.ub-row-on]="seleccionada()?.id === b.id"
                      (click)="abrir(b)">
                      <span class="ub-row-code">{{ b.code }}</span>
                      <span class="ub-row-lbl">{{ b.label || b.tipoLabel }}</span>
                      <span class="ub-row-qty" [class.ub-row-vacia]="!b.unidades">
                        @if (b.unidades) { {{ b.unidades | number }} } @else { vacía }
                      </span>
                    </button>
                  </li>
                }
              </ul>
            </app-load-state>
          </section>

          <!-- ── DETALLE: qué hay adentro ───────────────────────────────── -->
          <section class="ub-right">
            @if (seleccionada(); as b) {
              <div class="surf-card">
                <div class="ub-side-head">
                  <div>
                    <h2 class="ub-h2">{{ b.code }}</h2>
                    <p class="ub-sub">{{ b.label || b.tipoLabel }} · {{ b.unidades | number }} unidades</p>
                  </div>
                  <button pButton [text]="true" size="small" severity="secondary" (click)="cerrarDetalle()">
                    <span class="p-button-icon pi pi-times" aria-hidden="true"></span>
                  </button>
                </div>

                <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()"
                  [isEmpty]="!contenido().length" emptyIcon="pi-inbox"
                  emptyTitle="Esta ubicación está vacía"
                  emptyHint="Nada acomodado acá todavía." (retry)="abrir(b)">
                  <p-table [value]="contenido()" styleClass="p-datatable-sm surf-table surf-table--zebra"
                    [scrollable]="true" scrollHeight="420px">
                    <ng-template #header>
                      <tr>
                        <th scope="col">Producto</th>
                        <th scope="col">Lote</th>
                        <th scope="col">Caduca</th>
                        <th scope="col" class="num">Cant.</th>
                      </tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr>
                        <td class="ub-name">
                          {{ l.product_name || l.product_id }}
                          @if (l.sku) { <small class="ub-sku">{{ l.sku }}</small> }
                        </td>
                        <td class="ub-mono">{{ l.lot_code }}</td>
                        <td class="ub-mono">
                          {{ l.expiry_date || '—' }}
                          @if (l.days_to_expiry != null && l.days_to_expiry <= 30) {
                            <p-tag [value]="l.days_to_expiry + 'd'"
                              [severity]="l.days_to_expiry < 0 ? 'danger' : 'warn'"></p-tag>
                          }
                        </td>
                        <td class="num ub-strong">{{ l.quantity | number }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                </app-load-state>
              </div>
            } @else {
              <div class="surf-card ub-hint-card">
                <i class="pi pi-arrow-left" aria-hidden="true"></i>
                <p>Elegí una ubicación de la izquierda para ver qué tiene adentro, en orden de caducidad.</p>
              </div>
            }

            <!-- ── Dónde está un producto ─────────────────────────────── -->
            <div class="surf-card">
              <div class="ub-side-head">
                <h2 class="ub-h2">¿Dónde está este producto?</h2>
                <app-product-search (productSelected)="onFilterProduct($event)"></app-product-search>
              </div>
              @if (filterProductId) {
                <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!locations().length"
                  emptyIcon="pi-search" emptyTitle="No está acomodado en ningún lado"
                  emptyHint="Puede estar en existencia sin ubicar — mirá 'Por acomodar' abajo." (retry)="reload()">
                  <p-table [value]="locations()" styleClass="p-datatable-sm surf-table" [scrollable]="true"
                    scrollHeight="260px">
                    <ng-template #header>
                      <tr><th scope="col">Ubicación</th><th scope="col">Lote</th><th scope="col">Caduca</th><th scope="col" class="num">Cant.</th></tr>
                    </ng-template>
                    <ng-template #body let-l>
                      <tr class="ub-row-click" (click)="abrirPorCodigo(l.bin_code)">
                        <td class="ub-mono ub-strong">{{ l.bin_code }}</td>
                        <td class="ub-mono">{{ l.lot_code }}</td>
                        <td class="ub-mono">{{ l.expiry_date || '—' }}</td>
                        <td class="num">{{ l.quantity | number }}</td>
                      </tr>
                    </ng-template>
                  </p-table>
                </app-load-state>
              } @else {
                <p class="ub-hint">Buscá un producto para ver en qué racks está repartido.</p>
              }
            </div>

            <!-- ── Por acomodar + put-away ────────────────────────────── -->
            <div class="surf-card">
              <div class="ub-side-head">
                <h2 class="ub-h2">Por acomodar</h2>
                @if (unlocated().length) { <span class="ub-badge">{{ unlocated().length }}</span> }
              </div>
              <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!unlocated().length"
                emptyIcon="pi-check-circle" emptyTitle="Nada pendiente"
                emptyHint="Todo lo recibido está colocado." (retry)="reload()">
                <p-table [value]="unlocated()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="240px">
                  <ng-template #header>
                    <tr><th scope="col">Producto</th><th scope="col">Lote</th><th scope="col">Caduca</th><th scope="col" class="num">Falta</th></tr>
                  </ng-template>
                  <ng-template #body let-u>
                    <tr [class.ub-row-click]="canReceive()" (click)="prefillFromUnlocated(u)">
                      <td class="ub-name">{{ u.product_name || u.product_id }}</td>
                      <td class="ub-mono">{{ u.lot_code }}</td>
                      <td class="ub-mono">{{ u.expiry_date || '—' }}</td>
                      <td class="num ub-strong">{{ u.to_locate }}</td>
                    </tr>
                  </ng-template>
                </p-table>
              </app-load-state>

              @if (canReceive()) {
                <div class="ub-putaway">
                  <h3 class="ub-h3">Acomodar</h3>
                  <label class="ub-field"><span>Producto</span>
                    <app-product-search (productSelected)="onPuProduct($event)"></app-product-search>
                    @if (puProductLabel()) { <small class="ub-hint">{{ puProductLabel() }}</small> }
                  </label>
                  <div class="ub-row2">
                    <label class="ub-field"><span>Lote</span><input pInputText [(ngModel)]="puLot" placeholder="NA" /></label>
                    <label class="ub-field"><span>Caducidad</span><input pInputText type="date" [(ngModel)]="puExpiry" /></label>
                  </div>
                  <div class="ub-row2">
                    <label class="ub-field"><span>Ubicación</span>
                      <p-select [options]="binOptions()" [(ngModel)]="puBin" optionLabel="label" optionValue="value"
                        placeholder="Elegí dónde" [filter]="true" styleClass="ub-w"></p-select>
                    </label>
                    <label class="ub-field"><span>Cantidad</span><input pInputText type="number" min="1" [(ngModel)]="puQty" /></label>
                  </div>
                  <button pButton (click)="doPutAway()" [disabled]="!canDoPutAway()" [loading]="placing()">
                    <span class="p-button-icon p-button-icon-left pi pi-arrow-down" aria-hidden="true"></span> Acomodar
                  </button>
                </div>
              }
            </div>
          </section>
        </div>
      }

      <!-- Administrar ubicaciones -->
      <p-dialog [visible]="binsOpen()" (visibleChange)="binsOpen.set($event)" [modal]="true"
        [style]="{ width: '620px' }" header="Administrar ubicaciones" [dismissableMask]="true">
        <div class="ub-bin-form">
          <div class="ub-row2">
            <label class="ub-field"><span>Código *</span><input pInputText [(ngModel)]="newBinCode" placeholder="R-12" /></label>
            <label class="ub-field"><span>Nombre</span><input pInputText [(ngModel)]="newBinLabel" placeholder="Rack 12" /></label>
          </div>
          <button pButton size="small" (click)="createBin()" [disabled]="!newBinCode.trim()" [loading]="savingBin()">
            <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span> Crear
          </button>
          <p class="ub-hint">
            El cartel para pegar en el rack se imprime desde el Andén, al crear la ubicación mientras se acomoda.
          </p>
        </div>
        <p-table [value]="filas()" styleClass="p-datatable-sm surf-table" [scrollable]="true" scrollHeight="280px">
          <ng-template #header>
            <tr><th scope="col">Código</th><th scope="col">Nombre</th><th scope="col" class="num">Unidades</th><th scope="col"><span class="sr-only">Acciones</span></th></tr>
          </ng-template>
          <ng-template #body let-b>
            <tr>
              <td class="ub-mono ub-strong">{{ b.code }}</td>
              <td>{{ b.label || '—' }}</td>
              <td class="num">{{ b.unidades | number }}</td>
              <td>
                <!-- Borrar exige ASIGNAR y que esté vacía: el backend lo rechaza igual,
                     pero un botón que siempre falla es peor que un botón ausente. -->
                <button pButton size="small" severity="danger" [text]="true" (click)="deleteBin(b)"
                  title="Eliminar" [disabled]="b.unidades > 0">
                  <span class="pi pi-trash" aria-hidden="true"></span>
                </button>
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><p>Sin ubicaciones. Creá la primera.</p></div></td></tr>
          </ng-template>
        </p-table>
      </p-dialog>
    </div>
  `,
  styles: [`
    .ub-head-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .ub-w { width: 100%; min-width: 200px; }
    .ub-kpis { display: flex; gap: .75rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .ub-kpi {
      flex: 1 1 140px; padding: .6rem .9rem; border-radius: var(--radius-lg, 12px);
      background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border);
      display: flex; flex-direction: column; gap: 2px;
    }
    .ub-kpi-n { font-size: 1.35rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .ub-kpi-l { font-size: .75rem; color: var(--text-color-secondary); }
    .ub-kpi-warn .ub-kpi-n { color: var(--bad-fg, #b91c1c); }
    .ub-layout { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 1rem; align-items: start; }
    @media (max-width: 960px) { .ub-layout { grid-template-columns: 1fr; } }
    .surf-card { background: var(--surface-card, var(--surface-0)); border: 1px solid var(--surface-border); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1rem; }
    .ub-left, .ub-right { display: flex; flex-direction: column; }
    .ub-h2 { font-size: .95rem; font-weight: 700; margin: 0; }
    .ub-h3 { font-size: .85rem; font-weight: 700; margin: 0 0 .5rem; }
    .ub-sub { margin: 2px 0 0; font-size: .78rem; color: var(--text-color-secondary); font-variant-numeric: tabular-nums; }
    .ub-side-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .ub-buscar { width: 100%; margin-bottom: .5rem; }
    .ub-chips { display: flex; gap: .35rem; margin-bottom: .75rem; flex-wrap: wrap; }
    .ub-chip {
      padding: .25rem .7rem; cursor: pointer; font: inherit; font-size: .78rem;
      background: transparent; color: var(--text-color-secondary);
      border: 1px solid var(--surface-border); border-radius: 999px;
    }
    .ub-chip-on { border-color: var(--action); color: var(--action); font-weight: 700; }
    .ub-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 520px; overflow: auto; }
    .ub-row {
      display: grid; grid-template-columns: auto 1fr auto; gap: .5rem; align-items: center;
      width: 100%; min-height: 44px; padding: .4rem .6rem; text-align: left; cursor: pointer;
      background: transparent; color: inherit; border: 1px solid transparent; border-radius: var(--radius-md, 8px); font: inherit;
    }
    .ub-row:hover { background: var(--surface-hover); }
    .ub-row-on { border-color: var(--action); background: var(--surface-hover); }
    .ub-row-code { font-family: var(--font-mono, monospace); font-weight: 700; font-size: .85rem; }
    .ub-row-lbl { font-size: .78rem; color: var(--text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ub-row-qty { font-size: .82rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ub-row-vacia { font-weight: 400; font-size: .75rem; color: var(--text-color-secondary); }
    .ub-hint-card { display: flex; align-items: center; gap: .75rem; color: var(--text-color-secondary); font-size: .85rem; }
    .ub-badge {
      min-width: 22px; padding: 0 6px; border-radius: 999px; font-size: .75rem; font-weight: 700;
      background: var(--warn-soft-bg, var(--surface-ground)); color: var(--warn-fg, inherit); text-align: center;
    }
    .ub-field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
    .ub-field > span { font-size: .8rem; color: var(--text-color-secondary); font-weight: 600; }
    .ub-field input[pInputText], .ub-field input[type=number], .ub-field input[type=date] { width: 100%; }
    .ub-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .ub-hint { font-size: .78rem; color: var(--text-color-secondary); margin: .25rem 0 0; }
    .ub-mono { font-family: var(--font-mono, monospace); }
    .ub-strong { font-weight: 700; }
    .ub-name { max-width: 260px; }
    .ub-name small { display: block; font-size: .72rem; color: var(--text-color-secondary); font-family: var(--font-mono, monospace); }
    .ub-sku { font-family: var(--font-mono, monospace); }
    .ub-row-click { cursor: pointer; }
    .ub-putaway { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--surface-border); }
    .ub-bin-form { margin-bottom: 1rem; }
  `],
})
export class AlmacenUbicacionesComponent implements OnInit {
  private readonly svc = inject(BinLocationService);
  private readonly comercial = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly tipos = TIPOS_UBICACION;

  readonly warehouses = signal<Warehouse[]>([]);
  readonly warehouseOptions = computed(() => this.warehouses().map((w) => ({ label: `${w.code} · ${w.name}`, value: w.id })));
  warehouseId = '';

  readonly bins = signal<WarehouseBin[]>([]);
  readonly locations = signal<LotLocation[]>([]);
  readonly unlocated = signal<UnlocatedLot[]>([]);
  readonly loading = signal(false);
  /**
   * El error se GUARDA y se muestra. Antes los tres `subscribe` de esta pantalla
   * hacían `error: () => set([])`, así que un 403 —el que de hecho tenía el rol
   * `almacenista`— se veía igual que una bodega vacía: sin racks, sin pendientes
   * y sin una sola pista de por qué.
   */
  readonly error = signal<string | null>(null);

  readonly busqueda = signal('');
  readonly tipoFiltro = signal('');

  readonly seleccionada = signal<UbicacionFila | null>(null);
  readonly contenido = signal<LotLocation[]>([]);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);

  filterProductId = '';

  // put-away
  readonly puProductLabel = signal<string>('');
  puProductId = '';
  puLot = '';
  puExpiry = '';
  puBin = '';
  puQty: number | null = null;
  readonly placing = signal(false);

  // administrar
  readonly binsOpen = signal(false);
  readonly savingBin = signal(false);
  newBinCode = '';
  newBinLabel = '';

  /** Las ubicaciones con su tipo derivado y las unidades como número. */
  readonly filas = computed<UbicacionFila[]>(() =>
    this.bins().map((b) => {
      const t = tipoDeUbicacion(b.code, b.label);
      return { ...b, unidades: Number(b.units || 0), tipo: t.key, tipoLabel: t.label };
    }),
  );

  readonly filasVisibles = computed(() => {
    const q = this.busqueda().trim().toLowerCase();
    const t = this.tipoFiltro();
    return this.filas().filter((b) => {
      if (t && b.tipo !== t) return false;
      if (!q) return true;
      return `${b.code} ${b.label ?? ''} ${b.tipoLabel}`.toLowerCase().includes(q);
    });
  });

  readonly conMercancia = computed(() => this.filas().filter((b) => b.unidades > 0).length);
  readonly porUbicarTotal = computed(() => this.unlocated().reduce((a, u) => a + Number(u.to_locate || 0), 0));

  readonly binOptions = computed(() =>
    this.filas().map((b) => ({ label: `${b.code}${b.label ? ' · ' + b.label : ''}`, value: b.id })),
  );

  ngOnInit(): void {
    this.comercial.listWarehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ws: Warehouse[]) => this.warehouses.set(ws || []),
      error: () => this.warehouses.set([]),
    });
  }

  reload(): void {
    if (!this.warehouseId) return;
    this.loading.set(true);
    this.error.set(null);
    this.cerrarDetalle();

    this.svc.listBins(this.warehouseId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.bins.set(r || []); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.error.set(this.motivo(e)); },
    });
    // El auxiliar sólo se pide con un producto elegido: sin filtro trae hasta 1000
    // renglones que nadie va a leer, y el contenido por ubicación ya lo da el detalle.
    if (this.filterProductId) {
      this.svc.locations(this.warehouseId, this.filterProductId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => this.locations.set(r || []),
        error: (e) => this.error.set(this.motivo(e)),
      });
    } else {
      this.locations.set([]);
    }
    this.svc.unlocated(this.warehouseId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.unlocated.set(r || []),
      error: (e) => this.error.set(this.motivo(e)),
    });
  }

  /** Un 403 tiene que decir que es un 403, no quedar como "no hay nada". */
  private motivo(e: unknown): string {
    const x = e as { status?: number; error?: { message?: string } };
    if (x?.status === 403) return 'Tu rol no tiene permiso para ver las ubicaciones de este almacén.';
    return x?.error?.message || 'No se pudo leer cómo está acomodado el almacén.';
  }

  abrir(b: UbicacionFila): void {
    this.seleccionada.set(b);
    this.contenido.set([]);
    this.errorDetalle.set(null);
    this.cargandoDetalle.set(true);
    // `binContents` y no `locations`: el segundo corta en 1000 sin avisar, y el
    // contenido de un rack no se puede mostrar a medias.
    this.svc.binContents(b.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.contenido.set(r || []); this.cargandoDetalle.set(false); },
      error: (e) => { this.cargandoDetalle.set(false); this.errorDetalle.set(this.motivo(e)); },
    });
  }

  /** Salta al rack desde el resultado de "dónde está este producto". */
  abrirPorCodigo(code: string | null | undefined): void {
    if (!code) return;
    const b = this.filas().find((x) => x.code.trim().toLowerCase() === String(code).trim().toLowerCase());
    if (b) this.abrir(b);
  }

  cerrarDetalle(): void {
    this.seleccionada.set(null);
    this.contenido.set([]);
    this.errorDetalle.set(null);
  }

  onPuProduct(hit: ProductHit | null): void {
    this.puProductId = hit?.id || '';
    this.puProductLabel.set(hit ? `${hit.sku || ''} · ${hit.label}` : '');
  }

  onFilterProduct(hit: ProductHit | null): void {
    this.filterProductId = hit?.id || '';
    this.reload();
  }

  prefillFromUnlocated(u: UnlocatedLot): void {
    if (!this.canReceive()) return;
    this.puProductId = u.product_id;
    this.puProductLabel.set(`${u.sku || ''} · ${u.product_name || u.product_id}`);
    this.puLot = u.lot_code;
    this.puExpiry = u.expiry_date || '';
    this.puQty = Number(u.to_locate);
    this.toast.add({ severity: 'info', summary: 'Precargado', detail: 'Elegí la ubicación y confirmá' });
  }

  canDoPutAway(): boolean {
    return !!this.warehouseId && !!this.puProductId && !!this.puBin && !!this.puQty && this.puQty > 0;
  }

  doPutAway(): void {
    if (!this.canDoPutAway()) return;
    this.placing.set(true);
    this.svc.putAway({
      warehouse_id: this.warehouseId,
      product_id: this.puProductId,
      lot_code: this.puLot?.trim() || undefined,
      expiry_date: this.puExpiry || undefined,
      bin_id: this.puBin,
      quantity: Number(this.puQty),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.placing.set(false);
        this.toast.add({ severity: 'success', summary: 'Acomodado', detail: `${this.puQty} unidades` });
        this.puLot = ''; this.puExpiry = ''; this.puQty = null;
        this.reload();
      },
      error: (e) => { this.placing.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo acomodar' }); },
    });
  }

  canReceive(): boolean {
    return this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_RECIBIR];
  }

  /**
   * Administrar = dar de alta y borrar ubicaciones. **Crear** también lo puede
   * quien recibe (WMS-REC.9b: la bodega se rotula a medida que se usa), así que
   * el panel se abre con cualquiera de los dos; el borrado lo sigue frenando el
   * backend con `ASIGNAR`.
   */
  canAssign(): boolean {
    return this.perms.isAdmin()
      || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_INVENTORY_ASIGNAR]
      || this.canReceive();
  }

  createBin(): void {
    if (!this.newBinCode.trim() || !this.warehouseId) return;
    this.savingBin.set(true);
    this.svc.createBin({
      warehouse_id: this.warehouseId,
      code: this.newBinCode.trim().toUpperCase(),
      label: this.newBinLabel?.trim() || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.savingBin.set(false);
        this.newBinCode = ''; this.newBinLabel = '';
        this.toast.add({ severity: 'success', summary: 'Ubicación creada' });
        this.reload();
      },
      error: (e) => {
        this.savingBin.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo crear', detail: e?.error?.message || 'Error' });
      },
    });
  }

  deleteBin(b: UbicacionFila): void {
    this.svc.deleteBin(b.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'info', summary: 'Ubicación eliminada' }); this.reload(); },
      error: (e) => this.toast.add({
        severity: 'error', summary: 'No se pudo eliminar',
        detail: e?.status === 403
          ? 'Borrar una ubicación exige el permiso de asignar layout.'
          : e?.error?.message || 'Error',
      }),
    });
  }
}
