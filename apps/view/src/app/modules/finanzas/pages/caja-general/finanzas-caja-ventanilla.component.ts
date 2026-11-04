import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { SUCURSAL_CAJA_GENERAL, valorDePiezas, type PlanDePagoVentanilla, type ResultadoPago } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { uuidV4 } from '../../../../core/utils/uuid';
import { CashLedgerService, type PendientesResponse } from '../../cash-ledger.service';
import { LibroEfectivoService } from '../../libro-efectivo.service';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { ConteoCajonComponent } from '../../components/conteo-cajon.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { armarCola, resumenCola, type FilaVentanilla } from './ventanilla.util';

/** El libro nuevo, para la Ventanilla: si hoy puede pagar. */
type EstadoLibro = 'abierto' | 'sin_dia' | 'sin_medir';

/**
 * ⭐ `[LE.2.13]` **La Ventanilla de Caja General** (fase LE, ADR-112): pagar ES registrar, y lo que
 * respalda el pago lo dice Kepler. PM, 2026-11-03: *«las compras ya se autorizan cuando se hace la
 * compra»*, *«¿por qué volverlos a aprobar?»* (D27) y *«lo rechazado no se paga»* (D29).
 *
 * Las cinco preguntas (`diseno` §0b):
 * 1. Qué ve y en qué orden: si el libro puede pagar hoy; cuánto se paga ya, cuánto pide firma y
 *    cuánto está detenido; la cola en ese orden (lo que se paga primero).
 * 2. Qué no ve: la cuenta y el concepto (los resuelve el sistema), ni un vale que elegir (lo pone Kepler).
 * 3. Accesibilidad: el motivo va en la fila y en palabras (no sólo color), con el enlace a donde se
 *    arregla; el resultado del pago se anuncia (`role="status"`).
 * 4. Ligado a: Aprobación de gastos (donde se arregla un gasto), la máquina CAOS (el código) y la
 *    cola de Kepler (`movimientos-pendientes`, la misma de Captura).
 * 5. Quién: quien opera la caja (el permiso de Captura); pagar pide GESTIONAR, y la base exige la llave (LE.0.9).
 *
 * Jerarquía (Q.5): primario = qué se puede pagar ya; secundario = la fila y su porqué; terciario = el folio.
 *
 * ⚠️ El importe nunca viaja desde aquí: el servidor relee el documento (`pagos/plan`, `pagos`).
 */
