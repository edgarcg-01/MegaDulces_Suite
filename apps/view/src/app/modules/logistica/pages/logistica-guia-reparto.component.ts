import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { firstValueFrom } from 'rxjs';
import type { GuiaRepartoBusqueda, GuiaRepartoHoja, GuiaRepartoViaje, GuiaRepartoViajes } from '@megadulces/contracts';
import { normalizarNumeroDeGuia, warehouseName } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { abrirPestanaParaPdf, cerrarPestanaDePdf, entregarPdf } from '../../../shared/util/abrir-pdf';
import { LogisticaService } from '../logistica.service';
import { archivoGuia, archivoGuias, pdfGuiaReparto, pdfGuiasReparto } from '../guia-reparto-pdf';

const p2 = (n: number) => String(n).padStart(2, '0');
/** AAAA-MM-DD de una fecha LOCAL (la del selector), sin pasar por UTC. */
export const aYmd = (d: Date): string => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
/** Hoy en hora de México, como AAAA-MM-DD. */
export const hoyMx = (): string => aYmd(new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' })));
const deYmd = (s: string): Date => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** El titular: cuántos viajes hay ese día, dónde, y si son sólo los del chofer. Lo primero que se lee (Q.1). */
export function titularViajes(d: GuiaRepartoViajes, hoy: string): string {
  const cuando = d.fecha === hoy ? 'Hoy' : `El ${d.fecha.split('-').reverse().join('/')}`;
  if (d.filtro.motivo) return 'No podemos mostrarte tus viajes todavía.';
  const tuyos = d.filtro.por_chofer;
  if (!d.rows.length) return tuyos ? `${cuando} no tienes viajes asignados.` : `${cuando} no hay viajes de Kepler en tus sucursales.`;
  const n = `${d.rows.length} ${d.rows.length === 1 ? 'viaje' : 'viajes'}`;
  if (tuyos) return `${cuando} tienes ${n}${d.filtro.chofer_nombre ? ', ' + d.filtro.chofer_nombre.replace(/\.+$/, '') : ''}.`;
  // Quien coordina: los conteos van en la tira de abajo; el titular no los repite.
  const sucs = [...new Set(d.rows.map((r) => r.sucursal))];
  const donde = sucs.length === 1 ? `en ${warehouseName(sucs[0]) || sucs[0]}` : `en ${sucs.length} sucursales`;
  return `${d.fecha === hoy ? 'Viajes de hoy' : `Viajes del ${d.fecha.split('-').reverse().join('/')}`} ${donde}.`;
}

/**
 * Qué decirle a quien no ve viajes, y qué hacer. Cada chofer ve sólo los suyos (PM, 2026-11-09): si
 * no aparecen, la causa es de configuración y se dice cuál, con quién la arregla.
 */
export function vacioDeViajes(d: GuiaRepartoViajes | null): { titulo: string; pista: string } {
  if (d?.filtro.motivo === 'sin_ficha_de_chofer') {
    return { titulo: 'Tu usuario no está ligado a tu ficha de chofer', pista: 'Pídele a Logística que te ligue en Flotilla: en tu ficha de chofer, el campo «Cuenta del sistema». Mientras, no podemos saber cuáles viajes son tuyos.' };
  }
  if (d?.filtro.motivo === 'sin_clave_kepler') {
    // La clave de Kepler no se captura en ninguna pantalla hoy: no se manda a una que no la tiene.
    return { titulo: 'Tu ficha de chofer no tiene tu clave de Kepler', pista: 'Con ella sabemos cuáles viajes son tuyos. Hoy no se captura en pantalla: pídele a Logística que lo reporte a Sistemas.' };
  }
  if (d?.filtro.por_chofer) {
    return { titulo: 'No tienes viajes este día', pista: 'Un viaje es tuyo cuando almacén te captura como chofer en la salida por embarque de Kepler. Si ya vas a salir y no aparece, pídele a almacén que te capture en el embarque.' };
  }
  return { titulo: 'No hay viajes para este día', pista: 'Un viaje aparece cuando almacén captura en Kepler la salida por embarque. Si el camión ya salió, revisa la fecha.' };
}

/** El titular al buscar por número: cuántos viajes tienen ese número. */
export function titularBusqueda(b: GuiaRepartoBusqueda): string {
  const n = b.guia ? String(Number(b.guia)) : '';
  if (b.filtro.motivo) return 'No podemos mostrarte tus viajes todavía.';
  if (!b.rows.length) return `No encontramos la guía ${n}.`;
  if (b.rows.length === 1) return `Guía ${n}.`;
  return `La guía ${n} existe en ${b.rows.length} viajes: cada sucursal lleva su propia numeración. Escoge la tuya.`;
}

/** Qué decir cuando el número no da con ninguna guía, y por qué puede ser. */
export function vacioDeBusqueda(b: GuiaRepartoBusqueda): { titulo: string; pista: string } {
  if (b.filtro.motivo) return vacioDeViajes({ fecha: '', rows: [], filtro: b.filtro });
  return {
    titulo: `No encontramos la guía ${b.guia ? Number(b.guia) : ''}`,
    pista: b.filtro.por_chofer
      ? 'Sólo ves tus guías. Si es tuya, pídele a almacén que te capture como chofer en su salida por embarque.'
      : 'Revisa el número. Sólo se buscan las guías de tus sucursales, y la carga de una camioneta de Ruta Directa no lleva guía de reparto.',
  };
}

/**
 * `[EMB.56]` **Guía de reparto** — el chofer escoge su viaje del día e imprime su hoja de ruta.
 *
 * La pregunta que contesta: *¿qué hoja me llevo hoy?* El viaje se reconoce por la unidad, las
 * placas y los pueblos; un clic arma el PDF (paradas en orden de visita, domicilio de entrega,
 * bultos, folios factura > embarque > pedido, firma de recibido). **Sin importes**: el chofer no
 * cobra (PM, 2026-11-09). Diseño, los 12 pasos: FASE_EMB §8.1.
 *
 * Jerarquía: primario = el titular y la lista de viajes con su botón; secundario = unidad, paradas y
 * a dónde va; terciario = la fecha y la edad del dato.
 */
@Component({
  selector: 'app-logistica-guia-reparto',
  standalone: true,
  imports: [FormsModule, TableModule, ButtonModule, DatePickerModule, InputTextModule, ToastModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SucursalPipe],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page gr">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Guía de reparto</h1>
          <p class="surf-page-sub">Imprime la hoja de ruta de tu viaje: las paradas en orden, el domicilio de entrega, los bultos y los folios de factura, embarque y pedido. Sin importes. Cada chofer ve sólo sus viajes.</p>
        </div>
      </header>

      <section class="gr-barra" aria-label="Día">
        <p-datepicker [ngModel]="fechaDate()" (ngModelChange)="cambiarFecha($event)" dateFormat="dd/mm/yy" [showIcon]="true"
                      [maxDate]="maxFecha" inputId="gr-fecha" ariaLabel="Día del viaje" appendTo="body" class="gr-fecha" />
        @if (fecha() !== hoy && !busqueda()) {
          <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="cambiarFecha(null)"><span class="p-button-label">Volver a hoy</span></button>
        }
        <!-- Reimprimir sin navegar el calendario: el número de la guía y Enter (antes, 6 clics para llegar al 23-jul). -->
        <form class="gr-buscar" role="search" aria-label="Reimprimir una guía por su número" (submit)="$event.preventDefault(); buscar()">
          <input pInputText name="guia" class="gr-numero" inputmode="numeric" autocomplete="off" placeholder="Número de guía, p. ej. 969"
                 aria-label="Número de guía" [ngModel]="numero()" (ngModelChange)="numero.set($event)" />
          <button pButton type="submit" severity="secondary" [outlined]="true" class="gr-btn" [disabled]="!!imprimiendo()" [loading]="imprimiendo() === BUSCAR">
            <span class="p-button-icon p-button-icon-left pi pi-search" aria-hidden="true"></span><span class="p-button-label">Reimprimir</span>
          </button>
        </form>
        @if (busqueda()) {
          <button pButton type="button" size="small" [text]="true" severity="secondary" (click)="salirDeBusqueda()"><span class="p-button-label">Volver a los viajes del día</span></button>
        }
        <span class="gr-espacio"></span>
        @if (data()) { <app-freshness-pill measures="fetch" [since]="leido()" label="viajes de Kepler" /> }
      </section>

      <!-- El chofer con varias guías no las imprime una por una: un archivo, una guía por hoja. -->
      @if (data()?.filtro?.por_chofer && filas().length > 1) {
        <div class="gr-todas">
          <button pButton type="button" class="gr-btn" [disabled]="!!imprimiendo()" [loading]="imprimiendo() === TODAS"
                  (click)="imprimirTodas()" [attr.aria-label]="'Imprimir tus ' + filas().length + ' guías, una por hoja'">
            <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span><span class="p-button-label">Imprimir todas ({{ filas().length }})</span>
          </button>
          <span class="gr-sub">Una guía por hoja, cada una con su firma. También puedes imprimir sólo una.</span>
        </div>
      }

      @if (busqueda()) { <p class="gr-titular" role="status">{{ titular() }}</p> }
      @if (!busqueda() && data(); as d) {
        <p class="gr-titular">{{ titular() }}</p>
        <!-- El chofer ve uno o dos viajes: el titular ya los cuenta y la tira sólo repetiría. -->
        @if (d.rows.length && !d.filtro.por_chofer) { <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Viajes del día" /> }
      }

      <app-load-state [loading]="cargando() && !data() && !busqueda()" [error]="error()" [isEmpty]="!!(busqueda() || data()) && !filas().length"
                      emptyIcon="pi-truck" [emptyTitle]="vacio().titulo" [emptyHint]="vacio().pista"
                      (retry)="cargar()">
        <div class="dt-scope">
          <p-table [value]="filas()" [dataKey]="'clave'" size="small" class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack" [tableStyle]="{ 'min-width': '44rem' }">
            <ng-template #header>
              <tr>
                <th scope="col">Viaje</th>
                <th scope="col">Unidad</th>
                <th scope="col" class="comm-num">Paradas</th>
                <th scope="col">A dónde va</th>
                <th scope="col"><span class="sr-only">Imprimir</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-v>
              <tr>
                <td data-label="Viaje">
                  <!-- El número de guía como lo imprime Kepler; la sucursal, por nombre (nunca «01-G…»). -->
                  <span class="gr-viaje">Guía {{ v.guia }}</span>
                  @if (variasSucursales()) { <span class="gr-sub">{{ v.sucursal | sucursal }}</span> }
                  <!-- Al buscar por número salen guías de días distintos: el día distingue a la 969 de CEDIS de la de Padre Hidalgo. -->
                  @if (busqueda()) { <span class="gr-sub">{{ dmy(v.fecha) }}</span> }
                </td>
                <td data-label="Unidad">{{ v.unidad_descripcion || 'Sin unidad en Kepler' }}@if (v.unidad_placas) { <span class="gr-sub">{{ v.unidad_placas }}</span> }
                  @if (v.asignado_por === 'unidad') {
                    <!-- Respaldo, no certeza: la unidad de Kepler no siempre es el camión que salió (FASE_EMB §8). -->
                    <span class="gr-aviso"><i class="pi pi-info-circle" aria-hidden="true"></i> Te sale por tu camión: almacén no te capturó como chofer en este embarque.</span>
                  }
                </td>
                <td data-label="Paradas" class="comm-num">{{ v.paradas }}</td>
                <td data-label="A dónde va">{{ v.destinos_texto || 'Sin destino en Kepler' }}</td>
                <td class="gr-accion">
                  <!-- Una sola primaria por pantalla: con un viaje (el chofer), su botón; con varios, todos secundarios. -->
                  <button pButton type="button" class="gr-btn" [outlined]="filas().length > 1" [disabled]="!!imprimiendo()" [loading]="imprimiendo() === v.clave"
                          (click)="imprimir(v)" [attr.aria-label]="'Imprimir la guía ' + v.guia + (variasSucursales() ? ' de ' + (v.sucursal | sucursal) : '')">
                    <span class="p-button-icon p-button-icon-left pi pi-print" aria-hidden="true"></span><span class="p-button-label">Imprimir guía</span>
                  </button>
                </td>
              </tr>
            </ng-template>
          </p-table>
        </div>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .gr { display: flex; flex-direction: column; gap: var(--sp-3); container-type: inline-size; }
    .gr-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .gr-fecha { min-width: 11rem; }
    .gr-espacio { flex: 1; }
    .gr-titular { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); color: var(--fg-1); }
    .gr-viaje { font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums; }
    .gr-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
    .gr-accion { text-align: right; white-space: nowrap; }
    .gr-buscar { display: flex; align-items: center; gap: var(--sp-2); }
    .gr-numero { width: 13rem; }
    .gr-todas { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    .gr-todas .gr-sub { display: inline; }
    .gr-aviso { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    /* El chofer puede entrar desde el teléfono: el botón llega a 44 px con el dedo. */
    @media (pointer: coarse) { .gr-btn { min-height: 2.75rem; } }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class LogisticaGuiaRepartoComponent {
  private readonly api = inject(LogisticaService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly hoy = hoyMx();
  readonly maxFecha = deYmd(this.hoy);
  readonly fecha = signal(this.hoy);
  readonly fechaDate = computed(() => deYmd(this.fecha()));

  readonly data = signal<GuiaRepartoViajes | null>(null);
  readonly leido = signal(new Date().toISOString());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /** La clave del viaje que se está imprimiendo: deshabilita TODOS los botones (doble clic). */
  readonly imprimiendo = signal<string | null>(null);

  /** Lo tecleado en «Número de guía». */
  readonly numero = signal('');
  /** El resultado de buscar por número; mientras exista, la lista muestra eso y no el día. */
  readonly busqueda = signal<GuiaRepartoBusqueda | null>(null);
  readonly BUSCAR = '*buscar*';
  readonly dmy = (f: string | null) => (f ? f.split('-').reverse().join('/') : 'sin fecha');

  readonly filas = computed(() => (this.busqueda()?.rows ?? this.data()?.rows ?? []).map((r) => ({ ...r, clave: `${r.sucursal}|${r.guia}` })));
  readonly variasSucursales = computed(() => new Set(this.filas().map((r) => r.sucursal)).size > 1);
  readonly titular = computed(() => {
    const b = this.busqueda();
    if (b) return titularBusqueda(b);
    const d = this.data();
    return d ? titularViajes(d, this.hoy) : '';
  });
  readonly vacio = computed(() => { const b = this.busqueda(); return b ? vacioDeBusqueda(b) : vacioDeViajes(this.data()); });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const f = this.filas();
    return [
      { label: 'Viajes', value: f.length, format: 'number' },
      { label: 'Paradas', value: f.reduce((a, r) => a + r.paradas, 0), format: 'number' },
    ];
  });

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.getGuiaRepartoViajes(this.fecha()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.leido.set(new Date().toISOString()); this.cargando.set(false); },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message ?? 'No se pudieron leer los viajes de Kepler.'); },
    });
  }

  /** `null` = volver a hoy. */
  cambiarFecha(d: Date | null): void {
    const f = d ? aYmd(d) : this.hoy;
    this.busqueda.set(null); // escoger un día sale de la búsqueda por número
    if (f === this.fecha()) return;
    this.fecha.set(f);
    this.data.set(null);
    this.cargar();
  }

  /**
   * Reimprimir por número: «969» + Enter. Si el número da UN viaje, se imprime directo; si da varios
   * (el número es por sucursal: la 969 está en Padre Hidalgo y en CEDIS), se muestran para escoger y
   * no se imprime ninguno a ciegas. La pestaña se abre DENTRO del gesto (si no, el navegador la bloquea)
   * y se cierra si al final no hay una sola guía que imprimir.
   */
  async buscar(): Promise<void> {
    if (this.imprimiendo()) return;
    const guia = normalizarNumeroDeGuia(this.numero());
    if (!guia) {
      this.toast.add({ severity: 'warn', summary: 'Escribe el número de la guía', detail: 'Por ejemplo 969, como sale en la hoja de Kepler.', life: 5000 });
      return;
    }
    this.imprimiendo.set(this.BUSCAR);
    const win = abrirPestanaParaPdf('Buscando la guía…');
    try {
      const b = await firstValueFrom(this.api.buscarGuiaReparto(guia));
      this.busqueda.set(b);
      if (b.rows.length !== 1) { cerrarPestanaDePdf(win); return; }
      const v = b.rows[0];
      const h = await firstValueFrom(this.api.getGuiaReparto(v.sucursal, v.guia));
      const donde = entregarPdf(win, await pdfGuiaReparto(h, new Date()), archivoGuia(h), { imprimir: true });
      if (donde === 'descarga') {
        this.toast.add({ severity: 'info', summary: 'La guía se descargó', detail: 'El navegador no abrió la pestaña: ábrela desde tus descargas para imprimirla.', life: 6000 });
      }
    } catch (e: any) {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudo buscar la guía', detail: e?.error?.message ?? 'Intenta de nuevo.' });
    } finally {
      this.imprimiendo.set(null);
    }
  }

  salirDeBusqueda(): void {
    this.busqueda.set(null);
    this.numero.set('');
  }

  /** Marca de «imprimiendo todas» en `imprimiendo()` (no choca con ninguna clave sucursal|guía). */
  readonly TODAS = '*todas*';

  /**
   * Todas las guías del chofer en UN archivo, una por hoja. Se piden en secuencia; si una falla, se
   * imprimen las demás y se dice cuál faltó (fallo parcial ≠ fallo total): no se deja al chofer sin
   * hoja por una guía que no se pudo leer.
   */
  async imprimirTodas(): Promise<void> {
    if (this.imprimiendo()) return;
    const viajes = this.filas();
    if (!viajes.length) return;
    this.imprimiendo.set(this.TODAS);
    const win = abrirPestanaParaPdf('Preparando tus guías de reparto…');
    try {
      const hojas: GuiaRepartoHoja[] = [];
      const fallaron: string[] = [];
      for (const v of viajes) {
        try { hojas.push(await firstValueFrom(this.api.getGuiaReparto(v.sucursal, v.guia))); }
        catch { fallaron.push(v.guia); }
      }
      if (!hojas.length) {
        cerrarPestanaDePdf(win);
        this.toast.add({ severity: 'error', summary: 'No se pudo leer ninguna guía', detail: 'Intenta de nuevo.' });
        return;
      }
      const blob = await pdfGuiasReparto(hojas, new Date());
      const donde = entregarPdf(win, blob, archivoGuias(hojas), { imprimir: true });
      if (fallaron.length) {
        this.toast.add({ severity: 'warn', summary: `Se armaron ${hojas.length} de ${viajes.length} guías`,
          detail: `No se pudo leer: ${fallaron.map((g) => 'guía ' + g).join(', ')}. Imprímela con su botón.`, life: 10000 });
      } else if (donde === 'descarga') {
        this.toast.add({ severity: 'info', summary: 'Las guías se descargaron', detail: 'El navegador no abrió la pestaña: ábrelas desde tus descargas para imprimirlas.', life: 6000 });
      }
    } catch {
      cerrarPestanaDePdf(win);
      this.toast.add({ severity: 'error', summary: 'No se pudieron armar las guías', detail: 'Intenta de nuevo.' });
    } finally {
      this.imprimiendo.set(null);
    }
  }

  /**
   * La pestaña se abre DENTRO del clic (si no, el navegador la bloquea al llegar la respuesta) y el
   * PDF se arma en el navegador con lo que manda el endpoint. Sin pestaña, se descarga.
   */
  imprimir(v: GuiaRepartoViaje & { clave: string }): void {
    if (this.imprimiendo()) return;
    this.imprimiendo.set(v.clave);
    const win = abrirPestanaParaPdf('Preparando la guía de reparto…');
    this.api.getGuiaReparto(v.sucursal, v.guia).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: async (h) => {
        try {
          const blob = await pdfGuiaReparto(h, new Date());
          const donde = entregarPdf(win, blob, archivoGuia(h), { imprimir: true });
          if (donde === 'descarga') {
            this.toast.add({ severity: 'info', summary: 'La guía se descargó', detail: 'El navegador no abrió la pestaña: ábrela desde tus descargas para imprimirla.', life: 6000 });
          }
        } catch {
          cerrarPestanaDePdf(win);
          this.toast.add({ severity: 'error', summary: 'No se pudo armar la guía', detail: 'Intenta de nuevo.' });
        } finally {
          this.imprimiendo.set(null);
        }
      },
      error: (e) => {
        cerrarPestanaDePdf(win);
        this.imprimiendo.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo leer el viaje', detail: e?.error?.message ?? '' });
      },
    });
  }
}
