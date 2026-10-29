import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule, type TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  ETIQUETA_UNIDAD_IMPORTE, MOTIVOS_RESOLUCION_MOVIMIENTO, validarResolucion,
  type DetalleIncidenciaMovimiento, type EstadoRenglonMovimiento, type ExcepcionMovimiento, type ExcepcionMovimientoItem,
  type MotivoResolucion, type MovimientosExcepcionesResponse, type RenglonComparado,
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

const ETIQUETA: Record<ExcepcionMovimiento, string> = {
  diferencia: 'Diferencia', sin_acuse: 'Sin acuse', sin_origen: 'Sin origen',
  ajuste_inventario: 'Ajuste', importe_incompleto: 'Importe incompleto',
};
const SEVERIDAD: Record<ExcepcionMovimiento, 'danger' | 'warn' | 'info' | 'secondary'> = {
  diferencia: 'danger', sin_acuse: 'danger', sin_origen: 'warn', ajuste_inventario: 'info', importe_incompleto: 'secondary',
};
const ESTADO_RENGLON: Record<EstadoRenglonMovimiento, string> = {
  cuadra: 'Cuadra', falta: 'Falta', sobra: 'Sobra', no_llego: 'No llegó', no_venia: 'No venía',
  pendiente: 'Sin recibir', sin_respaldo: 'Sin salida', ajustado: 'Ajustado',
};
const ETIQUETA_MOTIVO = new Map(MOTIVOS_RESOLUCION_MOVIMIENTO.map((m) => [m.codigo, m.etiqueta]));

/**
 * `[MX.3.2]` **Incidencias de movimientos** — sólo lo que el motor no pudo dar por bueno.
 *
 * Hoy se audita a mano el Diario entero: el 90.7 % de las marcas «auditado» cayó en documentos que el
 * motor ya cuadraba (MX.0.1). Aquí llega el 3 % que no: diferencias, salidas a un almacén sin acuse
 * después de 15 días, recepciones sin origen, ajustes de inventario e importes incompletos. Lo que
 * cuadra sigue en el Diario (reportería).
 *
 * `[MX.2.4]` Cada fila dice DÓNDE está el error (el producto y las piezas, no sólo el total), y se
 * revisa y resuelve con su motivo en el panel lateral, sin salir de la pantalla (una sola interfaz por
 * flujo, Edgar 2026-10-28). El Diario queda como consulta del documento completo.
 *
 * Jerarquía: primario = cuántas incidencias y de qué tipo (franja) y, en cada fila, dónde está el
 * error; secundario = su dinero y su antigüedad; terciario = folios, piezas y la unidad del importe.
 */
