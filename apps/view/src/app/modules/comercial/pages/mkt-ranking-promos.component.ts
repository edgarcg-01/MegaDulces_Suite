import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom, switchMap, of, catchError } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
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
  CANALES, CANAL_CORTO, Canal, CodigoKepler, MktRankingService, Objetivo, PromoMkt, Sugerido,
} from '../mkt-ranking.service';

/** Las 8 sucursales que venden (la 00 es oficinas). */
export const SUCURSALES_VENTA = ['01', '02', '03', '04', '05', '06', '07', '08'];

/** Estado de una promo en la lista, en palabras. */
export function estadoPromo(p: Pick<PromoMkt, 'activo' | 'vigencia_desde' | 'vigencia_hasta'>, hoy: string): 'activa' | 'programada' | 'vencida' | 'inactiva' {
  if (!p.activo) return 'inactiva';
  if (p.vigencia_hasta && p.vigencia_hasta < hoy) return 'vencida';
  if (p.vigencia_desde > hoy) return 'programada';
  return 'activa';
}

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
    .filter((f) => (f.valor ?? null) !== (f.guardado ?? null) || (f.valor !== null && f.fuente === 'sugerido' && f.valor !== f.sugerido))
    .map((f) => ({
      warehouse_code: f.warehouse_code, canal, vendor_code: f.vendor_code,
      objetivo_semanal: f.valor && f.valor > 0 ? f.valor : null,
      fuente: f.valor !== null && f.valor === f.sugerido && f.guardado === null ? 'sugerido' : 'manual',
    }));
}

