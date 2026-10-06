import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuideRecipient, NuevoEmbarqueHoja, NuevoEmbarqueParada } from '../logistica.service';

/**
 * Cuántas cajas dice la nota MANUAL de almacén (`kdm1.c24`, p. ej. «10  CAJAS  A-1», «CJ 13 PQ 1
 * UB 3», «18C B5»). null = la nota no dice cajas.
 *
 * Se usa sólo para AVISAR cuando no cuadra con los renglones: medido en Kepler, la nota coincide
 * con la suma de renglones CJA/BTO en el 77% de los casos, y la parada 0001062 de la guía 0001419
 * dice «26 CAJAS» cuando sus renglones son 2 cajas y 26 sueltos. La fuente de las cajas son los
 * renglones; la nota es el testigo de lo que alguien contó a mano.
 */
export function cajasDeNota(nota: string | null | undefined): number | null {
  if (!nota) return null;
  const s = nota.toUpperCase();
  // Dos dialectos de la misma nota: Canindo escribe el número y luego la palabra («10  CAJAS  A-1»,
  // «1 CAJA 2 PAQ.»), Padre Hidalgo la abreviatura y luego el número («CJ 13 PQ 1 UB 3»), y a veces
  // sale pegado («18C B5»). El orden de las reglas importa: con la abreviatura primero, «1 CAJA 2
  // PAQ» se leería como 2 cajas.
  const palabra = /\b(\d+)\s*CAJAS?\b/.exec(s);
  if (palabra) return Number(palabra[1]);
  const abreviatura = /\bCJ\.?\s*(\d+)/.exec(s);
  if (abreviatura) return Number(abreviatura[1]);
  const pegado = /\b(\d+)C\b/.exec(s);
  return pegado ? Number(pegado[1]) : null;
}

/** La nota contradice a los renglones (y la diferencia no es de redondeo). */
export function notaDescuadra(p: Pick<NuevoEmbarqueParada, 'nota_almacen' | 'cajas'>): boolean {
  const n = cajasDeNota(p.nota_almacen);
  return n !== null && p.cajas !== null && Math.round(Number(p.cajas)) !== n;
}

/**
 * EMB.12 — La hoja del viaje TAL COMO LA CAPTURÓ KEPLER. Sólo lectura.
 *
 * Cada dato lleva en `previa` la columna de Kepler de la que sale, para que nadie tenga que
 * adivinar de dónde vino un número (ADR-056). En `final` se quita ese andamio y aparece, por
 * parada, si el chofer ya confirmó la entrega — eso lo registra la Suite, no Kepler.
 */
