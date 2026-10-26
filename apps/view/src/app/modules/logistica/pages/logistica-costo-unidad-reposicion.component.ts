import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import type { ParametrosReposicion, UnidadCosto } from '@megadulces/contracts';
import { simularReposicion } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LogisticaService } from '../logistica.service';
import { COSTO_UNIDAD_TABS } from '../costo-unidad-tabs';
import { rangoDe } from '../costo-unidad-fechas';

/** `[FCU.3.7]` Lo que se sabe de una unidad para simular su reposición, y lo que falta (se dice). */
export interface DatosDeUnidad {
  valor: number | null;
  km_anio: number | null;
  nota: string;
}

/** Valor de compra de la ficha y km de los últimos 12 meses; lo que no está, se declara. */
export function datosDeUnidad(purchaseValue: number | null, km: { km: number | null; fuente: string | null; dias_gps: number }, dias: number): DatosDeUnidad {
  const faltan: string[] = [];
  if (purchaseValue == null) faltan.push('la ficha no tiene valor de compra');
  if (km.km == null) faltan.push('no hay km del último año (sin GPS ni lecturas de odómetro)');
  else if (km.fuente === 'gps' && km.dias_gps < dias) faltan.push(`los km salen de ${km.dias_gps} de ${dias} días con GPS y pueden quedar cortos`);
  return {
    valor: purchaseValue,
    km_anio: km.km,
    nota: faltan.length ? `Ojo: ${faltan.join('; ')}. Escribe el dato a mano.` : 'Valor de compra de la ficha y km de los últimos 12 meses.',
  };
}

/**
 * `[FCU.3.7]` — **Reposición: ¿cuánto pierde una unidad por año y por km, contra reponerla?**
 *
 * Reemplaza la tabla lateral de la hoja (años 1–10): reponerla cuesta más cada año (incremento) y la
 * unidad vale menos (depreciación); la diferencia es lo que se pierde por seguir con ella, y eso
 * dividido entre los km del año es su costo por km. Se puede partir de una unidad (valor de compra de
 * su ficha, km de los últimos 12 meses) o escribir los datos a mano. No guarda nada: es un cálculo.
 *
 * Jerarquía: primario = lo que pierde el año 1 y por km; secundario = la tabla año por año;
 * terciario = de dónde salieron los datos.
 */
