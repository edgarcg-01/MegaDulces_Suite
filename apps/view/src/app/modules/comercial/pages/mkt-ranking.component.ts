import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { catchError, firstValueFrom, forkJoin, of } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PROMOS_TABS } from '../promos-tabs';
import {
  CANALES, CANAL_CORTO, Canal, MktRankingService, ParticipanteRanking, RankingSemana, moverSemana, pct, textoSemana,
  textoVentaProducto, textoProductos,
} from '../mkt-ranking.service';
import { pdfRanking } from '../mkt-ranking-pdf';

/**
 * `[MKT.11]` **Ranking de promociones** — reemplaza el Excel «RANKING SEMANA NN» de Mercadotecnia.
 *
 * Propósito (una pregunta): ¿quién cumplió las promociones de la semana y quién no?
 * Entra Mercadotecnia el lunes con la semana cerrada; Dirección consulta.
 *
 * Jerarquía: primario = el lugar y el cubrimiento de cada fila; secundario = cumplidas, sin venta y
 * sin objetivo; terciario = la clave del vendedor y la nota del método.
 *
 * Desglose: la fila abre el detalle por promoción (objetivo, venta, cubrimiento, regalos en
 * existencia y el aviso de un código que Kepler reutilizó). «Sin objetivo» lleva a capturarlos.
 * Dar de alta y fijar objetivos vive en «Objetivos» (otra pregunta: qué se mide y contra qué).
 */
