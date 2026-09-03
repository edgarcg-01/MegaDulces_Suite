import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { branchName } from '../../../core/constants/store-branches';
import { ArqueoService, CajeraCard, CumplimientoResp, TurnoCorte } from '../arqueo.service';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { imprimirTicket } from '../ticket-arqueo';

/**
 * Tienda — Arqueos por cajera (/tienda/arqueos).
 *
 * Una **tarjeta por persona**, no una tabla de eventos. La pregunta que se hace
 * la encargada no es "qué pasó el martes" sino "cómo viene Jessica": cuántos
 * cortes lleva, en qué horarios, cuáles quedaron sin contar y cuánto acumula.
 *
 * La fuente son **los cortes de Kepler**, no nuestros conteos — así el turno que
 * nadie arqueó también aparece, que es justo el que hay que perseguir. Nuestro
 * arqueo se cuelga de cada corte cuando existe, con su conteo pieza por pieza.
 *
 * Cada corte se puede imprimir en formato ticket (80 mm) como respaldo físico.
 */
@Component({
  selector: 'app-tienda-arqueo-historial',
  standalone: true,
  imports: [CommonModule, ButtonModule, ToastModule, TagModule, SegmentedComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ah-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueos por cajera</h1>
          <p class="surf-page-sub">
            @if (revela) { Cada persona con <strong>sus cortes de Kepler</strong> y sus horarios. Kepler siempre trae su cifra; el chip marca los turnos donde <strong>nadie contó el efectivo</strong>. }
            @else { Tus cortes y los conteos que capturaste. }
          </p>
        </div>
        <div class="ah-head-right">
          <app-segmented [options]="ventanas" [value]="ventana()" (valueChange)="cambiarVentana($event)" ariaLabel="Ventana" />
          <app-freshness-pill [since]="cargadoAl()" [staleAfterSec]="180" />
          <button pButton type="button" class="p-button-sm p-button-text" [class.ah-on]="soloPendientes()" (click)="togglePendientes()">
            <span class="p-button-icon p-button-icon-left pi pi-flag" aria-hidden="true"></span>
            <span class="p-button-label">Solo sin conteo físico</span>
          </button>
          <button pButton type="button" class="p-button-sm p-button-text" [loading]="loading()" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      @if (revela && cump(); as k) {
        <!-- El número que hace que la cola sirva. Sin esto el hallazgo se acumula
             y nadie rinde cuentas: "cuántos de los cortes de mi tienda llegaron a
             tener un conteo físico, y cuánto dinero quedó sin verificar". -->
        <div class="ah-cump" [class.mal]="k.totales.pct < 80">
          <div class="ah-cump-big">
            <span class="ah-cump-pct">{{ k.totales.pct }}%</span>
            <span class="ah-cump-l">de los cortes con conteo físico</span>
          </div>
          <div class="ah-cump-d">
            <span><strong>{{ k.totales.arqueados }}</strong> de {{ k.totales.cortes }} contados</span>
            @if (k.totales.pendientes) { <span class="warn"><strong>{{ k.totales.pendientes }}</strong> aún a tiempo</span> }
            @if (k.totales.no_verificables) { <span class="bad"><strong>{{ k.totales.no_verificables }}</strong> ya no se pueden contar</span> }
            <span class="bad ah-cump-monto">{{ money(k.totales.monto_sin_verificar) }} sin verificar</span>
          </div>
        </div>
      }

      <div class="ah-kpis">
        <div class="ah-kpi"><span class="ah-kpi-v">{{ totales().cajeras }}</span><span class="ah-kpi-l">Cajeras</span></div>
        <div class="ah-kpi"><span class="ah-kpi-v">{{ totales().cortes }}</span><span class="ah-kpi-l">Cortes</span></div>
        <div class="ah-kpi"><span class="ah-kpi-v" [class.bad]="totales().sin_arqueo > 0">{{ totales().sin_arqueo }}</span><span class="ah-kpi-l">Sin conteo físico</span></div>
        @if (revela) {
          <div class="ah-kpi"><span class="ah-kpi-v bad">{{ money(totales().faltante_total) }}</span><span class="ah-kpi-l">Faltantes</span></div>
        }
      </div>

      @if (loading() && !cajeras().length) {
        <p class="muted ah-msg">Cargando…</p>
      } @else if (!visibles().length) {
        <div class="card-premium card-flat ah-vacio">
          <i class="pi pi-inbox"></i>
          <div>
            <strong>Sin cortes en esta ventana.</strong>
            <p class="muted">
              @if (soloPendientes()) { Todos los turnos tienen conteo físico — probá quitando el filtro. }
              @else { Kepler no registró cortes en el rango. Ampliá a 7 o 30 días. }
            </p>
          </div>
        </div>
      }

      @for (g of grupos(); track g.code) {
        <section class="ah-suc">
          <h2 class="ah-suc-h2">
            <button type="button" class="ah-suc-h" (click)="alternarSuc(g.code)"
                    [attr.aria-expanded]="abiertaSuc(g.code)" [attr.aria-controls]="'suc-' + g.code">
              <i class="pi ah-suc-chev" [class.pi-chevron-down]="abiertaSuc(g.code)" [class.pi-chevron-right]="!abiertaSuc(g.code)" aria-hidden="true"></i>
              <span class="ah-suc-n">{{ g.nombre }}</span>
              <span class="ah-suc-m">{{ g.cajeras.length }} cajeras · {{ g.cortes }} cortes</span>
              @if (g.sin_arqueo) { <span class="ah-badge">{{ g.sin_arqueo }} solo Kepler</span> }
              @if (revela && g.faltante > 0) { <span class="ah-suc-f bad">{{ money(g.faltante) }} de faltantes</span> }
            </button>
          </h2>
          @if (abiertaSuc(g.code)) {
          <div class="ah-cards" [id]="'suc-' + g.code">
        @for (c of g.cajeras; track c.cajero_code) {
          <article class="card-premium card-flat ah-card">
            <header class="ah-card-h">
              <div class="ah-ini" aria-hidden="true">{{ iniciales(c) }}</div>
              <div class="ah-card-id">
                <h3>{{ c.cajero_nombre || c.cajero_code }}</h3>
                <span class="muted">{{ c.cajero_code }}</span>
              </div>
              @if (c.sin_arqueo) { <span class="ah-badge">{{ c.sin_arqueo }} solo Kepler</span> }
            </header>

            <div class="ah-card-kpis">
              <div><span class="ah-k">{{ c.cortes }}</span><span class="ah-l">cortes</span></div>
              <div><span class="ah-k">{{ c.dias }}</span><span class="ah-l">días</span></div>
              @if (revela) {
                <div><span class="ah-k" [class.bad]="(c.faltante_total || 0) > 0">{{ money(c.faltante_total) }}</span><span class="ah-l">faltantes</span></div>
                <div><span class="ah-k" [class.ok]="(c.sobrante_total || 0) > 0">{{ money(c.sobrante_total) }}</span><span class="ah-l">sobrantes</span></div>
              }
            </div>

            <ul class="ah-turnos">
              @for (t of turnosDe(c); track t.folio + t.business_date) {
                <li class="ah-turno">
                  <button type="button" class="ah-turno-h" (click)="alternar(t)">
                    <span class="ah-t-fecha">{{ t.business_date | date:'dd/MM' }}</span>
                    <span class="ah-t-caja">Caja {{ t.caja }}</span>
                    <span class="ah-t-hora">
                      {{ (t.hora_apertura || '--').slice(0,5) }}–{{ (t.hora_cierre || '--').slice(0,5) }}
                      @if (t.duracion_horas != null) { <span class="muted">· {{ t.duracion_horas }}h</span> }
                    </span>
                    @if (t.nuestro_contado != null) {
                      <span class="ah-t-monto">{{ money(t.nuestro_contado) }}</span>
                      @if (revela && t.diff_real != null && t.diff_real !== 0) {
                        <span class="ah-t-dif" [class.bad]="t.diff_real > 0" [class.ok]="t.diff_real < 0">
                          {{ t.diff_real > 0 ? '+' : '' }}{{ money(t.diff_real) }}
                        </span>
                      }
                    } @else {
                      <!-- Kepler siempre trae su cifra, así que el turno no queda
                           vacío: lo que falta es el conteo físico. A la cajera NO se
                           le muestra el monto (SM.10) — vería su esperado por la puerta
                           de atrás — pero sí que ese corte quedó sin contar. -->
                      @if (revela) { <span class="ah-t-monto muted">{{ money(t.kepler_contado) }}</span> }
                      <span class="ah-t-sin" title="Kepler declaró este corte; nadie contó el efectivo a ciegas">solo Kepler</span>
                    }
                    <i class="pi ah-chev" [class.pi-chevron-down]="abierto(t)" [class.pi-chevron-right]="!abierto(t)"></i>
                  </button>

                  @if (abierto(t)) {
                    <div class="ah-t-det">
                      @if (revela) {
                        <div class="ah-t-kep">
                          <span><span class="ah-l">Esperado</span>{{ money(t.esperado) }}</span>
                          <span><span class="ah-l">Kepler</span>{{ money(t.kepler_contado) }}</span>
                          <span><span class="ah-l">Billetes</span>{{ money(t.kepler_billetes) }}</span>
                          <span><span class="ah-l">Monedas</span>{{ money(t.kepler_monedas) }}</span>
                          <span><span class="ah-l">Retirado</span>{{ money(t.kepler_retirado) }}</span>
                        </div>
                      }
                      @if (t.denominaciones?.length) {
                        <table class="ah-den">
                          @for (d of t.denominaciones; track d.denominacion) {
                            <tr>
                              <td class="ta-r">{{ d.denominacion >= 1 ? '$' + d.denominacion : (d.denominacion * 100) + '¢' }}</td>
                              <td class="ta-c muted">×</td><td class="ta-r">{{ d.cantidad }}</td>
                              <td class="ta-c muted">=</td><td class="ta-r strong">{{ money(d.subtotal) }}</td>
                            </tr>
                          }
                          <tr class="ah-den-tot"><td colspan="4" class="ta-r">TOTAL CONTADO</td><td class="ta-r strong">{{ money(t.nuestro_contado) }}</td></tr>
                        </table>
                      } @else {
                        @if (revela) {
                          <!-- Kepler no guarda el conteo pieza por pieza (verificado contra las
                               307 tablas del ERP): solo el total de billetes y el de monedas.
                               Se muestra ese desglose en el mismo formato alineado que el
                               nuestro, para que las dos columnas se lean igual — pero el
                               renglón dice "billetes", no "$500 × 4", porque esa línea no
                               existe en ningún lado y no se inventa. -->
                          <table class="ah-den">
                            <tr><td class="ta-r">Billetes</td><td class="ta-c muted">=</td><td class="ta-r strong">{{ money(t.kepler_billetes) }}</td></tr>
                            <tr><td class="ta-r">Monedas</td><td class="ta-c muted">=</td><td class="ta-r strong">{{ money(t.kepler_monedas) }}</td></tr>
                            <tr><td class="ta-r">Retirado</td><td class="ta-c muted">=</td><td class="ta-r strong">{{ money(t.kepler_retirado) }}</td></tr>
                            <tr class="ah-den-tot"><td class="ta-r">TOTAL KEPLER</td><td class="ta-c muted">=</td><td class="ta-r strong">{{ money(t.kepler_contado) }}</td></tr>
                          </table>
                          @if (hueco(t) !== null) {
                            <p class="ah-nada bad">
                              El desglose no llega al total: faltan {{ money(hueco(t)) }} sin explicar
                              <span class="muted">(billetes + monedas + retirado ≠ contado).</span>
                            </p>
                          }
                          <p class="ah-nada muted">
                            Cifra <em>declarada</em> al cerrar el corte, sin conteo físico a ciegas.
                            Kepler no guarda el detalle por denominación — eso solo sale del arqueo de la cajera.
                          </p>
                        } @else {
                          <p class="ah-nada muted">Este corte se cerró en Kepler sin conteo físico. Contalo con tu encargada.</p>
                        }
                      }
                      <div class="ah-t-pie">
                        <span class="muted">
                          @if (t.capturado_por) { Capturó {{ t.capturado_por }} · {{ t.capturado_at | date:'dd/MM HH:mm' }} }
                          @if (t.validado_por) { · Validó {{ t.validado_por }} }
                        </span>
                        <button pButton type="button" class="p-button-sm p-button-text" (click)="imprimir(c, t)">
                          <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span>
                          <span class="p-button-label">Imprimir ticket</span>
                        </button>
                      </div>
                    </div>
                  }
                </li>
              }
            </ul>
          </article>
        }
          </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ah-head-right { display: inline-flex; align-items: center; gap: .6rem; margin-left: auto; flex-wrap: wrap; }
    :host ::ng-deep .ah-on { color: var(--action); font-weight: 700; }
    .ah-msg { font-size: .85rem; }
    .ah-cump { display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap;
               padding: .8rem 1rem; margin-bottom: .9rem; border-radius: var(--r-md);
               border: 1px solid var(--border-color); background: var(--card-bg); }
    .ah-cump.mal { border-color: var(--bad-fg); background: var(--bad-soft-bg); }
    .ah-cump-big { display: flex; align-items: baseline; gap: .5rem; }
    .ah-cump-pct { font-size: 1.9rem; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
    .ah-cump.mal .ah-cump-pct { color: var(--bad-soft-fg); }
    .ah-cump.mal .ah-cump-l, .ah-cump.mal .ah-cump-d { color: var(--bad-soft-fg); }
    .ah-cump-l { font-size: .78rem; color: var(--text-muted); }
    .ah-cump-d { display: flex; gap: .3rem 1rem; flex-wrap: wrap; font-size: .76rem; font-variant-numeric: tabular-nums; }
    .ah-cump-monto { margin-left: auto; }
    .warn { color: var(--warn-fg); }
    .ah-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .7rem; margin-bottom: 1rem; }
    .ah-kpi { padding: .8rem .9rem; border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .ah-kpi-v { display: block; font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ah-kpi-l { display: block; font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-top: .15rem; }
    .ah-vacio { display: flex; gap: .8rem; align-items: flex-start; padding: 1.1rem; }
    .ah-vacio i { color: var(--text-muted); margin-top: .15rem; }
    .ah-vacio p { margin: .2rem 0 0; font-size: .82rem; }
    .ah-suc { margin-bottom: 1.4rem; }
    /* Encabezado pegajoso: al recorrer una lista larga, saber en qué tienda vas
       importa más que ganar esos 30px de alto. */
    /* El sticky vive en el <h2>: si va en el botón, el borde se despega al scrollear. */
    .ah-suc-h2 { position: sticky; top: 0; z-index: 2; margin: 0 0 .55rem; }
    .ah-suc-h { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap;
                width: 100%; padding: .5rem .4rem .55rem; text-align: left;
                background: var(--page-bg, var(--surface-ground)); border: 0;
                border-bottom: 1px solid var(--border-color); border-radius: var(--r-sm);
                cursor: pointer; color: inherit; font: inherit; }
    .ah-suc-h:hover { background: var(--surface-hover, var(--card-bg)); }
    .ah-suc-h:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .ah-suc-chev { align-self: center; font-size: .72rem; color: var(--text-muted); }
    .ah-suc-n { font-size: .92rem; font-weight: 700; letter-spacing: -.01em; }
    .ah-suc-m { font-size: .72rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .ah-suc-f { font-size: .72rem; font-weight: 700; font-variant-numeric: tabular-nums; margin-left: auto; }
    /* Grid intrínseco: sin breakpoints, la tarjeta decide cuántas caben. */
    .ah-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 27rem), 1fr)); gap: .9rem; }
    .ah-card { padding: .9rem 1rem 1rem; }
    .ah-card-h { display: flex; align-items: center; gap: .65rem; margin-bottom: .7rem; }
    .ah-ini { width: 2.1rem; height: 2.1rem; flex: 0 0 auto; border-radius: 50%; display: grid; place-items: center;
              font-size: .72rem; font-weight: 700; letter-spacing: .02em;
              background: color-mix(in srgb, var(--action) 14%, transparent); color: var(--action); }
    .ah-card-id { min-width: 0; }
    .ah-card-id h3 { margin: 0; font-size: .88rem; font-weight: 700; line-height: 1.2;
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ah-card-id span { font-size: .68rem; }
    .ah-badge { margin-left: auto; flex: 0 0 auto; font-size: .62rem; font-weight: 700; text-transform: uppercase;
                letter-spacing: .04em; padding: .12rem .4rem; border-radius: 999px;
                background: color-mix(in srgb, var(--bad-fg) 12%, transparent); color: var(--bad-fg); }
    .ah-card-kpis { display: flex; gap: 1.2rem; padding: .5rem 0 .7rem; border-bottom: 1px solid var(--border-color); }
    .ah-k { display: block; font-size: .95rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .ah-l { display: block; font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .ah-turnos { list-style: none; margin: 0; padding: 0; }
    .ah-turno { border-bottom: 1px solid var(--border-color); }
    .ah-turno:last-child { border-bottom: 0; }
    .ah-turno-h { width: 100%; display: flex; align-items: center; gap: .55rem; padding: .42rem 0; background: none;
                  border: 0; cursor: pointer; color: inherit; text-align: left; font-variant-numeric: tabular-nums; }
    .ah-turno-h:hover { color: var(--action); }
    .ah-t-fecha { font-size: .76rem; font-weight: 600; flex: 0 0 3rem; }
    .ah-t-caja { font-size: .72rem; color: var(--text-muted); flex: 0 0 4rem; }
    .ah-t-hora { font-size: .72rem; color: var(--text-muted); }
    .ah-t-monto { margin-left: auto; font-size: .8rem; font-weight: 700; }
    .ah-t-dif { font-size: .72rem; font-weight: 700; }
    .ah-t-sin { margin-left: auto; font-size: .64rem; font-weight: 700; text-transform: uppercase;
                letter-spacing: .04em; color: var(--warn-fg); }
    .ah-chev { font-size: .62rem; color: var(--text-muted); }
    .ah-t-det { padding: .3rem 0 .7rem 3rem; }
    .ah-t-kep { display: flex; flex-wrap: wrap; gap: .3rem 1.1rem; margin-bottom: .5rem; font-size: .76rem; font-variant-numeric: tabular-nums; }
    .ah-den { font-variant-numeric: tabular-nums; border-collapse: collapse;
              font-family: var(--font-mono, ui-monospace, "Geist Mono", monospace); }
    .ah-den td { padding: .07rem .45rem; font-size: .76rem; white-space: nowrap; }
    .ah-den-tot td { border-top: 1px solid var(--border-color); font-weight: 700; padding-top: .25rem; }
    .ah-nada { font-size: .78rem; margin: .2rem 0; }
    .ah-t-pie { display: flex; align-items: center; gap: .6rem; margin-top: .45rem; font-size: .68rem; flex-wrap: wrap; }
    .ta-r { text-align: right; } .ta-c { text-align: center; }
    .strong { font-weight: 700; } .muted { color: var(--text-muted); }
    .bad { color: var(--bad-fg); } .ok { color: var(--ok-fg); }
  `],
})
export class TiendaArqueoHistorialComponent implements OnInit {
  private readonly svc = inject(ArqueoService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  /** Espeja la regla del backend: solo quien valida ve el cuadre. */
  readonly revela = this.perms.isAdmin()
    || this.auth.user()?.permissions?.[Permission.RECONCILIATION_VER] === true;

  readonly cajeras = signal<CajeraCard[]>([]);
  readonly totales = signal<{ cajeras: number; cortes: number; sin_arqueo: number; faltante_total?: number }>(
    { cajeras: 0, cortes: 0, sin_arqueo: 0 });
  readonly loading = signal(false);
  readonly cargadoAl = signal<string | null>(null);
  readonly soloPendientes = signal(false);
  /** Turnos con el detalle desplegado, por `folio|fecha`. */
  readonly desplegados = signal<Record<string, boolean>>({});

  readonly ventanas = [
    { label: 'Hoy', value: 'hoy' },
    { label: '7 días', value: '7' },
    { label: '30 días', value: '30' },
  ];
  readonly ventana = signal<string>('7');
  readonly cump = signal<CumplimientoResp | null>(null);

  /** Con el filtro puesto, la tarjeta solo aparece si tiene pendientes. */
  readonly visibles = computed(() =>
    this.soloPendientes() ? this.cajeras().filter((c) => c.sin_arqueo > 0) : this.cajeras());

  /**
   * Las cajeras van **dentro de su sucursal**: quien mira esta pantalla es de una
   * tienda, y una lista que mezcla Padre Hidalgo con La Piedad la obliga a filtrar
   * con la vista. Cada grupo lleva su propio conteo, así el encargado sabe cuánto
   * le falta a SU tienda sin restar del total.
   *
   * El orden es por pendientes primero: la sucursal con más cortes sin contar es
   * la que hay que abrir, no la que salga alfabéticamente antes.
   */
  readonly grupos = computed(() => {
    const acc = new Map<string, { code: string; nombre: string; cajeras: CajeraCard[]; cortes: number; sin_arqueo: number; faltante: number }>();
    for (const c of this.visibles()) {
      const code = c.warehouse_code || '—';
      let g = acc.get(code);
      if (!g) { g = { code, nombre: this.branchLabel(code), cajeras: [], cortes: 0, sin_arqueo: 0, faltante: 0 }; acc.set(code, g); }
      g.cajeras.push(c);
      g.cortes += Number(c.cortes || 0);
      g.sin_arqueo += Number(c.sin_arqueo || 0);
      g.faltante += Number(c.faltante_total || 0);
    }
    // `Array.from`, no spread del iterador: el spread de un Map.values() en este
    // repo ya devolvió el iterador como único elemento y rompió los totales.
    return Array.from(acc.values()).sort((a, b) => b.sin_arqueo - a.sin_arqueo || a.nombre.localeCompare(b.nombre));
  });

  ngOnInit() {
    this.load();
    this.zone.runOutsideAngular(() => {
      const id = setInterval(() => this.zone.run(() => {
        if (document.visibilityState === 'visible') this.load();
      }), 60_000);
      this.destroyRef.onDestroy(() => clearInterval(id));
    });
  }

  /**
   * Sucursales desplegadas. `null` = nadie tocó nada todavía → vale la regla por
   * defecto de `abiertaSuc`. Se distingue de un Set vacío (que sí significa
   * "las cerré todas a mano") para que el auto-refresh de 60s no vuelva a abrir
   * lo que el encargado acaba de cerrar.
   */
  private readonly aperturas = signal<Set<string> | null>(null);

  /** Con una sola tienda a la vista, pedir un clic para verla es puro peaje. */
  abiertaSuc(code: string): boolean {
    const s = this.aperturas();
    return s ? s.has(code) : this.grupos().length === 1;
  }

  alternarSuc(code: string) {
    const previas = this.aperturas()
      ?? new Set(this.grupos().length === 1 ? this.grupos().map((g) => g.code) : []);
    const s = new Set(previas);
    if (s.has(code)) s.delete(code); else s.add(code);
    this.aperturas.set(s);
  }

  cambiarVentana(v: string) { this.ventana.set(v); this.load(); }
  togglePendientes() { this.soloPendientes.set(!this.soloPendientes()); }

  /** Inicio de la ventana en hora de MÉXICO (§10), no en la del navegador. */
  private desdeTxt(): string {
    const hoyMx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    if (this.ventana() === 'hoy') return hoyMx;
    const d = new Date(`${hoyMx}T12:00:00`);
    d.setDate(d.getDate() - Number(this.ventana()));
    return d.toLocaleDateString('en-CA');
  }

  load() {
    this.loading.set(true);
    if (this.revela) {
      // Best-effort: si el tablero falla, la lista de cajeras igual se pinta.
      this.svc.cumplimiento({ from: this.desdeTxt() })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ next: (r) => this.cump.set(r), error: () => this.cump.set(null) });
    }
    this.svc.porCajera({ from: this.desdeTxt(), limit: 600 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.cajeras.set(r.cajeras || []);
          this.totales.set(r.totales || { cajeras: 0, cortes: 0, sin_arqueo: 0 });
          this.cargadoAl.set(new Date().toISOString());
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  /** Con el filtro puesto, dentro de la tarjeta también se ven solo los pendientes. */
  turnosDe(c: CajeraCard): TurnoCorte[] {
    return this.soloPendientes() ? c.turnos.filter((t) => t.nuestro_contado == null) : c.turnos;
  }

  private clave(t: TurnoCorte) { return `${t.folio}|${t.business_date}`; }
  abierto(t: TurnoCorte) { return !!this.desplegados()[this.clave(t)]; }
  alternar(t: TurnoCorte) {
    const k = this.clave(t); const d = { ...this.desplegados() };
    if (d[k]) delete d[k]; else d[k] = true;
    this.desplegados.set(d);
  }

  iniciales(c: CajeraCard): string {
    const n = (c.cajero_nombre || c.cajero_code || '').trim();
    const p = n.split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '??';
  }

  imprimir(c: CajeraCard, t: TurnoCorte) {
    const ok = imprimirTicket({
      sucursal: this.branchLabel(c.warehouse_code), caja: t.caja, fecha: t.business_date, folio: t.folio,
      cajera: c.cajero_nombre || c.cajero_code || '',
      hora_apertura: t.hora_apertura, hora_cierre: t.hora_cierre,
      denominaciones: t.denominaciones || [], total_contado: t.nuestro_contado ?? t.kepler_contado ?? 0,
      esperado: t.esperado, diff_real: t.diff_real, kepler_contado: t.kepler_contado,
      kepler_billetes: t.kepler_billetes, kepler_monedas: t.kepler_monedas, kepler_retirado: t.kepler_retirado,
      kepler_tarjeta: t.kepler_tarjeta, kepler_transfer: t.kepler_transfer, venta: t.venta,
      tipo: 'cierre', turno: t.turno, duracion_horas: t.duracion_horas, handoff: t.handoff,
      arqueo_id: t.arqueo_id, incidencia_tipo: t.incidencia_tipo, nota: t.nota, validado_nota: t.validado_nota,
      capturado_por: t.capturado_por, capturado_at: t.capturado_at,
      validado_por: t.validado_por, validado_at: t.validado_at,
    }, { revela: this.revela });
    if (!ok) {
      this.toast.add({ severity: 'warn', summary: 'El navegador bloqueó la ventana', detail: 'Permití las ventanas emergentes de este sitio para imprimir.' });
    }
  }

  /**
   * Lo que el desglose de Kepler no alcanza a explicar. La identidad que cierra
   * es `billetes + monedas + retirado = contado` (63.6% de los cortes); cuando
   * no da, el hueco suele ser un retiro que no quedó registrado en `c48`, así
   * que vale la pena verlo en vez de sumar en silencio. `null` = cuadra, o no
   * hay con qué comparar.
   */
  hueco(t: TurnoCorte): number | null {
    const c = Number(t.kepler_contado ?? 0);
    if (!c) return null;
    const suma = Number(t.kepler_billetes ?? 0) + Number(t.kepler_monedas ?? 0) + Number(t.kepler_retirado ?? 0);
    if (!suma) return null;
    const d = c - suma;
    return Math.abs(d) < 1 ? null : d;
  }

  branchLabel(code?: string | null): string { return branchName(code); }
  money(v: number | string | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
