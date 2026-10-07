import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GuideRecipient, NuevoEmbarqueHoja } from '../logistica.service';
import { KeplerParadasComponent } from './kepler-paradas.component';

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const entero = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/** Los datos del viaje que ya escribió Kepler, en texto listo para la hoja. null = Kepler no lo trae. */
export interface DatosKepler {
  fecha: string | null;
  guia: string;
  origen: string;
  tipo: string;
  rutas: string | null;
  unidad: string | null;
  placas: string | null;
  chofer: string | null;
  surtio: string | null;
  checo: string | null;
  embarco: string | null;
  paradas: string;
  cajas: string;
  sueltos: string;
  valor: string;
  /** Sólo cuando la guía lleva traspasos: van a costo y no se suman con la venta. */
  traspaso: string | null;
}

/**
 * Una sola fuente para la hoja de embarque al tomar el viaje y para el embarque ya creado: los
 * dos muestran lo mismo de Kepler, con las mismas palabras.
 */
export function datosDeKepler(h: NuevoEmbarqueHoja): DatosKepler {
  const lista = (xs: string[]) => (xs.length ? xs.join(', ') : null);
  const rutas = h.resumen.rutas.map((r) => r.nombre || r.clave);
  return {
    fecha: h.viaje.fecha,
    guia: h.viaje.guia,
    origen: h.viaje.sucursal_nombre || `Sucursal ${h.viaje.sucursal}`,
    tipo: h.viaje.tipo.etiqueta,
    rutas: rutas.length ? rutas.join(' · ') : null,
    unidad: [h.unidad.kepler_code, h.unidad.descripcion].filter(Boolean).join(' · ') || null,
    placas: h.unidad.placas,
    chofer: h.chofer.falta ? null : ([h.chofer.kepler_code, h.chofer.nombre].filter(Boolean).join(' · ') || null),
    surtio: lista(h.responsables.surtio),
    checo: lista(h.responsables.checo),
    embarco: lista(h.responsables.embarco),
    paradas: entero.format(h.resumen.paradas),
    cajas: entero.format(h.resumen.cajas),
    sueltos: entero.format(h.resumen.sueltos),
    valor: pesos.format(h.resumen.valor_venta),
    traspaso: h.resumen.valor_traspaso > 0 ? pesos.format(h.resumen.valor_traspaso) : null,
  };
}

/**
 * EMB.12 — El viaje de Kepler dentro del embarque ya creado. Sólo lectura: lo que Kepler escribió
 * no se cambia en la Suite. Las paradas llevan lo que el chofer registró en cada entrega.
 */
@Component({
  selector: 'app-kepler-hoja',
  standalone: true,
  imports: [CommonModule, KeplerParadasComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let d = datos();
    <section class="kh" aria-labelledby="kh-titulo">
      <h2 id="kh-titulo" class="kh-title">Guía <code>{{ d.guia }}</code> · {{ d.origen }}</h2>
      <dl class="kh-grid">
        @for (f of campos(); track f.label) {
          <div class="kh-f" [class.is-wide]="f.wide">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value ?? '—' }}</dd>
          </div>
        }
      </dl>
      <h3 class="kh-h3">Paradas</h3>
      <app-kepler-paradas [hoja]="hoja()" [entregas]="entregas()"></app-kepler-paradas>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .kh { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-md); padding: 1rem; display: flex; flex-direction: column; gap: .9rem; }
    .kh-title { margin: 0; font-size: var(--fs-h3); font-weight: var(--fw-bold); }
    .kh-title code { font-family: var(--font-mono); }
    .kh-grid { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: .6rem .75rem; }
    .kh-f { display: flex; flex-direction: column; gap: .25rem; min-width: 0; }
    .kh-f.is-wide { grid-column: 1 / -1; }
    .kh-f dt { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--c-text-2); }
    .kh-f dd { margin: 0; min-height: 2.25rem; box-sizing: border-box; padding: .45rem .6rem; border-radius: var(--r-sm); background: var(--c-surface-2); color: var(--c-text-1); font-size: var(--fs-sm); overflow-wrap: anywhere; }
    .kh-h3 { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); }
  `],
})
export class KeplerHojaComponent {
  readonly hoja = input.required<NuevoEmbarqueHoja>();
  /** Los destinatarios de la guía, con el estado de entrega que registra el chofer. */
  readonly entregas = input<GuideRecipient[]>([]);

  readonly datos = computed(() => datosDeKepler(this.hoja()));
  readonly campos = computed(() => {
    const d = this.datos();
    const xs: Array<{ label: string; value: string | null; wide?: boolean }> = [
      { label: 'Fecha', value: d.fecha },
      { label: 'Tipo', value: d.tipo },
      { label: 'Unidad', value: d.unidad },
      { label: 'Placas', value: d.placas },
      { label: 'Chofer', value: d.chofer },
      { label: 'Rutas', value: d.rutas, wide: true },
      { label: 'Paradas', value: d.paradas },
      { label: 'Cajas', value: d.cajas },
      { label: 'Sueltos', value: d.sueltos },
      { label: 'Valor de la mercancía', value: d.valor },
    ];
    if (d.traspaso) xs.push({ label: 'Traspaso a costo', value: d.traspaso });
    xs.push({ label: 'Surtió', value: d.surtio }, { label: 'Checó', value: d.checo }, { label: 'Embarcó', value: d.embarco });
    return xs;
  });
}
