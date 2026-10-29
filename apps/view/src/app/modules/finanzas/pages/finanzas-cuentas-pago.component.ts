import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import type { CuentaPagoFaltante, CuentasPagoFaltantesResponse, CuentaPagoPropuesta } from '@megadulces/contracts';
import { PagosTabsComponent } from '../pagos-tabs.component';

interface SupplierOpt { id: string; name: string; code: string }
interface PaymentAccount { id: string; bank_name: string; account_number: string | null; clabe: string | null; alias: string | null; notes: string | null; attachment_url: string | null; es_favorita: boolean; status: string }
interface ChangeRequest {
  id: string; supplier_id: string; supplier_name: string; account_id: string | null; deactivate: boolean;
  proposed_bank_name: string | null; proposed_account_number: string | null; proposed_clabe: string | null;
  proposed_alias: string | null; proposed_es_favorita: boolean; reason: string; status: string;
  requested_by: string; requested_at: string; decided_by: string | null; decision_notes: string | null;
}

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor. TODA alta o cambio pasa por una
 * solicitud (control anti-fraude) — se aprueba/rechaza con FINANCE_PAYMENT_CALENDAR_AUTORIZAR,
 * el MISMO permiso que autoriza el Calendario de Pagos (separación real de quien pide el cambio).
 */
