import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import {
  ETIQUETA_DECISION_COSTO, MOTIVO_MINIMO, maximoReclamable, validarDecision,
  type AplicacionCosto, type DecisionCosto, type DecisionCostoGuardada, type NuevaDecisionCosto, type RenglonCostoConDecision,
} from '@megadulces/contracts/http/application-cost';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CostoAplicadoService } from '../costo-aplicado.service';

/** El renglón de Kepler del panel: de ahí sale el nombre del producto. */
export interface LineaKeplerNombre {
  linea: string;
  nombre: string | null;
}

const llave = (r: Pick<RenglonCostoConDecision, 'subtipo' | 'renglon'>) => `${r.subtipo}|${r.renglon}`;
const decidible = (r: RenglonCostoConDecision) => r.cost_state === 'sube' || r.cost_state === 'baja';

/**
 * `[PQ.157]` C3 — **Costo contra la OC**, dentro del panel de Revisión de facturas (anexo R §3d–§3e).
 *
 * La pregunta: ¿esta aplicación se aplicó al costo de su OC? Primario, el veredicto en una línea; secundario, sólo
 * los renglones que difieren, el que más pesos mueve primero, con su decisión; terciario, la cadena y la caja.
 * Decidir (aceptar el costo, reclamar la nota, promoción) se hace en el mismo renglón y sólo con
 * COMPRAS_COSTO_DECIDIR; sin la clave, la decisión se lee. Lo tecleado y no guardado avisa al panel (capturando).
 */
