import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import type { WarehouseOrderDetail, WarehouseOrderRow, WarehouseOrdersResponse } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { money } from '../../../shared/util/money.util';
import { AlmacenPedidosService, type AlmacenPedidosFiltro } from '../almacen-pedidos.service';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';
type Preset = 'hoy' | 'semana' | 'mes' | 'mes_anterior' | 'rango';

/** Color de cada estatus de Kepler. Lo que Kepler traiga nuevo cae en gris, no se pierde. */
const ESTATUS: Record<string, { label: string; sev: Sev }> = {
  CREADO: { label: 'Creado', sev: 'secondary' },
  AUTORIZADO: { label: 'Autorizado', sev: 'info' },
  SURTIDO: { label: 'Surtido', sev: 'warn' },
  CHECADO: { label: 'Checado', sev: 'warn' },
  EMBARCADO: { label: 'Embarcado', sev: 'success' },
};
const ORIGEN: Record<string, string> = { TELEMARK: 'Telemarketing', SUCURSAL: 'Sucursal' };

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/**
 * `[GP.1]` Tablero de pedidos del almacén.
 *
 * Los pedidos Kepler `U-D-40` (telemarketing y sucursal) del periodo, filtrables por estatus,
 * origen, sucursal y texto, con el detalle por renglón: cantidad pedida/surtida/checada/
 * embarcada y la ubicación de cada etapa. Sólo lectura (ADR-084): el pedido se sigue
 * avanzando en Kepler. El periodo arranca en el **mes en curso** (decisión de Francisco).
 *
 * Lo que Kepler no guarda se declara, no se dibuja: no hay hora por etapa, así que la columna
 * "Abierto" mide desde que se CREÓ el pedido, no cuánto lleva en su estatus.
 */
