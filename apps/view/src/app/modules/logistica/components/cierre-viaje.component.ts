import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { SelectModule } from 'primeng/select';
import { TextareaModule } from 'primeng/textarea';
import type {
  AltaRapidaResultado, CierreDeEmbarque, ConceptoPago, MotivoNoEntrega, PagoViaje, ParadaCierre, ResultadoParada,
} from '@megadulces/contracts';
// Por subruta, no por el barrel: ver tsconfig.base.json (bundle inicial).
import {
  CONCEPTO_KEPLER, erroresDeCierreDeParada, ESTADO_VIAJE_LABEL, MOTIVO_NO_ENTREGA_LABEL, seCierraEnLaSuite,
} from '@megadulces/contracts/http/cierre-viaje';
import { Driver, LogisticaService } from '../logistica.service';
import { AltaPersonaComponent } from './alta-persona.component';

interface FilaPersona {
  driver_id: string;
  persona: string;
  rol: string;
  montos: Record<ConceptoPago, number>;
  total: number;
  estado: 'liberado' | 'retenido' | 'en_vale';
  motivo: string;
}

const TIPO_LABEL: Record<string, string> = {
  traspaso: 'Traspaso', cliente: 'Cliente', carga_ruta: 'Carga a ruta', otro: 'Otro', manual: 'Manual', sin_documento: 'Sin documento',
};

/**
 * EMB.24–EMB.27 — Cierre y pago del viaje (ADR-091). Muestra cómo se cerró cada parada (traspaso
 * con la recepción de Kepler, cliente con la entrega que registra Logística), registra quién cargó y dice qué
 * se libera para cada persona. El estado lo calcula la base: esta pantalla no decide nada.
 */
