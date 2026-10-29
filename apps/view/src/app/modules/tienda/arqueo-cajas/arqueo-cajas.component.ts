import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { DENOMINACIONES_MXN, type Denominacion } from '@megadulces/contracts';
import {
  conceptoRetiroLabel,
  type ArqueoCajasConteo, type ArqueoCajasResp, type ArqueoCajasSucursal, type ArqueoCajasTurno,
} from '@megadulces/contracts/http/arqueo-cajas';
import { ArqueoService } from '../arqueo.service';
import { imprimirTicket } from '../ticket-arqueo';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';

type Sev = 'success' | 'warn' | 'danger' | 'secondary' | 'info';
interface Estado { sev: Sev; txt: string; }

const MEDIOS: Record<string, string> = {
  tarjeta: 'Tarjeta', transferencia: 'Transferencia', retiros: 'Retiros', creditos: 'Créditos', cheques: 'Cheques',
};

/**
 * [SM.48] «Sucursales y sus cajas» — reemplaza «Arqueos recientes» para quien VALIDA.
 *
 * Por sucursal, cada caja con sus turnos de Kepler; en cada turno, sus retiros y el
 * cajón, con dos revisiones (retiros contra Kepler · retiros + cajón contra el
 * esperado) y el desglose pieza por pieza de cada arqueo, con su reimpresion. Muestra el esperado: la
 * cajera NO la ve (el arqueo es ciego) y el servidor lo exige (RECONCILIATION_VER).
 *
 * Responsiva: en angosto la lista de sucursales pasa a un selector arriba, los turnos
 * se apilan y el desglose se desliza a lo ancho con la columna de denominación fija.
 *
 * ⚠️ NO PONER ACENTOS GRAVES en los comentarios del template ni de los estilos.
 */
