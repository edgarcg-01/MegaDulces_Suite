import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, Router, ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { ENTRADAS_CONTROL_TABS } from '../entradas-control-tabs';
import { TableDensityComponent } from '../../../shared/components/table-density/table-density.component';
import { TableDensityService } from '../../../shared/components/table-density/table-density.service';
import { EntradasService, CoverageReport, CoverageRow } from '../entradas.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { money, moneyShort } from '../../../shared/util';

type Periodo = 'arranque' | 'mes' | 'semana';

/**
 * `[RE.16.2]` — **Centro de control · Por sucursal**. La pestaña de entrada del administrador.
 *
 * Contesta una sola pregunta y en el primer renglón: *¿de quién falta la factura?* Un % global
 * no sirve para actuar — con CEDIS pesando el 74% del volumen, la red puede verse bien mientras
 * una sucursal chica lleva tres semanas sin subir nada.
 *
 * Lo que esta vista agrega sobre la tabla que vivía dentro de Compras 360:
 *
 *   · **Responsables.** Cero cobertura con cero personas con permiso de subir NO es gente que no
 *     trabaja: es un permiso que falta. Son dos conversaciones distintas y sin la columna el
 *     tablero acusa al inocente. (Al escribir esto, tres sucursales estaban así.)
 *   · **Antigüedad p50/p90 de lo pendiente**, porque el promedio esconde la cola larga, que es
 *     justo la que hay que perseguir.
 *   · **El rezago aparte.** Lo anterior al arranque nunca va a tener comprobante; si entra al %,
 *     el número deja de servir para exigirle a nadie.
 *
 * Es un tablero de lectura: no sube ni valida nada. Cada renglón enlaza a la pantalla del oficio
 * que sí opera (Pendientes de subir · Revisión), con la sucursal ya filtrada.
 */
