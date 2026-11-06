import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  CASILLAS_KEPLER,
  type CasillaKepler,
  type CatalogosAlta,
  type EstadoSolicitudAlta,
  type SolicitudAlta,
} from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AltaClientesService } from '../alta-clientes.service';
import { AltaClienteFormComponent } from '../components/alta-cliente-form.component';

type Vista = 'pendientes' | EstadoSolicitudAlta | 'todas';

const ESTADO: Record<EstadoSolicitudAlta, { label: string; sev: 'warn' | 'info' | 'success' | 'secondary' }> = {
  credito_por_aprobar: { label: 'Crédito por aprobar', sev: 'warn' },
  lista_para_kepler: { label: 'Por capturar en Kepler', sev: 'info' },
  ligada: { label: 'Ligada a Kepler', sev: 'success' },
  cancelada: { label: 'Cancelada', sev: 'secondary' },
};

/** El orden de la forma «Datos del cliente» de Kepler (md_cat_cli_sc.kpl), para copiar casilla por casilla. */
const ORDEN_KEPLER: CasillaKepler[] = ['nombre', 'direccion_1', 'direccion_2', 'estado', 'codigo_postal', 'telefono_1', 'telefono_2', 'telefono_3', 'rfc', 'curp', 'email'];

/**
 * `[ALC.3]` **Alta de clientes** (`/comercial/alta-clientes`).
 *
 * Las cinco preguntas (skill `diseno` §0b), contestadas antes de la plantilla:
 *  1. Al entrar: lo pendiente contado (crédito por aprobar · por capturar en Kepler, cuántas ya
 *     tienen su clave allá) y «Nuevo cliente». La bandeja abre en «Pendientes», crédito primero
 *     y lo más nuevo arriba.
 *  2. No se ve: obligaciones y actividades de la constancia, la lectura cruda, las canceladas
 *     (a un clic, con su conteo) ni sucursales fuera del alcance.
 *  3. Acceso: la ficha en el orden de Kepler con «copiar» por casilla; búsqueda por RFC, nombre
 *     o folio; el hallazgo junto a su casilla; Enter guarda.
 *  4. Ligada a: la constancia (se abre), el cliente de la Suite al ligar y la bandeja de clientes
 *     del vendedor sin clave (MCP.3.8), enlazada — no se duplica.
 *  5. El crédito se decide aquí mismo (Crédito y Cobranza ve la misma bandeja), no en otra pantalla.
 *
 * Jerarquía: primario = lo pendiente y la acción; secundario = la bandeja; terciario = folio,
 * quién la capturó y cuándo.
 */
