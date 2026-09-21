import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { MessageModule } from 'primeng/message';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { CashLedgerService, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja, type TotalesCorte, type IngresoPendiente } from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import {
  DENOMINACIONES, estadoArqueo, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia,
  textoCobertura, sumaDesglose, puedeAutorizarUI, puedeCerrarUI, textoSaldo,
  type DenominacionCapturada, type MotivoBloqueo, type CorteVista,
} from './caja-captura.util';

/**
 * CG.14 — Caja General: la pantalla donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Reemplaza las 6 formas del Access "Control" ("Fichas de Efectivo por Cobranza",
 * "Fichas de Otros Ingresos", "Comprobante de Gasto", "Comprobación de Gasto",
 * "Depósitos al banco") **con los mismos nombres que la gente ya usa**: reestructurar es
 * renombrar y reordenar, no rediseñar.
 *
 * ⚠️ Acá se citaba con acento grave y se cambió a comillas a propósito: este archivo tiene DOS
 * literales de plantilla (`styles` y `template`) y un acento grave suelto en un comentario los
 * cierra. Pasó siete veces en el repo — la séptima, en el comentario CSS de abajo, en esta misma
 * sesión. Comillas dobles en los comentarios de este archivo, siempre.
 *
 * Tres cosas que esta pantalla hace y la de Access no podía:
 *   · El concepto contable de Kepler es un buscador sobre el catálogo vivo, no un número que
 *     hay que saberse. Y es POR SUCURSAL, porque el mismo par tiene nombre distinto por plaza.
 *   · Lo que el motor propone se ve COMO PROPUESTA, con su respaldo. Un campo autorrellenado
 *     que se pinta igual que uno tecleado se acepta sin mirarlo.
 *   · La cobertura del catálogo está SIEMPRE a la vista: "0 conceptos" por carril caído no
 *     puede leerse igual que "esta sucursal no tiene conceptos".
 *
 * La lógica de decisión vive en caja-captura.util.ts (puro, con pruebas unitarias).
 */
