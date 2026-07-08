import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { CuadreService, Discrepancy, DiscStats, RuleHealth, DiscPlano, CuadreOverview, CashCut, StockMovement, BlindCountResult, BlindCountRow, Foco, ReconAction, ActionPalanca } from '../cuadre.service';

type Tab = 'resumen' | 'focos' | 'cortes' | 'movimientos' | 'arqueo' | 'acciones' | 'descuadres';

/**
 * SM.6 — Consola del Supervisor de Movimientos. 4 tabs: RESUMEN (KPIs + rankings),
 * CORTES DE CAJA (data cruda), MOVIMIENTOS/MERMAS (data cruda), DESCUADRES (bandeja
 * HITL con triage + causa + salud de reglas). Superficie Operations, PrimeNG denso.
 */
@Component({
  selector: 'app-almacen-cuadre',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, ToastModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in cd-page">
      <p-toast></p-toast>
      <header class="surf-page-head cd-head">
        <div class="surf-page-head-text">
          <h1>Supervisor de Movimientos</h1>
          <p class="surf-page-sub">Cuadre de caja e inventario contra los movimientos. Ve todo: la data cruda y los descuadres que el motor detecta.</p>
        </div>
        <div class="cd-head-actions">
          <button pButton type="button" label="Escanear ahora" icon="pi pi-bolt" class="p-button-sm p-button-outlined" [loading]="scanning()" (click)="scan()"></button>
        </div>
      </header>

      <!-- Tabs -->
      <div class="cd-tabs">
        <button [class.active]="tab() === 'resumen'" (click)="go('resumen')"><i class="pi pi-chart-bar"></i> Resumen</button>
        <button [class.active]="tab() === 'focos'" (click)="go('focos')"><i class="pi pi-bullseye"></i> Focos</button>
        <button [class.active]="tab() === 'cortes'" (click)="go('cortes')"><i class="pi pi-wallet"></i> Cortes de caja</button>
        <button [class.active]="tab() === 'movimientos'" (click)="go('movimientos')"><i class="pi pi-box"></i> Movimientos</button>
        <button [class.active]="tab() === 'arqueo'" (click)="go('arqueo')"><i class="pi pi-eye-slash"></i> Arqueo ciego</button>
        <button [class.active]="tab() === 'acciones'" (click)="go('acciones')"><i class="pi pi-check-circle"></i> Acciones</button>
        <button [class.active]="tab() === 'descuadres'" (click)="go('descuadres')"><i class="pi pi-flag"></i> Descuadres @if (stats()?.pendientes) { <span class="cd-badge">{{ stats()?.pendientes }}</span> }</button>
      </div>

      <!-- ══ RESUMEN ══ -->
      @if (tab() === 'resumen') {
        @if (ov(); as o) {
          <div class="cd-kpis">
            <div class="cd-kpi"><span class="cd-kpi-val">{{ o.caja.cortes | number }}</span><span class="cd-kpi-lbl">Cortes de caja</span></div>
            <div class="cd-kpi"><span class="cd-kpi-val">{{ money(o.caja.venta) }}</span><span class="cd-kpi-lbl">Venta total (3 formas)</span></div>
            <div class="cd-kpi" [class.bad]="o.caja.con_descuadre > 0"><span class="cd-kpi-val">{{ o.caja.con_descuadre | number }}</span><span class="cd-kpi-lbl">Descuadre efectivo</span></div>
            <div class="cd-kpi" [class.bad]="o.caja.descuadre_no_efectivo > 0"><span class="cd-kpi-val">{{ o.caja.descuadre_no_efectivo | number }}</span><span class="cd-kpi-lbl">Descuadre tarjeta/transf</span></div>
            <div class="cd-kpi"><span class="cd-kpi-val bad">{{ money(o.caja.faltante) }}</span><span class="cd-kpi-lbl">Faltante caja</span></div>
            <div class="cd-kpi"><span class="cd-kpi-val">{{ money(o.caja.sobrante) }}</span><span class="cd-kpi-lbl">Sobrante caja</span></div>
            <div class="cd-kpi" [class.bad]="o.caja.pct_exacto >= 90" [class.warn]="o.caja.pct_exacto >= 70 && o.caja.pct_exacto < 90">
              <span class="cd-kpi-val">{{ o.caja.pct_exacto }}%</span><span class="cd-kpi-lbl">Cuadre exacto (arqueo no ciego)</span></div>
            <div class="cd-kpi" [class.warn]="o.caja.turnos_largos > 0"><span class="cd-kpi-val">{{ o.caja.turnos_largos | number }}</span><span class="cd-kpi-lbl">Turnos ≥10h (fatiga)</span></div>
            <div class="cd-kpi"><span class="cd-kpi-val bad">{{ money(o.inventario.monto_merma) }}</span><span class="cd-kpi-lbl">Merma ({{ o.inventario.mermas | number }})</span></div>
            <div class="cd-kpi" [class.bad]="o.descuadres.criticos > 0"><span class="cd-kpi-val">{{ o.descuadres.pendientes | number }}</span><span class="cd-kpi-lbl">Descuadres pend. ({{ o.descuadres.criticos }} crít.)</span></div>
          </div>
          @if (o.caja.pct_exacto >= 70 && o.caja.cortes_monto_alto > 0) {
            <div class="cd-note">
              <i class="pi pi-exclamation-triangle"></i>
              <span><strong>{{ o.caja.cuadre_exacto | number }} de {{ o.caja.cortes_monto_alto | number }}</strong> cortes con monto alto cerraron con el efectivo contado <strong>idéntico al esperado, al centavo</strong>. En un conteo físico real eso es casi imposible — el arqueo probablemente no se hace a ciegas, así que un descuadre bajo no garantiza que la caja esté sana. La regla <em>Arqueo no ciego</em> lo señala en Descuadres.</span>
            </div>
          }

          <div class="cd-2col">
            <div class="card-premium card-flat cd-panel">
              <h3 class="cd-card-title">Top cajeros con faltante</h3>
              @if (o.top_cajeros.length) {
                @for (c of o.top_cajeros; track c.cajero + c.sucursal) {
                  <div class="cd-bar-row">
                    <span class="cd-bar-lbl">{{ c.cajero_nombre || c.cajero }} <span class="muted">· suc {{ c.sucursal }} · {{ c.eventos }}×</span></span>
                    <div class="cd-bar"><div class="cd-bar-fill" [style.width.%]="barPct(c.faltante, o.top_cajeros[0].faltante)"></div></div>
                    <span class="cd-bar-val">{{ money(c.faltante) }}</span>
                  </div>
                }
              } @else { <p class="muted">Sin faltantes registrados.</p> }
            </div>

            <div class="card-premium card-flat cd-panel">
              <h3 class="cd-card-title">Por sucursal</h3>
              <p-table [value]="o.por_sucursal" styleClass="p-datatable-sm" [rowHover]="true">
                <ng-template pTemplate="header"><tr><th>Sucursal</th><th class="ta-r">Cortes</th><th class="ta-r">Faltante caja</th><th class="ta-r">Merma</th></tr></ng-template>
                <ng-template pTemplate="body" let-s>
                  <tr><td>{{ s.sucursal }}</td><td class="ta-r">{{ s.cortes | number }}</td>
                    <td class="ta-r" [class.bad]="s.faltante_caja > 0">{{ money(s.faltante_caja) }}</td>
                    <td class="ta-r" [class.bad]="s.merma > 0">{{ money(s.merma) }}</td></tr>
                </ng-template>
              </p-table>
            </div>
          </div>
        } @else { <p class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin datos. Corre los importers + "Escanear ahora".' }}</p> }
      }

      <!-- ══ FOCOS (P4) ══ -->
      @if (tab() === 'focos') {
        <div class="cd-note">
          <i class="pi pi-bullseye"></i>
          <span>Dónde apuntar primero. Ranking por faltante + señales de riesgo, con la <strong>palanca recomendada</strong> para cada foco. Atacá de arriba hacia abajo.</span>
        </div>
        <div class="cd-filters">
          <div class="cd-seg">
            <button [class.active]="focoScope() === 'caja'" (click)="setFocoScope('caja')">Por caja</button>
            <button [class.active]="focoScope() === 'cajero'" (click)="setFocoScope('cajero')">Por cajero</button>
          </div>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="focos()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()">
            <ng-template pTemplate="header">
              <tr><th style="width:2rem">#</th><th>{{ focoScope() === 'cajero' ? 'Cajero' : 'Caja' }}</th><th class="ta-r">Faltante</th><th class="ta-r">Descuadres</th><th class="ta-r">% exacto</th><th class="ta-r">% handoff</th><th class="ta-r">Turnos ≥10h</th><th>Acción recomendada</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-f let-i="rowIndex">
              <tr>
                <td class="muted">{{ i + 1 }}</td>
                <td>
                  @if (focoScope() === 'cajero') { <span class="cd-prod">{{ f.cajero_nombre || f.cajero }}</span><span class="cd-sku muted">suc {{ f.sucursal }} · {{ f.cajero }}</span> }
                  @else { suc {{ f.sucursal }} · caja {{ f.caja }} }
                </td>
                <td class="ta-r strong bad">{{ money(f.faltante) }}</td>
                <td class="ta-r">{{ f.descuadres }}<span class="muted">/{{ f.cortes }}</span></td>
                <td class="ta-r" [class.bad]="f.pct_exacto >= 80">{{ f.pct_exacto }}%</td>
                <td class="ta-r" [class.bad]="f.pct_handoff >= 70">{{ f.pct_handoff }}%</td>
                <td class="ta-r" [class.bad]="f.turnos_largos >= 5">{{ f.turnos_largos }}</td>
                <td><span class="cd-accion">{{ f.accion }}</span> <button pButton type="button" icon="pi pi-plus" label="Acción" class="p-button-text p-button-sm" (click)="crearAccionDesdeFoco(f)"></button></td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin focos (sin faltante registrado).' }}</td></tr></ng-template>
          </p-table>
        </div>
      }

      <!-- ══ CORTES DE CAJA ══ -->
      @if (tab() === 'cortes') {
        <div class="cd-filters">
          <input class="cd-input" type="text" placeholder="Cajero…" [(ngModel)]="fCajero" (keyup.enter)="loadCortes()">
          <input class="cd-input cd-input-sm" type="text" placeholder="Suc" [(ngModel)]="fSucCaja" (keyup.enter)="loadCortes()">
          <label class="cd-lbl">Desde <input class="cd-input cd-input-date" type="date" [(ngModel)]="fFrom" (change)="loadCortes()"></label>
          <label class="cd-lbl">Hasta <input class="cd-input cd-input-date" type="date" [(ngModel)]="fTo" (change)="loadCortes()"></label>
          <label class="cd-check"><input type="checkbox" [(ngModel)]="fSoloDesc" (change)="loadCortes()"> Solo descuadres</label>
          <button pButton type="button" icon="pi pi-search" label="Filtrar" class="p-button-sm p-button-text" (click)="loadCortes()"></button>
          <span class="cd-count muted">{{ cortes().length }} cortes</span>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="cortes()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()" dataKey="id"
                   [expandedRowKeys]="expandedCortes()" [scrollable]="true" scrollHeight="600px" [paginator]="cortes().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th style="width:2.5rem"></th><th>Fecha</th><th>Sucursal</th><th>Caja</th><th>Cajero</th><th class="ta-r">Efvo esperado</th><th class="ta-r">Contado</th><th class="ta-r">Diferencia</th><th class="ta-r">Tarjeta</th><th class="ta-r">Transf.</th><th class="ta-r">Venta total</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-c let-expanded="expanded">
              <tr [class.cd-row-bad]="abs(c.efectivo_diff) >= 50 || abs(c.tarjeta_diff) >= 50 || abs(c.transfer_diff) >= 50">
                <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" (click)="toggleCorte(c)"></button></td>
                <td>{{ c.business_date | date:'dd/MM/yy' }}</td>
                <td>{{ c.warehouse_name || c.warehouse_code }}</td>
                <td>{{ c.caja }}</td>
                <td>@if (c.cajero_nombre) { {{ c.cajero_nombre }} <span class="cd-code muted">{{ c.cajero_cierre }}</span> } @else { {{ c.cajero_cierre || '—' }} }</td>
                <td class="ta-r">{{ money(c.efectivo_esperado) }}</td>
                <td class="ta-r">{{ money(c.efectivo_contado) }}
                  @if (c.cuadre_exacto) { <i class="pi pi-eye-slash cd-flag" title="Cuadre exacto: contado idéntico al esperado — conteo posiblemente no ciego"></i> }
                </td>
                <td class="ta-r strong" [class.bad]="c.efectivo_diff > 0" [class.ok]="c.efectivo_diff < 0">{{ signed(c.efectivo_diff) }}</td>
                <td class="ta-r" [class.bad]="abs(c.tarjeta_diff) >= 50">{{ money(c.tarjeta_esperado) }}<span class="cd-mini" *ngIf="abs(c.tarjeta_diff) >= 50"> Δ{{ signed(c.tarjeta_diff) }}</span></td>
                <td class="ta-r" [class.bad]="abs(c.transfer_diff) >= 50">{{ money(c.transfer_esperado) }}<span class="cd-mini" *ngIf="abs(c.transfer_diff) >= 50"> Δ{{ signed(c.transfer_diff) }}</span></td>
                <td class="ta-r strong">{{ money(c.venta_total) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="rowexpansion" let-c>
              <tr><td colspan="11" class="cd-ev">
                <div class="cd-corte-grid">
                  <div class="cd-corte-block">
                    <h4>Formas de pago</h4>
                    <table class="cd-mini-table">
                      <tr><th></th><th class="ta-r">Esperado</th><th class="ta-r">Contado</th><th class="ta-r">Diferencia</th></tr>
                      <tr><td>Efectivo</td><td class="ta-r">{{ money(c.efectivo_esperado) }}</td><td class="ta-r">{{ money(c.efectivo_contado) }}</td><td class="ta-r strong" [class.bad]="c.efectivo_diff>0" [class.ok]="c.efectivo_diff<0">{{ signed(c.efectivo_diff) }}</td></tr>
                      <tr><td>Tarjeta</td><td class="ta-r">{{ money(c.tarjeta_esperado) }}</td><td class="ta-r">{{ money(c.tarjeta_contado) }}</td><td class="ta-r strong" [class.bad]="c.tarjeta_diff>0" [class.ok]="c.tarjeta_diff<0">{{ signed(c.tarjeta_diff) }}</td></tr>
                      <tr><td>Transferencia</td><td class="ta-r">{{ money(c.transfer_esperado) }}</td><td class="ta-r">{{ money(c.transfer_contado) }}</td><td class="ta-r strong" [class.bad]="c.transfer_diff>0" [class.ok]="c.transfer_diff<0">{{ signed(c.transfer_diff) }}</td></tr>
                      <tr class="cd-total-row"><td>Venta total</td><td class="ta-r strong" colspan="3">{{ money(c.venta_total) }}</td></tr>
                    </table>
                  </div>
                  <div class="cd-corte-block">
                    <h4>Desglose del arqueo (contado físico)</h4>
                    <div class="cd-ev-grid">
                      <div><span class="cd-ev-k">Billetes</span><span class="cd-ev-v">{{ money(c.arqueo_billetes) }}</span></div>
                      <div><span class="cd-ev-k">Monedas</span><span class="cd-ev-v">{{ money(c.arqueo_monedas) }}</span></div>
                      <div><span class="cd-ev-k">Otros / vales</span><span class="cd-ev-v">{{ money(c.arqueo_otros) }}</span></div>
                      <div><span class="cd-ev-k">Efvo. retirado</span><span class="cd-ev-v">{{ money(c.efectivo_retirado) }}</span></div>
                      <div><span class="cd-ev-k">Turno</span><span class="cd-ev-v">{{ c.turno || '—' }}</span></div>
                      <div><span class="cd-ev-k">Folio</span><span class="cd-ev-v mono">{{ c.folio }}</span></div>
                      <div><span class="cd-ev-k">Horario</span><span class="cd-ev-v">{{ (c.hora_apertura || '?') | slice:0:5 }}–{{ (c.hora_cierre || '?') | slice:0:5 }}@if (c.duracion_horas != null) { <span class="muted"> ({{ c.duracion_horas }}h)</span> }</span></div>
                      <div><span class="cd-ev-k">Cajeros</span><span class="cd-ev-v">@if (c.handoff) { <span class="cd-flag-inline">cambio {{ c.cajero_apertura }}→{{ c.cajero_cierre }}</span> } @else { mismo }</span></div>
                    </div>
                    @if (c.cuadre_exacto) { <p class="cd-flag-note"><i class="pi pi-eye-slash"></i> Contado idéntico al esperado al centavo — conteo posiblemente no a ciegas.</p> }
                    @if (c.handoff && (c.duracion_horas || 0) >= 10) { <p class="cd-flag-note"><i class="pi pi-clock"></i> Circunstancia de riesgo: cambio de cajero + turno largo ({{ c.duracion_horas }}h).</p> }
                  </div>
                </div>
              </td></tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="11" class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin cortes. ¿Corriste import-cash-cuts?' }}</td></tr></ng-template>
          </p-table>
        </div>
      }

      <!-- ══ MOVIMIENTOS ══ -->
      @if (tab() === 'movimientos') {
        <div class="cd-filters">
          <div class="cd-seg">
            <button [class.active]="fClase() === null" (click)="setClase(null)">Todos</button>
            <button [class.active]="fClase() === 'merma'" (click)="setClase('merma')">Merma</button>
            <button [class.active]="fClase() === 'traspaso_salida'" (click)="setClase('traspaso_salida')">Traspaso sal.</button>
            <button [class.active]="fClase() === 'ajuste_salida'" (click)="setClase('ajuste_salida')">Ajuste</button>
            <button [class.active]="fClase() === 'inv_fisico'" (click)="setClase('inv_fisico')">Inv. físico</button>
          </div>
          <input class="cd-input" type="text" placeholder="SKU o producto…" [(ngModel)]="fSku" (keyup.enter)="loadMovs()">
          <input class="cd-input cd-input-sm" type="text" placeholder="Suc" [(ngModel)]="fSucMov" (keyup.enter)="loadMovs()">
          <label class="cd-lbl">Desde <input class="cd-input cd-input-date" type="date" [(ngModel)]="fMovFrom" (change)="loadMovs()"></label>
          <label class="cd-lbl">Hasta <input class="cd-input cd-input-date" type="date" [(ngModel)]="fMovTo" (change)="loadMovs()"></label>
          <button pButton type="button" icon="pi pi-search" label="Filtrar" class="p-button-sm p-button-text" (click)="loadMovs()"></button>
          <span class="cd-count muted">{{ movs().length }} movs</span>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="movs()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()" [scrollable]="true" scrollHeight="600px" [paginator]="movs().length > 100" [rows]="100">
            <ng-template pTemplate="header">
              <tr><th>Fecha</th><th>Suc</th><th>Producto</th><th>Tipo</th><th>Folio</th><th class="ta-r">Unidades</th><th class="ta-r">Importe</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-m>
              <tr [class.cd-row-bad]="m.clase_mov === 'merma'">
                <td>{{ m.fecha | date:'dd/MM/yy' }}</td>
                <td>{{ m.warehouse_code }}</td>
                <td><span class="cd-prod">{{ m.producto || m.sku }}</span><span class="cd-sku muted">{{ m.sku }}</span></td>
                <td><span class="cd-tag" [ngClass]="'mv-' + m.clase_mov">{{ claseMovLabel(m.clase_mov) }}</span></td>
                <td class="muted">{{ m.folio }}</td>
                <td class="ta-r">{{ m.unidades | number }} <span class="muted">{{ m.unidad }}</span></td>
                <td class="ta-r strong" [class.bad]="m.clase_mov === 'merma'">{{ money(m.importe) }}</td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="7" class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin movimientos. ¿Corriste import-kardex?' }}</td></tr></ng-template>
          </p-table>
        </div>
      }

      <!-- ══ ARQUEO CIEGO (P1) ══ -->
      @if (tab() === 'arqueo') {
        <div class="cd-note">
          <i class="pi pi-eye-slash"></i>
          <span>Contá el efectivo físico por denominación <strong>sin ver el esperado</strong>. Al guardar, el sistema revela la diferencia <strong>real</strong> — que el arqueo de Kepler (73% cuadra exacto) suele ocultar.</span>
        </div>
        <div class="cd-2col">
          <div class="card-premium card-flat cd-panel">
            <h3 class="cd-card-title">Nuevo arqueo ciego</h3>
            <div class="cd-seg" style="margin-bottom:.7rem">
              <button [class.active]="aTipo() === 'cierre'" (click)="aTipo.set('cierre')">Cierre de día</button>
              <button [class.active]="aTipo() === 'relevo'" (click)="aTipo.set('relevo')">Relevo (cambio de turno)</button>
            </div>
            <div class="cd-arq-head">
              <label class="cd-lbl">Sucursal <input class="cd-input cd-input-sm" [(ngModel)]="aSuc" placeholder="03"></label>
              <label class="cd-lbl">Caja <input class="cd-input cd-input-sm" [(ngModel)]="aCaja" placeholder="2"></label>
              <label class="cd-lbl">Fecha <input class="cd-input cd-input-date" type="date" [(ngModel)]="aDate"></label>
              <label class="cd-lbl">{{ aTipo() === 'relevo' ? 'Cajero saliente' : 'Cajero' }} <input class="cd-input cd-input-sm" [(ngModel)]="aCajero" placeholder="40VMC"></label>
              @if (aTipo() === 'relevo') { <label class="cd-lbl">Cajero entrante <input class="cd-input cd-input-sm" [(ngModel)]="aEntrante" placeholder="40RMH"></label> }
            </div>
            <table class="cd-denoms">
              <tr><th>Denominación</th><th class="ta-r">Cantidad</th><th class="ta-r">Subtotal</th></tr>
              @for (d of denoms; track d) {
                <tr>
                  <td>{{ d >= 1 ? '$' + d : (d*100) + '¢' }}</td>
                  <td class="ta-r"><input class="cd-input cd-input-xs" type="number" min="0" [(ngModel)]="denomCount[d]" (ngModelChange)="recalc()"></td>
                  <td class="ta-r muted">{{ money((denomCount[d] || 0) * d) }}</td>
                </tr>
              }
              <tr class="cd-total-row"><td>Total contado</td><td></td><td class="ta-r strong">{{ money(arqTotal()) }}</td></tr>
            </table>
            <label class="cd-lbl cd-block">Nota <input class="cd-input" [(ngModel)]="aNota" placeholder="opcional"></label>
            <button pButton type="button" [label]="aTipo() === 'relevo' ? 'Sellar relevo' : 'Guardar y revelar diferencia'" icon="pi pi-lock-open" class="p-button-sm" [disabled]="!aSuc || !aCaja || !aDate || arqTotal()===0" [loading]="arqSaving()" (click)="submitArqueo()"></button>
            @if (arqResult(); as r) {
              <div class="cd-arq-result" [class.bad]="r.kepler_enmascaro">
                @if (r.tipo === 'relevo') {
                  <p class="muted">Relevo sellado: {{ money(r.total_contado) }} entregados de {{ aCajero }} → {{ aEntrante }}. Responsabilidad fijada al saliente.</p>
                } @else if (!r.matched) {
                  <p class="muted">Guardado. No hay corte de Kepler para esa caja/fecha aún — la comparación aparecerá cuando se importe.</p>
                } @else {
                  <div class="cd-arq-cmp">
                    <div><span class="cd-ev-k">Contado ciego</span><span class="cd-ev-v strong">{{ money(r.total_contado) }}</span></div>
                    <div><span class="cd-ev-k">Esperado (Kepler)</span><span class="cd-ev-v">{{ money(r.esperado || 0) }}</span></div>
                    <div><span class="cd-ev-k">Diferencia REAL</span><span class="cd-ev-v strong" [class.bad]="(r.diff_real||0)>0" [class.ok]="(r.diff_real||0)<0">{{ signed(r.diff_real || 0) }}</span></div>
                    <div><span class="cd-ev-k">Kepler reportó</span><span class="cd-ev-v">{{ signed(r.kepler_diff || 0) }}</span></div>
                  </div>
                  @if (r.kepler_enmascaro) { <p class="cd-flag-note"><i class="pi pi-exclamation-triangle"></i> Kepler dio este corte por cuadrado, pero el arqueo ciego destapa {{ money(abs(r.diff_real||0)) }}. Enmascaramiento confirmado.</p> }
                }
              </div>
            }
          </div>

          <div class="card-premium card-flat cd-panel">
            <h3 class="cd-card-title">Arqueos ciegos recientes</h3>
            <p-table [value]="blindRows()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()">
              <ng-template pTemplate="header"><tr><th>Fecha</th><th>Tipo</th><th>Suc/Caja</th><th>Cajero</th><th class="ta-r">Ciego</th><th class="ta-r">Real</th></tr></ng-template>
              <ng-template pTemplate="body" let-b>
                <tr [class.cd-row-bad]="b.kepler_enmascaro">
                  <td>{{ b.business_date | date:'dd/MM/yy' }}</td>
                  <td><span class="cd-tag">{{ b.tipo === 'relevo' ? 'Relevo' : 'Cierre' }}</span></td>
                  <td>{{ b.warehouse_code }}/{{ b.caja }}</td>
                  <td>{{ b.cajero_nombre || b.cajero_code || '—' }}@if (b.tipo === 'relevo' && b.cajero_entrante) { <span class="muted"> → {{ b.cajero_entrante }}</span> }</td>
                  <td class="ta-r">{{ money(b.total_contado) }}</td>
                  <td class="ta-r strong" [class.bad]="(b.diff_real||0)>0" [class.ok]="(b.diff_real||0)<0">{{ b.diff_real != null ? signed(b.diff_real) : '—' }}@if (b.kepler_enmascaro) { <i class="pi pi-eye-slash cd-flag"></i> }</td>
                </tr>
              </ng-template>
              <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="cd-empty">Sin arqueos ciegos aún.</td></tr></ng-template>
            </p-table>
          </div>
        </div>
      }

      <!-- ══ ACCIONES (P5) ══ -->
      @if (tab() === 'acciones') {
        <div class="cd-note">
          <i class="pi pi-check-circle"></i>
          <span>Las palancas aplicadas y si <strong>funcionaron</strong>. Efectividad = faltante 30 días antes vs 30 después en el alcance, menos el cambio de la red (diff-in-diff) para descontar la tendencia general.</span>
        </div>
        <div class="card-premium card-flat">
          <p-table [value]="acciones()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()">
            <ng-template pTemplate="header">
              <tr><th>Fecha</th><th>Palanca</th><th>Alcance</th><th>Título</th><th class="ta-r">Antes</th><th class="ta-r">Después</th><th class="ta-r">Efecto (DiD)</th><th>Estado</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-a>
              <tr>
                <td>{{ a.fecha_intervencion | date:'dd/MM/yy' }}</td>
                <td><span class="cd-tag">{{ palancaLabel(a.palanca) }}</span></td>
                <td class="muted">{{ a.sucursal }}{{ a.caja ? '/'+a.caja : '' }}{{ a.cajero ? ' · '+a.cajero : '' }}</td>
                <td>{{ a.titulo }}</td>
                <td class="ta-r">{{ money(a.efectividad.faltante_antes) }}</td>
                <td class="ta-r">{{ money(a.efectividad.faltante_despues) }}</td>
                <td class="ta-r strong" [class.ok]="a.efectividad.diff_in_diff < 0" [class.bad]="a.efectividad.diff_in_diff > 0">{{ signed(a.efectividad.diff_in_diff) }}</td>
                <td>
                  <select class="cd-input cd-input-sm" [ngModel]="a.status" (ngModelChange)="cambiarEstadoAccion(a, $event)">
                    <option value="propuesta">Propuesta</option><option value="aceptada">Aceptada</option>
                    <option value="en_curso">En curso</option><option value="hecha">Hecha</option><option value="descartada">Descartada</option>
                  </select>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="8" class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin acciones. Creá una desde Focos.' }}</td></tr></ng-template>
          </p-table>
        </div>
      }

      <!-- ══ DESCUADRES (bandeja HITL) ══ -->
      @if (tab() === 'descuadres') {
        @if (stats(); as s) {
          <div class="cd-kpis">
            <div class="cd-kpi"><span class="cd-kpi-val">{{ s.pendientes | number }}</span><span class="cd-kpi-lbl">Pendientes</span></div>
            <div class="cd-kpi" [class.bad]="s.criticos > 0"><span class="cd-kpi-val">{{ s.criticos | number }}</span><span class="cd-kpi-lbl">Críticos</span></div>
            <div class="cd-kpi"><span class="cd-kpi-val">{{ money(s.monto_en_juego) }}</span><span class="cd-kpi-lbl">$ en juego</span></div>
            @for (p of s.por_plano; track p.plano) {
              <div class="cd-kpi"><span class="cd-kpi-val">{{ p.n | number }}</span><span class="cd-kpi-lbl">{{ planoLabel(p.plano) }}</span></div>
            }
          </div>
        }
        <div class="cd-filters">
          <div class="cd-seg">
            <button [class.active]="plano() === null" (click)="setPlano(null)">Todos</button>
            <button [class.active]="plano() === 'caja'" (click)="setPlano('caja')">Caja</button>
            <button [class.active]="plano() === 'inventario'" (click)="setPlano('inventario')">Inventario</button>
            <button [class.active]="plano() === 'cruce'" (click)="setPlano('cruce')">Cruce</button>
          </div>
          <div class="cd-seg">
            <button [class.active]="dStatus() === 'pendientes'" (click)="setStatus('pendientes')">Pendientes</button>
            <button [class.active]="dStatus() === 'confirmado'" (click)="setStatus('confirmado')">Confirmados</button>
            <button [class.active]="dStatus() === 'descartado'" (click)="setStatus('descartado')">Descartados</button>
          </div>
          <button pButton type="button" [label]="rulesOpen() ? 'Ocultar reglas' : 'Reglas'" icon="pi pi-sliders-h" class="p-button-sm p-button-text" (click)="rulesOpen.set(!rulesOpen())"></button>
        </div>

        @if (rulesOpen()) {
          <div class="card-premium card-flat cd-panel">
            <h3 class="cd-card-title">Salud de las reglas <span class="muted">(precisión = confirmados / veredictos)</span></h3>
            <p-table [value]="rules()" styleClass="p-datatable-sm" [rowHover]="true">
              <ng-template pTemplate="header"><tr><th>Regla</th><th>Plano</th><th class="ta-r">Total</th><th class="ta-r">✓/✗</th><th class="ta-r">Precisión</th><th>Estado</th><th style="width:4rem"></th></tr></ng-template>
              <ng-template pTemplate="body" let-r>
                <tr [class.cd-suppressed]="r.suppressed_auto">
                  <td>{{ r.nombre }}</td><td><span class="cd-tag" [ngClass]="'pl-' + r.plano">{{ planoLabel(r.plano) }}</span></td>
                  <td class="ta-r">{{ r.findings_total | number }}</td><td class="ta-r muted">{{ r.findings_confirmados }}/{{ r.findings_falsos }}</td>
                  <td class="ta-r" [class.bad]="r.precision_score != null && r.precision_score < 0.3">{{ r.precision_score != null ? (r.precision_score * 100 | number:'1.0-0') + '%' : '—' }}</td>
                  <td>@if (r.suppressed_auto) { <span class="cd-tag pl-off">suprimida</span> } @else if (r.pinned) { <span class="cd-tag pl-pin">fijada</span> } @else { <span class="muted">activa</span> }</td>
                  <td class="ta-r"><button pButton type="button" [icon]="r.pinned ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'" class="p-button-text p-button-sm" (click)="pin(r)"></button></td>
                </tr>
              </ng-template>
            </p-table>
          </div>
        }

        <div class="card-premium card-flat">
          <p-table [value]="items()" styleClass="p-datatable-sm cd-table" [rowHover]="true" [loading]="loading()"
                   dataKey="id" [expandedRowKeys]="expanded()" [scrollable]="true" scrollHeight="560px" [paginator]="items().length > 50" [rows]="50">
            <ng-template pTemplate="header">
              <tr><th style="width:2.5rem"></th><th style="width:6rem">Severidad</th><th>Descuadre</th><th style="width:6rem">Plano</th><th class="ta-r" style="width:9rem">Diferencia</th><th style="width:12rem">Acciones</th></tr>
            </ng-template>
            <ng-template pTemplate="body" let-d let-expanded="expanded">
              <tr>
                <td><button pButton type="button" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="p-button-text p-button-sm" (click)="toggle(d)"></button></td>
                <td><span class="cd-sev" [ngClass]="'sev-' + d.severity">{{ sevLabel(d.severity) }}</span></td>
                <td><div class="cd-titulo">{{ d.titulo }}</div><div class="cd-resumen">{{ d.resumen }}</div></td>
                <td><span class="cd-tag" [ngClass]="'pl-' + d.plano">{{ planoLabel(d.plano) }}</span></td>
                <td class="ta-r strong" [class.bad]="(d.diferencia || 0) > 0" [class.ok]="(d.diferencia || 0) < 0">{{ money(d.importe) }}</td>
                <td>
                  <div class="cd-acts">
                    @if (d.status === 'nuevo' || d.status === 'en_revision') {
                      <button pButton type="button" icon="pi pi-check" label="Confirmar" class="p-button-sm p-button-success p-button-text" (click)="verdict(d, 'util')" [title]="'Causa: ' + (d.causa_probable || 'otro')"></button>
                      <button pButton type="button" icon="pi pi-times" class="p-button-sm p-button-danger p-button-text" (click)="verdict(d, 'falso')" title="Falso positivo"></button>
                    } @else {
                      <span class="cd-status" [ngClass]="'st-' + d.status">{{ statusLabel(d.status) }}</span>
                      @if (d.causa_confirmada) { <span class="muted cd-causa">· {{ causaLabel(d.causa_confirmada) }}</span> }
                    }
                  </div>
                </td>
              </tr>
            </ng-template>
            <ng-template pTemplate="rowexpansion" let-d>
              <tr><td colspan="6" class="cd-ev">
                <div class="cd-ev-grid">@for (kv of evidenceRows(d); track kv.k) { <div><span class="cd-ev-k">{{ kv.k }}</span><span class="cd-ev-v mono">{{ kv.v }}</span></div> }</div>
                <div class="cd-ev-meta muted">Regla: {{ d.regla || d.rule_key }} · causa probable: {{ causaLabel(d.causa_probable) }} · detectado {{ d.first_seen | date:'dd/MM/yy' }}</div>
              </td></tr>
            </ng-template>
            <ng-template pTemplate="emptymessage"><tr><td colspan="6" class="cd-empty">{{ loading() ? 'Cargando…' : 'Sin descuadres. Corre "Escanear ahora".' }}</td></tr></ng-template>
          </p-table>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cd-head { display: flex; align-items: flex-start; gap: 1rem; }
    .cd-head-actions { margin-left: auto; }
    .cd-tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--border-color, #e7e5e4); margin-bottom: 1rem; }
    .cd-tabs button { border: none; background: none; padding: .55rem .9rem; font-size: .85rem; cursor: pointer; color: var(--text-muted, #78716c); border-bottom: 2px solid transparent; display: inline-flex; align-items: center; gap: .4rem; }
    .cd-tabs button.active { color: var(--action, #FB923C); border-bottom-color: var(--action, #FB923C); font-weight: 600; }
    .cd-tabs i { font-size: .8rem; }
    .cd-badge { background: var(--bad-fg, #dc2626); color: #fff; border-radius: 999px; font-size: .65rem; padding: .05rem .4rem; font-weight: 700; }
    .cd-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
    .cd-kpi { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-md, 10px); padding: .75rem 1rem; background: var(--card-bg, #fff); }
    .cd-kpi.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, var(--border-color, #e7e5e4)); }
    .cd-kpi.warn { border-color: color-mix(in srgb, #d97706 45%, var(--border-color, #e7e5e4)); }
    .cd-note { display: flex; gap: .6rem; align-items: flex-start; background: color-mix(in srgb, #d97706 8%, transparent); border: 1px solid color-mix(in srgb, #d97706 30%, transparent); border-radius: var(--r-md, 10px); padding: .7rem .9rem; font-size: .82rem; line-height: 1.45; margin-bottom: 1rem; }
    .cd-note i { color: #b45309; margin-top: .15rem; }
    .cd-lbl { display: inline-flex; align-items: center; gap: .3rem; font-size: .76rem; color: var(--text-muted, #57534e); }
    .cd-input-date { padding: .28rem .45rem; }
    .cd-count { font-size: .76rem; margin-left: auto; }
    .cd-flag { color: #b45309; font-size: .72rem; margin-left: .3rem; }
    .cd-mini { font-size: .7rem; color: var(--bad-fg, #dc2626); }
    .cd-corte-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 1.5rem; }
    @media (max-width: 800px) { .cd-corte-grid { grid-template-columns: 1fr; } }
    .cd-corte-block h4 { margin: 0 0 .5rem; font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .cd-mini-table { width: 100%; border-collapse: collapse; font-size: .82rem; font-variant-numeric: tabular-nums; }
    .cd-mini-table th { font-size: .66rem; text-transform: uppercase; color: var(--text-muted, #78716c); font-weight: 600; padding: .2rem .4rem; text-align: left; }
    .cd-mini-table td { padding: .25rem .4rem; border-top: 1px solid var(--border-color, #eee); }
    .cd-total-row td { border-top: 2px solid var(--border-color, #ddd); font-weight: 700; }
    .cd-flag-note { font-size: .76rem; color: #b45309; margin: .6rem 0 0; display: flex; align-items: center; gap: .35rem; }
    .cd-prod { display: block; font-weight: 500; } .cd-sku { display: block; font-size: .7rem; }
    .cd-code { font-size: .68rem; font-family: var(--font-mono, ui-monospace, monospace); }
    .cd-flag-inline { color: #b45309; font-size: .78rem; }
    .cd-accion { font-size: .8rem; font-weight: 600; color: var(--action, #FB923C); }
    .cd-arq-head { display: flex; gap: .8rem; flex-wrap: wrap; margin-bottom: .8rem; }
    .cd-denoms { width: 100%; border-collapse: collapse; font-size: .84rem; font-variant-numeric: tabular-nums; }
    .cd-denoms th { font-size: .66rem; text-transform: uppercase; color: var(--text-muted, #78716c); font-weight: 600; padding: .25rem .4rem; text-align: left; }
    .cd-denoms td { padding: .2rem .4rem; border-top: 1px solid var(--border-color, #eee); }
    .cd-input-xs { width: 4.5rem; padding: .2rem .4rem; text-align: right; }
    .cd-block { display: block; margin: .8rem 0; }
    .cd-arq-result { margin-top: 1rem; padding: .9rem; border-radius: var(--r-md, 10px); border: 1px solid var(--border-color, #e7e5e4); background: var(--surface-hover-bg, #fafaf9); }
    .cd-arq-result.bad { border-color: color-mix(in srgb, var(--bad-fg, #dc2626) 40%, transparent); background: color-mix(in srgb, var(--bad-fg, #dc2626) 5%, transparent); }
    .cd-arq-cmp { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .6rem 1rem; }
    .cd-kpi-val { display: block; font-size: 1.25rem; font-weight: 800; font-variant-numeric: tabular-nums; }
    .cd-kpi-lbl { display: block; font-size: .68rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); }
    .cd-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 900px) { .cd-2col { grid-template-columns: 1fr; } }
    .cd-panel { padding: 1rem; }
    .cd-card-title { margin: 0 0 .7rem; font-size: .85rem; font-weight: 700; }
    .cd-bar-row { display: grid; grid-template-columns: 1fr 5rem auto; align-items: center; gap: .6rem; margin-bottom: .45rem; font-size: .82rem; }
    .cd-bar-lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cd-bar { background: var(--surface-hover-bg, #f5f5f4); border-radius: 999px; height: 7px; overflow: hidden; }
    .cd-bar-fill { background: var(--bad-fg, #dc2626); height: 100%; }
    .cd-bar-val { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
    .cd-filters { display: flex; gap: .8rem; flex-wrap: wrap; align-items: center; margin-bottom: .8rem; }
    .cd-seg { display: inline-flex; border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-pill, 999px); overflow: hidden; }
    .cd-seg button { border: none; background: var(--card-bg, #fff); padding: .3rem .8rem; font-size: .78rem; cursor: pointer; color: var(--text-muted, #57534e); }
    .cd-seg button.active { background: var(--action, #FB923C); color: #fff; font-weight: 600; }
    .cd-input { border: 1px solid var(--border-color, #e7e5e4); border-radius: var(--r-sm, 8px); padding: .35rem .6rem; font-size: .82rem; }
    .cd-input-sm { width: 5rem; }
    .cd-check { display: inline-flex; align-items: center; gap: .35rem; font-size: .82rem; color: var(--text-muted, #57534e); }
    .cd-table { font-variant-numeric: tabular-nums; }
    .cd-row-bad td { background: color-mix(in srgb, var(--bad-fg, #dc2626) 5%, transparent); }
    .ta-r { text-align: right; } .strong { font-weight: 700; } .muted { color: var(--text-muted, #78716c); }
    .bad { color: var(--bad-fg, #dc2626); } .ok { color: var(--ok-fg, #16a34a); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .85em; }
    .cd-titulo { font-weight: 600; } .cd-resumen { font-size: .8rem; color: var(--text-muted, #78716c); margin-top: .1rem; max-width: 62ch; }
    .cd-sev { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .66rem; font-weight: 700; text-transform: uppercase; }
    .sev-critical { background: color-mix(in srgb, var(--bad-fg, #dc2626) 15%, transparent); color: var(--bad-fg, #dc2626); }
    .sev-warn { background: color-mix(in srgb, #d97706 15%, transparent); color: #b45309; }
    .sev-info { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .cd-tag { display: inline-block; padding: .08rem .5rem; border-radius: 999px; font-size: .68rem; font-weight: 600; }
    .pl-caja, .mv-merma { background: color-mix(in srgb, var(--bad-fg, #dc2626) 12%, transparent); color: var(--bad-fg, #dc2626); }
    .pl-inventario { background: color-mix(in srgb, #0ea5e9 14%, transparent); color: #0369a1; }
    .pl-cruce { background: color-mix(in srgb, #0d9488 14%, transparent); color: #0f766e; }
    .mv-traspaso_salida, .mv-traspaso_entrada { background: color-mix(in srgb, #0ea5e9 12%, transparent); color: #0369a1; }
    .mv-ajuste_salida, .mv-ajuste_entrada { background: color-mix(in srgb, #d97706 14%, transparent); color: #b45309; }
    .mv-inv_fisico, .mv-otro { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #57534e); }
    .pl-off { background: var(--surface-hover-bg, #f5f5f4); color: var(--text-muted, #78716c); }
    .pl-pin { background: color-mix(in srgb, var(--action, #FB923C) 15%, transparent); color: var(--action, #FB923C); }
    .cd-acts { display: flex; align-items: center; gap: .1rem; }
    .cd-status { font-size: .74rem; font-weight: 600; } .cd-causa { font-size: .72rem; }
    .st-confirmado { color: var(--ok-fg, #16a34a); } .st-descartado { color: var(--text-muted, #a8a29e); } .st-corregido { color: var(--action, #FB923C); }
    .cd-suppressed { opacity: .55; }
    .cd-ev { background: var(--surface-hover-bg, #fafaf9); padding: .8rem 1.2rem; }
    .cd-ev-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .4rem 1.2rem; }
    .cd-ev-k { font-size: .66rem; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted, #78716c); display: block; }
    .cd-ev-v { font-size: .85rem; } .cd-ev-meta { font-size: .72rem; margin-top: .6rem; }
    .cd-empty { padding: 2rem; text-align: center; color: var(--text-muted, #78716c); }
  `],
})
export class AlmacenCuadreComponent implements OnInit {
  private readonly svc = inject(CuadreService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tab = signal<Tab>('resumen');
  readonly loading = signal(false);
  readonly scanning = signal(false);

  // resumen
  readonly ov = signal<CuadreOverview | null>(null);
  // focos
  readonly focos = signal<Foco[]>([]);
  readonly focoScope = signal<'caja' | 'cajero'>('caja');
  // acciones
  readonly acciones = signal<ReconAction[]>([]);
  // cortes
  readonly cortes = signal<CashCut[]>([]);
  readonly expandedCortes = signal<Record<string, boolean>>({});
  fCajero = ''; fSucCaja = ''; fSoloDesc = false; fFrom = ''; fTo = '';
  // movimientos
  readonly movs = signal<StockMovement[]>([]);
  readonly fClase = signal<string | null>(null);
  fSku = ''; fSucMov = ''; fMovFrom = ''; fMovTo = '';
  // arqueo ciego
  readonly denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];
  denomCount: Record<number, number> = {};
  readonly aTipo = signal<'cierre' | 'relevo'>('cierre');
  aSuc = ''; aCaja = ''; aDate = ''; aCajero = ''; aEntrante = ''; aNota = '';
  readonly arqTotal = signal(0);
  readonly arqSaving = signal(false);
  readonly arqResult = signal<BlindCountResult | null>(null);
  readonly blindRows = signal<BlindCountRow[]>([]);
  // descuadres
  readonly items = signal<Discrepancy[]>([]);
  readonly stats = signal<DiscStats | null>(null);
  readonly rules = signal<RuleHealth[]>([]);
  readonly rulesOpen = signal(false);
  readonly plano = signal<DiscPlano | null>(null);
  readonly dStatus = signal<'pendientes' | 'confirmado' | 'descartado'>('pendientes');
  readonly expanded = signal<Record<string, boolean>>({});

  ngOnInit() { this.loadOverview(); this.loadStats(); }

  go(t: Tab) {
    this.tab.set(t);
    if (t === 'resumen' && !this.ov()) this.loadOverview();
    if (t === 'focos' && !this.focos().length) this.loadFocos();
    if (t === 'acciones') this.loadAcciones();
    if (t === 'cortes' && !this.cortes().length) this.loadCortes();
    if (t === 'movimientos' && !this.movs().length) this.loadMovs();
    if (t === 'arqueo') this.loadBlind();
    if (t === 'descuadres') this.reloadDisc();
  }

  private loadFocos() {
    this.loading.set(true);
    this.svc.focos(this.focoScope()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.focos.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  setFocoScope(s: 'caja' | 'cajero') { this.focoScope.set(s); this.loadFocos(); }

  private loadAcciones() {
    this.loading.set(true);
    this.svc.listActions().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.acciones.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  private palancaFromAccion(accion: string): ActionPalanca {
    if (accion.includes('ciego')) return 'arqueo_ciego';
    if (accion.includes('relevo')) return 'arqueo_relevo';
    if (accion.includes('jornada')) return 'limitar_jornada';
    return 'supervision';
  }
  crearAccionDesdeFoco(f: Foco) {
    const hoy = new Date().toISOString().slice(0, 10);
    const palanca = this.palancaFromAccion(f.accion);
    const alcance = f.cajero ? `cajero ${f.cajero_nombre || f.cajero}` : `caja ${f.caja}`;
    this.svc.createAction({
      palanca, titulo: `${this.palancaLabel(palanca)} — suc ${f.sucursal} ${alcance}`,
      warehouse_code: f.sucursal, caja: f.caja, cajero_code: f.cajero, fecha_intervencion: hoy,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.toast.add({ severity: 'success', summary: 'Acción creada', detail: `Baseline ${this.money(r.baseline_faltante)}. Se medirá el efecto a 30 días.` }); this.loadAcciones(); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo crear.' }),
    });
  }
  cambiarEstadoAccion(a: ReconAction, status: any) {
    this.svc.setActionStatus(a.id, status).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => { a.status = status; }, error: () => {} });
  }
  palancaLabel(p: string): string {
    const m: Record<string, string> = { arqueo_ciego: 'Arqueo ciego', arqueo_relevo: 'Arqueo relevo', limitar_jornada: 'Limitar jornada', supervision: 'Supervisión', otro: 'Otro' };
    return m[p] || p;
  }

  recalc() { this.arqTotal.set(this.denoms.reduce((s, d) => s + (Number(this.denomCount[d]) || 0) * d, 0)); }

  submitArqueo() {
    this.arqSaving.set(true);
    const denominations: Record<string, number> = {};
    for (const d of this.denoms) { const n = Number(this.denomCount[d]) || 0; if (n > 0) denominations[String(d)] = n; }
    this.svc.submitBlindCount({ warehouse_code: this.aSuc.trim(), caja: this.aCaja.trim(), business_date: this.aDate, tipo: this.aTipo(), cajero_code: this.aCajero.trim() || undefined, cajero_entrante: this.aTipo() === 'relevo' ? (this.aEntrante.trim() || undefined) : undefined, denominations, nota: this.aNota.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.arqSaving.set(false); this.arqResult.set(r);
          const detail = r.tipo === 'relevo' ? `Relevo sellado (${this.money(r.total_contado)}).` : (r.matched ? `Diferencia real ${this.signed(r.diff_real || 0)}` : 'Guardado (sin corte para comparar aún).');
          this.toast.add({ severity: r.kepler_enmascaro ? 'warn' : 'success', summary: r.tipo === 'relevo' ? 'Relevo guardado' : 'Arqueo guardado', detail });
          this.loadBlind();
        },
        error: (e) => { this.arqSaving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar.' }); },
      });
  }
  private loadBlind() {
    this.loading.set(true);
    this.svc.listBlindCounts({ limit: 100 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.blindRows.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  private loadOverview() {
    this.loading.set(true);
    this.svc.overview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (o) => { this.ov.set(o); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  loadCortes() {
    this.loading.set(true);
    this.svc.cashCuts({ cajero: this.fCajero || undefined, sucursal: this.fSucCaja || undefined, from: this.fFrom || undefined, to: this.fTo || undefined, solo_descuadres: this.fSoloDesc, limit: 400 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.cortes.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  loadMovs() {
    this.loading.set(true);
    this.svc.movements({ clase_mov: this.fClase() || undefined, sku: this.fSku || undefined, sucursal: this.fSucMov || undefined, from: this.fMovFrom || undefined, to: this.fMovTo || undefined, limit: 400 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.movs.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  toggleCorte(c: CashCut) { this.expandedCortes.update((e) => { const n = { ...e }; if (n[c.id]) delete n[c.id]; else n[c.id] = true; return n; }); }
  setClase(c: string | null) { this.fClase.set(c); this.loadMovs(); }

  private reloadDisc() {
    this.loading.set(true);
    const status = this.dStatus() === 'pendientes' ? undefined : this.dStatus();
    this.svc.list({ plano: this.plano() || undefined, status, limit: 300 })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.items.set(r); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  private loadStats() {
    this.svc.stats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (s) => this.stats.set(s), error: () => {} });
    this.svc.rules().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.rules.set(r), error: () => {} });
  }
  setPlano(p: DiscPlano | null) { this.plano.set(p); this.reloadDisc(); }
  setStatus(s: 'pendientes' | 'confirmado' | 'descartado') { this.dStatus.set(s); this.reloadDisc(); }

  scan() {
    this.scanning.set(true);
    this.svc.scan().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.scanning.set(false); this.toast.add({ severity: 'success', summary: 'Escaneo listo', detail: `${r.total_nuevos} descuadre(s) nuevo(s).` }); this.loadOverview(); this.loadStats(); if (this.tab() === 'descuadres') this.reloadDisc(); },
      error: () => { this.scanning.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo escanear.' }); },
    });
  }

  toggle(d: Discrepancy) { this.expanded.update((e) => { const c = { ...e }; if (c[d.id]) delete c[d.id]; else c[d.id] = true; return c; }); }

  verdict(d: Discrepancy, v: 'util' | 'falso') {
    const causa = v === 'util' ? (d.causa_probable || 'otro') : undefined;
    this.svc.feedback(d.id, v, causa).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.items.update((arr) => arr.filter((x) => x.id !== d.id)); this.loadStats();
        const sup = res?.suppressed ? ' · regla auto-suprimida' : '';
        this.toast.add({ severity: v === 'util' ? 'success' : 'info', summary: v === 'util' ? 'Confirmado' : 'Descartado', detail: `El supervisor aprende de esto${sup}.` });
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudo registrar.' }),
    });
  }
  pin(r: RuleHealth) { this.svc.pinRule(r.rule_key, !r.pinned).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.loadStats(), error: () => {} }); }

  evidenceRows(d: Discrepancy): { k: string; v: string }[] {
    const e = { ...(d.entity || {}), ...(d.evidencia || {}) };
    return Object.entries(e).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => ({ k: k.replace(/_/g, ' '), v: String(v) }));
  }

  barPct(v: number, max: number): number { return max > 0 ? Math.max(3, Math.round((v / max) * 100)) : 0; }
  abs(n: number): number { return Math.abs(n || 0); }
  money(v: number): string { return (v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  signed(v: number): string { return (v > 0 ? '+' : '') + this.money(v); }
  planoLabel(p: string): string { return p === 'caja' ? 'Caja' : p === 'inventario' ? 'Inventario' : p === 'cruce' ? 'Cruce' : p; }
  claseMovLabel(c: string): string {
    const m: Record<string, string> = { merma: 'Merma', traspaso_salida: 'Traspaso ↑', traspaso_entrada: 'Traspaso ↓', ajuste_salida: 'Ajuste sal.', ajuste_entrada: 'Ajuste ent.', inv_fisico: 'Inv. físico', otro: 'Otro' };
    return m[c] || c;
  }
  sevLabel(s: string): string { return s === 'critical' ? 'Crítico' : s === 'warn' ? 'Alerta' : 'Info'; }
  statusLabel(s: string): string { return s === 'confirmado' ? 'Confirmado' : s === 'descartado' ? 'Descartado' : s === 'corregido' ? 'Corregido' : s; }
  causaLabel(c: string | null): string {
    const m: Record<string, string> = { faltante_caja: 'Faltante de caja', sobrante_caja: 'Sobrante de caja', faltante_recurrente: 'Faltante recurrente', merma: 'Merma', robo: 'Robo', error_captura: 'Error de captura', otro: 'Otro' };
    return c ? (m[c] || c.replace(/_/g, ' ')) : '—';
  }
}