@Component({
  selector: 'app-cierre-viaje',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DialogModule, InputTextModule, MultiSelectModule, SelectModule, TextareaModule, AltaPersonaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <div class="cv-msg cv-msg-bad" role="alert">{{ error() }}</div>
    }
    @if (data(); as d) {
      @for (v of d.viajes; track v.guide_id) {
        <section class="cv-banner" [attr.data-estado]="v.estado_viaje" aria-live="polite">
          <div class="cv-banner-main">
            <span class="cv-pill" [attr.data-estado]="v.estado_viaje">{{ estadoLabel(v.estado_viaje) }}</span>
            <strong>{{ v.paradas_cerradas + v.paradas_con_diferencia }} de {{ v.paradas }} paradas cerradas</strong>
            <span class="cv-sub">{{ v.guide_number }}@if (v.kepler_guia) { · guía Kepler {{ v.kepler_sucursal }}-{{ v.kepler_guia }} }</span>
          </div>
          <div class="cv-banner-text">{{ textoViaje(v.estado_viaje, v.paradas_pendientes, v.paradas_con_diferencia) }}</div>
        </section>
      }

      <section class="cv-block">
        <header class="cv-head">
          <h3>Paradas y cómo se cerró cada una</h3>
          <span class="cv-sub">Traspaso: con la recepción de la sucursal destino en Kepler · Cliente: con la entrega que registra Logística</span>
        </header>
        <div class="cv-scroll dt-scope">
          <table class="cv-table dt-stack">
            <thead>
              <tr>
                <th scope="col">#</th><th scope="col">Destino</th><th scope="col">Tipo</th><th scope="col">Embarque Kepler</th>
                <th scope="col" class="num">Embarcado</th><th scope="col">Cómo se cerró</th><th scope="col">Estado</th><th scope="col"><span class="sr-only">Acción</span></th>
              </tr>
            </thead>
            <tbody>
              @for (p of d.paradas; track p.recipient_id; let i = $index) {
                <tr [class.cv-row-bad]="p.estado_parada === 'diferencia'">
                  <td class="num" role="cell" data-label="#">{{ p.sequence_order ?? i + 1 }}</td>
                  <td class="dt-id" role="cell" data-label="Destino">{{ p.customer_name }}@if (p.destino_code) { <span class="cv-sub">{{ p.destino_code }}</span> }</td>
                  <td role="cell" data-label="Tipo">{{ tipoLabel(p.tipo_parada) }}</td>
                  <td role="cell" data-label="Embarque Kepler"><code>{{ p.kepler_folio ? 'UD41' + (p.kepler_serie === '2' ? '02' : '01') + '-' + p.kepler_folio : '—' }}</code></td>
                  <td class="num dt-num" role="cell" data-label="Embarcado">{{ (p.importe_embarcado ?? p.value) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                  <td role="cell" data-label="Cómo se cerró">
                    {{ p.motivo }}
                    @if (p.recepcion_folio) {
                      <span class="cv-sub">Recepción UA5001-{{ p.recepcion_folio }} · {{ p.recepcion_importe | currency:'MXN':'symbol-narrow':'1.2-2' }} · {{ p.recepcion_fecha }}</span>
                    }
                    @if (p.diferencia && p.estado_parada === 'diferencia') {
                      <span class="cv-sub cv-bad">Diferencia {{ p.diferencia | currency:'MXN':'symbol-narrow':'1.2-2' }} · no frena el pago del viaje</span>
                    }
                    @if (p.delivered_to) { <span class="cv-sub">Recibió: {{ p.delivered_to }}</span> }
                    @if (p.incident_type) { <span class="cv-sub">{{ motivoLabel(p.incident_type) }}@if (p.incident_notes) { · {{ p.incident_notes }} }</span> }
                    @if (p.remision_url) { <a class="cv-sub" [href]="p.remision_url" target="_blank" rel="noopener">Ver remisión</a> }
                  </td>
                  <td role="cell" data-label="Estado"><span class="cv-pill" [attr.data-estado]="p.estado_parada">{{ estadoParadaLabel(p.estado_parada) }}</span></td>
                  <td class="dt-actions" role="cell" data-label="Acción">
                    @if (puedeCerrar(p)) {
                      <button pButton type="button" size="small" (click)="abrirCierre(p)"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Registrar entrega</span></button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8" class="cv-empty" role="cell">Este embarque no tiene paradas registradas.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="cv-block">
        <header class="cv-head">
          <h3>Quién cargó</h3>
          @if (d.tarifa_carga) {
            <span class="cv-sub">{{ d.tarifa_carga | currency:'MXN':'symbol-narrow':'1.2-2' }} por persona · se libera porque el embarque ya está en Kepler</span>
          }
        </header>
        @if (!d.tarifa_carga) {
          <div class="cv-msg cv-msg-warn">Falta capturar la tarifa de carga por persona en Logística › Configuración. Sin tarifa no se registran cargadores: un cero sería no pagar.</div>
        } @else {
          <div class="cv-loaders">
            <label class="sr-only" for="cv-cargadores">Cargadores</label>
            <div class="cv-ms">
              <p-multiselect inputId="cv-cargadores" [options]="opcionesCargadores()" optionLabel="full_name" optionValue="id"
                [(ngModel)]="seleccion" [filter]="true" placeholder="Elige a quienes cargaron" display="chip"
                [disabled]="cargaPagada()" (onFilter)="filtroCargador.set($event.filter ?? '')">
                <ng-template #footer>
                  <div class="cv-alta-pie">
                    <button pButton type="button" size="small" [text]="true" (click)="altaCargadorVisible.set(true)"><span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span><span class="p-button-label">Nuevo cargador</span></button>
                  </div>
                </ng-template>
              </p-multiselect>
              <app-alta-persona rol="cargador" [nombreInicial]="filtroCargador()" [visible]="altaCargadorVisible()"
                (visibleChange)="altaCargadorVisible.set($event)" (creada)="cargadorCreado($event)"></app-alta-persona>
            </div>
            <button pButton type="button" [loading]="guardandoCarga()"
              [disabled]="cargaPagada()" (click)="guardarCargadores()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Guardar cargadores</span></button>
          </div>
          @if (cargaPagada()) { <div class="cv-sub">La carga ya está en un vale: no se puede cambiar.</div> }
          @if (aviso(); as a) { <div class="cv-sub" role="status">{{ a }}</div> }
        }
      </section>

      <section class="cv-block">
        <header class="cv-head">
          <h3>Lo que se libera por persona</h3>
          <span class="cv-sub">Se paga en el vale del corte de 14 días (Gastos › Comisiones de logística)</span>
        </header>
        <div class="cv-scroll dt-scope">
          <table class="cv-table dt-stack">
            <thead>
              <tr>
                <th scope="col">Persona</th><th scope="col">Papel</th>
                <th scope="col" class="num">Comisión 075</th><th scope="col" class="num">Viáticos 128</th><th scope="col" class="num">Maniobra 186</th>
                <th scope="col" class="num">Total</th><th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              @for (f of personas(); track f.driver_id + f.rol) {
                <tr>
                  <td class="dt-id" role="cell" data-label="Persona">{{ f.persona }}</td>
                  <td role="cell" data-label="Papel">{{ f.rol }}</td>
                  <td class="num dt-num" role="cell" data-label="Comisión 075">{{ f.montos.comision ? (f.montos.comision | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num dt-num" role="cell" data-label="Viáticos 128">{{ f.montos.viatico ? (f.montos.viatico | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num dt-num" role="cell" data-label="Maniobra 186">{{ f.montos.maniobra_carga ? (f.montos.maniobra_carga | currency:'MXN':'symbol-narrow':'1.2-2') : '—' }}</td>
                  <td class="num dt-num" role="cell" data-label="Total"><strong>{{ f.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</strong></td>
                  <td role="cell" data-label="Estado">
                    <span class="cv-pill" [attr.data-estado]="f.estado">{{ f.estado === 'liberado' ? 'Liberado' : f.estado === 'en_vale' ? 'En vale' : 'Retenido' }}</span>
                    @if (f.estado === 'retenido') { <span class="cv-sub">{{ f.motivo }}</span> }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="cv-empty" role="cell">Todavía no hay montos: completa la guía (chofer, ayudantes y horario) y registra a los cargadores.</td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    } @else if (!error()) {
      <div class="cv-empty">Cargando el cierre del viaje…</div>
    }

    <p-dialog header="Registrar entrega" [visible]="dialogo()" (visibleChange)="dialogo.set($event)" [modal]="true" [style]="{ width: '30rem', maxWidth: '95vw' }">
      @if (parada(); as p) {
        <div class="cv-form">
          <div class="cv-sub">{{ p.customer_name }} · {{ (p.importe_embarcado ?? p.value) | currency:'MXN':'symbol-narrow':'1.2-2' }}</div>
          <fieldset class="cv-radio">
            <legend>¿Se entregó?</legend>
            <label><input type="radio" name="cv-res" value="entregado" [ngModel]="resultado()" (ngModelChange)="resultado.set($event)"> Sí, se entregó</label>
            <label><input type="radio" name="cv-res" value="no_entregado" [ngModel]="resultado()" (ngModelChange)="resultado.set($event)"> No se pudo entregar</label>
          </fieldset>
          @if (resultado() === 'entregado') {
            <label for="cv-recibio">Quién recibió</label>
            <input pInputText id="cv-recibio" [ngModel]="recibio()" (ngModelChange)="recibio.set($event)" autocomplete="off">
          } @else {
            <label for="cv-motivo">Por qué no se entregó</label>
            <p-select inputId="cv-motivo" [options]="motivos" optionLabel="label" optionValue="value" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)" placeholder="Elige el motivo"></p-select>
          }
          <label for="cv-nota">Nota (opcional)</label>
          <textarea pTextarea id="cv-nota" rows="2" [ngModel]="nota()" (ngModelChange)="nota.set($event)"></textarea>
          @if (erroresForm().length) {
            <ul class="cv-errs">@for (e of erroresForm(); track e) { <li>{{ e }}</li> }</ul>
          }
        </div>
      }
      <ng-template #footer>
        <button pButton type="button" severity="secondary" [text]="true" (click)="dialogo.set(false)"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" [loading]="guardando()"
          [disabled]="erroresForm().length > 0" (click)="guardarCierre()"><span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span><span class="p-button-label">Cerrar parada</span></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .cv-banner { border: 1px solid var(--c-divider); border-radius: var(--radius-md, 10px); padding: .75rem 1rem; margin-bottom: 1rem; background: var(--c-surface-1, #fff); }
    .cv-banner[data-estado="cerrado"], .cv-banner[data-estado="cerrado_con_diferencia"] { border-color: var(--ok-border); }
    .cv-banner[data-estado="abierto"] { border-color: var(--warn-border); }
    .cv-banner-main { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .cv-banner-text { margin-top: .25rem; font-size: var(--fs-sm); color: var(--c-text-2); }
    .cv-block { margin-bottom: 1.25rem; }
    .cv-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem; align-items: baseline; margin-bottom: .5rem; }
    .cv-head h3 { margin: 0; font-size: var(--fs-md, 1rem); font-weight: var(--fw-bold); }
    .cv-scroll { overflow-x: auto; }
    .cv-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .cv-table th { text-align: left; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); padding: .45rem .5rem; border-bottom: 1px solid var(--c-divider); }
    .cv-table td { padding: .5rem; border-bottom: 1px solid var(--c-surface-2); vertical-align: top; }
    .cv-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cv-table code { font-family: var(--font-mono); font-size: var(--fs-xs); }
    .cv-row-bad td { background: var(--bad-soft-bg); }
    .cv-sub { display: block; font-size: var(--fs-xs); color: var(--c-text-2); }
    .cv-bad { color: var(--bad-soft-fg); font-weight: var(--fw-medium); }
    .cv-pill { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: var(--fs-xs); font-weight: var(--fw-medium); white-space: nowrap; background: var(--c-surface-2); color: var(--c-text-1); }
    .cv-pill[data-estado="cerrada"], .cv-pill[data-estado="cerrado"], .cv-pill[data-estado="liberado"] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .cv-pill[data-estado="cerrado_con_diferencia"], .cv-pill[data-estado="diferencia"] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .cv-pill[data-estado="pendiente"], .cv-pill[data-estado="abierto"], .cv-pill[data-estado="retenido"], .cv-pill[data-estado="guia_incompleta"] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cv-pill[data-estado="en_vale"] { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .cv-loaders { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .cv-ms { min-width: 18rem; max-width: 100%; }
    .cv-ms ::ng-deep .p-multiselect { width: 100%; }
    .cv-alta-pie { padding: .25rem .5rem .5rem; border-top: 1px solid var(--c-surface-2); }
    .cv-msg { padding: .6rem .8rem; border-radius: 8px; font-size: var(--fs-sm); margin-bottom: .75rem; }
    .cv-msg-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .cv-msg-bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .cv-empty { padding: 1rem; color: var(--c-text-2); font-size: var(--fs-sm); }
    .cv-form { display: flex; flex-direction: column; gap: .5rem; }
    .cv-form label { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
    .cv-radio { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .35rem; }
    .cv-radio legend { font-size: var(--fs-sm); font-weight: var(--fw-medium); margin-bottom: .25rem; }
    .cv-radio label { font-weight: var(--fw-regular, 400); display: flex; gap: .4rem; align-items: center; min-height: 32px; }
    .cv-errs { margin: 0; padding-left: 1.1rem; color: var(--bad-soft-fg); font-size: var(--fs-xs); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class CierreViajeComponent {
  private readonly api = inject(LogisticaService);

  readonly shipmentId = input.required<string>();
  /** El padrón de logística (choferes, ayudantes, cargadores) para elegir a quienes cargaron. */
  readonly drivers = input<Driver[]>([]);
  /** `[EMB.32]` Los dados de alta aquí mismo, mientras el padrón del padre no se recarga. */
  readonly altas = signal<Driver[]>([]);
  readonly altaCargadorVisible = signal(false);
  readonly filtroCargador = signal('');
  readonly aviso = signal<string | null>(null);

  readonly data = signal<CierreDeEmbarque | null>(null);
  readonly error = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly guardandoCarga = signal(false);

  seleccion: string[] = [];
  readonly dialogo = signal(false);
  readonly parada = signal<ParadaCierre | null>(null);
  readonly resultado = signal<ResultadoParada>('entregado');
  readonly recibio = signal('');
  readonly motivo = signal<MotivoNoEntrega | null>(null);
  readonly nota = signal('');

  readonly motivos = (Object.keys(MOTIVO_NO_ENTREGA_LABEL) as MotivoNoEntrega[]).map((value) => ({ value, label: MOTIVO_NO_ENTREGA_LABEL[value] }));

  readonly opcionesCargadores = computed(() =>
    [...this.drivers().filter((d) => !this.altas().some((a) => a.id === d.id)), ...this.altas()].filter((d) => d.active && d.status === 'activo').slice().sort((a, b) => a.full_name.localeCompare(b.full_name)),
  );
  readonly cargaPagada = computed(() => (this.data()?.cargadores ?? []).some((c) => c.pagado));

  readonly personas = computed<FilaPersona[]>(() => agruparPorPersona(this.data()?.pagos ?? []));

  readonly erroresForm = computed(() => {
    const p = this.parada();
    if (!p) return [];
    return erroresDeCierreDeParada(
      { resultado: this.resultado(), recibio: this.recibio(), motivo: this.motivo(), nota: this.nota() },
      p,
    );
  });

  constructor() {
    effect(() => {
      const id = this.shipmentId();
      if (id) this.cargar(id);
    });
  }

  cargar(id = this.shipmentId()) {
    this.error.set(null);
    this.api.getCierre(id).subscribe({
      next: (d) => {
        this.data.set(d);
        this.seleccion = d.cargadores.map((c) => c.driver_id);
      },
      error: (e) => this.error.set(e?.error?.message ?? 'No se pudo leer el cierre del viaje.'),
    });
  }

  puedeCerrar(p: ParadaCierre) {
    return seCierraEnLaSuite(p.tipo_parada) && p.recipient_status === 'pendiente';
  }

  abrirCierre(p: ParadaCierre) {
    this.parada.set(p);
    this.resultado.set('entregado');
    this.recibio.set('');
    this.motivo.set(null);
    this.nota.set('');
    this.dialogo.set(true);
  }

  guardarCierre() {
    const p = this.parada();
    if (!p || this.erroresForm().length) return;
    this.guardando.set(true);
    this.api.cerrarParada(p.recipient_id, {
      resultado: this.resultado(), recibio: this.recibio(), motivo: this.motivo(), nota: this.nota(),
    }).subscribe({
      next: () => { this.guardando.set(false); this.dialogo.set(false); this.cargar(); },
      error: (e) => { this.guardando.set(false); this.error.set(e?.error?.message ?? 'No se pudo cerrar la parada.'); this.dialogo.set(false); },
    });
  }

  guardarCargadores() {
    this.guardandoCarga.set(true);
    this.api.setCargadores(this.shipmentId(), this.seleccion).subscribe({
      next: (d) => { this.guardandoCarga.set(false); this.data.set(d); this.seleccion = d.cargadores.map((c) => c.driver_id); },
      error: (e) => { this.guardandoCarga.set(false); this.error.set(e?.error?.message ?? 'No se pudieron guardar los cargadores.'); },
    });
  }

  /** `[EMB.32]` El cargador nuevo (o el que ya existía) entra a la lista y queda elegido. */
  cargadorCreado(r: AltaRapidaResultado & { mensaje: string }): void {
    const d = r.driver as unknown as Driver;
    this.altas.update((xs) => [...xs.filter((x) => x.id !== d.id), d]);
    if (!this.seleccion.includes(d.id)) this.seleccion = [...this.seleccion, d.id];
    this.filtroCargador.set('');
    this.aviso.set(r.mensaje + ' Falta «Guardar cargadores».');
  }

  tipoLabel(t: string) { return TIPO_LABEL[t] ?? t; }
  estadoLabel(e: keyof typeof ESTADO_VIAJE_LABEL) { return ESTADO_VIAJE_LABEL[e] ?? e; }
  estadoParadaLabel(e: string) { return ({ cerrada: 'Cerrada', diferencia: 'Diferencia', pendiente: 'Pendiente' } as Record<string, string>)[e] ?? e; }
  motivoLabel(m: MotivoNoEntrega) { return MOTIVO_NO_ENTREGA_LABEL[m] ?? m; }
  concepto(c: ConceptoPago) { return CONCEPTO_KEPLER[c]; }

  textoViaje(e: string, pendientes: number, dif: number): string {
    switch (e) {
      case 'cerrado': return 'Todas las paradas cuadran: la comisión y los viáticos quedan liberados para el corte.';
      case 'cerrado_con_diferencia': return `Viaje cerrado: se libera el pago. ${dif} parada${dif === 1 ? '' : 's'} con diferencia queda${dif === 1 ? '' : 'n'} marcada${dif === 1 ? '' : 's'} para revisar.`;
      case 'abierto': return `Faltan ${pendientes} parada${pendientes === 1 ? '' : 's'} por cerrar: hasta entonces la comisión y los viáticos quedan retenidos.`;
      case 'guia_incompleta': return 'Completa la guía en la pestaña Guías (chofer, ayudantes y horario): sin eso no hay montos que liberar.';
      case 'sin_paradas': return 'La guía no tiene paradas: no se puede cerrar.';
      default: return 'Viaje cancelado.';
    }
  }
}

/** Una fila por persona y papel, con el estado más atrasado de sus renglones. */
export function agruparPorPersona(pagos: PagoViaje[]): FilaPersona[] {
  const m = new Map<string, FilaPersona>();
  for (const p of pagos) {
    if (p.estado_viaje === 'cancelado') continue;
    const k = `${p.driver_id}|${p.rol}`;
    const estado: FilaPersona['estado'] = p.en_vale ? 'en_vale' : p.liberado ? 'liberado' : 'retenido';
    const f = m.get(k) ?? {
      driver_id: p.driver_id, persona: p.persona, rol: p.rol,
      montos: { comision: 0, viatico: 0, maniobra_carga: 0 }, total: 0, estado, motivo: p.motivo,
    };
    f.montos[p.concept] = Math.round((f.montos[p.concept] + p.amount) * 100) / 100;
    f.total = Math.round((f.total + p.amount) * 100) / 100;
    if (estado === 'retenido') { f.estado = 'retenido'; f.motivo = p.motivo; }
    m.set(k, f);
  }
  const orden = { chofer: 0, ayudante: 1, cargador: 2 } as Record<string, number>;
  return [...m.values()].sort((a, b) => (orden[a.rol] ?? 9) - (orden[b.rol] ?? 9) || a.persona.localeCompare(b.persona));
}