@Component({
  selector: 'app-kepler-hoja',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let h = hoja();
    <section class="kh" aria-label="Viaje registrado en Kepler">
      <header class="kh-head">
        <div>
          <span class="kh-eyebrow">Viaje de Kepler · solo lectura</span>
          <h2 class="kh-title">Guía <code>{{ h.viaje.guia }}</code> · {{ h.viaje.sucursal_nombre || ('Sucursal ' + h.viaje.sucursal) }}</h2>
        </div>
        <div class="kh-flags">
          <span class="kh-pill">{{ h.viaje.tipo.etiqueta }}</span>
          @if (h.viaje.multi_transporte) { <span class="kh-pill is-warn">Más de una unidad en la guía</span> }
          @if (h.viaje.multi_fecha) { <span class="kh-pill is-warn">Paradas con fechas distintas</span> }
        </div>
      </header>

      <dl class="kh-grid">
        @for (f of campos(); track f.label) {
          <div class="kh-field" [class.is-missing]="f.falta">
            <dt><span class="kh-k" aria-hidden="true">K</span>{{ f.label }}</dt>
            <dd>
              <span class="kh-value">{{ f.value }}</span>
              @if (f.sub) { <span class="kh-sub">{{ f.sub }}</span> }
              @if (modo() === 'previa' && f.src) { <code class="kh-src">{{ f.src }}</code> }
            </dd>
          </div>
        }
      </dl>

      <div class="kh-carga" aria-label="Carga">
        <div><span class="kh-clabel">Cajas</span><span class="kh-cvalue">{{ h.resumen.cajas | number:'1.0-0' }}</span></div>
        <div><span class="kh-clabel">Sueltos</span><span class="kh-cvalue">{{ h.resumen.sueltos | number:'1.0-0' }}</span></div>
        <div>
          <span class="kh-clabel">Peso</span>
          <span class="kh-cvalue is-missing">Sin medir</span>
          <span class="kh-sub">
            @if (h.resumen.kg_vendido_por_kilo !== null) {
              {{ h.resumen.kg_vendido_por_kilo | number:'1.0-2' }} kg vendidos por kilo; el resto no tiene peso en Kepler
            } @else { Kepler no tiene peso por producto }
          </span>
        </div>
        <div>
          <span class="kh-clabel">Valor de la mercancía</span>
          <span class="kh-cvalue">{{ h.resumen.valor_venta | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
          <span class="kh-sub">precio de venta con impuestos</span>
        </div>
        @if (h.resumen.valor_traspaso > 0) {
          <div>
            <span class="kh-clabel">Traspaso a costo</span>
            <span class="kh-cvalue">{{ h.resumen.valor_traspaso | currency:'MXN':'symbol-narrow':'1.2-2' }}</span>
            <span class="kh-sub">no se suma con la venta</span>
          </div>
        }
      </div>

      <div class="kh-stops dt-scope">
        <h3 class="kh-h3">Paradas <span class="kh-count">{{ h.resumen.paradas }}</span>
          <span class="kh-hint">· ordenadas por ruta y orden de visita</span></h3>
        <table class="kh-table dt-stack">
          <thead>
            <tr>
              <th scope="col">Ruta</th>
              <th scope="col" class="num">Orden</th>
              <th scope="col">Documento</th>
              <th scope="col">Cliente · ciudad</th>
              <th scope="col" class="num">Cajas</th>
              <th scope="col" class="num">Sueltos</th>
              <th scope="col" class="num">Kg</th>
              <th scope="col" class="num">Valor</th>
              <th scope="col">Factura</th>
              @if (modo() === 'final') { <th scope="col">Entrega</th> } @else { <th scope="col">Nota de almacén</th> }
            </tr>
          </thead>
          <tbody>
            @for (p of h.paradas; track p.folio_digital) {
              <tr>
                <td data-label="Ruta" role="cell" class="dt-id">
                  {{ p.ruta_nombre || 'Sin ruta' }}
                  @if (p.ruta_clave) { <code class="kh-src">{{ p.ruta_clave }}</code> }
                </td>
                <td data-label="Orden" role="cell" class="num dt-num">{{ p.orden_visita ?? '—' }}</td>
                <td data-label="Documento" role="cell">
                  <code>{{ p.folio_digital }}</code>
                  @if (p.pedido_folio) { <span class="kh-sub">pedido {{ p.pedido_folio }}</span> }
                </td>
                <td data-label="Cliente" role="cell">
                  <code>{{ p.cliente_code || '—' }}</code> · {{ p.destino_ciudad || p.domicilio_ciudad || '—' }}
                  @if (p.destino_nombre) { <span class="kh-sub">{{ p.destino_nombre }}</span> }
                </td>
                <td data-label="Cajas" role="cell" class="num dt-num">{{ p.cajas ?? '—' }}</td>
                <td data-label="Sueltos" role="cell" class="num dt-num">{{ p.sueltos ? p.sueltos : '—' }}</td>
                <td data-label="Kg" role="cell" class="num dt-num">{{ p.kg ?? '—' }}</td>
                <td data-label="Valor" role="cell" class="num dt-num">{{ p.total | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td data-label="Factura" role="cell">
                  @if (p.facturado) { <span class="kh-pill is-ok">Facturado</span> }
                  @else { <span class="kh-pill">{{ p.facturacion ? 'Estado ' + p.facturacion : 'Sin factura' }}</span> }
                </td>
                @if (modo() === 'final') {
                  <td data-label="Entrega" role="cell">
                    <span class="kh-pill" [class.is-ok]="entregaDe(p) === 'entregado'" [class.is-warn]="entregaDe(p) === 'no_entregado' || entregaDe(p) === 'rechazado'">
                      {{ entregaLabel(entregaDe(p)) }}
                    </span>
                  </td>
                } @else {
                  <td data-label="Nota de almacén" role="cell">
                    <span class="kh-nota">{{ p.nota_almacen || '—' }}</span>
                    @if (descuadra(p)) {
                      <span class="kh-pill is-warn">La nota dice {{ cajasNota(p) }} cajas; los renglones, {{ p.cajas }}</span>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colspan="4">Total · {{ h.resumen.rutas.length }} ruta{{ h.resumen.rutas.length === 1 ? '' : 's' }} · {{ h.resumen.clientes }} cliente{{ h.resumen.clientes === 1 ? '' : 's' }}</th>
              <td class="num">{{ h.resumen.cajas | number:'1.0-0' }}</td>
              <td class="num">{{ h.resumen.sueltos | number:'1.0-0' }}</td>
              <td class="num">{{ h.resumen.kg_vendido_por_kilo ?? '—' }}</td>
              <td class="num">{{ (h.resumen.valor_venta + h.resumen.valor_traspaso) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
        @if (modo() === 'previa') {
          <p class="kh-foot">
            Ruta por domicilio de entrega (kdudent.c13) · cajas de los renglones (kdm2.c54 en CJA/BTO), no de la nota ·
            kilos sólo de renglones vendidos por kilo.
            @if (h.resumen.renglones_sin_empaque > 0) {
              <b>{{ h.resumen.renglones_sin_empaque }} renglón(es) sin unidad de manejo</b> no entran ni a cajas ni a sueltos.
            }
          </p>
        }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .kh { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
    .kh-head { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-start; justify-content: space-between; }
    .kh-eyebrow { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-2); }
    .kh-title { margin: .15rem 0 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .kh-title code, .kh-table code { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .kh-flags { display: flex; flex-wrap: wrap; gap: .4rem; }
    .kh-pill { display: inline-flex; align-items: center; padding: .1rem .5rem; border-radius: 999px; background: var(--c-surface-2); color: var(--c-text-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); white-space: nowrap; }
    .kh-pill.is-ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .kh-pill.is-warn { background: var(--warn-soft-bg); color: var(--warn-soft-fg); white-space: normal; }

    .kh-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: .6rem; }
    .kh-field { background: var(--c-surface-0); border: 1px solid var(--c-divider); border-radius: var(--r-sm); padding: .6rem .75rem; display: flex; flex-direction: column; gap: .2rem; }
    .kh-field.is-missing { background: var(--warn-soft-bg); }
    .kh-field dt { display: flex; align-items: center; gap: .35rem; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .06em; color: var(--c-text-2); }
    .kh-field dd { margin: 0; display: flex; flex-direction: column; gap: .15rem; }
    .kh-k { display: inline-flex; align-items: center; justify-content: center; width: 1rem; height: 1rem; border-radius: .25rem; background: var(--c-divider); color: var(--c-text-1); font-family: var(--font-mono); font-size: var(--fs-nano); }
    .kh-value { font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .kh-sub { display: block; font-size: var(--fs-xs); color: var(--c-text-2); }
    .kh-src { font-family: var(--font-mono); font-size: var(--fs-nano); color: var(--c-text-3); }

    .kh-carga { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; padding: .75rem; border: 1px solid var(--c-divider); border-radius: var(--r-sm); }
    .kh-carga > div { display: flex; flex-direction: column; gap: .15rem; }
    .kh-clabel { font-size: var(--fs-xs); color: var(--c-text-2); }
    .kh-cvalue { font-size: var(--fs-h3); font-weight: var(--fw-bold); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .kh-cvalue.is-missing { font-family: inherit; color: var(--warn-soft-fg); }

    .kh-h3 { margin: 0 0 .5rem; font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .kh-count { color: var(--c-text-2); font-family: var(--font-mono); }
    .kh-hint { font-weight: var(--fw-regular); font-size: var(--fs-xs); color: var(--c-text-2); }
    .kh-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .kh-table th { text-align: left; font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase; letter-spacing: .04em; color: var(--c-text-2); padding: .45rem .5rem; border-bottom: 1px solid var(--c-divider); }
    .kh-table td { padding: .45rem .5rem; border-bottom: 1px solid var(--c-surface-2); vertical-align: top; }
    .kh-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .kh-table tfoot th, .kh-table tfoot td { font-weight: var(--fw-bold); border-top: 1px solid var(--c-divider); border-bottom: 0; color: var(--c-text-1); text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); }
    .kh-nota { font-family: var(--font-mono); font-size: var(--fs-xs); display: block; }
    .kh-foot { margin: .5rem 0 0; font-size: var(--fs-xs); color: var(--c-text-2); }
  `],
})
export class KeplerHojaComponent {
  readonly hoja = input.required<NuevoEmbarqueHoja>();
  readonly modo = input<'previa' | 'final'>('previa');
  /** En `final`: los destinatarios de la guía, con el estado de entrega que captura el chofer. */
  readonly entregas = input<GuideRecipient[]>([]);

  private readonly entregaPorFolio = computed(() => {
    const m = new Map<string, string>();
    for (const r of this.entregas()) if (r.kepler_folio) m.set(`${r.kepler_serie}|${r.kepler_folio}`, r.status);
    return m;
  });

  readonly campos = computed(() => {
    const h = this.hoja();
    const hora = h.viaje.hora_captura_desde
      ? (h.viaje.hora_captura_desde === h.viaje.hora_captura_hasta
        ? h.viaje.hora_captura_desde
        : `${h.viaje.hora_captura_desde} – ${h.viaje.hora_captura_hasta}`)
      : '—';
    const rutas = h.resumen.rutas.map((r) => r.nombre || r.clave);
    const responsables = [
      h.responsables.checo.length ? `Checó ${h.responsables.checo.join(', ')}` : null,
      h.responsables.embarco.length ? `Embarcó ${h.responsables.embarco.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    return [
      { label: 'Fecha', value: h.viaje.fecha ?? '—', sub: 'Fecha del documento de embarque', src: 'kdm1.c9' },
      { label: 'Hora de captura', value: hora, sub: 'Cuándo se capturó en Kepler; no es la hora de salida', src: 'kdm1.c69' },
      { label: 'Tipo', value: h.viaje.tipo.etiqueta, sub: h.viaje.tipo.mixto ? 'La guía mezcla tipos de parada' : null, src: 'kdm1.c5 + destino' },
      { label: 'Origen', value: h.viaje.sucursal_nombre || `Sucursal ${h.viaje.sucursal}`, sub: `Sucursal ${h.viaje.sucursal}`, src: 'kdm1.c1' },
      {
        label: 'Unidad',
        value: [h.unidad.kepler_code, h.unidad.descripcion].filter(Boolean).join(' · ') || 'Sin unidad',
        sub: [h.unidad.placas ? `Placas ${h.unidad.placas}` : null, h.unidad.motivo].filter(Boolean).join(' · ') || null,
        src: 'kdm1.c83 → kdm_transporte', falta: !h.unidad.kepler_code,
      },
      {
        label: 'Chofer',
        value: h.chofer.falta ? 'No viene en Kepler' : ([h.chofer.kepler_code, h.chofer.nombre].filter(Boolean).join(' · ') || 'Sin resolver'),
        sub: h.chofer.motivo,
        src: 'kdm1.c84 → kdm_chofer', falta: h.chofer.falta,
      },
      {
        label: 'Rutas',
        value: `${rutas.length} ruta${rutas.length === 1 ? '' : 's'}`,
        sub: rutas.join(' · ') + (h.resumen.paradas_sin_ruta ? ` · ${h.resumen.paradas_sin_ruta} parada(s) sin ruta` : ''),
        src: 'kdudent.c13 → kdm_rutas',
      },
      {
        label: 'Almacén',
        value: responsables || 'Sin responsables',
        sub: h.responsables.surtio.length ? `Surtieron ${h.responsables.surtio.length} persona(s)` : null,
        src: 'kdm1.c80 / c81 / c82',
      },
      {
        label: 'Facturado',
        value: `${h.resumen.facturadas} de ${h.resumen.paradas_a_cliente}`,
        sub: 'Paradas a cliente con factura',
        src: 'kdm1.c43',
      },
    ] as Array<{ label: string; value: string; sub: string | null; src: string; falta?: boolean }>;
  });

  entregaDe(p: NuevoEmbarqueParada): string {
    return this.entregaPorFolio().get(`${p.serie}|${p.folio}`) ?? 'sin_guia';
  }

  entregaLabel(s: string): string {
    return ({
      pendiente: 'Pendiente', entregado: 'Entregado', no_entregado: 'No entregado',
      rechazado: 'Rechazado', sin_guia: 'Sin registro',
    } as Record<string, string>)[s] ?? s;
  }

  descuadra(p: NuevoEmbarqueParada) { return notaDescuadra(p); }
  cajasNota(p: NuevoEmbarqueParada) { return cajasDeNota(p.nota_almacen); }
}