@Component({
  selector: 'app-arqueo-cajas',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePickerModule, SelectModule, TagModule, LoadStateComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-head">
      <h3 class="ac-title">Sucursales y sus cajas</h3>
      <span class="ac-sp"></span>
      <p-datepicker [ngModel]="fechaDate()" (ngModelChange)="elegirFecha($event)" dateFormat="dd/mm/yy" [maxDate]="hoy"
                    [showIcon]="true" appendTo="body" styleClass="ac-fecha" inputId="ac-fecha" ariaLabel="Fecha" />
      <p-select [options]="filtros" [ngModel]="filtro()" (ngModelChange)="filtro.set($event)" optionLabel="label" optionValue="value"
                styleClass="ac-filtro" appendTo="body" ariaLabel="Qué cajas mostrar" />
      <p-button type="button" icon="pi pi-refresh" [text]="true" size="small" ariaLabel="Actualizar" (click)="cargar()" [disabled]="cargando()" />
    </div>
    @if (consultado(); as c) { <p class="ac-edad">Consultado a las {{ c }}</p> }

    <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!sucursales().length" [skeletonRows]="6"
                    emptyIcon="pi-inbox" emptyTitle="Sin turnos ni conteos ese día"
                    emptyHint="Kepler no abrió cajas en tus sucursales en esa fecha, y nadie capturó arqueos." (retry)="cargar()">
      <div class="ac-grid">
        <!-- Maestro: en ancho, la lista; en angosto, un selector (la lista se oculta por CSS). -->
        <nav class="ac-sucs" aria-label="Sucursales">
          @for (s of sucursales(); track s.warehouse_code) {
            <button type="button" class="ac-suc" [class.on]="s.warehouse_code === activa()" (click)="activa.set(s.warehouse_code)"
                    [attr.aria-current]="s.warehouse_code === activa() ? 'true' : null">
              <span class="ac-suc-n">{{ s.warehouse_code | sucursal }}</span>
              <p-tag [value]="resumenSuc(s).tag.txt" [severity]="resumenSuc(s).tag.sev" styleClass="ac-tag" />
              <span class="ac-suc-m">{{ resumenSuc(s).linea }}</span>
            </button>
          }
        </nav>
        <p-select class="ac-suc-sel" [options]="opcionesSuc()" [ngModel]="activa()" (ngModelChange)="activa.set($event)"
                  optionLabel="label" optionValue="value" appendTo="body" ariaLabel="Sucursal" styleClass="ac-suc-sel-in" />

        <section class="ac-det" aria-live="polite">
          @if (sucActiva(); as s) {
            <p class="ac-sum">
              <span>Kepler registró <b>{{ money(totalSuc(s).kepler) }}</b> en retiros</span>
              <span>se contaron <b>{{ money(totalSuc(s).contados) }}</b></span>
              @if (totalSuc(s).contados - totalSuc(s).kepler; as d) {
                <span [class.ac-mal]="d < 0">{{ d < 0 ? 'faltan por contar' : 'contado de más' }} <b>{{ money(abs(d)) }}</b></span>
              }
            </p>
            <!-- Lo que salio de las cajas ese dia, por concepto (pagos a proveedor, nomina...).
                 Todo eso es retiro y cuenta en el cuadre de su turno; aqui solo se agrupa. -->
            @if (porConcepto(retirosDe(s)); as cs) {
              @if (cs.length) {
                <p class="ac-conc-suc"><span class="ac-lbl">Salidas por concepto</span>
                  @for (c of cs; track c.label) { <span class="ac-chip">{{ c.label }} <b class="ac-num">{{ money(c.total) }}</b></span> }
                </p>
              }
            }

            @for (cj of cajasDe(s); track cj.caja) {
              <!-- Todo MINIMIZADO (pedido de la operacion): la caja es su renglon; un clic abre sus
                   turnos, y el desglose de cada turno se abre aparte. El renglon dice su estado. -->
              <article class="ac-caja">
                <button type="button" class="ac-caja-h" (click)="alternarCaja(s, cj.caja)"
                        [attr.aria-expanded]="cajaAbierta(s, cj.caja)">
                  <i class="pi" [class.pi-chevron-right]="!cajaAbierta(s, cj.caja)" [class.pi-chevron-down]="cajaAbierta(s, cj.caja)" aria-hidden="true"></i>
                  <span class="ac-caja-n">Caja {{ cj.caja }}</span>
                  <span class="ac-caja-m">{{ cj.turnos.length }} turno(s) · retiros contados {{ money(cj.contados) }} de {{ money(cj.kepler) }}</span>
                  <p-tag [value]="cj.estado.txt" [severity]="cj.estado.sev" styleClass="ac-tag ac-caja-tag" />
                </button>
                @if (cajaAbierta(s, cj.caja)) {
                @for (t of cj.turnos; track t.folio) {
                  <div class="ac-turno">
                    <div class="ac-t-id">
                      <span class="ac-num">#{{ t.folio }}</span>
                      <span class="ac-sub">{{ hm(t.hora_apertura) }}–{{ t.hora_cierre ? hm(t.hora_cierre) : 'abierta' }}</span>
                    </div>
                    <div class="ac-t-cajera">
                      <span class="ac-nombre">{{ t.cajero_nombre ? nombre(t.cajero_nombre) : 'Sin nombre en Kepler' }}</span>
                      <span class="ac-sub ac-num">{{ t.cajero_code || '—' }}</span>
                    </div>
                    <div class="ac-t-est">
                      <span class="ac-lbl">Retiros</span>
                      <p-tag [value]="estadoRetiros(t).txt" [severity]="estadoRetiros(t).sev" styleClass="ac-tag" />
                      @if (t.retiros_contados || t.retirado_kepler) {
                        <span class="ac-sub"><b class="ac-num">{{ money(t.retiros_contados) }}</b> de <b class="ac-num">{{ money(t.retirado_kepler) }}</b> que registró Kepler</span>
                        @if (t.retiros.length) {
                          <span class="ac-sub ac-conc">@for (c of porConcepto(t.retiros); track c.label; let last = $last) { {{ c.label }} {{ money(c.total) }}@if (!last) { · } }</span>
                        }
                      }
                    </div>
                    <div class="ac-t-est">
                      <span class="ac-lbl">Cuadre del turno</span>
                      <p-tag [value]="estadoCuadre(t).txt" [severity]="estadoCuadre(t).sev" styleClass="ac-tag" />
                      <span class="ac-sub">{{ explicaCuadre(t) }}</span>
                    </div>
                    @if (arqueosDe(t).length) {
                      <p-button type="button" [text]="true" size="small" styleClass="ac-tog"
                                [label]="abierto(s, t) ? 'Ocultar desglose' : 'Ver desglose (' + arqueosDe(t).length + ')'"
                                [icon]="abierto(s, t) ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
                                [attr.aria-expanded]="abierto(s, t)" (click)="alternar(s, t)" />
                    }
                  </div>
                  @if (abierto(s, t) && arqueosDe(t).length) {
                    <div class="ac-mx-wrap">
                      <table class="ac-mx">
                        <thead>
                          <tr>
                            <th scope="col" class="ac-fix">Denominación</th>
                            @for (a of arqueosDe(t); track a.id) {
                              <th scope="col" class="ac-r">
                                <span class="ac-mx-t">{{ titulo(a, arqueosDe(t)) }}</span>
                                <span class="ac-sub ac-num">{{ hm(a.hora) }} · {{ a.usuario_nombre ? nombre(a.usuario_nombre) : (a.usuario || '—') }}</span>
                                <!-- Sin boton de validar (pedido de la operacion, 2026-10-28: se usaba en 19 de
                                     730 arqueos en 30 dias). Lo ya validado se sigue diciendo. -->
                                <span class="ac-mx-acc">
                                  @if (a.validado_at) {
                                    <span class="ac-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> {{ a.validado_por || 'validado' }}</span>
                                  }
                                  <p-button type="button" icon="pi pi-print" [text]="true" size="small" [ariaLabel]="'Reimprimir ' + titulo(a, arqueosDe(t))" (click)="reimprimir(s, t, a)" />
                                </span>
                              </th>
                            }
                            <th scope="col" class="ac-r ac-tot">Total del turno</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (fam of familias; track fam.key) {
                            @if (denomsUsadas(t, fam.key).length) {
                              <tr class="ac-fam"><th scope="rowgroup" class="ac-fix" [attr.colspan]="arqueosDe(t).length + 2">{{ fam.label }}</th></tr>
                              @for (d of denomsUsadas(t, fam.key); track d.key) {
                                <tr>
                                  <th scope="row" class="ac-fix ac-num">{{ d.label }}</th>
                                  @for (a of arqueosDe(t); track a.id) {
                                    <td class="ac-r">
                                      @if (piezas(a, d); as n) { <span class="ac-num">× {{ n }}</span> <span class="ac-imp">{{ money(n * d.valor) }}</span> }
                                      @else { <span class="ac-vacio">—</span> }
                                    </td>
                                  }
                                  <td class="ac-r ac-tot"><span class="ac-num">× {{ piezasTurno(t, d) }}</span> <span class="ac-imp">{{ money(piezasTurno(t, d) * d.valor) }}</span></td>
                                </tr>
                              }
                              <tr class="ac-subt">
                                <th scope="row" class="ac-fix">Total {{ fam.label.toLowerCase() }}</th>
                                @for (a of arqueosDe(t); track a.id) {
                                  <td class="ac-r"><span class="ac-num">{{ money(sumaFam(a, fam.key)) }}</span> <span class="ac-imp">{{ pzFam(a, fam.key) }} pzas</span></td>
                                }
                                <td class="ac-r ac-tot"><span class="ac-num">{{ money(sumaFamTurno(t, fam.key)) }}</span></td>
                              </tr>
                            }
                          }
                          <tr class="ac-total">
                            <th scope="row" class="ac-fix">Total</th>
                            @for (a of arqueosDe(t); track a.id) { <td class="ac-r ac-num">{{ money(a.total) }}</td> }
                            <td class="ac-r ac-num ac-tot">{{ money(totalTurno(t)) }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  }
                }
                }
              </article>
            } @empty {
              <p class="ac-nada">{{ filtro() === 'pend' ? 'Nada por revisar en esta sucursal.' : 'Esta sucursal no tuvo turnos ese día.' }}</p>
            }

            @if (s.sin_turno.length) {
              <h4 class="ac-sec">Conteos sin turno de Kepler</h4>
              <p class="ac-sub ac-sec-nota">Ninguno de sus turnos estaba abierto en esa caja a esa hora. Se muestran aparte para no pegarlos al turno equivocado.</p>
              <ul class="ac-lista">
                @for (a of s.sin_turno; track a.id) {
                  <li class="ac-li">
                    <span>{{ etiquetaTipo(a) }} · caja {{ a.caja }}</span><span class="ac-num">{{ hm(a.hora) }}</span>
                    <span class="ac-sub">{{ a.usuario_nombre ? nombre(a.usuario_nombre) : (a.usuario || '—') }}</span>
                    <b class="ac-num ac-r">{{ money(a.total) }}</b>
                    <p-button type="button" icon="pi pi-print" [text]="true" size="small" [ariaLabel]="'Reimprimir ' + etiquetaTipo(a)" (click)="reimprimir(s, null, a)" />
                  </li>
                }
              </ul>
            }

            <h4 class="ac-sec">Rutas y conteos de efectivo (sin caja)</h4>
            @if (s.sin_caja.length) {
              <ul class="ac-lista">
                @for (a of s.sin_caja; track a.id) {
                  <li class="ac-li">
                    <span>{{ etiquetaTipo(a) }}</span><span class="ac-num">{{ hm(a.hora) }}</span>
                    <span class="ac-sub">{{ a.motivo || (a.usuario_nombre ? nombre(a.usuario_nombre) : (a.usuario || '—')) }}</span>
                    <b class="ac-num ac-r">{{ money(a.total) }}</b>
                    <p-button type="button" icon="pi pi-print" [text]="true" size="small" [ariaLabel]="'Reimprimir ' + etiquetaTipo(a)" (click)="reimprimir(s, null, a)" />
                  </li>
                }
              </ul>
              <p class="ac-sub ac-sec-nota">No suman a ninguna caja ni a ningún cuadre.</p>
            } @else {
              <p class="ac-sub">Ninguno ese día.</p>
            }
          }
        </section>
      </div>
    </app-load-state>
  `,
  styles: [`
    :host { display: block; }
    .ac-head { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem .6rem; margin: 0 0 .2rem; }
    .ac-title { margin: 0; font-size: var(--fs-h3); font-weight: 700; }
    .ac-sp { flex: 1; }
    .ac-edad { margin: 0 0 .7rem; font-size: var(--fs-micro); color: var(--text-muted); }
    :host ::ng-deep .ac-fecha input { width: 8.5rem; }
    :host ::ng-deep .ac-filtro { min-width: 11rem; }

    .ac-grid { display: grid; grid-template-columns: minmax(0, 16rem) minmax(0, 1fr); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--card-bg); }
    .ac-sucs { border-right: 1px solid var(--border-color); }
    .ac-suc-sel { display: none; }
    .ac-suc { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .15rem .5rem; width: 100%; text-align: left; padding: .6rem .8rem;
              border: 0; border-bottom: 1px solid var(--border-color); background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .ac-suc:hover { background: var(--overlay-hover); }
    .ac-suc.on { background: var(--overlay-selected); box-shadow: inset 3px 0 0 var(--action); }
    .ac-suc:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    .ac-suc-n { font-weight: 700; }
    .ac-suc-m { grid-column: 1 / -1; font-size: var(--fs-xs); color: var(--text-muted); }

    .ac-det { padding: .8rem 1rem 1rem; min-width: 0; }
    .ac-sum { display: flex; flex-wrap: wrap; gap: .3rem 1.2rem; margin: 0 0 .8rem; font-size: var(--fs-xs); color: var(--text-muted); }
    .ac-sum b { color: var(--text-main); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
    .ac-sum .ac-mal b { color: var(--bad-fg); }
    .ac-conc-suc { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .4rem; margin: -.4rem 0 .8rem; font-size: var(--fs-xs); }
    .ac-chip { display: inline-flex; gap: .3rem; padding: .15rem .5rem; border: 1px solid var(--border-color); border-radius: var(--r-pill); color: var(--text-muted); }
    .ac-chip b { color: var(--text-main); }
    .ac-conc { color: var(--text-main); }

    .ac-caja { border: 1px solid var(--border-color); border-radius: var(--r-md); margin: 0 0 .8rem; overflow: hidden; }
    .ac-caja-h { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .7rem; padding: .55rem .8rem; background: var(--overlay-hover);
                 width: 100%; border: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
    .ac-caja-h:hover { background: var(--overlay-selected); }
    .ac-caja-h:focus-visible { outline: 2px solid var(--action); outline-offset: -2px; }
    :host ::ng-deep .ac-caja-tag { margin-left: auto; }
    .ac-caja-n { font-weight: 700; }
    .ac-caja-m { font-size: var(--fs-xs); color: var(--text-muted); }

    .ac-turno { display: grid; grid-template-columns: 5.5rem minmax(0, 1.1fr) minmax(0, 1.3fr) minmax(0, 1.3fr) auto; gap: .4rem .9rem;
                align-items: start; padding: .6rem .8rem; border-top: 1px solid var(--border-color); }
    .ac-t-id, .ac-t-cajera, .ac-t-est { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
    .ac-nombre { font-weight: 600; }
    .ac-lbl { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; color: var(--text-muted); }
    .ac-sub { font-size: var(--fs-xs); color: var(--text-muted); }
    .ac-num { font-variant-numeric: tabular-nums; }
    :host ::ng-deep .ac-tag { align-self: flex-start; white-space: normal; }
    :host ::ng-deep .ac-tog { align-self: center; white-space: nowrap; }

    .ac-mx-wrap { overflow-x: auto; border-top: 1px solid var(--border-color); background: var(--layout-bg); padding: .5rem; }
    .ac-mx { border-collapse: separate; border-spacing: 0; min-width: 100%; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ac-mx th, .ac-mx td { padding: .35rem .7rem; font-size: var(--fs-xs); border-bottom: 1px solid var(--border-color); white-space: nowrap; text-align: left; font-weight: 400; }
    .ac-mx thead th { vertical-align: bottom; font-weight: 700; }
    .ac-mx .ac-r { text-align: right; }
    .ac-mx-t { display: block; font-size: var(--fs-xs); font-weight: 700; color: var(--text-main); }
    .ac-mx-acc { display: flex; justify-content: flex-end; align-items: center; gap: .2rem; }
    .ac-ok { font-size: var(--fs-micro); color: var(--ok-fg); font-weight: 600; }
    .ac-fix { position: sticky; left: 0; z-index: 1; background: var(--card-bg); font-weight: 600; }
    .ac-fam th { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; color: var(--text-muted); background: var(--overlay-hover); }
    .ac-subt th, .ac-subt td { background: var(--overlay-hover); font-weight: 700; }
    .ac-total th, .ac-total td { font-weight: 800; font-size: var(--fs-sm); border-bottom: 0; }
    .ac-tot { background: var(--overlay-selected); }
    .ac-imp { color: var(--text-muted); font-size: var(--fs-micro); margin-left: .4rem; }
    .ac-vacio { color: var(--text-faint); }

    .ac-sec { margin: 1.1rem 0 .3rem; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; color: var(--text-muted); }
    .ac-sec-nota { margin: 0 0 .4rem; }
    .ac-lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-sm); }
    .ac-li { display: grid; grid-template-columns: minmax(0, 1.2fr) 3.5rem minmax(0, 1.5fr) 7rem auto; gap: .3rem .8rem; align-items: center;
             padding: .35rem .7rem; border-bottom: 1px solid var(--border-color); font-size: var(--fs-xs); }
    .ac-li:last-child { border-bottom: 0; }
    .ac-r { text-align: right; }
    .ac-nada { color: var(--text-muted); font-size: var(--fs-sm); }

    /* Responsivo: tablet (lista arriba como selector) y telefono (turno apilado). */
    @media (max-width: 64rem) {
      .ac-grid { grid-template-columns: 1fr; }
      .ac-sucs { display: none; }
      .ac-suc-sel { display: block; padding: .6rem .8rem 0; }
      :host ::ng-deep .ac-suc-sel-in { width: 100%; }
      .ac-turno { grid-template-columns: 5.5rem minmax(0, 1fr) minmax(0, 1fr); }
      .ac-turno > :nth-child(3) { grid-column: 1 / 3; }
      :host ::ng-deep .ac-tog { grid-column: 1 / -1; justify-self: start; }
    }
    @media (max-width: 40rem) {
      .ac-det { padding: .6rem; }
      .ac-turno { grid-template-columns: 1fr 1fr; }
      .ac-turno > :nth-child(3), .ac-turno > :nth-child(4) { grid-column: 1 / -1; }
      .ac-li { grid-template-columns: minmax(0, 1fr) auto auto; }
      .ac-li > .ac-sub { grid-column: 1 / -1; order: 5; }
      :host ::ng-deep .ac-fecha input { width: 7.5rem; }
    }
  `],
})
export class ArqueoCajasComponent {
  private readonly svc = inject(ArqueoService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** El padre lo incrementa al guardar un arqueo: la vista se vuelve a pedir. */
  readonly refresco = input(0);

  readonly hoy = new Date();
  readonly fecha = signal(this.ymd(new Date()));
  readonly fechaDate = computed(() => { const [y, m, d] = this.fecha().split('-').map(Number); return new Date(y, m - 1, d); });
  readonly filtros = [
    { label: 'Todas las cajas', value: 'todo' },
    { label: 'Solo con algo por revisar', value: 'pend' },
  ];
  readonly filtro = signal<'todo' | 'pend'>('todo');
  readonly familias = [{ key: 'billete', label: 'Billetes' }, { key: 'moneda', label: 'Monedas' }];

  readonly data = signal<ArqueoCajasResp | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly consultado = signal<string | null>(null);
  readonly activa = signal<string | null>(null);
  /** Desgloses que la persona abrió o cerró a mano (llave suc|caja#folio → abierto). */
  private readonly manual = signal<Record<string, boolean>>({});

  readonly sucursales = computed(() => this.data()?.sucursales ?? []);
  readonly sucActiva = computed(() => this.sucursales().find((s) => s.warehouse_code === this.activa()) ?? null);
  readonly opcionesSuc = computed(() => this.sucursales().map((s) => ({
    value: s.warehouse_code, label: this.resumenSuc(s).etiqueta,
  })));

  private readonly recargar = effect(() => {
    this.refresco();
    this.fecha();
    untracked(() => this.cargar());
  });

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.cajas(this.fecha()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.data.set(r);
        this.cargando.set(false);
        this.consultado.set(new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }));
        const codes = r.sucursales.map((s) => s.warehouse_code);
        if (!this.activa() || !codes.includes(this.activa()!)) this.activa.set(codes[0] ?? null);
      },
      error: (e) => {
        this.cargando.set(false);
        this.error.set(e?.error?.message || 'No se pudieron consultar las cajas.');
      },
    });
  }

  elegirFecha(d: Date | null): void {
    if (!d) return;
    this.manual.set({});
    this.cajasAbiertas.set({});
    this.fecha.set(this.ymd(d));
  }

  // ── estados (lo que dice cada etiqueta) ──────────────────────────────────────

  estadoRetiros(t: ArqueoCajasTurno): Estado {
    switch (t.retiros_estado) {
      case 'cuadra': return { sev: 'success', txt: 'Cuadran con Kepler' };
      case 'faltan': return t.retiros_contados === 0
        ? { sev: 'danger', txt: 'Ningún retiro contado' }
        : { sev: 'warn', txt: 'Faltan ' + this.money(-t.retiros_diferencia) + ' por contar' };
      case 'de_mas': return { sev: 'danger', txt: 'Contado de más ' + this.money(t.retiros_diferencia) };
      default: return { sev: 'secondary', txt: 'Sin retiros' };
    }
  }

  estadoCuadre(t: ArqueoCajasTurno): Estado {
    const c = t.cuadre;
    const umbral = this.data()?.umbral ?? 50;
    if (!c.medible || c.diferencia == null) {
      if (c.motivo === 'sin_esperado') return { sev: 'secondary', txt: t.abierto ? 'Turno abierto' : 'Sin esperado de Kepler' };
      return { sev: 'secondary', txt: 'Sin conteo del cajón' };
    }
    if (Math.abs(c.diferencia) < umbral) return { sev: 'success', txt: 'Cuadra' };
    return c.diferencia > 0
      ? { sev: 'danger', txt: 'Faltan ' + this.money(c.diferencia) }
      : { sev: 'warn', txt: 'Sobran ' + this.money(-c.diferencia) };
  }

  /** Q.2: la lectura en llano del cuadre, no solo la etiqueta. */
  explicaCuadre(t: ArqueoCajasTurno): string {
    const c = t.cuadre;
    if (c.contado_total == null) return t.esperado != null ? 'Esperado ' + this.money(t.esperado) : '';
    const base = 'Contado ' + this.money(c.contado_total) + ' de ' + this.money(t.esperado ?? 0) + ' esperados';
    return c.retiros_sin_verificar > 0
      ? base + ', con ' + this.money(c.retiros_sin_verificar) + ' de retiros que nadie contó (se toman de Kepler)'
      : base;
  }

  private porRevisar(t: ArqueoCajasTurno): boolean {
    const umbral = this.data()?.umbral ?? 50;
    return t.retiros_estado === 'faltan' || t.retiros_estado === 'de_mas'
      || (t.cuadre.diferencia != null && Math.abs(t.cuadre.diferencia) >= umbral);
  }

  resumenSuc(s: ArqueoCajasSucursal): { tag: Estado; linea: string; etiqueta: string } {
    const cajas = new Set(s.turnos.map((t) => t.caja)).size;
    const revisar = s.turnos.filter((t) => this.porRevisar(t)).length;
    const hayRetiros = s.turnos.some((t) => t.retiros_contados || t.retirado_kepler);
    const tag: Estado = revisar ? { sev: 'danger', txt: revisar + ' por revisar' }
      : hayRetiros ? { sev: 'success', txt: 'Todo cuadra' } : { sev: 'secondary', txt: 'Sin retiros' };
    const tot = this.totalSuc(s);
    const pend = tot.kepler - tot.contados;
    const linea = cajas + ' cajas · ' + s.turnos.length + ' turnos' + (pend > 0.5 ? ' · ' + this.money(pend) + ' de retiros sin contar' : '');
    return { tag, linea, etiqueta: this.nombreSuc(s.warehouse_code) + ' · ' + tag.txt };
  }

  /**
   * Los retiros agrupados por concepto, de mayor a menor. «Otro» se agrupa como «Otro» (su
   * motivo va en el desglose); un retiro anterior a SM.49 sale como «Sin concepto».
   */
  porConcepto(retiros: ArqueoCajasConteo[]): { label: string; total: number }[] {
    const m = new Map<string, number>();
    for (const r of retiros) {
      const label = r.concepto ? (conceptoRetiroLabel(r.concepto) ?? r.concepto) : 'Sin concepto';
      m.set(label, (m.get(label) ?? 0) + Number(r.total || 0));
    }
    return [...m.entries()].map(([label, total]) => ({ label, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);
  }

  retirosDe(s: ArqueoCajasSucursal): ArqueoCajasConteo[] { return s.turnos.flatMap((t) => t.retiros); }

  totalSuc(s: ArqueoCajasSucursal): { kepler: number; contados: number } {
    return s.turnos.reduce((a, t) => ({ kepler: a.kepler + t.retirado_kepler, contados: a.contados + t.retiros_contados }), { kepler: 0, contados: 0 });
  }

  cajasDe(s: ArqueoCajasSucursal): Array<{ caja: string; turnos: ArqueoCajasTurno[]; kepler: number; contados: number; estado: Estado }> {
    const m = new Map<string, ArqueoCajasTurno[]>();
    for (const t of s.turnos) {
      if (this.filtro() === 'pend' && !this.porRevisar(t)) continue;
      if (!m.has(t.caja)) m.set(t.caja, []);
      m.get(t.caja)!.push(t);
    }
    return [...m.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))
      .map(([caja, turnos]) => {
        const todos = s.turnos.filter((t) => t.caja === caja);
        const revisar = todos.filter((t) => this.porRevisar(t)).length;
        const hayRetiros = todos.some((t) => t.retiros_contados || t.retirado_kepler);
        return {
          caja, turnos,
          kepler: todos.reduce((x, t) => x + t.retirado_kepler, 0),
          contados: todos.reduce((x, t) => x + t.retiros_contados, 0),
          estado: revisar ? { sev: 'danger' as Sev, txt: revisar + ' por revisar' }
            : hayRetiros ? { sev: 'success' as Sev, txt: 'Todo cuadra' } : { sev: 'secondary' as Sev, txt: 'Sin retiros' },
        };
      });
  }

  // ── desglose ────────────────────────────────────────────────────────────────

  arqueosDe(t: ArqueoCajasTurno): ArqueoCajasConteo[] { return [...t.retiros, ...t.relevos, ...t.cierres]; }

  /** Cajas abiertas (llave suc|caja). Todo nace MINIMIZADO: se abre con un clic. */
  private readonly cajasAbiertas = signal<Record<string, boolean>>({});
  cajaAbierta(s: ArqueoCajasSucursal, caja: string): boolean { return !!this.cajasAbiertas()[s.warehouse_code + '|' + caja]; }
  alternarCaja(s: ArqueoCajasSucursal, caja: string): void {
    const k = s.warehouse_code + '|' + caja;
    this.cajasAbiertas.update((m) => ({ ...m, [k]: !m[k] }));
  }

  /** El desglose de un turno nace cerrado; se abre con «Ver desglose». */
  abierto(s: ArqueoCajasSucursal, t: ArqueoCajasTurno): boolean {
    return !!this.manual()[this.llave(s, t)];
  }

  alternar(s: ArqueoCajasSucursal, t: ArqueoCajasTurno): void {
    const k = this.llave(s, t);
    const actual = this.abierto(s, t);
    this.manual.update((m) => ({ ...m, [k]: !actual }));
  }

  denomsUsadas(t: ArqueoCajasTurno, familia: string): readonly Denominacion[] {
    const as = this.arqueosDe(t);
    return DENOMINACIONES_MXN.filter((d) => d.familia === familia && as.some((a) => this.piezas(a, d) > 0));
  }

  piezas(a: ArqueoCajasConteo, d: Denominacion): number { return Number(a.denominations?.[d.key]) || 0; }
  piezasTurno(t: ArqueoCajasTurno, d: Denominacion): number { return this.arqueosDe(t).reduce((s, a) => s + this.piezas(a, d), 0); }
  sumaFam(a: ArqueoCajasConteo, fam: string): number {
    return DENOMINACIONES_MXN.filter((d) => d.familia === fam).reduce((s, d) => s + this.piezas(a, d) * d.valor, 0);
  }
  pzFam(a: ArqueoCajasConteo, fam: string): number {
    return DENOMINACIONES_MXN.filter((d) => d.familia === fam).reduce((s, d) => s + this.piezas(a, d), 0);
  }
  sumaFamTurno(t: ArqueoCajasTurno, fam: string): number { return this.arqueosDe(t).reduce((s, a) => s + this.sumaFam(a, fam), 0); }
  totalTurno(t: ArqueoCajasTurno): number { return this.arqueosDe(t).reduce((s, a) => s + Number(a.total || 0), 0); }

  titulo(a: ArqueoCajasConteo, todos: ArqueoCajasConteo[]): string {
    if (a.tipo === 'retiro') {
      // [SM.49] «Retiro 2 · Pago a proveedor». Los retiros viejos no tienen concepto.
      const c = conceptoRetiroLabel(a.concepto, a.motivo);
      return 'Retiro ' + (todos.filter((x) => x.tipo === 'retiro').indexOf(a) + 1) + (c ? ' · ' + c : '');
    }
    if (a.tipo === 'relevo') return 'Relevo';
    return 'Cierre (cajón)';
  }

  etiquetaTipo(a: ArqueoCajasConteo): string {
    if (a.tipo === 'rd' || a.tipo === 'rv') return a.tipo.toUpperCase() + (a.route_code ? ' · ruta ' + a.route_code : '');
    if (a.tipo === 'sin_caja') return 'Conteo de efectivo';
    if (a.tipo === 'retiro') return 'Retiro';
    if (a.tipo === 'relevo') return 'Relevo';
    return 'Cierre';
  }

  // ── acciones ────────────────────────────────────────────────────────────────

  reimprimir(s: ArqueoCajasSucursal, t: ArqueoCajasTurno | null, a: ArqueoCajasConteo): void {
    const medios = Object.entries(a.medios || {})
      .map(([k, v]) => ({ label: MEDIOS[k] || k, monto: Number(v) || 0 }))
      .filter((m) => m.monto > 0);
    const ok = imprimirTicket({
      sucursal: this.nombreSuc(s.warehouse_code),
      caja: a.caja,
      ruta: a.route_code,
      fecha: this.data()?.fecha ?? this.fecha(),
      folio: t?.folio ?? a.cash_cut_folio,
      cajera: a.usuario_nombre || a.usuario || '',
      hora_apertura: t?.hora_apertura ?? null,
      hora_cierre: t?.hora_cierre ?? null,
      denominaciones: DENOMINACIONES_MXN.filter((d) => this.piezas(a, d) > 0).map((d) => ({
        denominacion: d.valor, cantidad: this.piezas(a, d), subtotal: Math.round(this.piezas(a, d) * d.valor * 100) / 100,
        familia: d.familia, label: d.label,
      })),
      total_contado: Number(a.total) || 0,
      medios_declarados: medios,
      tipo: a.tipo, arqueo_id: a.id, incidencia_tipo: a.incidencia_tipo, nota: a.nota, motivo: a.motivo,
      concepto: a.tipo === 'retiro' ? conceptoRetiroLabel(a.concepto, a.motivo) : null,
      capturado_at: a.captured_at, capturado_por: a.usuario,
      validado_por: a.validado_por, validado_at: a.validado_at,
      reimpresion: new Date().toISOString(),
    }, { revela: false }, () => this.avisarImpresion());
    if (!ok) this.avisarImpresion();
  }

  private avisarImpresion(): void {
    this.toast.add({ severity: 'warn', summary: 'No se pudo imprimir el ticket', detail: 'Intenta de nuevo con el botón de imprimir.', life: 8000 });
  }

  // ── formato ─────────────────────────────────────────────────────────────────

  money(n: number | string | null | undefined): string {
    return (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  abs(n: number): number { return Math.abs(n); }
  hm(h: string | null | undefined): string { return h ? String(h).slice(0, 5) : '—'; }
  /** Los nombres llegan en MAYUSCULAS del catalogo de Kepler; se leen mejor como nombre propio. */
  nombre(n: string): string { return n.toLowerCase().replace(/(^|\s)(\S)/g, (_m, sp: string, c: string) => sp + c.toUpperCase()); }
  private nombreSuc(code: string): string { return new SucursalPipe().transform(code); }
  private llave(s: ArqueoCajasSucursal, t: ArqueoCajasTurno): string { return s.warehouse_code + '|' + t.caja + '#' + t.folio; }
  private ymd(d: Date): string {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
}
