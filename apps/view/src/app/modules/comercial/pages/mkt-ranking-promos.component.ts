import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { firstValueFrom, of, catchError } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { warehouseName } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PROMOS_TABS } from '../promos-tabs';
import {
  CANAL_CORTO, Canal, MktRankingService, Objetivo, PromoMkt, Sugerido,
  ProductosDePromo, ProveedorPromo, SIN_PROVEEDOR, textoProductos,
} from '../mkt-ranking.service';

/** [MKT.24] «CD015 · DULCES DE LA ROSA»: la clave de Kepler ubica, el nombre se lee. */
export const textoProveedor = (p: ProveedorPromo | null | undefined): string => (p ? `${p.code} · ${p.name}` : 'Sin proveedor asignado');

/** [MKT.24] ¿La promo es del proveedor del filtro? null = todos; 'sin' = las que nadie asignó. */
export function delProveedor(p: { proveedor?: ProveedorPromo | null }, filtro: string | null): boolean {
  if (!filtro) return true;
  return filtro === SIN_PROVEEDOR ? !p.proveedor : p.proveedor?.id === filtro;
}

/** Las 8 sucursales que venden (la 00 es oficinas). */
export const SUCURSALES_VENTA = ['01', '02', '03', '04', '05', '06', '07', '08'];

/** Un renglón editable de objetivos: lo guardado, lo sugerido y lo que se está escribiendo. */
export interface FilaObjetivo {
  warehouse_code: string;
  vendor_code: string;
  nombre: string;
  guardado: number | null;
  fuente: 'sugerido' | 'manual' | null;
  sugerido: number | null;
  semanas_historia: number;
  valor: number | null;
}

/** Arma los renglones de un canal: sucursales (mostrador) o vendedores con historia u objetivo. */
export function armarFilas(canal: Canal, sucursales: string[], objetivos: Objetivo[], sugeridos: Sugerido[]): FilaObjetivo[] {
  const obj = objetivos.filter((o) => o.canal === canal);
  const sug = sugeridos.filter((s) => s.canal === canal);
  const llave = (w: string, v: string) => `${w}|${v}`;
  const filas = new Map<string, FilaObjetivo>();
  const base = (w: string, v: string, nombre: string): FilaObjetivo =>
    ({ warehouse_code: w, vendor_code: v, nombre, guardado: null, fuente: null, sugerido: null, semanas_historia: 0, valor: null });
  if (canal === 'mostrador') for (const w of sucursales) filas.set(llave(w, ''), base(w, '', warehouseName(w)));
  for (const s of sug) {
    const k = llave(s.warehouse_code, s.vendor_code);
    const f = filas.get(k) ?? base(s.warehouse_code, s.vendor_code, s.vendor_name || s.vendor_code.split(':').pop() || s.vendor_code);
    f.sugerido = s.sugerido; f.semanas_historia = s.semanas_historia;
    if (canal === 'mostrador' || sucursales.includes(s.warehouse_code)) filas.set(k, f);
  }
  for (const o of obj) {
    const k = llave(o.warehouse_code, o.vendor_code);
    const f = filas.get(k) ?? base(o.warehouse_code, o.vendor_code, o.vendor_code.split(':').pop() || o.vendor_code);
    f.guardado = o.objetivo_semanal; f.fuente = o.fuente ?? 'manual'; f.valor = o.objetivo_semanal;
    filas.set(k, f);
  }
  return [...filas.values()].sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code) || a.nombre.localeCompare(b.nombre, 'es'));
}

/** Lo que cambió respecto de lo guardado, listo para mandar. Vacío o 0 = quitar el objetivo. */
export function cambios(canal: Canal, filas: FilaObjetivo[]): Objetivo[] {
  return filas
    .filter((f) => (f.valor ?? null) !== (f.guardado ?? null))
    .map((f) => ({
      warehouse_code: f.warehouse_code, canal, vendor_code: f.vendor_code,
      objetivo_semanal: f.valor && f.valor > 0 ? f.valor : null,
      // [MKT.17] Todo lo que se guarda es un objetivo FIJO; lo que no se guarda va con el dinámico.
      fuente: 'manual',
    }));
}

