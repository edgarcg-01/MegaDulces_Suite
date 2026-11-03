import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime } from 'rxjs';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  diaCorto, ETIQUETA_CAUSA_NEGATIVO, ETIQUETA_REAPERTURA, MOTIVOS_EXISTENCIA_NEGATIVA, validarResolucionNegativo,
  type CausaNegativo, type ExistenciaNegativaItem, type ExistenciaNegativaResponse, type MotivoNegativo,
} from '@megadulces/contracts';
import { AlmacenMovimientosService } from '../almacen-movimientos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';

const SEVERIDAD: Record<CausaNegativo, 'danger' | 'warn' | 'secondary'> = {
  entrada_sin_aplicar: 'warn', salio_sin_existencia: 'danger', rezago: 'secondary',
};
const ETIQUETA_MOTIVO = new Map(MOTIVOS_EXISTENCIA_NEGATIVA.map((m) => [m.codigo, m.etiqueta]));
type Vista = '' | CausaNegativo | 'resueltas';

/**
 * `[MX.3.3]` **Existencia negativa** — la sección de Prevención dentro de `/almacen/incidencias`.
 *
 * Kepler deja vender sin existencia y la pantalla de Existencia lo recorta a 0, así que nadie se
 * enteraba (Edgar, 2026-11-03, con 17210 en Zamora Centro: −260). Aquí llega cada producto × sucursal
 * en negativo HOY, por el dinero que falta, con la causa sólo cuando el dato la prueba (un vale de
 * entrada sin su orden de entrada) y, si no, lo que se sabe sin inventar el porqué.
 *
 * Componente aparte y no una pestaña dentro de la bandeja de movimientos: contesta OTRA pregunta
 * («qué productos están en negativo» ≠ «qué movimientos no cuadran»), y meterla en la misma clase
 * habría juntado dos (skill `diseno` §3a).
 *
 * Jerarquía: primario = cuántos hay por atender y cuánto valen (franja) y, en cada fila, dónde está
 * el error; secundario = la existencia de Kepler y el valor de la fila; terciario = la clave, las
 * fechas, el costo unitario.
 *
 * Alcance (D10): Prevención ve la red; el encargado de tienda sólo la suya — lo recorta el servidor.
 * El rezago (sin movimiento en 30 días) no entra a la lista por defecto (D9): es una opción con su
 * conteo, para revisarse en bloque.
 */