@Component({
  selector: 'app-compras-entradas-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule, RouterLink, ButtonModule, TooltipModule,
    PageTabsComponent, MetricStripComponent, LoadStateComponent, FreshnessPillComponent,
    SegmentedComponent, ContextHelpComponent, TableDensityComponent,
  ],
  template: `
    <div class="surf-page in ec">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Control de entradas</h1>
          <p class="surf-page-sub">
            Cada sucursal responde por lo suyo. Esto es lectura:
            @if (canManage() || canValidate()) {
              para subir o validar, entrá por el renglón.
            } @else {
              la captura y la revisión las hace cada sucursal.
            }
          </p>
        </div>
        <div class="ec-head">
          <app-table-density />
          <app-freshness-pill [since]="cargadoAt()" label="calculado" [staleAfterSec]="300" />
          <app-context-help topic="compras-entradas" />
          <button pButton type="button" class="p-button-sm p-button-text" (click)="reload()"
                  [loading]="loading()" pTooltip="Recalcular la cobertura" tooltipPosition="bottom">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      @if (report(); as cv) {
        <!-- Answer-first (DESIGN Q.1): el veredicto en llano ANTES de cualquier tabla.
             Sin color de estado: la frase pesa por tamaño y peso, y el semáforo lo lleva la
             cifra de "Comprobado" acá abajo. Pintar el párrafo entero de rojo duplicaba el
             mismo semáforo y gritaba (DESIGN §15: jerarquía por tipo y contraste, no color). -->
        <p class="ec-verdict">{{ veredicto() }}</p>

        <app-metric-strip [items]="kpis()" ariaLabel="Cobertura de la red" />

        <div class="ec-filters">
          <span class="ec-lbl">Periodo</span>
          <app-segmented [options]="periodoOpts" [value]="periodo()" (valueChange)="setPeriodo($any($event))" />
          <span class="ec-hint">
            arranque del proceso: <b class="mono">{{ cv.settings.reception_start }}</b> ·
            vencida = más de {{ cv.settings.sla_capture_days }} días sin factura
          </span>
          <span class="ec-spacer"></span>
          @if (cv.rezago.entradas > 0) {
            <span class="ec-rez" [pTooltip]="'Entradas anteriores al arranque: nunca van a tener comprobante, así que no entran al % ni al SLA'" tooltipPosition="left">
              rezago aparte: {{ cv.rezago.entradas }} órdenes · {{ moneyShort(cv.rezago.monto) }}
            </span>
          }
        </div>
      }

      <section class="surf-card ec-card">
        @if (error()) {
          <app-load-state [error]="error()" (retry)="reload()" />
        } @else if (loading() && !report()) {
          <app-load-state [loading]="true" [skeletonRows]="7" />
        } @else if (!rows().length) {
          <app-load-state [isEmpty]="true" emptyIcon="pi-sitemap" emptyTitle="Sin sucursales en tu alcance"
                          emptyHint="Tu usuario no tiene ninguna sucursal asignada. Pedile a sistemas que revise tu alcance de datos." />
        } @else {
          <div class="ec-scroll">
            <!-- Acá el modificador frozen-first SÍ corresponde: 10 columnas con scroll y la
                 primera es la identificadora (la sucursal). -->
            <table class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first ec-table"
                   [class.is-dense]="density.dense()">
              <thead>
                <tr>
                  <th scope="col">Sucursal</th>
                  <th scope="col">Quién sube</th>
                  <th scope="col" class="comm-num">Órdenes</th>
                  <th scope="col">Con factura</th>
                  <th scope="col" class="comm-num">Validadas</th>
                  <th scope="col" class="comm-num">Por revisar</th>
                  <th scope="col" class="comm-num">Vencidas</th>
                  <th scope="col" class="comm-num" pTooltip="La mitad de lo pendiente lleva p50 días o más; el 10% peor, p90" tooltipPosition="top">Antigüedad p50/p90</th>
                  <th scope="col" class="comm-num">$ sin factura</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                @for (c of rows(); track c.sucursal) {
                  <tr [class.is-cero]="c.pct_evidencia === 0">
                    <td class="ec-suc">
                      <b>{{ suc(c.sucursal) }}</b>
                      <em class="mono">{{ c.sucursal }}</em>
                    </td>
                    <!-- Von Restorff: el único renglón que se marca en rojo acá es el que no tiene
                         a nadie — porque no se arregla persiguiendo, se arregla dando permiso. -->
                    <td class="ec-resp">
                      @if (c.responsables.length) {
                        <span [pTooltip]="nombres(c)" tooltipPosition="top">
                          {{ c.responsables[0].nombre || c.responsables[0].username }}@if (c.responsables.length > 1) {
                            <em> +{{ c.responsables.length - 1 }}</em>
                          }
                        </span>
                      } @else {
                        <span class="ec-nadie">
                          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> nadie con permiso
                        </span>
                      }
                    </td>
                    <td class="comm-num">{{ c.entradas }}</td>
                    <!-- La barra sube de rojo a ámbar a verde con el mismo umbral que el KPI de
                         arriba. Estaba siempre verde: una sucursal al 20% se leía "bien" de
                         reojo, que es justo como se lee una tabla de 7 renglones. -->
                    <td class="ec-bar" [attr.data-tone]="tono(c.pct_evidencia)">
                      <span class="ec-track"><span [style.width.%]="c.pct_evidencia"></span></span>
                      <em class="mono">{{ c.pct_evidencia }}%</em>
                    </td>
                    <td class="comm-num">{{ c.validadas }}</td>
                    <td class="comm-num">{{ c.por_validar || '—' }}</td>
                    <td class="comm-num" [class.is-bad]="c.atrasadas > 0">{{ c.atrasadas || '—' }}</td>
                    <td class="comm-num" [class.is-warn]="c.dias_p50 > slaCaptura()">
                      {{ c.dias_p50 }} / {{ c.dias_p90 }}
                    </td>
                    <td class="comm-num">{{ moneyShort(c.monto_pendiente) }}</td>
                    <td class="ec-acts">
                      <!-- RE.16.9 — el supervisor que sólo observa (VER, sin GESTIONAR ni
                           VALIDAR) no ve atajos a pantallas donde el guard lo rebota. "ver
                           todo" queda siempre: es lectura, igual que este tablero. -->
                      @if (canManage() && c.entradas > c.con_evidencia) {
                        <a class="ec-link" [routerLink]="['/compras/entradas']" [queryParams]="{ suc: c.sucursal }"
                           [pTooltip]="(c.entradas - c.con_evidencia) + ' sin factura'" tooltipPosition="left">subir</a>
                      }
                      @if (canValidate() && c.por_validar > 0) {
                        <a class="ec-link" [routerLink]="['/compras/entradas/revision']" [queryParams]="{ suc: c.sucursal }"
                           [pTooltip]="c.por_validar + ' esperando decisión'" tooltipPosition="left">revisar</a>
                      }
                      <a class="ec-link is-quiet" [routerLink]="['/compras/entradas/control/ordenes']" [queryParams]="{ suc: c.sucursal }">ver todo</a>
                    </td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <td>Red</td>
                  <td class="ec-resp">
                    @if (report()?.responsables_red) {
                      <span class="ec-red-resp">{{ report()?.responsables_red }} con alcance de red</span>
                    }
                  </td>
                  <td class="comm-num">{{ tot().entradas }}</td>
                  <td class="ec-bar">
                    <span class="ec-track"><span [style.width.%]="pctRed()"></span></span>
                    <em class="mono">{{ pctRed() }}%</em>
                  </td>
                  <td class="comm-num">{{ tot().validadas }}</td>
                  <td class="comm-num">{{ tot().por_validar || '—' }}</td>
                  <td class="comm-num" [class.is-bad]="tot().atrasadas > 0">{{ tot().atrasadas || '—' }}</td>
                  <td></td>
                  <td class="comm-num">{{ moneyShort(tot().monto_pendiente) }}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ec-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }

    /* Answer-first: una oración, tamaño de título de panel, sin caja. */
    .ec-verdict {
      margin: var(--sp-4) 0 var(--sp-3);
      font-size: var(--fs-h3);
      font-weight: var(--fw-bold, 700);
      color: var(--text-main);
      text-wrap: balance;
    }

    .ec-filters {
      display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap;
      margin: var(--sp-4) 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted);
    }
    .ec-lbl { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
    .ec-hint b { color: var(--text-muted); font-weight: 600; }
    .ec-spacer { flex: 1 1 auto; }
    .ec-rez { color: var(--text-faint); }

    .ec-card { padding: 0; overflow: hidden; }
    .ec-scroll { overflow-x: auto; }
    /* La base (tipografía, densidad, header, divisores) es surf-table--plain. Acá queda
       sólo el pie pegado: el total de la red tiene que verse sin scrollear. */
    .ec-table tfoot td { position: sticky; bottom: 0; }

    .ec-suc b { display: block; color: var(--text-main); font-weight: 600; }
    .ec-suc em { font-style: normal; font-size: var(--fs-micro); color: var(--text-faint); }

    .ec-resp { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
    .ec-resp em { font-style: normal; color: var(--text-faint); }
    .ec-nadie { color: var(--bad-fg); font-weight: 600; }
    .ec-red-resp { font-size: var(--fs-micro); font-weight: 400; color: var(--text-faint); }

    .ec-bar { display: flex; align-items: center; gap: var(--sp-2); min-width: 8rem; }
    .ec-track { flex: 1 1 auto; height: 4px; border-radius: var(--r-pill, 999px); background: var(--surface-200, var(--hover-bg)); overflow: hidden; }
    .ec-track > span { display: block; height: 100%; background: var(--ok-fg); }
    .ec-bar[data-tone="warn"] .ec-track > span { background: var(--warn-fg); }
    .ec-bar[data-tone="bad"]  .ec-track > span { background: var(--bad-fg); }
    .ec-bar em { font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); min-width: 2.6rem; text-align: right; }

    /* Semántica, no marca: el descuadre nunca usa --action (que es el color de ACTUAR). */
    td.is-bad { color: var(--bad-fg); font-weight: 600; }
    td.is-warn { color: var(--warn-fg); }
    tr.is-cero .ec-suc b { color: var(--bad-fg); }

    .ec-acts { white-space: nowrap; text-align: right; }
    .ec-link {
      display: inline-block; margin-left: var(--sp-2); font-size: var(--fs-xs);
      color: var(--action); text-decoration: none; border-bottom: 1px solid transparent;
    }
    .ec-link:hover, .ec-link:focus-visible { border-bottom-color: currentColor; }
    .ec-link.is-quiet { color: var(--text-faint); }
  `],
})
export class ComprasEntradasControlComponent {
  private readonly svc = inject(EntradasService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  readonly density = inject(TableDensityService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  // Este tablero lo abre cualquiera con VER — incluido el que sólo supervisa. Los atajos a las
  // pantallas de oficio se muestran según lo que la persona SÍ puede hacer.
  readonly canManage = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_GESTIONAR] === true);
  readonly canValidate = computed(() => this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  readonly tabs = ENTRADAS_CONTROL_TABS;
  readonly report = signal<CoverageReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly cargadoAt = signal<number | null>(null);
  readonly periodo = signal<Periodo>('arranque');

  readonly periodoOpts = [
    { label: 'Desde el arranque', value: 'arranque' },
    { label: 'Este mes', value: 'mes' },
    { label: 'Últimos 7 días', value: 'semana' },
  ];

  readonly rows = computed(() => this.report()?.rows ?? []);
  readonly slaCaptura = computed(() => this.report()?.settings.sla_capture_days ?? 3);

  /** Totales de la red: se suman acá, no en otra llamada — la tabla ya trae todo. */
  readonly tot = computed(() => {
    const r = this.rows();
    const acc = { entradas: 0, con_evidencia: 0, validadas: 0, por_validar: 0, atrasadas: 0, monto_pendiente: 0 };
    for (const c of r) {
      acc.entradas += c.entradas; acc.con_evidencia += c.con_evidencia;
      acc.validadas += c.validadas; acc.por_validar += c.por_validar;
      acc.atrasadas += c.atrasadas; acc.monto_pendiente += c.monto_pendiente;
    }
    return acc;
  });
  readonly pctRed = computed(() => {
    const t = this.tot();
    return t.entradas ? Math.round((t.con_evidencia / t.entradas) * 100) : 0;
  });
  /** Sucursales sin nadie que pueda subir: el problema que NO se arregla persiguiendo. */
  readonly sinResponsable = computed(() => this.rows().filter((c) => !c.responsables.length && c.entradas > 0));

  readonly veredicto = computed(() => {
    const t = this.tot();
    if (!t.entradas) return 'Sin órdenes de entrada en el periodo.';
    const falta = t.entradas - t.con_evidencia;
    const huerfanas = this.sinResponsable().length;
    const partes = [`La red lleva ${this.pctRed()}% comprobado: faltan ${falta} facturas por ${money(t.monto_pendiente)}`];
    if (t.atrasadas) partes.push(`${t.atrasadas} ya pasaron los ${this.slaCaptura()} días`);
    if (huerfanas) partes.push(`${huerfanas} sucursal${huerfanas > 1 ? 'es' : ''} sin nadie que pueda subir`);
    return partes.join(' · ') + '.';
  });

  /** Un solo umbral para toda la pantalla: el KPI de arriba y la barra de cada fila. */
  tono(pct: number): 'ok' | 'warn' | 'bad' { return pct >= 90 ? 'ok' : pct >= 60 ? 'warn' : 'bad'; }

  readonly kpis = computed<MetricStripItem[]>(() => {
    const t = this.tot();
    const huerfanas = this.sinResponsable().length;
    return [
      { label: 'Comprobado', value: this.pctRed(), format: 'percent', tone: this.tono(this.pctRed()) },
      { label: 'Sin factura', value: t.monto_pendiente, format: 'currency-short', tone: 'default', sub: `${t.entradas - t.con_evidencia} órdenes` },
      { label: 'Vencidas', value: t.atrasadas, format: 'number', tone: t.atrasadas ? 'bad' : 'ok', sub: `más de ${this.slaCaptura()} días` },
      { label: 'Esperando revisión', value: t.por_validar, format: 'number', tone: t.por_validar ? 'warn' : 'default' },
      // Se muestra siempre, también en cero: la ausencia del problema es información.
      { label: 'Sucursales sin responsable', value: huerfanas, format: 'number', tone: huerfanas ? 'bad' : 'ok' },
    ];
  });

  constructor() {
    // Estado en la URL: el link a "la cobertura de este mes" se puede pegar en un chat.
    const p = this.route.snapshot.queryParamMap.get('periodo') as Periodo | null;
    if (p === 'mes' || p === 'semana') this.periodo.set(p);
    this.cargar();
  }

  setPeriodo(v: Periodo): void {
    this.periodo.set(v);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { periodo: v === 'arranque' ? null : v },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.cargar();
  }

  reload(): void { this.error.set(null); this.cargar(); }

  private cargar(): void {
    this.loading.set(true);
    this.svc.coverage(this.rango()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.report.set(r);
        this.error.set(null);
        this.loading.set(false);
        this.cargadoAt.set(Date.now());
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(e?.error?.message || 'No se pudo calcular la cobertura');
      },
    });
  }

  /** `arranque` no manda `from`: el server ya recorta en la fecha de arranque del tenant. */
  private rango(): { from?: string; to?: string } {
    const hoy = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (this.periodo() === 'mes') return { from: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)) };
    if (this.periodo() === 'semana') {
      const d = new Date(hoy); d.setDate(d.getDate() - 6);
      return { from: iso(d) };
    }
    return {};
  }

  nombres(c: CoverageRow): string {
    return c.responsables.map((r) => `${r.nombre || r.username}${r.alcance === 'asignado' ? ' (asignada)' : ''}`).join(' · ');
  }
  suc(c: string): string { return branchName(c) || c; }
  money = money;
  moneyShort = moneyShort;
}