@Component({
  selector: 'app-compras-costo-aplicado',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TextareaModule, InputNumberModule, DatePickerModule, SegmentedComponent],
  template: `
    <section class="ca" aria-labelledby="ca-t">
      <h3 id="ca-t" class="ca-h">Costo contra la OC</h3>
      @if (loading()) {
        <div class="ca-skel" aria-busy="true" aria-label="Comparando el costo contra la OC"><span></span><span></span></div>
      } @else if (error(); as e) {
        <p class="ca-nota">{{ e }}
          @if (reintentable()) { <button type="button" class="ca-link" (click)="cargar()">Reintentar</button> }
        </p>
      } @else if (data(); as a) {
        <!-- Primario: el veredicto en una línea. El color acompaña; lo dice la palabra. -->
        @if (!difieren().length && !resumen().comparables) {
          <!-- Nada se pudo comparar: se DICE, no se pinta como «al costo» (lo que no se midió no va en verde, regla 11). -->
          <p class="ca-ver" data-tono="neutro"><i class="pi pi-minus-circle" aria-hidden="true"></i>
            <span>Ningún renglón se pudo comparar contra su OC (ver abajo por qué).</span>
          </p>
        } @else if (!difieren().length) {
          <p class="ca-ver" data-tono="ok"><i class="pi pi-check-circle" aria-hidden="true"></i>
            <span>{{ resumen().comparables === 1 ? 'El renglón comparable se aplicó' : 'Los ' + resumen().comparables + ' renglones comparables se aplicaron' }} al costo de su OC.</span>
          </p>
        } @else {
          <div class="ca-ver" data-tono="warn">
            <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
            <div class="ca-ver-txt">
              <p class="ca-ver-t">{{ difieren().length }} de {{ a.renglones.length }} {{ a.renglones.length === 1 ? 'renglón' : 'renglones' }} a otro costo que su OC</p>
              <p class="ca-ver-s num">
                @if (resumen().suben) { {{ resumen().suben }} {{ resumen().suben === 1 ? 'sube' : 'suben' }} · {{ pesos(resumen().pesosSube, true) }} }
                @if (resumen().suben && resumen().bajan) { · }
                @if (resumen().bajan) { {{ resumen().bajan }} {{ resumen().bajan === 1 ? 'baja' : 'bajan' }} · {{ pesos(resumen().pesosBaja, true) }} }
                · @if (a.por_decidir) { <strong>{{ a.por_decidir }} por decidir</strong> } @else { todos decididos }
              </p>
            </div>
          </div>
        }
        <!-- Lo que no se comparó, cada causa con su nombre (no todo es «sin OC» ni «sin factor»). -->
        @if (resumen().sinOc) {
          <p class="ca-nota">{{ resumen().sinOc }} {{ resumen().sinOc === 1 ? 'renglón no llega' : 'renglones no llegan' }} a una OC con precio: el vale salió sin OC o la cadena en Kepler no llega a la OC.</p>
        }
        @if (resumen().sinPrecio) {
          <p class="ca-nota">{{ resumen().sinPrecio }} {{ resumen().sinPrecio === 1 ? 'renglón tiene' : 'renglones tienen' }} el precio en cero en la aplicación o en la OC.</p>
        }
        @if (resumen().sinFactor) {
          <p class="ca-nota">{{ resumen().sinFactor }} {{ resumen().sinFactor === 1 ? 'renglón tiene' : 'renglones tienen' }} la OC en otra unidad y la ficha del producto no trae el factor de caja.</p>
        }
        @if (resumen().ambiguos) {
          <p class="ca-nota">{{ resumen().ambiguos }} {{ resumen().ambiguos === 1 ? 'renglón tiene' : 'renglones tienen' }} la OC en otra unidad y la ficha trae dos factores posibles: no se adivina cuál.</p>
        }

        <!-- Terciario: el folio de la orden de entrada, que el panel no mostraba (la OC y el vale ya están en la línea
             de arriba; aquí sólo se repiten si los renglones vienen de más de una). -->
        @if (cadena(); as c) {
          <p class="ca-cadena num">
            @if (c.oe) { <span>Orden de entrada <span class="mono">{{ c.oe }}</span></span> }
            @if (c.varias) {
              <span>OC <span class="mono">{{ c.oc }}</span></span>
              <span>Vales <span class="mono">{{ c.vale }}</span></span>
            }
          </p>
        }

        <!-- Secundario: sólo lo que difiere, el que más pesos mueve primero. -->
        @if (difieren().length) {
          <!-- dt-scope: el contenedor contra el que mide el apilado del celular (UIM.1); sin él la regla es inerte. -->
          <div class="dt-scope">
          <p-table [value]="difieren()" class="ca-tbl dt-stack" size="small">
            <ng-template #header>
              <tr>
                <th>Producto</th>
                <th class="ta-r">Aplicado</th>
                <th class="ta-r">OC</th>
                <th>Diferencia</th>
                <th>Decisión</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr [class.is-abierto]="abierto() === key(r)">
                <td class="dt-id" role="cell"><div>
                  <span class="mono ca-sku">#{{ r.renglon }} · {{ r.sku }}</span>
                  <span class="ca-nombre">{{ nombre(r) }}</span>
                  <span class="ca-sub num">{{ r.quantity | number:'1.0-2' }} {{ r.unit || '' }}</span>
                </div></td>
                <td class="ta-r num" data-label="Aplicado" role="cell"><div>{{ costo(r.applied_price) }}</div></td>
                <td class="ta-r num" data-label="OC" role="cell"><div>
                  {{ costo(r.oc_price) }}
                  @if (r.escala && r.escala !== 'misma' && r.factor_escala) {
                    <span class="ca-sub">{{ r.escala === 'oc_en_unidad_mayor' ? 'la OC: ' + costo(r.oc_price_original) + ' por ' + (r.factor_escala | number:'1.0-2') : 'la OC por pieza: ' + costo(r.oc_price_original) }}</span>
                  }
                </div></td>
                <td data-label="Diferencia" role="cell"><div>
                  <span class="ca-dif" [attr.data-estado]="r.cost_state">
                    <i class="pi" [class.pi-arrow-up]="r.cost_state === 'sube'" [class.pi-arrow-down]="r.cost_state === 'baja'" aria-hidden="true"></i>
                    {{ r.cost_state === 'sube' ? 'Sube' : 'Baja' }} {{ pct(r.variacion_pct) }}
                  </span>
                  <span class="ca-sub num">{{ pesos(r.pesos_vs_oc, true) }}</span>
                </div></td>
                <td data-label="Decisión" role="cell"><div class="ca-dec">
                  @if (r.decision; as d) {
                    <span class="ca-dec-t">{{ etiqueta(d) }}</span>
                    <span class="ca-sub">«{{ d.reason }}»</span>
                    <span class="ca-quien">{{ d.created_by }} · {{ fecha(d.created_at) }}</span>
                    @if (puedeDecidir() && abierto() !== key(r)) {
                      <button type="button" class="ca-link" (click)="abrir(r)" [disabled]="ocupado()"
                              [attr.aria-label]="'Cambiar la decisión del renglón ' + r.renglon">Cambiar</button>
                    }
                  } @else {
                    @if (r.antecedente; as p) {
                      <!-- Una promoción es temporal: se dice como promoción, no como «ya se aceptó» (revisión del PR). -->
                      @if (p.decision === 'promotion') {
                        <span class="ca-ante">Este costo está en promoción hasta el {{ fecha(p.valid_until + 'T12:00:00') }} (aplicación {{ p.sucursal }}/{{ p.folio }})</span>
                      } @else {
                        <span class="ca-ante">Ya se aceptó este costo el {{ fecha(p.created_at) }} (aplicación {{ p.sucursal }}/{{ p.folio }})</span>
                      }
                    } @else {
                      <span class="ca-sin">Sin decisión</span>
                    }
                    @if (puedeDecidir() && abierto() !== key(r)) {
                      <span class="ca-acc comm-actions">
                        @if (r.antecedente; as p) {
                          <p-button [label]="p.decision === 'promotion' ? 'Promoción igual' : 'Aceptar igual'" size="small" [outlined]="true"
                                    (onClick)="aceptarIgual(r)" [disabled]="enviando() || ocupado()"
                                    [ariaLabel]="(p.decision === 'promotion' ? 'Marcar como la misma promoción' : 'Aceptar el costo') + ' del renglón ' + r.renglon + ' igual que la vez anterior'" />
                        }
                        <p-button label="Decidir" size="small" (onClick)="abrir(r)" [disabled]="ocupado()" [ariaLabel]="'Decidir el costo del renglón ' + r.renglon" />
                      </span>
                    }
                  }
                </div></td>
              </tr>
              @if (abierto() === key(r)) {
                <tr class="ca-form-row">
                  <td colspan="5">
                    <form class="ca-form" (ngSubmit)="guardar(r)" [attr.aria-label]="'Decisión del renglón ' + r.renglon">
                      <app-segmented [options]="opciones(r)" [value]="decision()" (valueChange)="elegir($event)" ariaLabel="Qué decides" />
                      <p class="ca-explica">{{ explicacion(r) }}</p>
                      <div class="ca-campos">
                        <label class="ca-campo ca-motivo" [for]="'ca-motivo-' + r.renglon">
                          <span>¿Por qué?</span>
                          <textarea pTextarea [id]="'ca-motivo-' + r.renglon" name="motivo" rows="2" [ngModel]="motivo()" (ngModelChange)="motivo.set($event)"
                                    placeholder="Por ejemplo: el proveedor subió su lista el 1 de noviembre"></textarea>
                          <span class="ca-ayuda">{{ motivoRestante() > 0 ? 'Faltan ' + motivoRestante() + ' letras' : 'Listo' }}</span>
                        </label>
                        @if (decision() === 'claim') {
                          <label class="ca-campo" [for]="'ca-monto-' + r.renglon">
                            <span>Nota esperada</span>
                            <p-inputnumber [inputId]="'ca-monto-' + r.renglon" name="monto" [ngModel]="monto()" (ngModelChange)="monto.set($event)"
                                           mode="currency" currency="MXN" locale="es-MX" [min]="0" [max]="maximo(r)" />
                            <span class="ca-ayuda">Hasta {{ pesos(maximo(r), false) }}, la diferencia contra la OC</span>
                          </label>
                        }
                        @if (decision() === 'promotion') {
                          <label class="ca-campo" [for]="'ca-hasta-' + r.renglon">
                            <span>Vale hasta</span>
                            <p-datepicker [inputId]="'ca-hasta-' + r.renglon" name="hasta" [ngModel]="hasta()" (ngModelChange)="hasta.set($event)"
                                          dateFormat="dd/mm/yy" [minDate]="minHasta(r)" appendTo="body" />
                          </label>
                        }
                      </div>
                      @if (errorForm(); as ef) { <p class="ca-error" role="alert">{{ ef }}</p> }
                      <div class="ca-botones comm-actions">
                        <p-button type="submit" label="Guardar decisión" [loading]="enviando()" [disabled]="enviando() || !!faltante(r)" />
                        <p-button type="button" label="Cancelar" [text]="true" severity="secondary" (onClick)="cerrar()" [disabled]="enviando()" />
                        @if (faltante(r); as f) { <span class="ca-ayuda">{{ f }}</span> }
                      </div>
                    </form>
                  </td>
                </tr>
              }
            </ng-template>
          </p-table>
          </div>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ca { display: flex; flex-direction: column; gap: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); background: var(--surface-1, transparent); }
    .ca-h { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .num { font-variant-numeric: tabular-nums; }
    .mono { font-family: var(--font-mono); }
    .ca-ver { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0; }
    .ca-ver > .pi { margin-top: .2rem; }
    .ca-ver[data-tono="ok"] { color: var(--text-muted); font-size: var(--fs-xs); }
    .ca-ver[data-tono="ok"] > .pi { color: var(--ok-soft-fg); }
    .ca-ver[data-tono="warn"] > .pi { color: var(--warn-soft-fg); }
    .ca-ver[data-tono="neutro"] { color: var(--text-muted); font-size: var(--fs-xs); }
    .ca-ver[data-tono="neutro"] > .pi { color: var(--text-muted); }
    .ca-ver-txt { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .ca-ver-t { margin: 0; font-size: var(--fs-body); font-weight: 700; color: var(--text-main); }
    .ca-ver-s { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-ver-s strong { color: var(--text-main); }
    .ca-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-cadena { margin: 0; display: flex; flex-wrap: wrap; gap: .15rem var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-cadena .mono { color: var(--text-main); }
    .ca-tbl { font-size: var(--fs-xs); }
    .ca-tbl .ta-r { text-align: right; }
    .ca-tbl td > div { display: flex; flex-direction: column; gap: .1rem; min-width: 0; }
    .ca-sku { color: var(--text-main); font-weight: 600; }
    .ca-nombre { color: var(--text-main); overflow-wrap: anywhere; }
    .ca-sub { font-size: var(--fs-micro); color: var(--text-muted); overflow-wrap: anywhere; }
    .ca-dif { display: inline-flex; align-items: center; gap: .25rem; font-weight: 600; white-space: nowrap; }
    .ca-dif .pi { font-size: var(--fs-micro); }
    .ca-dif[data-estado="sube"] { color: var(--warn-soft-fg); }
    .ca-dif[data-estado="baja"] { color: var(--ok-soft-fg); }
    .ca-dec { align-items: flex-start; }
    .ca-dec-t { font-weight: 600; color: var(--text-main); }
    .ca-quien { font-size: var(--fs-micro); color: var(--text-faint); }
    .ca-sin { color: var(--text-muted); }
    .ca-ante { font-size: var(--fs-micro); color: var(--text-main); }
    /* comm-actions: la regla global que da 44 px a los botones con el dedo; aquí alineados a la izquierda. */
    .ca-acc { display: flex; flex-wrap: wrap; gap: var(--sp-1); margin-top: .15rem; justify-content: flex-start; }
    .ca-link { all: unset; cursor: pointer; color: var(--action); text-decoration: underline; font-size: var(--fs-xs); min-height: var(--tap-min); display: inline-flex; align-items: center; }
    .ca-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; border-radius: var(--r-sm); }
    tr.is-abierto > td { border-bottom: 0; }
    .ca-form-row > td { background: var(--surface-2); }
    .ca-form { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-1) 0; }
    .ca-explica { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-campos { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-start; }
    .ca-campo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-main); font-weight: 600; min-width: 0; }
    .ca-motivo { flex: 1 1 18rem; }
    .ca-motivo textarea { width: 100%; font-weight: 400; }
    .ca-ayuda { font-size: var(--fs-micro); font-weight: 400; color: var(--text-muted); }
    .ca-error { margin: 0; font-size: var(--fs-xs); color: var(--bad-fg); font-weight: 600; }
    .ca-botones { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); justify-content: flex-start; }
    .ca-skel { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ca-skel span { height: 1.4rem; border-radius: var(--r-sm); background: var(--surface-2); }
  `],
})
export class ComprasCostoAplicadoComponent {
  private readonly svc = inject(CostoAplicadoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly sucursal = input.required<string>();
  readonly folio = input.required<string>();
  /** Los renglones de Kepler que ya cargó el panel: de ahí el nombre del producto. */
  readonly lineas = input<readonly LineaKeplerNombre[]>([]);
  /** Hay algo tecleado y sin guardar: el panel pregunta antes de cerrarse. */
  readonly capturando = output<boolean>();

  readonly data = signal<AplicacionCosto | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly reintentable = signal(true);

  readonly abierto = signal<string | null>(null);
  readonly decision = signal<DecisionCosto>('accept');
  readonly motivo = signal('');
  readonly monto = signal<number | null>(null);
  readonly hasta = signal<Date | null>(null);
  readonly enviando = signal(false);
  readonly errorForm = signal<string | null>(null);

  readonly puedeDecidir = computed(() =>
    this.perms.isAdmin() || this.auth.user()?.permissions?.[Permission.COMPRAS_COSTO_DECIDIR] === true);

  /** Lo que difiere de su OC, el que más pesos mueve primero. */
  readonly difieren = computed(() =>
    (this.data()?.renglones ?? []).filter(decidible).sort((a, b) => Math.abs(b.pesos_vs_oc ?? 0) - Math.abs(a.pesos_vs_oc ?? 0)));

  readonly resumen = computed(() => {
    const rs = this.data()?.renglones ?? [];
    const sube = rs.filter((r) => r.cost_state === 'sube');
    const baja = rs.filter((r) => r.cost_state === 'baja');
    return {
      comparables: rs.filter((r) => r.cost_state === 'igual' || decidible(r)).length,
      suben: sube.length,
      bajan: baja.length,
      pesosSube: sube.reduce((s, r) => s + (r.pesos_vs_oc ?? 0), 0),
      pesosBaja: baja.reduce((s, r) => s + (r.pesos_vs_oc ?? 0), 0),
      sinOc: rs.filter((r) => r.cost_state === 'sin_oc').length,
      sinPrecio: rs.filter((r) => r.cost_state === 'sin_precio').length,
      sinFactor: rs.filter((r) => r.cost_state === 'otra_escala_sin_factor').length,
      ambiguos: rs.filter((r) => r.cost_state === 'otra_escala_ambigua').length,
    };
  });

  /** Hay un motivo tecleado y sin guardar: lo que lo tiraría (otro renglón, «… igual») queda apagado hasta guardar o cancelar. */
  readonly sucio = computed(() => this.abierto() !== null && this.motivo().trim().length > 0);
  readonly ocupado = computed(() => this.sucio() || this.enviando());

  /** La cadena de la aplicación. Si los renglones vienen de varias OC o vales, se nombran todos. */
  readonly cadena = computed(() => {
    const rs = this.data()?.renglones ?? [];
    const unicos = (k: 'oc_folio' | 'vale_folio' | 'oe_folio') => [...new Set(rs.map((r) => r[k]).filter((x): x is string => !!x))];
    const [oc, vale, oe] = [unicos('oc_folio'), unicos('vale_folio'), unicos('oe_folio')];
    if (!oe.length && oc.length <= 1 && vale.length <= 1) return null;
    return { oe: oe.join(', '), oc: oc.join(', '), vale: vale.join(', '), varias: oc.length > 1 || vale.length > 1 };
  });

  /** Cuántas letras le faltan al motivo (el mismo piso que la regla y el CHECK). */
  readonly motivoRestante = computed(() => Math.max(0, MOTIVO_MINIMO - [...this.motivo().trim()].length));

  private pedido?: Subscription;

  constructor() {
    effect(() => {
      const s = this.sucursal();
      const f = this.folio();
      untracked(() => { this.cerrar(); this.cargar(s, f); });
    });
    effect(() => {
      const sucio = this.sucio();
      untracked(() => this.capturando.emit(sucio));
    });
  }

  cargar(s = this.sucursal(), f = this.folio()): void {
    this.loading.set(true);
    this.error.set(null);
    this.pedido?.unsubscribe();
    this.pedido = this.svc.aplicacion(s, f).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => { this.data.set(a); this.loading.set(false); },
      error: (e: HttpErrorResponse) => {
        this.data.set(null);
        this.loading.set(false);
        // 404 = Kepler no tiene renglones de aplicación con ese folio; 400 = folio que no es de Kepler; 403 = la clave o la
        // sucursal. Ninguno se arregla reintentando: sólo el error de red ofrece «Reintentar».
        const s = e?.status;
        this.reintentable.set(s !== 404 && s !== 403 && s !== 400);
        this.error.set(s === 404 || s === 400
          ? 'No se puede comparar el costo: Kepler no tiene renglones de aplicación con este folio.'
          : s === 403 ? 'No tienes acceso a ver el costo contra la OC de esta entrada.' : 'No se pudo comparar el costo contra la OC.');
      },
    });
  }

  key(r: RenglonCostoConDecision): string { return llave(r); }

  nombre(r: RenglonCostoConDecision): string {
    return this.lineas().find((l) => Number(l.linea) === r.renglon)?.nombre ?? '';
  }

  opciones(r: RenglonCostoConDecision): SegOption[] {
    const o: SegOption[] = [{ label: 'Aceptar el costo', value: 'accept' }];
    if (r.cost_state === 'sube') o.push({ label: 'Reclamar nota', value: 'claim' });
    o.push({ label: 'Promoción', value: 'promotion' });
    return o;
  }

  explicacion(r: RenglonCostoConDecision): string {
    switch (this.decision()) {
      case 'claim': return `Esperas una nota de crédito del proveedor por la diferencia contra la OC (hasta ${this.pesos(this.maximo(r), false)}).`;
      case 'promotion': return 'Es un precio temporal: vale hasta la fecha que digas y la siguiente OC no lo hereda.';
      default: return `La siguiente OC de este producto nace con ${this.costo(r.applied_price)}${r.unit ? ' por ' + r.unit : ''}.`;
    }
  }

  maximo(r: RenglonCostoConDecision): number { return maximoReclamable(r); }

  minHasta(r: RenglonCostoConDecision): Date { return new Date(`${r.fecha_aplicacion}T12:00:00`); }

  abrir(r: RenglonCostoConDecision): void {
    this.abierto.set(llave(r));
    const d = r.decision;
    this.decision.set(d?.decision ?? 'accept');
    this.motivo.set('');
    this.monto.set(d?.claim_amount ?? (r.cost_state === 'sube' ? this.maximo(r) : null));
    this.hasta.set(d?.valid_until ? new Date(`${d.valid_until}T12:00:00`) : null);
    this.errorForm.set(null);
  }

  elegir(v: string): void {
    this.decision.set(v as DecisionCosto);
    this.errorForm.set(null);
  }

  cerrar(): void {
    this.abierto.set(null);
    this.motivo.set('');
    this.errorForm.set(null);
  }

  /** Lo que la regla pide y todavía falta, dicho antes de enviar (la misma regla que el servidor). */
  faltante(r: RenglonCostoConDecision): string | null {
    const e = validarDecision(r, this.nueva());
    return e[0] ?? null;
  }

  private nueva(): NuevaDecisionCosto {
    const d = this.decision();
    const h = this.hasta();
    return {
      decision: d,
      reason: this.motivo(),
      claim_amount: d === 'claim' ? this.monto() : null,
      valid_until: d === 'promotion' && h ? `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}` : null,
    };
  }

  guardar(r: RenglonCostoConDecision): void {
    if (this.enviando() || this.faltante(r)) return;
    this.enviar(r, this.nueva());
  }

  /** «Ya se aceptó antes»: un clic, con el motivo escrito a partir del antecedente. */
  /**
   * «… igual»: un clic, con el motivo escrito a partir del antecedente. Una promoción se repite como PROMOCIÓN con su
   * misma fecha de fin: volverla «aceptar» haría permanente un precio que se registró temporal (revisión del PR).
   */
  aceptarIgual(r: RenglonCostoConDecision): void {
    const p = r.antecedente;
    if (!p || this.ocupado()) return;
    if (p.decision === 'promotion') {
      this.enviar(r, { decision: 'promotion', valid_until: p.valid_until,
        reason: `La misma promoción que en la aplicación ${p.sucursal}/${p.folio} (hasta el ${this.fecha(p.valid_until + 'T12:00:00')}): ${p.reason}` });
      return;
    }
    this.enviar(r, { decision: 'accept', reason: `Igual que lo aceptado el ${this.fecha(p.created_at)} en la aplicación ${p.sucursal}/${p.folio}: ${p.reason}` });
  }

  private enviar(r: RenglonCostoConDecision, d: NuevaDecisionCosto): void {
    this.enviando.set(true);
    this.errorForm.set(null);
    this.svc.decidir({ ...d, sucursal: r.sucursal, subtipo: r.subtipo, folio: r.folio, renglon: r.renglon })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (guardada: DecisionCostoGuardada) => {
          this.enviando.set(false);
          this.cerrar();
          const a = this.data();
          if (a) {
            const renglones = a.renglones.map((x) => (llave(x) === llave(r) ? { ...x, decision: guardada } : x));
            this.data.set({ ...a, renglones, por_decidir: renglones.filter((x) => decidible(x) && !x.decision).length });
          }
        },
        error: (e: HttpErrorResponse) => {
          this.enviando.set(false);
          const msg = (e?.error as { message?: string | string[] } | null)?.message;
          const texto = Array.isArray(msg) ? msg.join(' ') : msg;
          if (this.abierto() !== llave(r)) this.abrir(r);
          this.errorForm.set(e?.status === 409 ? (texto ?? 'Otra persona acaba de decidir este renglón.') + ' Se recargó la aplicación.'
            : texto ?? 'No se pudo guardar la decisión. Intenta otra vez.');
          if (e?.status === 409) this.cargar();
        },
      });
  }

  etiqueta(d: DecisionCostoGuardada): string {
    if (d.decision === 'claim') return `${ETIQUETA_DECISION_COSTO.claim} · ${this.pesos(d.claim_amount ?? 0, false)}`;
    if (d.decision === 'promotion') return `${ETIQUETA_DECISION_COSTO.promotion} hasta ${this.fecha(`${d.valid_until}T12:00:00`)}`;
    return ETIQUETA_DECISION_COSTO.accept;
  }

  costo(n: number | null | undefined): string {
    return n == null ? '—' : Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }

  pesos(n: number | null | undefined, signo: boolean): string {
    if (n == null) return '—';
    const t = Math.abs(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return signo ? `${n < 0 ? '−' : '+'}${t}` : t;
  }

  pct(n: number | null | undefined): string {
    return n == null ? '' : `${Math.abs(n).toLocaleString('es-MX', { maximumFractionDigits: 2 })} %`;
  }

  fecha(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Mexico_City' });
  }
}