@Component({
  selector: 'app-finanzas-caja-general',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, InputNumberModule, TableModule,
    SelectModule, TagModule, DialogModule, AutoCompleteModule, MessageModule, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  /**
   * ⛔ Esta pantalla se pintaba SIN UN SOLO ESTILO. Usaba 19 clases fin-* que no existen en
   * ningún lado del repo: FINANZAS_SHARED_STYLES define 63 clases y ni una empieza con fin-.
   * Nadie lo vio porque nadie abrió la página; la validación visual quedó declarada como pendiente
   * dos veces y el hueco era esto.
   *
   * El shell (página, encabezado, subtítulo) pasa al global surf-*. Lo de acá abajo es lo que sí
   * es propio de una captura de caja —la barra del corte, el formulario, la reja de denominaciones—
   * y vive local con el mismo criterio que cg-* en /finanzas/caja. Se conservan los nombres
   * fin-* en vez de renombrar 19 usos: el arreglo es que EXISTAN, no cómo se llamen.
   */
  styles: [FINANZAS_SHARED_STYLES, `
    .cg-head-actions { display:flex; align-items:center; gap:.5rem; }

    /* La barra del corte: saldo + estado + acción, en una línea que se lee de un vistazo. */
    .fin-corte-bar { display:flex; align-items:center; flex-wrap:wrap; gap:.75rem; margin:.75rem 0 1rem; }
    .fin-saldo { font-weight:600; font-variant-numeric:tabular-nums; }

    .fin-filters { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; margin:1rem 0 .75rem; }
    .fin-filters input, .fin-filters p-select { min-width:11rem; }

    .fin-h2 { font-size:1rem; font-weight:700; margin:1.5rem 0 .5rem; }
    .fin-dim { color:var(--text-muted); font-size:.78rem; }
    .fin-empty { text-align:center; color:var(--text-muted); padding:1.25rem 0; }
    .fin-neg { color:var(--danger-fg, #b42318); }
    .d-block { display:block; }

    /* Formulario de captura. fin-row-col apila cuando el campo necesita su propia explicación
       debajo (el selector de cobro de Kepler), en vez de meterla en la misma línea. */
    .fin-form { display:flex; flex-direction:column; gap:.85rem; }
    .fin-row { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; }
    .fin-row > label { min-width:6.5rem; font-size:.8rem; color:var(--text-muted); }
    .fin-row-col { flex-direction:column; align-items:stretch; gap:.35rem; }
    .fin-row-col > label { min-width:0; }
    .w-full { width:100%; }

    .fin-hint-ok   { color:var(--ok-fg, #067647); font-size:.78rem; }
    .fin-hint-warn { color:var(--warn-fg, #b54708); font-size:.78rem; }

    .fin-details { border:1px solid var(--surface-border, #e5e5e5); border-radius:var(--r-sm,6px); padding:.5rem .75rem; }
    .fin-details > summary { cursor:pointer; font-size:.82rem; }

    /* Reja de denominaciones: fija y ancha para que contar sea teclear en orden, no buscar. */
    .fin-denoms { display:grid; grid-template-columns:repeat(auto-fill, minmax(8.5rem, 1fr)); gap:.5rem; margin-top:.6rem; }
    .fin-denom { display:flex; align-items:center; justify-content:space-between; gap:.4rem;
                 border:1px solid var(--surface-border, #e5e5e5); border-radius:var(--r-sm,6px); padding:.3rem .5rem; }
    .fin-denom .mono { font-variant-numeric:tabular-nums; font-size:.8rem; }

    /* Los motivos de bloqueo van TODOS juntos: que se vea de una vez lo que falta. */
    .fin-blocks { margin:.25rem 0 0; padding-left:1.1rem; color:var(--warn-fg, #b54708); font-size:.8rem; }
  `],
  template: `
    <div class="surf-page in">
      <!-- El shell de página es el GLOBAL (surf-*, styles.css), el mismo que usa /finanzas/caja.
           Antes eran clases fin-* que NO EXISTEN en el repo: la página se pintaba sin un solo
           estilo. Inventar un segundo shell de página es exactamente lo que ADR-056 prohíbe. -->
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja General</h1>
          <p class="surf-page-sub">{{ coberturaTexto() }}</p>
        </div>
        <div class="cg-head-actions">
          <p-button label="Registrar movimiento" icon="pi pi-plus" size="small"
                    (onClick)="abrirCaptura()" [disabled]="!hayConceptos()"></p-button>
        </div>
      </header>

      @if (!hayConceptos() && !cargando()) {
        <p-message severity="warn" styleClass="w-full"
          text="No hay conceptos de Kepler disponibles. No se puede capturar sin cuenta contable — revisá el carril del ODS antes de seguir."></p-message>
      }

      <div class="fin-corte-bar">
        <span class="fin-saldo">{{ textoSaldoUI() }}</span>
        @if (corteAbierto()) {
          <p-tag [value]="'Corte ' + corteAbierto()!.folio" severity="info"></p-tag>
          <p-button label="Cerrar corte" icon="pi pi-lock" size="small" severity="secondary"
                    (onClick)="abrirCierre()"></p-button>
        } @else {
          <p-button label="Abrir corte" icon="pi pi-unlock" size="small" severity="secondary"
                    (onClick)="abrirApertura()"></p-button>
        }
      </div>

      <app-metric-strip [items]="kpis()"></app-metric-strip>

      <div class="fin-filters">
        <input pInputText type="date" [(ngModel)]="from" (ngModelChange)="cargar()" aria-label="Desde" />
        <input pInputText type="date" [(ngModel)]="to" (ngModelChange)="cargar()" aria-label="Hasta" />
        <p-select [options]="tiposFiltro" [(ngModel)]="tipo" (ngModelChange)="cargar()"
                  optionLabel="label" optionValue="value" placeholder="Todos los tipos" [showClear]="true"></p-select>
        <input pInputText [(ngModel)]="search" (keyup.enter)="cargar()" placeholder="Folio, glosa o beneficiario" />
      </div>

      <p-table [value]="rows()" [loading]="cargando()" size="small" styleClass="p-datatable-sm"
               [scrollable]="true" scrollHeight="flex">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Fecha</th><th>Tipo</th><th>Cuenta / Concepto</th>
            <th>Qué pasó</th><th class="ta-r">Monto</th><th>Capturó</th><th>Origen</th>
          </tr>
        </ng-template>
        <ng-template #body let-m>
          <tr>
            <td class="mono">{{ m.folio }}</td>
            <td>{{ dmy(m.fecha) }}</td>
            <td><p-tag [value]="m.tipo" [severity]="sevTipo(m.tipo)"></p-tag></td>
            <td>
              <span class="mono">{{ m.kepler_cuenta }} / {{ m.kepler_concepto }}</span>
              <small class="fin-dim d-block">{{ m.kepler_concepto_nombre }}</small>
            </td>
            <td>{{ m.glosa }}</td>
            <td class="ta-r mono">{{ money(m.monto) }}</td>
            <td>{{ m.created_by_username || '—' }}</td>
            <td>
              @if (m.autofill) {
                <span title="Parte de este movimiento la propuso el sistema">
                  <p-tag value="autorrellenado" severity="info"></p-tag>
                </span>
              } @else { <small class="fin-dim">manual</small> }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="8" class="fin-empty">Sin movimientos en el periodo.</td></tr>
        </ng-template>
      </p-table>

      <h2 class="fin-h2">Cortes</h2>
      <p-table [value]="cortes()" size="small" styleClass="p-datatable-sm">
        <ng-template #header>
          <tr>
            <th>Folio</th><th>Fecha</th><th>Sucursal</th><th>Estado</th>
            <th class="ta-r">Esperado</th><th class="ta-r">Contado</th><th class="ta-r">Diferencia</th>
            <th>Cerró / Autorizó</th><th></th>
          </tr>
        </ng-template>
        <ng-template #body let-c>
          <tr>
            <td class="mono">{{ c.folio }}</td>
            <td>{{ dmy(c.fecha) }}</td>
            <td>{{ c.sucursal }}</td>
            <td><p-tag [value]="c.estado" [severity]="sevEstadoCorte(c.estado)"></p-tag></td>
            <td class="ta-r mono">{{ c.esperado === null ? '—' : money(c.esperado) }}</td>
            <td class="ta-r mono">{{ c.contado === null ? '—' : money(c.contado) }}</td>
            <td class="ta-r mono" [class.fin-neg]="c.diferencia < 0">
              {{ c.diferencia === null ? '—' : money(c.diferencia) }}
            </td>
            <td>
              <small class="fin-dim">{{ c.closed_by_username || '—' }} / {{ c.authorized_by_username || '—' }}</small>
            </td>
            <td>
              @if (c.estado === 'cerrado') {
                <p-button label="Autorizar" size="small" severity="secondary"
                          [disabled]="!gateAutorizar(c).ok" [title]="gateAutorizar(c).texto"
                          (onClick)="autorizar(c)"></p-button>
              } @else {
                <small class="fin-dim">{{ gateAutorizar(c).texto }}</small>
              }
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="9" class="fin-empty">Sin cortes en el periodo.</td></tr>
        </ng-template>
      </p-table>
    </div>

    <p-dialog [(visible)]="capturaAbierta" [modal]="true" [style]="{ width: '46rem' }"
              header="Registrar movimiento de caja" [draggable]="false">
      <div class="fin-form">
        <div class="fin-row">
          <label>Tipo</label>
          <p-select [options]="tiposCaptura" [(ngModel)]="f.tipo" optionLabel="label" optionValue="value"
                    (ngModelChange)="pedirPropuesta()"></p-select>
          <label>Fecha</label>
          <input pInputText type="date" [(ngModel)]="f.fecha" />
          <label>Sucursal</label>
          <input pInputText [(ngModel)]="f.sucursal" (ngModelChange)="onSucursal()" placeholder="00" />
        </div>

        <!-- ⭐ CG.19 Capa 1 — el ingreso se ELIGE, no se teclea. El monto viaja de Kepler.
             Sólo para ingresos: un gasto o un depósito no tienen un cobro del ERP detrás. -->
        @if (f.tipo === 'ingreso') {
          <div class="fin-row fin-row-col">
            <label>Entrega contra un cobro de Kepler</label>
            <p-autocomplete [(ngModel)]="cobroSel" [suggestions]="cobros()"
                            (completeMethod)="buscarCobros($event)" (onSelect)="elegirCobro($event)"
                            (onClear)="soltarCobro()" optionLabel="label" [delay]="250"
                            [minQueryLength]="0" [showClear]="true" appendTo="body" styleClass="w-full"
                            placeholder="Buscá por cliente, folio o ruta — o dejalo vacío y capturá a mano"></p-autocomplete>
            @if (cobroElegido(); as c) {
              <small class="fin-hint-ok">
                Tomado de Kepler: {{ c.folio }} · {{ c.cliente_nombre || c.cliente_code }} ·
                {{ money(c.monto) }}<span *ngIf="c.tipo_cuenta"> · {{ c.tipo_cuenta }}</span>.
                El monto no se edita: lo pone el documento.
              </small>
            } @else {
              <small class="fin-dim">
                Sin cobro elegido: esto se registra como captura manual. Está bien —
                cerca de la mitad del ingreso todavía no tiene un documento en el ERP— pero queda
                marcado así en la cobertura.
              </small>
            }
          </div>
        }

        <div class="fin-row">
          <label>Beneficiario</label>
          <input pInputText [(ngModel)]="f.beneficiario" (blur)="pedirPropuesta()" class="w-full"
                 [readonly]="!!cobroElegido()" />
        </div>

        <div class="fin-row">
          <label>Cuenta y concepto de Kepler</label>
          <p-autocomplete [(ngModel)]="conceptoSel" [suggestions]="conceptos()"
                          (completeMethod)="buscarConceptos($event)" (onSelect)="elegirConcepto($event)"
                          optionLabel="label" [delay]="250" [minQueryLength]="2" [showClear]="true"
                          placeholder="Buscá por nombre, cuenta o código" appendTo="body"
                          styleClass="w-full"></p-autocomplete>
          <small [class]="etiquetaConcepto().tono === 'propuesto' ? 'fin-hint-ok' : 'fin-hint-warn'">
            {{ etiquetaConcepto().texto }}
          </small>
        </div>

        <div class="fin-row">
          <label>Qué pasó</label>
          <input pInputText [(ngModel)]="f.glosa" (ngModelChange)="pedirPropuestaDebounced()" class="w-full"
                 placeholder="Contá qué pasó — esto NO es el concepto contable" />
        </div>

        <div class="fin-row">
          <label>Monto</label>
          <!-- Con el cobro elegido el monto NO se edita. El servidor lo ignora igual y toma el del
               documento; bloquearlo acá es para que nadie teclee una cifra que no va a viajar. -->
          <p-inputnumber [(ngModel)]="f.monto" mode="currency" currency="MXN" locale="es-MX"
                         [readonly]="!!cobroElegido()" />
          <label>Morralla</label>
          <p-inputnumber [(ngModel)]="f.morralla" mode="currency" currency="MXN" locale="es-MX" />
        </div>

        <details class="fin-details">
          <summary>Desglose por denominación (opcional) — {{ textoArqueo() }}</summary>
          <div class="fin-denoms">
            @for (d of denominaciones; track d) {
              <label class="fin-denom">
                <span class="mono">{{ money(d) }}</span>
                <p-inputnumber [ngModel]="piezasDe(d)" (ngModelChange)="setPiezas(d, $event)" [min]="0" />
              </label>
            }
          </div>
        </details>

        @if (bloqueos().length) {
          <ul class="fin-blocks">
            @for (b of bloqueos(); track b) { <li>{{ textoBloqueo(b) }}</li> }
          </ul>
        }
      </div>

      <!-- ⚠️ El pie va con #footer, NO con pTemplate="footer". En PrimeNG 22 el segundo NO
           PROYECTA NADA: el diálogo se abre sin Guardar ni Cancelar, sin un solo error en
           consola y sin que el build se queje. Los 3 diálogos de esta pantalla lo tenían y
           quedaron inutilizables — medido en vivo: .p-dialog-footer no existía y el diálogo
           no tenía ningún botón. Las otras 50 pantallas del repo ya usan #footer.
           SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. -->
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="capturaAbierta = false"></p-button>
        <p-button label="Guardar" icon="pi pi-check" size="small"
                  [disabled]="bloqueos().length > 0 || guardando()" (onClick)="guardar()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [(visible)]="aperturaAbierta" [modal]="true" [style]="{ width: '24rem' }"
              header="Abrir corte de caja" [draggable]="false">
      <div class="fin-form">
        <div class="fin-row">
          <label>Fondo inicial</label>
          <p-inputnumber [(ngModel)]="fondoInicial" mode="currency" currency="MXN" locale="es-MX" />
        </div>
        <small class="fin-dim">Con qué efectivo arranca la caja. Es el punto de partida del saldo.</small>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="aperturaAbierta = false"></p-button>
        <p-button label="Abrir" icon="pi pi-check" size="small" (onClick)="abrirCorte()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [(visible)]="cierreAbierto" [modal]="true" [style]="{ width: '40rem' }"
              header="Cerrar corte — contá el efectivo" [draggable]="false">
      <div class="fin-form">
        <!-- CG.19 Capa 1b: el arqueo es CIEGO. Acá se pintaba "Esperado / Diferencia" mientras la
             persona tecleaba, o sea que contaba hasta que la diferencia diera cero. Ahora sólo se
             ve lo que ella misma sumó; el resultado aparece al SELLAR. -->
        @if (revelado(); as r) {
          <p class="fin-dim">Esperado: <strong>{{ money(r.esperado) }}</strong> ·
            Contado: <strong>{{ money(r.contado) }}</strong> ·
            Diferencia: <strong>{{ money(r.diferencia) }}</strong></p>
          <p-tag [value]="r.veredicto || ''" [severity]="sevVeredicto(r.veredicto || '')"></p-tag>
        } @else {
          <p class="fin-dim">Contado hasta ahora: <strong>{{ money(sumaConteo()) }}</strong></p>
          <p-message severity="info" styleClass="w-full"
            text="Contá sin ver el esperado. Al guardar el conteo se revela la diferencia — y a partir de ahí sólo se puede recontar UNA vez, con motivo."></p-message>
        }
        <div class="fin-denoms">
          @for (d of denominaciones; track d) {
            <label class="fin-denom">
              <span class="mono">{{ money(d) }}</span>
              <p-inputnumber [ngModel]="piezasCorteDe(d)" (ngModelChange)="setPiezasCorte(d, $event)" [min]="0" />
            </label>
          }
        </div>
        <div class="fin-row">
          <label>Morralla</label>
          <p-inputnumber [(ngModel)]="morrallaCorte" mode="currency" currency="MXN" locale="es-MX" />
        </div>
        @if (revelado() && revelado()!.veredicto !== 'cuadra' && puedeRecontar()) {
          <div class="fin-row">
            <label>Motivo del reconteo</label>
            <input pInputText [(ngModel)]="motivoReconteo" class="w-full"
                   placeholder="Por qué se vuelve a contar — queda guardado junto al primer conteo" />
          </div>
        }
        <small [class]="gateCierre().ok ? 'fin-hint-ok' : 'fin-hint-warn'">{{ gateCierre().texto }}</small>
      </div>
      <ng-template #footer>
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cierreAbierto = false"></p-button>
        @if (!revelado()) {
          <!-- Sellar ANTES de revelar: si se revelara sin guardar, bastaba mirar el resultado y
               corregir el conteo, y el arqueo ciego dejaría de serlo. -->
          <p-button label="Guardar conteo" icon="pi pi-lock" size="small"
                    [disabled]="sumaConteo() <= 0 || sellando()" (onClick)="sellarConteo()"></p-button>
        } @else {
          @if (revelado()!.veredicto !== 'cuadra' && puedeRecontar()) {
            <p-button label="Recontar" icon="pi pi-replay" size="small" severity="secondary"
                      [disabled]="motivoReconteo.trim().length < 5 || sellando()" (onClick)="recontar()"></p-button>
          }
          <p-button label="Cerrar corte" icon="pi pi-check" size="small"
                    [disabled]="!gateCierre().ok" (onClick)="cerrarCorte()"></p-button>
        }
      </ng-template>
    </p-dialog>
  `,
})
export class FinanzasCajaGeneralComponent implements OnInit {
  private svc = inject(CashLedgerService);
  private auth = inject(AuthService);