/**
 * `[MKT.11]` **Objetivos** — qué promociones mide el ranking y contra qué objetivo.
 *
 * Propósito: fijar el objetivo semanal por sucursal o vendedor de las promociones de Kepler.
 * `[MKT.22]` Nadie las da de alta: salen de Kepler (las que vendieron en 5 semanas), como en la app
 * de vendedor. `[MKT.17]` Sin objetivo fijo, el ranking usa el
 * DINÁMICO (promedio de las 4 semanas anteriores, recalculado cada semana); fijarlo es opcional.
 *
 * `[MKT.24]` El PROVEEDOR de cada promo lo asigna Mercadotecnia aquí, en la misma celda (Kepler sólo
 * trae la cubeta «PROMOCIONES MKT»: medido, ninguna fuente lo da). Se elige con un clic y se guarda
 * solo; «Sin proveedor» se cuenta arriba y se filtra, para que lo pendiente no se esconda.
 *
 * Jerarquía: primario = qué promos hay, su proveedor y cuáles tienen objetivo fijo; secundario =
 * dónde vendieron; terciario = el código.
 */
@Component({
  selector: 'app-mkt-ranking-promos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ButtonModule, InputTextModule, InputNumberModule, ToastModule, ConfirmDialogModule, SelectModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rp">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Objetivos del ranking <app-context-help topic="mkt-ranking" /></h1>
          <p class="surf-page-sub">Las promociones salen de Kepler, como en la app de vendedor. Aquí les asignas su proveedor y, si quieres, un objetivo semanal.</p>
        </div>
        <div class="rp-cabeza-der">
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="900"></app-freshness-pill>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" variant="menu" ariaLabel="Secciones de Mercadotecnia" />

      <div class="rp-filtros">
        <span class="rp-tenue rp-inline">Promociones de Kepler («= GRATIS») que vendieron en las últimas 5 semanas.</span>
        <p-select [options]="opcionesFiltroProveedor()" optionLabel="label" optionValue="value" [ngModel]="filtroProveedor()"
                  (ngModelChange)="filtroProveedor.set($event)" [filter]="true" filterBy="label" [showClear]="true"
                  placeholder="Todos los proveedores" appendTo="body" class="rp-prov-filtro" ariaLabel="Filtrar por proveedor"></p-select>
        <input pInputText type="search" class="rp-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Código, promoción o proveedor" aria-label="Buscar promoción" />
      </div>

      @if (promos(); as ps) {
        <app-metric-strip [items]="kpis()" ariaLabel="Promociones del ranking" (drill)="drill($event)"></app-metric-strip>
      }

      <app-load-state [loading]="res.isLoading() && !promos()" [error]="res.error() ? 'No se pudieron cargar las promociones.' : null"
                      [isEmpty]="!!promos() && !filas().length" emptyIcon="pi-megaphone"
                      [emptyTitle]="(promos()?.length ?? 0) ? 'Nada coincide' : 'Ninguna promoción de Kepler vendió en las últimas 5 semanas'"
                      [emptyHint]="(promos()?.length ?? 0) ? 'Prueba otra búsqueda o quita el filtro de proveedor.' : 'Las promociones aparecen solas cuando Kepler registra su venta.'"
                      (retry)="res.reload()">
        <p-table [value]="filas()" dataKey="id" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Promoción</th>
              <th>Proveedor</th>
              <th>Vendió en</th>
              <th>Sucursales</th>
              <th class="comm-num">Objetivos fijos</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p" [attr.aria-label]="'Objetivos de ' + p.mecanica">
              <td data-label="Promoción">
                <span class="rp-nombre">{{ p.mecanica }}</span>
                <span class="rp-tenue">{{ p.code }}@if (p.descripcion_kepler && p.descripcion_kepler !== p.mecanica) { · Kepler: {{ p.descripcion_kepler }} }</span>
                @if (p.productos; as pr) {
                  <span class="rp-producto" [title]="pr.nota">{{ textoProductos(pr.metodo, nombresProducto(pr)) }}</span>
                }
              </td>
              <!-- [MKT.24] Se asigna en la celda: el clic no abre el panel de objetivos. -->
              <td data-label="Proveedor" class="rp-prov" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
                @if (puedeGestionar) {
                  <!-- El derivado del producto es una SUGERENCIA (placeholder), no un valor guardado: elegirlo lo confirma. -->
                  <p-select [options]="proveedores()" optionLabel="etiqueta" optionValue="id" [ngModel]="asignado(p)"
                            (ngModelChange)="asignarProveedor(p, $event)" [filter]="true" filterBy="etiqueta" [showClear]="true"
                            [virtualScroll]="true" [virtualScrollItemSize]="36" [disabled]="guardandoProveedor() === p.id"
                            [loading]="guardandoProveedor() === p.id" [placeholder]="sugerencia(p)" appendTo="body"
                            class="rp-prov-sel" [ariaLabel]="'Proveedor de ' + p.mecanica"></p-select>
                } @else {
                  <span [class.rp-tenue]="!p.proveedor" [class.rp-inline]="!p.proveedor">{{ textoProveedor(p.proveedor) }}</span>
                  @if (p.proveedor_fuente === 'producto') { <span class="rp-tenue">del producto que la activa</span> }
                }
              </td>
              <td data-label="Vendió en">{{ canalesTexto(p.canales) }}</td>
              <td data-label="Sucursales">{{ sucursalesTexto(p) }}</td>
              <td class="comm-num" data-label="Objetivos">
                @if (p.objetivos) { {{ p.objetivos }} } @else { <span class="rp-tenue rp-inline">dinámico</span> }
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <!-- Objetivos de una promoción -->
      <app-side-peek [open]="!!abierta()" (openChange)="$event ? null : cerrarPeek()" [width]="720"
                     [title]="abierta()?.mecanica ?? ''" [subtitle]="abierta() ? abierta()!.code + ' · vendió en ' + canalesTexto(abierta()!.canales) : null">
        @if (abierta(); as p) {
          @if (p.canales.length > 1) {
            <app-segmented [options]="canalesPeek()" [value]="canalPeek()" (valueChange)="elegirCanalPeek($any($event))" ariaLabel="Canal"></app-segmented>
          }
          <p class="rp-ayuda">Objetivo semanal: cuántas veces se debe aplicar la promoción de lunes a domingo.
            Si no fijas uno, el ranking usa el <strong>dinámico</strong>: el promedio de las 4 semanas anteriores{{ canalPeek() === 'mostrador' ? '' : ' de cada vendedor' }}, que se recalcula solo cada semana.
            Fíjalo sólo si quieres una meta distinta; bórralo para volver al dinámico. Sin historia ni objetivo fijo = sin objetivo (no cuenta para el lugar, no es cero).</p>
          <app-load-state [loading]="cargandoObj()" [error]="errorObj()" [isEmpty]="!cargandoObj() && !errorObj() && !filasObj().length"
                          emptyIcon="pi-users" emptyTitle="Nadie vendió esta promoción en este canal"
                          emptyHint="Cuando un vendedor la venda aparecerá aquí con su objetivo dinámico." (retry)="cargarObjetivos(p)">
            <p-table [value]="filasObj()" size="small" class="surf-table surf-table--plain">
              <ng-template #header>
                <tr>
                  <th>{{ canalPeek() === 'mostrador' ? 'Sucursal' : 'Vendedor' }}</th>
                  <th class="comm-num">Dinámico esta semana</th>
                  <th class="comm-num">Objetivo fijo <span class="rp-tenue rp-inline">(opcional)</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr>
                  <td>
                    <span class="rp-nombre">{{ f.nombre }}</span>
                    @if (canalPeek() !== 'mostrador') { <span class="rp-tenue">{{ suc(f.warehouse_code) }}</span> }
                  </td>
                  <td class="comm-num">
                    @if (f.sugerido !== null) {
                      {{ f.sugerido }} <span class="rp-tenue">{{ f.semanas_historia }} sem. de historia</span>
                    } @else { <span class="rp-tenue">Sin historia</span> }
                  </td>
                  <td class="comm-num rp-input">
                    <p-inputnumber [(ngModel)]="f.valor" (ngModelChange)="marcarSucio()" [min]="0" [max]="1000000" [maxFractionDigits]="0"
                                   [disabled]="!puedeGestionar" [inputStyle]="{ width: '6rem', 'text-align': 'right' }"
                                   [ariaLabel]="'Objetivo fijo de ' + f.nombre" placeholder="dinámico"></p-inputnumber>
                    @if (f.valor === null) { <span class="rp-tenue">{{ f.sugerido !== null ? 'usa el dinámico' : 'sin objetivo' }}</span> }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </app-load-state>
          @if (puedeGestionar) {
            <div class="rp-peek-acciones">
              <span class="rp-espacio"></span>
              <button pButton type="button" class="p-button-sm" (click)="guardarObjetivos(p)" [disabled]="trabajando() || !sucio()" [loading]="trabajando()">
                <span class="p-button-label">Guardar objetivos</span></button>
            </div>
          }
        }
      </app-side-peek>

    </div>
  `,
  styles: [`
    :host { display: block; }
    .rp-cabeza-der { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .rp-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rp-filtros { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: var(--sp-4) 0 var(--sp-3); }
    .rp-buscar { min-width: 14rem; margin-left: auto; }
    .rp-prov-filtro { min-width: 16rem; max-width: 22rem; }
    .rp-prov { min-width: 14rem; }
    .rp-prov-sel { width: 100%; max-width: 20rem; }
    .rp-nombre { display: block; font-weight: var(--fw-medium); }
    .rp-inline { display: inline; }
    .rp-producto { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .rp-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .rp-tenue-i { color: var(--text-muted); font-size: var(--fs-xs); font-weight: var(--fw-regular); }
    .rp-nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .rp-ayuda { color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-3) 0; }
    .rp-input { white-space: nowrap; }
    .rp-peek-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin-top: var(--sp-4); }
    .rp-espacio { flex: 1; }
    .rp-form { display: flex; flex-direction: column; gap: var(--sp-2); }
    .rp-campo { font-weight: var(--fw-medium); font-size: var(--fs-sm); margin-top: var(--sp-2); }
    .rp-dos { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
    .rp-dos > div { display: flex; flex-direction: column; gap: var(--sp-1); }
    .rp-canales { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
    .rp-check { display: inline-flex; gap: var(--sp-2); align-items: center; }
    .rp-codigos { list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow: auto; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .rp-codigos > li + li { border-top: 1px solid var(--border-color); }
    .rp-codigos > li.rp-tenue { padding: var(--sp-3); }
    .rp-codigo { all: unset; display: block; width: 100%; box-sizing: border-box; padding: var(--sp-2) var(--sp-3); cursor: pointer; }
    .rp-codigo:hover { background: var(--overlay-hover); }
    .rp-codigo:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .rp-elegido { display: flex; align-items: center; gap: var(--sp-2); margin: 0; }
    .rp-error { color: var(--bad-fg); margin: var(--sp-2) 0 0; }
    @media (max-width: 48rem) { .rp-dos { grid-template-columns: 1fr; } .rp-buscar { margin-left: 0; width: 100%; } }
  `],
})
export class MktRankingPromosComponent {
  private readonly api = inject(MktRankingService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly perms = inject(PermissionsService);
  readonly tabs = PROMOS_TABS;
  readonly puedeGestionar = this.perms.has(Permission.MKT_AGREEMENTS_GESTIONAR);
  readonly suc = warehouseName;

  readonly busqueda = signal('');
  readonly trabajando = signal(false);
  /** [MKT.24] El proveedor del filtro: null = todos; 'sin' = las que nadie asignó. */
  readonly filtroProveedor = signal<string | null>(null);
  /** [MKT.24] La promo cuyo proveedor se está guardando (apaga su selector: un clic, una escritura). */
  readonly guardandoProveedor = signal<string | null>(null);
  readonly textoProveedor = textoProveedor;
  /** [MKT.24] Los ~1,000 proveedores activos, una vez (sólo a quien puede asignar). */
  private readonly resProv = rxResource({ stream: () => (this.puedeGestionar ? this.api.proveedores() : of([] as ProveedorPromo[])) });
  readonly proveedores = computed(() => (this.resProv.hasValue() ? this.resProv.value() : []).map((p) => ({ ...p, etiqueta: textoProveedor(p) })));

  readonly res = rxResource({ stream: () => this.api.promos(false) });
  readonly promos = computed<PromoMkt[] | undefined>(() => (this.res.hasValue() ? this.res.value() : undefined));
  /** [MKT.24] Sólo lo que Mercadotecnia ASIGNÓ es el valor del selector; lo derivado va de sugerencia. */
  asignado(p: PromoMkt): string | null { return p.proveedor_fuente === 'asignado' ? (p.proveedor?.id ?? null) : null; }
  sugerencia(p: PromoMkt): string { return p.proveedor_fuente === 'producto' ? 'Del producto: ' + textoProveedor(p.proveedor) : 'Sin proveedor'; }
  /** Cuándo se trajo la lista (los objetivos sugeridos y los capturados cambian con el uso). */
  readonly cargadoEn = computed(() => (this.promos() ? new Date() : null));
  readonly filas = computed(() => {
    const q = this.busqueda();
    const fp = this.filtroProveedor();
    return (this.promos() ?? []).filter((p) => delProveedor(p, fp) && coincideBusqueda(q, p.code, p.mecanica, p.descripcion_kepler,
      p.proveedor?.code ?? '', p.proveedor?.name ?? '', ...(p.productos?.productos ?? []).flatMap((x) => [x.sku, x.nombre ?? ''])));
  });
  /** [MKT.24] Los proveedores que tienen promos en la lista, con cuántas; «Sin proveedor asignado» al final. */
  readonly opcionesFiltroProveedor = computed(() => {
    const de = new Map<string, { label: string; value: string; n: number }>();
    let sin = 0;
    for (const p of this.promos() ?? []) {
      if (!p.proveedor) { sin++; continue; }
      const o = de.get(p.proveedor.id) ?? { label: textoProveedor(p.proveedor), value: p.proveedor.id, n: 0 };
      o.n++; de.set(p.proveedor.id, o);
    }
    const ops = [...de.values()].sort((a, b) => a.label.localeCompare(b.label, 'es')).map((o) => ({ label: `${o.label} (${o.n})`, value: o.value }));
    if (sin) ops.push({ label: `Sin proveedor asignado (${sin})`, value: SIN_PROVEEDOR });
    return ops;
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const ps = this.promos() ?? [];
    const fijo = ps.filter((p) => p.objetivos).length;
    const sinProv = ps.filter((p) => !p.proveedor).length;
    const delProducto = ps.filter((p) => p.proveedor_fuente === 'producto').length;
    return [
      { label: 'Promociones de Kepler', value: ps.length, format: 'number', sub: 'vendieron en 5 semanas' },
      // [MKT.24] Lo pendiente se cuenta y se abre: lleva a la lista ya filtrada.
      { label: 'Sin proveedor', value: sinProv, format: 'number',
        sub: (sinProv ? 'asígnalo en la columna Proveedor' : 'todas tienen proveedor') + (delProducto ? ` · ${delProducto} tomados del producto` : ''),
        ...(sinProv ? { drill: SIN_PROVEEDOR, drillLabel: 'Ver las promociones sin proveedor' } : {}) },
      { label: 'Con objetivo fijo', value: fijo, format: 'number' },
      { label: 'Con objetivo dinámico', value: ps.length - fijo, format: 'number', sub: 'se recalcula cada semana' },
    ];
  });

  // ── objetivos de una promo ──
  readonly abierta = signal<PromoMkt | null>(null);
  readonly canalPeek = signal<Canal>('mostrador');
  readonly cargandoObj = signal(false);
  readonly errorObj = signal<string | null>(null);
  private readonly objetivos = signal<Objetivo[]>([]);
  private readonly sugeridos = signal<Sugerido[]>([]);
  readonly filasObj = signal<FilaObjetivo[]>([]);
  readonly sucio = signal(false);
  readonly canalesPeek = computed<SegOption[]>(() => (this.abierta()?.canales ?? []).map((c) => ({ label: CANAL_CORTO[c], value: c })));

  readonly textoProductos = textoProductos;
  /** [MKT.15] El producto que activa la promo, por nombre (derivado de sus tickets). */
  nombresProducto(pr: ProductosDePromo): string[] {
    return pr.productos.map((x) => x.nombre ?? x.sku);
  }

  drill(id: string): void {
    if (id === SIN_PROVEEDOR) this.filtroProveedor.set(SIN_PROVEEDOR);
  }

  /**
   * [MKT.24] Guarda el proveedor de una promo en cuanto se elige. Mientras guarda, su selector se
   * apaga; si falla, vuelve al que tenía y se dice por qué.
   */
  async asignarProveedor(p: PromoMkt, supplierId: string | null): Promise<void> {
    if (this.asignado(p) === (supplierId ?? null) || this.guardandoProveedor()) return;
    this.guardandoProveedor.set(p.id);
    try {
      const r = await firstValueFrom(this.api.asignarProveedor(p.id, supplierId ?? null));
      this.toast.add({ severity: 'success', summary: r.proveedor ? 'Proveedor asignado' : 'Proveedor quitado', detail: `${p.mecanica}: ${textoProveedor(r.proveedor)}` });
      // Se relee: el id de una promo k-… cambia al recibir su renglón, y al quitarlo vuelve el del producto.
      this.res.reload();
    } catch (e: unknown) {
      // El selector ya muestra lo elegido: se relee la lista para que vuelva a decir lo guardado.
      this.res.reload();
      this.toast.add({ severity: 'error', summary: 'No se guardó el proveedor', detail: this.mensaje(e) });
    } finally {
      this.guardandoProveedor.set(null);
    }
  }

  canalesTexto(cs: Canal[]): string { return cs.length === 4 ? 'Todos' : cs.map((c) => CANAL_CORTO[c]).join(', '); }
  /** Dónde vendió (la semana o las 4 previas). */
  sucursalesTexto(p: PromoMkt): string {
    const w = p.warehouse_codes ?? [];
    return w.length >= SUCURSALES_VENTA.length ? 'Todas' : w.length <= 2 ? w.map((c) => warehouseName(c)).join(', ') : `${w.length} de 8`;
  }

  abrir(p: PromoMkt): void {
    this.abierta.set(p);
    this.canalPeek.set(p.canales[0] ?? 'mostrador');
    this.cargarObjetivos(p);
  }

  async cargarObjetivos(p: PromoMkt): Promise<void> {
    this.cargandoObj.set(true);
    this.errorObj.set(null);
    this.sucio.set(false);
    try {
      const [obj, sug] = await Promise.all([
        firstValueFrom(this.api.objetivos(p.id)),
        firstValueFrom(this.api.sugerir(null, false).pipe(catchError(() => of({ sugeridos: [] as Sugerido[] })))),
      ]);
      this.objetivos.set(obj);
      this.sugeridos.set(sug.sugeridos.filter((s) => s.promo_id === p.id));
      this.recalcularFilas();
    } catch {
      this.errorObj.set('No se pudieron cargar los objetivos.');
    } finally {
      this.cargandoObj.set(false);
    }
  }

  private recalcularFilas(): void {
    const p = this.abierta();
    if (!p) return;
    this.filasObj.set(armarFilas(this.canalPeek(), p.warehouse_codes ?? SUCURSALES_VENTA, this.objetivos(), this.sugeridos()));
  }

  elegirCanalPeek(c: Canal): void {
    const cambiar = () => { this.canalPeek.set(c); this.sucio.set(false); this.recalcularFilas(); };
    if (this.sucio()) this.confirmarDescartar(cambiar); else cambiar();
  }

  marcarSucio(): void { this.sucio.set(true); }

  async guardarObjetivos(p: PromoMkt): Promise<void> {
    const items = cambios(this.canalPeek(), this.filasObj());
    if (!items.length) { this.sucio.set(false); return; }
    this.trabajando.set(true);
    try {
      const r = await firstValueFrom(this.api.guardarObjetivos(p.id, items));
      this.toast.add({ severity: 'success', summary: 'Objetivos guardados', detail: `${r.guardados} guardados${r.quitados ? ` · ${r.quitados} quitados` : ''}` });
      this.sucio.set(false);
      this.res.reload();
      await this.cargarObjetivos(p);
    } catch (e: unknown) {
      this.toast.add({ severity: 'error', summary: 'No se guardaron', detail: this.mensaje(e) });
    } finally {
      this.trabajando.set(false);
    }
  }

  cerrarPeek(): void {
    if (this.sucio()) this.confirmarDescartar(() => { this.sucio.set(false); this.abierta.set(null); });
    else this.abierta.set(null);
  }

  private confirmarDescartar(seguir: () => void): void {
    this.confirm.confirm({
      header: 'Hay objetivos sin guardar',
      message: 'Si sigues, se pierden los cambios que escribiste.',
      acceptLabel: 'Descartar cambios', rejectLabel: 'Seguir editando',
      acceptButtonStyleClass: 'p-button-danger', accept: seguir,
    });
  }

  private mensaje(e: unknown): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    return Array.isArray(m) ? m.join(' · ') : m || 'Intenta de nuevo.';
  }
}
