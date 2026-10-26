import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { AutoCompleteModule, AutoCompleteCompleteEvent, AutoCompleteSelectEvent } from 'primeng/autocomplete';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { money, dmy } from '../finanzas-format';
import {
  CashLedgerService, type CoberturaCuentasKepler, type ConceptoKepler, type EntidadDeclarada,
} from '../../cash-ledger.service';

/**
 * ⭐ `[CGA-A.19]` **Cuentas de Kepler — la configuración de con qué cuenta va cada movimiento.**
 *
 * Edgar, 2026-10-23: *«hay que hacer que el 100 % tenga una cuenta de Kepler ligada, y además un
 * sistema de configuración en caso hipotético que alguna no lo tenga»*.
 *
 * La pregunta que contesta, en una frase: **¿todos los movimientos de la cola tienen su cuenta, y
 * si no, cuál le falta y cómo se la doy?** Por eso abre con la cobertura medida sobre el universo
 * (no sobre la página de la cola), sigue con lo que falta —agrupado por entidad, porque es lo que
 * se declara— y termina con lo ya declarado, que se puede cambiar o quitar.
 *
 * Jerarquía (Q.5): primario = cuántos de cuántos tienen cuenta; secundario = la lista de lo que
 * falta; terciario = de dónde sale la cuenta de los demás y lo ya declarado.
 *
 * ⛔ La cuenta de casi todo NO se declara: sale de la póliza del documento o, si la póliza no
 * llegó, del tipo de documento. Declarar es el residuo — póliza repartida, tipo sin cuenta única —
 * y por eso declarar exige motivo: es una decisión contable que alguien tiene que poder revisar.
 */