  readonly money = money;
  readonly dmy = dmy;
  readonly denominaciones = DENOMINACIONES;

  rows = signal<MovimientoCaja[]>([]);
  cargando = signal(false);
  guardando = signal(false);
  conceptos = signal<Array<ConceptoKepler & { label: string }>>([]);
  /** CG.19 — los cobros de Kepler sin aplicar, y cuál se eligió. */
  cobros = signal<Array<IngresoPendiente & { label: string }>>([]);
  cobroElegido = signal<IngresoPendiente | null>(null);
  cobroSel: (IngresoPendiente & { label: string }) | null = null;
  cobertura = signal<Array<{ usables: number; filas_origen: number; sin_subcuenta: number }>>([]);
  propuesta = signal<AutofillResponse | null>(null);
  kpiRaw = signal<{ movimientos: number; ingresos: number; gastos: number; depositos: number } | null>(null);

  capturaAbierta = false;
  aperturaAbierta = false;
  cierreAbierto = false;
  fondoInicial = 0;
  morrallaCorte = 0;
  conteoCorte: DenominacionCapturada[] = [];
  saldoResp = signal<SaldoResponse | null>(null);
  cortes = signal<CorteCaja[]>([]);
  /**
   * CG.19 Capa 1b — null mientras se cuenta a ciegas; con valor una vez SELLADO el conteo.
   * No se inicializa con los totales del saldo a propósito: ahí está justamente lo que hay que
   * ocultar, y el servidor ya no lo manda a quien no autoriza.
   */
  revelado = signal<TotalesCorte | null>(null);
  puedeRecontar = signal(false);
  sellando = signal(false);
  motivoReconteo = '';
  conceptoSel: (ConceptoKepler & { label: string }) | null = null;
  from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  to = new Date().toISOString().slice(0, 10);
  tipo: string | null = null;
  search = '';

