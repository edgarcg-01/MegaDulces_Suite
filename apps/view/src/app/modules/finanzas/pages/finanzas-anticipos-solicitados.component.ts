import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import type { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import {
  diasEnEtapa, embudoAnticipos, ETAPA_ANTICIPO_TEXTO, faltaCancelarAnticipo, partirMotivo, PASOS_EMBUDO_ANTICIPO, PERMISOS_PEDIR_ANTICIPO,
  type AnticipoKeplerSinSolicitudRow, type AnticipoSolicitadoRow, type EtapaSolicitudAnticipo, type PasoEmbudoAnticipo,
} from '@megadulces/contracts';
import { environment } from '../../../../environments/environment';
import { PermissionsService } from '../../../core/services/permissions.service';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarUrl } from '../../../shared/util/abrir-pdf';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { PagosTabsComponent } from '../pagos-tabs.component';
import { PedirAnticipoDialogComponent } from '../components/pedir-anticipo-dialog.component';
import { PAGO_PROVEEDOR_TABS } from '../../compras/pago-proveedor-tabs';

type Filtro = PasoEmbudoAnticipo | 'cancelado' | null;
type Vista = 'fecha' | 'proveedor';
const PERIODOS = [30, 90, 180] as const;
const PLURAL: Record<PasoEmbudoAnticipo, string> = {
  por_programar: 'Solicitados', programado: 'Programados', pagado: 'Cubiertos', en_kepler: 'En Kepler', aplicado: 'Aplicados',
};

/**
 * `[PGP.144]` **Anticipos solicitados — el embudo de lo que pide Compras** (Francisco, 2026-11-17): *«hoy no hay
 * trazabilidad: Compras hace la orden de compra, le pide la cotización al proveedor, lanza una firma de Finanzas
 * y espera que lo agreguen manualmente»*. Esto lo sustituye; esta pestaña es su control.
 *
 * Contesta UNA pregunta: *¿dónde se atoran los anticipos que pidió Compras?* El embudo (Solicitado → Programado →
 * Cubierto → En Kepler → Aplicado) dice cuántos llegaron a cada paso y cuántos siguen ahí; cada tarjeta filtra la
 * lista a los que están en ese paso. Fuera del embudo: lo que Kepler tiene sin solicitud (se pagó por fuera).
 *
 * Diseño (skill `diseno` §0a/§0b) en `FASE_PGP_PAGO_A_PROVEEDOR.md` §«[PGP.144]». Primario = el embudo y su
 * veredicto; secundario = la lista (por fecha o por proveedor); terciario = la OC, el folio de Kepler, quién pidió.
 * Vive en Pagos (D17); Compras entra por su puerta (`/compras/anticipos-solicitados`) con sus pestañas.
 */
