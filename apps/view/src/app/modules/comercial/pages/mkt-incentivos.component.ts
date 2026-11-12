import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, distinctUntilChanged, firstValueFrom, forkJoin, map, of, switchMap } from 'rxjs';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { warehouseName } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ComercialService } from '../comercial.service';
import { PROMOS_TABS } from '../promos-tabs';
import {
  CANALES, CANAL_CORTO, Canal, IncentivoConResultado, IncentivoDto, MktRankingService, TIPO_INCENTIVO, TipoIncentivo,
  moverSemana, textoSemana,
} from '../mkt-ranking.service';
import { pdfIncentivos } from '../mkt-ranking-pdf';
import { SUCURSALES_VENTA } from './mkt-ranking-promos.component';

const dinero = (v: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(v) || 0);
const ymd = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);
const aFecha = (s: string | null) => (s ? new Date(`${s}T12:00:00`) : null);

interface FormIncentivo {
  id: string | null;
  nombre: string;
  tipo: TipoIncentivo;
  pago: number | null;
  base_monto: number | null;
  completo: boolean;
  productos: Array<{ sku: string; nombre: string | null }>;
  desde: Date | null;
  hasta: Date | null;
  canales: Canal[];
  sucursales: string[];
}

/** Lo que la forma manda al servidor, ya validado. Devuelve el error en palabras si falta algo. */
export function dtoDeForm(f: FormIncentivo): IncentivoDto | string {
  if (f.nombre.trim().length < 3) return 'Ponle nombre (el producto o la marca).';
  if (!(Number(f.pago) > 0)) return 'Indica cuánto se paga.';
  if (f.tipo === 'por_monto' && !(Number(f.base_monto) > 0)) return 'Indica cada cuántos pesos se paga.';
  if (f.tipo !== 'por_captura' && !f.productos.length) return 'Elige al menos un producto.';
  if (!f.desde) return 'Elige cuándo empieza.';
  if (f.hasta && f.hasta < f.desde) return 'La fecha de fin es anterior a la de inicio.';
  if (!f.canales.length) return 'Elige al menos un canal.';
  return {
    nombre: f.nombre.trim(), tipo: f.tipo, pago: Number(f.pago), base_monto: f.tipo === 'por_monto' ? Number(f.base_monto) : null,
    redondeo: f.completo ? 'completo' : 'proporcional', skus: f.productos.map((p) => p.sku),
    vigencia_desde: ymd(f.desde)!, vigencia_hasta: ymd(f.hasta), canales: f.canales,
    warehouse_codes: f.sucursales.length && f.sucursales.length < SUCURSALES_VENTA.length ? f.sucursales : null,
  };
}

/**
 * `[MKT.14]` **Incentivos** — lo que se le paga a cada vendedor por vender ciertos productos
 * («$50 por caja de Súper Sport», «$5 por cada $120 de Colombina»). Reemplaza los bloques de
 * «PESOS POR CAJAS» del Excel, donde 165 renglones multiplicaban por un monto distinto al de su
 * propio texto: aquí la regla se captura una vez y el pago sale de ella.
 *
 * Propósito: ¿cuánto se le paga a cada vendedor esta semana, y por qué?
 * Jerarquía: primario = lo que se paga esta semana; secundario = el acumulado y la regla;
 * terciario = vigencia, productos y la nota de medición.
 *
 * ⚠️ Esto CALCULA el pago, no lo hace: no escribe en nómina ni en caja. El PDF lleva firmas.
 */
