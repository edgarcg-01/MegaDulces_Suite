import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, QueryList, ViewChildren, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { SelectButtonModule } from 'primeng/selectbutton';
import { InputTextModule } from 'primeng/inputtext';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService, ScopeOption } from '../../../core/services/data-scope.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, ArqueoResult, ArqueoRow } from '../arqueo.service';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { HasUnsavedChanges } from '../../../core/guards/unsaved-changes.guard';

/**
 * Proyecto Tienda — Arqueo ciego de caja para CAJERAS (/tienda/arqueo).
 *
 * La cajera cuenta el efectivo físico por denominación y **eso es todo lo que ve**:
 * su total contado y su historial. No ve el esperado ni su diferencia — mostrarle
 * la diferencia equivale a mostrarle el esperado (esperado = contado + diferencia),
 * y con eso el arqueo deja de ser ciego: se puede recapturar "ajustando". El
 * supervisor revela en /almacen/cuadre (`RECONCILIATION_VER`), donde además ve el
 * flag de enmascaramiento de Kepler. El descuadre igual se levanta al instante en
 * su bandeja (autolineado SM.9): la cajera no lo ve, pero pasa.
 *
 * `[ID.4]` — Las sucursales salen del ALCANCE del usuario (`/users/me/scope`), no
 * de su ficha: una asignada → fija; varias → elige; ninguna → no puede capturar.
 * El backend recorta igual (esto es solo el selector).
 *
 * Superficie Operations, PrimeNG denso, dark-safe. §13: captura de dinero → guard
 * de estado sucio + botón que se auto-deshabilita síncrono al 1er clic (anti doble-corte).
 */
