import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MismaFactura, MovimientoDeFactura } from '@megadulces/contracts';

/**
 * `[RE.85]` La misma factura citada por varias entradas del proveedor, en el panel lateral de la entrada.
 *
 * Las cinco preguntas (diseno 0b), contestadas antes de la plantilla:
 *  1. Qué ve y en qué orden: primero la respuesta (cuánto debe Kepler por esa factura contra lo que dice el CFDI,
 *     y qué significa la diferencia); debajo, la cadena en orden de fecha, cada movimiento con SU motivo.
 *  2. Qué no ve: la sección no existe si ninguna otra entrada cita la factura; la referencia cruda de Kepler no
 *     se muestra (se muestra la factura por serie y folio).
 *  3. Accesibilidad: cero clics (va dentro del panel ya abierto); el origen del motivo va en TEXTO, no en color.
 *  4. Ligas: cada devolución o nota dice a qué entrada se aplicó; la que se está viendo dice «esta».
 *  5. ¿Le toca? Sí: Revisión de facturas es donde se decide si lo de Kepler cuadra con la factura.
 *
 * Jerarquía: primario = lo que debe Kepler contra la factura · secundario = cada movimiento y su importe ·
 * terciario = el motivo y de dónde salió.
 *
 * ⛔ Cada movimiento dice POR QUÉ se hizo (Edgar, 2026-11-23): el de Kepler, el deducido del dato, o
 * «sin motivo capturado» dicho en voz alta. Nunca un renglón sin motivo en silencio.
 */
@Component({
  selector: 'app-compras-entrada-misma-factura',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data(); as m) {
      <section class="mf" aria-labelledby="mf-t">
        <h3 id="mf-t" class="mf-h">La misma factura en otras entradas{{ factura() }}</h3>
        <p class="mf-res">
          <span class="mf-res-n">Kepler debe {{ money(m.neto_kepler) }}</span>
          @if (m.cfdi) { <span class="mf-res-s"> · la factura dice {{ money(m.cfdi.total) }}</span> }
        </p>
        <p class="mf-lect">{{ lectura() }}</p>
        <ol class="mf-lista">
          @for (x of m.movimientos; track x.tipo + x.folio) {
            <li class="mf-mov" [attr.data-esta]="x.es_esta ? '' : null">
              <div class="mf-fila">
                <span class="mf-fecha">{{ fecha(x.fecha) }}</span>
                <span class="mf-que">
                  {{ tipoTexto(x) }} <span class="mf-folio">{{ x.folio }}</span>
                  @if (x.es_esta) { <span class="mf-esta">esta</span> }
                  @if (x.aplicada_a) { <span class="mf-apl">aplicada a la entrada {{ x.aplicada_a }}</span> }
                </span>
                <span class="mf-imp">{{ conSigno(x.importe) }}</span>
              </div>
              <p class="mf-mot" [attr.data-origen]="x.motivo_origen">
                <span class="mf-orig">{{ origenTexto(x.motivo_origen) }}</span>
                {{ x.motivo ?? 'Nadie escribió por qué se hizo este movimiento.' }}
              </p>
            </li>
          }
        </ol>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .mf { display: flex; flex-direction: column; gap: var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-3); }
    .mf-h { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .mf-res { margin: 0; font-variant-numeric: tabular-nums; }
    .mf-res-n { font-size: var(--fs-lg); font-weight: 700; color: var(--text-main); }
    .mf-res-s { font-size: var(--fs-sm); color: var(--text-muted); }
    .mf-lect { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mf-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .mf-mov { padding: var(--sp-2) 0; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: var(--sp-1); }
    .mf-mov[data-esta] .mf-que { font-weight: 700; }
    .mf-fila { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr) auto; gap: var(--sp-2); align-items: baseline; font-size: var(--fs-sm); }
    .mf-fecha { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .mf-que { color: var(--text-main); min-width: 0; }
    .mf-folio { font-family: var(--font-mono); }
    .mf-esta { margin-left: var(--sp-1); font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); border: 1px solid var(--border-color); border-radius: var(--r-pill); padding: 0 var(--sp-1); }
    .mf-apl { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .mf-imp { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-main); text-align: right; white-space: nowrap; }
    .mf-mot { margin: 0 0 0 calc(4.5rem + var(--sp-2)); font-size: var(--fs-xs); color: var(--text-main); }
    .mf-orig { font-weight: 600; color: var(--text-muted); margin-right: var(--sp-1); }
    .mf-mot[data-origen="sin_motivo"] { color: var(--text-muted); }
    .mf-mot[data-origen="sin_motivo"] .mf-orig { color: var(--warn-fg); }
    @media (max-width: 40rem) {
      .mf-fila { grid-template-columns: minmax(0, 1fr) auto; }
      .mf-fecha { grid-column: 1 / -1; }
      .mf-mot { margin-left: 0; }
    }
  `],
})
export class ComprasEntradaMismaFacturaComponent {
  readonly data = input<MismaFactura | null | undefined>(null);

  readonly factura = computed(() => {
    const c = this.data()?.cfdi;
    return c ? ` · ${(c.serie ?? '').trim()}${c.folio ?? ''}` : '';
  });

  /** `[RE.85]` Q.2: la diferencia contra la factura, dicha en llano. */
  readonly lectura = computed(() => {
    const m = this.data();
    if (!m) return '';
    if (!m.cfdi || m.diferencia == null) return 'Ninguna de estas entradas tiene el CFDI ligado: no se puede comparar contra la factura.';
    const d = m.diferencia;
    if (Math.abs(d) < 0.5) return 'Cuadra con la factura: lo que se descontó volvió a entrar.';
    if (d < 0) {
      return `Kepler debe ${this.money(-d)} menos que la factura: es lo descontado por devolución o nota que no ha vuelto a entrar. `
        + 'Si el proveedor no emitió la nota de crédito por eso, lo que se pague no va a cuadrar con lo facturado.';
    }
    return `Kepler debe ${this.money(d)} más que la factura: se cargó más de lo que se facturó.`;
  });

  tipoTexto(x: MovimientoDeFactura): string {
    return x.tipo === 'entrada' ? 'Entrada' : x.tipo === 'devolucion' ? 'Devolución' : 'Nota de crédito';
  }

  origenTexto(o: MovimientoDeFactura['motivo_origen']): string {
    return o === 'kepler' ? 'Motivo en Kepler:' : o === 'derivado' ? 'Deducido:' : 'Sin motivo capturado.';
  }

  money(v: number | string | null | undefined): string {
    const n = Number(v ?? 0);
    return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  conSigno(v: number): string {
    const n = Number(v);
    return `${n < 0 ? '−' : '+'}${this.money(Math.abs(n))}`;
  }

  fecha(f: string | null): string {
    if (!f) return 'sin fecha';
    const [y, m, d] = f.slice(0, 10).split('-');
    return d && m && y ? `${d}/${m}/${y.slice(2)}` : f;
  }
}