  f: {
    tipo: TipoMovimiento; fecha: string; sucursal: string;
    kepler_cuenta: string | null; kepler_concepto: string | null;
    glosa: string; beneficiario: string; monto: number | null; morralla: number;
    denominaciones: DenominacionCapturada[];
  } = this.formVacio();

  readonly tiposFiltro = [
    { label: 'Ingresos', value: 'ingreso' }, { label: 'Gastos', value: 'gasto' }, { label: 'Depósitos', value: 'deposito' },
  ];
  readonly tiposCaptura = [
    { label: 'Ficha de efectivo por cobranza', value: 'ingreso' },
    { label: 'Comprobante de gasto', value: 'gasto' },
    { label: 'Depósito al banco', value: 'deposito' },
  ];

  coberturaTexto = computed(() => textoCobertura(this.cobertura()));
  textoSaldoUI = computed(() => textoSaldo(this.saldoResp()));
  corteAbierto = computed(() => this.saldoResp()?.corte_abierto ?? null);
  /**
   * ⛔ CG.19 Capa 1b — acá estaba la fuga. esperadoCorte leía saldoResp().totales.esperado y
   * veredicto calculaba la diferencia EN EL NAVEGADOR mientras la persona tecleaba: se contaba
   * hasta que diera cero. Las dos se retiran.
   *
   * El veredicto ahora lo produce el SERVIDOR al sellar el conteo (revelado()), que es el único
   * momento en que el conteo ya no se puede retocar. Calcularlo del lado del cliente sería
   * devolverle el esperado por la ventana: con esperado en el bundle, taparlo en la plantilla
   * no tapa nada.
   */
  corteVista = computed<CorteVista | null>(() => {
    const c = this.corteAbierto();
    return c ? { id: c.id, folio: c.folio, estado: 'borrador' } : null;
  });
  /** No se cierra sin haber SELLADO el conteo: sin revelación no hay nada firmado que cerrar. */
  gateCierre = computed(() => {
    const r = this.revelado();
    if (!r) return { ok: false, texto: 'Guardá el conteo primero: el resultado se revela al sellarlo.' };
    return puedeCerrarUI(this.corteVista(), r.veredicto ?? 'sin_contar');
  });
  hayConceptos = computed(() => this.cobertura().reduce((a, r) => a + Number(r.usables || 0), 0) > 0);
  bloqueos = computed<MotivoBloqueo[]>(() => motivosDeBloqueo(this.f));
  etiquetaConcepto = computed(() => etiquetaProcedencia(this.propuesta()?.concepto as never));

