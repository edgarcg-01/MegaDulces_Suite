import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { money, dmy } from '../finanzas-format';
import { todayMx } from '../../../../core/utils/mx-date';
import { encuestarVisible } from '../../../../core/utils/poll-visible';
import { CaosService, type CaosMovimiento, type CaosKpi, type CaosDenominacion } from '../../caos.service';
import { CaosSocketService } from '../../caos-socket.service';

/**
 * CS.2 — Reporte de movimientos de la caja fuerte CAOS (sistema externo, ADR Fase CS).
 *
 * Sólo lectura del espejo `analytics.caos_cash_movements`. Depósitos (entra efectivo) y
 * dispensaciones (sale), por denominación, por usuario, con su referencia. Se pone al día solo por
 * WS (`/caos`) + un repaso lento de red de seguridad, igual que Caja General (CG.23.2).
 *
 * ⚠️ Este reporte NO cruza CAOS contra Caja General / banco / rutas — eso son las capas CS.4–CS.7,
 * que dependen de anclar antes qué caja física y sucursal es CAOS (gate de negocio CS.0). Acá sólo
 * se muestra lo que la máquina registró.
 */
interface FilaUI extends CaosMovimiento { abierto?: boolean; denom?: CaosDenominacion[] }

@Component({
  selector: 'app-finanzas-caos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputTextModule, SelectModule, TagModule, MetricStripComponent, LoadStateComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caja Fuerte (CAOS)</h1>
          <p class="surf-page-sub">
            Movimientos de efectivo del dispositivo de caja fuerte — depósitos y dispensaciones por
            denominación. Sólo lectura.
            @if (kpi(); as k) { · <span class="mono">{{ freskura(k) }}</span> }
          </p>
        </div>
      </header>

      <!-- Filtros -->
      <div class="fin-form fin-filtros">
        <div class="fin-row">
          <label for="cs-from">Desde</label>
          <input pInputText id="cs-from" type="date" [(ngModel)]="from" (change)="cargar()" />
          <label for="cs-to">Hasta</label>
          <input pInputText id="cs-to" type="date" [(ngModel)]="to" (change)="cargar()" />
          <label for="cs-tipo">Tipo</label>
          <p-select inputId="cs-tipo" [options]="tiposOpc" [(ngModel)]="tipo" optionLabel="label" optionValue="value"
                    (ngModelChange)="cargar()" [ariaLabel]="'Tipo de movimiento'"></p-select>
        </div>
        <div class="fin-row">
          <label for="cs-user">Usuario</label>
          <input pInputText id="cs-user" [(ngModel)]="usuario" (keyup.enter)="cargar()" placeholder="Nombre del operador" />
          <label for="cs-ref">Referencia</label>
          <input pInputText id="cs-ref" [(ngModel)]="ref" (keyup.enter)="cargar()" placeholder="ruta / pagos / …" />
          <p-button label="Buscar" icon="pi pi-search" size="small" (onClick)="cargar()"></p-button>
        </div>
      </div>

      <!-- KPIs: sin medir NO es cero (ADR-056) -->
      <app-metric-strip [items]="kpis()" ariaLabel="Resumen de la caja fuerte"></app-metric-strip>

      <!-- Tabla -->
      <app-load-state [loading]="cargando()" [error]="err()" [isEmpty]="!cargando() && !err() && rows().length === 0"
                      emptyIcon="pi-lock" emptyTitle="Sin movimientos en el rango"
                      emptyHint="La caja fuerte no registró depósitos ni dispensaciones en estas fechas."
                      (retry)="cargar()">
        <table class="cs-tbl">
          <caption class="sr-only">Movimientos de la caja fuerte CAOS</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Fecha</th>
              <th scope="col">Contable</th>
              <th scope="col">Usuario</th>
              <th scope="col">Tipo</th>
              <th scope="col" class="cs-r">Total</th>
              <th scope="col">Referencia</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.id) {
              <tr>
                <td class="mono">{{ r.external_id }}</td>
                <td class="mono">{{ dmy(r.occurred_at) }}</td>
                <td class="mono">{{ r.accounting_date || '—' }}</td>
                <td>{{ r.user_external || '—' }}</td>
                <td><p-tag [value]="r.type_label" [severity]="sev(r.type_id)"></p-tag></td>
                <td class="mono cs-r">{{ money(r.total) }}</td>
                <td>{{ r.ref || '—' }}</td>
                <td>
                  <p-button [icon]="r.abierto ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" size="small"
                            severity="secondary" [text]="true" (onClick)="verDetalle(r)"
                            [title]="'Ver denominaciones'"></p-button>
                </td>
              </tr>
              @if (r.abierto) {
                <tr class="cs-det">
                  <td colspan="8">
                    @if (r.denom && r.denom.length) {
                      <table class="cs-denom">
                        <thead><tr><th scope="col">Denominación</th><th scope="col" class="cs-r">Piezas</th><th scope="col" class="cs-r">Importe</th></tr></thead>
                        <tbody>
                          @for (d of r.denom; track d.denom) {
                            <tr><td class="mono">{{ money(d.denom) }}</td><td class="mono cs-r">{{ d.quantity }}</td><td class="mono cs-r">{{ money(d.denom * d.quantity) }}</td></tr>
                          }
                        </tbody>
                      </table>
                    } @else {
                      <span class="fin-dim">Sin desglose por denominación en este movimiento.</span>
                    }
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
        @if (hasMore()) {
          <p class="fin-dim cs-rezago">La lista viene topada en {{ limite }} filas. Acotá el rango para ver el resto.</p>
        }
      </app-load-state>
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .fin-filtros { gap:.5rem; margin-bottom:.75rem; }
    .cs-tbl { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .cs-tbl th { text-align:left; font-weight:600; color:var(--text-muted); padding:.35rem .5rem;
                 border-bottom:1px solid var(--border-color); white-space:nowrap; }
    .cs-tbl td { padding:.3rem .5rem; border-bottom:1px solid var(--border-color); vertical-align:top; }
    .cs-r { text-align:right; font-variant-numeric:tabular-nums; }
    .cs-det td { background:color-mix(in srgb, var(--text-muted) 6%, var(--card-bg)); }
    .cs-denom { width:auto; border-collapse:collapse; font-size:var(--fs-xs); }
    .cs-denom th, .cs-denom td { padding:.15rem .75rem .15rem 0; }
    .cs-rezago { margin-top:.5rem; }
    .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  `],
})
export class FinanzasCaosComponent implements OnInit, OnDestroy {
  private svc = inject(CaosService);
  private sock = inject(CaosSocketService);
  private destroyRef = inject(DestroyRef);
  private zone = inject(NgZone);

  readonly money = money;
  readonly dmy = dmy;
  readonly limite = 500;

  from = todayMx();
  to = todayMx();
  tipo = '';
  usuario = '';
  ref = '';

  readonly tiposOpc = [
    { label: 'Todos', value: '' },
    { label: 'Depósito', value: '0' },
    { label: 'Dispensar', value: '4' },
    { label: 'Dotar', value: '8' },
    { label: 'Cambio', value: '7' },
  ];

  rows = signal<FilaUI[]>([]);
  kpi = signal<CaosKpi | null>(null);
  cargando = signal(false);
  err = signal<string | null>(null);
  hasMore = signal(false);
  private firmaVista: string | null = null;

  kpis = computed<MetricStripItem[]>(() => {
    const k = this.kpi();
    // Sin medición NO se dibuja $0.00 (ADR-056): se declara "sin medir".
    if (!k) return [
      { label: 'Movimientos', value: 'sin medir' },
      { label: 'Depósitos', value: 'sin medir' },
      { label: 'Dispensado', value: 'sin medir' },
      { label: 'Balance', value: 'sin medir' },
    ];
    return [
      { label: 'Movimientos', value: k.movimientos },
      { label: 'Depósitos', value: money(k.depositos) },
      { label: 'Dispensado', value: money(k.dispensado) },
      { label: 'Balance', value: money(k.balance) },
    ];
  });

  ngOnInit(): void {
    this.from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    this.cargar();
    this.enVivo();
  }

  ngOnDestroy(): void { this.sock.disconnect(); }

  cargar(): void {
    this.cargando.set(true);
    this.svc.movimientos({ from: this.from, to: this.to, tipo: this.tipo || undefined, usuario: this.usuario || undefined, ref: this.ref || undefined, limit: this.limite })
      .subscribe({
        next: (r) => {
          this.rows.set((r.rows || []) as FilaUI[]);
          this.kpi.set(r.kpi ?? null);
          this.hasMore.set(!!r.has_more);
          this.err.set(null);
          this.cargando.set(false);
        },
        error: (e) => {
          this.rows.set([]); this.kpi.set(null);
          this.err.set(this.textoError(e)); this.cargando.set(false);
        },
      });
  }

  verDetalle(r: FilaUI): void {
    r.abierto = !r.abierto;
    this.rows.set([...this.rows()]);
    if (r.abierto && !r.denom) {
      this.svc.detalle(r.id).subscribe({
        next: (d) => { r.denom = d.denominaciones || []; this.rows.set([...this.rows()]); },
        error: () => { r.denom = []; this.rows.set([...this.rows()]); },
      });
    }
  }

  sev(typeId: number): 'success' | 'danger' | 'info' | 'warn' {
    if (typeId === 0) return 'success';   // Depósito (entra)
    if (typeId === 4) return 'danger';    // Dispensar (sale)
    return 'info';                        // Dotar/Cambio/administrativos
  }

  freskura(k: CaosKpi): string {
    return k.datos_al ? `datos al ${dmy(k.datos_al)}` : 'frescura sin medir';
  }

  private enVivo(): void {
    // El canal en vivo es un EXTRA: si no abre, queda el repaso. No puede tumbar la pantalla.
    try {
      this.sock.connect();
      this.sock.change$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
        const firma = e.firma ?? `${e.filas}|${e.max_id}`;
        if (firma === this.firmaVista) return;
        this.firmaVista = firma;
        this.cargar();
      });
    } catch (e) {
      console.warn('[caos] sin avisos en vivo; queda el repaso:', e);
    }
    // Red de seguridad: NOTIFY no se persiste, un socket caído no deja rastro.
    encuestarVisible(60000, () => this.cargar(), { destroyRef: this.destroyRef, zone: this.zone });
  }

  private textoError(e: unknown): string {
    const err = e as { status?: number; error?: { message?: string } };
    if (err?.status === 0) return 'No hay conexión con el servidor.';
    return err?.error?.message || 'No se pudo cargar el reporte de la caja fuerte.';
  }
}