@Component({
  selector: 'app-tienda-arqueo',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, ToastModule,
    SelectButtonModule, InputTextModule, DatePickerModule, TagModule,
    ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in arq-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueo de caja</h1>
          <p class="surf-page-sub">
            Contá el efectivo físico por denominación y guardalo.
            @if (revela) { Al guardar, el sistema te muestra la diferencia real. }
            @else { El cuadre lo revisa tu supervisor. }
          </p>
        </div>
        <div class="arq-head-right">
          @if (sucursalFija()) { <span class="arq-scope"><i class="pi pi-map-marker"></i> {{ branchLabel(sucursalFija()) }}</span> }
          <app-context-help topic="arqueo" />
        </div>
      </header>

      @if (scopeCargado() && !sucursales().length) {
        <div class="card-premium card-flat arq-nowh">
          <i class="pi pi-lock"></i>
          <div>
            <strong>Tu usuario no tiene sucursal asignada.</strong>
            <p class="muted">Sin sucursal no hay caja que arquear. Pedile al administrador que te asigne la tuya en Usuarios → Alcance.</p>
          </div>
        </div>
      }

      <div class="arq-2col" [class.arq-1col]="!canCapture()">
        <!-- Captura -->
        @if (canCapture()) {
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Nuevo arqueo</h3>
          <p-selectbutton [options]="tipoOptions" [ngModel]="aTipo()" (ngModelChange)="aTipo.set($event); dirty.set(true)"
                          optionLabel="label" optionValue="value" [allowEmpty]="false" styleClass="sb-liquid arq-seg" />

          <div class="arq-head">
            @if (!sucursalFija()) {
              <label class="arq-lbl">Sucursal
                <select class="arq-fld arq-sel arq-fld-suc" [(ngModel)]="aSuc" (ngModelChange)="dirty.set(true)">
                  <option value="" disabled>Elegí…</option>
                  @for (w of sucursales(); track w.value) { <option [value]="w.value">{{ w.value }} — {{ w.label }}</option> }
                </select>
              </label>
            }
            <label class="arq-lbl">Caja <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCaja" (ngModelChange)="dirty.set(true)" placeholder="2"></label>
            <label class="arq-lbl">Fecha
              <p-datepicker [(ngModel)]="aDate" (ngModelChange)="dirty.set(true)" dateFormat="dd/mm/yy"
                            [showIcon]="true" appendTo="body" styleClass="arq-date" inputStyleClass="arq-fld" />
            </label>
            <label class="arq-lbl">{{ aTipo() === 'relevo' ? 'Cajero saliente' : 'Cajero' }} <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aCajero" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>
            @if (aTipo() === 'relevo') { <label class="arq-lbl">Cajero entrante <input pInputText class="arq-fld arq-fld-sm" [(ngModel)]="aEntrante" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label> }
          </div>

          <p-table [value]="denoms" styleClass="p-datatable-sm arq-denoms-tbl">
            <ng-template #header>
              <tr><th>Denominación</th><th class="ta-r">Cantidad</th><th class="ta-r">Subtotal</th></tr>
            </ng-template>
            <ng-template #body let-d let-i="rowIndex">
              <tr>
                <td class="arq-denom-lbl">{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</td>
                <td class="ta-r">
                  <!-- Input de texto (no p-inputnumber) a propósito: acá ↑/↓ SALTAN de
                       casilla en vez de sumar/restar. Con el spinner puesto, una flecha
                       de más cambia el conteo del billete sin que la cajera lo note. -->
                  <input #denomInput pInputText class="arq-num" inputmode="numeric" autocomplete="off"
                         [attr.aria-label]="'Cantidad de ' + (d >= 1 ? '$' + d : (d*100) + ' centavos')"
                         [value]="denomCount[d] ?? ''" placeholder="0"
                         (input)="onDenomInput(d, $event)" (keydown)="onDenomKey($event, i)" (focus)="selectAll($event)">
                </td>
                <td class="ta-r muted">{{ money((denomCount[d] || 0) * d) }}</td>
              </tr>
            </ng-template>
            <ng-template #footer>
              <tr class="arq-total-row"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(arqTotal()) }}</td></tr>
            </ng-template>
          </p-table>
          <p class="arq-hint"><i class="pi pi-arrows-v"></i> Usá <kbd>↑</kbd> <kbd>↓</kbd> o <kbd>Enter</kbd> para moverte entre denominaciones.</p>

          @if (aTipo() === 'cierre') {
            <label class="arq-lbl arq-block">Incidencia <span class="muted">(opcional — si hubo un motivo)</span>
              <select class="arq-fld arq-sel" [(ngModel)]="aIncidencia" (ngModelChange)="dirty.set(true)">
                <option value="">Ninguna</option>
                <option value="faltante_justificado">Faltante justificado</option>
                <option value="billete_falso">Billete falso</option>
                <option value="robo">Robo</option>
                <option value="error_cobro">Error de cobro</option>
                <option value="otro">Otro</option>
              </select>
            </label>
          }
          <label class="arq-lbl arq-block">Nota <input pInputText class="arq-fld" [(ngModel)]="aNota" (ngModelChange)="dirty.set(true)" placeholder="opcional"></label>
          <p-button type="button" [label]="submitLabel()" icon="pi pi-lock" styleClass="p-button-sm"
                  [disabled]="!canSubmit() || saving()" [loading]="saving()" (click)="submit()"></p-button>

          @if (result(); as r) {
            <div class="arq-result" [class.bad]="revela && (r.diff_real || 0) > 0" [class.ok]="revela && (r.diff_real || 0) < 0">
              @if (r.tipo === 'relevo') {
                <p class="muted">Relevo sellado: {{ money(r.total_contado) }} entregados de {{ aCajero || '—' }} → {{ aEntrante || '—' }}.</p>
              } @else if (!r.reveal) {
                <!-- Cajera: se confirma el hecho, no el cuadre. -->
                <div class="arq-cmp">
                  <div><span class="arq-ev-k">Guardado — total contado</span><span class="arq-ev-v strong">{{ money(r.total_contado) }}</span></div>
                </div>
                <p class="muted arq-mt">Quedó sellado con la hora. El cuadre contra el sistema lo revisa tu supervisor.</p>
              } @else if (r.ambiguous) {
                <p class="muted">Guardado ({{ money(r.total_contado) }}). Hay <strong>varios cortes</strong> en esta caja hoy — especificá el <strong>cajero</strong> para revelar la diferencia contra el turno correcto.</p>
              } @else if (!r.matched) {
                <p class="muted">Guardado. Todavía no hay corte del sistema para comparar — la diferencia aparecerá cuando se procese.</p>
              } @else {
                <div class="arq-cmp">
                  <div><span class="arq-ev-k">Contado</span><span class="arq-ev-v strong">{{ money(r.total_contado) }}</span></div>
                  <div><span class="arq-ev-k">Esperado</span><span class="arq-ev-v">{{ money(r.esperado || 0) }}</span></div>
                  <div><span class="arq-ev-k">{{ diffLabel(r.diff_real) }}</span><span class="arq-ev-v strong" [class.bad]="(r.diff_real||0)>0" [class.ok]="(r.diff_real||0)<0">{{ signed(r.diff_real || 0) }}</span></div>
                </div>
              }
            </div>
          }
        </div>
        }

        <!-- Historial -->
        <div class="card-premium card-flat arq-panel">
          <h3 class="arq-card-title">Arqueos recientes</h3>
          <p-table [value]="rows()" styleClass="p-datatable-sm arq-table" [rowHover]="true" [loading]="loading()">
            <ng-template #header>
              <tr>
                <th>Fecha</th>
                @if (variasSucursales()) { <th>Sucursal</th> }
                <th>Tipo</th><th>Caja</th><th>Cajero</th><th class="ta-r">Contado</th>
                @if (revela) { <th class="ta-r">Diferencia</th> }
              </tr>
            </ng-template>
            <ng-template #body let-b>
              <tr>
                <td>{{ b.business_date | date:'dd/MM/yy' }}</td>
                @if (variasSucursales()) { <td>{{ branchLabel(b.warehouse_code) }}</td> }
                <td><p-tag [value]="b.tipo === 'relevo' ? 'Relevo' : 'Cierre'" [severity]="b.tipo === 'relevo' ? 'info' : 'secondary'" /></td>
                <td>{{ b.caja }}</td>
                <td>{{ b.cajero_nombre || b.cajero_code || '—' }}@if (b.tipo === 'relevo' && b.cajero_entrante) { <span class="muted"> → {{ b.cajero_entrante }}</span> }</td>
                <td class="ta-r">{{ money(b.total_contado) }}</td>
                @if (revela) {
                  <td class="ta-r strong" [class.bad]="(b.diff_real||0)>0" [class.ok]="(b.diff_real||0)<0">{{ b.diff_real != null ? signed(b.diff_real) : '—' }}</td>
                }
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td [attr.colspan]="colspan()" class="arq-empty">Sin arqueos aún.</td></tr></ng-template>
          </p-table>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .arq-head-right { display: inline-flex; align-items: center; gap: .4rem; margin-left: auto; }
    .arq-scope { display: inline-flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 600; color: var(--action); }
    .arq-scope i { font-size: .72rem; }
    .arq-nowh { display: flex; gap: .8rem; align-items: flex-start; padding: 1rem; margin-bottom: 1rem; }
    .arq-nowh i { color: var(--action); margin-top: .15rem; }
    .arq-nowh p { margin: .2rem 0 0; font-size: .82rem; }
    .arq-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .arq-2col.arq-1col { grid-template-columns: 1fr; }
    @media (max-width: 900px) { .arq-2col { grid-template-columns: 1fr; } }
    .arq-panel { padding: 1rem; }
    .arq-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    :host ::ng-deep .arq-seg { margin-bottom: .7rem; }
    .arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin: .8rem 0; align-items: flex-end; }
    .arq-lbl { display: inline-flex; flex-direction: column; gap: .2rem; font-size: .76rem; color: var(--text-muted); }
    :host ::ng-deep .arq-fld { font-size: .82rem; padding: .35rem .6rem; }
    :host ::ng-deep .arq-fld-sm { width: 5.5rem; }
    .arq-fld-suc { width: 11rem; }
    :host ::ng-deep .arq-num { width: 5rem; text-align: right; font-variant-numeric: tabular-nums; padding: .25rem .4rem; }
    :host ::ng-deep .arq-date .p-datepicker-input { width: 8.5rem; }
    .arq-block { display: block; margin: .8rem 0; }
    .arq-sel { font-size: .82rem; padding: .35rem .6rem; border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); background: var(--card-bg); color: var(--text-main); }
    .arq-block .arq-sel { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-block .arq-fld { display: block; width: 100%; margin-top: .2rem; }
    :host ::ng-deep .arq-denoms-tbl { font-variant-numeric: tabular-nums; margin-bottom: .4rem; }
    :host ::ng-deep .arq-denoms-tbl .p-datatable-tbody > tr > td { padding: .2rem .5rem; }
    .arq-denom-lbl { font-variant-numeric: tabular-nums; }
    .arq-hint { margin: 0 0 .8rem; font-size: .72rem; color: var(--text-muted); display: flex; align-items: center; gap: .35rem; }
    .arq-hint kbd { font-family: var(--font-mono, monospace); font-size: .68rem; padding: .05rem .3rem; border: 1px solid var(--border-color); border-radius: 4px; background: var(--surface-hover-bg); }
    :host ::ng-deep .arq-total-row td { border-top: 2px solid var(--border-color); font-weight: 700; }
    .arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md); border: 1px solid var(--border-color); background: var(--surface-hover-bg); }
    .arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg) 40%, transparent); background: color-mix(in srgb, var(--bad-fg) 6%, transparent); }
    .arq-result.ok { border-color: color-mix(in srgb, var(--ok-fg) 40%, transparent); background: color-mix(in srgb, var(--ok-fg) 6%, transparent); }
    .arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: .6rem 1rem; }
    .arq-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); display: block; }
    .arq-ev-v { font-size: .95rem; font-variant-numeric: tabular-nums; }
    .arq-mt { margin: .6rem 0 0; font-size: .78rem; }
    .arq-table { font-variant-numeric: tabular-nums; }
    .arq-empty { padding: 2rem; text-align: center; color: var(--text-muted); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }
  `],
})
export class TiendaArqueoComponent implements OnInit, HasUnsavedChanges {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly dataScope = inject(DataScopeService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChildren('denomInput') private denomInputs?: QueryList<ElementRef<HTMLInputElement>>;

  /**
   * ¿Se le revela el cuadre? Solo al supervisor del motor (`RECONCILIATION_VER`).
   * Espeja la regla del backend — acá es cosmético (el backend ya no manda los
   * campos), pero evita renderizar columnas que siempre saldrían vacías.
   */
  readonly revela = this.perms.can('manage', 'all')
    || this.auth.user()?.permissions?.[Permission.RECONCILIATION_VER] === true;

  /** Sucursales del ALCANCE del usuario (`/users/me/scope`), no de su ficha. */
  readonly sucursales = signal<ScopeOption[]>([]);
  readonly scopeCargado = signal(false);
  /** Con una sola asignada no hay nada que elegir: se fija y se muestra como chip. */
  readonly sucursalFija = computed(() => this.sucursales().length === 1 ? this.sucursales()[0].value : '');
  readonly variasSucursales = computed(() => this.sucursales().length > 1);

  readonly canCapture = computed(() =>
    (this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.STORE_ARQUEO_CAPTURAR] === true)
    && (!this.scopeCargado() || this.sucursales().length > 0));

  readonly tipoOptions = [
    { label: 'Cierre de día', value: 'cierre' as const },
    { label: 'Relevo (cambio de turno)', value: 'relevo' as const },
  ];

  readonly denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<'cierre' | 'relevo'>('cierre');
  aSuc = ''; aCaja = ''; aDate: Date = new Date(); aCajero = ''; aEntrante = ''; aNota = ''; aIncidencia = '';
  readonly arqTotal = signal(0);
  readonly saving = signal(false);
  readonly loading = signal(false);
  readonly dirty = signal(false);
  readonly result = signal<ArqueoResult | null>(null);
  readonly rows = signal<ArqueoRow[]>([]);

  readonly submitLabel = computed(() =>
    this.aTipo() === 'relevo' ? 'Sellar relevo' : (this.revela ? 'Guardar y revelar diferencia' : 'Guardar arqueo'));
  readonly colspan = computed(() => 5 + (this.variasSucursales() ? 1 : 0) + (this.revela ? 1 : 0));

  /** §13 estado sucio — hay conteo capturado sin guardar. */
  hasUnsavedChanges(): boolean { return this.dirty(); }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent) { if (this.hasUnsavedChanges()) e.preventDefault(); }

  ngOnInit() {
    // SM.9 — autofill del cajero: las cajeras loguean con username = su código de
    // caja. Prellenamos el código (en MAYÚSCULAS, como viene en el corte de Kepler)
    // solo cuando el usuario tiene sucursal propia (= es una cajera, no un rol
    // global). Así solo cuenta el dinero.
    if (this.auth.user()?.warehouse_code) {
      const u = this.auth.user()?.username;
      if (u) this.aCajero = u.toUpperCase();
    }
    this.dataScope.warehouses().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (w) => {
        this.sucursales.set(w);
        this.scopeCargado.set(true);
        if (w.length === 1) this.aSuc = w[0].value;
      },
      // Sin alcance no se bloquea la captura: el backend resuelve la sucursal.
      error: () => this.scopeCargado.set(true),
    });
    this.load();
  }

  branchLabel(code?: string | null): string {
    if (!code) return '';
    const o = this.sucursales().find((w) => w.value === code);
    return o?.label || branchName(code);
  }

  canSubmit(): boolean {
    const suc = this.sucursalFija() || this.aSuc.trim();
    return !!suc && !!this.aCaja.trim() && !!this.aDate && this.arqTotal() > 0;
  }

  // ─────────────────── pad de denominaciones ───────────────────

  /** Solo dígitos: es un conteo de billetes, no una fórmula. */
  onDenomInput(denom: number, ev: Event) {
    const el = ev.target as HTMLInputElement;
    const limpio = (el.value || '').replace(/\D/g, '');
    if (limpio !== el.value) el.value = limpio;
    if (limpio) this.denomCount[denom] = Number(limpio);
    else delete this.denomCount[denom];
    this.recalc();
  }

  /**
   * ↑/↓ SALTAN de casilla (y Enter avanza), en vez de incrementar el conteo —
   * por eso este input no es un `p-inputnumber`. Contar efectivo es teclear un
   * número y bajar; una flecha que suma un billete sin aviso es un descuadre.
   */
  onDenomKey(ev: KeyboardEvent, i: number) {
    const salto = ev.key === 'ArrowUp' ? -1 : (ev.key === 'ArrowDown' || ev.key === 'Enter') ? 1 : 0;
    if (!salto) return;
    ev.preventDefault();
    this.focusDenom(i + salto);
  }

  private focusDenom(i: number) {
    const inputs = this.denomInputs?.toArray() ?? [];
    if (i < 0 || i >= inputs.length) return;
    const el = inputs[i].nativeElement;
    el.focus();
    el.select();
  }

  /** Al entrar a una casilla se selecciona lo que hay: retecleás encima, no atrás. */
  selectAll(ev: Event) { (ev.target as HTMLInputElement).select(); }

  recalc() {
    this.arqTotal.set(this.denoms.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0));
    this.dirty.set(true); // §13: cualquier edición ensucia; se limpia solo al guardar OK
  }

  // ─────────────────────────── guardar ───────────────────────────

  submit() {
    if (this.saving()) return; // §13 idempotencia visual: ignora re-clicks
    this.saving.set(true);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
    const relevo = this.aTipo() === 'relevo';
    this.svc.submit({
      warehouse_code: this.sucursalFija() || this.aSuc.trim() || undefined,
      caja: this.aCaja.trim(), business_date: this.fmtDate(this.aDate), tipo: this.aTipo(),
      cajero_code: this.aCajero.trim() || undefined,
      cajero_entrante: relevo ? (this.aEntrante.trim() || undefined) : undefined,
      denominations, nota: this.aNota.trim() || undefined,
      incidencia_tipo: !relevo && this.aIncidencia ? this.aIncidencia : undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.saving.set(false); this.result.set(r); this.dirty.set(false);
        const detail = r.tipo === 'relevo' ? `Relevo sellado (${this.money(r.total_contado)}).`
          : !r.reveal ? `Total contado ${this.money(r.total_contado)}. Lo revisa tu supervisor.`
          : r.ambiguous ? 'Guardado. Varios cortes hoy: especificá el cajero para comparar.'
          : (r.matched ? `${this.diffLabel(r.diff_real)}: ${this.signed(r.diff_real || 0)}` : 'Guardado (sin corte para comparar aún).');
        this.toast.add({
          severity: this.revela && (r.diff_real || 0) > 0 ? 'warn' : 'success',
          summary: r.tipo === 'relevo' ? 'Relevo guardado' : 'Arqueo guardado', detail,
        });
        this.load();
      },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
    });
  }

  private load() {
    this.loading.set(true);
    this.svc.list({ limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => { this.rows.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  /** Fecha local → 'YYYY-MM-DD' sin corrimiento de TZ (§10: no re-convertir). */
  private fmtDate(d: Date): string {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  diffLabel(diff: number | null | undefined): string {
    if (diff == null) return 'Diferencia';
    if (diff > 0) return 'Faltante';
    if (diff < 0) return 'Sobrante';
    return 'Cuadrado';
  }
  // Pantalla de conteo de efectivo (incl. denominación de 50¢): SIEMPRE con centavos,
  // si no, 3×$0.50 se vería "$2" y una diferencia real de centavos parecería cuadrada.
  money(v: number | string | null | undefined): string { return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
}
