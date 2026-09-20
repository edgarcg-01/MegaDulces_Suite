import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectButtonModule } from 'primeng/selectbutton';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { CustomerEstado } from '../weekly.service';
import { AnalisisStateService } from './analisis-state.service';

/**
 * `[TDA.A4]` Sección **Clientes** de `/tienda/analisis-semanal`.
 *
 * ── ⭐ Esta pantalla abre declarando su techo, y esa es su decisión de diseño ───────────
 * El mostrador es anónimo. Medido en prod (12 meses): la facturación a nombre son $23.1M
 * contra **$105.2M** del fact de venta, el 62 % de eso es televenta, y de los $7.96M que
 * quedan con el recorte de esta pantalla, **$6.48M son DOS cuentas del propio piso de
 * venta**. Clientes externos de verdad: ~1.4 % de la venta.
 *
 * Una tabla de clientes con cifras grandes y sin ese encabezado se lee como si fuera la
 * venta del negocio. Por eso la primera fila de la pantalla no es un KPI: es la proporción.
 *
 * ── Lo que la ficha del ERP aporta ─────────────────────────────────────────────────────
 * El negocio mandó la pantalla «Datos del cliente» de Kepler y de ahí salen las columnas
 * que esta tabla no podría inventar: **Grupo · Zona · Vendedor · Límite de crédito ·
 * Plazo**, vía `analytics.v_customer_master` (vista derivada del ODS).
 *
 * El **Grupo** es además el que separa al cliente real de la cuenta interna — sin él, la
 * propia tienda encabeza el ranking de clientes y parece uno.
 *
 * ⚠️ **La clave de cliente es por sucursal** y 141 de 1,574 son una persona distinta según
 * la plaza (el propio ERP lo advierte). Además **a un cliente le pueden vender varios
 * vendedores o sucursales**. Por eso la tabla muestra la plaza en cada fila y **no se
 * pueden sumar clientes entre plazas** — se declara al pie.
 *
 * ── Por qué acá NO está la cascada ─────────────────────────────────────────────────────
 * Las otras pestañas la tienen porque su dato sale del fact de venta. **El fact no sabe
 * quién compró**: el cliente vive en la facturación, que es otro universo y otro tamaño.
 * Poner la misma cascada acá mezclaría los dos y daría cifras que no cuadran con ninguna
 * de las dos pantallas. En su lugar, la recencia y el estado (nuevo/activo/dormido) salen
 * de las fechas de la propia facturación.
 *
 * OJO: acá adentro NO van acentos graves (template literal de JS).
 */