@Component({
  selector: 'app-finanzas-anticipos-solicitados',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, TableModule, TagModule, DialogModule, ToastModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent, PageTabsComponent, SegmentedComponent, ContextHelpComponent, SucursalPipe,
    PagosTabsComponent, PedirAnticipoDialogComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast />
    @if (deCompras) { <app-page-tabs [tabs]="tabsCompras" /> } @else { <app-pagos-tabs /> }
    <div class="surf-page as-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="surf-page-title">Anticipos solicitados <app-context-help topic="embudo-anticipos" /></h1>
          <p class="surf-page-sub">Lo que pide Compras, de la solicitud al anticipo aplicado en Kepler: dónde se atora cada uno.</p>
        </div>
        <div class="as-head-actions">
          @if (puedePedir()) {
            <button pButton type="button" class="p-button-sm" (click)="pedir.abrir()"><span class="pi pi-plus" aria-hidden="true"></span>&nbsp;Pedir anticipo</button>
          }
          <app-freshness-pill measures="fetch" [since]="cargadoEn()" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()" (click)="cargar()" aria-label="Volver a leer">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <section class="as-body">
        <div class="as-periodo">
          <app-segmented [options]="periodoOpts" [value]="'' + dias()" (valueChange)="cambiarPeriodo($event)" ariaLabel="Periodo: solicitudes pedidas en los últimos días" />
          <span class="as-muted">Solicitudes pedidas y anticipos de Kepler de los últimos {{ dias() }} días.</span>
        </div>

        <app-load-state [loading]="loading()" [error]="error()" [skeletonRows]="6" [isEmpty]="!loading() && !error() && !enPeriodo().length && !keplerSin().length"
          errorTitle="No se pudieron leer los anticipos solicitados" emptyTitle="Sin anticipos solicitados"
          [emptyHint]="'Ni Compras pidió anticipos ni Kepler tiene anticipos de mercancía en los últimos ' + dias() + ' días.'" (retry)="cargar()"></app-load-state>

        @if (!loading() && !error()) {
          <p class="as-veredicto">{{ veredicto() }}</p>
          <!-- El embudo: cada tarjeta es un paso. La cifra = los que LLEGARON; la barra = qué parte de lo solicitado;
               al pie, los que siguen AHÍ. Al tocarla, la lista muestra sólo ésos (otra vez, la quita). -->
          <app-metric-strip mode="bullet" [items]="pasosItems()" [instant]="true" [selected]="filtroPaso()"
                            (drill)="alternarPaso($event)" ariaLabel="Embudo de anticipos solicitados" />
          <p class="as-fuera">
            <span class="as-muted">Fuera del embudo:</span>
            @if (keplerError()) {
              <span>no se pudo leer lo que Kepler tiene sin solicitud. <button pButton type="button" class="p-button-sm p-button-text" (click)="cargarKepler()">Reintentar</button></span>
            } @else if (keplerCargando()) {
              <span class="as-muted">leyendo Kepler…</span>
            } @else {
              <a class="as-link" href="#as-kepler" (click)="irAKepler($event)">{{ keplerSin().length }} en Kepler sin solicitud ({{ money(sumaKepler()) }})</a>
            }
            @if (embudo().cancelados.n) {
              · <button type="button" class="as-link-btn" [attr.aria-pressed]="filtroPaso() === 'cancelado'" (click)="alternarPaso('cancelado')">{{ embudo().cancelados.n }} cancelado{{ embudo().cancelados.n === 1 ? '' : 's' }} ({{ money(embudo().cancelados.monto) }})</button>
            }
          </p>

          <div class="as-filtros">
            <label class="sr-only" for="as-q">Buscar proveedor, OC o folio de Kepler</label>
            <input id="as-q" pInputText type="search" enterkeyhint="search" autocomplete="off" class="as-q"
                   placeholder="Buscar proveedor, OC o folio de Kepler" [ngModel]="q()" (ngModelChange)="q.set($event); ponerEnUrl()" />
            <app-segmented [options]="vistaOpts" [value]="vista()" (valueChange)="cambiarVista($event)" ariaLabel="Ordenar la lista por fecha o agrupar por proveedor" />
            @if (filtroPaso(); as f) {
              <span class="as-chip">{{ textoFiltro(f) }} <button type="button" class="as-link-btn" (click)="alternarPaso(f)" [attr.aria-label]="'Quitar el filtro ' + textoFiltro(f)">✕</button></span>
            }
            <span class="as-count">{{ visibles().length }} de {{ enPeriodo().length }}</span>
          </div>

          <div class="dt-scope">
            <p-table [value]="visibles()" size="small" class="dt-stack surf-table surf-table--plain as-table"
                     [rowGroupMode]="vista() === 'proveedor' ? 'subheader' : undefined" groupRowsBy="proveedor_nombre">
              <!-- ⚠️ Con subheader, p-table ordena SOLO el arreglo por la columna del grupo: por eso se agrupa por el
                   NOMBRE (el mismo orden que arma visibles()); por código, CA001 iba antes que CHOCOLATES. -->
              <ng-template #header>
                <tr><th>Pedido</th><th>Proveedor</th><th>Sucursal · OC</th><th class="comm-num">Importe</th><th>Pago</th><th>Etapa</th><th>Kepler (X-D-60)</th>
                  <th><span class="sr-only">Acciones</span></th></tr>
              </ng-template>
              <ng-template #groupheader let-s>
                <tr class="as-grupo"><td colspan="8"><b>{{ s.proveedor_nombre }}</b>&nbsp;<span class="as-muted">{{ s.proveedor }}</span>
                  <span class="as-muted"> · {{ resumenProveedor(s.proveedor) }}</span></td></tr>
              </ng-template>
              <ng-template #body let-s>
                <tr>
                  <td role="cell" data-label="Pedido"><div>{{ fecha(s.creado) }}</div><div class="as-muted">{{ s.creado_por || 'sin nombre' }}@if (motivoDe(s); as m) { · {{ m }}}</div></td>
                  <td role="cell" data-label="Proveedor"><div class="as-strong">{{ s.proveedor_nombre }}</div><div class="as-muted">{{ s.proveedor }}</div></td>
                  <td role="cell" data-label="Sucursal · OC">{{ s.sucursal | sucursal }}@if (ocsTexto(s); as t) {<div class="as-muted">{{ t }}</div>}</td>
                  <td role="cell" data-label="Importe" class="comm-num as-strong">{{ money2(s.monto) }}</td>
                  <td role="cell" data-label="Pago">{{ pagoTexto(s) }}
                    <!-- [PGP.127] La cuenta, derivada del catálogo: aprobada, esperando a Dirección, rechazada o efectivo. -->
                    @if (cuentaTexto(s); as c) {<div class="as-muted" [class.as-alerta]="cuentaAlerta(s)">{{ c }}</div>}</td>
                  <td role="cell" data-label="Etapa"><p-tag [value]="etapaTexto(s.etapa)" [severity]="etapaTono(s.etapa)" />
                    @if (diasDe(s); as d) {<div class="as-muted" [class.as-alerta]="atorado(s)">{{ d }} {{ d === 1 ? 'día' : 'días' }} aquí</div>}</td>
                  <td role="cell" data-label="Kepler (X-D-60)">
                    @if (s.kepler; as k) {
                      <div>{{ k.folio }} · {{ fecha(k.fecha) }}</div>
                      <div class="as-muted">{{ money2(k.importe) }}@if (s.etapa === 'en_kepler') { · por aplicar {{ money2(k.remanente) }}}</div>
                      @if (s.posibles > 1) {<div class="as-muted">{{ s.posibles }} anticipos de Kepler podían ser: se tomó el de fecha más cercana.</div>}
                    } @else if (s.etapa === 'pagado') {
                      <span class="as-alerta">Cubierto sin anticipo en Kepler</span>
                    } @else { <span class="as-muted">—</span> }
                  </td>
                  <td role="cell" data-label="Acciones">
                    @if (s.tiene_cotizacion) {
                      <button pButton type="button" class="p-button-sm p-button-text" (click)="verCotizacion(s)"
                              [attr.aria-label]="'Ver la cotización del anticipo de ' + s.proveedor_nombre"><i class="pi pi-file" aria-hidden="true"></i>&nbsp;Cotización</button>
                    }
                    @if (puedePedir() && s.etapa === 'por_programar') {
                      <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="abrirCancelar(s)"
                              [attr.aria-label]="'Cancelar el anticipo de ' + s.proveedor_nombre + ' por ' + money2(s.monto)">Cancelar</button>
                    }
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="8" class="as-vacio">
                  @if (filtroPaso() || q()) { Ningún anticipo solicitado con este filtro. <button type="button" class="as-link-btn" (click)="limpiar()">Quitar filtros</button> }
                  @else { Compras no pidió anticipos en los últimos {{ dias() }} días. }
                </td></tr>
              </ng-template>
            </p-table>
          </div>

          <!-- Fuera del embudo: lo que Kepler tiene y nadie pidió en la Suite. -->
          <h2 class="as-h2" id="as-kepler" tabindex="-1">En Kepler sin solicitud en la Suite <span class="as-count">{{ keplerVisibles().length }} · {{ money(sumaKepler()) }}</span></h2>
          <p class="as-help">Anticipos de mercancía que Cuentas por pagar capturó en Kepler sin que nadie los pidiera aquí: se pagaron por fuera del proceso. Gasto y tarjeta no entran.</p>
          @if (keplerError()) {
            <p class="as-help" role="status">No se pudieron leer. <button pButton type="button" class="p-button-sm p-button-text" (click)="cargarKepler()">Reintentar</button></p>
          } @else if (keplerCargando()) {
            <p class="as-help" aria-live="polite">Leyendo Kepler…</p>
          } @else {
            <div class="dt-scope">
              <p-table [value]="keplerVisibles()" size="small" class="dt-stack surf-table surf-table--plain as-table">
                <ng-template #header>
                  <tr><th>Fecha</th><th>Proveedor</th><th>Sucursal</th><th>Anticipo (X-D-60)</th><th class="comm-num">Importe</th><th class="comm-num">Por aplicar</th><th>Referencia</th></tr>
                </ng-template>
                <ng-template #body let-k>
                  <tr>
                    <td role="cell" data-label="Fecha">{{ fecha(k.fecha) }}</td>
                    <td role="cell" data-label="Proveedor"><div class="as-strong">{{ k.proveedor_nombre || k.proveedor }}</div><div class="as-muted">{{ k.proveedor }}</div></td>
                    <td role="cell" data-label="Sucursal">{{ k.sucursal | sucursal }}</td>
                    <td role="cell" data-label="Anticipo (X-D-60)">{{ k.folio }}</td>
                    <td role="cell" data-label="Importe" class="comm-num">{{ money2(k.importe) }}</td>
                    <td role="cell" data-label="Por aplicar" class="comm-num">{{ k.remanente > 0.005 ? money2(k.remanente) : 'aplicado' }}</td>
                    <td role="cell" data-label="Referencia">{{ k.referencia || 'sin referencia en Kepler' }}</td>
                  </tr>
                </ng-template>
                <ng-template #emptymessage><tr><td colspan="7" class="as-vacio">Kepler no tiene anticipos de mercancía de los últimos {{ dias() }} días sin su solicitud en la Suite.</td></tr></ng-template>
              </p-table>
            </div>
          }
        }
      </section>
    </div>

    <app-pedir-anticipo-dialog #pedir (pedido)="cargar()" />

    <!-- [PGP.126] Cancelar un anticipo solicitado que todavía no tiene pago. Se mudó aquí con la lista (D17). -->
    <p-dialog [visible]="!!cancelando()" (visibleChange)="$event || cerrarCancelar()" [modal]="true" header="Cancelar anticipo solicitado" [style]="{ width: '30rem' }"
              [breakpoints]="{ '640px': '96vw' }">
      @if (cancelando(); as s) {
        <p class="as-help"><b>{{ s.proveedor_nombre }}</b> · {{ money2(s.monto) }} · {{ s.sucursal | sucursal }}@if (ocsTexto(s); as t) { · {{ t }}}.
          Sale del Calendario de pagos y le devuelve ese saldo a su orden de compra.</p>
        <label class="as-label" for="as-canc">Por qué se cancela</label>
        <input id="as-canc" pInputText type="text" autocomplete="off" class="as-full" [ngModel]="cancRazon()" (ngModelChange)="cancRazon.set($event)"
               placeholder="Ej. el proveedor ya no pide anticipo" />
        @if (cancFalta(); as f) { <p class="as-muted" aria-live="polite">{{ f }}</p> }
        <div class="as-acciones">
          <button pButton type="button" class="p-button-text p-button-secondary" (click)="cerrarCancelar()">No cancelar</button>
          <button pButton type="button" class="p-button-danger" [disabled]="!!cancFalta() || cancGuardando()" [loading]="cancGuardando()" (click)="confirmarCancelar()">Cancelar anticipo</button>
        </div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .as-page { display: block; }
    .as-head-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .as-body { padding: var(--sp-3) 1.5rem var(--sp-8); display: block; }
    .as-periodo { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin: 0 0 var(--sp-3); }
    .as-veredicto { font-size: var(--fs-lg); font-weight: 600; color: var(--text-main); margin: 0 0 var(--sp-3); max-width: 72rem; }
    app-metric-strip { display: block; margin: 0 0 var(--sp-2); }
    .as-fuera { font-size: var(--fs-sm); color: var(--text-main); margin: 0 0 var(--sp-4); display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .as-filtros { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin: 0 0 var(--sp-2); }
    .as-q { width: 100%; max-width: 26rem; }
    .as-chip { font-size: var(--fs-sm); color: var(--text-main); display: inline-flex; gap: var(--sp-1); align-items: center; border: 1px solid var(--border-color); border-radius: var(--r-md); padding: 0 var(--sp-2); }
    .as-count { font-size: var(--fs-sm); font-weight: 400; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .as-h2 { font-size: var(--fs-md); font-weight: 600; color: var(--text-main); margin: var(--sp-6) 0 var(--sp-1); display: flex; gap: var(--sp-2); align-items: baseline; }
    .as-help { font-size: var(--fs-sm); color: var(--text-muted); margin: 0 0 var(--sp-2); max-width: 72rem; }
    .as-strong { font-weight: 600; color: var(--text-main); }
    .as-muted { font-size: var(--fs-xs); color: var(--text-muted); }
    .as-alerta { color: var(--warn-soft-fg); font-weight: 600; }
    .as-table { display: block; margin-bottom: var(--sp-2); }
    .as-grupo td { background: var(--surface-hover); font-size: var(--fs-sm); }
    .as-vacio { font-size: var(--fs-sm); color: var(--text-muted); }
    .as-link, .as-link-btn { color: var(--text-main); text-decoration: underline; background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
    .as-link:focus-visible, .as-link-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .as-label { display: block; font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); margin: var(--sp-3) 0 var(--sp-1); }
    .as-full { width: 100%; }
    .as-acciones { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-4); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @container (max-width: 48rem) { .as-body { padding: var(--sp-2) 1rem var(--sp-6); } }
  `],
})
export class FinanzasAnticiposSolicitadosComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly base = `${environment.apiUrl}/commercial/supplier-obligations`;
  private peticion?: Subscription;
  private peticionKepler?: Subscription;

  /** Por qué puerta se entró: Compras ve las pestañas de Pago a proveedor; Finanzas, las de Pagos. */
  readonly deCompras = this.route.snapshot.data?.['puerta'] === 'compras';
  readonly tabsCompras = PAGO_PROVEEDOR_TABS;
  /** Pide (y cancela lo pedido) Compras o Dirección (ADR-120): la MISMA lista que el servidor. Finanzas ve el embudo. */
  readonly puedePedir = computed(() => this.perms.hasAny(...PERMISOS_PEDIR_ANTICIPO));

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly filas = signal<AnticipoSolicitadoRow[]>([]);
  readonly cargadoEn = signal<Date | null>(null);
  readonly keplerSin = signal<AnticipoKeplerSinSolicitudRow[]>([]);
  readonly keplerCargando = signal(true);
  readonly keplerError = signal(false);

  readonly dias = signal<number>(90);
  readonly filtroPaso = signal<Filtro>(null);
  readonly vista = signal<Vista>('fecha');
  readonly q = signal('');
  readonly periodoOpts: SegOption[] = PERIODOS.map((d) => ({ label: `${d} días`, value: String(d) }));
  readonly vistaOpts: SegOption[] = [{ label: 'Por fecha', value: 'fecha' }, { label: 'Por proveedor', value: 'proveedor' }];

  /** Hoy en el calendario de quien mira (México). */
  readonly hoy = this.ymd(new Date());
  /** Las solicitudes PEDIDAS dentro del periodo. */
  readonly enPeriodo = computed(() => {
    const desde = this.restarDias(this.hoy, this.dias());
    return this.filas().filter((s) => s.creado >= desde);
  });
  readonly embudo = computed(() => embudoAnticipos(this.enPeriodo(), this.hoy));
  readonly pasosItems = computed<MetricStripItem[]>(() => this.embudo().pasos.map((p) => ({
    label: PLURAL[p.paso],
    value: p.llegaron.n,
    format: 'number',
    pct: p.pct ?? 0,
    sub: this.subPaso(p.paso, p.llegaron.monto, p.aqui.n, p.aqui.masViejo),
    drill: p.paso,
    drillLabel: `Ver los ${p.aqui.n} que están en «${ETAPA_ANTICIPO_TEXTO[p.paso]}»`,
    ...(p.pct === null ? { state: 'no_medido' as const, stateNote: 'Sin solicitudes en el periodo: no hay porcentaje.' } : {}),
  })));

  /** La lista: las del periodo, filtradas por paso (los que ESTÁN ahí) y por la búsqueda; lo más nuevo primero. */
  readonly visibles = computed(() => {
    const f = this.filtroPaso();
    let xs = this.enPeriodo().filter((s) => !f || s.etapa === f);
    xs = filtrarPorBusqueda(xs, this.q(), (s) => [s.proveedor_nombre, s.proveedor, s.oc_folio, ...(s.ocs ?? []).map((o) => o.folio), s.kepler?.folio, s.creado_por]);
    const orden = [...xs].sort((a, b) => b.creado.localeCompare(a.creado));
    return this.vista() === 'proveedor'
      ? orden.sort((a, b) => a.proveedor_nombre.localeCompare(b.proveedor_nombre) || b.creado.localeCompare(a.creado))
      : orden;
  });
  readonly keplerVisibles = computed(() => filtrarPorBusqueda(this.keplerSin(), this.q(), (k) => [k.proveedor_nombre, k.proveedor, k.folio, k.referencia]));
  readonly sumaKepler = computed(() => this.keplerVisibles().reduce((s, k) => s + Number(k.importe), 0));

  readonly veredicto = computed(() => {
    const vivos = this.enPeriodo().filter((s) => s.etapa !== 'cancelado');
    const d = this.dias();
    if (!vivos.length) return `Compras no pidió anticipos en los últimos ${d} días.`;
    const { pasos } = this.embudo();
    const total = pasos[0].llegaron;
    const cubiertos = pasos[2].llegaron.n;
    // Dónde más se juntan (sin contar «Aplicado», que es el final del embudo).
    const atasco = pasos.slice(0, 4).reduce((m, p) => (p.aqui.n > m.aqui.n ? p : m), pasos[0]);
    const base = `De ${total.n} anticipo${total.n === 1 ? '' : 's'} solicitado${total.n === 1 ? '' : 's'} en ${d} días (${this.money(total.monto)}), ${cubiertos} ya se ${cubiertos === 1 ? 'cubrió' : 'cubrieron'}.`;
    if (!atasco.aqui.n) return `${base} Todos están aplicados en Kepler.`;
    // Programados cuyo día no llega no están atorados: se dice que esperan su día, no «el más viejo de 0 días».
    if (atasco.paso === 'programado' && !atasco.aqui.masViejo) {
      return `${base} ${atasco.aqui.n} ${atasco.aqui.n === 1 ? 'está programado y espera' : 'están programados y esperan'} su día de pago.`;
    }
    const viejo = atasco.aqui.masViejo ? `, el más viejo de ${atasco.aqui.masViejo} ${atasco.aqui.masViejo === 1 ? 'día' : 'días'}` : '';
    return `${base} Donde más se juntan: «${ETAPA_ANTICIPO_TEXTO[atasco.paso]}» (${atasco.aqui.n}${viejo}).`;
  });

  // ── `[PGP.126]` Cancelar un solicitado sin pago (se mudó aquí con la lista, D17) ──
  readonly cancelando = signal<AnticipoSolicitadoRow | null>(null);
  readonly cancRazon = signal('');
  readonly cancGuardando = signal(false);
  readonly cancFalta = computed<string | null>(() => { const s = this.cancelando(); return s ? faltaCancelarAnticipo(s, this.cancRazon()) : null; });

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const d = Number(q.get('dias'));
    if ((PERIODOS as readonly number[]).includes(d)) this.dias.set(d);
    const paso = q.get('paso');
    if (paso && ([...PASOS_EMBUDO_ANTICIPO, 'cancelado'] as string[]).includes(paso)) this.filtroPaso.set(paso as Filtro);
    if (q.get('vista') === 'proveedor') this.vista.set('proveedor');
    const buscar = q.get('q');
    if (buscar) this.q.set(buscar.slice(0, 80));
    this.cargar();
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.peticion?.unsubscribe();
    this.peticion = this.http.get<AnticipoSolicitadoRow[]>(`${this.base}/anticipos`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.filas.set(r ?? []); this.loading.set(false); this.cargadoEn.set(new Date()); },
      error: (e) => { this.filas.set([]); this.loading.set(false); this.error.set(e?.error?.message || 'Error del servidor'); },
    });
    this.cargarKepler();
  }
  /** Lo de Kepler va aparte: si falla, el embudo sigue y la sección lo dice (no «0 sin solicitud»). */
  cargarKepler(): void {
    this.keplerCargando.set(true);
    this.keplerError.set(false);
    this.peticionKepler?.unsubscribe();
    this.peticionKepler = this.http.get<AnticipoKeplerSinSolicitudRow[]>(`${this.base}/anticipos/kepler-sin-solicitud`, { params: { dias: String(this.dias()) } })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.keplerSin.set(r ?? []); this.keplerCargando.set(false); },
        error: () => { this.keplerSin.set([]); this.keplerCargando.set(false); this.keplerError.set(true); },
      });
  }

  cambiarPeriodo(v: string): void {
    const d = Number(v);
    if (!(PERIODOS as readonly number[]).includes(d) || d === this.dias()) return;
    this.dias.set(d);
    this.ponerEnUrl();
    this.cargarKepler();
  }
  cambiarVista(v: string): void { this.vista.set(v === 'proveedor' ? 'proveedor' : 'fecha'); this.ponerEnUrl(); }
  /** La tarjeta del paso filtra a los que están AHÍ; tocarla otra vez quita el filtro. */
  alternarPaso(p: string): void {
    const f = p as Filtro;
    this.filtroPaso.set(this.filtroPaso() === f ? null : f);
    this.ponerEnUrl();
  }
  limpiar(): void { this.filtroPaso.set(null); this.q.set(''); this.ponerEnUrl(); }
  irAKepler(ev: Event): void {
    ev.preventDefault();
    const h = document.getElementById('as-kepler');
    h?.scrollIntoView({ block: 'start' });
    h?.focus();
  }
  /** El estado de la lista viaja en la URL: se puede mandar «mira éstos» por chat. */
  ponerEnUrl(): void {
    void this.router.navigate([], { relativeTo: this.route, replaceUrl: true, queryParamsHandling: 'merge',
      queryParams: { dias: this.dias() === 90 ? null : this.dias(), paso: this.filtroPaso(), vista: this.vista() === 'proveedor' ? 'proveedor' : null, q: this.q().trim() || null } });
  }

  textoFiltro(f: Exclude<Filtro, null>): string { return f === 'cancelado' ? 'Cancelados' : `En «${ETAPA_ANTICIPO_TEXTO[f]}»`; }
  etapaTexto(e: EtapaSolicitudAnticipo): string { return ETAPA_ANTICIPO_TEXTO[e]; }
  etapaTono(e: EtapaSolicitudAnticipo): 'warn' | 'info' | 'success' | 'secondary' {
    return e === 'por_programar' ? 'warn' : e === 'aplicado' ? 'success' : e === 'cancelado' ? 'secondary' : 'info';
  }
  diasDe(s: AnticipoSolicitadoRow): number | null { return diasEnEtapa(s, this.hoy); }
  /** Atorado: lleva más de una semana en su paso (Solicitado, Cubierto) o su día de pago ya pasó (Programado). */
  atorado(s: AnticipoSolicitadoRow): boolean {
    const d = this.diasDe(s);
    if (d === null) return false;
    return s.etapa === 'programado' ? d > 0 : (s.etapa === 'por_programar' || s.etapa === 'pagado') && d > 7;
  }
  pagoTexto(s: AnticipoSolicitadoRow): string {
    switch (s.etapa) {
      case 'por_programar': return s.fecha_deseada ? `Pedido para el ${this.fecha(s.fecha_deseada)}` : 'Sin día pedido';
      case 'programado': return s.programado_dia ? `En el pago del ${this.fecha(s.programado_dia)}` : 'Programado';
      case 'pagado': case 'en_kepler': case 'aplicado': return s.cubierto_el ? `Cubierto el ${this.fecha(s.cubierto_el)}` : 'Cubierto (sin fecha de pago en la Suite)';
      case 'cancelado': { const c = partirMotivo(s.motivo).cancelacion; return c ? `Cancelado: ${c}` : 'Cancelado'; }
    }
  }
  /** El motivo del pedido, sin la razón de la cancelación (que va en «Pago»). */
  motivoDe(s: AnticipoSolicitadoRow): string | null { return partirMotivo(s.motivo).motivo; }
  /** `[PGP.127]` La cuenta en llano; los pedidos de antes de PGP.127 no dicen nada (no la traían). */
  cuentaTexto(s: AnticipoSolicitadoRow): string | null {
    const c = s.cuenta;
    if (!c) return null;
    const fin = c.clabe ? `${c.banco ? c.banco + ' · ' : ''}CLABE terminación ${c.clabe.slice(-4)}` : '';
    switch (c.estado) {
      case 'aprobada': return `A ${fin} (aprobada).`;
      case 'en_aprobacion': return `A ${fin}: espera la aprobación de Dirección en Cuentas de pago.`;
      case 'rechazada': return `Dirección rechazó la CLABE ${fin}: pídele al proveedor otra cuenta.`;
      case 'sin_cuenta': return `La CLABE ${fin} ya no está aprobada: hay que pedir su alta otra vez.`;
      case 'efectivo': return 'En efectivo.';
      case 'sin_dato': return null;
    }
  }
  cuentaAlerta(s: AnticipoSolicitadoRow): boolean { return s.cuenta?.estado === 'rechazada' || s.cuenta?.estado === 'sin_cuenta'; }
  ocsTexto(s: AnticipoSolicitadoRow): string | null {
    const k = (s.ocs ?? []).map((o) => o.folio);
    if (k.length) return `OC ${k.join(', ')}`;
    return s.oc_folio ? `OC ${s.oc_folio}` : null;
  }
  /** Por proveedor: cuántos, cuánto y cuánto ya cubierto, sobre lo que está a la vista. */
  resumenProveedor(codigo: string): string {
    const xs = this.visibles().filter((s) => s.proveedor === codigo);
    const vivos = xs.filter((s) => s.etapa !== 'cancelado');
    const cub = vivos.filter((s) => ['pagado', 'en_kepler', 'aplicado'].includes(s.etapa));
    const sum = (ys: AnticipoSolicitadoRow[]) => ys.reduce((t, s) => t + Number(s.monto), 0);
    return `${vivos.length} solicitado${vivos.length === 1 ? '' : 's'} por ${this.money(sum(vivos))} · cubierto ${this.money(sum(cub))}`;
  }
  private subPaso(paso: PasoEmbudoAnticipo, monto: number, aqui: number, viejo: number | null): string {
    const m = this.money(monto);
    if (paso === 'aplicado') return `${m} · terminados`;
    return `${m} · ${aqui} aquí${aqui && viejo ? ` · el más viejo ${viejo} d` : ''}`;
  }

  verCotizacion(s: AnticipoSolicitadoRow): void {
    const win = abrirPestanaParaPdf('Abriendo la cotización…');
    this.http.get<{ url: string }>(`${this.base}/anticipos/${s.obligation_id}/cotizacion`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => entregarUrl(win, r.url),
      error: (e) => { cerrarPestanaDePdf(win); this.toast.add({ severity: 'error', summary: 'No se abrió la cotización', detail: e?.error?.message || 'Intenta de nuevo.' }); },
    });
  }
  abrirCancelar(s: AnticipoSolicitadoRow): void { this.cancRazon.set(''); this.cancelando.set(s); }
  cerrarCancelar(): void { this.cancelando.set(null); }
  confirmarCancelar(): void {
    const s = this.cancelando();
    if (!s || this.cancFalta() || this.cancGuardando()) return;
    this.cancGuardando.set(true);
    this.http.post(`${this.base}/anticipos/${s.obligation_id}/cancelar`, { reason: this.cancRazon().trim() }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.cancGuardando.set(false); this.cancelando.set(null); this.cargar();
        this.toast.add({ severity: 'success', summary: 'Anticipo cancelado', detail: `${s.proveedor_nombre}: ${this.money2(s.monto)}. Ya no está en el Calendario de pagos.` });
      },
      error: (e) => {
        this.cancGuardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se canceló el anticipo', detail: e?.error?.message || 'Intenta de nuevo en un momento.', life: 10000 });
      },
    });
  }

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  private restarDias(ymd: string, n: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return this.ymd(new Date(y, m - 1, d - n));
  }
  fecha(ymd: string): string {
    const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
    const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
    return `${d}-${mes}${y !== new Date().getFullYear() ? `-${y}` : ''}`;
  }
  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  money2(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