@Component({
  selector: 'app-mkt-incentivos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, InputTextModule, InputNumberModule, DialogModule,
    DatePickerModule, MultiSelectModule, SelectModule, CheckboxModule, ToastModule, ConfirmDialogModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SidePeekComponent, ContextHelpComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page inc">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Incentivos de venta <app-context-help topic="mkt-incentivos" /></h1>
          <p class="surf-page-sub">Cuánto se le paga a cada vendedor esta semana y por qué. Sale de la venta en Kepler; aquí no se paga nada.</p>
        </div>
        <div class="inc-acciones">
          <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="900"></app-freshness-pill>
          @if (puedeGestionar) {
            <button pButton type="button" class="p-button-sm p-button-outlined" (click)="nuevo()" [disabled]="trabajando()">
              <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span><span class="p-button-label">Nuevo incentivo</span></button>
          }
          <button pButton type="button" class="p-button-sm" (click)="pdf()" [disabled]="generando() || !datos()?.incentivos?.length" [loading]="generando()">
            <span class="p-button-icon p-button-icon-left pi pi-file-pdf" aria-hidden="true"></span><span class="p-button-label">PDF de pago</span></button>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" variant="menu" ariaLabel="Secciones de Mercadotecnia" />

      <div class="inc-filtros">
        <div class="inc-semana" role="group" aria-label="Semana">
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(-1)" aria-label="Semana anterior">
            <span class="p-button-icon pi pi-chevron-left" aria-hidden="true"></span></button>
          <span class="inc-semana-txt">{{ datos() ? semanaTexto() : 'Cargando semana…' }}</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="cambiarSemana(1)" [disabled]="datos()?.semana?.en_curso" aria-label="Semana siguiente">
            <span class="p-button-icon pi pi-chevron-right" aria-hidden="true"></span></button>
        </div>
        <input pInputText type="search" class="inc-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Incentivo o producto" aria-label="Buscar incentivo" />
      </div>

      @if (datos()) { <app-metric-strip [items]="kpis()" ariaLabel="Incentivos de la semana"></app-metric-strip> }

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="res.error() ? 'No se pudieron cargar los incentivos.' : null"
                      [isEmpty]="!!datos() && !filas().length" emptyIcon="pi-wallet"
                      [emptyTitle]="(datos()?.incentivos?.length ?? 0) ? 'Nada coincide' : 'Sin incentivos vigentes esta semana'"
                      [emptyHint]="(datos()?.incentivos?.length ?? 0) ? 'Prueba otra búsqueda.' : 'Da de alta los incentivos que pagan las marcas: la regla se captura una vez y el pago sale solo de la venta.'"
                      [emptyCta]="puedeGestionar && !(datos()?.incentivos?.length ?? 0) ? 'Nuevo incentivo' : null" (cta)="nuevo()" (retry)="res.reload()">
        <p-table [value]="filas()" dataKey="id" selectionMode="single" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abierto.set($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Incentivo</th>
              <th>Vigencia</th>
              <th class="comm-num">Vendedores</th>
              <th class="comm-num">A pagar esta semana</th>
              <th class="comm-num">Acumulado</th>
            </tr>
          </ng-template>
          <ng-template #body let-i>
            <tr [pSelectableRow]="i" [attr.aria-label]="'Ver el pago de ' + i.nombre">
              <td data-label="Incentivo">
                <span class="inc-nombre">{{ i.nombre }}</span>
                <span class="inc-tenue">{{ i.regla }}@if (i.redondeo === 'completo') { · sólo unidades completas }</span>
                @if (i.nota_medicion) { <span class="inc-aviso"><i class="pi pi-info-circle" aria-hidden="true"></i> {{ i.nota_medicion }}</span> }
              </td>
              <td class="inc-nowrap" data-label="Vigencia">{{ fecha(i.vigencia_desde) }} → {{ i.vigencia_hasta ? fecha(i.vigencia_hasta) : 'sin fin' }}</td>
              <td class="comm-num" data-label="Vendedores">{{ i.resultados.length }}</td>
              <td class="comm-num inc-pago" data-label="A pagar esta semana">{{ dinero(i.total_semana) }}</td>
              <td class="comm-num" data-label="Acumulado">{{ dinero(i.total_acumulado) }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <app-side-peek [open]="!!abierto()" (openChange)="$event ? null : abierto.set(null)" [width]="820"
                     [title]="abierto()?.nombre ?? ''" [subtitle]="abierto()?.regla ?? null">
        @if (abierto(); as i) {
          <p class="inc-frase">Esta semana se pagan <strong>{{ dinero(i.total_semana) }}</strong> a {{ conPagoSemana(i) }} vendedores;
            en toda la vigencia van <strong>{{ dinero(i.total_acumulado) }}</strong>.</p>
          @if (i.productos.length) {
            <p class="inc-tenue">Productos: {{ productosTexto(i) }}</p>
          }
          <p-table [value]="i.resultados" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr>
                <th>Vendedor</th>
                <th class="comm-num">{{ unidad(i) }} semana</th>
                <th class="comm-num">{{ unidad(i) }} acumulado</th>
                <th class="comm-num">A pagar semana</th>
                <th class="comm-num">Acumulado</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td>
                  <span class="inc-nombre">{{ r.vendor_name }}</span>
                  <span class="inc-tenue">{{ r.warehouse_name }}@if (r.canal) { · {{ canalCorto(r.canal) }} }</span>
                </td>
                <td class="comm-num">{{ r.semana_cantidad | number:'1.0-2' }}</td>
                <td class="comm-num">{{ r.acumulado_cantidad | number:'1.0-2' }}
                  @if (r.sin_resolver) { <span class="inc-tenue">+{{ r.sin_resolver | number:'1.0-2' }} sin factor</span> }</td>
                <td class="comm-num inc-pago">{{ dinero(r.semana_pago) }}</td>
                <td class="comm-num">{{ dinero(r.acumulado_pago) }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="5" class="inc-tenue">Nadie ha vendido estos productos en la vigencia.</td></tr>
            </ng-template>
          </p-table>

          @if (i.tipo === 'por_captura' && puedeGestionar) {
            <h3 class="inc-h3">Captura de la semana</h3>
            <p class="inc-tenue">Kepler no registra exhibidores colocados: se capturan por vendedor para {{ semanaTexto() }}.</p>
            <app-load-state [loading]="cargandoCaptura()" [isEmpty]="!cargandoCaptura() && !captura().length" emptyIcon="pi-users"
                            emptyTitle="Sin vendedores en los canales del incentivo esta semana">
              <p-table [value]="captura()" size="small" class="surf-table surf-table--plain">
                <ng-template #header><tr><th>Vendedor</th><th class="comm-num">Exhibidores colocados</th></tr></ng-template>
                <ng-template #body let-c>
                  <tr>
                    <td><span class="inc-nombre">{{ c.nombre }}</span><span class="inc-tenue">{{ suc(c.warehouse_code) }}</span></td>
                    <td class="comm-num"><p-inputnumber [(ngModel)]="c.cantidad" [min]="0" [maxFractionDigits]="0" [inputStyle]="{ width: '6rem', 'text-align': 'right' }" [ariaLabel]="'Exhibidores de ' + c.nombre"></p-inputnumber></td>
                  </tr>
                </ng-template>
              </p-table>
            </app-load-state>
            <div class="inc-peek-acciones">
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="cargarCaptura(i)" [disabled]="trabajando()"><span class="p-button-label">Traer vendedores</span></button>
              <button pButton type="button" class="p-button-sm" (click)="guardarCaptura(i)" [disabled]="trabajando() || !captura().length" [loading]="trabajando()"><span class="p-button-label">Guardar captura</span></button>
            </div>
          }

          @if (puedeGestionar) {
            <div class="inc-peek-acciones">
              <button pButton type="button" class="p-button-sm p-button-text p-button-danger" (click)="terminar(i)" [disabled]="trabajando()"><span class="p-button-label">Terminar incentivo</span></button>
              <span class="inc-espacio"></span>
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="editar(i)" [disabled]="trabajando()"><span class="p-button-label">Editar regla</span></button>
            </div>
          }
        }
      </app-side-peek>

      <p-dialog [visible]="!!form()" (visibleChange)="$event ? null : form.set(null)" [modal]="true" [style]="{ width: 'min(46rem, 96vw)' }"
                [header]="form()?.id ? 'Editar incentivo' : 'Nuevo incentivo'" [draggable]="false">
        @if (form(); as f) {
          <div class="inc-form">
            <label class="inc-campo" for="inc-nombre">Nombre (producto o marca)</label>
            <input id="inc-nombre" pInputText [(ngModel)]="f.nombre" maxlength="200" placeholder="Súper Sport 1 kg" />
            <div class="inc-tres">
              <div>
                <label class="inc-campo" for="inc-tipo">Cómo se paga</label>
                <p-select inputId="inc-tipo" [options]="tipos" optionLabel="label" optionValue="value" [(ngModel)]="f.tipo" appendTo="body"></p-select>
              </div>
              <div>
                <label class="inc-campo" for="inc-pago">Se pagan</label>
                <p-inputnumber inputId="inc-pago" [(ngModel)]="f.pago" mode="currency" currency="MXN" locale="es-MX" [min]="0"></p-inputnumber>
              </div>
              @if (f.tipo === 'por_monto') {
                <div>
                  <label class="inc-campo" for="inc-base">Por cada (pesos vendidos)</label>
                  <p-inputnumber inputId="inc-base" [(ngModel)]="f.base_monto" mode="currency" currency="MXN" locale="es-MX" [min]="0"></p-inputnumber>
                </div>
              }
            </div>
            <p class="inc-tenue">{{ explicacion(f) }}</p>
            @if (f.tipo === 'por_caja' || f.tipo === 'por_unidad' || f.tipo === 'por_monto') {
              <label class="inc-check"><p-checkbox inputId="inc-completo" [binary]="true" [(ngModel)]="f.completo"></p-checkbox>
                <span>Pagar sólo unidades completas (sin fracciones)</span></label>
            }
            @if (f.tipo !== 'por_captura') {
              <label class="inc-campo" for="inc-prod">Productos</label>
              <input id="inc-prod" pInputText type="search" [ngModel]="buscarProd()" (ngModelChange)="buscarProd.set($event); prod$.next($event)" placeholder="Buscar por nombre o clave" autocomplete="off" />
              @if (productosEncontrados().length) {
                <ul class="inc-lista" aria-label="Productos encontrados">
                  @for (p of productosEncontrados(); track p.sku) {
                    <li><button type="button" class="inc-op" (click)="agregarProducto(p)"><span>{{ p.sku }} · {{ p.nombre }}</span><i class="pi pi-plus" aria-hidden="true"></i></button></li>
                  }
                </ul>
              }
              <div class="inc-chips" aria-label="Productos elegidos">
                @for (p of f.productos; track p.sku) {
                  <span class="inc-chip">{{ p.sku }} · {{ p.nombre ?? '' }}
                    <button type="button" class="inc-chip-x" (click)="quitarProducto(p.sku)" [attr.aria-label]="'Quitar ' + p.sku"><i class="pi pi-times" aria-hidden="true"></i></button></span>
                } @empty { <span class="inc-tenue">Ningún producto elegido.</span> }
              </div>
            }
            <div class="inc-tres">
              <div>
                <label class="inc-campo" for="inc-desde">Empieza</label>
                <p-datepicker inputId="inc-desde" [(ngModel)]="f.desde" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body"></p-datepicker>
              </div>
              <div>
                <label class="inc-campo" for="inc-hasta">Termina <span class="inc-tenue-i">(vacío = sin fin)</span></label>
                <p-datepicker inputId="inc-hasta" [(ngModel)]="f.hasta" dateFormat="dd/mm/yy" [showIcon]="true" [showClear]="true" [minDate]="f.desde" appendTo="body"></p-datepicker>
              </div>
            </div>
            <span class="inc-campo" id="inc-canales-l">Quién lo cobra (canal)</span>
            <div class="inc-canales" role="group" aria-labelledby="inc-canales-l">
              @for (c of todosCanales; track c) {
                <label class="inc-check"><p-checkbox [inputId]="'inc-c-' + c" [value]="c" [(ngModel)]="f.canales"></p-checkbox><span>{{ canalCorto(c) }}</span></label>
              }
            </div>
            <label class="inc-campo" for="inc-sucs">Sucursales <span class="inc-tenue-i">(vacío = todas)</span></label>
            <p-multiselect inputId="inc-sucs" [options]="opcionesSucursal" optionLabel="label" optionValue="value" [(ngModel)]="f.sucursales"
                           placeholder="Todas las sucursales" display="chip" appendTo="body"></p-multiselect>
            @if (errorForm()) { <p class="inc-error" role="alert">{{ errorForm() }}</p> }
          </div>
        }
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="form.set(null)"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" (click)="guardar()" [disabled]="trabajando()" [loading]="trabajando()"><span class="p-button-label">{{ form()?.id ? 'Guardar cambios' : 'Crear incentivo' }}</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .inc-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .inc-filtros { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin: var(--sp-4) 0 var(--sp-3); }
    .inc-semana { display: inline-flex; align-items: center; gap: var(--sp-1); }
    .inc-semana-txt { font-weight: var(--fw-bold); min-width: 15rem; text-align: center; font-variant-numeric: tabular-nums; }
    .inc-buscar { min-width: 14rem; margin-left: auto; }
    .inc-nombre { display: block; font-weight: var(--fw-medium); }
    .inc-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .inc-tenue-i { color: var(--text-muted); font-size: var(--fs-xs); font-weight: var(--fw-regular); }
    .inc-aviso { display: flex; gap: var(--sp-1); color: var(--warn-fg); font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .inc-nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .inc-pago { font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .inc-frase { margin: 0 0 var(--sp-2); }
    .inc-h3 { font-size: var(--fs-h3); margin: var(--sp-5) 0 var(--sp-1); }
    .inc-peek-acciones { display: flex; gap: var(--sp-2); align-items: center; margin-top: var(--sp-4); flex-wrap: wrap; }
    .inc-espacio { flex: 1; }
    .inc-form { display: flex; flex-direction: column; gap: var(--sp-2); }
    .inc-campo { font-weight: var(--fw-medium); font-size: var(--fs-sm); margin-top: var(--sp-2); }
    .inc-tres { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--sp-3); }
    .inc-tres > div { display: flex; flex-direction: column; gap: var(--sp-1); }
    .inc-check { display: inline-flex; gap: var(--sp-2); align-items: center; }
    .inc-canales { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
    .inc-lista { list-style: none; margin: 0; padding: 0; max-height: 12rem; overflow: auto; border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .inc-lista > li + li { border-top: 1px solid var(--border-color); }
    .inc-op { all: unset; box-sizing: border-box; width: 100%; display: flex; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); cursor: pointer; }
    .inc-op:hover { background: var(--overlay-hover); }
    .inc-op:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .inc-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .inc-chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-pill); font-size: var(--fs-xs); }
    .inc-chip-x { all: unset; cursor: pointer; display: inline-flex; padding: 0 var(--sp-1); }
    .inc-chip-x:focus-visible { outline: 2px solid var(--focus-ring); }
    .inc-error { color: var(--bad-fg); margin: var(--sp-2) 0 0; }
    @media (max-width: 48rem) { .inc-buscar { margin-left: 0; width: 100%; } .inc-semana-txt { min-width: 0; } }
  `],
})
export class MktIncentivosComponent {
  private readonly api = inject(MktRankingService);
  private readonly catalogo = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  readonly tabs = PROMOS_TABS;
  readonly puedeGestionar = this.perms.has(Permission.MKT_AGREEMENTS_GESTIONAR);
  readonly todosCanales = CANALES;
  readonly opcionesSucursal = SUCURSALES_VENTA.map((c) => ({ label: warehouseName(c), value: c }));
  readonly tipos = (Object.keys(TIPO_INCENTIVO) as TipoIncentivo[]).map((t) => ({ label: TIPO_INCENTIVO[t], value: t }));
  readonly dinero = dinero;
  readonly suc = warehouseName;

  readonly semana = signal<string | null>(null);
  readonly busqueda = signal('');
  readonly abierto = signal<IncentivoConResultado | null>(null);
  readonly trabajando = signal(false);
  readonly generando = signal(false);

  readonly res = rxResource({ params: () => this.semana(), stream: ({ params }) => this.api.incentivos(params) });
  readonly datos = computed(() => (this.res.hasValue() ? this.res.value() : undefined));
  readonly filas = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.incentivos ?? []).filter((i) => coincideBusqueda(q, i.nombre, i.regla, ...i.productos.map((p) => `${p.sku} ${p.nombre ?? ''}`)));
  });
  readonly semanaTexto = computed(() => { const d = this.datos(); return d ? textoSemana(d.semana) : ''; });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const is = this.datos()?.incentivos ?? [];
    const semana = is.reduce((a, i) => a + i.total_semana, 0);
    const vendedores = new Set(is.flatMap((i) => i.resultados.filter((r) => r.semana_pago > 0).map((r) => `${r.warehouse_code}|${r.vendor_code}`))).size;
    const sinFactor = is.filter((i) => i.resultados.some((r) => r.sin_resolver > 0)).length;
    return [
      { label: 'A pagar esta semana', value: semana, format: 'currency2', tone: 'brand' },
      { label: 'Vendedores que cobran', value: vendedores, format: 'number' },
      { label: 'Incentivos vigentes', value: is.length, format: 'number' },
      { label: 'Con ventas sin factor de caja', value: sinFactor, format: 'number', tone: sinFactor ? 'warn' : 'ok', sub: sinFactor ? 'corregir la ficha en Kepler' : 'todo convertido' },
    ];
  });

  cambiarSemana(delta: number): void {
    const d = this.datos();
    if (!d) return;
    this.abierto.set(null);
    this.semana.set(moverSemana(d.semana.lunes, delta));
  }

  fecha(s: string): string {
    return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${s}T00:00:00Z`)).replace('.', '');
  }
  canalCorto(c: Canal): string { return CANAL_CORTO[c]; }
  conPagoSemana(i: IncentivoConResultado): number { return i.resultados.filter((r) => r.semana_pago > 0).length; }
  productosTexto(i: IncentivoConResultado): string { return i.productos.map((p) => `${p.sku} ${p.nombre ?? ''}`.trim()).join(' · '); }
  unidad(i: IncentivoConResultado): string {
    return { por_caja: 'Cajas', por_unidad: 'Unidades', por_monto: 'Bloques', por_cliente: 'Clientes', por_captura: 'Exhibidores' }[i.tipo];
  }
  explicacion(f: FormIncentivo): string {
    const p = f.pago ? dinero(f.pago) : '$__';
    switch (f.tipo) {
      case 'por_caja': return `${p} por cada caja vendida. La caja se cuenta con el factor de la ficha de Kepler de cada sucursal.`;
      case 'por_unidad': return `${p} por cada unidad vendida (la unidad base de Kepler).`;
      case 'por_monto': return `${p} por cada ${f.base_monto ? dinero(f.base_monto) : '$__'} vendidos (importe con impuestos).`;
      case 'por_cliente': return `${p} por cada cliente distinto al que se le vendió en la semana.`;
      case 'por_captura': return `${p} por cada exhibidor colocado. Kepler no lo registra: se captura cada semana.`;
    }
  }

  // ── PDF ──
  async pdf(): Promise<void> {
    const d = this.datos();
    if (!d || this.generando()) return;
    this.generando.set(true);
    const win = abrirPestanaParaPdf('Preparando el pago de incentivos…');
    try {
      const { blob, archivo } = await pdfIncentivos({
        semana: d.semana, incentivos: this.filas(), elaboro: this.auth.user()?.username ?? 'Mercadotecnia', consultado: new Date(d.consultado_at),
      });
      if (entregarPdf(win, blob, archivo) === 'descarga') this.toast.add({ severity: 'success', summary: 'PDF descargado', detail: archivo });
    } catch {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudo generar el PDF', detail: 'Intenta de nuevo.' });
    } finally {
      this.generando.set(false);
    }
  }

  // ── captura (exhibidores) ──
  readonly captura = signal<Array<{ warehouse_code: string; vendor_code: string; nombre: string; cantidad: number | null }>>([]);
  readonly cargandoCaptura = signal(false);

  async cargarCaptura(i: IncentivoConResultado): Promise<void> {
    const d = this.datos();
    if (!d) return;
    this.cargandoCaptura.set(true);
    try {
      const rankings = await firstValueFrom(forkJoin(i.canales.map((c) => this.api.ranking(d.semana.lunes, c).pipe(catchError(() => of(null))))));
      const ya = new Map(i.resultados.map((r) => [`${r.warehouse_code}|${r.vendor_code}`, r.semana_cantidad]));
      const filas = new Map<string, { warehouse_code: string; vendor_code: string; nombre: string; cantidad: number | null }>();
      for (const r of rankings) {
        for (const p of r?.participantes ?? []) {
          if (!p.vendor_code) continue;
          if (i.warehouse_codes && !i.warehouse_codes.includes(p.warehouse_code)) continue;
          const k = `${p.warehouse_code}|${p.vendor_code}`;
          filas.set(k, { warehouse_code: p.warehouse_code, vendor_code: p.vendor_code, nombre: p.nombre, cantidad: ya.get(k) ?? null });
        }
      }
      this.captura.set([...filas.values()].sort((a, b) => a.warehouse_code.localeCompare(b.warehouse_code) || a.nombre.localeCompare(b.nombre, 'es')));
    } finally {
      this.cargandoCaptura.set(false);
    }
  }

  async guardarCaptura(i: IncentivoConResultado): Promise<void> {
    const d = this.datos();
    if (!d) return;
    const items = this.captura().filter((c) => c.cantidad !== null).map((c) => ({ warehouse_code: c.warehouse_code, vendor_code: c.vendor_code, cantidad: Number(c.cantidad) }));
    if (!items.length) return;
    this.trabajando.set(true);
    try {
      const r = await firstValueFrom(this.api.guardarCapturas(i.id, d.semana.lunes, items));
      this.toast.add({ severity: 'success', summary: 'Captura guardada', detail: `${r.guardadas} vendedores` });
      this.res.reload();
      this.abierto.set(null);
    } catch (e: unknown) {
      this.toast.add({ severity: 'error', summary: 'No se guardó', detail: this.mensaje(e) });
    } finally {
      this.trabajando.set(false);
    }
  }

  // ── alta / edición ──
  readonly form = signal<FormIncentivo | null>(null);
  readonly errorForm = signal<string | null>(null);
  readonly buscarProd = signal('');
  readonly prod$ = new Subject<string>();
  readonly productosEncontrados = toSignal(
    this.prod$.pipe(
      debounceTime(250), distinctUntilChanged(),
      switchMap((q) => (q.trim().length < 2 ? of([]) : this.catalogo.listProducts({ search: q, pageSize: 15, active: true }).pipe(
        map((r) => (r.data ?? []).filter((p) => !!p.sku).map((p) => ({ sku: p.sku as string, nombre: p.nombre }))),
        catchError(() => of([])),
      ))),
    ),
    { initialValue: [] as Array<{ sku: string; nombre: string }> },
  );

  nuevo(): void {
    this.errorForm.set(null);
    this.buscarProd.set('');
    this.form.set({ id: null, nombre: '', tipo: 'por_caja', pago: null, base_monto: null, completo: false, productos: [],
      desde: new Date(), hasta: null, canales: ['preventa', 'ruta', 'mayoreo'], sucursales: [] });
  }

  editar(i: IncentivoConResultado): void {
    this.errorForm.set(null);
    this.buscarProd.set('');
    this.form.set({ id: i.id, nombre: i.nombre, tipo: i.tipo, pago: i.pago, base_monto: i.base_monto, completo: i.redondeo === 'completo',
      productos: [...i.productos], desde: aFecha(i.vigencia_desde), hasta: aFecha(i.vigencia_hasta), canales: [...i.canales], sucursales: i.warehouse_codes ?? [] });
  }

  agregarProducto(p: { sku: string; nombre: string }): void {
    const f = this.form();
    if (!f || f.productos.some((x) => x.sku === p.sku)) return;
    this.form.set({ ...f, productos: [...f.productos, p] });
  }

  quitarProducto(sku: string): void {
    const f = this.form();
    if (f) this.form.set({ ...f, productos: f.productos.filter((p) => p.sku !== sku) });
  }

  async guardar(): Promise<void> {
    const f = this.form();
    if (!f || this.trabajando()) return;
    const dto = dtoDeForm(f);
    if (typeof dto === 'string') { this.errorForm.set(dto); return; }
    this.trabajando.set(true);
    this.errorForm.set(null);
    try {
      if (f.id) await firstValueFrom(this.api.editarIncentivo(f.id, dto));
      else await firstValueFrom(this.api.crearIncentivo(dto));
      this.form.set(null);
      this.abierto.set(null);
      this.toast.add({ severity: 'success', summary: f.id ? 'Incentivo actualizado' : 'Incentivo creado' });
      this.res.reload();
    } catch (e: unknown) {
      this.errorForm.set(this.mensaje(e));
    } finally {
      this.trabajando.set(false);
    }
  }

  /** Terminar = cerrar la vigencia ayer; lo ya ganado se conserva. */
  terminar(i: IncentivoConResultado): void {
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
    const ayer = new Date(Date.parse(`${hoy}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const borrar = i.vigencia_desde > ayer;
    this.confirm.confirm({
      header: 'Terminar el incentivo',
      message: borrar ? 'Empieza hoy o después: se quita sin dejar pagos.' : 'Termina ayer: deja de acumular desde hoy y lo ganado se conserva.',
      acceptLabel: 'Terminar', rejectLabel: 'Cancelar', acceptButtonStyleClass: 'p-button-danger',
      accept: async () => {
        this.trabajando.set(true);
        try {
          if (borrar) await firstValueFrom(this.api.borrarIncentivo(i.id));
          else await firstValueFrom(this.api.editarIncentivo(i.id, { vigencia_hasta: ayer }));
          this.abierto.set(null);
          this.toast.add({ severity: 'success', summary: 'Incentivo terminado' });
          this.res.reload();
        } catch (e: unknown) {
          this.toast.add({ severity: 'error', summary: 'No se pudo terminar', detail: this.mensaje(e) });
        } finally {
          this.trabajando.set(false);
        }
      },
    });
  }

  private mensaje(e: unknown): string {
    const m = (e as { error?: { message?: string | string[] } })?.error?.message;
    return Array.isArray(m) ? m.join(' · ') : m || 'Intenta de nuevo.';
  }
}