@Component({
  selector: 'app-tienda-analisis-clientes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, SelectButtonModule, TableModule, TagModule, TooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (st.customersError()) {
      <div class="cl-banner">
        <i class="pi pi-exclamation-triangle"></i> No se pudo cargar la cartera de clientes.
        <button pButton type="button" class="p-button-text p-button-sm" (click)="st.loadCustomers()">
          <span class="p-button-label">Reintentar</span>
        </button>
      </div>
    } @else if (st.customersRep(); as rep) {
      <!-- ───────────────── EL TECHO: lo primero que se ve ───────────────── -->
      <div class="card-premium card-flat cl-techo">
        <h3 class="cl-title">De toda la venta, ¿cuánta sabemos de quién fue?</h3>
        <div class="cl-barra" role="img"
             [attr.aria-label]="'Clientes ' + money(rep.techo.venta_clientes) + ', cuentas internas ' + money(rep.techo.venta_interna) + ', mostrador anónimo ' + money(anonimo(rep))">
          <span class="cl-seg cl-seg-cli" [style.width.%]="anchoPct(rep.techo.venta_clientes, rep.techo.venta_fact)"></span>
          <span class="cl-seg cl-seg-int" [style.width.%]="anchoPct(rep.techo.venta_interna, rep.techo.venta_fact)"></span>
          <span class="cl-seg cl-seg-ano" [style.width.%]="anchoPct(anonimo(rep), rep.techo.venta_fact)"></span>
        </div>
        <ul class="cl-leyenda">
          <li><span class="cl-dot cl-seg-cli"></span>
            <strong>{{ money(rep.techo.venta_clientes) }}</strong> de clientes con nombre
            <span class="cl-muted">({{ rep.techo.pct_identificado == null ? '—' : (rep.techo.pct_identificado | number: '1.1-1') + '%' }})</span>
          </li>
          <li><span class="cl-dot cl-seg-int"></span>
            <strong>{{ money(rep.techo.venta_interna) }}</strong> facturado a cuentas internas
            <span class="cl-muted">(el propio piso de venta y las cuentas de vendedores — no son clientes)</span>
          </li>
          <li><span class="cl-dot cl-seg-ano"></span>
            <strong>{{ money(anonimo(rep)) }}</strong> de mostrador anónimo
            <span class="cl-muted">(se cobró y se fue; nadie pidió factura)</span>
          </li>
        </ul>
        <p class="cl-note cl-muted">
          Total de la tienda en el período: <strong>{{ money(rep.techo.venta_fact) }}</strong>.
          Todo lo de abajo habla <strong>sólo</strong> de la primera franja. Que sea chica no es un
          defecto del dato: el mostrador es anónimo por naturaleza. La televenta queda fuera — tiene
          su propio módulo.
        </p>
      </div>

      <!-- ───────────── DÓNDE CAE LA FACTURACIÓN (Grupo del ERP) ───────────── -->
      @if (rep.grupos.length > 1) {
        <div class="card-premium card-flat cl-panel">
          <h3 class="cl-title">Dónde cae lo facturado, según el Grupo del ERP</h3>
          <p class="cl-sub">
            El Grupo es el campo que el ERP ya mantiene en la ficha del cliente, y es el que
            distingue una cuenta interna de un cliente real. Se muestran las dos.
          </p>
          <p-table [value]="rep.grupos" styleClass="p-datatable-sm cl-table" [rowHover]="true">
            <ng-template #header>
              <tr><th>Grupo</th><th class="ta-r">Clientes</th><th class="ta-r">Facturado</th><th class="ta-r">Part.</th></tr>
            </ng-template>
            <ng-template #body let-g>
              <tr [class.cl-fila-int]="g.es_interno">
                <td>
                  {{ g.name }}
                  @if (g.es_interno) { <p-tag value="interno" severity="warn" styleClass="cl-tag" /> }
                </td>
                <td class="ta-r">{{ num(g.clientes) }}</td>
                <td class="ta-r strong">{{ money(g.revenue) }}</td>
                <td class="ta-r cl-muted">{{ g.share_pct == null ? '—' : (g.share_pct | number: '1.1-1') + '%' }}</td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      }

      <!-- ───────────────────────── LA CARTERA ───────────────────────── -->
      <div class="card-premium card-flat cl-panel">
        <div class="cl-head">
          <div>
            <h3 class="cl-title">Cartera</h3>
            <p class="cl-sub">
              @if (rep.resumen.nuevos_confiable) {
                <strong>{{ rep.resumen.nuevos }}</strong> nuevos ·
              }
              <strong>{{ rep.resumen.activos }}</strong> activos ·
              <strong>{{ rep.resumen.dormidos }}</strong> dormidos
              <span class="cl-muted">(compraron el período anterior y no éste)</span>
            </p>
            @if (!rep.resumen.nuevos_confiable) {
              <!--
                Si el período arranca donde arranca la facturación, TODOS salen «nuevo» — no
                porque lo sean, sino porque no hay con qué saber que ya venían. Se declara en
                vez de publicar un número de altas que sería el padrón entero (ADR-056).
              -->
              <p class="cl-aviso">
                <i class="pi pi-info-circle"></i>
                No se puede decir quién es <strong>nuevo</strong>: la facturación disponible
                @if (rep.resumen.historia_desde) { empieza el {{ rep.resumen.historia_desde | date: 'dd/MM/yy' }}, }
                @else { no alcanza hacia atrás, }
                dentro del período elegido. Acorta el período o corre uno más reciente para que
                «nuevo» signifique algo.
              </p>
            }
          </div>
          <div class="cl-acciones">
            <p-selectbutton [options]="segOptions" optionLabel="label" optionValue="value" [allowEmpty]="false"
                            [ngModel]="st.cliSegmento()" (ngModelChange)="st.changeCliFiltro({ segmento: $event })"
                            styleClass="sb-liquid sb-liquid-sm" ariaLabel="Segmento de clientes" />
            <input pInputText type="search" [ngModel]="texto()" (ngModelChange)="onTexto($event)"
                   placeholder="Buscar cliente o clave" aria-label="Buscar cliente" class="cl-search" />
          </div>
        </div>

        <p-table [value]="rep.rows" styleClass="p-datatable-sm cl-table" [rowHover]="true"
                 [scrollable]="true" scrollHeight="560px"
                 [paginator]="rep.rows.length > 50" [rows]="50" [rowsPerPageOptions]="[50, 100, 200]"
                 currentPageReportTemplate="{first}–{last} de {totalRecords}" [showCurrentPageReport]="true">
          <ng-template #header>
            <tr>
              <th class="cl-sticky">Cliente</th>
              <th pTooltip="La clave de cliente es POR SUCURSAL: la misma clave puede ser otra persona en otra plaza." tooltipPosition="bottom">Plaza</th>
              <th>Grupo</th>
              <th>Zona</th>
              <th>Vendedor</th>
              <th class="ta-r">Venta</th>
              <th class="ta-r">Δ%</th>
              <th class="ta-r">Part.</th>
              <th class="ta-r" pTooltip="Documentos en el período: con cuántas compras juntó esa venta." tooltipPosition="bottom">Compras</th>
              <th class="ta-r">Ticket prom.</th>
              <th class="ta-r" pTooltip="Días desde su última compra, contra el fin del período." tooltipPosition="bottom">Sin comprar</th>
              <th>Estado</th>
              <th class="ta-r" pTooltip="De la ficha del ERP. 0 = sin línea de crédito asignada." tooltipPosition="bottom">Límite</th>
              <th class="ta-r">Plazo</th>
            </tr>
          </ng-template>
          <ng-template #body let-c>
            <tr>
              <td class="cl-sticky">
                <span class="cl-nom">{{ c.nombre }}</span>
                <span class="cl-code">{{ c.cliente_code }}</span>
              </td>
              <td class="cl-muted">{{ c.sucursal }}</td>
              <td class="cl-tax" [title]="c.grupo || ''">{{ c.grupo || '—' }}</td>
              <td class="cl-tax" [title]="c.zona || ''">{{ c.zona || '—' }}</td>
              <td class="cl-tax" [title]="c.vendedor || ''">{{ c.vendedor || '—' }}</td>
              <td class="ta-r strong">{{ money(c.revenue) }}</td>
              <td class="ta-r"><span [ngClass]="deltaCls(c.delta_pct)">{{ deltaTxt(c.delta_pct) }}</span></td>
              <td class="ta-r cl-muted">{{ c.share_pct == null ? '—' : (c.share_pct | number: '1.1-1') + '%' }}</td>
              <td class="ta-r">{{ num(c.docs) }}</td>
              <td class="ta-r">{{ c.ticket_prom == null ? '—' : money(c.ticket_prom) }}</td>
              <td class="ta-r">{{ c.dias_sin_comprar == null ? '—' : c.dias_sin_comprar + ' d' }}</td>
              <td><p-tag [value]="estadoLbl(c.estado)" [severity]="estadoSev(c.estado)" styleClass="cl-tag" /></td>
              <td class="ta-r cl-muted">{{ c.limite_credito == null ? '—' : money(c.limite_credito) }}</td>
              <td class="ta-r cl-muted">{{ c.plazo_dias == null ? '—' : c.plazo_dias + ' d' }}</td>
            </tr>
          </ng-template>
          <ng-template #emptymessage>
            <tr>
              <td colspan="14" class="cl-empty">
                @if (st.cliQ()) {
                  Ningún cliente coincide con «{{ st.cliQ() }}» en este período y segmento.
                } @else {
                  Ninguna sucursal de tu alcance facturó a nombre de un cliente entre
                  {{ rep.period.from | date: 'dd/MM/yy' }} y {{ rep.period.to | date: 'dd/MM/yy' }}.
                }
              </td>
            </tr>
          </ng-template>
        </p-table>

        <p class="cl-note cl-muted">
          Grupo, Zona, Vendedor, Límite y Plazo salen de la ficha del cliente en el ERP.
          <strong>La clave de cliente es por sucursal</strong>: 141 de 1,574 claves son una persona
          distinta según la plaza —el propio ERP lo advierte— y a un mismo cliente le pueden vender
          varios vendedores o sucursales. Por eso cada fila trae su plaza y
          <strong>no se pueden sumar clientes entre plazas</strong>.
          El Vendedor es el <strong>asignado</strong> en la ficha, no necesariamente quien hizo cada venta.
          @if (rep.as_of.facturacion) { Última factura vista: {{ rep.as_of.facturacion | date: 'dd/MM/yy' }}. }
        </p>
      </div>
    } @else {
      <div class="cl-loading">Cargando la cartera…</div>
    }
  `,
  styles: [
    `
      :host { display: block; }
      .cl-techo, .cl-panel { padding: 1rem; margin-bottom: 1rem; }
      .cl-title { margin: 0; font-size: .85rem; font-weight: 700; }
      .cl-sub { margin: .2rem 0 0; font-size: .75rem; color: var(--text-muted); max-width: 70ch; }
      /* La proporción se ve antes de leerse: una sola barra con las tres franjas. */
      .cl-barra { display: flex; height: .9rem; border-radius: var(--r-sm); overflow: hidden; margin: .8rem 0 .6rem;
                  background: var(--surface-2, rgba(0,0,0,.05)); }
      .cl-seg { display: block; height: 100%; }
      .cl-seg-cli { background: var(--action); }
      .cl-seg-int { background: color-mix(in srgb, var(--warn-fg) 70%, transparent); }
      .cl-seg-ano { background: color-mix(in srgb, var(--text-muted) 32%, transparent); }
      .cl-leyenda { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-size: .8rem; }
      .cl-leyenda li { display: flex; align-items: baseline; gap: .45rem; }
      .cl-dot { width: .6rem; height: .6rem; border-radius: 50%; flex: none; }
      .cl-note { font-size: .72rem; margin: .7rem 0 0; }
      .cl-aviso { display: flex; align-items: flex-start; gap: .4rem; margin: .45rem 0 0; padding: .45rem .65rem; font-size: .75rem;
                  background: color-mix(in srgb, var(--warn-fg) 8%, transparent);
                  border: 1px solid color-mix(in srgb, var(--warn-fg) 28%, transparent); border-radius: var(--r-md); max-width: 62ch; }
      .cl-muted { color: var(--text-muted); }

      .cl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .8rem; }
      .cl-acciones { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
      .cl-search { min-width: 14rem; }
      .cl-table { font-variant-numeric: tabular-nums; font-size: var(--fs-sm, .8125rem); }
      .ta-r { text-align: right; white-space: nowrap; }
      .strong { font-weight: 700; }
      /* Tabla ancha: el nombre se congela o a la altura de «Plazo» ya no sabés de quién es la fila. */
      .cl-sticky { position: sticky; left: 0; z-index: 2; background: var(--card-bg); min-width: 14rem; }
      th.cl-sticky { z-index: 3; }
      .cl-nom { display: block; font-weight: 500; }
      .cl-code { display: block; font-size: .7rem; color: var(--text-muted); font-family: var(--font-mono, ui-monospace, monospace); }
      .cl-tax { font-size: var(--fs-xs, .75rem); color: var(--text-muted); max-width: 11rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cl-fila-int > td { background: color-mix(in srgb, var(--warn-fg) 6%, transparent); }
      .cl-tag { font-size: .68rem; }
      .cl-banner { display: flex; align-items: center; gap: .5rem; background: color-mix(in srgb, var(--bad-fg) 8%, transparent);
                   border: 1px solid color-mix(in srgb, var(--bad-fg) 30%, transparent); border-radius: var(--r-md);
                   padding: .7rem .9rem; font-size: .82rem; margin-bottom: 1rem; }
      .cl-loading, .cl-empty { padding: 2rem; text-align: center; color: var(--text-muted); font-size: .85rem; }
      .up { color: var(--ok-fg); } .down { color: var(--bad-fg); } .flat { color: var(--text-muted); }
      @media (max-width: 48rem) { .cl-search { min-width: 100%; } .cl-acciones { width: 100%; } }
    `,
  ],
})
export class TiendaAnalisisClientesComponent implements OnInit, OnDestroy {
  protected readonly st = inject(AnalisisStateService);
  readonly texto = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly segOptions = [
    { label: 'Clientes', value: 'externos' as const },
    { label: 'Cuentas internas', value: 'internos' as const },
    { label: 'Todos', value: 'todos' as const },
  ];

  ngOnInit(): void {
    this.texto.set(this.st.cliQ());
    // Esta pestaña no usa la cascada (el fact no sabe quién compró — ver el encabezado),
    // así que suelta cualquier recorte que venga de las otras.
    this.st.limpiarAlcanceSalvo(null);
    this.st.need('customers');
  }
  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  onTexto(v: string): void {
    this.texto.set(v);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.st.changeCliFiltro({ q: v }), 350);
  }

  /**
   * Lo que se cobró y no quedó a nombre de nadie. Se DERIVA restando, y se protege del
   * negativo: si la facturación superara al fact (universos distintos, que es justo lo que
   * esta pantalla advierte), una franja negativa rompería la barra sin explicar nada.
   */
  anonimo(rep: { techo: { venta_fact: number; venta_facturada: number } }): number {
    return Math.max(0, rep.techo.venta_fact - rep.techo.venta_facturada);
  }
  anchoPct(parte: number, total: number): number {
    if (!total || total <= 0) return 0;
    return Math.max(0, Math.min(100, (parte / total) * 100));
  }

  estadoLbl(e: CustomerEstado): string {
    return e === 'nuevo' ? 'Nuevo' : e === 'activo' ? 'Activo' : 'Dormido';
  }
  estadoSev(e: CustomerEstado): 'success' | 'info' | 'danger' {
    return e === 'nuevo' ? 'success' : e === 'activo' ? 'info' : 'danger';
  }

  deltaCls(p: number | null): string { return p == null ? 'flat' : p > 0 ? 'up' : p < 0 ? 'down' : 'flat'; }
  deltaTxt(p: number | null): string { return p == null ? '—' : (p > 0 ? '▲ +' : p < 0 ? '▼ ' : '') + p + '%'; }
  money(v: number | null): string { return (v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  num(v: number): string { return Math.round(v || 0).toLocaleString('es-MX'); }
}
