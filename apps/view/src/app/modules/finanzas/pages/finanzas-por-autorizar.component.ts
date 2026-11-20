import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import type { BandejaAutorizacion, PedidoPorAutorizar } from '@megadulces/contracts';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { CarteraSegmentsComponent } from '../cartera-segments.component';
import { AutorizacionPedidosService } from '../autorizacion-pedidos.service';

/** Las condiciones de la regla, en el orden del anexo EA §3.1, como las lee Crédito y cobranza. */
export const CONDICIONES = [
  'Tiene límite en Kepler',
  'Lo que debe, sus otros pedidos y éste caben en el límite',
  'Nada vencido fuera de la gracia (los centavos no cuentan)',
  'No está marcado NO TOCAR',
  'Los datos son recientes',
  'La autorización automática está encendida en la sucursal',
  'El pedido no es viejo',
] as const;

type Tono = 'success' | 'secondary' | 'danger' | 'contrast';

/** Lo que falló y le toca decidir a una persona. Las condiciones 5 y 6 son del sistema: se dicen una vez arriba. */
export function motivosDelCliente(p: PedidoPorAutorizar) {
  return p.resultado.motivos.filter((m) => m.condicion !== 5 && m.condicion !== 6);
}

/** La etiqueta de la fila: palabra, no sólo color. */
export function etiquetaDe(p: PedidoPorAutorizar): { texto: string; tono: Tono } {
  if (p.es_contado) return { texto: 'Contado', tono: 'secondary' };
  const c = motivosDelCliente(p)[0]?.condicion;
  if (c === 4) return { texto: 'NO TOCAR', tono: 'contrast' };
  if (c === 2) return { texto: 'Excede', tono: 'danger' };
  if (c === 3) return { texto: 'Vencido', tono: 'danger' };
  if (c === 1) return { texto: 'Sin límite', tono: 'secondary' };
  if (c === 7) return { texto: 'Viejo', tono: 'secondary' };
  return { texto: 'Pasaría solo', tono: 'success' };
}

/** Por qué no pasó solo, en una frase. */
export function fraseDe(p: PedidoPorAutorizar): string {
  if (p.es_contado) return 'venta de contado: no usa crédito';
  return motivosDelCliente(p)[0]?.texto ?? 'cumple todo: se autorizaría solo con la autorización automática encendida';
}

const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
export const dinero = (n: number) => fmt.format(n);

/** Lo que Kepler cuenta por cobrar de más contra la cartera de la Suite. null si no hay diferencia que decir. */
export function diferenciaKepler(p: PedidoPorAutorizar): number | null {
  if (p.por_cobrar_kepler == null || p.saldo_cartera == null) return null;
  const d = Math.round((p.por_cobrar_kepler - p.saldo_cartera) * 100) / 100;
  return d > 1 ? d : null;
}

/** La segunda línea de la fila: sólo si hay un dato que cambia la decisión. */
export function datoDe(p: PedidoPorAutorizar): string | null {
  const dif = diferenciaKepler(p);
  if (dif != null) return `Kepler cuenta ${dinero(dif)} más que la cartera`;
  if (p.es_contado) return null;
  if (p.pago.facturas_pagadas === 0) return 'sin historial de pago';
  if (p.pago.mediana_dias != null) {
    return `suele pagar a ${p.pago.mediana_dias} días` + (p.plazo_dias ? ` con plazo de ${p.plazo_dias}` : '');
  }
  return null;
}