@Component({
  selector: 'app-mkt-ranking',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TableModule, TagModule, ButtonModule, InputTextModule, ToastModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page rk">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ranking de promociones <app-context-help topic="mkt-ranking" /></h1>
          <p class="surf-page-sub">Quién cumplió las promociones de la semana. Sale solo de Kepler: ya no hay que capturar la venta.</p>
        </div>
        <div class="rk-acciones">
          <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="900"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm" (click)="pdf()" [disabled]="generando() || !datos()" [loading]="generando()">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">Reporte PDF</span>
          </button>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" />

      <div class="rk-filtros">
        <div class="rk-semana" role="group" aria-label="Semana">
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(-1)" aria-label="Semana anterior">
            <span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="rk-semana-txt">{{ datos() ? semanaTexto() : 'Cargando semana…' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(1)" [disabled]="datos()?.semana?.en_curso" aria-label="Semana siguiente">
            <span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        <app-segmented [options]="opcionesCanal()" [value]="canal()" (valueChange)="elegirCanal($event)" ariaLabel="Canal"></app-segmented>
        <input pInputText type="search" class="rk-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               [placeholder]="canal() === 'mostrador' ? 'Buscar sucursal' : 'Buscar vendedor o sucursal'" aria-label="Buscar en el ranking" />
      </div>

      @if (datos(); as d) {
        <app-metric-strip [items]="kpis()" ariaLabel="Resumen de la semana" (drill)="drill($event)"></app-metric-strip>
        @if (d.semana.en_curso) {
          <p class="rk-nota" role="status"><i class="pi pi-clock" aria-hidden="true"></i> La semana está en curso: la venta llega hasta hoy y el lugar todavía puede cambiar.</p>
        }
      }

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !filas().length"
                      [emptyIcon]="datos()?.promos_vigentes ? 'pi-search' : 'pi-megaphone'"
                      [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                      [emptyCta]="!datos()?.promos_vigentes && puedeGestionar ? 'Dar de alta una promoción' : null"
                      (cta)="irAObjetivos()" (retry)="res.reload()">
        <p-table [value]="filas()" dataKey="clave" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th class="comm-num rk-col-lugar">Lugar</th>
              <th>{{ canal() === 'mostrador' ? 'Sucursal' : 'Vendedor' }}</th>
              <th class="rk-col-cub">Cubrimiento</th>
              <th class="comm-num">Cumplidas</th>
              <th class="comm-num">Sin venta</th>
              <th class="comm-num">Sin objetivo</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p" [attr.aria-label]="'Ver las promociones de ' + p.nombre">
              <td class="comm-num rk-lugar" data-label="Lugar">{{ p.lugar ?? '—' }}</td>
              <td data-label="Quién">
                <span class="rk-nombre">{{ p.nombre }}</span>
                @if (canal() !== 'mostrador') { <span class="rk-tenue">{{ p.warehouse_name }}</span> }
              </td>
              <td class="rk-col-cub" data-label="Cubrimiento">
                @if (p.puntaje !== null) {
                  <div class="rk-barra" aria-hidden="true"><span [style.width.%]="p.puntaje * 100" [class.ok]="p.puntaje >= 0.9" [class.bajo]="p.puntaje < 0.5"></span></div>
                  <span class="rk-pct">{{ pct(p.puntaje) }}</span>
                } @else {
                  <span class="rk-tenue">Sin objetivos: no se puede medir</span>
                }
              </td>
              <td class="comm-num" data-label="Cumplidas">{{ p.cumplidas }} <span class="rk-tenue">de {{ p.con_objetivo }}</span></td>
              <td class="comm-num" data-label="Sin venta">{{ p.sin_venta }}</td>
              <td class="comm-num" data-label="Sin objetivo">@if (p.sin_objetivo) { <p-tag [value]="'' + p.sin_objetivo" severity="warn"></p-tag> } @else { <span class="rk-tenue">—</span> }</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      @if (datos(); as d) {
        <p class="rk-metodo">{{ d.criterio }}</p>
      }

      <app-side-peek [open]="!!abierto()" (openChange)="$event ? null : abierto.set(null)" [width]="760"
                     [title]="abierto()?.nombre ?? ''" [subtitle]="subtitulo()">
        @if (abierto(); as p) {
          <p class="rk-peek-frase">
            @if (p.puntaje !== null) {
              Cubrió en promedio <strong>{{ pct(p.puntaje) }}</strong> de sus objetivos y cumplió <strong>{{ p.cumplidas }} de {{ p.con_objetivo }}</strong> promociones.
            } @else {
              Ninguna de sus promociones tiene objetivo: no tiene lugar en el ranking hasta capturarlos.
            }
            @if (p.sin_objetivo) { {{ p.sin_objetivo }} sin objetivo no cuentan. }
          </p>
          <p-table [value]="p.promos" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr>
                <th>Promoción</th>
                <th class="comm-num">Objetivo</th>
                <th class="comm-num">Venta</th>
                <th class="comm-num">Cubrimiento</th>
                @if (canal() === 'mostrador') { <th class="comm-num">Regalos en existencia</th> }
              </tr>
            </ng-template>
            <ng-template #body let-x>
              <tr>
                <td>
                  <span class="rk-promo">{{ x.mecanica }}</span>
                  <span class="rk-tenue">{{ x.code }}</span>
                  @for (pr of x.productos; track pr.sku) {
                    <span class="rk-producto">{{ textoVentaProducto(pr) }}</span>
                  } @empty {
                    <span class="rk-tenue" [title]="x.productos_nota">{{ textoProductos(x.productos_metodo, []) }}</span>
                  }
                  @if (x.descripcion_distinta) {
                    <span class="rk-aviso"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> Kepler vendió este código con otra descripción: puede ser otra promoción.</span>
                  }
                </td>
                <td class="comm-num">
                  @if (x.objetivo !== null) {
                    {{ x.objetivo | number:'1.0-2' }}
                    @if (x.objetivo_fuente === 'sugerido') { <span class="rk-tenue">sugerido</span> }
                  } @else { <p-tag value="Sin objetivo" severity="warn"></p-tag> }
                </td>
                <td class="comm-num">{{ x.venta | number:'1.0-2' }}</td>
                <td class="comm-num rk-pct">{{ pct(x.cubrimiento) }}</td>
                @if (canal() === 'mostrador') { <td class="comm-num">{{ x.existencia === null ? '—' : (x.existencia | number:'1.0-2') }}</td> }
              </tr>
            </ng-template>
          </p-table>
          @if (puedeGestionar) {
            <div class="rk-peek-acciones">
              <a pButton class="p-button-sm p-button-outlined" routerLink="/mkt/ranking/promociones">
                <span class="p-button-icon p-button-icon-left pi pi-sliders-h" aria-hidden="true"></span><span class="p-button-label">Ajustar objetivos</span></a>
            </div>
          }
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rk-acciones { display: flex; align-items: center; gap: var(--sp-3); }
    .rk-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-4) 0 var(--sp-3); }
    .rk-semana { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .rk-semana-txt { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; min-width: 15rem; text-align: center; }
    .rk-buscar { min-width: 14rem; margin-left: auto; }
    .rk-nota { display: flex; gap: var(--sp-2); align-items: center; color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-2) 0; }
    .rk-col-lugar { width: 4.5rem; }
    .rk-col-cub { min-width: 14rem; }
    .rk-lugar { font-size: var(--fs-lg); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rk-nombre { display: block; font-weight: var(--fw-bold); }
    .rk-producto { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .rk-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .rk-col-cub { white-space: nowrap; }
    .rk-barra { display: inline-block; vertical-align: middle; width: 8rem; height: 0.5rem; border-radius: var(--r-pill); background: var(--overlay-hover); overflow: hidden; margin-right: var(--sp-2); }
    .rk-barra > span { display: block; height: 100%; background: var(--text-muted); border-radius: var(--r-pill); }
    .rk-barra > span.ok { background: var(--ok-fg); }
    .rk-barra > span.bajo { background: var(--warn-fg); }
    .rk-pct { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .rk-metodo { color: var(--text-muted); font-size: var(--fs-xs); margin-top: var(--sp-3); max-width: 70rem; }
    .rk-peek-frase { margin: 0 0 var(--sp-4); }
    .rk-promo { display: block; }
    .rk-aviso { display: flex; gap: var(--sp-1); align-items: flex-start; color: var(--warn-fg); font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .rk-peek-acciones { margin-top: var(--sp-4); display: flex; justify-content: flex-end; }
    @media (max-width: 48rem) { .rk-buscar { margin-left: 0; width: 100%; } .rk-semana-txt { min-width: 0; } }
  `],
})
export class MktRankingComponent {
  private readonly api = inject(MktRankingService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly perms = inject(PermissionsService);
  readonly tabs = PROMOS_TABS;
  readonly pct = pct;
  readonly textoVentaProducto = textoVentaProducto;
  readonly textoProductos = textoProductos;
  readonly puedeGestionar = this.perms.has(Permission.MKT_AGREEMENTS_GESTIONAR);

  /** NULL = la última semana cerrada (la decide el servidor). */
  readonly semana = signal<string | null>(null);
  readonly canal = signal<Canal>('mostrador');
  readonly busqueda = signal('');
  readonly abierto = signal<ParticipanteRanking | null>(null);
  readonly generando = signal(false);

  readonly res = rxResource({
    params: () => ({ semana: this.semana(), canal: this.canal() }),
    stream: ({ params }) => this.api.ranking(params.semana, params.canal),
  });
  readonly datos = computed<RankingSemana | undefined>(() => (this.res.hasValue() ? this.res.value() : undefined));
  readonly error = computed(() => (this.res.error() ? 'No se pudo cargar el ranking. Revisa tu conexión y vuelve a intentar.' : null));

  readonly filas = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.participantes ?? []).filter((p) => coincideBusqueda(q, p.nombre, p.warehouse_name));
  });

  readonly opcionesCanal = computed<SegOption[]>(() => CANALES.map((c) => ({ label: CANAL_CORTO[c], value: c })));

  readonly semanaTexto = computed(() => { const d = this.datos(); return d ? textoSemana(d.semana) : ''; });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const sinObj = d.participantes.reduce((a, p) => a + p.sin_objetivo, 0);
    const primero = d.participantes.find((p) => p.lugar === 1);
    return [
      d.promedio_general === null
        ? { label: 'Promedio general', value: 'Sin medir', format: 'text', tone: 'muted', state: 'no_medido', stateNote: 'Ninguna promoción tiene objetivo esta semana.' }
        // `percent` del MetricStrip espera 0–100 (no la fracción).
        : { label: 'Promedio general', value: Math.round(d.promedio_general * 1000) / 10, format: 'percent', tone: d.promedio_general >= 0.9 ? 'ok' : d.promedio_general < 0.5 ? 'warn' : 'default', sub: 'con tope de 100 % por promoción' },
      { label: 'Promociones vigentes', value: d.promos_vigentes, format: 'number', drill: 'promos' } as MetricStripItem,
      { label: 'Sin objetivo', value: sinObj, format: 'number', tone: sinObj ? 'warn' : 'ok', sub: sinObj ? 'no cuentan para el lugar' : 'todas medidas', drill: sinObj ? 'objetivos' : undefined } as MetricStripItem,
      { label: 'Primer lugar', value: primero ? primero.nombre : '—', format: 'text', sub: primero ? pct(primero.puntaje) : 'nadie medible' },
    ];
  });

  readonly vacioTitulo = computed(() => (this.datos()?.promos_vigentes ? 'Nadie coincide con la búsqueda' : 'Sin promociones dadas de alta para esta semana'));
  readonly vacioPista = computed(() => (this.datos()?.promos_vigentes
    ? 'Prueba con otro nombre o limpia la búsqueda.'
    : 'El ranking mide sólo las promociones que Mercadotecnia da de alta, con su vigencia. Kepler no guarda la vigencia y reutiliza los códigos.'));

  readonly subtitulo = computed(() => {
    const p = this.abierto();
    const d = this.datos();
    if (!p || !d) return null;
    const lugar = p.lugar === null ? 'Sin lugar' : `Lugar ${p.lugar} de ${d.participantes.filter((x) => x.lugar !== null).length}`;
    return `${lugar} · ${textoSemana(d.semana)}`;
  });

  cambiarSemana(delta: number): void {
    const d = this.datos();
    if (!d) return;
    this.abierto.set(null);
    this.semana.set(moverSemana(d.semana.lunes, delta));
  }

  elegirCanal(v: string): void {
    this.abierto.set(null);
    this.canal.set(v as Canal);
  }

  abrir(p: ParticipanteRanking): void { this.abierto.set(p); }

  drill(id: string): void {
    if (id === 'objetivos' || id === 'promos') this.irAObjetivos();
  }

  irAObjetivos(): void { void this.router.navigate(['/mkt/ranking/promociones']); }

  /** El reporte de la semana con los CUATRO canales (sólo los que tienen promociones). */
  async pdf(): Promise<void> {
    const d = this.datos();
    if (!d || this.generando()) return;
    this.generando.set(true);
    const win = abrirPestanaParaPdf('Preparando el ranking…');
    try {
      const otros = CANALES.filter((c) => c !== d.canal);
      const resto = await firstValueFrom(forkJoin(otros.map((c) => this.api.ranking(d.semana.lunes, c).pipe(catchError(() => of(null))))));
      const todos = [d, ...resto.filter((x): x is RankingSemana => !!x)]
        .filter((r) => r.promos_vigentes > 0 && r.participantes.length > 0)
        .sort((a, b) => CANALES.indexOf(a.canal) - CANALES.indexOf(b.canal));
      if (!todos.length) {
        cerrarPestanaDePdf(win);
        this.toast.add({ severity: 'info', summary: 'Sin datos', detail: 'No hay promociones vigentes en esta semana.' });
        return;
      }
      const { blob, archivo } = await pdfRanking({
        semana: d.semana, rankings: todos, elaboro: this.auth.user()?.username ?? 'Mercadotecnia', consultado: new Date(d.consultado_at),
      });
      const donde = entregarPdf(win, blob, archivo);
      if (donde === 'descarga') this.toast.add({ severity: 'success', summary: 'Reporte descargado', detail: archivo });
    } catch {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF', detail: 'Intenta de nuevo.' });
    } finally {
      this.generando.set(false);
    }
  }
}
