import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import type { SupervisorRuta, SupervisorTablero } from '@megadulces/contracts';
import { ComercialService } from '../comercial.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { REPORTS_TABS } from '../reports-tabs';

/** Los presets del selector. "Semana" es el filtro que el supervisor pidió por nombre. */
type Preset = 'semana' | 'semana_pasada' | 'mes' | 'treinta' | 'custom';

/** Una fila del pivote día × ruta. */
interface FilaDia {
  fecha: string;
  porRuta: Record<string, number>;
  total: number;
}

@Component({
  selector: 'app-comercial-mis-rutas',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, SelectButtonModule,
    DatePickerModule, TagModule, ToggleSwitchModule, PageTabsComponent, MetricStripComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-tabs [tabs]="tabs"></app-page-tabs>

    <div class="mr">
      <header class="mr-head">
        <div>
          <h1 class="mr-title">Mis rutas</h1>
          <p class="mr-sub">
            Cómo va el equipo contra su meta, día por día.
            @if (data(); as d) {
              <span class="mr-alcance">
                {{ d.alcance.reportes }} persona(s) · {{ d.alcance.rutas.length }} ruta(s)
              </span>
            }
          </p>
        </div>
        <div class="mr-actions">
          <p-selectbutton
            [options]="presets" [ngModel]="preset()" (ngModelChange)="setPreset($event)"
            optionLabel="label" optionValue="value" [allowEmpty]="false" />
          @if (preset() === 'custom') {
            <p-datepicker [(ngModel)]="rango" selectionMode="range" dateFormat="dd/mm/yy"
              [readonlyInput]="true" (onSelect)="cargarSiRangoCompleto()" />
          }
          <label class="mr-todas">
            <p-toggleswitch [ngModel]="verTodas()" (ngModelChange)="setVerTodas($event)" />
            <span>Ver todas las rutas</span>
          </label>
          <p-button icon="pi pi-refresh" [text]="true" (onClick)="cargar()"
            [loading]="cargando()" ariaLabel="Actualizar" />
        </div>
      </header>

      @if (error(); as e) {
        <div class="mr-aviso mr-aviso--error">
          <i class="pi pi-exclamation-triangle"></i><span>{{ e }}</span>
        </div>
      }

      @if (data(); as d) {
        <!-- El alcance vacío se EXPLICA. Una tabla vacía sin motivo se lee como "hoy no vendió
             nadie", que es una afirmación distinta y falsa. -->
        @if (d.alcance.motivo) {
          <div class="mr-aviso mr-aviso--vacio">
            <i class="pi pi-users"></i>
            <span>
              @if (d.alcance.motivo === 'sin_equipo') {
                No tenés personas asignadas, así que no hay rutas que mostrar.
                Lo resuelve quien administra personas.
              } @else {
                Tenés {{ d.alcance.reportes }} persona(s) asignada(s), y a ninguna se le declaró ruta.
                Lo resuelve quien asigna rutas.
              }
            </span>
          </div>
        }

        <app-metric-strip [items]="metricas()" />

        <!-- ── Por ruta ────────────────────────────────────────────────────────────── -->
        <section class="mr-bloque">
          <h2 class="mr-h2">Por ruta</h2>
          <p-table [value]="d.rutas" class="p-datatable-sm" [scrollable]="true" scrollHeight="340px"
                   dataKey="route_code" [tableStyle]="{ 'min-width': '60rem' }">
            <ng-template #header>
              <tr>
                <th>Ruta</th>
                <th class="num">Días</th>
                <th class="num">Venta del periodo</th>
                <th class="num">Tickets</th>
                <th class="num">Ticket prom.</th>
                <th class="num">Mes a la fecha</th>
                <th class="num">Meta del mes</th>
                <th>Cómo va</th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td>
                  <span class="mr-cod">{{ r.route_code }}</span>
                  <span class="mr-eti">{{ nombreDe(r) }}</span>
                </td>
                <td class="num">{{ r.dias_operados }}</td>
                <td class="num mr-fuerte">{{ r.venta | currency: 'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="num">{{ r.tickets | number }}</td>
                <td class="num">
                  @if (r.ticket_promedio !== null) {
                    {{ r.ticket_promedio | currency: 'MXN':'symbol-narrow':'1.0-0' }}
                  } @else { <span class="mr-nulo" title="Sin tickets en el periodo">—</span> }
                </td>
                <td class="num">{{ r.venta_mes | currency: 'MXN':'symbol-narrow':'1.0-0' }}</td>
                <td class="num">
                  @if (r.meta_mes !== null) {
                    {{ r.meta_mes | currency: 'MXN':'symbol-narrow':'1.0-0' }}
                  } @else { <span class="mr-nulo" title="Nadie capturó la meta de esta ruta">Sin capturar</span> }
                </td>
                <td>
                  <p-tag [value]="etiquetaEstado(r.estado)" [severity]="severidad(r.estado)"
                         [title]="r.estado_motivo || ''" />
                  @if (r.avance !== null) {
                    <span class="mr-avance">{{ r.avance | percent: '1.0-0' }}</span>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="8" class="mr-vacio">Sin venta en el periodo elegido.</td></tr>
            </ng-template>
          </p-table>
        </section>

        <!-- ── Día a día ───────────────────────────────────────────────────────────── -->
        <section class="mr-bloque">
          <h2 class="mr-h2">Día a día</h2>
          <p-table [value]="pivote()" class="p-datatable-sm" [scrollable]="true" scrollHeight="320px"
                   [tableStyle]="{ 'min-width': '48rem' }">
            <ng-template #header>
              <tr>
                <th>Día</th>
                @for (c of codigos(); track c) { <th class="num">{{ c }}</th> }
                <th class="num">Total</th>
              </tr>
            </ng-template>
            <ng-template #body let-f>
              <tr>
                <td class="mr-fecha">{{ f.fecha }}</td>
                @for (c of codigos(); track c) {
                  <td class="num">
                    @if (f.porRuta[c]) {
                      {{ f.porRuta[c] | currency: 'MXN':'symbol-narrow':'1.0-0' }}
                    } @else { <span class="mr-nulo" title="Sin venta ese día">—</span> }
                  </td>
                }
                <td class="num mr-fuerte">{{ f.total | currency: 'MXN':'symbol-narrow':'1.0-0' }}</td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="codigos().length + 2" class="mr-vacio">Sin días con venta.</td></tr>
            </ng-template>
          </p-table>
        </section>

        <!-- ── Lo que esta pantalla NO sabe ────────────────────────────────────────── -->
        <!-- Va al pie y en palabras, no escondido en un tooltip: una cifra sin su hueco
             declarado se lee como si el hueco no existiera. -->
        <footer class="mr-pie">
          <p>
            <i class="pi pi-info-circle"></i>
            <strong>Cobertura:</strong> {{ d.cobertura.note }}
          </p>
          @if (sinMeta() > 0) {
            <p>
              <i class="pi pi-flag"></i>
              <strong>{{ sinMeta() }} ruta(s) sin meta:</strong>
              hay venta y no hay contra qué compararla, así que no se dice si van bien o mal.
            </p>
          }
          <p>
            <i class="pi pi-dollar"></i>
            <strong>Sin margen:</strong> la fuente no trae el costo de estas rutas, así que no se
            publica un margen que sería inventado.
          </p>
          <p class="mr-frescura">
            <i class="pi pi-clock"></i>
            @if (d.freshness.data_as_of) {
              Datos al {{ d.freshness.data_as_of | date: 'short' }}
              @if (d.freshness.stale) { <span class="mr-rezago">· con rezago</span> }
            } @else { Frescura sin medir. }
          </p>
        </footer>
      } @else if (!cargando() && !error()) {
        <p class="mr-vacio">Elegí un periodo para ver cómo va el equipo.</p>
      }
    </div>
  `,
  styles: [`
    .mr { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
    .mr-head { display: flex; justify-content: space-between; align-items: flex-start;
               gap: var(--space-3); flex-wrap: wrap; }
    .mr-title { font-size: var(--fs-xl); font-weight: 700; margin: 0; }
    .mr-sub { font-size: var(--fs-sm); color: var(--text-muted); margin: var(--space-1) 0 0; }
    .mr-alcance { margin-left: var(--space-2); color: var(--text-subtle); }
    .mr-actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
    .mr-todas { display: flex; align-items: center; gap: var(--space-2);
                font-size: var(--fs-sm); color: var(--text-muted); cursor: pointer; }
    .mr-bloque { display: flex; flex-direction: column; gap: var(--space-2); }
    .mr-h2 { font-size: var(--fs-base); font-weight: 600; margin: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .mr-fuerte { font-weight: 600; }
    .mr-cod { font-weight: 600; margin-right: var(--space-2); }
    .mr-eti { font-size: var(--fs-xs); color: var(--text-muted); }
    .mr-fecha { font-variant-numeric: tabular-nums; }
    /* El guion es un NO MEDIDO con motivo en el title, no un cero: un 0 en una celda de
       dinero se lee como "vendio cero", y "no hubo fila" es otra cosa. */
    .mr-nulo { color: var(--text-subtle); }
    .mr-avance { margin-left: var(--space-2); font-size: var(--fs-xs); color: var(--text-muted); }
    .mr-vacio { padding: var(--space-4); text-align: center; color: var(--text-muted); }
    .mr-aviso { display: flex; align-items: center; gap: var(--space-2);
                padding: var(--space-3); border-radius: var(--radius-md); font-size: var(--fs-sm); }
    .mr-aviso--error { background: var(--danger-soft); color: var(--danger-strong); }
    .mr-aviso--vacio { background: var(--surface-2); color: var(--text-muted); }
    .mr-pie { display: flex; flex-direction: column; gap: var(--space-1);
              font-size: var(--fs-xs); color: var(--text-muted);
              border-top: 1px solid var(--border-subtle); padding-top: var(--space-3); }
    .mr-pie p { margin: 0; display: flex; align-items: center; gap: var(--space-2); }
    .mr-rezago { color: var(--warn-strong); }
    @media (max-width: 40rem) {
      .mr-head { flex-direction: column; }
      .mr-actions { width: 100%; }
    }
  `],
})
export class ComercialMisRutasComponent {
  private readonly svc = inject(ComercialService);

  readonly tabs = REPORTS_TABS;
  readonly presets = [
    { label: 'Esta semana', value: 'semana' as Preset },
    { label: 'Semana pasada', value: 'semana_pasada' as Preset },
    { label: 'Este mes', value: 'mes' as Preset },
    { label: '30 días', value: 'treinta' as Preset },
    { label: 'Otro', value: 'custom' as Preset },
  ];

  readonly preset = signal<Preset>('semana');
  readonly verTodas = signal(false);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly data = signal<SupervisorTablero | null>(null);
  rango: Date[] = [];

  constructor() {
    this.cargar();
  }

  setPreset(p: Preset) {
    this.preset.set(p);
    if (p !== 'custom') this.cargar();
  }

  setVerTodas(v: boolean) {
    this.verTodas.set(v);
    this.cargar();
  }

  cargarSiRangoCompleto() {
    if (this.rango?.length === 2 && this.rango[1]) this.cargar();
  }

  cargar() {
    const { desde, hasta } = this.ventana();
    if (!desde || !hasta) return;
    this.cargando.set(true);
    this.error.set(null);
    this.svc.misRutas(desde, hasta, this.verTodas()).subscribe({
      next: (d) => { this.data.set(d); this.cargando.set(false); },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo cargar el tablero.');
        this.cargando.set(false);
      },
    });
  }

  /**
   * La ventana del preset. La semana arranca el LUNES, que es como se habla de la semana
   * de ruta acá; `getDay()` devuelve 0 para domingo, así que se corrige a 7 antes de restar.
   */
  private ventana(): { desde: string; hasta: string } {
    const hoy = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const menos = (d: Date, n: number) => new Date(d.getTime() - n * 86400000);
    const dow = hoy.getDay() === 0 ? 7 : hoy.getDay();

    switch (this.preset()) {
      case 'semana':
        return { desde: iso(menos(hoy, dow - 1)), hasta: iso(hoy) };
      case 'semana_pasada': {
        const lunPasado = menos(hoy, dow - 1 + 7);
        return { desde: iso(lunPasado), hasta: iso(menos(lunPasado, -6)) };
      }
      case 'mes':
        return { desde: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), hasta: iso(hoy) };
      case 'treinta':
        return { desde: iso(menos(hoy, 29)), hasta: iso(hoy) };
      case 'custom':
        return this.rango?.length === 2 && this.rango[1]
          ? { desde: iso(this.rango[0]), hasta: iso(this.rango[1]) }
          : { desde: '', hasta: '' };
    }
  }

  readonly codigos = computed(() => (this.data()?.rutas ?? []).map((r) => r.route_code));

  /** El pivote día × ruta. Es lo que hace legible "cómo van día a día" con 4 o 19 rutas. */
  readonly pivote = computed<FilaDia[]>(() => {
    const d = this.data();
    if (!d) return [];
    const porFecha = new Map<string, FilaDia>();
    for (const p of d.serie) {
      let f = porFecha.get(p.business_date);
      if (!f) { f = { fecha: p.business_date, porRuta: {}, total: 0 }; porFecha.set(p.business_date, f); }
      f.porRuta[p.route_code] = (f.porRuta[p.route_code] ?? 0) + p.venta;
      f.total += p.venta;
    }
    return [...porFecha.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  });

  readonly sinMeta = computed(
    () => (this.data()?.rutas ?? []).filter((r) => r.estado === 'sin_meta').length,
  );

  readonly metricas = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    const venta = d.rutas.reduce((a, r) => a + r.venta, 0);
    const tickets = d.rutas.reduce((a, r) => a + r.tickets, 0);
    const ventaMes = d.rutas.reduce((a, r) => a + r.venta_mes, 0);
    const conMeta = d.rutas.filter((r) => r.meta_mes !== null);
    const metaTotal = conMeta.reduce((a, r) => a + (r.meta_mes ?? 0), 0);
    return [
      { label: 'Venta del periodo', value: venta, format: 'currency' },
      { label: 'Tickets', value: tickets, format: 'number' },
      {
        label: 'Ticket promedio',
        value: tickets > 0 ? venta / tickets : '—',
        format: tickets > 0 ? 'currency' : undefined,
        sub: tickets > 0 ? undefined : 'Sin tickets en el periodo',
      },
      {
        label: 'Mes a la fecha',
        value: ventaMes,
        format: 'currency',
        // Sin meta NO se pinta avance: el hueco se nombra, no se rellena con un 0 %.
        sub: metaTotal > 0
          ? Math.round((ventaMes / metaTotal) * 100) + '% de la meta de ' + conMeta.length + ' ruta(s)'
          : 'Sin meta capturada',
        // Sin tono a proposito: 'muted' NO existe en MetricTone y `.ms-item.tone-default`
        // tampoco tiene regla, asi que no pintaba nada -- el hueco lo nombra el `sub`.
      },
    ];
  });

  nombreDe(r: SupervisorRuta): string {
    if (!r.etiqueta) return '';
    // La etiqueta del catálogo trae el código pegado al nombre del vendedor; en la tabla el
    // código ya está en su propia columna, así que acá sobra.
    return r.etiqueta.startsWith(r.route_code)
      ? r.etiqueta.slice(r.route_code.length).trim()
      : r.etiqueta;
  }

  etiquetaEstado(e: SupervisorRuta['estado']): string {
    return {
      ok: 'En meta', warn: 'Atrás', bad: 'Lejos',
      sin_meta: 'Sin meta', sin_medir: 'Sin medir',
    }[e];
  }

  severidad(e: SupervisorRuta['estado']): 'success' | 'warn' | 'danger' | 'secondary' {
    return { ok: 'success', warn: 'warn', bad: 'danger',
             sin_meta: 'secondary', sin_medir: 'secondary' }[e] as
      'success' | 'warn' | 'danger' | 'secondary';
  }
}