/** El último día de una promo que se da de baja hoy: ayer. */
export const bajaHasta = (hoy: string) => new Date(Date.parse(`${hoy}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const ymd = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);
const aFecha = (s: string | null) => (s ? new Date(`${s}T12:00:00`) : null);

interface Formulario {
  id: string | null;
  code: string;
  descripcion_kepler: string | null;
  mecanica: string;
  desde: Date | null;
  hasta: Date | null;
  canales: Canal[];
  sucursales: string[];
  notas: string;
}

/**
 * `[MKT.11]` **Objetivos** — qué promociones mide el ranking y contra qué objetivo.
 *
 * Propósito: dar de alta una promoción (Kepler no guarda su vigencia y reutiliza códigos) y fijar
 * su objetivo semanal por sucursal o vendedor. El sistema SUGIERE (promedio de las 4 semanas
 * anteriores) y la persona decide; lo sugerido se marca como tal. «Sugerir los que faltan» nunca
 * pisa un objetivo capturado.
 *
 * Jerarquía: primario = qué promos están vigentes y cuántas NO tienen objetivo; secundario =
 * vigencia y canales; terciario = código y quién capturó.
 */
@Component({
  selector: 'app-mkt-ranking-promos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, InputTextModule, InputNumberModule, DialogModule,
    DatePickerModule, MultiSelectModule, CheckboxModule, TextareaModule, ToastModule, ConfirmDialogModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rp">
      <p-toast></p-toast>
      <p-confirmDialog></p-confirmDialog>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Objetivos del ranking <app-context-help topic="mkt-ranking" /></h1>
          <p class="surf-page-sub">Qué promociones se miden y contra qué objetivo semanal.</p>
        </div>
        <div class="rp-cabeza-der">
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="900"></app-freshness-pill>
        @if (puedeGestionar) {
          <div class="rp-acciones">
            <button pButton type="button" class="p-button-sm p-button-outlined" (click)="sugerirFaltantes()" [disabled]="trabajando()">
              <span class="p-button-icon p-button-icon-left pi pi-sparkles" aria-hidden="true"></span><span class="p-button-label">Sugerir los que faltan</span></button>
            <button pButton type="button" class="p-button-sm" (click)="nueva()" [disabled]="trabajando()">
              <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Dar de alta</span></button>
          </div>
        }
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" />

      <div class="rp-filtros">
        <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué promociones ver"></app-segmented>
        <input pInputText type="search" class="rp-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Código o promoción" aria-label="Buscar promoción" />
      </div>

      @if (promos(); as ps) {
        <app-metric-strip [items]="kpis()" ariaLabel="Promociones del ranking"></app-metric-strip>
      }

      <app-load-state [loading]="res.isLoading() && !promos()" [error]="res.error() ? 'No se pudieron cargar las promociones.' : null"
                      [isEmpty]="!!promos() && !filas().length" emptyIcon="pi-megaphone"
                      [emptyTitle]="(promos()?.length ?? 0) ? 'Nada coincide' : 'Todavía no hay promociones dadas de alta'"
                      [emptyHint]="(promos()?.length ?? 0) ? 'Prueba otra búsqueda o mira todas.' : 'Da de alta las promociones de la semana: eliges el código de Kepler, su vigencia y en qué canales cuenta.'"
                      [emptyCta]="puedeGestionar && !(promos()?.length ?? 0) ? 'Dar de alta' : null" (cta)="nueva()" (retry)="res.reload()">
        <p-table [value]="filas()" dataKey="id" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Promoción</th>
              <th>Vigencia</th>
              <th>Canales</th>
              <th>Sucursales</th>
              <th class="comm-num">Objetivos</th>
              <th>Estado</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p" [attr.aria-label]="'Objetivos de ' + p.mecanica">
              <td data-label="Promoción">
                <span class="rp-nombre">{{ p.mecanica }}</span>
                <span class="rp-tenue">{{ p.code }}@if (p.descripcion_kepler && p.descripcion_kepler !== p.mecanica) { · Kepler: {{ p.descripcion_kepler }} }</span>
              </td>
              <td class="rp-nowrap" data-label="Vigencia">{{ fecha(p.vigencia_desde) }} → {{ p.vigencia_hasta ? fecha(p.vigencia_hasta) : 'hasta agotar' }}</td>
              <td data-label="Canales">{{ canalesTexto(p.canales) }}</td>
              <td data-label="Sucursales">{{ p.warehouse_codes ? p.warehouse_codes.length + ' de 8' : 'Todas' }}</td>
              <td class="comm-num" data-label="Objetivos">
                @if (p.objetivos) { {{ p.objetivos }} } @else { <p-tag value="Sin objetivos" severity="warn"></p-tag> }
              </td>
              <td data-label="Estado"><p-tag [value]="estadoTexto(p)" [severity]="estadoSev(p)"></p-tag></td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <!-- Objetivos de una promoción -->
      <app-side-peek [open]="!!abierta()" (openChange)="$event ? null : cerrarPeek()" [width]="720"
                     [title]="abierta()?.mecanica ?? ''" [subtitle]="abierta() ? abierta()!.code + ' · ' + (abierta()!.vigencia_hasta ? 'hasta ' + fecha(abierta()!.vigencia_hasta!) : 'hasta agotar') : null">
        @if (abierta(); as p) {
          @if (p.canales.length > 1) {
            <app-segmented [options]="canalesPeek()" [value]="canalPeek()" (valueChange)="elegirCanalPeek($any($event))" ariaLabel="Canal"></app-segmented>
          }
          <p class="rp-ayuda">Objetivo semanal: cuántas veces se debe aplicar la promoción de lunes a domingo.
            El sugerido es el promedio de las últimas 4 semanas{{ canalPeek() === 'mostrador' ? '' : ' de cada vendedor' }}. Vacío = sin objetivo (no cuenta para el lugar, no es cero).</p>
          <app-load-state [loading]="cargandoObj()" [error]="errorObj()" [isEmpty]="!cargandoObj() && !errorObj() && !filasObj().length"
                          emptyIcon="pi-users" emptyTitle="Nadie vendió esta promoción en este canal"
                          emptyHint="Cuando un vendedor la venda aparecerá aquí con su sugerido." (retry)="cargarObjetivos(p)">
            <p-table [value]="filasObj()" size="small" class="surf-table surf-table--plain">
              <ng-template #header>
                <tr>
                  <th>{{ canalPeek() === 'mostrador' ? 'Sucursal' : 'Vendedor' }}</th>
                  <th class="comm-num">Sugerido</th>
                  <th class="comm-num">Objetivo semanal</th>
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
                    <p-inputNumber [(ngModel)]="f.valor" (ngModelChange)="marcarSucio()" [min]="0" [max]="1000000" [maxFractionDigits]="0"
                                   [disabled]="!puedeGestionar" [inputStyle]="{ width: '6rem', 'text-align': 'right' }"
                                   [ariaLabel]="'Objetivo de ' + f.nombre" placeholder="—"></p-inputNumber>
                    @if (f.fuente === 'sugerido' && f.valor === f.guardado) { <span class="rp-tenue">sugerido</span> }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </app-load-state>
          @if (puedeGestionar) {
            <div class="rp-peek-acciones">
              <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="darDeBaja(p)" [disabled]="trabajando()">
                <span class="p-button-label">Dar de baja</span></button>
              <span class="rp-espacio"></span>
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="editar(p)" [disabled]="trabajando()">
                <span class="p-button-label">Editar promoción</span></button>
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="usarSugeridos()" [disabled]="trabajando() || !hayHuecosConSugerido()">
                <span class="p-button-label">Llenar vacíos con el sugerido</span></button>
              <button pButton type="button" class="p-button-sm" (click)="guardarObjetivos(p)" [disabled]="trabajando() || !sucio()" [loading]="trabajando()">
                <span class="p-button-label">Guardar objetivos</span></button>
            </div>
          }
        }
      </app-side-peek>

      <!-- Alta / edición -->
      <p-dialog [visible]="!!form()" (visibleChange)="$event ? null : form.set(null)" [modal]="true" [style]="{ width: 'min(44rem, 96vw)' }"
                [header]="form()?.id ? 'Editar promoción' : 'Dar de alta una promoción'" [draggable]="false">
        @if (form(); as f) {
          <div class="rp-form">
            @if (!f.id) {
              <label class="rp-campo" for="rp-buscar-codigo">Código de la promoción en Kepler</label>
              <input id="rp-buscar-codigo" pInputText type="search" [ngModel]="buscarCodigo()" (ngModelChange)="buscarCodigo.set($event); buscar$.next($event)"
                     placeholder="Código o parte del nombre («leche», «09066»)" autocomplete="off" />
              @if (!f.code) {
                <ul class="rp-codigos" role="listbox" aria-label="Códigos de promoción de Kepler">
                  @for (c of codigos(); track c.code) {
                    <li>
                      <button type="button" class="rp-codigo" role="option" [attr.aria-selected]="false" (click)="elegirCodigo(c)">
                        <span class="rp-nombre">{{ c.code }} · {{ c.descripcion }}</span>
                        <span class="rp-tenue">
                          {{ c.ultima_venta ? 'Última venta ' + fecha(c.ultima_venta) : 'Sin venta en 60 días' }} · en {{ c.sucursales.length }} sucursales
                          @if (c.ya_registrada) { · ya está dada de alta }
                        </span>
                      </button>
                    </li>
                  } @empty {
                    <li class="rp-tenue">{{ buscarCodigo() ? 'Ningún código de promoción coincide.' : 'Escribe para buscar.' }}</li>
                  }
                </ul>
              } @else {
                <p class="rp-elegido"><strong>{{ f.code }}</strong> · {{ f.descripcion_kepler }}
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarCodigo()"><span class="p-button-label">Cambiar</span></button></p>
              }
            }
            @if (f.code) {
              <label class="rp-campo" for="rp-mecanica">Cómo se llama en el ranking</label>
              <textarea id="rp-mecanica" pTextarea rows="2" [(ngModel)]="f.mecanica" maxlength="500"></textarea>
              <div class="rp-dos">
                <div>
                  <label class="rp-campo" for="rp-desde">Empieza</label>
                  <p-datepicker inputId="rp-desde" [(ngModel)]="f.desde" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"></p-datepicker>
                </div>
                <div>
                  <label class="rp-campo" for="rp-hasta">Termina <span class="rp-tenue-i">(vacío = hasta agotar)</span></label>
                  <p-datepicker inputId="rp-hasta" [(ngModel)]="f.hasta" dateFormat="dd/mm/yy" [showIcon]="true" [showClear]="true" [minDate]="f.desde" appendTo="body"></p-datepicker>
                </div>
              </div>
              <span class="rp-campo" id="rp-canales-l">En qué canales cuenta</span>
              <div class="rp-canales" role="group" aria-labelledby="rp-canales-l">
                @for (c of todosCanales; track c) {
                  <label class="rp-check"><p-checkbox [inputId]="'rp-c-' + c" [value]="c" [(ngModel)]="f.canales"></p-checkbox><span>{{ canalCorto(c) }}</span></label>
                }
              </div>
              <label class="rp-campo" for="rp-sucs">Sucursales <span class="rp-tenue-i">(vacío = todas)</span></label>
              <p-multiSelect inputId="rp-sucs" [options]="opcionesSucursal" optionLabel="label" optionValue="value" [(ngModel)]="f.sucursales"
                             placeholder="Todas las sucursales" display="chip" appendTo="body" [showToggleAll]="true"></p-multiSelect>
              @if (errorForm()) { <p class="rp-error" role="alert">{{ errorForm() }}</p> }
            }
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="form.set(null)"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" (click)="guardarPromo()" [disabled]="trabajando() || !form()?.code" [loading]="trabajando()">
            <span class="p-button-label">{{ form()?.id ? 'Guardar cambios' : 'Dar de alta' }}</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rp-cabeza-der { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
    .rp-acciones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rp-filtros { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: var(--sp-4) 0 var(--sp-3); }
    .rp-buscar { min-width: 14rem; margin-left: auto; }
    .rp-nombre { display: block; font-weight: var(--fw-medium); }
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
  readonly todosCanales = CANALES;
  readonly opcionesSucursal = SUCURSALES_VENTA.map((c) => ({ label: warehouseName(c), value: c }));
  readonly suc = warehouseName;

  readonly vista = signal<'vigentes' | 'todas'>('vigentes');
  readonly busqueda = signal('');
  readonly trabajando = signal(false);
  private readonly hoy = hoyMx();

  readonly res = rxResource({
    params: () => this.vista(),
    stream: ({ params }) => this.api.promos(params === 'todas'),
  });
  readonly promos = computed<PromoMkt[] | undefined>(() => (this.res.hasValue() ? this.res.value() : undefined));
  /** Cuándo se trajo la lista (los objetivos sugeridos y los capturados cambian con el uso). */
  readonly cargadoEn = computed(() => (this.promos() ? new Date() : null));
  readonly filas = computed(() => {
    const q = this.busqueda();
    return (this.promos() ?? []).filter((p) => coincideBusqueda(q, p.code, p.mecanica, p.descripcion_kepler));
  });
  readonly vistas = computed<SegOption[]>(() => [{ label: 'Vigentes', value: 'vigentes' }, { label: 'Todas', value: 'todas' }]);
  readonly kpis = computed<MetricStripItem[]>(() => {
    const ps = (this.promos() ?? []).filter((p) => estadoPromo(p, this.hoy) === 'activa');
    const sin = ps.filter((p) => !p.objetivos).length;
    return [
      { label: 'Promociones activas', value: ps.length, format: 'number' },
      { label: 'Sin objetivos', value: sin, format: 'number', tone: sin ? 'warn' : 'ok', sub: sin ? 'no entran al ranking' : 'todas se miden' },
      { label: 'Sin fecha de fin', value: ps.filter((p) => !p.vigencia_hasta).length, format: 'number', sub: 'hasta agotar' },
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
  readonly hayHuecosConSugerido = computed(() => this.filasObj().some((f) => f.valor === null && f.sugerido !== null));

  // ── alta ──
  readonly form = signal<Formulario | null>(null);
  readonly errorForm = signal<string | null>(null);
  readonly buscarCodigo = signal('');
  readonly buscar$ = new Subject<string>();
  readonly codigos = toSignal(
    this.buscar$.pipe(debounceTime(250), distinctUntilChanged(), switchMap((q) => this.api.codigosKepler(q).pipe(catchError(() => of([] as CodigoKepler[]))))),
    { initialValue: [] as CodigoKepler[] },
  );

  fecha(s: string): string {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${s}T00:00:00Z`)).replace('.', '');
  }
  canalCorto(c: Canal): string { return CANAL_CORTO[c]; }
  canalesTexto(cs: Canal[]): string { return cs.length === 4 ? 'Todos' : cs.map((c) => CANAL_CORTO[c]).join(', '); }
  estadoTexto(p: PromoMkt): string {
    return { activa: 'Activa', programada: 'Programada', vencida: 'Vencida', inactiva: 'Dada de baja' }[estadoPromo(p, this.hoy)];
  }
  estadoSev(p: PromoMkt): 'success' | 'info' | 'secondary' | 'warn' {
    return ({ activa: 'success', programada: 'info', vencida: 'secondary', inactiva: 'secondary' } as const)[estadoPromo(p, this.hoy)];
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

  usarSugeridos(): void {
    this.filasObj.update((fs) => fs.map((f) => (f.valor === null && f.sugerido !== null ? { ...f, valor: f.sugerido } : f)));
    this.sucio.set(true);
  }

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

  sugerirFaltantes(): void {
    this.confirm.confirm({
      header: 'Sugerir los objetivos que faltan',
      message: 'Se guarda el promedio de las últimas 4 semanas donde NO hay objetivo. Los que ya capturaste no se tocan. Después puedes ajustarlos.',
      acceptLabel: 'Sugerir', rejectLabel: 'Cancelar',
      accept: async () => {
        this.trabajando.set(true);
        try {
          const r = await firstValueFrom(this.api.sugerir(null, true));
          const sinHistoria = r.sugeridos.filter((s) => s.sugerido === null).length;
          this.toast.add({ severity: 'success', summary: `${r.aplicados} objetivos sugeridos`,
            detail: sinHistoria ? `${sinHistoria} sin historia: captúralos a mano.` : 'Revísalos en cada promoción.' });
          this.res.reload();
        } catch (e: unknown) {
          this.toast.add({ severity: 'error', summary: 'No se pudo sugerir', detail: this.mensaje(e) });
        } finally {
          this.trabajando.set(false);
        }
      },
    });
  }

  nueva(): void {
    this.errorForm.set(null);
    this.buscarCodigo.set('');
    this.buscar$.next('');
    this.form.set({ id: null, code: '', descripcion_kepler: null, mecanica: '', desde: aFecha(this.hoy), hasta: null, canales: ['mostrador'], sucursales: [], notas: '' });
  }

  editar(p: PromoMkt): void {
    this.errorForm.set(null);
    this.form.set({
      id: p.id, code: p.code, descripcion_kepler: p.descripcion_kepler, mecanica: p.mecanica,
      desde: aFecha(p.vigencia_desde), hasta: aFecha(p.vigencia_hasta), canales: [...p.canales], sucursales: p.warehouse_codes ?? [], notas: p.notas ?? '',
    });
  }

  elegirCodigo(c: CodigoKepler): void {
    const f = this.form();
    if (!f) return;
    if (c.ya_registrada) {
      this.toast.add({ severity: 'warn', summary: 'Ya está dada de alta', detail: 'Ese código ya tiene una promoción vigente. Si Kepler lo reutilizó para otra, da de baja la anterior primero.' });
    }
    this.form.set({ ...f, code: c.code, descripcion_kepler: c.descripcion, mecanica: c.descripcion });
  }

  cambiarCodigo(): void {
    const f = this.form();
    if (f) this.form.set({ ...f, code: '', descripcion_kepler: null });
  }

  async guardarPromo(): Promise<void> {
    const f = this.form();
    if (!f || this.trabajando()) return;
    if (!f.mecanica.trim()) { this.errorForm.set('Escribe cómo se llama la promoción.'); return; }
    if (!f.desde) { this.errorForm.set('Elige cuándo empieza.'); return; }
    if (!f.canales.length) { this.errorForm.set('Elige al menos un canal.'); return; }
    if (f.hasta && f.hasta < f.desde) { this.errorForm.set('La fecha de fin es anterior a la de inicio.'); return; }
    this.trabajando.set(true);
    this.errorForm.set(null);
    const dto = {
      mecanica: f.mecanica.trim(), vigencia_desde: ymd(f.desde)!, vigencia_hasta: ymd(f.hasta),
      canales: f.canales, warehouse_codes: f.sucursales.length && f.sucursales.length < SUCURSALES_VENTA.length ? f.sucursales : null,
    };
    try {
      const p = f.id
        ? await firstValueFrom(this.api.editarPromo(f.id, dto))
        : await firstValueFrom(this.api.crearPromo({ ...dto, code: f.code, descripcion_kepler: f.descripcion_kepler }));
      this.form.set(null);
      this.toast.add({ severity: 'success', summary: f.id ? 'Promoción actualizada' : 'Promoción dada de alta', detail: f.id ? undefined : 'Ahora fija sus objetivos.' });
      this.res.reload();
      this.abrir(p);
    } catch (e: unknown) {
      this.errorForm.set(this.mensaje(e));
    } finally {
      this.trabajando.set(false);
    }
  }

  /**
   * Dar de baja = TERMINAR la promo ayer: deja de contar desde hoy y las semanas pasadas se siguen
   * midiendo igual. Borrarla la quitaría también del pasado; eso sólo se hace con una promo que
   * todavía no empezaba (no hay pasado que conservar).
   */
  darDeBaja(p: PromoMkt): void {
    const ayer = bajaHasta(this.hoy);
    const borrar = p.vigencia_desde > ayer;
    this.confirm.confirm({
      header: 'Dar de baja la promoción',
      message: borrar
        ? `«${p.mecanica}» empieza hoy o después: no tiene semanas pasadas y se quita del ranking.`
        : `«${p.mecanica}» termina ayer y deja de contar desde hoy. Las semanas pasadas no cambian.`,
      acceptLabel: 'Dar de baja', rejectLabel: 'Cancelar', acceptButtonStyleClass: 'p-button-danger',
      accept: async () => {
        this.trabajando.set(true);
        try {
          if (borrar) await firstValueFrom(this.api.borrarPromo(p.id));
          else await firstValueFrom(this.api.editarPromo(p.id, { vigencia_hasta: ayer }));
          this.abierta.set(null);
          this.sucio.set(false);
          this.toast.add({ severity: 'success', summary: 'Promoción dada de baja' });
          this.res.reload();
        } catch (e: unknown) {
          this.toast.add({ severity: 'error', summary: 'No se pudo dar de baja', detail: this.mensaje(e) });
        } finally {
          this.trabajando.set(false);
        }
      },
    });
  }

  private mensaje(e: unknown): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    return Array.isArray(m) ? m.join(' · ') : m || 'Intenta de nuevo.';
  }
}
