import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import type { ExpedienteCheck, ExpedienteCheckGrupo, ExpedienteCubo, ExpedienteLiga, ReceiptExpediente } from '@megadulces/contracts';
import { EntradasService } from '../entradas.service';

/** Texto y tono de cada cubo. El color nunca va solo (DESIGN.md §5): siempre ícono + palabra. */
const CUBO: Record<ExpedienteCubo, { titulo: string; tono: 'ok' | 'warn' | 'info' | 'muted'; icono: string }> = {
  auto: { titulo: 'Pasa sola', tono: 'ok', icono: 'pi-check-circle' },
  revisar: { titulo: 'Revisar', tono: 'warn', icono: 'pi-exclamation-triangle' },
  sin_cfdi_aun: { titulo: 'Sin CFDI aún', tono: 'info', icono: 'pi-clock' },
  sin_documento: { titulo: 'Sin factura ni remisión', tono: 'muted', icono: 'pi-paperclip' },
  fuera_de_alcance: { titulo: 'Fuera de alcance', tono: 'muted', icono: 'pi-minus-circle' },
};

const LIGA: Record<string, string> = {
  asignado: 'confirmada antes por una persona',
  uuid: 'por el UUID leído del documento',
  uuid_corregido: 'por el UUID leído (corregido: el OCR confundió caracteres)',
  rfc_folio: 'por RFC y folio de la factura',
  folio_total: 'por folio y total de la factura',
  rfc_importe: 'sugerida por RFC e importe: confírmala',
  // [RE.35.6] RFC + importe es exacta cuando ninguna otra entrada tiene ese importe (promoverRfcImporte).
  rfc_importe_exacta: 'por RFC e importe exacto (ninguna otra entrada tiene ese importe)',
  total_fecha: 'sugerida por total y fecha: confírmala',
};

/**
 * [RE.35] El expediente de la factura, dentro del panel «Orden de entrada» de costo por compra.
 *
 * Regla de fuentes (ADR-085): el papel que entrega el repartidor sólo IDENTIFICA la factura; todo
 * dato fiscal sale del CFDI que sincroniza ContPAQi. Esta vista es de sólo lectura: la decisión
 * con motivo y la liga confirmada llegan en RE.37.
 */