@Component({
  selector: 'app-almacen-existencia-negativa',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, SelectModule, InputTextModule, TextareaModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="neg-cabeza">
      <p class="neg-sub">Productos que Kepler tiene en negativo hoy, por el dinero que falta. Se corrigen en Kepler; aquí se registra qué pasó.
        <app-context-help topic="almacen-existencia-negativa" /></p>
      <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="600"></app-freshness-pill>
    </div>

    <div class="neg-filtros">
      <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="elegirVista($event)" ariaLabel="Qué existencias negativas ver"></app-segmented>
      @if (sucursales().length > 1) {
        <p-select [options]="sucursales()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="elegirSucursal($event)"
                  [showClear]="true" placeholder="Todas las sucursales" appendTo="body" inputId="neg-suc" ariaLabel="Sucursal" class="neg-suc"></p-select>
      }
      <input pInputText type="search" class="neg-buscar" [ngModel]="busqueda()" (ngModelChange)="buscar($event)"
             placeholder="Clave o nombre del producto" aria-label="Buscar producto" />
    </div>

    @if (resp(); as r) {
      <app-metric-strip [items]="kpis()" ariaLabel="Existencias negativas"></app-metric-strip>
      @if (r.alcance === 'propias') { <p class="neg-nota">Ves sólo tu sucursal.</p> }
    }

    <app-load-state class="dt-scope" [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="!!resp() && !resp()!.rows.length"
                    emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="recargar()">
      <p-table [value]="resp()?.rows ?? []" [lazy]="true" (onLazyLoad)="paginar($event)" [paginator]="total() > tam" [rows]="tam"
               [totalRecords]="total()" [first]="(pagina() - 1) * tam" [loading]="cargando()"
               selectionMode="single" [dataKey]="'clave'" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack"
               [rowHover]="true" (onRowSelect)="revisar($any($event).data)">
        <ng-template #header>
          <tr>
            <th>Producto y dónde está el error</th>
            <th>Sucursal</th>
            <th class="comm-num">Existencia en Kepler</th>
            <th class="comm-num">Valor a costo</th>
            <th><span class="neg-oculto">Acción</span></th>
          </tr>
        </ng-template>
        <ng-template #body let-f>
          <tr [pSelectableRow]="f">
            <td class="dt-id neg-cel-donde" data-label="Producto" role="cell">
              <div class="neg-tags">
                <p-tag [value]="causa(f.causa)" [severity]="severidad(f.causa)"></p-tag>
                @if (f.reabierta) { <p-tag [value]="reapertura(f.reabierta)" severity="danger"></p-tag> }
              </div>
              <span class="neg-prod">{{ f.producto || 'Sin ficha en el catálogo' }}</span>
              <span class="neg-donde">{{ f.donde }}</span>
              <span class="neg-clave">{{ f.sku }}</span>
              @if (f.resolucion && !f.reabierta) {
                <span class="neg-resuelta"><i class="pi pi-check" aria-hidden="true"></i> {{ motivo(f.resolucion.motivo) }}</span>
              }
            </td>
            <td data-label="Sucursal" role="cell">{{ f.sucursal }}</td>
            <td class="comm-num dt-num" data-label="Existencia" role="cell">
              <span class="neg-exist">{{ f.existencia | number:'1.0-2' }}</span>
              @if (f.quedaria != null) { <span class="neg-tenue">queda en {{ f.quedaria | number:'1.0-2' }} al aplicar</span> }
            </td>
            <td class="comm-num dt-num" data-label="Valor" role="cell">
              @if (f.valor != null) { <span class="neg-valor">{{ dinero(f.valor) }}</span> } @else { <span class="neg-tenue">sin costo en Kepler</span> }
            </td>
            <td class="dt-actions" data-label="Acción" role="cell">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="$event.stopPropagation(); revisar(f)"
                      [attr.aria-label]="'Revisar ' + (f.producto || f.sku) + ' en ' + f.sucursal">
                <span class="p-button-label">Revisar</span>
              </button>
            </td>
          </tr>
        </ng-template>
      </p-table>
    </app-load-state>

    <app-side-peek [open]="!!abierta()" (openChange)="$event ? null : cerrar()" [width]="560"
                   [title]="abierta()?.producto || abierta()?.sku || ''" [subtitle]="subtitulo()">
      @if (abierta(); as f) {
        <section class="neg-peek" aria-labelledby="neg-donde-h">
          <h3 id="neg-donde-h" class="neg-peek-h">Dónde está el error</h3>
          <p class="neg-peek-frase">{{ f.donde }}</p>
          @if (f.causa === 'entrada_sin_aplicar') {
            <p class="neg-peek-meta">Se corrige en Kepler aplicando la orden de entrada {{ f.vale!.folios.length > 1 ? 'de los vales' : 'del vale' }} {{ f.vale!.folios.join(', ') }}.</p>
          } @else if (f.causa === 'salio_sin_existencia') {
            <p class="neg-peek-meta">El dato no dice por qué: puede ser una venta con otra clave, una entrada que nunca se capturó o un faltante real. Eso es lo que se averigua.</p>
          }
          <dl class="neg-datos">
            <dt>Existencia en Kepler</dt><dd>{{ f.existencia | number:'1.0-2' }} pz</dd>
            <dt>Costo unitario</dt><dd>{{ f.costo_unitario != null ? dinero2(f.costo_unitario) : 'sin costo en Kepler' }}</dd>
            <dt>Última entrada</dt><dd>{{ dia(f.ult_entrada) }}</dd>
            <dt>Última salida</dt><dd>{{ dia(f.ult_salida) }}</dd>
          </dl>
        </section>

        <section class="neg-peek-resolver" aria-labelledby="neg-res-h">
          <h3 id="neg-res-h" class="neg-peek-h">Resolución</h3>
          @if (f.resolucion) {
            @if (f.reabierta) { <p class="neg-err">{{ reapertura(f.reabierta) }}. La resolución anterior ya no vale:</p> }
            <p class="neg-peek-frase-sm">{{ motivo(f.resolucion.motivo) }}</p>
            @if (f.resolucion.nota) { <p class="neg-peek-nota">«{{ f.resolucion.nota }}»</p> }
            <p class="neg-peek-meta">{{ f.resolucion.por || 'Alguien' }} · {{ dia(f.resolucion.fecha) }} · vio {{ f.resolucion.existencia_vista | number:'1.0-2' }} pz</p>
          }
          @if (puedeResolver) {
            @if (f.resolucion && !f.reabierta) {
              <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="guardando()" (click)="reabrir()">
                <span class="p-button-label">Reabrir</span>
              </button>
            } @else {
              <div class="neg-form">
                <label for="neg-motivo" class="neg-label">Motivo</label>
                <p-select inputId="neg-motivo" [options]="motivos" optionLabel="etiqueta" optionValue="codigo" [(ngModel)]="motivoSel"
                          placeholder="¿Qué pasó?" appendTo="body" class="neg-motivo"></p-select>
                <label for="neg-nota" class="neg-label">Nota{{ pideNota() ? '' : ' (opcional)' }}</label>
                <textarea pTextarea id="neg-nota" rows="3" maxlength="1000" [(ngModel)]="nota"
                          [placeholder]="pideNota() ? 'Qué pasó: con qué clave se vendió, número de acta…' : 'Opcional'"></textarea>
                @if (motivoSel && errorResolver()) { <p class="neg-err" role="alert">{{ errorResolver() }}</p> }
                <div class="neg-acciones">
                  <button pButton type="button" class="p-button-sm" [disabled]="guardando() || !!errorResolver()" (click)="resolver()">
                    <span class="p-button-label">Marcar resuelta</span>
                  </button>
                </div>
              </div>
            }
          } @else {
            <p class="neg-peek-meta">Para resolverla necesitas el permiso de gestionar movimientos (Prevención).</p>
          }
        </section>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .neg-cabeza { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .neg-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); display: inline-flex; align-items: center; gap: var(--sp-1); }
    .neg-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .neg-buscar { min-width: 16rem; }
    :host ::ng-deep .neg-suc { min-width: 14rem; }
    .neg-nota { margin: var(--sp-1) 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .neg-tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
    .neg-cel-donde { min-width: 20rem; }
    .neg-prod { display: block; margin-top: var(--sp-1); color: var(--text-main); }
    .neg-donde { display: block; color: var(--text-main); font-weight: 600; }
    .neg-clave, .neg-tenue { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .neg-clave { font-family: var(--font-mono, monospace); }
    .neg-resuelta { display: block; font-size: var(--fs-xs); color: var(--ok-fg); }
    .neg-exist { display: block; font-weight: 600; color: var(--bad-fg); }
    .neg-valor { display: block; font-weight: 600; color: var(--text-main); }
    .neg-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .neg-peek-h { margin: 0 0 var(--sp-1); font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .neg-peek-frase { margin: 0; font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); }
    .neg-peek-frase-sm { margin: 0; font-weight: 600; color: var(--text-main); }
    .neg-peek-meta { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .neg-peek-nota { margin: var(--sp-1) 0 0; color: var(--text-main); }
    .neg-datos { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-1) var(--sp-3); margin: var(--sp-3) 0 0; font-size: var(--fs-sm); }
    .neg-datos dt { color: var(--text-muted); }
    .neg-datos dd { margin: 0; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .neg-peek-resolver { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .neg-form { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); }
    .neg-label { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--sp-2); }
    .neg-err { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--bad-fg); }
    .neg-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
    :host ::ng-deep .neg-motivo { width: 100%; }
    @container (max-width: 48rem) { .neg-filtros { flex-direction: column; align-items: stretch; } .neg-buscar { min-width: 0; } }
  `],
})
export class AlmacenExistenciaNegativaComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** Cuántas hay por atender (sin rezago), para el conteo del selector de la página. */
  readonly porAtender = output<number>();

  /** Resolver escribe: el mismo permiso que resolver una incidencia de movimientos (Prevención). */
  readonly puedeResolver = this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_MOVEMENTS_GESTIONAR];
  /** Copia mutable: `p-select` pide `any[]` y el catálogo del contrato es `readonly`. */
  readonly motivos = [...MOTIVOS_EXISTENCIA_NEGATIVA];

  readonly tam = 50;
  readonly vista = signal<Vista>('');
  readonly sucursal = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly pagina = signal(1);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resp = signal<(ExistenciaNegativaResponse & { rows: (ExistenciaNegativaItem & { clave: string })[] }) | null>(null);
  readonly cargadoEn = signal<Date | null>(null);
  private readonly busqueda$ = new Subject<string>();

  readonly abierta = signal<ExistenciaNegativaItem | null>(null);
  readonly guardando = signal(false);
  private readonly motivoSig = signal<MotivoNegativo | null>(null);
  private readonly notaSig = signal('');
  get motivoSel(): MotivoNegativo | null { return this.motivoSig(); }
  set motivoSel(v: MotivoNegativo | null) { this.motivoSig.set(v); }
  get nota(): string { return this.notaSig(); }
  set nota(v: string) { this.notaSig.set(v ?? ''); }

  readonly total = computed(() => this.resp()?.total ?? 0);

  readonly vistas = computed<SegOption[]>(() => {
    const t = this.resp()?.totals;
    const n = (c: CausaNegativo) => t?.por_causa[c].n ?? 0;
    return [
      { label: 'Por atender', value: '', count: n('entrada_sin_aplicar') + n('salio_sin_existencia') },
      { label: 'Entrada sin aplicar', value: 'entrada_sin_aplicar', count: n('entrada_sin_aplicar') },
      { label: 'Salió sin existencia', value: 'salio_sin_existencia', count: n('salio_sin_existencia') },
      { label: 'Rezago', value: 'rezago', count: n('rezago') },
      { label: 'Resueltas', value: 'resueltas', count: t?.resueltas ?? 0 },
    ];
  });

  /** Por NOMBRE y con su conteo: se ve dónde pesa antes de elegir. */
  readonly sucursales = computed(() => (this.resp()?.totals.por_sucursal ?? [])
    .map((s) => ({ value: s.warehouse_id, label: `${s.sucursal} · ${s.n.toLocaleString('es-MX')} por atender` })));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resp(); if (!r) return [];
    const c = r.totals.por_causa;
    const activos = c.entrada_sin_aplicar.n + c.salio_sin_existencia.n;
    const sinCosto = c.entrada_sin_aplicar.sin_costo + c.salio_sin_existencia.sin_costo;
    return [
      { label: 'Por atender', value: activos, format: 'number', tone: activos ? 'warn' : 'ok',
        sub: `de ${r.totals.universo.toLocaleString('es-MX')} en negativo · ${r.totals.resueltas.toLocaleString('es-MX')} resueltas` },
      { label: 'Valor a costo', value: c.entrada_sin_aplicar.valor + c.salio_sin_existencia.valor, format: 'currency', tone: 'default',
        ...(sinCosto ? { state: 'parcial' as const, stateNote: `${sinCosto.toLocaleString('es-MX')} productos sin costo en Kepler no suman` } : {}) },
      { label: 'Entrada sin aplicar', value: c.entrada_sin_aplicar.n, format: 'number', tone: c.entrada_sin_aplicar.n ? 'warn' : 'muted',
        sub: 'se arreglan aplicando la orden de entrada en Kepler' },
      { label: 'Rezago', value: c.rezago.n, format: 'number', tone: 'muted', sub: `sin movimiento en 30 días · ${this.dinero(c.rezago.valor)}` },
    ];
  });

  readonly vacioTitulo = computed(() => {
    const v = this.vista();
    if (this.busqueda().trim()) return 'Ningún producto coincide con la búsqueda';
    if (v === 'resueltas') return 'Ninguna existencia negativa resuelta';
    return v ? `Sin existencias negativas de tipo «${ETIQUETA_CAUSA_NEGATIVO[v]}»` : 'Ningún producto en negativo por atender';
  });
  readonly vacioPista = computed(() => (this.vista() || this.busqueda().trim()
    ? 'Elige «Por atender» o borra la búsqueda para ver el resto.'
    : 'Kepler no tiene productos en negativo con movimiento reciente, o ya se resolvieron.'));

  readonly subtitulo = computed(() => {
    const f = this.abierta(); if (!f) return null;
    return `${f.sucursal} · clave ${f.sku}`;
  });
  readonly pideNota = computed(() => !!MOTIVOS_EXISTENCIA_NEGATIVA.find((m) => m.codigo === this.motivoSig())?.pide_nota);
  /** Poka-yoke: la misma validación que el servidor, antes de enviar. */
  readonly errorResolver = computed(() => validarResolucionNegativo(this.motivoSig(), this.notaSig()));

  ngOnInit(): void {
    this.busqueda$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.recargar());
    this.cargar();
  }

  recargar(): void { this.pagina.set(1); this.cargar(); }
  elegirVista(v: string): void { this.vista.set(v as Vista); this.recargar(); }
  elegirSucursal(v: string | null): void { this.sucursal.set(v || null); this.recargar(); }
  buscar(v: string): void { this.busqueda.set(v ?? ''); this.busqueda$.next(v ?? ''); }

  paginar(e: TableLazyLoadEvent): void {
    const p = Math.floor((e.first ?? 0) / this.tam) + 1;
    if (p === this.pagina()) return;
    this.pagina.set(p); this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true); this.error.set(null);
    const v = this.vista();
    this.api.negativeStock({
      warehouse_ids: this.sucursal() ? [this.sucursal() as string] : [],
      estado: v === 'resueltas' ? 'resueltas' : 'pendientes',
      causas: v && v !== 'resueltas' ? [v] : [],
      search: this.busqueda(),
      page: this.pagina(), pageSize: this.tam,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.resp.set({ ...r, rows: r.rows.map((x) => ({ ...x, clave: `${x.warehouse_id}|${x.sku}` })) });
        this.cargando.set(false); this.cargadoEn.set(new Date());
        this.porAtender.emit(r.totals.por_causa.entrada_sin_aplicar.n + r.totals.por_causa.salio_sin_existencia.n);
      },
      // un error limpia lo anterior: no se deja en pantalla el número de otra consulta
      error: () => { this.resp.set(null); this.cargando.set(false); this.error.set('No se pudieron cargar las existencias negativas.'); },
    });
  }

  revisar(f: ExistenciaNegativaItem): void {
    this.abierta.set(f);
    this.motivoSel = null;
    this.nota = '';
  }

  cerrar(): void { this.abierta.set(null); }

  resolver(): void {
    const f = this.abierta(); const m = this.motivoSig();
    if (!f || !m || this.guardando() || this.errorResolver()) return;
    this.guardando.set(true); // síncrono en el primer clic: un doble clic no manda dos
    this.api.resolveNegative(f.warehouse_id, f.sku, m, this.notaSig().trim() || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        this.toast.add({ severity: 'success', summary: 'Resuelta', detail: `${f.producto || f.sku} en ${f.sucursal}: ${this.motivo(m)}` });
        this.cerrar(); this.cargar();
      },
      error: (e: { error?: { message?: string } }) => {
        this.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se guardó', detail: e?.error?.message || 'Intenta de nuevo.' });
      },
    });
  }

  reabrir(): void {
    const f = this.abierta(); if (!f || this.guardando()) return;
    this.guardando.set(true);
    this.api.reopenNegative(f.warehouse_id, f.sku).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.toast.add({ severity: 'info', summary: 'Reabierta', detail: `${f.producto || f.sku} en ${f.sucursal}` }); this.cerrar(); this.cargar(); },
      error: () => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se reabrió', detail: 'Intenta de nuevo.' }); },
    });
  }

  causa(c: CausaNegativo): string { return ETIQUETA_CAUSA_NEGATIVO[c]; }
  severidad(c: CausaNegativo): 'danger' | 'warn' | 'secondary' { return SEVERIDAD[c]; }
  reapertura(r: keyof typeof ETIQUETA_REAPERTURA): string { return ETIQUETA_REAPERTURA[r]; }
  motivo(m: MotivoNegativo | null | undefined): string { return (m && ETIQUETA_MOTIVO.get(m)) || 'Sin motivo'; }
  dia(f: string | null): string { return f ? diaCorto(f) : 'sin fecha'; }
  dinero(n: number | string): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  dinero2(n: number | string): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