/** Los 2 o 3 hechos que pesan para decidir este caso (anexo EA §3.6). */
export function hechosDe(p: PedidoPorAutorizar): string[] {
  const h: string[] = [];
  const pg = p.pago;
  if (pg.facturas_pagadas > 0) {
    let t = `Pagó ${pg.facturas_pagadas} ${pg.facturas_pagadas === 1 ? 'factura' : 'facturas'}`;
    if (pg.mediana_dias != null) t += `; suele pagar a ${pg.mediana_dias} días` + (p.plazo_dias ? ` con plazo de ${p.plazo_dias}` : '');
    if (pg.a_tiempo != null) t += `; ${pg.a_tiempo} a tiempo`;
    h.push(t + '.');
    if (pg.peor_atraso) h.push(`Su peor atraso fue de ${pg.peor_atraso} días.`);
  } else if (!p.es_contado) {
    h.push('No tiene historial de pago en Kepler.');
  }
  if ((p.otros_pedidos ?? 0) > 0) h.push(`Tiene otros pedidos sin facturar por ${dinero(p.otros_pedidos ?? 0)}.`);
  if (p.resultado.numeros.resto_ignorado > 0) {
    h.push(`Quedan ${dinero(p.resultado.numeros.resto_ignorado)} de redondeo en facturas cobradas: no cuentan.`);
  }
  return h.slice(0, 3);
}

export function esperaDe(p: PedidoPorAutorizar): string {
  const d = p.dias_esperando;
  if (d == null) return '—';
  return d <= 0 ? 'hoy' : `${d} d`;
}

/**
 * `[GP.A.4]` **Por autorizar** — los pedidos de telemarketing que esperan a Crédito y cobranza (anexo EA de GP §3.6,
 * aprobada por Edgar el 2026-11-20). Vive en Cartera porque ahí trabaja Crédito y cobranza.
 *
 * La pregunta que contesta: ¿qué pedidos tengo que decidir yo? Primario: cuántos esperan; secundario: por qué no pasó
 * solo cada uno; terciario: importe y espera. El detalle se abre en el panel sin salir de la lista.
 *
 * Sólo lectura: el botón Autorizar está apagado y lo dice, hasta que exista la escritura en Kepler (GP.A.2).
 */
