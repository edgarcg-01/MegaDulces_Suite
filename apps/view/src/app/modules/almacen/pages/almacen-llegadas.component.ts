import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { DrawerModule } from 'primeng/drawer';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type {
  AndenLlegada,
  AndenLlegadaEstado,
  AndenLlegadaLote,
  AndenLlegadaRenglon,
  AndenLlegadaRenglonEstado,
  AndenLlegadas,
} from '@megadulces/contracts';
import { money } from '../../../shared/util/money.util';
import { ReceivingSessionService } from '../receiving-session.service';
import { type PeriodoLlegadas, diaAnterior, enPeriodo, ordenarLlegadas, resumirLlegadas } from '../llegadas.util';

type Sev = 'success' | 'warn' | 'danger' | 'secondary' | 'info';

const ESTADO: Record<AndenLlegadaEstado, { label: string; sev: Sev }> = {
  sin_abrir: { label: 'Sin abrir', sev: 'danger' },
  a_medias: { label: 'A medias', sev: 'warn' },
  completa: { label: 'Completa', sev: 'success' },
  en_camino: { label: 'En camino', sev: 'secondary' },
};

const RENGLON: Record<AndenLlegadaRenglonEstado, { label: string; sev: Sev }> = {
  fechado: { label: 'Fechado', sev: 'success' },
  sin_caducidad: { label: 'Sin caducidad', sev: 'secondary' },
  falta: { label: 'Falta', sev: 'warn' },
  no_llego: { label: 'No llegó', sev: 'secondary' },
  sin_vale: { label: 'Sin vale', sev: 'danger' },
};

const TIPO: Record<AndenLlegada['tipo'], string> = { compra: 'Proveedor', traspaso: 'Traspaso', manual: 'Vale manual' };

const dmy = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

/**
 * `[WMS-REC.22]` **Llegadas al andén** — qué camiones llegaron a cada sucursal, qué traían y si se
 * les capturó la caducidad.
 *
 * Lo nuevo que muestra es el camión **sin abrir**: Kepler ya le dio entrada y nadie abrió el vale,
 * así que su mercancía está en el inventario sin caducidad. «Por fechar» no lo ve porque sólo mira
 * vales que alguien abrió.
 *
 * Lo ve quien tenga `ALMACEN_LLEGADAS_VER`, que nace sin repartir: hoy, sólo el modo god. Es de
 * sólo lectura. Lo que Kepler no guarda se declara: no hay hora de llegada sin vale.
 */