@Component({
  selector: 'app-almacen-incidencias',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, DatePickerModule, SelectModule, TextareaModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast></p-toast>
    <div class="surf-page in inc-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="inc-h1">Incidencias de movimientos <app-context-help topic="almacen-incidencias" /></h1>
          <p class="surf-page-sub">Sólo lo que el motor no pudo dar por bueno. Lo que cuadra está en el Diario de movimientos.</p>
        </div>
        <app-freshness-pill measures="fetch" [since]="cargadoEn()" [staleAfterSec]="600"></app-freshness-pill>
      </header>

      <div class="inc-filtros">
        <p-datepicker [(ngModel)]="desde" (onSelect)="recargar()" dateFormat="yy-mm-dd" placeholder="Desde" [showIcon]="true" appendTo="body"
                      inputId="inc-desde" ariaLabel="Desde"></p-datepicker>
        <p-datepicker [(ngModel)]="hasta" (onSelect)="recargar()" dateFormat="yy-mm-dd" placeholder="Hasta" [showIcon]="true" appendTo="body"
                      inputId="inc-hasta" ariaLabel="Hasta"></p-datepicker>
        <app-segmented [options]="tipos()" [value]="tipo()" (valueChange)="elegirTipo($event)" ariaLabel="Tipo de incidencia"></app-segmented>
      </div>

      @if (resp()?.capped) {
        <div class="inc-banda" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <span>El pareo llegó a su tope de 50,000 filas: la bandeja está incompleta. Acota el rango de fechas.</span>
        </div>
      }

      @if (resp(); as r) {
        <app-metric-strip [items]="kpis()" ariaLabel="Incidencias del rango"></app-metric-strip>
        <p class="inc-unidad">{{ unidadResumen() }}</p>
      }

      <app-load-state class="dt-scope" [loading]="cargando() && !resp()" [error]="error()" [isEmpty]="!!resp() && !filas().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="recargar()">
        <p-table [value]="filas()" [lazy]="true" (onLazyLoad)="paginar($event)" [paginator]="total() > tam" [rows]="tam"
                 [totalRecords]="total()" [first]="(pagina() - 1) * tam" [loading]="cargando()"
                 selectionMode="single" dataKey="clave" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack"
                 [rowHover]="true" (onRowSelect)="revisar($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Incidencia y dónde está el error</th>
              <th>Fecha</th>
              <th class="comm-num">Días</th>
              <th>Origen</th>
              <th>Destino</th>
              <th class="comm-num">Piezas</th>
              <th class="comm-num">Importe</th>
              <th><span class="inc-oculto">Acción</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr [pSelectableRow]="f">
              <td class="dt-id inc-cel-donde" data-label="Incidencia" role="cell">
                <div class="inc-tags">
                  @for (e of f.excepciones; track e) {
                    <p-tag [value]="etiqueta(e)" [severity]="severidad(e)" styleClass="inc-tag"></p-tag>
                  }
                  <span class="inc-tipo">{{ f.tipo === 'ajuste' ? 'Ajuste de inventario' : 'Traspaso' }}</span>
                </div>
                <span class="inc-donde">{{ f.donde || 'Sin detalle por producto' }}</span>
                @if (f.resolucion?.motivo) {
                  <span class="inc-resuelta"><i class="pi pi-check" aria-hidden="true"></i> {{ motivo(f.resolucion.motivo) }}</span>
                }
              </td>
              <td data-label="Fecha" role="cell" [attr.aria-label]="'Fecha ' + f.fecha">{{ f.fecha }}</td>
              <td class="comm-num dt-num" data-label="Días" role="cell" [attr.aria-label]="f.dias + ' días'">{{ f.dias | number }}</td>
              <td data-label="Origen" role="cell">
                <span class="inc-alm">{{ f.origen.nombre || 'Almacén sin nombre' }}</span>
                <span class="inc-folio">{{ f.origen.folio || '—' }}</span>
              </td>
              <td data-label="Destino" role="cell">
                @if (f.destino) {
                  <span class="inc-alm">{{ f.destino.nombre || 'Sin destino resuelto' }}</span>
                  <span class="inc-folio">{{ f.destino.folio || 'sin recepción' }}</span>
                } @else { <span class="inc-tenue">—</span> }
              </td>
              <td class="comm-num dt-num" data-label="Piezas" role="cell">
                @if (f.tipo === 'traspaso') {
                  <span>{{ f.piezas_enviadas != null ? (f.piezas_enviadas | number:'1.0-2') : '—' }} → {{ f.piezas_recibidas != null ? (f.piezas_recibidas | number:'1.0-2') : '—' }}</span>
                  @if (f.delta_piezas) { <span class="inc-delta">Δ {{ f.delta_piezas > 0 ? '+' : '' }}{{ f.delta_piezas | number:'1.0-2' }}</span> }
                } @else {
                  <span>{{ f.delta_piezas > 0 ? '+' : '' }}{{ f.delta_piezas | number:'1.0-2' }}</span>
                }
              </td>
              <td class="comm-num dt-num" data-label="Importe" role="cell">
                <span class="inc-imp">{{ f.importe != null ? dinero(f.importe) : '—' }}</span>
                <span class="inc-tenue">{{ unidad(f) }}</span>
                @if (f.lineas_sin_importe) { <span class="inc-tenue">+{{ f.lineas_sin_importe }} sin costo</span> }
              </td>
              <td class="dt-actions" data-label="Acción" role="cell">
                <button pButton type="button" class="p-button-sm p-button-text" (click)="$event.stopPropagation(); revisar(f)"
                        [attr.aria-label]="'Revisar ' + f.documento.folio">
                  <span class="p-button-label">Revisar</span>
                </button>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <app-side-peek [open]="!!abierta()" (openChange)="$event ? null : cerrar()" [width]="680"
                   [title]="tituloPeek()" [subtitle]="subtituloPeek()">
      <div class="dt-scope">
        <app-load-state [loading]="cargandoDetalle()" [error]="errorDetalle()" [isEmpty]="false" [skeletonRows]="5" (retry)="cargarDetalle()">
          @if (detalle(); as d) {
            <section class="inc-peek-donde" aria-labelledby="inc-donde-h">
              <h3 id="inc-donde-h" class="inc-peek-h">Dónde está el error</h3>
              <p class="inc-peek-frase">{{ d.donde || 'El motor no encontró un producto que explique la incidencia.' }}</p>
              @if (d.contraparte) {
                <p class="inc-peek-meta">Comparado contra {{ d.contraparte.doc_code === 'TrsfRcv' ? 'la recepción' : 'la salida' }}
                  {{ d.contraparte.folio }} de {{ d.contraparte.nombre || 'un almacén sin nombre' }} ({{ d.contraparte.fecha }}).</p>
              } @else if (d.documento.doc_code === 'TrsfShip') {
                <p class="inc-peek-meta">No hay recepción registrada{{ d.destino ? ' en ' + d.destino : '' }}.</p>
              }
            </section>

            <p-table [value]="renglonesVisibles()" size="small" class="surf-table surf-table--plain dt-stack inc-peek-tabla">
              <ng-template #header>
                <tr>
                  <th>Producto</th>
                  @if (esAjuste()) {
                    <th class="comm-num">Piezas</th>
                    <th class="comm-num">Importe</th>
                  } @else {
                    <th class="comm-num">Salió</th>
                    <th class="comm-num">Llegó</th>
                    <th class="comm-num">Diferencia</th>
                  }
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr>
                  <td class="dt-id" data-label="Producto" role="cell">
                    <span class="inc-alm">{{ r.producto }}</span>
                    <span class="inc-folio">{{ r.sku }} · {{ estadoRenglon(r.estado) }}@if (r.sin_costo) { · sin costo en Kepler }</span>
                  </td>
                  @if (esAjuste()) {
                    <td class="comm-num dt-num" data-label="Piezas" role="cell">{{ r.delta > 0 ? '+' : '' }}{{ r.delta | number:'1.0-2' }}</td>
                    <td class="comm-num dt-num" data-label="Importe" role="cell">{{ r.importe != null ? dinero(r.importe) : '—' }}</td>
                  } @else {
                    <td class="comm-num dt-num" data-label="Salió" role="cell">{{ r.salida != null ? (r.salida | number:'1.0-2') : '—' }}</td>
                    <td class="comm-num dt-num" data-label="Llegó" role="cell">{{ r.recepcion != null ? (r.recepcion | number:'1.0-2') : '—' }}</td>
                    <td class="comm-num dt-num" data-label="Diferencia" role="cell">
                      @if (r.delta) {
                        <span class="inc-delta-fuerte">{{ r.delta > 0 ? '+' : '' }}{{ r.delta | number:'1.0-2' }}</span>
                        <span class="inc-tenue">{{ r.importe_diferencia != null ? dinero(r.importe_diferencia) : 'sin valuar' }}</span>
                      } @else { <span class="inc-tenue">—</span> }
                    </td>
                  }
                </tr>
              </ng-template>
            </p-table>
            @if (renglonesCuadran() > 0) {
              <button pButton type="button" class="p-button-sm p-button-text inc-ver-todos" (click)="verTodos.set(!verTodos())">
                <span class="p-button-label">{{ verTodos() ? 'Ocultar' : 'Ver' }} los {{ renglonesCuadran() }} productos que cuadran</span>
              </button>
            }

            <section class="inc-peek-resolver" aria-labelledby="inc-res-h">
              <h3 id="inc-res-h" class="inc-peek-h">Resolución</h3>
              @if (d.resolucion?.motivo) {
                <p class="inc-peek-frase">{{ motivo(d.resolucion!.motivo) }}</p>
                @if (d.resolucion!.nota) { <p class="inc-peek-nota">«{{ d.resolucion!.nota }}»</p> }
                <p class="inc-peek-meta">{{ d.resolucion!.por || 'Alguien' }} · {{ d.resolucion!.fecha }}</p>
                @if (puedeResolver) {
                  <button pButton type="button" class="p-button-sm p-button-outlined" [disabled]="guardando()" (click)="reabrir()">
                    <span class="p-button-label">Reabrir</span>
                  </button>
                }
              } @else {
                @if (d.resolucion) {
                  <p class="inc-peek-meta">Marcada como auditada en el Diario por {{ d.resolucion.por || 'alguien' }} ({{ d.resolucion.fecha }}), sin motivo: sigue pendiente.</p>
                }
                @if (puedeResolver) {
                  <div class="inc-form">
                    <label for="inc-motivo" class="inc-label">Motivo</label>
                    <p-select inputId="inc-motivo" [options]="d.motivos" optionLabel="etiqueta" optionValue="codigo" [(ngModel)]="motivoSel"
                              placeholder="¿Por qué queda resuelta?" appendTo="body" class="inc-motivo"></p-select>
                    <label for="inc-nota" class="inc-label">Nota{{ pideNota() ? '' : ' (opcional)' }}</label>
                    <textarea pTextarea id="inc-nota" rows="3" maxlength="1000" [(ngModel)]="nota"
                              [placeholder]="pideNota() ? 'Qué pasó: número de acta, quién lo confirmó…' : 'Opcional'"></textarea>
                    @if (motivoSel && errorResolver()) { <p class="inc-err" role="alert">{{ errorResolver() }}</p> }
                    <div class="inc-acciones">
                      <button pButton type="button" class="p-button-sm" [disabled]="guardando() || !!errorResolver()" (click)="resolver()">
                        <span class="p-button-label">Marcar resuelta</span>
                      </button>
                      <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirEnDiario()">
                        <span class="p-button-label">Abrir el documento completo en el Diario</span>
                      </button>
                    </div>
                  </div>
                } @else {
                  <p class="inc-peek-meta">Para resolverla necesitas el permiso de gestionar movimientos.</p>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="abrirEnDiario()">
                    <span class="p-button-label">Abrir el documento completo en el Diario</span>
                  </button>
                }
              }
            </section>
          }
        </app-load-state>
      </div>
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .inc-h1 { display: inline-flex; align-items: center; gap: var(--sp-2); }
    .inc-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .inc-banda { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--warn-border);
      background: var(--warn-soft-bg); color: var(--warn-soft-fg); border-radius: var(--r-md); margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
    .inc-unidad { margin: var(--sp-1) 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    :host ::ng-deep .inc-tag { margin-right: var(--sp-1); }
    .inc-tags { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
    .inc-cel-donde { min-width: 18rem; }
    .inc-donde { display: block; margin-top: var(--sp-1); color: var(--text-main); font-weight: 600; }
    .inc-resuelta { display: block; font-size: var(--fs-xs); color: var(--ok-fg); }
    .inc-tipo, .inc-folio, .inc-tenue, .inc-delta { font-size: var(--fs-xs); color: var(--text-muted); }
    .inc-folio, .inc-tenue, .inc-delta { display: block; }
    .inc-folio { font-family: var(--font-mono, monospace); }
    .inc-alm, .inc-imp { display: block; color: var(--text-main); }
    .inc-imp { font-weight: 600; }
    .inc-delta { color: var(--bad-fg); }
    .inc-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .inc-peek-h { margin: 0 0 var(--sp-1); font-size: var(--fs-xs); font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .inc-peek-donde { margin-bottom: var(--sp-3); }
    .inc-peek-frase { margin: 0; font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); }
    .inc-peek-meta { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .inc-peek-nota { margin: var(--sp-1) 0 0; color: var(--text-main); }
    .inc-delta-fuerte { display: block; font-weight: 600; color: var(--bad-fg); }
    .inc-ver-todos { margin-top: var(--sp-1); }
    .inc-peek-resolver { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .inc-form { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); }
    .inc-label { font-size: var(--fs-xs); color: var(--text-muted); margin-top: var(--sp-2); }
    .inc-err { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); }
    .inc-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
    :host ::ng-deep .inc-motivo { width: 100%; }
    @container (max-width: 48rem) { .inc-filtros { flex-direction: column; align-items: stretch; } }
  `],
})
export class AlmacenIncidenciasComponent implements OnInit {
  private readonly api = inject(AlmacenMovimientosService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  /** Resolver escribe: el mismo permiso que «Auditar» en el Diario (el propio llega con MX.2.5). */
  readonly puedeResolver = this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_MOVEMENTS_GESTIONAR];

  readonly tam = 50;
  desde: Date | null = new Date(Date.now() - 30 * 864e5);
  hasta: Date | null = new Date();
  readonly tipo = signal<ExcepcionMovimiento | 'resueltas' | ''>('');
  readonly pagina = signal(1);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resp = signal<MovimientosExcepcionesResponse | null>(null);
  readonly cargadoEn = signal<Date | null>(null);

  // [MX.2.4] el panel de una incidencia
  readonly abierta = signal<ExcepcionMovimientoItem | null>(null);
  readonly detalle = signal<DetalleIncidenciaMovimiento | null>(null);
  readonly cargandoDetalle = signal(false);
  readonly errorDetalle = signal<string | null>(null);
  readonly verTodos = signal(false);
  readonly guardando = signal(false);
  private readonly motivoSig = signal<MotivoResolucion | null>(null);
  private readonly notaSig = signal('');
  get motivoSel(): MotivoResolucion | null { return this.motivoSig(); }
  set motivoSel(v: MotivoResolucion | null) { this.motivoSig.set(v); }
  get nota(): string { return this.notaSig(); }
  set nota(v: string) { this.notaSig.set(v ?? ''); }

  readonly filas = computed(() => (this.resp()?.rows ?? []).map((r, i) => ({ ...r, clave: `${this.pagina()}-${i}` })));
  readonly total = computed(() => this.resp()?.total ?? 0);

  /** Las opciones del filtro llevan su cuenta: se ve qué tipo pesa antes de elegirlo. */
  readonly tipos = computed<SegOption[]>(() => {
    const p = this.resp()?.totals.por_excepcion ?? {};
    const n = (e: ExcepcionMovimiento) => p[e]?.n ?? 0;
    return [
      { label: `Pendientes (${(this.resp()?.totals.items ?? 0).toLocaleString('es-MX')})`, value: '' },
      ...(Object.keys(ETIQUETA) as ExcepcionMovimiento[]).map((e) => ({ label: `${ETIQUETA[e]} (${n(e).toLocaleString('es-MX')})`, value: e })),
      { label: `Resueltas (${(this.resp()?.totals.resueltas ?? 0).toLocaleString('es-MX')})`, value: 'resueltas' },
    ];
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resp(); if (!r) return [];
    const p = r.totals.por_excepcion;
    const universo = r.totals.universo.traspasos + r.totals.universo.ajustes;
    return [
      { label: 'Pendientes', value: r.totals.items, format: 'number', tone: r.totals.items ? 'warn' : 'ok',
        sub: `de ${universo.toLocaleString('es-MX')} documentos revisados · ${r.totals.resueltas.toLocaleString('es-MX')} resueltas` },
      { label: 'Sin acuse', value: p.sin_acuse?.n ?? 0, format: 'number', tone: p.sin_acuse?.n ? 'bad' : 'muted', sub: this.dinero(p.sin_acuse?.importe ?? 0) },
      { label: 'Diferencias', value: p.diferencia?.n ?? 0, format: 'number', tone: p.diferencia?.n ? 'bad' : 'muted', sub: this.dinero(p.diferencia?.importe ?? 0) },
      { label: 'Ajustes', value: p.ajuste_inventario?.n ?? 0, format: 'number', tone: 'default', sub: this.dinero(p.ajuste_inventario?.importe ?? 0) },
      { label: 'Importe incompleto', value: p.importe_incompleto?.n ?? 0, format: 'number', tone: 'muted' },
    ];
  });

  /** El dinero de la bandeja, por unidad: nunca se suma valor de traspaso con precio de venta. */
  readonly unidadResumen = computed(() => {
    const u = this.resp()?.totals.importe_por_unidad; if (!u) return '';
    const partes = [
      u.valor_traspaso ? `${this.dinero(u.valor_traspaso)} a valor de traspaso` : '',
      u.precio_venta ? `${this.dinero(u.precio_venta)} a precio de venta` : '',
      u.mixta ? `${this.dinero(u.mixta)} con costo y precio mezclados` : '',
      u.sin_unidad ? `${this.dinero(u.sin_unidad)} sin unidad medida (ajustes)` : '',
    ].filter(Boolean);
    return partes.length ? `Importe de las incidencias pendientes: ${partes.join(' · ')}.` : '';
  });

  readonly vacioTitulo = computed(() => {
    const t = this.tipo();
    if (t === 'resueltas') return 'Ninguna incidencia resuelta en el rango';
    return t ? `Sin incidencias pendientes de tipo «${ETIQUETA[t]}»` : 'Sin incidencias pendientes en el rango';
  });
  readonly vacioPista = computed(() => (this.tipo() ? 'Elige «Pendientes» para ver el resto.' : 'Todo lo que el motor revisó en estas fechas cuadra o ya se resolvió. Amplía el rango para revisar más atrás.'));

  // [MX.2.4] el panel
  readonly esAjuste = computed(() => this.abierta()?.tipo === 'ajuste');
  readonly tituloPeek = computed(() => {
    const f = this.abierta(); if (!f) return '';
    return `${f.tipo === 'ajuste' ? 'Ajuste' : f.documento.doc_code === 'TrsfRcv' ? 'Recepción' : 'Salida'} ${f.documento.folio}`;
  });
  readonly subtituloPeek = computed(() => {
    const f = this.abierta(); if (!f) return null;
    const ruta = f.destino ? `${f.origen.nombre || 'Sin origen'} → ${f.destino.nombre || 'sin destino resuelto'}` : (f.origen.nombre || '');
    return `${ruta} · ${f.fecha} · ${f.dias} días`;
  });
  readonly renglonesVisibles = computed<RenglonComparado[]>(() => {
    const r = this.detalle()?.renglones ?? [];
    return this.verTodos() ? r : r.filter((x) => x.con_error);
  });
  readonly renglonesCuadran = computed(() => (this.detalle()?.renglones ?? []).filter((x) => !x.con_error).length);
  readonly pideNota = computed(() => !!MOTIVOS_RESOLUCION_MOVIMIENTO.find((m) => m.codigo === this.motivoSig())?.pide_nota);
  /** Poka-yoke: la misma validación que el servidor, antes de enviar. */
  readonly errorResolver = computed(() => validarResolucion(this.motivoSig(), this.notaSig()));

  ngOnInit(): void { this.cargar(); }

  recargar(): void { this.pagina.set(1); this.cargar(); }

  elegirTipo(v: string): void { this.tipo.set(v as ExcepcionMovimiento | 'resueltas' | ''); this.recargar(); }

  paginar(e: TableLazyLoadEvent): void {
    const p = Math.floor((e.first ?? 0) / this.tam) + 1;
    if (p === this.pagina()) return;
    this.pagina.set(p); this.cargar();
  }

  private cargar(): void {
    this.cargando.set(true); this.error.set(null);
    const f = { from: this.desde ? this.iso(this.desde) : undefined, to: this.hasta ? this.iso(this.hasta) : undefined };
    this.api.exceptions(f, this.tipo(), this.pagina(), this.tam).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resp.set(r); this.cargando.set(false); this.cargadoEn.set(new Date()); },
      // un error limpia lo anterior: no se deja en pantalla el número de otro rango
      error: () => { this.resp.set(null); this.cargando.set(false); this.error.set('No se pudieron cargar las incidencias.'); },
    });
  }

  /** [MX.2.4] Abre la incidencia en el panel: el detalle producto por producto y su resolución. */
  revisar(f: ExcepcionMovimientoItem): void {
    this.abierta.set(f);
    this.verTodos.set(false);
    this.motivoSel = null;
    this.nota = '';
    this.cargarDetalle();
  }

  cargarDetalle(): void {
    const f = this.abierta(); if (!f) return;
    this.detalle.set(null); this.cargandoDetalle.set(true); this.errorDetalle.set(null);
    this.api.exceptionDetail(f.documento).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { if (this.abierta() === f) { this.detalle.set(d); this.cargandoDetalle.set(false); } },
      error: () => { this.cargandoDetalle.set(false); this.errorDetalle.set('No se pudo cargar el detalle del documento.'); },
    });
  }

  cerrar(): void { this.abierta.set(null); this.detalle.set(null); }

  resolver(): void {
    const f = this.abierta(); const m = this.motivoSig();
    if (!f || !m || this.guardando() || this.errorResolver()) return;
    this.guardando.set(true); // síncrono en el primer clic: un doble clic no manda dos
    this.api.resolveException(f.documento, m, this.notaSig().trim() || null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.guardando.set(false);
        this.toast.add({ severity: 'success', summary: 'Incidencia resuelta', detail: `${this.tituloPeek()}: ${this.motivo(m)}` });
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
    this.api.reopenException(f.documento).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.toast.add({ severity: 'info', summary: 'Incidencia reabierta', detail: this.tituloPeek() }); this.cerrar(); this.cargar(); },
      error: () => { this.guardando.set(false); this.toast.add({ severity: 'error', summary: 'No se reabrió', detail: 'Intenta de nuevo.' }); },
    });
  }

  /** El documento completo, con su contraparte y todos sus renglones, sigue en el Diario. */
  abrirEnDiario(): void {
    const f = this.abierta(); if (!f) return;
    const d = f.documento;
    void this.router.navigate(['/almacen/movimientos'], { queryParams: { abrir: d.folio, wh: d.warehouse_id, dc: d.doc_code, serie: d.doc_serie || null, from: f.fecha, to: f.fecha } });
  }

  etiqueta(e: ExcepcionMovimiento): string { return ETIQUETA[e]; }
  severidad(e: ExcepcionMovimiento): 'danger' | 'warn' | 'info' | 'secondary' { return SEVERIDAD[e]; }
  estadoRenglon(e: EstadoRenglonMovimiento): string { return ESTADO_RENGLON[e]; }
  motivo(m: MotivoResolucion | null | undefined): string { return (m && ETIQUETA_MOTIVO.get(m)) || 'Sin motivo'; }
  unidad(f: ExcepcionMovimientoItem): string { return f.unidad_importe ? ETIQUETA_UNIDAD_IMPORTE[f.unidad_importe] : 'unidad no medida'; }
  dinero(n: number | string): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  private iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