  kpis = computed<MetricStripItem[]>(() => {
    const k = this.kpiRaw();
    return [
      { label: 'Movimientos', value: String(k?.movimientos ?? 0) },
      { label: 'Ingresos', value: money(k?.ingresos ?? 0) },
      { label: 'Gastos', value: money(k?.gastos ?? 0) },
      { label: 'Depósitos', value: money(k?.depositos ?? 0) },
    ];
  });

  ngOnInit(): void {
    this.svc.cobertura().subscribe({
      next: (c) => this.cobertura.set(c.catalogo ?? []),
      // Un error de red NO puede verse como "no hay conceptos": se deja sin medir.
      error: () => this.cobertura.set([]),
    });
    this.cargar();
    this.cargarSaldo();
    this.cargarCortes();
  }

  cargarCortes(): void {
    this.svc.cortes({ from: this.from, to: this.to, limit: 50 })
      .subscribe({ next: (r) => this.cortes.set(r.rows ?? []), error: () => this.cortes.set([]) });
  }

  sevEstadoCorte(e: string): 'secondary' | 'warn' | 'success' {
    return e === 'borrador' ? 'secondary' : e === 'cerrado' ? 'warn' : 'success';
  }

  /**
   * La doble llave, en el boton. El sub del JWT es el MISMO id que el backend guarda en
   * closed_by (el controller resuelve id ?? sub ?? userId), asi que la comparacion es
   * valida. El candado real esta en la DB: esto solo evita el 403 sorpresa.
   */
  gateAutorizar(c: CorteCaja) {
    return puedeAutorizarUI(c as unknown as CorteVista, this.auth.user()?.sub ?? null);
  }