@Component({
  selector: 'app-caja-cuentas-kepler',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, InputTextModule, TextareaModule, TableModule, TagModule, AutoCompleteModule,
    MetricStripComponent, LoadStateComponent, FreshnessPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ck">
      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" [skeletonRows]="4" (retry)="cargar()">
        @if (cob(); as c) {
          <div class="ck-head">
            @if (c.datos_al) {
              <app-freshness-pill measures="data" [since]="c.datos_al" label="Kepler" />
            } @else {
              <span class="ck-warn">frescura sin medir</span>
            }
          </div>
          <app-metric-strip [items]="kpis()" ariaLabel="Cobertura de cuentas de Kepler" density="compact" />
          <p class="ck-alcance">
            Medido sobre los {{ c.universo }} movimientos de la cola del {{ fecha(c.desde) }} al {{ fecha(c.hasta) }}, no sólo los que se ven en la página.
            @if (c.truncado) {
              <strong class="ck-warn">La cola pasa de {{ c.tope }} movimientos: las cifras son de los primeros {{ c.tope }} y no alcanzan para afirmar el total.</strong>
            }
          </p>

          @if (fuentes().length) {
            <ul class="ck-fuentes" aria-label="De dónde sale la cuenta">
              @for (f of fuentes(); track f.fuente) {
                <li><span class="ck-num">{{ f.movimientos }}</span> {{ f.texto }}</li>
              }
            </ul>
          }

          <section class="ck-sec" aria-labelledby="ck-sin">
            <h4 id="ck-sin" class="ck-h">Sin cuenta</h4>
            @if (c.sin_cuenta_por_entidad.length) {
              <!-- D.7: las filas llevan una accion; pSelectableRow = flechas + Home/End y la tabla es UN stop de Tab. -->
              <p-table [value]="c.sin_cuenta_por_entidad" size="small" selectionMode="single" [(selection)]="filaSin" class="surf-table surf-table--plain" [tableStyle]="{ 'min-width': '40rem' }">
                <ng-template #header>
                  <tr>
                    <th scope="col">Entidad</th>
                    <th scope="col">Documentos</th>
                    <th scope="col" class="comm-num">Movimientos</th>
                    <th scope="col" class="comm-num">Monto</th>
                    <th scope="col"><span class="sr-only">Acción</span></th>
                  </tr>
                </ng-template>
                <ng-template #body let-g>
                  <tr [pSelectableRow]="g">
                    <td>
                      <div>{{ g.beneficiario || 'Sin beneficiario' }}</div>
                      <small class="ck-dim mono">{{ g.entidad_code || 'sin código de entidad' }}</small>
                    </td>
                    <td class="mono">{{ g.doc_tipos.join(', ') }}</td>
                    <td class="comm-num">{{ g.movimientos }}</td>
                    <td class="comm-num">{{ dinero(g.monto) }}</td>
                    <td>
                      @if (g.entidad_code && puedeDeclarar()) {
                        <p-button label="Declarar cuenta" icon="pi pi-pencil" size="small" severity="secondary" [outlined]="true"
                                  (onClick)="abrir(g.entidad_code, g.beneficiario)"></p-button>
                      } @else if (!g.entidad_code) {
                        <small class="ck-dim">Sin código no se puede declarar: captúralo a mano.</small>
                      }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            } @else if (!c.truncado) {
              <p class="ck-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Todos los movimientos de la cola tienen su cuenta de Kepler.</p>
            }
          </section>
        }
      </app-load-state>

      @if (form(); as fm) {
        <section class="ck-sec ck-form" aria-labelledby="ck-form-h">
          <h4 id="ck-form-h" class="ck-h">{{ fm.nuevo ? 'Declarar la cuenta de una entidad' : 'Cambiar la cuenta de ' + fm.entidad }}</h4>
          @if (fm.beneficiario) { <p class="ck-dim">{{ fm.beneficiario }}</p> }
          <div class="ck-campo">
            <label for="ck-entidad">Entidad de Kepler</label>
            <input pInputText id="ck-entidad" class="mono" [ngModel]="fm.entidad" (ngModelChange)="setForm({ entidad: $event })"
                   [readonly]="!fm.nuevo" placeholder="GG022, CP036, CONTADO…" autocomplete="off" />
          </div>
          <div class="ck-campo">
            <label for="ck-concepto">Cuenta y concepto</label>
            <p-autocomplete inputId="ck-concepto" [(ngModel)]="conceptoSel" [suggestions]="conceptos()"
                            (completeMethod)="buscar($event)" (onSelect)="elegir($event)" optionLabel="label"
                            [delay]="250" [minQueryLength]="2" placeholder="Busca por nombre, cuenta o código"
                            appendTo="body" class="ck-full"></p-autocomplete>
          </div>
          <div class="ck-campo">
            <label for="ck-motivo">Por qué es esta cuenta</label>
            <textarea pTextarea id="ck-motivo" rows="2" class="ck-full" [ngModel]="fm.motivo" (ngModelChange)="setForm({ motivo: $event })"
                      placeholder="Ej.: es la caja chica de Morelia Madero; Kepler la asienta contra la 102/037"></textarea>
            <small [class]="motivoCorto() ? 'ck-warn' : 'ck-dim'">Mínimo 10 caracteres: una cuenta sin motivo no se puede revisar después.</small>
          </div>
          <p class="ck-dim">Aplica a todos los movimientos de esta entidad de aquí en adelante, cuando su póliza no diga otra cosa. Lo ya confirmado no cambia.</p>
          @if (errorForm()) { <p class="ck-warn" role="alert">{{ errorForm() }}</p> }
          <div class="ck-acciones">
            <p-button label="Guardar" icon="pi pi-check" [disabled]="!formValido() || guardando()" [loading]="guardando()" (onClick)="guardar()"></p-button>
            <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cerrarForm()"></p-button>
          </div>
        </section>
      }

      <section class="ck-sec" aria-labelledby="ck-dec">
        <div class="ck-sec-head">
          <h4 id="ck-dec" class="ck-h">Declaradas a mano</h4>
          @if (puedeDeclarar() && !form()) {
            <p-button label="Declarar otra entidad" icon="pi pi-plus" size="small" severity="secondary" [text]="true" (onClick)="abrir(null, null)"></p-button>
          }
        </div>
        <app-load-state [loading]="cargandoDec()" [error]="errorDec()" [isEmpty]="!declaradas().length" [skeletonRows]="2"
                        emptyTitle="Ninguna declarada" emptyHint="Todo lo que tiene cuenta la saca de Kepler: la póliza o el tipo de documento."
                        (retry)="cargarDeclaradas()">
          <p-table [value]="declaradas()" size="small" dataKey="entidad_code" selectionMode="single" [(selection)]="filaDec" class="surf-table surf-table--plain" [tableStyle]="{ 'min-width': '40rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Entidad</th>
                <th scope="col">Cuenta / concepto</th>
                <th scope="col">Motivo</th>
                <th scope="col">Declaró</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-d>
              <tr [pSelectableRow]="d">
                <td class="mono">{{ d.entidad_code }}</td>
                <td class="mono">{{ d.kepler_cuenta }} / {{ d.kepler_concepto }}</td>
                <td>{{ d.motivo }}</td>
                <td><div>{{ d.declarada_por_username || 'sin usuario' }}</div><small class="ck-dim">{{ fecha(d.updated_at) }}</small></td>
                <td class="ck-fila-acc">
                  @if (puedeDeclarar()) {
                    @if (quitando() === d.entidad_code) {
                      <span class="ck-dim">¿Quitarla?</span>
                      <p-button label="Sí, quitar" severity="danger" size="small" [text]="true" [disabled]="borrando()" (onClick)="quitar(d.entidad_code)"></p-button>
                      <p-button label="No" severity="secondary" size="small" [text]="true" (onClick)="quitando.set(null)"></p-button>
                    } @else {
                      <p-button label="Cambiar" icon="pi pi-pencil" size="small" severity="secondary" [text]="true" (onClick)="abrir(d.entidad_code, null, d)"></p-button>
                      <p-button label="Quitar" icon="pi pi-trash" size="small" severity="danger" [text]="true" (onClick)="quitando.set(d.entidad_code)"></p-button>
                    }
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
        @if (errorForm() && !form()) { <p class="ck-warn" role="alert">{{ errorForm() }}</p> }
        @if (!puedeDeclarar()) {
          <p class="ck-dim">Declarar o quitar una cuenta lo hace quien puede autorizar la caja: decide la cuenta de todos los movimientos de esa entidad.</p>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ck { display: flex; flex-direction: column; gap: var(--sp-4); }
    .ck-head { display: flex; justify-content: flex-end; }
    .ck-alcance { margin: var(--sp-2) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .ck-fuentes { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-4);
      color: var(--text-muted); font-size: var(--fs-sm); }
    .ck-num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-main); }
    .ck-sec { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ck-sec-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
    .ck-h { margin: 0; font-size: var(--fs-h3); font-weight: 600; color: var(--text-main); }
    .ck-dim { color: var(--text-muted); font-size: var(--fs-sm); margin: 0; }
    .ck-warn { color: var(--warn-fg); font-size: var(--fs-sm); }
    .ck-ok { margin: 0; color: var(--ok-fg); display: flex; align-items: center; gap: var(--sp-2); }
    .ck-form { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); }
    .ck-campo { display: flex; flex-direction: column; gap: var(--sp-1); }
    .ck-full { width: 100%; }
    .ck-acciones { display: flex; gap: var(--sp-2); }
    .ck-fila-acc { white-space: nowrap; text-align: right; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  `],
})
export class CajaCuentasKeplerComponent implements OnInit {
  private readonly svc = inject(CashLedgerService);
  private readonly destroyRef = inject(DestroyRef);

  /** Sucursal del catálogo de conceptos con que se valida lo declarado. */
  readonly sucursal = input<string>(SUCURSAL_CAJA_GENERAL);
  /** Llave FINANCE_CAJA_AUTORIZAR: decidir la cuenta de toda una entidad. El servidor la vuelve a exigir. */
  readonly puedeDeclarar = input<boolean>(false);
  /** Abre el formulario ya puesto en esta entidad (llega desde la ficha de un movimiento sin cuenta). */
  readonly entidadInicial = input<{ entidad: string; beneficiario: string | null } | null>(null);
  /** Se declaró o se quitó algo: la cola de al lado tiene que volver a resolverse. */
  readonly cambio = output<void>();

  readonly cob = signal<CoberturaCuentasKepler | null>(null);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);
  readonly declaradas = signal<EntidadDeclarada[]>([]);
  readonly cargandoDec = signal(true);
  readonly errorDec = signal<string | null>(null);
  readonly form = signal<{ nuevo: boolean; entidad: string; beneficiario: string | null; motivo: string } | null>(null);
  readonly conceptos = signal<Array<ConceptoKepler & { label: string }>>([]);
  conceptoSel: (ConceptoKepler & { label: string }) | null = null;
  /** Fila con el foco de teclado de cada rejilla (pSelectableRow). No decide nada. */
  filaSin: unknown = null;
  filaDec: EntidadDeclarada | null = null;
  readonly guardando = signal(false);
  readonly errorForm = signal<string | null>(null);
  readonly quitando = signal<string | null>(null);
  readonly borrando = signal(false);

  private readonly TEXTO_FUENTE: Record<string, string> = {
    documento: 'de la póliza del propio documento',
    libro_dominante: 'de la póliza, con el concepto que las personas ya eligieron para esa cuenta',
    tipo_documento: 'del tipo de documento (su póliza todavía no llega)',
    regla: 'de una regla por beneficiario',
    ruta: 'del mapa de rutas',
    declarada: 'declaradas a mano para su entidad',
  };

  readonly kpis = computed<MetricStripItem[]>(() => {
    const c = this.cob();
    if (!c) return [];
    const pct = c.universo ? (100 * c.con_cuenta.movimientos) / c.universo : null;
    return [
      {
        label: 'Con cuenta de Kepler',
        value: pct === null ? 'Cola vacía' : `${pct.toFixed(1)} %`,
        format: 'text',
        tone: pct === 100 && !c.truncado ? 'ok' : 'warn',
        sub: `${c.con_cuenta.movimientos} de ${c.universo} · ${money(c.con_cuenta.monto)}`,
        state: c.truncado ? 'parcial' : 'medido',
        stateNote: c.truncado ? `primeros ${c.tope} movimientos` : undefined,
      },
      {
        label: 'Falta elegir concepto',
        value: c.falta_concepto.movimientos,
        format: 'number',
        tone: c.falta_concepto.movimientos ? 'warn' : 'muted',
        sub: 'la cuenta está; se elige el concepto al capturar',
      },
      {
        label: 'Sin cuenta',
        value: c.sin_cuenta.movimientos,
        format: 'number',
        tone: c.sin_cuenta.movimientos ? 'bad' : 'ok',
        sub: c.sin_cuenta.movimientos ? `${money(c.sin_cuenta.monto)} · se declaran abajo` : 'nada que declarar',
      },
    ];
  });

  readonly fuentes = computed(() => (this.cob()?.por_fuente ?? []).map((f) => ({
    ...f, texto: this.TEXTO_FUENTE[f.fuente] ?? f.fuente,
  })));

  readonly motivoCorto = computed(() => {
    const f = this.form();
    return !!f && f.motivo.trim().length > 0 && f.motivo.trim().length < 10;
  });
  readonly formValido = computed(() => {
    const f = this.form();
    return !!f && !!f.entidad.trim() && f.motivo.trim().length >= 10 && !!this.conceptoElegido();
  });
  /** El autocomplete escribe un objeto o un texto: sólo un objeto del catálogo es un par válido. */
  private readonly conceptoElegido = signal<ConceptoKepler | null>(null);

  ngOnInit(): void {
    this.cargar();
    this.cargarDeclaradas();
    const ini = this.entidadInicial();
    if (ini?.entidad) this.abrir(ini.entidad, ini.beneficiario);
  }

  cargar(): void {
    this.cargando.set(true); this.error.set(null);
    this.svc.coberturaCuentasKepler().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => { this.cob.set(c); this.cargando.set(false); },
      error: () => { this.error.set('No se pudo medir la cobertura de cuentas.'); this.cargando.set(false); },
    });
  }

  cargarDeclaradas(): void {
    this.cargandoDec.set(true); this.errorDec.set(null);
    this.svc.declaradas().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.declaradas.set(d ?? []); this.cargandoDec.set(false); },
      error: () => { this.errorDec.set('No se pudieron leer las declaraciones.'); this.cargandoDec.set(false); },
    });
  }

  abrir(entidad: string | null, beneficiario: string | null, actual?: EntidadDeclarada): void {
    this.quitando.set(null);
    this.form.set({ nuevo: !entidad, entidad: entidad ?? '', beneficiario, motivo: actual?.motivo ?? '' });
    if (actual) {
      const c: ConceptoKepler = { sucursal: this.sucursal(), cuenta: actual.kepler_cuenta, concepto: actual.kepler_concepto, concepto_nombre: '', cuenta_mayor: '' };
      this.conceptoSel = { ...c, label: `${c.cuenta} / ${c.concepto}` };
      this.conceptoElegido.set(c);
    } else {
      this.conceptoSel = null;
      this.conceptoElegido.set(null);
    }
  }

  cerrarForm(): void { this.form.set(null); this.conceptoSel = null; this.conceptoElegido.set(null); this.errorForm.set(null); }

  setForm(p: Partial<{ entidad: string; motivo: string }>): void {
    const f = this.form();
    if (f) this.form.set({ ...f, ...p });
    this.errorForm.set(null);
  }

  buscar(e: AutoCompleteCompleteEvent): void {
    this.conceptoElegido.set(null);
    this.svc.conceptos(this.sucursal() || undefined, e.query || '', 30).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.conceptos.set((r.rows ?? []).map((c) => ({
        ...c, label: `${c.cuenta} / ${c.concepto} · ${c.concepto_nombre}`,
      }))),
      error: () => this.conceptos.set([]),
    });
  }

  elegir(e: AutoCompleteSelectEvent): void {
    const c = e.value as ConceptoKepler;
    this.conceptoElegido.set(c?.cuenta && c?.concepto ? c : null);
  }

  guardar(): void {
    const f = this.form(); const c = this.conceptoElegido();
    // Se deshabilita SÍNCRONO, antes de esperar la respuesta: el doble clic no declara dos veces.
    if (!f || !c || !this.formValido() || this.guardando()) return;
    this.guardando.set(true);
    this.svc.declararEntidad({
      entidad_code: f.entidad.trim(), kepler_cuenta: c.cuenta, kepler_concepto: c.concepto,
      motivo: f.motivo.trim(), sucursal: c.sucursal || this.sucursal(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.guardando.set(false); this.cerrarForm(); this.recargar(); },
      error: (err) => {
        this.guardando.set(false);
        this.errorForm.set(err?.error?.message ?? 'No se pudo guardar la declaración.');
      },
    });
  }

  quitar(entidad: string): void {
    if (this.borrando()) return;
    this.borrando.set(true);
    this.svc.quitarDeclarada(entidad).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.borrando.set(false); this.quitando.set(null); this.recargar(); },
      error: (err) => {
        this.borrando.set(false);
        this.errorForm.set(err?.error?.message ?? 'No se pudo quitar la declaración.');
      },
    });
  }

  private recargar(): void {
    this.cargar();
    this.cargarDeclaradas();
    this.cambio.emit();
  }

  dinero(n: number): string { return money(Number(n)); }
  fecha(v: string | null | undefined): string { return dmy(v); }
}
