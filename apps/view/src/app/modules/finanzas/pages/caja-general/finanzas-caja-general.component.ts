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
import { CashLedgerService, type ConceptoKepler, type MovimientoCaja, type AutofillResponse, type TipoMovimiento, type SaldoResponse, type CorteCaja } from '../../cash-ledger.service';
import {
  DENOMINACIONES, estadoArqueo, motivosDeBloqueo, TEXTO_BLOQUEO, etiquetaProcedencia,
  textoCobertura, sumaDesglose, veredictoCorte, puedeAutorizarUI, puedeCerrarUI, textoSaldo,
  type DenominacionCapturada, type MotivoBloqueo, type CorteVista,
} from './caja-captura.util';

/**
 * CG.14 — Caja General: la pantalla donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Reemplaza las 6 formas del Access `Control` (`Fichas de Efectivo por Cobranza`,
 * `Fichas de Otros Ingresos`, `Comprobante de Gasto`, `Comprobación de Gasto`,
 * `Depósitos al banco`) **con los mismos nombres que la gente ya usa**: reestructurar es
 * renombrar y reordenar, no rediseñar.
 *
 * Tres cosas que esta pantalla hace y la de Access no podía:
 *   · El concepto contable de Kepler es un buscador sobre el catálogo vivo, no un número que
 *     hay que saberse. Y es POR SUCURSAL, porque el mismo par tiene nombre distinto por plaza.
 *   · Lo que el motor propone se ve COMO PROPUESTA, con su respaldo. Un campo autorrellenado
 *     que se pinta igual que uno tecleado se acepta sin mirarlo.
 *   · La cobertura del catálogo está SIEMPRE a la vista: "0 conceptos" por carril caído no
 *     puede leerse igual que "esta sucursal no tiene conceptos".
 *
 * La lógica de decisión vive en `caja-captura.util.ts` (puro, con pruebas unitarias).
 */
@Component({
  selector: 'app-finanzas-caja-general',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, InputTextModule, InputNumberModule, TableModule,
    SelectModule, TagModule, DialogModule, AutoCompleteModule, MessageModule, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [FINANZAS_SHARED_STYLES],
  template: `
    <div class="fin-page">
      <header class="fin-head">
        <div>
          <h1>Caja General</h1>
          <p class="fin-sub">{{ coberturaTexto() }}</p>
        </div>
        <div class="fin-actions">
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

      <p-table [value]="rows()" [loading]="cargando()" size="small" styleClass="fin-table"
               [scrollable]="true" scrollHeight="flex">
        <ng-template pTemplate="header">
          <tr>
            <th>Folio</th><th>Fecha</th><th>Tipo</th><th>Cuenta / Concepto</th>
            <th>Qué pasó</th><th class="ta-r">Monto</th><th>Capturó</th><th>Origen</th>
          </tr>
        </ng-template>
        <ng-template pTemplate="body" let-m>
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
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="8" class="fin-empty">Sin movimientos en el periodo.</td></tr>
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

        <div class="fin-row">
          <label>Beneficiario</label>
          <input pInputText [(ngModel)]="f.beneficiario" (blur)="pedirPropuesta()" class="w-full" />
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
          <p-inputnumber [(ngModel)]="f.monto" mode="currency" currency="MXN" locale="es-MX" />
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

      <ng-template pTemplate="footer">
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
      <ng-template pTemplate="footer">
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="aperturaAbierta = false"></p-button>
        <p-button label="Abrir" icon="pi pi-check" size="small" (onClick)="abrirCorte()"></p-button>
      </ng-template>
    </p-dialog>

    <p-dialog [(visible)]="cierreAbierto" [modal]="true" [style]="{ width: '40rem' }"
              header="Cerrar corte — contá el efectivo" [draggable]="false">
      <div class="fin-form">
        <p class="fin-dim">Esperado: <strong>{{ money(esperadoCorte()) }}</strong> ·
          Contado: <strong>{{ money(veredicto().contado) }}</strong> ·
          Diferencia: <strong>{{ money(veredicto().diferencia) }}</strong></p>
        <p-tag [value]="veredicto().veredicto" [severity]="sevVeredicto(veredicto().veredicto)"></p-tag>
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
        <small [class]="gateCierre().ok ? 'fin-hint-ok' : 'fin-hint-warn'">{{ gateCierre().texto }}</small>
      </div>
      <ng-template pTemplate="footer">
        <p-button label="Cancelar" severity="secondary" size="small" (onClick)="cierreAbierto = false"></p-button>
        <p-button label="Cerrar corte" icon="pi pi-lock" size="small"
                  [disabled]="!gateCierre().ok" (onClick)="cerrarCorte()"></p-button>
      </ng-template>
    </p-dialog>
  `,
})
export class FinanzasCajaGeneralComponent implements OnInit {
  private svc = inject(CashLedgerService);

  readonly money = money;
  readonly dmy = dmy;
  readonly denominaciones = DENOMINACIONES;

  rows = signal<MovimientoCaja[]>([]);
  cargando = signal(false);
  guardando = signal(false);
  conceptos = signal<Array<ConceptoKepler & { label: string }>>([]);
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
  esperadoCorte = computed(() => this.saldoResp()?.totales?.esperado ?? 0);
  veredicto = computed(() => veredictoCorte(this.esperadoCorte(), this.conteoCorte, this.morrallaCorte));
  corteVista = computed<CorteVista | null>(() => {
    const c = this.corteAbierto();
    return c ? { id: c.id, folio: c.folio, estado: 'borrador' } : null;
  });
  gateCierre = computed(() => puedeCerrarUI(this.corteVista(), this.veredicto().veredicto));
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
    }).subscribe({ next: () => { this.aperturaAbierta = false; this.cargarSaldo(); } });
  }

  abrirCierre(): void { this.conteoCorte = []; this.morrallaCorte = 0; this.cierreAbierto = true; }

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
      next: () => { this.cierreAbierto = false; this.cargarSaldo(); this.cargar(); },
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
        next: (r) => { this.rows.set(r.rows ?? []); this.kpiRaw.set(r.kpi); this.cargando.set(false); },
        error: () => { this.rows.set([]); this.kpiRaw.set(null); this.cargando.set(false); },
      });
  }

  abrirCaptura(): void {
    this.f = this.formVacio();
    this.conceptoSel = null;
    this.propuesta.set(null);
    this.capturaAbierta = true;
  }

  conceptoLabel = (c: ConceptoKepler) => `${c.cuenta} / ${c.concepto} — ${c.concepto_nombre}`;

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
    this.svc.crear({
      ...this.f,
      denominaciones: this.f.denominaciones,
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