  autorizar(c: CorteCaja): void {
    if (!this.gateAutorizar(c).ok) return;
    this.svc.autorizarCorte(c.id).subscribe({ next: () => this.cargarCortes() });
  }

  /** Sucursal del corte. Por ahora fija; cuando haya selector, sale de ahí. */
  private sucursalActiva = '00';

  cargarSaldo(): void {
    this.svc.saldo(this.sucursalActiva).subscribe({
      next: (r) => this.saldoResp.set(r),
      // Un error de red NO es "saldo 0": se declara como sin medir.
      error: () => this.saldoResp.set(null),
    });
  }

  abrirApertura(): void { this.fondoInicial = 0; this.aperturaAbierta = true; }

  abrirCorte(): void {
    this.svc.abrirCorte({
      fecha: new Date().toISOString().slice(0, 10),
      sucursal: this.sucursalActiva,
      fondo_inicial: this.fondoInicial,
    }).subscribe({ next: () => { this.aperturaAbierta = false; this.cargarSaldo(); this.cargarCortes(); } });
  }

  /**
   * CG.19 Capa 1b — el arqueo es CIEGO: se abre sin revelación y sin motivo de reconteo.
   * El esperado aparece cuando el servidor lo devuelve, y sólo después de SELLAR el conteo.
   */
  abrirCierre(): void {
    this.conteoCorte = []; this.morrallaCorte = 0;
    this.revelado.set(null); this.motivoReconteo = '';
    this.cierreAbierto = true;
  }

  /** Lo que la persona lleva sumado. No revela nada: es su propia suma. */
  sumaConteo(): number {
    return sumaDesglose(this.conteoCorte, this.morrallaCorte);
  }

  /** Sella el conteo y recibe la revelación. A partir de acá el conteo ya no se retoca en silencio. */
  sellarConteo(): void {
    const c = this.corteAbierto();
    if (!c || this.sellando()) return;
    this.sellando.set(true);
    this.svc.contarCorte(c.id, this.conteoCorte, this.morrallaCorte).subscribe({
      next: (r) => { this.revelado.set(r.totales); this.puedeRecontar.set(r.puede_recontar); this.sellando.set(false); },
      error: () => this.sellando.set(false),
    });
  }