@Component({
  selector: 'app-almacen-llegadas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, TableModule, SelectModule, InputTextModule, TagModule, DrawerModule],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head ll-head">
        <div class="ll-head-text">
          <h1>Llegadas al andén</h1>
          @if (data(); as d) {
            <span class="ll-meta">Kepler leído {{ hora(d.generado_en) }} · del {{ dmy(d.desde) }} a hoy · sólo lectura</span>
          }
        </div>
        <div class="ll-actions">
          <div class="ll-seg" role="group" aria-label="Periodo">
            @for (p of periodos; track p.key) {
              <button type="button" class="ll-seg-b" [class.on]="periodo() === p.key" [attr.aria-pressed]="periodo() === p.key" (click)="periodo.set(p.key)">{{ p.label }}</button>
            }
          </div>
          <button pButton type="button" class="p-button-sm p-button-outlined" [loading]="loading()" (click)="reload()" aria-label="Actualizar"><span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </div>
      </header>

      @if (err(); as e) {
        <div class="ll-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="ll-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div>
      }

      @if (loading() && !data()) {
        <div class="ll-skeleton" aria-busy="true">@for (i of skel; track i) { <div class="ll-skel-row"></div> }</div>
      } @else if (data(); as d) {
        @let r = resumen();
        <div class="ll-kpis" role="group" aria-label="Resumen y filtro por estado">
          <button type="button" class="ll-kpi" [class.on]="!estado()" [attr.aria-pressed]="!estado()" (click)="estado.set(null)">
            <span class="ll-kpi-l">Camiones que llegaron</span><span class="ll-kpi-v num">{{ r.llegaron }}</span>
            <span class="ll-kpi-s">{{ r.proveedor }} de proveedor · {{ r.traspaso }} traspasos@if (r.manual) { · {{ r.manual }} manuales }@if (periodo() === 'hoy' && r.anteriores) { · {{ r.anteriores }} de días anteriores }</span>
          </button>
          <button type="button" class="ll-kpi ll-kpi-bad" [class.on]="estado() === 'sin_abrir'" [attr.aria-pressed]="estado() === 'sin_abrir'" (click)="toggle('sin_abrir')">
            <span class="ll-kpi-l">Sin abrir en el Andén</span><span class="ll-kpi-v num">{{ r.sin_abrir }}</span>
            <span class="ll-kpi-s">@if (r.sin_abrir) { {{ money(r.importe_sin_abrir) }} de mercancía sin caducidad } @else { Ninguno }</span>
          </button>
          <button type="button" class="ll-kpi ll-kpi-warn" [class.on]="estado() === 'a_medias'" [attr.aria-pressed]="estado() === 'a_medias'" (click)="toggle('a_medias')">
            <span class="ll-kpi-l">A medias</span><span class="ll-kpi-v num">{{ r.a_medias }}</span>
            <span class="ll-kpi-s">@if (r.renglones_sin_fecha) { {{ r.renglones_sin_fecha }} renglones sin fecha } @else { Ninguno }</span>
          </button>
          <button type="button" class="ll-kpi ll-kpi-ok" [class.on]="estado() === 'completa'" [attr.aria-pressed]="estado() === 'completa'" (click)="toggle('completa')">
            <span class="ll-kpi-l">Con caducidad completa</span><span class="ll-kpi-v num">{{ r.completas }}</span>
            <span class="ll-kpi-s">{{ r.sin_caducidad }} renglones sin caducidad@if (r.por_autorizar) { · {{ r.por_autorizar }} rojos por autorizar }</span>
          </button>
          <button type="button" class="ll-kpi" [class.on]="estado() === 'en_camino'" [attr.aria-pressed]="estado() === 'en_camino'" (click)="toggle('en_camino')">
            <span class="ll-kpi-l">En camino</span><span class="ll-kpi-v num">{{ r.en_camino }}</span>
            <span class="ll-kpi-s">Traspasos que aún no llegan</span>
          </button>
        </div>

        <section class="ll-block dt-scope" aria-labelledby="ll-h-lista">
          <div class="ll-bh">
            <h2 id="ll-h-lista">Camiones <span class="muted num">{{ filas().length }}</span></h2>
            <div class="ll-filters">
              @if (sucursalOpts().length > 2) {
                <p-select [options]="sucursalOpts()" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (onChange)="sucursal.set($event.value)" ariaLabel="Sucursal" appendTo="body" class="ll-sel" />
              }
              <p-select [options]="origenOpts" optionLabel="label" optionValue="value" [ngModel]="origen()" (onChange)="origen.set($event.value)" ariaLabel="Origen" appendTo="body" class="ll-sel" />
              <input pInputText type="search" class="ll-q" [ngModel]="q()" (ngModelChange)="q.set($event)" placeholder="Folio, proveedor o producto" aria-label="Buscar folio, proveedor o producto" />
            </div>
          </div>
          <p-table [value]="filas()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="calc(100vh - 24rem)" selectionMode="single" [selection]="sel()" (selectionChange)="sel.set($event)" dataKey="clave">
            <ng-template #header>
              <tr>
                <th>Caducidad</th><th>Llegó</th><th>Sucursal</th><th>De</th>
                <th class="ta-r">Mercancía</th><th title="Renglones que ya no esperan fecha">Renglones listos</th><th title="Lotes con caducidad, por semáforo">Semáforo</th>
              </tr>
            </ng-template>
            <ng-template #body let-l>
              <tr [pSelectableRow]="l" [class]="'ll-row ll-row-' + l.estado">
                <td role="cell" data-label="Caducidad"><p-tag [value]="estadoLabel(l.estado)" [severity]="estadoSev(l.estado)" styleClass="ll-tag" /></td>
                <td role="cell" data-label="Llegó">
                  @if (l.vale) {
                    <span class="mono">{{ hora(l.vale.abierto_en) }}</span>@if (l.dia !== d.hoy) { <span class="ll-dia">{{ diaTexto(l.dia, d.hoy) }}</span> }
                    <span class="muted ll-sub">{{ l.vale.abierto_por || '—' }}</span>
                  } @else if (l.estado === 'en_camino') {
                    <span>Salió {{ diaTexto(l.salio, d.hoy) }}</span>
                  } @else {
                    <span class="muted">Sin hora</span><span class="muted ll-sub">Kepler: {{ diaTexto(l.dia, d.hoy) }}</span>
                  }
                </td>
                <td role="cell" data-label="Sucursal"><span class="mono">{{ l.warehouse_code || '—' }}</span><span class="muted ll-sub">{{ l.warehouse_name || '' }}</span></td>
                <td role="cell" data-label="De"><span class="ll-trunc">{{ deQuien(l) }}</span><span class="muted ll-sub mono">{{ l.documento || l.vale?.folio || '—' }}</span></td>
                <td class="ta-r" role="cell" data-label="Mercancía"><span class="num">{{ l.resumen.renglones }} reng.</span><span class="muted ll-sub num">{{ l.importe === null ? '—' : money(l.importe) }}</span></td>
                <td role="cell" data-label="Renglones listos">
                  @if (l.estado === 'en_camino') { <span class="muted">Todavía no llega</span> }
                  @else {
                    <span class="ll-bar" [class.ll-bar-cero]="!l.resumen.listos" [class.ll-bar-parcial]="l.resumen.listos && l.resumen.faltan"><span class="ll-bar-f" [style.width.%]="pct(l)"></span></span>
                    <span class="ll-sub num">{{ l.resumen.listos }} de {{ l.resumen.renglones }}@if (!l.vale) { · sin vale } @else if (l.resumen.faltan) { · {{ l.vale.cerrado_en ? 'vale cerrado' : 'vale abierto' }} }</span>
                  }
                </td>
                <td role="cell" data-label="Semáforo">
                  @if (l.resumen.verdes + l.resumen.amarillos + l.resumen.rojos) {
                    <span class="ll-dots num" [attr.aria-label]="l.resumen.verdes + ' verdes, ' + l.resumen.amarillos + ' amarillos, ' + l.resumen.rojos + ' rojos'">
                      <span><i class="ll-dot ll-dot-g"></i>{{ l.resumen.verdes }}</span><span><i class="ll-dot ll-dot-y"></i>{{ l.resumen.amarillos }}</span><span><i class="ll-dot ll-dot-r"></i>{{ l.resumen.rojos }}</span>
                    </span>
                  } @else { <span class="muted">—</span> }
                  @if (l.resumen.sin_caducidad) { <span class="muted ll-sub">{{ l.resumen.sin_caducidad }} sin caducidad</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7"><div class="ll-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Ningún camión con estos filtros.</span>@if (hayFiltros()) { <button type="button" class="ll-link" (click)="limpiar()">Quitar filtros</button> }</div></td></tr>
            </ng-template>
          </p-table>
        </section>

        <details class="ll-legend">
          <summary>Cómo se lee</summary>
          <ul>
            <li><b>Llegó</b> quiere decir que Kepler registró la entrada: la orden de entrada del proveedor, o el traspaso recibido en la sucursal. Kepler sólo guarda el día; la hora sale del Andén, cuando alguien abre el vale.</li>
            <li><b>Sin abrir</b>: Kepler ya lo tiene y nadie abrió el vale. Esa mercancía está en el inventario sin lote ni caducidad.</li>
            <li><b>A medias</b>: hay vale y le faltan renglones por fechar. Si el vale ya se cerró, lo que falta está en Por fechar.</li>
            <li><b>Sin caducidad</b>: quien recibió declaró que el producto no tiene caducidad. Entra como lote NA y no cuenta en el semáforo.</li>
            <li><b>Hoy</b> también muestra lo de días anteriores que sigue sin terminar, igual que el menú del Andén.</li>
          </ul>
        </details>

        <p-drawer [visible]="!!sel()" (visibleChange)="!$event && sel.set(null)" position="right" styleClass="ll-drawer"
                  [style]="{ width: 'min(600px, 100vw)' }" [header]="sel()?.documento || sel()?.vale?.folio || 'Camión'">
          @if (sel(); as x) {
            <section class="ll-detail" aria-labelledby="ll-h-det" aria-live="polite">
              <h2 id="ll-h-det" class="sr-only">Detalle del camión {{ x.documento || x.vale?.folio }}</h2>
              <div class="ll-det-head">
                <p-tag [value]="estadoLabel(x.estado)" [severity]="estadoSev(x.estado)" styleClass="ll-tag" />
                <span class="muted">{{ tipoLabel(x.tipo) }} · {{ x.resumen.renglones }} renglones · {{ x.importe === null ? '—' : money(x.importe) }}</span>
              </div>
              <p class="ll-frase" [class.ll-frase-bad]="x.estado === 'sin_abrir'">{{ frase(x) }}</p>
              <div class="ll-step">
                <div class="ll-r"><span>De</span><span>{{ deQuien(x) }}</span></div>
                <div class="ll-r"><span>Entra a</span><span>{{ x.warehouse_code || '—' }} {{ x.warehouse_name || '' }}</span></div>
                @if (x.tipo === 'traspaso') {
                  <div class="ll-r"><span>Salió (Kepler)</span><span class="mono">{{ dmy(x.salio) }}</span></div>
                  <div class="ll-r"><span>Recibido en Kepler</span><span class="mono">{{ x.recibido_kepler ? dmy(x.recibido_kepler) : 'Todavía no' }}</span></div>
                } @else if (x.tipo === 'compra') {
                  <div class="ll-r"><span>Orden de entrada (Kepler)</span><span class="mono">{{ dmy(x.dia) }}</span></div>
                }
                @if (x.vale; as v) {
                  <div class="ll-r"><span>Vale</span><span class="mono">{{ v.folio }}</span></div>
                  <div class="ll-r"><span>Abrió</span><span>{{ v.abierto_por || '—' }} · <span class="mono">{{ dmy(diaMx(v.abierto_en)) }} {{ hora(v.abierto_en) }}</span></span></div>
                  <div class="ll-r"><span>Cerró</span><span class="mono">{{ v.cerrado_en ? dmy(diaMx(v.cerrado_en)) + ' ' + hora(v.cerrado_en) : 'Sin cerrar' }}</span></div>
                } @else if (x.estado !== 'en_camino') {
                  <div class="ll-r"><span>Vale</span><span class="ll-bad">Nadie lo abrió</span></div>
                }
              </div>
              <div class="ll-step">
                <h3>Mercancía · {{ x.renglones.length }}</h3>
                <p-table [value]="x.renglones" size="small" class="surf-table ll-lines" [scrollable]="true" scrollHeight="calc(100vh - 26rem)">
                  <ng-template #header>
                    <tr><th>Producto</th><th class="ta-r">Llegó</th><th>Caducidad</th></tr>
                  </ng-template>
                  <ng-template #body let-g>
                    <tr>
                      <td role="cell" data-label="Producto"><span class="ll-trunc">{{ g.nombre || g.sku || '—' }}</span><span class="muted ll-sub mono">{{ g.sku || '' }}</span></td>
                      <td class="ta-r num" role="cell" data-label="Llegó">{{ cant(g.cantidad) }} <span class="muted">{{ unidad(g) }}</span></td>
                      <td role="cell" data-label="Caducidad">
                        @if (g.estado === 'fechado') {
                          @for (o of g.lotes; track $index) {
                            <span class="ll-lote" [class.ll-lote-x]="o.estatus === 'rejected'"><i [class]="'ll-dot ll-dot-' + punto(o)"></i><span class="mono">{{ o.caducidad ? dmy(o.caducidad) : 'Sin caducidad' }}</span> <span class="muted">· lote {{ o.lote }} · {{ cant(o.cantidad) }}@if (o.estatus === 'pending_authorization') { · por autorizar }@if (o.estatus === 'rejected') { · rechazado }</span></span>
                          }
                        } @else {
                          <p-tag [value]="renglonLabel(g.estado)" [severity]="renglonSev(g.estado)" styleClass="ll-tag" />
                        }
                      </td>
                    </tr>
                  </ng-template>
                </p-table>
              </div>
            </section>
          }
        </p-drawer>
      }
    </div>
  `,
  styles: [`
    :host { display:block; }
    .ll-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:.5rem; }
    .ll-head-text { display:flex; flex-wrap:wrap; align-items:baseline; gap:.35rem .75rem; min-width:0; }
    .ll-head-text h1 { margin:0; font-size:var(--fs-h2); font-weight:700; letter-spacing:-.01em; }
    .ll-meta { font-size:var(--fs-xs); color:var(--text-muted); }
    .ll-actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .ll-seg { display:inline-flex; border:1px solid var(--border-color); border-radius:var(--r-sm); overflow:hidden; background:var(--card-bg); }
    .ll-seg-b { height:2.25rem; padding:0 .75rem; border:0; border-left:1px solid var(--border-color); background:transparent; color:var(--text-main); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .ll-seg-b:first-child { border-left:0; }
    .ll-seg-b.on { background:var(--text-main); color:var(--card-bg); }
    .ll-kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(11rem, 1fr)); gap:.5rem; margin-bottom:.75rem; }
    .ll-kpi { position:relative; display:flex; flex-direction:column; align-items:flex-start; gap:.1rem; padding:.55rem .75rem .6rem .9rem; text-align:left; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); color:var(--text-main); font:inherit; cursor:pointer; min-width:0; }
    .ll-kpi::before { content:''; position:absolute; left:0; top:.6rem; bottom:.6rem; width:3px; border-radius:0 3px 3px 0; background:transparent; }
    .ll-kpi-bad::before { background:var(--bad-fg); }
    .ll-kpi-warn::before { background:var(--warn-fg); }
    .ll-kpi-ok::before { background:var(--ok-fg); }
    .ll-kpi.on { border-color:var(--text-main); box-shadow:inset 0 0 0 1px var(--text-main); }
    .ll-kpi-l { font-size:var(--fs-xs); color:var(--text-muted); font-weight:500; }
    .ll-kpi-v { font-size:var(--fs-h2); font-weight:700; line-height:1.1; }
    .ll-kpi-bad .ll-kpi-v { color:var(--bad-fg); }
    .ll-kpi-s { font-size:var(--fs-xs); color:var(--text-muted); }
    .ll-seg-b:focus-visible, .ll-kpi:focus-visible, .ll-link:focus-visible, .ll-legend summary:focus-visible { outline:2px solid var(--action-ring); outline-offset:1px; }
    .ll-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; }
    .ll-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .ll-bh h2 { font-size:var(--fs-sm); font-weight:700; margin:0; }
    .ll-filters { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
    :host ::ng-deep .ll-sel { min-width:10rem; }
    .ll-q { min-width:14rem; height:2.25rem; }
    :host ::ng-deep .ll-row td:first-child { box-shadow:inset 3px 0 0 transparent; }
    :host ::ng-deep .ll-row-sin_abrir td:first-child { box-shadow:inset 3px 0 0 var(--bad-fg); }
    :host ::ng-deep .ll-row-a_medias td:first-child { box-shadow:inset 3px 0 0 var(--warn-fg); }
    :host ::ng-deep .ll-row-completa td:first-child { box-shadow:inset 3px 0 0 var(--ok-fg); }
    :host ::ng-deep .ll-tag { font-size:var(--fs-nano); }
    .ll-sub { display:block; font-size:var(--fs-xs); }
    .ll-dia { margin-left:.35rem; padding:0 .3rem; border:1px solid var(--border-color); border-radius:var(--r-sm); font-size:var(--fs-micro); color:var(--text-muted); }
    .ll-trunc { display:block; max-width:20rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ll-bar { display:block; width:7rem; height:.4rem; border-radius:var(--r-pill); background:var(--surface-ground); border:1px solid var(--border-color); overflow:hidden; margin:.3rem 0 .15rem; }
    .ll-bar-f { display:block; height:100%; background:var(--ok-fg); }
    .ll-bar-parcial .ll-bar-f { background:var(--warn-fg); }
    .ll-bar-cero { border-color:var(--bad-fg); }
    .ll-dots { display:inline-flex; gap:.55rem; font-size:var(--fs-xs); white-space:nowrap; }
    .ll-dot { display:inline-block; width:.5rem; height:.5rem; border-radius:50%; margin-right:.2rem; background:var(--text-faint); }
    .ll-dot-g { background:var(--ok-fg); }
    .ll-dot-y { background:var(--warn-fg); }
    .ll-dot-r { background:var(--bad-fg); }
    .ll-dot-n { background:var(--text-faint); }
    .ll-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .ll-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .ll-legend { margin-top:.75rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); padding:.5rem .85rem; font-size:var(--fs-sm); color:var(--text-muted); }
    .ll-legend summary { cursor:pointer; color:var(--text-main); font-weight:600; }
    .ll-legend ul { margin:.5rem 0 .25rem; padding-left:1.1rem; display:flex; flex-direction:column; gap:.3rem; }
    .ll-legend b { color:var(--text-main); }
    .ll-det-head { display:flex; align-items:center; gap:.6rem; font-size:var(--fs-sm); }
    .ll-frase { margin:.6rem 0 0; font-size:var(--fs-sm); }
    .ll-frase-bad, .ll-bad { color:var(--bad-fg); }
    .ll-step { padding:.7rem 0; border-top:1px solid var(--border-color); margin-top:.7rem; }
    .ll-step h3 { font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .ll-r { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .ll-r > span:first-child { color:var(--text-muted); flex:none; }
    .ll-r > span:last-child { text-align:right; min-width:0; }
    .ll-lote { display:block; font-size:var(--fs-xs); white-space:nowrap; }
    .ll-lote-x { text-decoration:line-through; color:var(--text-muted); }
    :host ::ng-deep .ll-lines .p-datatable-tbody > tr > td, :host ::ng-deep .ll-lines .p-datatable-thead > tr > th { padding:.3rem .4rem; font-size:var(--fs-xs); }
    :host ::ng-deep .ll-lines .ll-trunc { max-width:16rem; font-size:var(--fs-sm); }
    .ta-r { text-align:right !important; }
    .num, .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .muted { color:var(--text-muted); }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
    .ll-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .ll-errbox .pi { color:var(--bad-fg); }
    .ll-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .ll-skeleton { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-4); }
    .ll-skel-row { height:var(--row-h-md); border-radius:var(--r-sm); background:var(--hover-bg); }
  `],
})
export class AlmacenLlegadasComponent implements OnInit {
  private readonly api = inject(ReceivingSessionService);
  private readonly destroyRef = inject(DestroyRef);

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;
  readonly periodos: { key: PeriodoLlegadas; label: string }[] = [
    { key: 'hoy', label: 'Hoy' },
    { key: 'ayer', label: 'Ayer' },
    { key: '7d', label: 'Últimos 7 días' },
  ];
  readonly origenOpts = [
    { label: 'Todo origen', value: null },
    { label: 'Proveedor', value: 'compra' },
    { label: 'Traspaso', value: 'traspaso' },
    { label: 'Vale manual', value: 'manual' },
  ];

  readonly data = signal<AndenLlegadas | null>(null);
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly periodo = signal<PeriodoLlegadas>('hoy');
  readonly estado = signal<AndenLlegadaEstado | null>(null);
  readonly sucursal = signal<string | null>(null);
  readonly origen = signal<AndenLlegada['tipo'] | null>(null);
  readonly q = signal('');
  readonly sel = signal<AndenLlegada | null>(null);

  /** Lo del periodo, la sucursal, el origen y la búsqueda. El estado se filtra aparte: los mosaicos cuentan sin él. */
  private readonly filtradas = computed<AndenLlegada[]>(() => {
    const d = this.data();
    if (!d) return [];
    const suc = this.sucursal();
    const ori = this.origen();
    const base = d.llegadas.filter(
      (l) => enPeriodo(l, this.periodo(), d.hoy) && (!suc || l.warehouse_code === suc) && (!ori || l.tipo === ori),
    );
    return filtrarPorBusqueda(base, this.q(), (l) => [
      l.documento, l.proveedor, l.origen_nombre, l.origen_code, l.warehouse_code, l.warehouse_name, l.vale?.folio, l.vale?.abierto_por,
      ...l.renglones.flatMap((g) => [g.sku, g.nombre]),
    ]);
  });

  readonly resumen = computed(() => resumirLlegadas(this.filtradas(), this.data()?.hoy ?? ''));

  readonly filas = computed<AndenLlegada[]>(() => {
    const e = this.estado();
    return ordenarLlegadas(this.filtradas().filter((l) => !e || l.estado === e));
  });

  readonly sucursalOpts = computed(() => {
    const vistas = new Map<string, string>();
    for (const l of this.data()?.llegadas ?? []) if (l.warehouse_code) vistas.set(l.warehouse_code, l.warehouse_name || '');
    return [
      { label: 'Todas las sucursales', value: null as string | null },
      ...[...vistas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, name]) => ({ label: `${code} ${name}`.trim(), value: code as string | null })),
    ];
  });

  readonly hayFiltros = computed(() => !!(this.estado() || this.sucursal() || this.origen() || this.q().trim()));

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    this.api.llegadas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        // Si el camión elegido sigue en la lista, se queda elegido con sus datos nuevos.
        const s = this.sel();
        this.sel.set(s ? d.llegadas.find((l) => l.clave === s.clave) ?? null : null);
        this.loading.set(false);
      },
      error: (e: { status?: number }) => {
        this.loading.set(false);
        this.err.set(e?.status === 403 ? 'No tienes permiso para ver las llegadas.' : 'No se pudieron leer las llegadas. Revisa la conexión y vuelve a intentar.');
      },
    });
  }

  toggle(e: AndenLlegadaEstado): void { this.estado.set(this.estado() === e ? null : e); }

  limpiar(): void {
    this.estado.set(null);
    this.sucursal.set(null);
    this.origen.set(null);
    this.q.set('');
  }

  estadoLabel(e: AndenLlegadaEstado): string { return ESTADO[e].label; }
  estadoSev(e: AndenLlegadaEstado): Sev { return ESTADO[e].sev; }
  renglonLabel(e: AndenLlegadaRenglonEstado): string { return RENGLON[e].label; }
  renglonSev(e: AndenLlegadaRenglonEstado): Sev { return RENGLON[e].sev; }
  tipoLabel(t: AndenLlegada['tipo']): string { return TIPO[t]; }

  deQuien(l: AndenLlegada): string {
    if (l.tipo === 'compra') return l.proveedor || 'Proveedor sin nombre';
    if (l.tipo === 'traspaso') return `Traspaso de ${l.origen_code ?? '—'} ${l.origen_nombre ?? ''}`.trim();
    return 'Vale manual';
  }

  /** La hora en México, en 24 h. */
  hora(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /** El día de México de un instante ISO (`YYYY-MM-DD`). */
  diaMx(iso: string): string {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  }

  diaTexto(dia: string | null, hoy: string): string {
    if (!dia) return '—';
    if (dia === hoy) return 'hoy';
    if (dia === diaAnterior(hoy)) return 'ayer';
    return dmy(dia).slice(0, 5);
  }

  pct(l: AndenLlegada): number {
    return l.resumen.renglones ? Math.round((100 * l.resumen.listos) / l.resumen.renglones) : 0;
  }

  cant(n: number): string {
    return Number(n).toLocaleString('es-MX', { maximumFractionDigits: 3 });
  }

  unidad(g: AndenLlegadaRenglon): string {
    return g.unidad && g.unidad !== 'ambigua' ? g.unidad : '';
  }

  /** El color del lote: verde, amarillo, rojo; gris si va sin caducidad. */
  punto(o: AndenLlegadaLote): 'g' | 'y' | 'r' | 'n' {
    if (!o.caducidad) return 'n';
    return o.semaforo === 'green' ? 'g' : o.semaforo === 'yellow' ? 'y' : 'r';
  }

  frase(x: AndenLlegada): string {
    const f = x.resumen.faltan;
    const rojos = x.resumen.por_autorizar ? ` ${x.resumen.por_autorizar === 1 ? 'Un lote en rojo espera' : `${x.resumen.por_autorizar} lotes en rojo esperan`} autorización.` : '';
    if (x.estado === 'sin_abrir') {
      return `Kepler ya le dio entrada y nadie abrió el vale en el Andén: ${x.resumen.renglones === 1 ? 'el renglón entró' : `los ${x.resumen.renglones} renglones entraron`} al inventario sin caducidad.`;
    }
    if (x.estado === 'en_camino') return `Salió de ${x.origen_code ?? ''} ${x.origen_nombre ?? ''} y todavía no se recibe.`.replace(/\s+/g, ' ');
    if (x.estado === 'a_medias' && x.vale?.cerrado_en) return `El vale se cerró con ${f === 1 ? 'un renglón' : `${f} renglones`} sin caducidad. Están en Por fechar.${rojos}`;
    if (x.estado === 'a_medias') return `El vale sigue abierto: ${f === 1 ? 'falta un renglón' : `faltan ${f} renglones`} por fechar.${rojos}`;
    return `Ningún renglón espera fecha.${x.resumen.sin_caducidad ? ` ${x.resumen.sin_caducidad === 1 ? 'Uno se declaró' : `${x.resumen.sin_caducidad} se declararon`} sin caducidad.` : ''}${rojos}`;
  }
}