@Component({
  selector: 'app-finanzas-caja-ventanilla',
  standalone: true,
  imports: [
    FormsModule, RouterLink, ButtonModule, TableModule, TagModule, DialogModule, InputTextModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, CajaTabsComponent, ConteoCajonComponent, ContextHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-caja-tabs />
    <div class="surf-page in vt">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Ventanilla</h1>
          <p class="surf-page-sub">Los pagos de Caja General. Sale lo que ya está autorizado —la compra o el gasto aprobado—; lo detenido dice por qué y dónde se arregla.</p>
        </div>
        <div class="vt-acciones">
          <app-context-help topic="caja-ventanilla" />
          <app-freshness-pill measures="data" [since]="cola()?.datos_al ?? null" label="Kepler" />
          <p-button size="small" icon="pi pi-refresh" severity="secondary" [text]="true" label="Actualizar"
                    [loading]="cargando()" (onClick)="cargar()" />
        </div>
      </header>

      @if (libro() === 'sin_dia') {
        <p class="vt-aviso" role="status" data-testid="libro-sin-dia">
          <i class="pi pi-info-circle" aria-hidden="true"></i>
          El libro nuevo no tiene el día abierto: aquí se ve qué se puede pagar, pero todavía no se paga. Falta el saldo de arranque:
          la cajera cuenta el cajón por pieza y Tesorería lo firma.
        </p>
      } @else if (libro() === 'sin_medir') {
        <p class="vt-aviso" role="status" data-testid="libro-sin-medir">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          No se pudo leer el libro nuevo: al pagar, el servidor dirá si se puede.
        </p>
      }

      <app-load-state [loading]="cargando() && !cola()" [error]="error()" [isEmpty]="!!cola() && !filas().length" [skeletonRows]="6"
                      errorTitle="No se pudo leer qué hay por pagar" emptyTitle="No hay pagos por hacer en Caja General"
                      (retry)="cargar()">
        @if (cola(); as c) {
          <app-metric-strip [items]="kpis()" ariaLabel="Lo que hay por pagar, por estado" density="compact" />

          <!-- D.7: la cola se recorre con flechas y Enter abre el pago de la fila (lo detenido no abre). -->
          <p-table [value]="filas()" size="small" dataKey="doc.origen_ref" class="dt-stack vt-tbl"
                   selectionMode="single" [metaKeySelection]="false" [selection]="null" (onRowSelect)="abrirFila($event.data)">
            <ng-template #header>
              <tr>
                <th scope="col">Documento</th><th scope="col">Beneficiario</th><th scope="col">Fecha</th>
                <th scope="col">Lo respalda</th><th scope="col" class="ta-r">Importe</th><th scope="col"><span class="sr-only">Pagar</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr [pSelectableRow]="f" [class.vt-detenido]="f.estado === 'detenido'" [attr.data-estado]="f.estado">
                <td class="dt-id num" data-label="Documento">X-D-26 {{ f.doc.folio }}</td>
                <td data-label="Beneficiario">{{ f.doc.beneficiario ?? '—' }}</td>
                <td class="num" data-label="Fecha">{{ dmy(f.doc.fecha_valor) }}</td>
                <td data-label="Lo respalda">
                  <p-tag [value]="f.etiqueta" [severity]="severidad(f)" styleClass="vt-tag" />
                  @if (f.motivo) {
                    <span class="vt-motivo">{{ f.motivo }}
                      @if (f.arreglo === 'aprobacion_gastos') { <a routerLink="/finanzas/aprobacion-gastos">Ir a Aprobación de gastos</a> }
                    </span>
                  }
                </td>
                <td class="ta-r num dt-num" data-label="Importe">{{ money(f.doc.monto) }}</td>
                <td class="ta-r" data-label="Pagar">
                  <p-button size="small" severity="secondary" [outlined]="true" [label]="f.estado === 'firma' ? 'Pedir firma' : 'Pagar'"
                            [disabled]="f.estado === 'detenido' || !puedePagar()" [ariaLabel]="'Pagar X-D-26 ' + f.doc.folio"
                            (onClick)="$event.stopPropagation(); abrir(f)" />
                </td>
              </tr>
            </ng-template>
          </p-table>

          <p class="vt-pie muted">
            La cola de Kepler para Caja General (X-D-26 de la caja 0011).
            @if (c.mal_fechados?.movimientos) {
              {{ c.mal_fechados!.movimientos }} {{ c.mal_fechados!.movimientos === 1 ? 'documento viene fechado' : 'documentos vienen fechados' }}
              después de hoy ({{ money(c.mal_fechados!.monto) }}): se corrigen en Kepler y aparecen solos.
            }
            @if (c.has_more) { <b>Hay más de {{ c.limit }}: se ven los primeros.</b> }
          </p>
        }
      </app-load-state>
    </div>

    <p-dialog [visible]="!!pagando()" (visibleChange)="!$event && cerrar()" [modal]="true" [draggable]="false"
              [style]="{ width: '36rem' }" [header]="pagando() ? 'Pagar X-D-26 ' + pagando()!.doc.folio : ''">
      @if (pagando(); as f) {
        <p class="vt-quien">{{ f.doc.beneficiario ?? '—' }} · <b class="num">{{ money(f.doc.monto) }}</b></p>
        <p class="vt-respalda muted" data-testid="lo-respalda">{{ loRespalda(f) }}</p>

        @if (resultado(); as r) {
          <div class="vt-resultado" role="status" data-testid="resultado">
            @if (r.estado === 'pagado') {
              @if (r.codigo) {
                <p>Teclea en la máquina este código; entrega <b class="num">{{ minor(r.maquina_minor) }}</b>:</p>
                <p class="vt-codigo" data-testid="codigo">{{ r.codigo }}</p>
                <p class="muted">Vale hasta el fin del día.</p>
              } @else {
                <p>Todo salió del cajón: no hay código que teclear.</p>
              }
              @if (r.cajon_minor !== '0') { <p>Del cajón salieron <b class="num">{{ minor(r.cajon_minor) }}</b>, ya registrados.</p> }
            } @else {
              <p>Quedó por firmar: {{ r.motivo }}. Tesorería la firma desde su teléfono y entonces sale el código.</p>
            }
          </div>
        } @else if (plan(); as p) {
          <dl class="vt-plan">
            <div><dt>La máquina entrega</dt><dd class="num">{{ minor(p.maquina_minor) }}</dd></div>
            <div><dt>Del cajón, en monedas</dt><dd class="num">{{ minor(p.cajon_minor) }}</dd></div>
            @if (p.redondeo_minor !== '0') {
              <div><dt>Redondeo al medio peso, declarado</dt><dd class="num">{{ minor(p.redondeo_minor) }}</dd></div>
            }
          </dl>
          @if (p.bloqueo) {
            <p class="vt-aviso vt-aviso--mal" role="alert">{{ p.motivo_bloqueo }}</p>
          } @else {
            @if (p.requiere_firma) {
              <p class="vt-aviso" role="status">{{ p.motivo_firma }}: al pedirlo queda por firmar y no sale un peso hasta que Tesorería firme.</p>
            }
            @if (cajon() > 0) {
              <app-conteo-cajon [total]="cajon()" [(piezas)]="piezas" [conBilletes]="false" [conMorralla]="false" />
            }
            <label class="vt-lbl" for="vt-recibe">Quién recibe el dinero</label>
            <input pInputText id="vt-recibe" class="vt-in" [ngModel]="recibe()" (ngModelChange)="recibe.set($event)"
                   placeholder="Nombre de quien recibe" autocomplete="off" />
          }
        } @else if (errorPago()) {
          <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorPago() }}</p>
        } @else {
          <p class="muted">Leyendo el documento…</p>
        }
        @if (resultado() === null && errorPago() && plan()) {
          <p class="vt-aviso vt-aviso--mal" role="alert">{{ errorPago() }}</p>
        }
      }
      <ng-template #footer>
        @if (resultado()) {
          <p-button label="Listo" (onClick)="cerrar()" />
        } @else {
          <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cerrar()" />
          <p-button [label]="plan()?.requiere_firma ? 'Pedir la firma' : 'Pagar'" [disabled]="!listoParaPagar()" [loading]="enviando()"
                    (onClick)="pagar()" />
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .vt .surf-page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .vt-acciones { display: flex; align-items: center; gap: var(--sp-2); }
    .vt-aviso { display: flex; gap: var(--sp-2); align-items: baseline; margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm, 8px); background: var(--warn-soft-bg); color: var(--text-main); font-size: var(--fs-sm); }
    .vt-aviso .pi { color: var(--warn-fg); }
    .vt-aviso--mal { background: var(--bad-soft-bg, var(--warn-soft-bg)); }
    .vt-tbl { margin-top: var(--sp-3); }
    .vt-motivo { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .vt-motivo a { color: var(--text-main); text-decoration: underline; text-underline-offset: 2px; }
    .vt-pie { margin-top: var(--sp-3); font-size: var(--fs-xs); }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ta-r { text-align: right; }
    .vt-quien { margin: 0 0 var(--sp-1); }
    .vt-respalda { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); }
    .vt-plan { display: grid; gap: var(--sp-1); margin: 0 0 var(--sp-3); }
    .vt-plan div { display: flex; justify-content: space-between; gap: var(--sp-3); }
    .vt-plan dt { color: var(--text-muted); } .vt-plan dd { margin: 0; font-weight: 600; }
    .vt-lbl { display: block; margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); }
    .vt-in { width: 100%; }
    .vt-codigo { font: 600 1.75rem/1.2 var(--font-mono, ui-monospace, monospace); letter-spacing: .08em; margin: var(--sp-2) 0; }
    .vt-resultado p { margin: 0 0 var(--sp-2); }
  `],
})
export class FinanzasCajaVentanillaComponent implements OnInit {
  private readonly ledger = inject(CashLedgerService);
  private readonly libroApi = inject(LibroEfectivoService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly money = money;
  readonly dmy = dmy;
  readonly minor = (m: string | null | undefined): string => money(Number(m ?? 0) / 100);

  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly cola = signal<PendientesResponse | null>(null);
  readonly filas = signal<FilaVentanilla[]>([]);
  readonly libro = signal<EstadoLibro>('sin_medir');

  readonly pagando = signal<FilaVentanilla | null>(null);
  readonly plan = signal<PlanDePagoVentanilla | null>(null);
  readonly piezas = signal<Record<string, number>>({});
  readonly recibe = signal('');
  readonly enviando = signal(false);
  readonly errorPago = signal<string | null>(null);
  readonly resultado = signal<ResultadoPago | null>(null);
  /** Una llave por intento: un doble clic o un reintento no paga dos veces. */
  private llave = '';

  readonly puedePagar = computed(() => this.perms.has(Permission.FINANCE_CAJA_GESTIONAR) && this.libro() !== 'sin_dia');
  readonly cajon = computed(() => Number(this.plan()?.cajon_minor ?? 0) / 100);
  readonly listoParaPagar = computed(() => {
    const p = this.plan();
    if (!p || p.bloqueo || this.enviando() || !this.recibe().trim()) return false;
    // La misma valuación que usa el servidor (`valorDePiezas`), no una aritmética aparte.
    const conteo = Object.fromEntries(Object.entries(this.piezas()).filter(([, n]) => Number(n) > 0));
    return valorDePiezas(conteo, 'MXN') === BigInt(p.cajon_minor);
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = resumenCola(this.filas());
    return [
      { label: 'Se pagan ya', value: r.pagable.monto, format: 'currency2', sub: `${r.pagable.n} ${r.pagable.n === 1 ? 'documento' : 'documentos'}`, tone: 'default' },
      { label: 'Piden la firma de Tesorería', value: r.firma.monto, format: 'currency2', sub: `${r.firma.n} · Kepler no dice qué pagan`, tone: r.firma.n ? 'warn' : 'muted' },
      { label: 'Detenidos', value: r.detenido.monto, format: 'currency2', sub: `${r.detenido.n} · se arreglan donde se autorizan`, tone: r.detenido.n ? 'bad' : 'muted' },
    ];
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.libroApi.saldos().pipe(
      map((s): EstadoLibro => (s.jornada_abierta ? 'abierto' : 'sin_dia')),
      catchError(() => of<EstadoLibro>('sin_medir')),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((e) => this.libro.set(e));
    this.ledger.movimientosPendientes({ doc_tipo: 'X-D-26', tipo: 'gasto', caja: '0011', sucursal: SUCURSAL_CAJA_GENERAL, limit: 200 }).pipe(
      switchMap((c) => forkJoin({ c: of(c), v: c.rows.length ? this.libroApi.veredictos(c.rows.map((r) => r.origen_ref)) : of([]) })),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ c, v }) => { this.cola.set(c); this.filas.set(armarCola(c.rows, v)); this.cargando.set(false); },
      error: (e) => { this.error.set(this.mensaje(e, 'No se pudo leer la cola.')); this.cargando.set(false); },
    });
  }

  severidad(f: FilaVentanilla): 'secondary' | 'warn' | 'danger' {
    return f.estado === 'detenido' ? 'danger' : f.estado === 'firma' ? 'warn' : 'secondary';
  }

  loRespalda(f: FilaVentanilla): string {
    const v = f.veredicto;
    if (!v || !v.detalle.length) return v?.respaldo === 'no_medido' ? 'No se pudo medir qué paga este documento.' : 'Kepler no dice qué gasto o compra paga.';
    const partes = v.detalle.map((d) => d.tipo === 'entrada'
      ? `entrada ${d.folio} ${this.minor(d.aplicado_minor)}`
      : `gasto ${d.folio} ${this.minor(d.aplicado_minor)} · vale ${d.vale_folio ?? 'sin expediente'}${d.aprobado ? ', aprobado' : ''}`);
    return (v.respaldo === 'compra' ? 'Paga la compra: ' : 'Paga: ') + partes.join(' · ');
  }

  /** PrimeNG declara `data` como `T | T[] | undefined` (admite selección múltiple): se toma sólo una fila. */
  abrirFila(data: FilaVentanilla | FilaVentanilla[] | undefined): void {
    const f = Array.isArray(data) ? data[0] : data;
    if (f && this.puedePagar()) this.abrir(f);
  }

  abrir(f: FilaVentanilla): void {
    if (f.estado === 'detenido' || !f.doc.kepler_cuenta) return;
    this.pagando.set(f);
    this.plan.set(null);
    this.piezas.set({});
    this.recibe.set('');
    this.resultado.set(null);
    this.errorPago.set(null);
    this.llave = uuidV4();
    this.libroApi.plan(f.doc.origen_ref, f.doc.kepler_cuenta).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => this.plan.set(p),
      error: (e) => this.errorPago.set(this.mensaje(e, 'No se pudo leer el documento.')),
    });
  }

  pagar(): void {
    const f = this.pagando();
    if (!f || !f.doc.kepler_cuenta || !this.listoParaPagar()) return;
    this.enviando.set(true);
    this.errorPago.set(null);
    const piezas = Object.fromEntries(Object.entries(this.piezas()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.libroApi.pagar({ origen_ref: f.doc.origen_ref, cuenta_kepler: f.doc.kepler_cuenta, piezas_cajon: piezas,
      recibe: { nombre: this.recibe().trim() } }, this.llave).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.resultado.set(r); this.enviando.set(false); },
      error: (e) => { this.errorPago.set(this.mensaje(e, 'No se pagó.')); this.enviando.set(false); },
    });
  }

  cerrar(): void {
    const pagado = !!this.resultado();
    this.pagando.set(null);
    this.plan.set(null);
    this.resultado.set(null);
    if (pagado) this.cargar();
  }

  /** El servidor del libro responde `{ codigo, mensaje }`; el resto de la API, `{ message }`. */
  private mensaje(e: unknown, porDefecto: string): string {
    const err = (e as { error?: { mensaje?: string; message?: string | string[] } })?.error;
    const m = err?.mensaje ?? err?.message;
    return (Array.isArray(m) ? m.join(' ') : m) || porDefecto;
  }
}