@Component({
  selector: 'app-finanzas-cuentas-pago',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, InputTextModule, DialogModule, CheckboxModule, TagModule, ToastModule, MetricStripComponent, LoadStateComponent, FreshnessPillComponent, ContextHelpComponent, PagosTabsComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page in cta-page">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cuentas de pago a proveedor</h1>
          <p class="surf-page-sub">Banco/cuenta/CLABE de cada proveedor, con el comprobante de la solicitud de pago adjunto para evitar errores. Toda alta o cambio requiere autorización — no hay edición directa.</p>
        </div>
        <button pButton type="button" (click)="openNewSupplierPick()"><span class="pi pi-plus"></span>&nbsp;Solicitar cuenta</button>
      </header>

      <app-pagos-tabs />

      <section class="cta-section">
        <div class="cta-section-head">
          <h2>A quién le falta cuenta</h2>
          <app-context-help topic="cuentas-de-pago" />
        </div>

        @if (loadingFaltantes() || errorFaltantes()) {
          <app-load-state [loading]="loadingFaltantes()" [error]="errorFaltantes()" [skeletonRows]="6"
            errorTitle="No se pudo medir la cobertura de cuentas" (retry)="loadFaltantes()"></app-load-state>
        } @else if (universo(); as u) {
          <app-metric-strip [items]="kpiFaltantes(u)" ariaLabel="Cobertura de cuentas de pago" />

          <p class="cta-lede">
            @if (u.corte_80pct) {
              Dando de alta las <strong>{{ u.corte_80pct }}</strong> cuentas de arriba, el pago por transferencia
              queda cubierto para el <strong>80 %</strong> del dinero. Hoy se cubre el
              <strong>{{ u.pct_monto_cubierto }} %</strong>.
            } @else if (u.proveedores_total === 0) {
              No hubo pagos por banco entre {{ u.desde }} y {{ u.hasta }}: no hay nada que medir.
            } @else {
              Los proveedores que cobran por banco en la ventana ya tienen cuenta: la cobertura es del
              <strong>{{ u.pct_monto_cubierto }} %</strong>.
            }
          </p>

          @if (u.data_as_of) {
            <app-freshness-pill measures="data" [since]="u.data_as_of" label="Pagos del ERP" />
          } @else {
            <span class="cta-muted cta-sin-edad">Sin filas con las que medir la edad del dato.</span>
          }

          <p class="cta-proc">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            Pagos por banco del {{ u.desde }} al {{ u.hasta }} ({{ u.dias }} días) —
            {{ u.proveedores_total }} proveedores, {{ money(u.monto_total) }}. El medio sale de la cuenta de
            tesorería del documento, no del tipo de documento.
            @if (u.proveedores_sin_catalogo > 0) {
              <strong> {{ u.proveedores_sin_catalogo }}</strong> proveedores ({{ money(u.monto_sin_catalogo) }})
              no están en el catálogo de la suite: cuentan en el total pero no se les puede abrir solicitud acá.
            }
          </p>

          <p-table [value]="faltantes()" [paginator]="faltantes().length > 25" [rows]="25"
            styleClass="p-datatable-sm surf-table surf-table--plain surf-table--sticky cta-table">
            <ng-template #header>
              <tr>
                <th>Proveedor</th>
                <th class="comm-num">Pagado</th>
                <th class="comm-num">Cobertura si se da de alta</th>
                <th class="comm-num">Pagos</th>
                <th>Último pago</th>
                <!-- [PGP.29] La columna que convierte esta tabla en trabajo hecho: la cuenta que
                     el proveedor YA declaró. Es la diferencia entre «hay que conseguirla» y
                     «hay que firmarla». -->
                <th>Su cuenta, según él</th>
                <th style="width:9rem"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-f let-i="rowIndex">
              <tr [class.cta-row-corte]="i + 1 === universo()?.corte_80pct">
                <td><strong>{{ f.nombre }}</strong> <span class="cta-muted cta-mono">{{ f.codigo }}</span></td>
                <td class="comm-num">{{ money(f.monto) }}</td>
                <td class="comm-num">{{ f.acumulado_pct }} %</td>
                <td class="comm-num">{{ f.pagos }}</td>
                <td class="cta-muted">{{ f.ultimo_pago_date }} · {{ money(f.ultimo_pago_monto) }}</td>
                <td>
                  @if (loadingPropuestas()) {
                    <span class="cta-muted cta-prop-wait">buscando…</span>
                  } @else if (propuestaDe(f.codigo); as prop) {
                    @if (prop.estado === 'propuesta') {
                      <span class="cta-prop-ok">
                        <i class="pi pi-verified" aria-hidden="true"></i>
                        <span class="cta-mono">{{ prop.clabe_propuesta }}</span>
                      </span>
                      <span class="cta-prop-sub">la declaró {{ prop.veces_declarada }} vez(ces) · última {{ prop.ultima_vez }}</span>
                    } @else {
                      <span class="cta-prop-no">{{ prop.motivo }}</span>
                    }
                  } @else if (errorPropuestas()) {
                    <span class="cta-prop-nm">no se pudo medir</span>
                  } @else {
                    <span class="cta-muted">nunca declaró una</span>
                  }
                </td>
                <td>
                  <button pButton type="button" class="p-button-sm"
                          [class.p-button-text]="!tienePropuesta(f.codigo)"
                          (click)="solicitarPara(f)">
                    {{ tienePropuesta(f.codigo) ? 'Revisar y solicitar' : 'Solicitar cuenta' }}
                  </button>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="7" class="cta-empty">
                @if (universo()?.proveedores_total) { Todos los que cobran por banco ya tienen cuenta. }
                @else { Sin pagos por banco en la ventana. }
              </td></tr>
            </ng-template>
          </p-table>
        }
      </section>

      <section class="cta-section">
        <div class="cta-section-head"><h2>Buscar proveedor</h2></div>
        <input pInputText type="text" [(ngModel)]="supplierSearch" (ngModelChange)="searchSuppliers($event)" placeholder="Buscar proveedor…" class="cta-search" />
        @if (supplierOpts().length) {
          <div class="cta-sup-list">
            @for (s of supplierOpts(); track s.id) {
              <div class="cta-sup-item" (click)="pickSupplier(s)">{{ s.name }}</div>
            }
          </div>
        }
        @if (selectedSupplier()) {
          <div class="cta-sup-current">Proveedor seleccionado: <strong>{{ selectedSupplier()!.name }}</strong></div>
          <p-table [value]="accounts()" [loading]="loadingAccounts()" styleClass="p-datatable-sm surf-table cta-table">
            <ng-template #header><tr><th>Banco</th><th>Cuenta</th><th>CLABE</th><th>Alias</th><th>Favorita</th><th>Adjunto</th><th style="width:8rem"><span class="sr-only">Acciones</span></th></tr></ng-template>
            <ng-template #body let-a>
              <tr>
                <td>{{ a.bank_name }}</td><td class="cta-mono">{{ a.account_number || '—' }}</td><td class="cta-mono">{{ a.clabe || '—' }}</td>
                <td>{{ a.alias || '—' }}</td><td>@if (a.es_favorita) { <i class="pi pi-star-fill cta-fav"></i> }</td>
                <td>@if (a.attachment_url) { <span class="pi pi-file cta-att" title="Tiene comprobante adjunto"></span> } @else { <span class="cta-muted">—</span> }</td>
                <td>
                  <button pButton type="button" class="p-button-sm p-button-text" (click)="openChange(a)">Cambiar</button>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="openDeactivate(a)">Baja</button>
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="7" class="cta-empty">Sin cuentas registradas para este proveedor.</td></tr></ng-template>
          </p-table>
        }
      </section>

      <section class="cta-section">
        <div class="cta-section-head"><h2>Solicitudes pendientes</h2></div>
        <p-table [value]="requests()" [loading]="loadingRequests()" styleClass="p-datatable-sm surf-table cta-table">
          <ng-template #header><tr><th>Proveedor</th><th>Tipo</th><th>Propuesta</th><th>Motivo</th><th>Solicitó</th><th style="width:12rem"><span class="sr-only">Acciones</span></th></tr></ng-template>
          <ng-template #body let-r>
            <tr>
              <td>{{ r.supplier_name }}</td>
              <td><p-tag [value]="tipoLabel(r)" severity="info" styleClass="cta-tag" /></td>
              <td>{{ r.proposed_bank_name || '—' }} @if (r.proposed_clabe) { <span class="cta-muted"> · {{ r.proposed_clabe }}</span> }</td>
              <td class="cta-reason">{{ r.reason }}</td>
              <td class="cta-muted">{{ r.requested_by }}</td>
              <td>
                @if (canAuthorize()) {
                  <button pButton type="button" class="p-button-sm" (click)="approve(r)">Aprobar</button>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="reject(r)">Rechazar</button>
                } @else { <span class="cta-muted">Requiere autorización</span> }
              </td>
            </tr>
          </ng-template>
          <ng-template #emptymessage><tr><td colspan="6" class="cta-empty">Sin solicitudes pendientes.</td></tr></ng-template>
        </p-table>
      </section>
    </div>

    <p-dialog [(visible)]="requestVisible" [modal]="true" [header]="requestTitle()" [style]="{ width: '30rem' }">
      @if (!requestSupplier()) {
        <input pInputText type="text" [(ngModel)]="dlgSupplierSearch" (ngModelChange)="searchSuppliers($event)" placeholder="Buscar proveedor…" class="cta-full" />
        @if (supplierOpts().length) {
          <div class="cta-sup-list">
            @for (s of supplierOpts(); track s.id) { <div class="cta-sup-item" (click)="requestSupplier.set(s)">{{ s.name }}</div> }
          </div>
        }
      } @else {
        <p class="cta-dlg-p">{{ requestSupplier()!.name }}</p>
      }
      @if (!requestDeactivate) {
        <!-- [PGP.29] De dónde salió lo que ya viene escrito. Quien FIRMA el alta tiene derecho a
             saberlo: no es una captura de alguien, es el comprobante que el proveedor timbró.
             ⛔ Y si el RFC con el que se encontró lo resolvió un cruce de nombre y no Kepler
                (PGP.27), se dice — presentarlo como dato del ERP sería afirmar lo que no es. -->
        @if (propuestaUsada(); as prop) {
          <div class="cta-evid">
            <p class="cta-evid-t"><i class="pi pi-verified" aria-hidden="true"></i>
              La CLABE ya viene puesta: <span class="cta-mono">{{ prop.clabe_propuesta }}</span>
            </p>
            <p class="cta-evid-p">
              Sale del comprobante de pago que <strong>{{ requestSupplier()?.name }}</strong> timbró ante el SAT
              declarando a qué cuenta quiere que le paguemos. La declaró
              <strong>{{ prop.veces_declarada }}</strong> vez(ces), la última el <strong>{{ prop.ultima_vez }}</strong>.
              Su dígito de control está verificado. Banco (código de la CLABE): <span class="cta-mono">{{ prop.banco_codigo }}</span>@if (prop.banco_rfc) { <span class="cta-muted"> · RFC del banco {{ prop.banco_rfc }}</span> }.
            </p>
            <p class="cta-evid-p cta-muted">Comprobante: <span class="cta-mono">{{ prop.rep_uuid }}</span></p>
            @if (prop.rfc_discrepa) {
              <!-- [PGP.32] ADR-108. El caso más delicado de los dos: Kepler SÍ tiene un RFC para
                   este proveedor, y no es el que el proveedor declara ante el SAT. Quien firma el
                   alta de una cuenta bancaria tiene que ver los dos números, no uno. -->
              <p class="cta-evid-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                <strong>El ERP y el SAT no coinciden sobre quién es este proveedor.</strong>
                Kepler tiene capturado <span class="cta-mono">{{ prop.rfc_discrepa }}</span> y sus comprobantes
                timbrados dicen <span class="cta-mono">{{ prop.rfc }}</span>. Se buscó con el del comprobante.
                La ficha de Kepler sigue sin corregir: verifica a quién le estás dando de alta la cuenta.
              </p>
            } @else if (prop.rfc_fuente === 'nombre') {
              <p class="cta-evid-warn"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                Kepler no tiene un RFC utilizable para este proveedor. Se usó <span class="cta-mono">{{ prop.rfc }}</span>,
                que resolvió el cruce de su nombre normalizado contra ContPAQi. Verifícalo antes de autorizar.
              </p>
            }
            <p class="cta-evid-p cta-muted">Revísala contra lo que tengas y corrígela si hace falta: esto propone, no da de alta.</p>
          </div>
        }
        <label class="cta-lbl">Banco</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_bank_name" class="cta-full" />
        <label class="cta-lbl">Número de cuenta</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_account_number" class="cta-full" />
        <label class="cta-lbl">CLABE</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_clabe" class="cta-full" />
        <label class="cta-lbl">Alias</label>
        <input pInputText type="text" [(ngModel)]="form.proposed_alias" class="cta-full" />
        <label class="cta-check"><p-checkbox [(ngModel)]="form.proposed_es_favorita" [binary]="true" />Marcar como favorita</label>
        <label class="cta-lbl">Adjunto — JPG/PDF de la solicitud de pago</label>
        <input type="file" accept="image/*,application/pdf" (change)="onFile($event)" class="cta-full" />
        @if (uploadedUrl()) { <p class="cta-uploaded">✓ Archivo adjuntado</p> }
      }
      <label class="cta-lbl">Motivo (obligatorio)</label>
      <input pInputText type="text" [(ngModel)]="form.reason" placeholder="Por qué se solicita este cambio" class="cta-full" />
      <div class="cta-dlg-actions"><button pButton type="button" (click)="confirmRequest()" [loading]="saving()">Enviar a autorización</button></div>
    </p-dialog>
  `,
  styles: [`
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cta-section { margin-top:1.4rem; }
    .cta-section h2 { font-size:.95rem; margin:0 0 .5rem; }
    .cta-section-head { display:flex; align-items:baseline; gap:.5rem; }
    .cta-search, .cta-full { width:100%; margin-bottom:.4rem; }
    .cta-sup-list { border:1px solid var(--border-color); border-radius:var(--r-md); max-height:8rem; overflow-y:auto; margin-bottom:.5rem; }
    .cta-sup-item { padding:.3rem .6rem; font-size:.82rem; cursor:pointer; }
    .cta-sup-item:hover { background:var(--card-bg); }
    .cta-sup-current { font-size:.82rem; color:var(--text-muted); margin:.4rem 0; }
    .cta-table { font-size:.84rem; margin-top:.3rem; }
    .cta-mono { font-family:var(--font-mono); }
    .cta-muted { color:var(--text-muted); }
    .cta-fav { color:#f5a623; }
    .cta-att { color:var(--action); }
    .cta-empty { text-align:center; color:var(--text-faint); padding:1.2rem; }
    .cta-reason { max-width:16rem; white-space:normal; }
    :host ::ng-deep .cta-tag { font-size:.64rem; }
    .cta-lbl { display:block; font-size:.76rem; color:var(--text-muted); margin:.4rem 0 .2rem; }
    .cta-check { display:flex; align-items:center; gap:.4rem; margin:.4rem 0; font-size:.82rem; }
    .cta-dlg-p { font-size:.85rem; font-weight:600; margin:0 0 .4rem; }
    .cta-dlg-actions { margin-top:.8rem; }
    .cta-uploaded { font-size:.78rem; color:var(--ok-fg); margin:.2rem 0; }
    /* [PGP.1] */
    app-metric-strip { display:block; margin:.2rem 0 .7rem; }
    .cta-lede { font-size:var(--fs-sm); color:var(--text-main); margin:.2rem 0 .5rem; max-width:62ch; }
    .cta-proc { display:flex; gap:.4rem; align-items:flex-start; font-size:var(--fs-xs); color:var(--text-muted); margin:0 0 .6rem; max-width:82ch; }
    .cta-proc .pi { margin-top:.15rem; }
    /* El renglón donde se cruza el 80 %: una línea, no un relleno — el color no es el dato. */
    .cta-row-corte > td { border-bottom:2px solid var(--action); }
    .cta-sin-edad { display:inline-block; font-size:var(--fs-xs); margin-bottom:.4rem; }
    /* [PGP.29] La cuenta que el proveedor ya declaró. El verde NO es el portador del dato:
       lo que distingue la fila accionable es el ícono y la CLABE a la vista. */
    .cta-prop-ok { display:inline-flex; align-items:center; gap:.3rem; font-size:var(--fs-xs); }
    .cta-prop-ok .pi { color:var(--ok-fg); }
    .cta-prop-sub { display:block; font-size:var(--fs-xs); color:var(--text-muted); }
    .cta-prop-no { font-size:var(--fs-xs); color:var(--text-muted); display:block; max-width:26ch; white-space:normal; }
    .cta-prop-wait { font-size:var(--fs-xs); font-style:italic; }
    .cta-prop-nm { font-size:var(--fs-xs); color:var(--warn-fg); font-style:italic; }
    .cta-evid { border:1px solid var(--border-color); border-left:3px solid var(--ok-fg);
                border-radius:var(--r-sm); padding:.5rem .6rem; margin:.2rem 0 .6rem; }
    .cta-evid-t { margin:0 0 .3rem; font-size:var(--fs-sm); display:flex; align-items:center; gap:.35rem; }
    .cta-evid-t .pi { color:var(--ok-fg); }
    .cta-evid-p { margin:0 0 .25rem; font-size:var(--fs-xs); line-height:1.45; }
    .cta-evid-warn { margin:.35rem 0 .25rem; font-size:var(--fs-xs); line-height:1.45;
                     display:flex; gap:.35rem; align-items:flex-start; }
    .cta-evid-warn .pi { margin-top:.15rem; }
  `],
})
export class FinanzasCuentasPagoComponent implements OnInit {
  /** [NAV.6] La barra del apartado «Pago a proveedor» del sidebar de Compras: la pintan todas sus páginas. */
  private readonly http = inject(HttpClient);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly base = `${environment.apiUrl}/finance/supplier-payment-accounts`;

  readonly canAuthorize = computed(() => this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR] === true);

  supplierSearch = '';
  dlgSupplierSearch = '';
  supplierOpts = signal<SupplierOpt[]>([]);
  selectedSupplier = signal<SupplierOpt | null>(null);
  accounts = signal<PaymentAccount[]>([]);
  loadingAccounts = signal(false);
  requests = signal<ChangeRequest[]>([]);
  loadingRequests = signal(false);
  // [PGP.1] Cobertura de cuentas. `universo` en null = todavía no se midió, distinto de medido en cero.
  faltantes = signal<CuentaPagoFaltante[]>([]);
  universo = signal<CuentasPagoFaltantesResponse['universo'] | null>(null);
  loadingFaltantes = signal(false);
  errorFaltantes = signal<string | null>(null);
  saving = signal(false);
  private searchTimer: any;

  requestVisible = false;
  requestSupplier = signal<SupplierOpt | null>(null);
  requestDeactivate = false;
  requestAccountId: string | null = null;
  uploadedUrl = signal<string | null>(null);
  uploadedKind: 'pdf' | 'image' | null = null;
  form: any = {};

  /**
   * `[PGP.29]` (objetivo **O6**) — lo que el proveedor ya declaró, indexado por su clave.
   *
   * ⭐ Por qué esto existe: el botón «Solicitar cuenta» abría un formulario **vacío**, y por eso
   * el catálogo lleva **0 cuentas**. El trabajo caro nunca fue aprobar: era conseguir la CLABE.
   * Medido el 2026-10-28 contra prod: **21 proveedores ya la declararon** en el comprobante de
   * pago que ellos mismos timbran, con su dígito de control verificado.
   */
  propuestas = signal<ReadonlyMap<string, CuentaPagoPropuesta>>(new Map());
  loadingPropuestas = signal(false);
  /**
   * ⛔ **No se fusiona con «nunca declaró una»** (ADR-056). Si la vista no está publicada o la
   * consulta falla, el mapa queda vacío **igual que si nadie hubiera declarado cuenta**, y la
   * columna afirmaría que 21 proveedores que SÍ la declararon no tienen ninguna. Lo no medido
   * se declara.
   */
  errorPropuestas = signal(false);
  /** La propuesta con la que se precargó el diálogo abierto. `null` si se abrió a mano. */
  propuestaUsada = signal<CuentaPagoPropuesta | null>(null);

  ngOnInit(): void { this.loadRequests(); this.loadFaltantes(); this.loadPropuestas(); }

  /**
   * ⚠️ **Diferida y sin bloquear, a propósito.** La vista que la alimenta encadena
   * `analytics.v_supplier_rfc`: medida contra prod el 2026-10-28 cuesta **794 ms**. La tabla se
   * pinta completa y la columna aparece después; si falla, la pantalla sigue sirviendo
   * exactamente como antes — la propuesta es un acelerador, no un requisito.
   *
   * ⭐ Pero «falla» NO se pinta como «no tiene»: ver `errorPropuestas`.
   */
  loadPropuestas(): void {
    this.loadingPropuestas.set(true);
    this.errorPropuestas.set(false);
    this.http.get<CuentaPagoPropuesta[]>(`${this.base}/propuestas`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => {
        this.propuestas.set(new Map((rows ?? []).map((r) => [String(r.codigo ?? '').trim(), r])));
        this.loadingPropuestas.set(false);
      },
      // Sin toast: no es un error del trabajo de la persona, y la pantalla no depende de esto.
      // Pero SÍ se declara en la columna — un mapa vacío por falla no es un mapa vacío por dato.
      error: () => { this.errorPropuestas.set(true); this.loadingPropuestas.set(false); },
    });
  }

  propuestaDe(codigo: string | null | undefined): CuentaPagoPropuesta | null {
    const k = String(codigo ?? '').trim();
    return k ? this.propuestas().get(k) ?? null : null;
  }

  /** Sólo `propuesta` es accionable: los demás estados explican por qué no, no ofrecen nada. */
  tienePropuesta(codigo: string | null | undefined): boolean {
    return this.propuestaDe(codigo)?.estado === 'propuesta';
  }

  /**
   * `[PGP.1]` **La lista que destraba el Calendario de Pagos.** Sin cuenta destino no se puede
   * preparar un pago, y un lote con un solo pago sin preparar no se puede autorizar: medido el
   * 2026-10-22, 6 lotes llevaban desde el 16-oct en borrador por esto.
   *
   * Los tres niveles de esta sección: **primario** = cuántas cuentas faltan para cubrir el 80 %
   * del dinero · **secundario** = quién, por monto · **terciario** = su último pago, que es con
   * lo que se le ubica en la banca en línea.
   */
  loadFaltantes(): void {
    this.loadingFaltantes.set(true);
    this.errorFaltantes.set(null);
    this.http.get<CuentasPagoFaltantesResponse>(`${this.base}/faltantes`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.universo.set(r.universo); this.faltantes.set(r.faltantes); this.loadingFaltantes.set(false); },
      // ⛔ El error NO se pinta como lista vacía: una cobertura que no se pudo medir no es cero.
      error: (e) => { this.errorFaltantes.set(e?.error?.message || 'No se pudo consultar la cobertura de cuentas.'); this.loadingFaltantes.set(false); },
    });
  }

  kpiFaltantes(u: CuentasPagoFaltantesResponse['universo']): MetricStripItem[] {
    return [
      {
        label: 'Cuentas por dar de alta para cubrir el 80 %',
        value: u.corte_80pct ?? 'Sin pendientes',
        format: u.corte_80pct ? 'number' : 'text',
        tone: u.corte_80pct ? 'warn' : 'ok',
        sub: u.corte_80pct ? `de ${this.faltantes().length} sin cuenta` : undefined,
      },
      { label: 'Dinero ya cubierto', value: u.pct_monto_cubierto, format: 'percent', tone: u.pct_monto_cubierto >= 80 ? 'ok' : 'warn', sub: this.money(u.monto_cubierto) },
      { label: 'Pagado por banco sin cuenta registrada', value: u.monto_total - u.monto_cubierto, format: 'currency-short', sub: `${u.dias} días` },
    ];
  }

  /** `[PGP.1]` Q.4 — del número a su lugar de arreglo, con el proveedor ya puesto. */
  solicitarPara(f: CuentaPagoFaltante): void {
    const s: SupplierOpt = { id: f.supplier_id, name: f.nombre, code: f.codigo };
    this.selectedSupplier.set(s);
    this.supplierSearch = f.nombre;
    this.loadAccounts(f.supplier_id);
    this.requestDeactivate = false;
    this.requestAccountId = null;
    // `[PGP.29]` La solicitud nace LLENA cuando el proveedor ya declaró su cuenta. El motivo
    // cita el comprobante: quien firma necesita saber de dónde salió, no sólo el número.
    // ⛔ El nombre del banco NO se rellena: no hay catálogo que traduzca el código de la CLABE
    //    y escribir uno inventado sería peor que dejarlo vacío.
    const prop = this.propuestaDe(f.codigo);
    const usar = prop?.estado === 'propuesta' ? prop : null;
    this.propuestaUsada.set(usar);
    this.form = usar
      ? {
          proposed_es_favorita: true,
          proposed_clabe: usar.clabe_propuesta,
          reason: `Alta de cuenta para pagarle por transferencia (PGP.1): ${this.money(f.monto)} pagados por banco en la ventana. `
            + `La CLABE la declaró el propio proveedor en su comprobante de pago timbrado ${usar.rep_uuid} `
            + `(${usar.veces_declarada} vez(ces), la última el ${usar.ultima_vez}); su dígito de control está verificado.`
            // [PGP.32] El motivo QUEDA GUARDADO y lo lee quien autoriza: tiene que decir cuál de
            // los dos casos es. Antes afirmaba siempre «no está en Kepler», que desde [PGP.31]
            // es falso para los 18 acreedores en los que Kepler tiene OTRO (ADR-108).
            + (usar.rfc_discrepa
                ? ` ATENCION: Kepler tiene capturado el RFC ${usar.rfc_discrepa} y sus comprobantes timbrados dicen ${usar.rfc}; se busco con el del comprobante (ADR-108).`
                : usar.rfc_fuente === 'nombre'
                  ? ` El RFC ${usar.rfc} no esta en Kepler: lo resolvio el cruce del nombre contra ContPAQi.`
                  : ''),
        }
      : { proposed_es_favorita: true, reason: `Alta de cuenta para pagarle por transferencia (PGP.1): ${this.money(f.monto)} pagados por banco en la ventana.` };
    this.requestSupplier.set(s);
    this.dlgSupplierSearch = '';
    this.uploadedUrl.set(null);
    this.uploadedKind = null;
    this.requestVisible = true;
  }

  /** Los `numeric` de Postgres llegan como string por JSON: `Number()` antes de formatear. */
  money(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }

  requestTitle(): string { return this.requestDeactivate ? 'Solicitar baja de cuenta' : 'Solicitar cuenta de pago'; }

  searchSuppliers(term: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.http.get<SupplierOpt[]>(`${environment.apiUrl}/commercial/supplier-obligations/suppliers`, { params: { search: term } })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.supplierOpts.set(r), error: () => this.supplierOpts.set([]) });
    }, 250);
  }

  pickSupplier(s: SupplierOpt): void {
    this.selectedSupplier.set(s); this.supplierOpts.set([]); this.supplierSearch = s.name;
    this.loadAccounts(s.id);
  }
  loadAccounts(supplierId: string): void {
    this.loadingAccounts.set(true);
    this.http.get<PaymentAccount[]>(`${this.base}/by-supplier/${supplierId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.accounts.set(rows); this.loadingAccounts.set(false); },
      error: () => { this.loadingAccounts.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las cuentas.' }); },
    });
  }

  loadRequests(): void {
    this.loadingRequests.set(true);
    this.http.get<ChangeRequest[]>(`${this.base}/solicitudes`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.requests.set(rows); this.loadingRequests.set(false); },
      error: () => { this.loadingRequests.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se pudieron cargar las solicitudes.' }); },
    });
  }

  tipoLabel(r: ChangeRequest): string { return r.deactivate ? 'Baja' : r.account_id ? 'Cambio' : 'Alta'; }

  openNewSupplierPick(): void {
    this.propuestaUsada.set(null);
    this.requestDeactivate = false; this.requestAccountId = null; this.form = { proposed_es_favorita: false, reason: '' };
    this.requestSupplier.set(this.selectedSupplier()); this.dlgSupplierSearch = ''; this.uploadedUrl.set(null); this.uploadedKind = null;
    this.requestVisible = true;
  }
  openChange(a: PaymentAccount): void {
    this.propuestaUsada.set(null);
    this.requestDeactivate = false; this.requestAccountId = a.id;
    this.form = { proposed_bank_name: a.bank_name, proposed_account_number: a.account_number, proposed_clabe: a.clabe, proposed_alias: a.alias, proposed_es_favorita: a.es_favorita, reason: '' };
    this.requestSupplier.set(this.selectedSupplier()); this.uploadedUrl.set(null); this.uploadedKind = null;
    this.requestVisible = true;
  }
  openDeactivate(a: PaymentAccount): void {
    this.propuestaUsada.set(null);
    this.requestDeactivate = true; this.requestAccountId = a.id; this.form = { reason: '' };
    this.requestSupplier.set(this.selectedSupplier());
    this.requestVisible = true;
  }

  onFile(ev: Event): void {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.http.post<{ url: string; kind: 'pdf' | 'image' }>(`${this.base}/adjunto`, { file_base64: reader.result as string })
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (r) => { this.uploadedUrl.set(r.url); this.uploadedKind = r.kind; },
          error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo subir el archivo.' }),
        });
    };
    reader.readAsDataURL(file);
  }

  confirmRequest(): void {
    const supplier = this.requestSupplier();
    if (!supplier) { this.toast.add({ severity: 'warn', summary: 'Falta el proveedor', detail: 'Selecciona un proveedor.' }); return; }
    if (!this.form.reason?.trim()) { this.toast.add({ severity: 'warn', summary: 'Falta el motivo', detail: 'El cambio de cuenta necesita justificación.' }); return; }
    this.saving.set(true);
    this.http.post(`${this.base}/solicitudes`, {
      supplier_id: supplier.id, account_id: this.requestAccountId, deactivate: this.requestDeactivate,
      proposed_bank_name: this.form.proposed_bank_name, proposed_account_number: this.form.proposed_account_number,
      proposed_clabe: this.form.proposed_clabe, proposed_alias: this.form.proposed_alias,
      proposed_es_favorita: !!this.form.proposed_es_favorita, proposed_attachment_url: this.uploadedUrl(),
      proposed_attachment_kind: this.uploadedKind, reason: this.form.reason,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.saving.set(false); this.requestVisible = false; this.loadRequests(); this.toast.add({ severity: 'success', summary: 'Enviado', detail: 'La solicitud quedó pendiente de autorización.' }); },
      error: (e) => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo enviar.' }); },
    });
  }

  approve(r: ChangeRequest): void {
    this.http.post(`${this.base}/solicitudes/${r.id}/aprobar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadRequests(); if (this.selectedSupplier()) this.loadAccounts(this.selectedSupplier()!.id); this.toast.add({ severity: 'success', summary: 'Aprobado', detail: 'La cuenta se aplicó.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo aprobar.' }),
    });
  }
  reject(r: ChangeRequest): void {
    this.http.post(`${this.base}/solicitudes/${r.id}/rechazar`, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.loadRequests(); this.toast.add({ severity: 'info', summary: 'Rechazado', detail: 'La solicitud se rechazó.' }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo rechazar.' }),
    });
  }
}