  /** Segundo y último conteo. El motivo es obligatorio y el primero se conserva en el corte. */
  recontar(): void {
    const c = this.corteAbierto();
    if (!c || this.motivoReconteo.trim().length < 5 || this.sellando()) return;
    this.sellando.set(true);
    this.svc.recontarCorte(c.id, this.conteoCorte, this.morrallaCorte, this.motivoReconteo.trim()).subscribe({
      next: (r) => { this.revelado.set(r.totales); this.puedeRecontar.set(false); this.sellando.set(false); },
      error: () => this.sellando.set(false),
    });
  }

  piezasCorteDe(d: number): number {
    return this.conteoCorte.find((x) => x.denominacion === d)?.piezas ?? 0;
  }

  setPiezasCorte(d: number, piezas: number): void {
    const list = this.conteoCorte.filter((x) => x.denominacion !== d);
    if (Number(piezas) > 0) list.push({ denominacion: d, piezas: Number(piezas) });
    this.conteoCorte = list;
  }

  sevVeredicto(v: string): 'success' | 'warn' | 'danger' | 'secondary' {
    return v === 'cuadra' ? 'success' : v === 'sobra' ? 'warn' : v === 'falta' ? 'danger' : 'secondary';
  }

  cerrarCorte(): void {
    const c = this.corteAbierto();
    if (!c || !this.gateCierre().ok) return;
    this.svc.cerrarCorte(c.id, this.conteoCorte, this.morrallaCorte).subscribe({
      next: () => { this.cierreAbierto = false; this.cargarSaldo(); this.cargar(); this.cargarCortes(); },
    });
  }

  private formVacio() {
    return {
      tipo: 'gasto' as TipoMovimiento, fecha: new Date().toISOString().slice(0, 10), sucursal: '00',
      kepler_cuenta: null as string | null, kepler_concepto: null as string | null,
      glosa: '', beneficiario: '', monto: null as number | null, morralla: 0,
      denominaciones: [] as DenominacionCapturada[],
    };
  }

  cargar(): void {
    this.cargando.set(true);
    this.svc.libro({ from: this.from, to: this.to, tipo: this.tipo ?? undefined, search: this.search || undefined })
      .subscribe({
        next: (r) => { this.rows.set(r.rows ?? []); this.kpiRaw.set(r.kpi); this.cargando.set(false); this.cargarCortes(); },
        error: () => { this.rows.set([]); this.kpiRaw.set(null); this.cargando.set(false); },
      });
  }

  abrirCaptura(): void {
    this.f = this.formVacio();
    this.conceptoSel = null;
    this.propuesta.set(null);
    // El cobro elegido NO sobrevive al diálogo anterior: arrastrarlo aplicaría el documento de
    // una entrega a otra, que es justo el error que el índice único frena del lado del servidor.
    this.cobroSel = null;
    this.cobroElegido.set(null);
    this.cobros.set([]);
    this.capturaAbierta = true;
  }

  conceptoLabel = (c: ConceptoKepler) => `${c.cuenta} / ${c.concepto} — ${c.concepto_nombre}`;

  // ── CG.19 Capa 1 — elegir el cobro en vez de teclear el monto ──────────────────────────────

  /** Etiqueta del cobro: primero lo que identifica la entrega, después el monto. */
  cobroLabel = (c: IngresoPendiente) =>
    `${dmy(c.cobro_date)} · ${c.cliente_nombre || c.cliente_code || 's/cliente'} · ${money(c.monto)} · ${c.folio}`;

  buscarCobros(e: AutoCompleteCompleteEvent): void {
    this.svc.ingresosPendientes({
      sucursal: this.f.sucursal || undefined,
      search: (e.query || '').trim() || undefined,
      limit: 40,
    }).subscribe({
      next: (r) => this.cobros.set((r.rows ?? []).map((c) => ({ ...c, label: this.cobroLabel(c) }))),
      // Un error de red NO es "no hay cobros pendientes": se deja la lista como estaba y el
      // capturista puede seguir a mano. Vaciarla diría que el ERP no tiene nada, que es distinto.
      error: () => this.cobros.set([]),
    });
  }

  /**
   * Toma el documento: monto, fecha, motivo y beneficiario salen del ERP.
   *
   * ⚠️ El monto que se pone acá es **cosmético**: el servidor lo relee del documento y descarta el
   * del formulario. Se escribe igual para que el arqueo por denominación pueda cuadrar contra la
   * cifra correcta antes de mandar, y para que la persona vea contra qué está contando.
   */
  elegirCobro(e: AutoCompleteSelectEvent): void {
    const c = e.value as IngresoPendiente;
    if (!c) return;
    this.cobroElegido.set(c);
    this.f = {
      ...this.f,
      monto: Number(c.monto),
      // La fecha del cobro es cuándo Kepler registró el documento; la del movimiento es cuándo
      // entró el efectivo. Se propone, no se impone: el capturista puede corregirla.
      fecha: String(c.cobro_date).slice(0, 10) || this.f.fecha,
      beneficiario: c.cliente_nombre || c.cliente_code || this.f.beneficiario,
      glosa: this.f.glosa?.trim()
        || `Cobro ${c.folio} · ${c.cliente_nombre || c.cliente_code || 'cliente'}`.slice(0, 200),
      // El desglose viejo dejaría de cuadrar contra el monto nuevo: se limpia y se vuelve a contar.
      denominaciones: [],
    };
    this.pedirPropuesta();
  }