@Component({
  selector: 'app-almacen-pedidos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, DatePickerModule, InputTextModule, TagModule, MetricStripComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Pedidos</h1>
          <p class="surf-page-sub">Pedidos de Kepler por surtir, checar y embarcar: telemarketing y sucursal. Sólo lectura; el pedido se sigue avanzando en Kepler.</p>
        </div>
        <div class="gp-actions">
          <div class="gp-seg" role="group" aria-label="Periodo">
            @for (p of presets; track p.key) {
              <button type="button" class="gp-seg-b" [class.on]="preset() === p.key" [attr.aria-pressed]="preset() === p.key" (click)="pickPreset(p.key)">{{ p.label }}</button>
            }
          </div>
          <p-datepicker inputId="gp-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Rango" (onClose)="onRange()" ariaLabel="Rango de fechas" />
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) { <div class="gp-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="gp-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="gp-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="gp-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <p class="gp-periodo">Periodo {{ dmy(d.periodo.from) }} – {{ dmy(d.periodo.to) }} · Kepler leído {{ hora(d.generado_en) }}</p>
        @if (!d.alcance.todas) {
          @if (d.alcance.sucursales.length) {
            <div class="gp-note" role="note"><i class="pi pi-shop" aria-hidden="true"></i><span>Viendo sólo {{ d.alcance.sucursales.length === 1 ? 'tu sucursal' : 'tus sucursales' }}: <b>{{ sucursalesTexto(d) }}</b>.</span></div>
          } @else {
            <div class="gp-note gp-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay pedidos que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
          }
        }

        <app-metric-strip [items]="kpiItems()" ariaLabel="Resumen de pedidos filtrados" />

        <div class="gp-split">
          <section class="gp-block dt-scope" aria-labelledby="gp-h-lista">
            <div class="gp-bh">
              <h2 id="gp-h-lista" class="sr-only">Lista de pedidos</h2>
              <div class="gp-chips" role="group" aria-label="Estatus en Kepler">
                <button type="button" class="gp-chip" [class.on]="!estatus()" [attr.aria-pressed]="!estatus()" (click)="pickEstatus(null)">Todos <span class="num">{{ totalConteos(d) }}</span></button>
                @for (c of d.conteos; track c.estatus) {
                  <button type="button" class="gp-chip" [class.on]="estatus() === c.estatus" [attr.aria-pressed]="estatus() === c.estatus" (click)="pickEstatus(c.estatus)">{{ estatusLabel(c.estatus) }} <span class="num">{{ c.pedidos }}</span></button>
                }
              </div>
              <div class="gp-filters">
                <p-select [options]="origenOpts" optionLabel="label" optionValue="value" [ngModel]="origen()" (onChange)="pickOrigen($event.value)" ariaLabel="Origen" appendTo="body" class="gp-sel" />
                @if (sucursalOpts().length > 2) {
                  <p-select [options]="sucursalOpts()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (onChange)="pickSucursal($event.value)" ariaLabel="Sucursal" appendTo="body" class="gp-sel" />
                }
                <input pInputText type="search" class="gp-q" [ngModel]="q()" (ngModelChange)="onQ($event)" placeholder="Folio, cliente, ciudad o guía" aria-label="Buscar folio, cliente, ciudad o guía" />
              </div>
            </div>
            @if (d.truncado) { <p class="gp-hint gp-pad">Se muestran los primeros {{ d.items.length }}; los conteos y totales sí incluyen todos. Acota el periodo o filtra por estatus.</p> }
            <p-table [value]="d.items" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="60vh" selectionMode="single" [selection]="sel()" (selectionChange)="pick($event)" dataKey="clave" [paginator]="d.items.length > 200" [rows]="200">
              <ng-template #header>
                <tr>
                  <th>Pedido</th><th>Fecha</th>@if (multiSucursal(d)) { <th>Suc</th> }<th>Origen</th><th>Cliente / destino</th>
                  <th class="ta-r">Reng.</th><th>Estatus</th>
                  <th class="ta-r" title="Horas desde que se creó el pedido. Kepler no guarda cuándo cambió de estatus.">Abierto</th>
                  <th>Guía</th><th class="ta-r">Importe</th>
                </tr>
              </ng-template>
              <ng-template #body let-r>
                <tr [pSelectableRow]="r">
                  <td class="mono" role="cell" data-label="Pedido">{{ r.documento }}</td>
                  <td class="mono" role="cell" data-label="Fecha">{{ dmy(r.fecha) }} <span class="muted">{{ r.hora || '' }}</span></td>
                  @if (multiSucursal(d)) { <td class="mono muted" role="cell" data-label="Suc">{{ r.sucursal }}</td> }
                  <td role="cell" data-label="Origen">{{ origenLabel(r.origen) }}</td>
                  <td role="cell" data-label="Cliente / destino"><span class="gp-trunc">{{ r.destino_nombre || r.cliente_code || '—' }}</span>@if (r.destino_ciudad) { <span class="muted gp-sub">{{ r.destino_ciudad }}</span> }</td>
                  <td class="ta-r num" role="cell" data-label="Reng.">{{ r.renglones }}</td>
                  <td role="cell" data-label="Estatus"><p-tag [value]="estatusLabel(r.estatus)" [severity]="estatusSev(r.estatus)" styleClass="gp-tag" /></td>
                  <td class="ta-r num" role="cell" data-label="Abierto">{{ horas(r.horas_abierto) }}</td>
                  <td class="mono" role="cell" data-label="Guía" [class.muted]="!r.guia">{{ r.guia || '—' }}</td>
                  <td class="ta-r num" role="cell" data-label="Importe">{{ r.importe === null ? '—' : money(r.importe) }}</td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td [attr.colspan]="multiSucursal(d) ? 10 : 9"><div class="gp-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Ningún pedido con estos filtros entre {{ dmy(d.periodo.from) }} y {{ dmy(d.periodo.to) }}.</span>@if (hayFiltros()) { <button type="button" class="gp-link" (click)="limpiar()">Quitar filtros</button> }</div></td></tr>
              </ng-template>
            </p-table>
          </section>

          <section class="gp-block gp-detail" aria-labelledby="gp-h-det" aria-live="polite">
            @if (detLoading()) {
              <div class="gp-skeleton gp-pad" aria-busy="true">@for (i of skelDet; track i) { <div class="gp-skel-row"></div> }</div>
            } @else if (det(); as x) {
              <div class="gp-bh">
                <h2 id="gp-h-det" class="mono">{{ x.pedido.documento }}</h2>
                <p-tag [value]="estatusLabel(x.pedido.estatus)" [severity]="estatusSev(x.pedido.estatus)" styleClass="gp-tag" />
              </div>
              <div class="gp-step">
                <div class="gp-row"><span>Cliente</span><span>{{ x.pedido.destino_nombre || x.pedido.cliente_code || '—' }}@if (x.pedido.destino_ciudad) { <span class="muted"> · {{ x.pedido.destino_ciudad }}</span> }</span></div>
                <div class="gp-row"><span>Origen</span><span>{{ origenLabel(x.pedido.origen) }} · {{ x.pedido.sucursal }} {{ x.pedido.sucursal_nombre }}</span></div>
                <div class="gp-row"><span>Vendedor</span><span>{{ x.pedido.vendedor_nombre || x.pedido.vendedor_code || '—' }}</span></div>
                <div class="gp-row"><span>Creado</span><span class="mono">{{ dmy(x.pedido.fecha) }} {{ x.pedido.hora || '' }}</span></div>
                <div class="gp-row"><span>Responsables (surtido · checado · embarque)</span><span class="mono">{{ x.pedido.resp_surtido || '—' }} · {{ x.pedido.resp_checado || '—' }} · {{ x.pedido.resp_embarque || '—' }}</span></div>
                <div class="gp-row"><span>Transporte · chofer · guía</span><span class="mono">{{ x.pedido.transporte || '—' }} · {{ x.pedido.chofer || '—' }} · {{ x.pedido.guia || '—' }}</span></div>
                @for (e of x.embarques; track e.documento) {
                  <div class="gp-row"><span>Embarque</span><span class="mono">{{ e.documento }} · {{ dmy(e.fecha) }}@if (e.guia) { · guía {{ e.guia }} }</span></div>
                } @empty {
                  <div class="gp-row"><span>Embarque</span><span class="muted">Sin embarque todavía</span></div>
                }
              </div>
              <div class="gp-step dt-scope">
                <h3>Renglones · {{ x.lineas.length }}</h3>
                <p-table [value]="x.lineas" size="small" class="surf-table dt-stack" [scrollable]="true" scrollHeight="42vh" dataKey="renglon">
                  <ng-template #header>
                    <tr><th>Producto</th><th class="ta-r">Ped</th><th class="ta-r">Surt</th><th class="ta-r">Chec</th><th class="ta-r">Emb</th><th title="Ubicación de surtido · checado · embarque capturada en Kepler">Ubic. S · C · E</th></tr>
                  </ng-template>
                  <ng-template #body let-l>
                    <tr>
                      <td role="cell" data-label="Producto">
                        <span class="gp-trunc">{{ l.descripcion || l.sku }}</span>
                        <span class="muted gp-sub mono">{{ l.sku }} · {{ l.unidad_presentacion || l.unidad || '' }}@if (agregado(l.etapa_alta)) { · <span class="gp-warn">agregado en {{ estatusLabel(l.etapa_alta).toLowerCase() }}</span> }</span>
                      </td>
                      <td class="ta-r num" role="cell" data-label="Ped">{{ cant(l.cant_pedida) }}</td>
                      <td class="ta-r num" role="cell" data-label="Surt" [class.gp-warn]="difiere(l.cant_pedida, l.cant_surtida)">{{ cant(l.cant_surtida) }}</td>
                      <td class="ta-r num" role="cell" data-label="Chec" [class.gp-warn]="difiere(l.cant_surtida, l.cant_checada)">{{ cant(l.cant_checada) }}</td>
                      <td class="ta-r num" role="cell" data-label="Emb" [class.gp-warn]="difiere(l.cant_checada, l.cant_embarcada)">{{ cant(l.cant_embarcada) }}</td>
                      <td class="mono" role="cell" data-label="Ubic. S · C · E">{{ l.ubic_surtido || '—' }} · {{ l.ubic_checado || '—' }} · {{ l.ubic_embarque || '—' }}</td>
                    </tr>
                  </ng-template>
                </p-table>
                <p class="gp-hint">Las cantidades van en la unidad del pedido. La ubicación por etapa casi nunca se captura en Kepler; se llenará al llevar el piso en la Suite.</p>
              </div>
            } @else if (detErr(); as e) {
              <div class="gp-empty gp-pad"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ e }}</span></div>
            } @else {
              <div class="gp-empty gp-pad"><i class="pi pi-arrow-left" aria-hidden="true"></i><span>Elige un pedido para ver sus renglones, responsables y embarque.</span></div>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .gp-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .gp-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:var(--r-sm); overflow:hidden; background:var(--card-bg); }
    .gp-seg-b { height:2.25rem; padding:0 .75rem; border:0; border-left:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .gp-seg-b:first-child { border-left:0; }
    .gp-seg-b.on { background:var(--text-main); color:var(--card-bg); }
    .gp-seg-b:focus-visible, .gp-chip:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .gp-periodo { margin:.2rem 0 .4rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .gp-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .gp-note .pi { color:var(--text-muted); margin-top:.15rem; }
    .gp-note-bad { border-left:3px solid var(--bad-fg); }
    .gp-note-bad .pi { color:var(--bad-fg); }
    app-metric-strip { display:block; margin:.6rem 0; }
    .gp-split { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(0,1fr); gap:1rem; align-items:start; }
    @media (max-width:68.75rem) { .gp-split { grid-template-columns:minmax(0,1fr); } }
    .gp-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .gp-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .gp-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .gp-chips { display:flex; flex-wrap:wrap; gap:.3rem; }
    .gp-chip { height:2rem; padding:0 .65rem; border:1px solid var(--border-color); border-radius:999px; background:var(--card-bg); color:var(--text-main); font:inherit; font-size:var(--fs-xs); display:inline-flex; align-items:center; gap:.35rem; cursor:pointer; }
    .gp-chip.on { background:var(--text-main); border-color:var(--text-main); color:var(--card-bg); }
    .gp-filters { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
    :host ::ng-deep .gp-sel { min-width:9.5rem; }
    .gp-q { min-width:14rem; height:2.25rem; }
    .gp-detail { position:sticky; top:.5rem; }
    .gp-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .gp-bh + .gp-step { border-top:0; }
    .gp-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .gp-row { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .gp-row > span:first-child { color:var(--text-muted); flex:none; }
    .gp-row > span:last-child { text-align:right; min-width:0; }
    .gp-trunc { display:block; max-width:22rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .gp-sub { display:block; font-size:var(--fs-xs); }
    .gp-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:.5rem 0 0; }
    .gp-pad { padding:.5rem .85rem; }
    .gp-warn { color:var(--warn-soft-fg); font-weight:600; }
    .gp-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .gp-tag { font-size:var(--fs-nano); }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .gp-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .gp-errbox .pi { color:var(--bad-fg); } .gp-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .gp-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .gp-empty .pi { font-size:var(--fs-lg); }
    .gp-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .gp-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); animation:gp-pulse 1.4s ease-in-out infinite; }
    @keyframes gp-pulse { 0%,100% { opacity:1; } 50% { opacity:.55; } }
    @media (prefers-reduced-motion: reduce) { .gp-skel-row { animation:none; } }
  `],
})
export class AlmacenPedidosComponent implements OnInit {
  private readonly api = inject(AlmacenPedidosService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly q$ = new Subject<string>();

  readonly skel = Array.from({ length: 8 });
  readonly skelDet = Array.from({ length: 6 });
  readonly money = money;
  readonly dmy = dmy;

  readonly presets: { key: Exclude<Preset, 'rango'>; label: string }[] = [
    { key: 'hoy', label: 'Hoy' },
    { key: 'semana', label: 'Semana' },
    { key: 'mes', label: 'Mes en curso' },
    { key: 'mes_anterior', label: 'Mes anterior' },
  ];
  readonly origenOpts = [
    { label: 'Todos los orígenes', value: null },
    { label: 'Telemarketing', value: 'TELEMARK' },
    { label: 'Sucursal', value: 'SUCURSAL' },
  ];

  readonly preset = signal<Preset>('mes');
  rangeDates: Date[] | null = null;
  readonly estatus = signal<string | null>(null);
  readonly origen = signal<string | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly q = signal('');

  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<WarehouseOrdersResponse | null>(null);
  readonly sel = signal<WarehouseOrderRow | null>(null);
  readonly det = signal<WarehouseOrderDetail | null>(null);
  readonly detLoading = signal(false);
  readonly detErr = signal<string | null>(null);

  readonly kpiItems = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const abiertos = d.conteos.filter((c) => c.estatus !== 'EMBARCADO');
    const pendientes = abiertos.reduce((t, c) => t + c.pedidos, 0);
    const masAntiguo = abiertos.reduce<number | null>((m, c) => (c.mas_antiguo_horas != null && (m == null || c.mas_antiguo_horas > m) ? c.mas_antiguo_horas : m), null);
    return [
      { label: 'Pedidos', value: d.totales.pedidos, format: 'number', tone: 'default', sub: `${d.totales.renglones.toLocaleString('es-MX')} renglones` },
      { label: 'Sin embarcar', value: pendientes, format: 'number', tone: pendientes ? 'warn' : 'ok', sub: masAntiguo == null ? 'ninguno abierto' : `el más antiguo lleva ${this.horas(masAntiguo)}` },
      { label: 'Importe', value: d.totales.importe, format: 'currency2', tone: 'default', sub: 'de los pedidos filtrados' },
    ];
  });

  /** Sucursales para el filtro: las del alcance, o las que aparecen en el periodo si se ven todas. */
  readonly sucursalOpts = computed(() => {
    const d = this.data();
    const out: { label: string; value: string | null }[] = [{ label: 'Todas las sucursales', value: null }];
    if (!d) return out;
    const vistas = new Map<string, string>();
    if (d.alcance.todas) for (const r of d.items) vistas.set(r.sucursal, r.sucursal_nombre);
    else for (const s of d.alcance.sucursales) vistas.set(s.codigo, s.nombre);
    const sel = this.sucursal();
    if (sel && !vistas.has(sel)) vistas.set(sel, sel);
    for (const [codigo, nombre] of [...vistas.entries()].sort()) out.push({ label: `${codigo} ${nombre}`, value: codigo });
    return out;
  });

  ngOnInit(): void {
    this.q$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef)).subscribe((v) => {
      this.q.set(v);
      this.reload();
    });
    this.reload();
  }

  pickPreset(p: Exclude<Preset, 'rango'>): void {
    this.preset.set(p);
    this.rangeDates = null;
    this.reload();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.preset.set('rango');
    this.reload();
  }

  pickEstatus(e: string | null): void { this.estatus.set(this.estatus() === e ? null : e); this.reload(); }
  pickOrigen(o: string | null): void { this.origen.set(o); this.reload(); }
  pickSucursal(s: string | null): void { this.sucursal.set(s); this.reload(); }
  onQ(v: string): void { this.q$.next(v); }

  hayFiltros(): boolean { return !!(this.estatus() || this.origen() || this.sucursal() || this.q()); }
  limpiar(): void {
    this.estatus.set(null); this.origen.set(null); this.sucursal.set(null); this.q.set('');
    this.reload();
  }

  private filtro(): AlmacenPedidosFiltro {
    const f: AlmacenPedidosFiltro = {
      estatus: this.estatus() ? [this.estatus() as string] : [],
      origen: this.origen(),
      sucursal: this.sucursal(),
      q: this.q() || null,
    };
    const hoy = new Date();
    switch (this.preset()) {
      case 'hoy': f.from = f.to = iso(hoy); break;
      case 'semana': {
        const lunes = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - ((hoy.getDay() + 6) % 7));
        f.from = iso(lunes); f.to = iso(hoy); break;
      }
      case 'mes': f.month = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}`; break;
      case 'mes_anterior': {
        const x = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        f.month = `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; break;
      }
      case 'rango': {
        const [a, b] = this.rangeDates || [];
        if (a && b) { f.from = iso(a); f.to = iso(b); }
        break;
      }
    }
    return f;
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.api.list(this.filtro()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        const s = this.sel();
        if (s && !d.items.some((x) => x.clave === s.clave)) { this.sel.set(null); this.det.set(null); }
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los pedidos.'); },
    });
  }

  pick(r: WarehouseOrderRow | null): void {
    this.sel.set(r);
    this.det.set(null);
    this.detErr.set(null);
    if (!r) return;
    this.detLoading.set(true);
    this.api.detail(r.sucursal, r.serie, r.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => { if (this.sel()?.clave === r.clave) this.det.set(x); this.detLoading.set(false); },
      error: () => { this.detLoading.set(false); this.detErr.set('No se pudo cargar el detalle del pedido.'); },
    });
  }

  multiSucursal(d: WarehouseOrdersResponse): boolean { return !this.sucursal() && (d.alcance.todas || d.alcance.sucursales.length > 1); }
  totalConteos(d: WarehouseOrdersResponse): number { return d.conteos.reduce((t, c) => t + c.pedidos, 0); }
  sucursalesTexto(d: WarehouseOrdersResponse): string { return d.alcance.sucursales.map((x) => `${x.codigo} ${x.nombre}`).join(', '); }
  estatusLabel(e: string | null): string { return e ? ESTATUS[e]?.label ?? e : 'Sin estatus'; }
  estatusSev(e: string | null): Sev { return (e && ESTATUS[e]?.sev) || 'secondary'; }
  origenLabel(o: string | null): string { return o ? ORIGEN[o] ?? o : '—'; }
  /** El renglón se agregó después de que el pedido se creó (en surtido, checado o embarque). */
  agregado(etapa: string | null): boolean { return !!etapa && etapa !== 'CREADO' && etapa !== 'AUTORIZADO'; }
  difiere(a: number | null, b: number | null): boolean { return a != null && b != null && Math.abs(a - b) > 0.0001; }
  cant(v: number | null): string { return v == null ? '—' : v.toLocaleString('es-MX', { maximumFractionDigits: 3 }); }
  horas(h: number | null): string {
    if (h == null) return '—';
    if (h < 1) return `${Math.round(h * 60)} min`;
    if (h < 48) return `${h.toLocaleString('es-MX', { maximumFractionDigits: 1 })} h`;
    return `${Math.floor(h / 24)} d`;
  }
  hora(isoTs: string): string {
    return new Date(isoTs).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' });
  }
}