@Component({
  selector: 'app-finanzas-por-autorizar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, TableModule, TagModule, FreshnessPillComponent, LoadStateComponent, MetricStripComponent, SidePeekComponent, CarteraSegmentsComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Crédito de clientes</h1>
        </div>
        @if (data(); as d) {
          <app-freshness-pill measures="data" [freshness]="d.freshness" [since]="d.freshness.data_as_of" label="Datos del ERP" />
        }
      </header>

      <app-cartera-segments />

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!loading() && !error() && !lista().length"
                      emptyIcon="pi-check-circle" [emptyTitle]="verAparte() ? 'No hay pedidos viejos' : 'Ningún pedido espera tu decisión'"
                      (retry)="cargar()">
        @if (data(); as d) {
          <div class="pa-respuesta">
            <!-- Las dos cifras se abren: tocar una cambia la lista. Sin conteo animado (instant): una cifra que
                 anima publica valores que no existen. -->
            <app-metric-strip [items]="cifras()" [instant]="true" [selected]="verAparte() ? 'aparte' : 'pendientes'"
                              ariaLabel="Pedidos por autorizar" (drill)="verAparte.set($event === 'aparte')" />
            <p class="pa-sub">
              @if (verAparte()) { Más de {{ d.parametros.pedidoViejoDias }} días sin movimiento: no se autorizan solos ni ocupan la lista del día. }
              @else if (!d.sucursales_encendidas.length) { La autorización automática está apagada: todos esperan aquí. }
            </p>
          </div>
        }

        <p-table [value]="lista()" selectionMode="single" dataKey="folio" size="small" [rowHover]="true"
                 class="surf-table surf-table--plain surf-table--sticky dt-stack" (onRowSelect)="abrir($any($event).data)">
          <ng-template #header>
            <tr>
              <th>Cliente</th>
              <th>Por qué no pasó solo</th>
              <th class="comm-num">Importe</th>
              <th class="comm-num">Espera</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr [pSelectableRow]="p">
              <td role="cell" data-label="Cliente">
                <div class="pa-cliente">{{ p.cliente_nombre || p.cliente }}</div>
                <div class="pa-tenue">{{ p.sucursal_nombre }}</div>
              </td>
              <td role="cell" data-label="Por qué">
                <div class="pa-motivo">
                  <p-tag [value]="etiqueta(p).texto" [severity]="etiqueta(p).tono" />
                  <span>{{ frase(p) }}</span>
                </div>
                @if (dato(p); as x) { <div class="pa-tenue">{{ x }}</div> }
              </td>
              <td role="cell" data-label="Importe" class="comm-num">{{ dinero(p.importe) }}</td>
              <td role="cell" data-label="Espera" class="comm-num pa-tenue">{{ espera(p) }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>
    </div>

    <app-side-peek [open]="peekOpen()" (openChange)="peekOpen.set($event)"
                   [title]="sel()?.cliente_nombre || sel()?.cliente || 'Pedido'"
                   [subtitle]="sel() ? subtitulo(sel()!) : null">
      @if (sel(); as p) {
        <div class="pa-panel">
          <section class="pa-bloque">
            <p class="pa-veredicto">{{ veredicto(p) }}</p>
            <dl class="pa-numeros">
              <dt>Límite</dt><dd>{{ p.limite && p.limite > 0 ? dinero(p.limite) : 'sin límite' }}</dd>
              <dt>Por cobrar en Kepler</dt>
              <dd>{{ p.es_contado ? 'no aplica: contado' : (p.por_cobrar_kepler == null ? 'no se pudo leer' : dinero(p.por_cobrar_kepler)) }}</dd>
              @if ((p.otros_pedidos ?? 0) > 0) { <dt>Otros pedidos sin facturar</dt><dd>{{ dinero(p.otros_pedidos ?? 0) }}</dd> }
              <dt>Este pedido</dt><dd>{{ dinero(p.importe) }}</dd>
            </dl>
            @if (diferencia(p); as dif) {
              <p class="pa-nota">Kepler cuenta {{ dinero(dif) }} más que la cartera de la Suite. Suelen ser facturas de ticket sin abono aplicado.</p>
            }
          </section>

          @if (hechos(p).length) {
            <section class="pa-bloque">
              <h3 class="pa-h3">Para decidir</h3>
              <ul class="pa-hechos">
                @for (h of hechos(p); track h) { <li>{{ h }}</li> }
              </ul>
            </section>
          }

          <details class="pa-detalles">
            <summary>Ver las 7 condiciones</summary>
            <ul class="pa-conds">
              @for (c of condiciones(p); track c.texto) {
                <li><i [class]="c.ok ? 'pi pi-check pa-ok' : 'pi pi-times pa-mal'" aria-hidden="true"></i>
                  <span class="sr-only">{{ c.ok ? 'Cumple:' : 'No cumple:' }}</span> {{ c.texto }}</li>
              }
            </ul>
          </details>

          <section class="pa-bloque">
            <div class="pa-acciones">
              <button pButton type="button" [disabled]="true"><span class="p-button-label">Autorizar</span></button>
              <button pButton type="button" class="p-button-outlined" [disabled]="true"><span class="p-button-label">Rechazar</span></button>
            </div>
            <p class="pa-tenue">Autorizar desde la Suite llega pronto. Por ahora, en Kepler › Autorización de Pedidos.</p>
          </section>

          <div class="pa-siguiente">
            <span class="pa-tenue">{{ posicion() }}</span>
            <button pButton type="button" class="p-button-outlined p-button-sm" [disabled]="!haySiguiente()" (click)="siguiente()">
              <span class="p-button-label">Siguiente pedido</span><span class="p-button-icon p-button-icon-right pi pi-arrow-right" aria-hidden="true"></span>
            </button>
          </div>
        </div>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; }
    .pa-respuesta { display: flex; flex-direction: column; gap: var(--sp-1); margin: var(--sp-3) 0 var(--sp-4); }
    .pa-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .pa-cliente { font-weight: 600; }
    .pa-motivo { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .pa-tenue { font-size: var(--fs-xs); color: var(--text-muted); }
    .pa-panel { display: flex; flex-direction: column; gap: var(--sp-5); }
    .pa-bloque { display: flex; flex-direction: column; gap: var(--sp-2); }
    .pa-veredicto { margin: 0; font-size: var(--fs-lg); font-weight: 700; }
    .pa-numeros { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-1) var(--sp-5); margin: 0; font-size: var(--fs-sm); }
    .pa-numeros dt { color: var(--text-muted); }
    .pa-numeros dd { margin: 0; text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .pa-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); background: var(--surface-2); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); }
    .pa-h3 { margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-muted); }
    .pa-hechos { margin: 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-body); }
    .pa-detalles { font-size: var(--fs-sm); color: var(--text-muted); }
    .pa-detalles summary { cursor: pointer; font-weight: 600; color: var(--text-main); }
    .pa-conds { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .pa-ok { color: var(--ok-soft-fg); font-weight: 700; }
    .pa-mal { color: var(--bad-soft-fg); font-weight: 700; }
    .pa-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
    .pa-siguiente { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color); padding-top: var(--sp-3); }
  `],
})
export class FinanzasPorAutorizarComponent implements OnInit {
  private readonly api = inject(AutorizacionPedidosService);
  private readonly destroyRef = inject(DestroyRef);

  readonly data = signal<BandejaAutorizacion | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly verAparte = signal(false);
  readonly sel = signal<PedidoPorAutorizar | null>(null);
  readonly peekOpen = signal(false);

  readonly lista = computed(() => {
    const d = this.data();
    if (!d) return [];
    return this.verAparte() ? d.aparte : d.pendientes;
  });

  readonly cifras = computed<MetricStripItem[]>(() => {
    const d = this.data();
    if (!d) return [];
    return [
      { label: 'Esperan tu decisión', value: d.pendientes.length, format: 'number', drill: 'pendientes' },
      { label: 'Viejos, aparte', value: d.aparte.length, format: 'number', drill: 'aparte' },
    ];
  });

  private readonly indice = computed(() => {
    const s = this.sel();
    return s ? this.lista().findIndex((p) => p.sucursal === s.sucursal && p.folio === s.folio) : -1;
  });
  readonly posicion = computed(() => (this.indice() >= 0 ? `${this.indice() + 1} de ${this.lista().length}` : ''));
  readonly haySiguiente = computed(() => this.indice() >= 0 && this.indice() < this.lista().length - 1);

  readonly etiqueta = etiquetaDe;
  readonly frase = fraseDe;
  readonly dato = datoDe;
  readonly hechos = hechosDe;
  readonly espera = esperaDe;
  readonly dinero = dinero;
  readonly diferencia = diferenciaKepler;

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.bandeja().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: () => { this.error.set('No se pudieron leer los pedidos por autorizar.'); this.loading.set(false); },
    });
  }

  abrir(p: PedidoPorAutorizar): void {
    this.sel.set(p);
    this.peekOpen.set(true);
  }

  siguiente(): void {
    const i = this.indice();
    const n = this.lista()[i + 1];
    if (n) this.sel.set(n);
  }

  subtitulo(p: PedidoPorAutorizar): string {
    return `${p.sucursal_nombre} · pedido ${p.folio} · espera ${esperaDe(p) === 'hoy' ? 'desde hoy' : esperaDe(p).replace(' d', ' días')}`;
  }

  veredicto(p: PedidoPorAutorizar): string {
    const f = fraseDe(p);
    return f.charAt(0).toUpperCase() + f.slice(1);
  }

  condiciones(p: PedidoPorAutorizar): { texto: string; ok: boolean }[] {
    const fallan = new Set(p.resultado.motivos.map((m) => m.condicion));
    return CONDICIONES.map((texto, i) => ({ texto, ok: !fallan.has((i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7) }));
  }
}
