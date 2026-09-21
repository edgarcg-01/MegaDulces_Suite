import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { BreakdownGrain, BreakdownRow } from '../weekly.service';
import { AnalisisStateService, GRAIN_OPTIONS } from './analisis-state.service';

/**
 * `[TDA.A1]` LA CASCADA — la misma fotografía, repetida hacia abajo.
 *
 * Arriba de esta tabla la pantalla dice «cómo vengo». Acá dice «cómo vengo comparado
 * conmigo mismo»: el MISMO rango partido en semanas, días de la semana, meses,
 * trimestres o años, con el mismo juego de indicadores en cada fila. Abrir una fila
 * baja un nivel — la semana a sus días, el lunes a cada lunes, el trimestre a sus meses.
 *
 * Tres cosas que la tabla hace a propósito:
 *
 *  1. **«—» no es cero.** Toda razón que el servidor no pudo medir en ESE bucket llega
 *     `null` y se pinta «—» con el motivo en el título. Un mes sin tickets no tuvo un
 *     ticket promedio de $0; decir $0 es afirmar algo falso (ADR-056).
 *  2. **El Δ% se lee hacia abajo.** Cada fila se compara con la de arriba, que es el
 *     período anterior del mismo tipo. En grano «día de la semana» los padres NO lo
 *     llevan: el lunes no viene después del domingo, y un número ahí parecería medido.
 *  3. **La cobertura va en la fila**, no en una nota al pie: cada renglón dice cuántos
 *     de sus días tienen venta y cuántos tienen tickets del POS. Es lo que explica un
 *     «—» y lo que delata un período a medias que de otro modo se leería como caída.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-analisis-cascada',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectButtonModule, TableModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card-premium card-flat cs-panel">
      <div class="cs-head">
        <div class="cs-head-text">
          <h3 class="cs-title">
            Evolución por período
            @if (st.breakdownRep()?.scope; as sc) { <span class="cs-chip">{{ sc.name }}</span> }
          </h3>
          <p class="cs-sub">
            El mismo rango, partido {{ granoFrase() }}. Abre una fila para ver {{ granoHijo() }}.
          </p>
        </div>
        <p-selectbutton [options]="grainOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                        [ngModel]="st.grain()" (ngModelChange)="st.changeGrain($event)"
                        styleClass="sb-liquid sb-liquid-sm" ariaLabel="Grano de la cascada" />
      </div>

      @if (st.grainCorto(); as g) {
        <p class="cs-warn">
          <i class="pi pi-info-circle"></i>
          El rango elegido son {{ st.days() }} días: para comparar {{ g.label.toLowerCase() }} contra
          {{ g.label.toLowerCase() }} hacen falta al menos {{ g.minDays }}. Amplía el período de arriba.
        </p>
      }

      @if (st.breakdownError()) {
        <div class="cs-banner">
          <i class="pi pi-exclamation-triangle"></i> No se pudo cargar la evolución.
          <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadBreakdown()">
            <span class="p-button-label">Reintentar</span>
          </button>
        </div>
      } @else if (st.breakdownRep(); as rep) {
        <p-table [value]="rep.rows" dataKey="key" styleClass="p-datatable-sm cs-table"
                 [rowHover]="true" [scrollable]="true" scrollHeight="560px">
          <ng-template #header>
            <tr>
              <th class="cs-sticky cs-th-period">Período</th>
              <th class="cs-r">Venta</th>
              <th class="cs-r" pTooltip="Contra el período anterior del mismo tipo (la fila de arriba)." tooltipPosition="bottom">Δ%</th>
              <th class="cs-r" pTooltip="Qué parte de la venta del rango cayó en este período." tooltipPosition="bottom">Part.</th>
              <th class="cs-r">Margen</th>
              <th class="cs-r">Mg%</th>
              @if (!modoLinea()) {
                <th class="cs-r">Tickets</th>
                <th class="cs-r">Ticket prom.</th>
                <th class="cs-r" pTooltip="Renglones distintos por venta." tooltipPosition="bottom">Part./tkt</th>
                <th class="cs-r" pTooltip="Cuánto deja cada renglón. Cruza el fact con el POS: sin cobertura pareja se declara sin medir." tooltipPosition="bottom">$/partida</th>
              }
              <th class="cs-r">Unidades</th>
              @if (!modoLinea()) {
                <th class="cs-r" pTooltip="Piezas o kg por venta. Cruza el fact con el POS." tooltipPosition="bottom">Uds/tkt</th>
              }
              <th class="cs-r">$/unidad</th>
              @if (!modoLinea()) {
                <th class="cs-r" pTooltip="Clientes con registro. Excluye mostrador anónimo y televenta: es otro universo, no cuadra contra la venta." tooltipPosition="bottom">Clientes</th>
                <th class="cs-r">$/cliente</th>
                <th class="cs-r cs-th-cov" pTooltip="Días del período con venta / días con tickets del POS. Es lo que explica un «—»." tooltipPosition="bottom">Cobertura</th>
              }
            </tr>
          </ng-template>

          <ng-template #body let-r let-expanded="expanded">
            <tr class="cs-row-parent">
              <td class="cs-sticky">
                <div class="cs-period">
                  @if (r.children.length > 1) {
                    <button type="button" class="cs-toggle" [pRowToggler]="r"
                            [attr.aria-label]="(expanded ? 'Cerrar ' : 'Abrir ') + r.label">
                      <i [class]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"></i>
                    </button>
                  } @else {
                    <span class="cs-toggle cs-toggle-off" aria-hidden="true"></span>
                  }
                  <span class="cs-period-txt">
                    <span class="cs-period-lbl">{{ r.label }}</span>
                    @if (r.sub) { <span class="cs-period-sub">{{ r.sub }}</span> }
                  </span>
                </div>
              </td>
              <ng-container [ngTemplateOutlet]="celdas" [ngTemplateOutletContext]="{ $implicit: r }" />
            </tr>
          </ng-template>

          <!--
            Los hijos se emiten como <tr> HERMANOS de la misma tabla, no como una tabla
            anidada dentro de un colspan: una tabla anidada NO hereda los anchos del
            padre, así que las columnas del detalle quedarían corridas contra las de
            arriba — que es exactamente lo que hace inservible una cascada.
          -->
          <ng-template #expandedrow let-r>
            @for (k of r.children; track k.key) {
              <tr class="cs-row-kid">
                <td class="cs-sticky cs-kid-period">
                  <span class="cs-period-txt">
                    <span class="cs-period-lbl">{{ k.label }}</span>
                    @if (k.sub) { <span class="cs-period-sub">{{ k.sub }}</span> }
                  </span>
                </td>
                <ng-container [ngTemplateOutlet]="celdas" [ngTemplateOutletContext]="{ $implicit: k }" />
              </tr>
            }
          </ng-template>

          <ng-template #emptymessage>
            <tr>
              <td [attr.colspan]="nCols()" class="cs-empty">
                Ninguna sucursal de tu alcance registra venta entre
                {{ rep.period.from | date: 'dd/MM/yy' }} y {{ rep.period.to | date: 'dd/MM/yy' }}.
                Amplía el período o cambia la sucursal.
              </td>
            </tr>
          </ng-template>
        </p-table>

        <p class="cs-note an-muted">
          Δ% compara cada fila con la de arriba.
          @if (rep.grain === 'weekday') {
            En «día de la semana» los renglones no llevan Δ% —el lunes no viene después del domingo—;
            el Δ% aparece al abrir la fila, donde cada lunes sí se compara con el lunes anterior.
          }
          «Part.» es participación en la venta del rango (en las filas abiertas, del período que las contiene).
          Un «—» es una razón que <strong>no se pudo medir</strong> en ese período, nunca un cero.
          Venta, margen y unidades salen del fact; tickets y partidas del POS; clientes de la facturación a nombre.
          @if (rep.scope; as sc) {
            <br />
            Acotado a {{ sc.kind === 'producto' ? 'el producto' : 'la línea' }} <strong>{{ sc.name }}</strong>.
            Por eso no están tickets, ticket promedio, partidas, $/partida, unidades por ticket ni clientes:
            <strong>un ticket lleva varios productos y de varias líneas</strong>, así que ninguno de esos
            números es atribuible a uno solo. Repartirlos sería inventarlos, y dejar el de la tienda entera
            se leería como si fuera de {{ sc.kind === 'producto' ? 'este producto' : 'esta línea' }}.
          }
        </p>
      } @else {
        <div class="cs-loading">Cargando la evolución…</div>
      }
    </div>

    <!-- Las 15 celdas numéricas. Una sola definición para padres e hijos: si divergieran,
         abrir una fila mostraría columnas que no son las de arriba. -->
    <ng-template #celdas let-r>
      <td class="cs-r cs-strong">{{ money(r.revenue) }}</td>
      <td class="cs-r"><span [ngClass]="deltaCls(r.delta_pct)">{{ deltaTxt(r.delta_pct) }}</span></td>
      <td class="cs-r an-muted">{{ r.share_pct == null ? '—' : (r.share_pct | number: '1.1-1') + '%' }}</td>
      <td class="cs-r an-muted">{{ money(r.margin) }}</td>
      <td class="cs-r an-muted">{{ r.margin_pct == null ? '—' : (r.margin_pct | number: '1.1-1') + '%' }}</td>
      @if (!modoLinea()) {
        <td class="cs-r">{{ num(r.tickets) }}</td>
        <td class="cs-r" [title]="porQue(r, 'pos')">{{ r.avg_ticket == null ? '—' : money(r.avg_ticket) }}</td>
        <td class="cs-r" [title]="porQue(r, 'pos')">{{ r.basket == null ? '—' : (r.basket | number: '1.2-2') }}</td>
        <td class="cs-r" [title]="porQue(r, 'cruce')">{{ r.avg_line == null ? '—' : money2(r.avg_line) }}</td>
      }
      <td class="cs-r">{{ num(r.units) }}</td>
      @if (!modoLinea()) {
        <td class="cs-r" [title]="porQue(r, 'cruce')">{{ r.units_per_ticket == null ? '—' : (r.units_per_ticket | number: '1.1-1') }}</td>
      }
      <td class="cs-r" [title]="porQue(r, 'fact')">{{ r.avg_unit == null ? '—' : money2(r.avg_unit) }}</td>
      @if (!modoLinea()) {
        <td class="cs-r">{{ num(r.customers) }}</td>
        <td class="cs-r an-muted" [title]="porQue(r, 'clientes')">{{ r.revenue_per_customer == null ? '—' : money(r.revenue_per_customer) }}</td>
        <td class="cs-r cs-cov" [title]="covTitle(r)">
          <span [class.cs-cov-gap]="r.fact_days > 0 && (r.pos_days ?? 0) < r.fact_days">{{ r.pos_days }}</span><span class="an-muted">/{{ r.fact_days }}</span>
        </td>
      }
    </ng-template>
  `,
  styles: [
    `
      :host { display: block; }
      .cs-panel { padding: 1rem; margin-bottom: 1rem; }
      .cs-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
      .cs-title { margin: 0; font-size: .85rem; font-weight: 700; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
      .cs-chip { font-size: .7rem; font-weight: 600; padding: .1rem .5rem; border-radius: var(--r-full, 999px);
                 background: color-mix(in srgb, var(--action) 12%, transparent); color: var(--action); }
      .cs-sub { margin: .2rem 0 0; font-size: .75rem; color: var(--text-muted); max-width: 46ch; }
      .cs-warn { display: flex; align-items: center; gap: .45rem; margin: 0 0 .8rem; padding: .5rem .7rem; font-size: .76rem;
                 background: color-mix(in srgb, var(--warn-fg) 8%, transparent);
                 border: 1px solid color-mix(in srgb, var(--warn-fg) 28%, transparent); border-radius: var(--r-md); }
      .cs-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent);
                   border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md);
                   padding: .7rem .9rem; font-size: .82rem; }
      .cs-loading, .cs-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }

      /* Densidad Operations: la tabla es ancha a propósito (15 indicadores) y por eso
         scrollea en horizontal con la columna del período congelada. Sin eso, al llegar
         a "$/cliente" ya no sabes de qué período es la fila. */
      .cs-table { font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .8125rem); }
      .cs-r { text-align: right; white-space: nowrap; }
      .cs-strong { font-weight: 700; }
      .an-muted { color: var(--text-muted); }
      .cs-sticky { position: sticky; left: 0; z-index: 2; background: var(--card-bg); min-width: 11rem; }
      .cs-th-period { z-index: 3; }
      .cs-th-cov { min-width: 5.5rem; }
      .cs-period { display: flex; align-items: center; gap: .3rem; }
      .cs-period-txt { display: flex; flex-direction: column; line-height: 1.2; }
      .cs-period-lbl { font-weight: 600; }
      .cs-period-sub { font-size: var(--fs-xs, .75rem); color: var(--text-muted); }
      .cs-toggle { display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem;
                   border: 0; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: var(--r-sm); }
      .cs-toggle:hover { color: var(--text-main); background: var(--hover-bg, rgba(0,0,0,.04)); }
      .cs-toggle:focus-visible { outline: 2px solid var(--action-ring, var(--action)); outline-offset: 1px; }
      .cs-toggle-off { cursor: default; }
      .cs-toggle i { font-size: .7rem; }

      /* Segundo nivel: son filas de la MISMA tabla (ver el comentario del template), así
         que las columnas ya alinean solas. Acá sólo se las distingue: tinte de fondo y
         el rótulo con sangría, para que se lean como detalle y no como otro período. */
      .cs-row-kid > td { background: color-mix(in srgb, var(--text-main) 3%, transparent); }
      .cs-row-kid .cs-period-lbl { font-weight: 400; }
      .cs-kid-period { padding-left: 2.35rem !important; }

      .cs-cov { font-size: var(--fs-xs, .75rem); }
      .cs-cov-gap { color: var(--warn-fg); font-weight: 700; }
      .up { color: var(--ok-fg); } .down { color: var(--bad-fg); } .flat { color: var(--text-muted); }
      .cs-note { font-size: .72rem; margin: .7rem 0 0; }
    `,
  ],
})
export class AnalisisCascadaComponent {
  protected readonly st = inject(AnalisisStateService);
  protected readonly grainOptions = GRAIN_OPTIONS;

  /**
   * `[TDA.A2]`/`[TDA.A3]` ¿La cascada está acotada (a una línea o a un producto)? Se lee de
   * la RESPUESTA (`scope`) y no de la selección de la pantalla, a propósito: mientras la
   * petición viaja, la selección ya cambió pero la tabla todavía muestra la respuesta
   * vieja — mirando la selección se esconderían columnas de datos que sí las tienen.
   */
  protected readonly modoLinea = computed(() => !!this.st.breakdownRep()?.scope);
  /** Columnas visibles: 16 en la tienda completa, 8 cuando está acotada. */
  protected readonly nCols = computed(() => (this.modoLinea() ? 8 : 16));

  /** Frase del encabezado, para que el grano se lea en llano y no como jerga. */
  protected readonly granoFrase = computed(() => {
    const g: BreakdownGrain = this.st.grain();
    return g === 'week' ? 'semana por semana'
      : g === 'weekday' ? 'por día de la semana'
      : g === 'month' ? 'mes por mes'
      : g === 'quarter' ? 'trimestre por trimestre'
      : 'año por año';
  });
  protected readonly granoHijo = computed(
    () => GRAIN_OPTIONS.find((o) => o.value === this.st.grain())?.hijo ?? 'el detalle',
  );

  /**
   * Por qué un «—». Se distingue el motivo porque no son el mismo problema: sin tickets
   * falta el POS de esa plaza, sin cobertura pareja el cruce sería un absurdo, y sin
   * venta no hay nada que dividir. Un solo texto genérico haría que las tres se
   * confundan con "está roto".
   */
  protected porQue(r: BreakdownRow, tipo: 'pos' | 'cruce' | 'fact' | 'clientes'): string {
    if (tipo === 'pos' && r.tickets <= 0) return 'Sin tickets del POS en este período: no hay entre qué dividir.';
    if (tipo === 'cruce' && (r.fact_days === 0 || r.pos_days < r.fact_days)) {
      return `El POS cubrió ${r.pos_days} de los ${r.fact_days} días con venta de este período. `
        + 'Dividir la venta de todos los días entre los tickets de unos pocos daría un número absurdo, así que no se publica.';
    }
    if (tipo === 'fact' && r.units <= 0) return 'Sin unidades registradas en este período.';
    if (tipo === 'clientes' && r.customers <= 0) return 'Ningún cliente con registro facturó en este período (el mostrador anónimo no cuenta acá).';
    return '';
  }

  protected covTitle(r: BreakdownRow): string {
    return `${r.fact_days} ${r.fact_days === 1 ? 'día' : 'días'} con venta · ${r.pos_days} con tickets del POS`;
  }

  protected deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  protected deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  protected money(v: number | null): string {
    return (v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
  protected money2(v: number | null): string {
    return (v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  protected num(v: number | null): string { return Math.round(v ?? 0).toLocaleString('es-MX'); }
}