@Component({
  selector: 'app-compras-entrada-expediente',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <section class="ex" aria-labelledby="ex-t">
      <h3 id="ex-t" class="ex-h">Expediente de la factura</h3>
      @if (loading()) {
        <div class="ex-skel" aria-busy="true" aria-label="Cargando el expediente">
          <span></span><span></span><span></span>
        </div>
      } @else if (error()) {
        <p class="ex-nota">No se pudo armar el expediente. <button type="button" class="ex-link" (click)="cargar()">Reintentar</button></p>
      } @else if (data(); as x) {
        <div class="ex-ver" [attr.data-tono]="cubo().tono" role="status">
          <i class="pi" [ngClass]="cubo().icono" aria-hidden="true"></i>
          <div class="ex-ver-txt">
            <p class="ex-ver-t">{{ cubo().titulo }}</p>
            @if (x.motivos.length) {
              <ul class="ex-mot">@for (m of x.motivos; track m) { <li>{{ m }}</li> }</ul>
            } @else if (x.cubo === 'auto') {
              <p class="ex-ver-s">Cumple todos los checks. Regla {{ x.regla }} · tolerancia menor a {{ (x.tolerancia.pct * 100).toFixed(2) }}% y a {{ money(x.tolerancia.abs) }}.</p>
            }
            @if (x.liga) {
              <p class="ex-ver-s">CFDI encontrado {{ ligaTexto(x.liga) }}.</p>
            }
            @if (x.via === 'remision' && x.doc_tipo === 'factura') {
              <p class="ex-ver-s">Se revisó como remisión: el proveedor no tiene CFDI en ContPAQi.</p>
            }
            @if (x.nota_credito; as n) {
              <p class="ex-ver-s">Cuadra descontando la nota de crédito por {{ money(n.total) }}.</p>
            }
          </div>
        </div>

        @for (g of grupos; track g.clave) {
          @if (checksDe(g.clave).length) {
            <h4 class="ex-sub">{{ g.titulo }}</h4>
            <table class="ex-tbl">
              <tbody>
                @for (c of checksDe(g.clave); track c.clave) {
                  <tr>
                    <th scope="row">{{ c.etiqueta }}</th>
                    <td class="ex-val">{{ c.valor ?? '—' }}</td>
                    <td class="ex-est" [attr.data-estado]="c.estado">
                      <i class="pi" [ngClass]="icono(c)" aria-hidden="true"></i>
                      <span>{{ estadoTexto(c) }}</span>
                    </td>
                  </tr>
                  @if (c.nota && c.estado !== 'ok') {
                    <tr class="ex-nota-row"><td colspan="3">{{ c.nota }}</td></tr>
                  }
                }
              </tbody>
            </table>
          }
        }

        @if (x.cfdi; as f) {
          <h4 class="ex-sub">Importes del CFDI</h4>
          <dl class="ex-imp">
            <div><dt>Subtotal</dt><dd>{{ money(f.subtotal) }}</dd></div>
            <div><dt>Descuento</dt><dd>{{ money(f.descuento) }}</dd></div>
            <div><dt>IVA</dt><dd>{{ money(f.iva_trasladado) }}</dd></div>
            <div><dt>IEPS</dt><dd>{{ money(f.ieps_trasladado) }}</dd></div>
            <div><dt>Total</dt><dd class="ex-strong">{{ money(f.total) }}</dd></div>
            @if (x.nota_credito; as n) {
              <div><dt>Nota de crédito</dt><dd>−{{ money(n.total) }}</dd></div>
            }
            <div><dt>Timbrado</dt><dd>{{ f.fecha_timbrado ?? '—' }}</dd></div>
          </dl>
          @if (x.nota_credito; as n) {
            <p class="ex-src">Nota de crédito UUID {{ n.uuid }}{{ n.fecha ? ' del ' + n.fecha : '' }}.</p>
          }
          <p class="ex-src">UUID {{ f.uuid }} · serie y folio {{ f.serie ?? '' }}{{ f.folio ? '-' + f.folio : '' }}. Del papel sólo se usan las llaves para encontrar la factura; todo dato fiscal viene del CFDI que sincroniza ContPAQi.</p>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ex { display: flex; flex-direction: column; gap: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); }
    .ex-h { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .ex-sub { margin: var(--sp-2) 0 0; font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 600; }
    .ex-ver { display: flex; gap: var(--sp-2); align-items: flex-start; border: 1px solid var(--border-color); border-left-width: 4px; border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); }
    .ex-ver[data-tono="ok"] { border-left-color: var(--ok-fg); }
    .ex-ver[data-tono="warn"] { border-left-color: var(--warn-fg); }
    .ex-ver[data-tono="info"] { border-left-color: var(--action); }
    .ex-ver[data-tono="muted"] { border-left-color: var(--text-faint); }
    .ex-ver > .pi { margin-top: .15rem; color: var(--text-muted); }
    .ex-ver[data-tono="ok"] > .pi { color: var(--ok-fg); }
    .ex-ver[data-tono="warn"] > .pi { color: var(--warn-fg); }
    .ex-ver-txt { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .ex-ver-t { margin: 0; font-weight: 700; color: var(--text-main); }
    .ex-ver-s { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .ex-mot { margin: 0; padding-left: 1.1rem; font-size: var(--fs-xs); color: var(--text-main); }
    .ex-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
    .ex-tbl th { text-align: left; font-weight: 500; color: var(--text-muted); padding: .3rem .4rem .3rem 0; white-space: nowrap; width: 30%; }
    .ex-tbl td { padding: .3rem .4rem; border-top: 1px solid var(--border-color); vertical-align: top; }
    .ex-tbl th { border-top: 1px solid var(--border-color); }
    .ex-val { font-family: var(--font-mono); color: var(--text-main); word-break: break-word; }
    .ex-est { white-space: nowrap; text-align: right; font-weight: 600; }
    .ex-est .pi { font-size: .75rem; margin-right: .25rem; }
    .ex-est[data-estado="ok"] { color: var(--ok-fg); }
    .ex-est[data-estado="falla"] { color: var(--bad-fg); }
    .ex-est[data-estado="aviso"] { color: var(--warn-fg); }
    .ex-est[data-estado="sin_medir"], .ex-est[data-estado="no_aplica"] { color: var(--text-faint); }
    .ex-nota-row td { border-top: 0; padding-top: 0; color: var(--text-muted); font-size: var(--fs-micro); }
    .ex-imp { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); margin: 0; }
    .ex-imp div { background: var(--surface-2); border-radius: var(--r-sm); padding: .35rem .5rem; min-width: 0; }
    .ex-imp dt { font-size: var(--fs-micro); color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
    .ex-imp dd { margin: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text-main); }
    .ex-strong { font-weight: 700; }
    .ex-src, .ex-nota { margin: 0; font-size: var(--fs-micro); color: var(--text-faint); }
    .ex-link { all: unset; cursor: pointer; color: var(--action); text-decoration: underline; }
    .ex-link:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .ex-skel { display: flex; flex-direction: column; gap: var(--sp-2); }
    .ex-skel span { height: 1.4rem; border-radius: var(--r-sm); background: var(--surface-2); }
    @media (max-width: 40rem) { .ex-imp { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `],
})
export class ComprasEntradaExpedienteComponent {
  private readonly svc = inject(EntradasService);
  private readonly destroyRef = inject(DestroyRef);

  readonly sucursal = input.required<string>();
  readonly folio = input.required<string>();

  readonly data = signal<ReceiptExpediente | null>(null);
  /** `[RE.35.6]` El expediente cargado (null mientras carga o si falla): el panel lo usa para el aviso de arriba. */
  readonly cargado = output<ReceiptExpediente | null>();
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly cubo = computed(() => CUBO[this.data()?.cubo ?? 'revisar']);
  /** La petición en curso: se cancela si el panel abre otra entrada antes de que responda. */
  private pedido?: Subscription;

  readonly grupos: { clave: ExpedienteCheckGrupo; titulo: string }[] = [
    { clave: 'identificacion', titulo: 'Para identificar · del papel' },
    { clave: 'fiscal', titulo: 'Datos fiscales · del CFDI (ContPAQi)' },
    { clave: 'entrada', titulo: 'Contra la entrada · Kepler' },
  ];

  constructor() {
    // Cada vez que el panel abre otra entrada, se arma su expediente.
    effect(() => {
      const s = this.sucursal();
      const f = this.folio();
      if (s && f) this.cargar();
    });
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(false);
    this.cargado.emit(null);
    this.pedido?.unsubscribe();
    this.pedido = this.svc.expediente(this.sucursal(), this.folio()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (x) => { this.data.set(x); this.loading.set(false); this.cargado.emit(x); },
      error: () => { this.data.set(null); this.loading.set(false); this.error.set(true); this.cargado.emit(null); },
    });
  }

  checksDe(grupo: ExpedienteCheckGrupo): ExpedienteCheck[] {
    return (this.data()?.checks ?? []).filter((c) => c.grupo === grupo);
  }

  ligaTexto(liga: ExpedienteLiga): string {
    const k = liga.metodo === 'rfc_importe' && liga.exacta ? 'rfc_importe_exacta' : liga.metodo;
    return LIGA[k] ?? liga.metodo;
  }

  icono(c: ExpedienteCheck): string {
    return { ok: 'pi-check', falla: 'pi-times', aviso: 'pi-exclamation-triangle', sin_medir: 'pi-minus', no_aplica: 'pi-minus' }[c.estado];
  }

  estadoTexto(c: ExpedienteCheck): string {
    return { ok: 'Coincide', falla: 'No pasa', aviso: 'Aviso', sin_medir: 'Sin medir', no_aplica: 'No aplica' }[c.estado];
  }

  money(n: number | null | undefined): string {
    return n == null ? '—' : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }
}