  /** Soltar el cobro devuelve el formulario a captura manual, sin arrastrar el monto del ERP. */
  soltarCobro(): void {
    this.cobroElegido.set(null);
    this.f = { ...this.f, monto: null, denominaciones: [] };
  }

  buscarConceptos(e: AutoCompleteCompleteEvent): void {
    this.svc.conceptos(this.f.sucursal || undefined, e.query || '', 30).subscribe({
      // `label` es lo que el autocomplete pinta: la vista no arma texto en la plantilla.
      next: (r) => this.conceptos.set((r.rows ?? []).map((c) => ({ ...c, label: this.conceptoLabel(c) }))),
      error: () => this.conceptos.set([]),
    });
  }

  elegirConcepto(e: AutoCompleteSelectEvent): void {
    const c = e.value as ConceptoKepler;
    this.f.kepler_cuenta = c?.cuenta ?? null;
    this.f.kepler_concepto = c?.concepto ?? null;
  }

  onSucursal(): void { this.conceptos.set([]); this.pedirPropuesta(); }

  private debounce?: ReturnType<typeof setTimeout>;
  pedirPropuestaDebounced(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.pedirPropuesta(), 350);
  }

  /** Pide una PROPUESTA. Nunca pisa lo que el humano ya eligió a mano. */
  pedirPropuesta(): void {
    if (!this.f.tipo && !this.f.beneficiario && !this.f.glosa) return;
    this.svc.autofill({
      tipo: this.f.tipo, sucursal: this.f.sucursal,
      glosa: this.f.glosa || undefined, beneficiario: this.f.beneficiario || undefined,
    }).subscribe({
      next: (r) => {
        this.propuesta.set(r);
        const v = r.concepto?.value;
        if (v && !this.conceptoSel) {
          this.f.kepler_cuenta = v.kepler_cuenta;
          this.f.kepler_concepto = v.kepler_concepto;
        }
      },
      error: () => this.propuesta.set(null),
    });
  }

  piezasDe(d: number): number {
    return this.f.denominaciones.find((x) => x.denominacion === d)?.piezas ?? 0;
  }

  setPiezas(d: number, piezas: number): void {
    const list = this.f.denominaciones.filter((x) => x.denominacion !== d);
    if (Number(piezas) > 0) list.push({ denominacion: d, piezas: Number(piezas) });
    this.f = { ...this.f, denominaciones: list };
  }

  textoArqueo(): string {
    const r = estadoArqueo(Number(this.f.monto), this.f.denominaciones, Number(this.f.morralla || 0));
    if (r.estado === 'sin_desglose') return 'sin contar';
    if (r.estado === 'cuadra') return `cuadra: ${money(r.desglosado)}`;
    return `NO cuadra: ${money(r.desglosado)} (${r.diferencia > 0 ? 'sobran' : 'faltan'} ${money(Math.abs(r.diferencia))})`;
  }

  textoBloqueo(b: MotivoBloqueo): string { return TEXTO_BLOQUEO[b]; }

  sevTipo(t: string): 'success' | 'danger' | 'info' {
    return t === 'ingreso' ? 'success' : t === 'gasto' ? 'danger' : 'info';
  }

  guardar(): void {
    if (this.bloqueos().length) return;
    this.guardando.set(true);
    const cobro = this.cobroElegido();
    this.svc.crear({
      ...this.f,
      denominaciones: this.f.denominaciones,
      // ⭐ CG.19 — la llave del documento de Kepler. Con esto el servidor RELEE el monto del ERP y
      // descarta el del formulario, y el índice único impide que el mismo cobro entre dos veces.
      origen_tipo: cobro ? 'cobro' : null,
      origen_ref: cobro ? cobro.origen_ref : null,
      // La procedencia viaja con el movimiento: qué campo propuso el motor y con qué respaldo.
      autofill: this.propuesta()?.provenance ?? null,
      client_uuid: crypto.randomUUID(),
    }).subscribe({
      next: () => { this.guardando.set(false); this.capturaAbierta = false; this.cargar(); this.cargarSaldo(); },
      error: () => { this.guardando.set(false); },
    });
  }

  /** Suma visible del desglose, para el pie del bloque. */
  desglosado = computed(() => sumaDesglose(this.f.denominaciones, this.f.morralla));
}