@Component({
  selector: 'app-comercial-alta-clientes',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, DialogModule, InputNumberModule, InputTextModule, TableModule, TagModule,
    TextareaModule, ToastModule, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent,
    SidePeekComponent, SucursalPipe, AltaClienteFormComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ac-page">
      <p-toast position="top-center"></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Alta de clientes</h1>
          <p class="surf-page-sub">
            Desde su constancia del SAT o a mano. Se captura en Kepler con la ficha de aquí y se liga con la clave que Kepler le dé.
          </p>
        </div>
        <div class="ac-acciones">
          <app-freshness-pill measures="data" [since]="bandeja()?.kepler_as_of ?? null" label="Maestro de Kepler" [staleAfterSec]="3600" />
          @if (puedeCapturar()) {
            <button pButton type="button" (click)="nuevo()">
              <span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span>Nuevo cliente
            </button>
          }
        </div>
      </header>

      @if (bandeja()?.alcance === 'ninguno') {
        <p class="ac-banda ac-banda-warn" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
          Tu usuario no tiene una sucursal asignada. Pide que te la asignen en Administración › Personas.</p>
      }
      @if (bandeja()?.truncada) {
        <p class="ac-banda ac-banda-warn" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          Se muestran las {{ todas().length }} más recientes: hay más solicitudes de las que caben.</p>
      }
      @if (!bandeja()?.kepler_as_of && bandeja()) {
        <p class="ac-nota" role="status">No se pudo saber cuándo llegó el último cambio del maestro de clientes de Kepler: las coincidencias pueden ir atrasadas.</p>
      }

      @if (bandeja()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Solicitudes de alta pendientes" [selected]="vista()" (drill)="verVista($event)" />
        <div class="ac-filtros">
          <app-segmented [options]="vistas()" [value]="vista()" (valueChange)="verVista($event)" ariaLabel="Qué solicitudes ver" />
          <input pInputText type="search" class="ac-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
                 placeholder="Buscar por nombre, RFC o folio" aria-label="Buscar solicitud" />
        </div>
      }

      <app-load-state [loading]="bandejaRes.isLoading() && !bandeja()" [error]="errorBandeja()" [isEmpty]="!!bandeja() && !visibles().length"
                      emptyIcon="pi-user-plus" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()"
                      [emptyCta]="puedeCapturar() && !busqueda() ? 'Nuevo cliente' : null" (cta)="nuevo()" (retry)="bandejaRes.reload()">
        <p-table [value]="visibles()" dataKey="id" styleClass="p-datatable-sm surf-table surf-table--plain surf-table--sticky"
                 [scrollable]="true" scrollHeight="flex" [rowHover]="true" selectionMode="single" [selection]="seleccion()"
                 (onRowSelect)="alSeleccionar($event.data)">
          <ng-template #header>
            <tr>
              <th scope="col">Cliente</th>
              <th scope="col">Sucursal</th>
              <th scope="col">Estado</th>
              <th scope="col" class="comm-num">Crédito pedido</th>
              <th scope="col" class="ac-col-capturo">Capturó</th>
              <th scope="col"><span class="ac-oculto">Acción</span></th>
            </tr>
          </ng-template>
          <ng-template #body let-s>
            <tr [pSelectableRow]="s" (keydown.enter)="abrir(s)" tabindex="0">
              <td>
                <span class="ac-nombre">{{ s.nombre_fiscal }}</span>
                <span class="ac-rfc">{{ s.rfc }}</span>
              </td>
              <td>{{ s.branch | sucursal }}</td>
              <td>
                <p-tag [value]="etiqueta(s.estado)" [severity]="severidad(s.estado)" />
                @if (s.coincidencias_kepler.length) { <span class="ac-hint">ya está en Kepler: {{ s.coincidencias_kepler[0].clave }}</span> }
                @if (s.estado === 'ligada') { <span class="ac-hint ac-mono">{{ s.erp_customer_code }}</span> }
              </td>
              <td class="comm-num">
                @if (s.credito_solicitado > 0 || s.plazo_dias > 0) { {{ dinero(s.credito_solicitado) }} · {{ s.plazo_dias }} d }
                @else { <span class="ac-tenue">De contado</span> }
              </td>
              <td class="ac-tenue ac-col-capturo">{{ s.creada_por_nombre || 'Sin registro' }} · {{ fechaCorta(s.creada_el) }} <span class="ac-mono">{{ s.folio }}</span></td>
              <td>
                <button pButton type="button" size="small" [text]="true" (click)="abrir(s); $event.stopPropagation()">{{ accion(s) }}</button>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="ac-pie">
        Los clientes que dio de alta el vendedor en su app, sin clave de Kepler, se ligan en
        <a routerLink="/almacen/clientes-nuevos">Almacén › Clientes nuevos</a>.
      </p>
    </div>

    <p-dialog [visible]="dialogo()" (visibleChange)="!$event && cerrarDialogo()" [modal]="true" header="Nuevo cliente"
              [style]="{ width: 'min(56rem, 96vw)' }" [closable]="false" [closeOnEscape]="false" [draggable]="false">
      <app-alta-cliente-form [catalogos]="catalogos()" [branchInicial]="catalogos()?.branch ?? ''" (guardada)="guardada($event)" (cerrar)="cerrarDialogo()" (sucursal)="sucursalForma.set($event)" />
    </p-dialog>

    <app-side-peek [open]="!!abierta()" (openChange)="!$event && abierta.set(null)" [title]="abierta()?.nombre_fiscal ?? ''"
                   [subtitle]="abierta() ? abierta()!.folio + ' · ' + abierta()!.rfc : null" [width]="560">
      @if (abierta(); as s) {
        <section class="ac-det">
          <p class="ac-siguiente">
            <p-tag [value]="etiqueta(s.estado)" [severity]="severidad(s.estado)" />
            <span>{{ siguientePaso(s) }}</span>
          </p>

          @if (s.estado === 'credito_por_aprobar') {
            @if (puedeCredito()) {
              <div class="ac-bloque">
                <h3>Decidir crédito</h3>
                <p class="ac-tenue">Pidió {{ dinero(s.credito_solicitado) }} a {{ s.plazo_dias }} días{{ s.descuento_pct > 0 ? ' y ' + s.descuento_pct + ' % de descuento' : '' }}.</p>
                <div class="ac-rejilla">
                  <label class="ac-campo"><span>Límite aprobado</span>
                    <p-inputnumber [(ngModel)]="credito.limite" mode="currency" currency="MXN" locale="es-MX" [min]="0" inputId="ac-lim" /></label>
                  <label class="ac-campo"><span>Plazo (días)</span>
                    <p-inputnumber [(ngModel)]="credito.plazo" [min]="0" [max]="365" [useGrouping]="false" inputId="ac-plazo" /></label>
                  <label class="ac-campo"><span>Descuento</span>
                    <p-inputnumber [(ngModel)]="credito.descuento" suffix=" %" [min]="0" [max]="100" [maxFractionDigits]="2" inputId="ac-desc" /></label>
                </div>
                <label class="ac-campo"><span>Motivo (queda en el registro)</span>
                  <textarea pTextarea rows="2" [(ngModel)]="credito.motivo"></textarea></label>
                <div class="ac-botones">
                  <button pButton type="button" [disabled]="ocupado() || (credito.motivo || '').trim().length < 5" (click)="decidir(s, 'aprobado')">Aprobar</button>
                  <button pButton type="button" severity="secondary" [outlined]="true" [disabled]="ocupado() || (credito.motivo || '').trim().length < 5" (click)="decidir(s, 'rechazado')">Rechazar: queda de contado</button>
                </div>
              </div>
            } @else {
              <p class="ac-nota">Lo decide Crédito y Cobranza (o, en su ausencia, la Gerencia Administrativa y Financiera o Dirección General).</p>
            }
          }

          @if (s.credito; as c) {
            <p class="ac-nota">
              Crédito {{ c.decision }}{{ c.por_nombre ? ' por ' + c.por_nombre : '' }} el {{ fechaCorta(c.el) }}:
              {{ dinero(c.credito_aprobado) }} a {{ c.plazo_aprobado }} días, {{ c.descuento_aprobado }} %. «{{ c.motivo }}»
              @if (s.credito_decidido_por_quien_la_creo) { <strong>Lo decidió quien capturó la solicitud.</strong> }
            </p>
          }

          @if (s.estado === 'lista_para_kepler' && puedeCapturar()) {
            <div class="ac-bloque">
              <h3>Ligar con Kepler</h3>
              @for (k of s.coincidencias_kepler; track k.clave) {
                <div class="ac-coincide">
                  <span>Kepler ya tiene <strong class="ac-mono">{{ k.clave }}</strong> · {{ k.nombre }} con este RFC.</span>
                  <button pButton type="button" size="small" [disabled]="ocupado()" (click)="ligar(s, k.clave)">Ligar con {{ k.clave }}</button>
                </div>
              }
              <form class="ac-ligar" (ngSubmit)="ligar(s, clave())">
                <label class="ac-campo"><span>Clave que le dio Kepler</span>
                  <input pInputText name="clave" class="ac-mono" [ngModel]="clave()" (ngModelChange)="clave.set($event)" maxlength="20" autocomplete="off" /></label>
                <button pButton type="submit" [disabled]="ocupado() || !clave().trim()">Ligar</button>
              </form>
            </div>
          }

          <div class="ac-bloque">
            <h3>Ficha para Kepler <span class="ac-tenue">— en el orden de la forma</span></h3>
            <table class="ac-ficha">
              <tbody>
                <tr><th scope="row">Clave</th><td class="ac-tenue">{{ s.erp_customer_code || 'La asigna Kepler' }}</td><td></td></tr>
                @for (c of ordenKepler; track c) {
                  <tr>
                    <th scope="row">{{ rotulo(c) }}</th>
                    <td [class.ac-mono]="c === 'rfc' || c === 'curp' || c === 'codigo_postal'">{{ s.ficha[c] || '—' }}</td>
                    <td>@if (s.ficha[c]) {
                      <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="copiar(s.ficha[c], rotulo(c))" [attr.aria-label]="'Copiar ' + rotulo(c)">
                        <span class="p-button-icon pi pi-copy" aria-hidden="true"></span></button>
                    }</td>
                  </tr>
                }
                <tr><th scope="row">Vendedor · Grupo · Zona</th><td class="ac-mono">{{ s.vendedor_code || '—' }} · {{ s.grupo_code || '—' }} · {{ s.zona_code || '—' }}</td><td></td></tr>
                <tr><th scope="row">Límite de crédito · Plazo</th>
                  <td>{{ dinero(s.credito?.decision === 'aprobado' ? s.credito!.credito_aprobado : 0) }} · {{ s.credito?.decision === 'aprobado' ? s.credito!.plazo_aprobado : 0 }} días
                    @if (s.estado === 'credito_por_aprobar') { <span class="ac-tenue">(falta la decisión)</span> }</td><td></td></tr>
                <tr><th scope="row">Descuento (1)</th><td>{{ s.credito?.decision === 'aprobado' ? s.credito!.descuento_aprobado : 0 }} %</td><td></td></tr>
              </tbody>
            </table>
          </div>

          <div class="ac-bloque">
            <h3>Datos fiscales</h3>
            <dl class="ac-dl">
              <dt>Persona</dt><dd>{{ s.tipo_persona === 'moral' ? 'Moral' : 'Física' }}</dd>
              <dt>Régimen</dt><dd>{{ regimen(s.regimen_fiscal) }}</dd>
              <dt>CP fiscal</dt><dd class="ac-mono">{{ s.codigo_postal_fiscal }}</dd>
              @if (s.regimen_capital) { <dt>Régimen de capital</dt><dd>{{ s.regimen_capital }}</dd> }
              <dt>Constancia</dt>
              <dd>@if (s.constancia_key) {
                  <button pButton type="button" size="small" [text]="true" (click)="verConstancia(s)">Ver PDF{{ s.constancia_emitida_el ? ' (emitida ' + fechaCorta(s.constancia_emitida_el) + ')' : '' }}</button>
                } @else { <span class="ac-tenue">{{ s.origen === 'manual' ? 'Capturada a mano' : 'Leída, sin guardar' }}</span> }</dd>
              @if (s.customer_id) { <dt>En la Suite</dt><dd>Con su ficha de cliente: búscala en Comercial › Clientes por su RFC.</dd> }
            </dl>
            @if (s.comentarios) { <p class="ac-comentarios">{{ s.comentarios }}</p> }
          </div>

          @if ((s.estado === 'credito_por_aprobar' || s.estado === 'lista_para_kepler') && puedeCapturar()) {
            <div class="ac-bloque ac-peligro">
              <h3>Cancelar la solicitud</h3>
              <label class="ac-campo"><span>Por qué no se va a dar de alta</span>
                <input pInputText [ngModel]="motivoCancelar()" (ngModelChange)="motivoCancelar.set($event)" /></label>
              <button pButton type="button" severity="danger" [outlined]="true" [disabled]="ocupado() || motivoCancelar().trim().length < 5" (click)="cancelar(s)">Cancelar solicitud</button>
            </div>
          }
        </section>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    /* Angosto (sidebar abierto, tableta): la búsqueda ocupa la fila y quién capturó se ve en el detalle. */
    @container (max-width: 44rem) { .ac-buscar { min-width: 0; max-width: none; } .ac-col-capturo { display: none; } }
    .ac-acciones { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
    .ac-filtros { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; margin: var(--sp-3) 0; }
    .ac-buscar { min-width: 16rem; flex: 1; max-width: 26rem; }
    .ac-banda { display: flex; gap: var(--sp-2); align-items: center; margin: var(--sp-2) 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .ac-banda-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .ac-nota { margin: var(--sp-2) 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .ac-nombre { display: block; font-weight: var(--fw-medium); color: var(--fg-1); }
    .ac-rfc, .ac-mono { font-family: var(--font-mono); }
    .ac-rfc { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .ac-hint { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--fg-2); }
    .ac-tenue { color: var(--fg-3); font-size: var(--fs-xs); }
    .ac-oculto { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .ac-pie { margin-top: var(--sp-4); font-size: var(--fs-xs); color: var(--fg-3); }
    .ac-det { display: flex; flex-direction: column; gap: var(--sp-4); }
    .ac-siguiente { display: flex; gap: var(--sp-2); align-items: center; margin: 0; font-size: var(--fs-sm); color: var(--fg-1); }
    .ac-bloque { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ac-bloque h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--fg-1); }
    .ac-rejilla { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--sp-3); }
    .ac-campo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--fg-2); }
    .ac-campo input, .ac-campo textarea { width: 100%; }
    .ac-botones { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .ac-coincide { display: flex; gap: var(--sp-2); align-items: center; justify-content: space-between; flex-wrap: wrap;
      padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .ac-ligar { display: flex; gap: var(--sp-2); align-items: flex-end; }
    .ac-ficha { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .ac-ficha th { text-align: left; font-weight: var(--fw-medium); color: var(--fg-2); padding: var(--sp-1) var(--sp-2) var(--sp-1) 0; white-space: nowrap; vertical-align: middle; }
    .ac-ficha td { padding: var(--sp-1) 0; color: var(--fg-1); vertical-align: middle; }
    .ac-ficha td:last-child { width: 2.5rem; text-align: right; }
    .ac-ficha tr + tr { border-top: 1px solid var(--border-color); }
    .ac-dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .ac-dl dt { color: var(--fg-2); }
    .ac-dl dd { margin: 0; color: var(--fg-1); }
    .ac-comentarios { white-space: pre-line; margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .ac-peligro { margin-top: var(--sp-4); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    .ac-peligro h3 { color: var(--bad-fg); }
    @media (pointer: coarse) { .ac-det button, .ac-acciones button { min-height: 44px; } }
  `],
})
export class ComercialAltaClientesComponent {
  private readonly svc = inject(AltaClientesService);
  private readonly toast = inject(MessageService);
  private readonly permisos = inject(PermissionsService);

  readonly ordenKepler = ORDEN_KEPLER;
  readonly puedeCapturar = computed(() => this.permisos.has(Permission.COMMERCIAL_ALTA_CLIENTES));
  readonly puedeCredito = computed(() => this.bandeja()?.puede_aprobar_credito === true);

  readonly bandejaRes = rxResource({ stream: () => this.svc.bandeja() });
  readonly bandeja = computed(() => this.bandejaRes.value() ?? null);
  readonly errorBandeja = computed(() => {
    const e = this.bandejaRes.error() as HttpErrorResponse | undefined;
    return e ? (typeof e.error?.message === 'string' ? e.error.message : 'No se pudo cargar la bandeja.') : null;
  });
  readonly sucursalForma = signal<string | null>(null);
  private readonly catalogosRes = rxResource({ params: () => ({ branch: this.sucursalForma() }), stream: ({ params }) => this.svc.catalogos(params.branch) });
  readonly catalogos = computed<CatalogosAlta | null>(() => this.catalogosRes.value() ?? null);

  readonly vista = signal<Vista>('pendientes');
  readonly busqueda = signal('');
  readonly dialogo = signal(false);
  readonly abierta = signal<SolicitudAlta | null>(null);
  readonly seleccion = computed(() => this.abierta());
  readonly clave = signal('');
  readonly motivoCancelar = signal('');
  readonly ocupado = signal(false);
  credito = { limite: 0, plazo: 0, descuento: 0, motivo: '' };

  constructor() {
    // Al abrir una solicitud, la decisión de crédito arranca con lo que se pidió.
    effect(() => {
      const s = this.abierta();
      this.credito = { limite: s?.credito_solicitado ?? 0, plazo: s?.plazo_dias ?? 0, descuento: s?.descuento_pct ?? 0, motivo: '' };
    });
  }

  readonly todas = computed(() => this.bandeja()?.solicitudes ?? []);
  readonly visibles = computed(() => {
    const v = this.vista(), q = this.busqueda();
    return this.todas()
      .filter((s) => v === 'todas' || (v === 'pendientes' ? s.estado === 'credito_por_aprobar' || s.estado === 'lista_para_kepler' : s.estado === v))
      .filter((s) => coincideBusqueda(q, s.nombre_fiscal, s.rfc, s.folio, s.ficha.nombre, s.erp_customer_code));
  });
  readonly conCoincidencia = computed(() => this.todas().filter((s) => s.coincidencias_kepler.length > 0).length);
  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.bandeja()?.conteo;
    if (!c) return [];
    return [
      { drill: 'credito_por_aprobar', label: 'Crédito por aprobar', value: c.credito_por_aprobar, format: 'number', tone: c.credito_por_aprobar ? 'warn' : 'default', sub: 'espera a Crédito y Cobranza' },
      { drill: 'lista_para_kepler', label: 'Por capturar en Kepler', value: c.lista_para_kepler, format: 'number',
        sub: this.conCoincidencia() ? `${this.conCoincidencia()} ya tienen su clave en Kepler: falta ligarlas` : 'copiar la ficha y ligar la clave' },
      { drill: 'ligada', label: 'Ligadas a Kepler', value: c.ligada, format: 'number', sub: 'con su ficha en la Suite' },
    ];
  });
  readonly vistas = computed<SegOption[]>(() => {
    const c = this.bandeja()?.conteo;
    const n = (k: EstadoSolicitudAlta) => c?.[k] ?? 0;
    return [
      { label: 'Pendientes', value: 'pendientes', count: n('credito_por_aprobar') + n('lista_para_kepler') },
      { label: 'Crédito por aprobar', value: 'credito_por_aprobar', count: n('credito_por_aprobar') },
      { label: 'Por capturar en Kepler', value: 'lista_para_kepler', count: n('lista_para_kepler') },
      { label: 'Ligadas', value: 'ligada', count: n('ligada') },
      { label: 'Canceladas', value: 'cancelada', count: n('cancelada') },
      { label: 'Todas', value: 'todas' },
    ] as SegOption[];
  });
  readonly vacioTitulo = computed(() => (this.busqueda() ? 'Nada coincide con la búsqueda' : this.vista() === 'pendientes' ? 'No hay altas pendientes' : 'No hay solicitudes en esta vista'));
  readonly vacioPista = computed(() => (this.busqueda() ? 'Prueba con el RFC o parte del nombre.' : this.vista() === 'pendientes' ? 'Las que capturen la caja, los encargados y los vendedores aparecen aquí.' : null));

  // ── textos ───────────────────────────────────────────────────────────────────────────────
  etiqueta(e: EstadoSolicitudAlta): string { return ESTADO[e].label; }
  severidad(e: EstadoSolicitudAlta) { return ESTADO[e].sev; }
  rotulo(c: CasillaKepler): string { return CASILLAS_KEPLER[c].rotulo; }
  accion(s: SolicitudAlta): string {
    if (s.estado === 'credito_por_aprobar') return this.puedeCredito() ? 'Decidir crédito' : 'Ver';
    if (s.estado === 'lista_para_kepler') return s.coincidencias_kepler.length ? 'Ligar' : 'Ver ficha';
    return 'Ver';
  }
  siguientePaso(s: SolicitudAlta): string {
    switch (s.estado) {
      case 'credito_por_aprobar': return `Pidió ${this.dinero(s.credito_solicitado)} a ${s.plazo_dias} días. Hasta que Crédito y Cobranza decida, no se captura en Kepler.`;
      case 'lista_para_kepler': return s.coincidencias_kepler.length
        ? 'Kepler ya tiene una ficha con este RFC: si es la que capturaron, lígala.'
        : 'Falta capturarla en Kepler: copia la ficha casilla por casilla y escribe aquí la clave que te dé Kepler.';
      case 'ligada': return `Ligada a la clave ${s.erp_customer_code} de Kepler${s.ligada_el ? ' el ' + this.fechaCorta(s.ligada_el) : ''}.`;
      default: return 'Cancelada: no se dio de alta.';
    }
  }
  regimen(clave: string): string {
    const r = this.catalogos()?.regimenes.find((x) => x.clave === clave);
    return r ? `${r.clave} · ${r.descripcion}` : clave;
  }
  dinero(v: number | string | null | undefined): string {
    return Number(v ?? 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  fechaCorta(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── acciones ─────────────────────────────────────────────────────────────────────────────
  verVista(v: string): void { this.vista.set(v as Vista); }

  nuevo(): void {
    // El diálogo crea el formulario al abrirse: nace limpio, con la sucursal por defecto.
    this.dialogo.set(true);
  }
  cerrarDialogo(): void { this.dialogo.set(false); }

  guardada(s: SolicitudAlta): void {
    this.dialogo.set(false);
    this.toast.add({ severity: 'success', summary: `Solicitud ${s.folio} guardada`, detail: this.siguientePaso(s) });
    this.bandejaRes.reload();
    this.abierta.set(s);
  }

  /**
   * `TableRowSelectEvent.data` es `T | T[] | undefined` (PrimeNG admite selección múltiple) y el
   * compilador de plantillas lo exige aunque aquí sea `single`. Se estrecha con una guarda, no con
   * un `as`: si un día cambia el modo, el panel no se abre con un arreglo como si fuera una solicitud.
   */
  alSeleccionar(data: SolicitudAlta | SolicitudAlta[] | undefined): void {
    const s = Array.isArray(data) ? data[0] : data;
    if (s) this.abrir(s);
  }

  abrir(s: SolicitudAlta): void {
    this.clave.set('');
    this.motivoCancelar.set('');
    this.abierta.set(s);
  }

  async copiar(valor: string, rotulo: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(valor);
      this.toast.add({ severity: 'info', summary: `${rotulo} copiado`, life: 1200 });
    } catch {
      this.toast.add({ severity: 'warn', summary: 'No se pudo copiar', detail: 'Selecciónalo y cópialo a mano.' });
    }
  }

  verConstancia(s: SolicitudAlta): void {
    this.svc.urlConstancia(s.id).subscribe({
      next: ({ url }) => window.open(url, '_blank', 'noopener'),
      error: (e: HttpErrorResponse) => this.error(e, 'No se pudo abrir la constancia.'),
    });
  }

  decidir(s: SolicitudAlta, decision: 'aprobado' | 'rechazado'): void {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    const c = this.credito;
    this.svc.decidirCredito(s.id, { decision, motivo: c.motivo, credito_aprobado: c.limite, plazo_aprobado: c.plazo, descuento_aprobado: c.descuento }).subscribe({
      next: (r) => this.hecho(r, decision === 'aprobado' ? 'Crédito aprobado' : 'Crédito rechazado: queda de contado'),
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.error(e, 'No se pudo guardar la decisión.'); },
    });
  }

  ligar(s: SolicitudAlta, clave: string): void {
    if (this.ocupado() || !clave.trim()) return;
    this.ocupado.set(true);
    this.svc.ligar(s.id, clave.trim()).subscribe({
      next: (r) => this.hecho(r, `Ligada a la clave ${r.erp_customer_code} de Kepler`),
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.error(e, 'No se pudo ligar.'); },
    });
  }

  cancelar(s: SolicitudAlta): void {
    if (this.ocupado()) return;
    this.ocupado.set(true);
    this.svc.cancelar(s.id, this.motivoCancelar().trim()).subscribe({
      next: (r) => this.hecho(r, `Solicitud ${r.folio} cancelada`),
      error: (e: HttpErrorResponse) => { this.ocupado.set(false); this.error(e, 'No se pudo cancelar.'); },
    });
  }

  private hecho(r: SolicitudAlta, resumen: string): void {
    this.ocupado.set(false);
    this.toast.add({ severity: 'success', summary: resumen });
    this.abierta.set(r);
    this.bandejaRes.reload();
  }

  private error(e: HttpErrorResponse, defecto: string): void {
    const m = e?.error?.message;
    this.toast.add({ severity: 'error', summary: defecto, detail: typeof m === 'string' ? m : Array.isArray(m) ? m.join(' ') : undefined, life: 8000 });
  }
}