@Component({
  selector: 'app-logistica-costo-unidad-reposicion',
  standalone: true,
  imports: [CurrencyPipe, DecimalPipe, FormsModule, TableModule, SelectModule, InputNumberModule, ButtonModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, PageTabsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cr">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Costo por unidad</h1>
          <p class="surf-page-sub">Cuánto se pierde cada año por seguir con una unidad en vez de reponerla, y cuánto es eso por km. Es la tabla lateral de la hoja; no guarda nada.</p>
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" ariaLabel="Pantallas de costo por unidad" />

      <section class="cr-form" aria-label="Datos de la simulación">
        <label class="cr-campo cr-ancho">
          <span>Partir de una unidad</span>
          <p-select [options]="opciones()" optionLabel="label" optionValue="value" [ngModel]="unidadId()" (ngModelChange)="elegir($event)"
            [filter]="true" filterBy="label" [showClear]="true" placeholder="Escribir los datos a mano" appendTo="body" ariaLabel="Unidad" [loading]="cargandoLista()" />
        </label>
        <label class="cr-campo">
          <span>Valor de la unidad hoy</span>
          <p-inputnumber [ngModel]="valor()" (ngModelChange)="valor.set($event)" mode="currency" currency="MXN" locale="es-MX" [min]="0" ariaLabel="Valor de la unidad hoy" />
        </label>
        <label class="cr-campo">
          <span>Km al año</span>
          <p-inputnumber [ngModel]="kmAnio()" (ngModelChange)="kmAnio.set($event)" [min]="0" [useGrouping]="true" suffix=" km" ariaLabel="Km al año" />
        </label>
        <label class="cr-campo">
          <span>Sube reponerla, por año</span>
          <p-inputnumber [ngModel]="incremento()" (ngModelChange)="incremento.set($event)" [min]="0" [max]="100" [maxFractionDigits]="2" suffix=" %" ariaLabel="Incremento anual del precio de reposición" />
        </label>
        <label class="cr-campo">
          <span>Pierde de valor, por año</span>
          <p-inputnumber [ngModel]="depreciacion()" (ngModelChange)="depreciacion.set($event)" [min]="0" [max]="100" [maxFractionDigits]="2" suffix=" %" ariaLabel="Depreciación anual" />
        </label>
        <label class="cr-campo">
          <span>Años</span>
          <p-inputnumber [ngModel]="anios()" (ngModelChange)="anios.set($event)" [min]="1" [max]="30" ariaLabel="Años a simular" />
        </label>
        <div class="cr-campo">
          <button pButton type="button" size="small" [text]="true" severity="secondary" [disabled]="!cambiaronSupuestos()" (click)="supuestosDeLaHoja()">
            <span class="p-button-label">Volver a 5 %, 10 % y 10 años (la hoja)</span></button>
        </div>
      </section>

      <app-load-state [loading]="cargandoUnidad()" [error]="error()" [isEmpty]="false" (retry)="elegir(unidadId())">
        @if (datos(); as d) {
          <p class="cr-nota">{{ d.nota }}
            @if (leido()) { <app-freshness-pill measures="fetch" [since]="leido()!" label="datos de la unidad" /> }
          </p>
        }
        @if (tabla().length) {
          <p class="cr-titular">{{ titular() }}</p>
          <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Reposición, año 1" />
          <div class="dt-scope">
            <p-table [value]="tabla()" dataKey="anio" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack" [tableStyle]="{ 'min-width': '44rem' }">
              <ng-template #header>
                <tr>
                  <th scope="col">Año</th>
                  <th scope="col" class="comm-num">Reponerla costaría</th>
                  <th scope="col" class="comm-num">La unidad vale</th>
                  <th scope="col" class="comm-num">Pérdida acumulada</th>
                  <th scope="col" class="comm-num">Pérdida del año</th>
                  <th scope="col" class="comm-num">Por km</th>
                </tr>
              </ng-template>
              <ng-template #body let-a>
                <tr>
                  <td data-label="Año">{{ a.anio }}</td>
                  <td data-label="Reponerla costaría" class="comm-num">{{ a.valor_reposicion | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td data-label="La unidad vale" class="comm-num">{{ a.valor_residual | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td data-label="Pérdida acumulada" class="comm-num">{{ a.perdida_acumulada | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td data-label="Pérdida del año" class="comm-num">{{ a.perdida_del_anio | currency:'MXN':'symbol-narrow':'1.0-0' }}</td>
                  <td data-label="Por km" class="comm-num">
                    @if (a.por_km != null) { {{ a.por_km | currency:'MXN':'symbol-narrow':'1.2-2' }} } @else { <span class="cr-sin">sin km</span> }
                  </td>
                </tr>
              </ng-template>
            </p-table>
          </div>
          <p class="cr-como">Reponerla = valor × (1 + {{ incremento() | number:'1.0-2' }} %)<sup>año − 1</sup> · la unidad vale = valor × (1 − {{ depreciacion() | number:'1.0-2' }} %)<sup>año</sup> · pérdida del año ÷ km al año = por km.</p>
        } @else {
          <p class="cr-vacio">Elige una unidad con valor de compra en su ficha, o escribe el valor de la unidad, para ver la tabla.</p>
        }
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .cr { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .cr-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: var(--sp-2) var(--sp-3); align-items: end; }
    .cr-campo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--fg-2); }
    .cr-ancho { grid-column: span 2; }
    @container (max-width: 30rem) { .cr-ancho { grid-column: auto; } }
    .cr-nota { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--fg-2); }
    .cr-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .cr-como { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .cr-sin { color: var(--text-muted); }
    .cr-vacio { margin: 0; color: var(--fg-2); }
  `],
})
export class LogisticaCostoUnidadReposicionComponent {
  private readonly api = inject(LogisticaService);
  private readonly route = inject(ActivatedRoute);

  readonly tabs = [...COSTO_UNIDAD_TABS];
  private readonly doce = rangoDe('doce', new Date());

  readonly unidades = signal<UnidadCosto[]>([]);
  readonly cargandoLista = signal(false);
  readonly opciones = computed(() => this.unidades().map((u) => ({ value: u.vehicle_id, label: `${u.nombre} · ${u.plate}` })));

  readonly unidadId = signal<string | null>(null);
  readonly cargandoUnidad = signal(false);
  readonly error = signal<string | null>(null);
  readonly datos = signal<DatosDeUnidad | null>(null);
  readonly leido = signal<string | null>(null);

  // La hoja usa 5 % de incremento y 10 % de depreciación, a 10 años.
  readonly valor = signal<number | null>(null);
  readonly kmAnio = signal<number | null>(null);
  readonly incremento = signal(5);
  readonly depreciacion = signal(10);
  readonly anios = signal(10);
  readonly cambiaronSupuestos = computed(() => this.incremento() !== 5 || this.depreciacion() !== 10 || this.anios() !== 10);
  supuestosDeLaHoja(): void { this.incremento.set(5); this.depreciacion.set(10); this.anios.set(10); }

  readonly parametros = computed<ParametrosReposicion>(() => ({
    valor: Number(this.valor() ?? 0),
    km_anio: Number(this.kmAnio() ?? 0),
    incremento: Number(this.incremento() ?? 0) / 100,
    depreciacion: Number(this.depreciacion() ?? 0) / 100,
    anios: Number(this.anios() ?? 0),
  }));
  readonly tabla = computed(() => simularReposicion(this.parametros()));

  readonly titular = computed(() => {
    const t = this.tabla();
    if (!t.length) return '';
    const $ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
    const ultimo = t[t.length - 1];
    const porKm = t[0].por_km != null ? ` (${'$' + t[0].por_km.toFixed(2)} por km)` : ', sin km para sacarlo por km';
    return `El primer año se pierden ${$(t[0].perdida_del_anio)}${porKm}; a los ${ultimo.anio} años, ${$(ultimo.perdida_acumulada)} acumulados.`;
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const t = this.tabla();
    if (!t.length) return [];
    const ultimo = t[t.length - 1];
    const porKm = t[0].por_km;
    return [
      { label: 'Pérdida del año 1', value: t[0].perdida_del_anio, format: 'currency' },
      porKm != null
        ? { label: 'Por km, año 1', value: porKm, format: 'currency2' }
        : { label: 'Por km, año 1', value: 'sin km', format: 'text', state: 'no_medido', stateNote: 'Escribe los km al año para sacarlo por km' },
      { label: `Acumulada a ${ultimo.anio} años`, value: ultimo.perdida_acumulada, format: 'currency' },
      { label: `La unidad vale al año ${ultimo.anio}`, value: ultimo.valor_residual, format: 'currency' },
    ];
  });

  constructor() {
    this.cargandoLista.set(true);
    this.api.costoUnidadResumen(this.doce.desde, this.doce.hasta).subscribe({
      next: (r) => { this.unidades.set(r.unidades); this.cargandoLista.set(false); },
      // Sin lista se puede seguir escribiendo a mano; el error se dice en el selector vacío.
      error: () => { this.cargandoLista.set(false); },
    });
    const id = this.route.snapshot.queryParamMap.get('unidad');
    if (id) this.elegir(id);
  }

  elegir(id: string | null): void {
    this.unidadId.set(id);
    this.error.set(null);
    if (!id) { this.datos.set(null); this.leido.set(null); return; }
    this.cargandoUnidad.set(true);
    this.api.costoUnidadDetalle(id, this.doce.desde, this.doce.hasta).subscribe({
      next: (d) => {
        const datos = datosDeUnidad(d.ficha.purchase_value, d.unidad.km, d.periodo.dias);
        this.datos.set(datos);
        this.valor.set(datos.valor);
        this.kmAnio.set(datos.km_anio);
        this.leido.set(d.leido_at);
        this.cargandoUnidad.set(false);
      },
      error: (e) => { this.cargandoUnidad.set(false); this.error.set(e?.error?.message ?? 'No se pudo leer la unidad.'); },
    });
  }
}
