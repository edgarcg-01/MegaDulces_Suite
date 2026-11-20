import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { InputTextModule } from 'primeng/inputtext';
import { repartirDeposito, warehouseName, type DepositoCobros, type DepositoCobroCandidato, type LigarCobrosResultado } from '@megadulces/contracts';
import { coincideBusqueda } from '@megadulces/ui-web';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { SegmentedComponent, type SegOption } from '../../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, type MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { CaosService } from '../../caos.service';
import { money, dmy } from '../finanzas-format';

/**
 * ⭐ `[LE.6.37]` «¿De qué cobros es este depósito?» — al abrir un DEPÓSITO de CAOS en la captura.
 *
 * Edgar, 2026-11-19: *«eso debe ser posible desde la interfaz principal de captura»*. El depósito
 * «rd can 13/11» ($51,770) era el efectivo de tres cobros de ruta YA capturados (501, 502 y 503 de
 * Canindo); lo único que ofrecía la captura era registrarlo como un ingreso NUEVO —el mismo dinero
 * dos veces— y ligarlo exigía `/finanzas/caos`, superadmin, folio por folio con su monto.
 *
 * Las cinco preguntas (skill `diseno` §0b):
 *  1. Qué ve y en qué orden: el depósito y lo que tiene libre; los cobros capturados que todavía no
 *     dicen a qué depósito fueron, del más nuevo al más viejo; al marcar, cuánto toma cada uno.
 *  2. Qué no ve: los cobros ya explicados enteros, los cancelados, los egresos, los posteriores al
 *     depósito (el cobro va ANTES que el depósito, `[CG.58]`).
 *  3. Accesibilidad: casillas con teclado y rótulo propio, filtro por sucursal con conteo, buscador
 *     multi-palabra (ruta, folio, sucursal por nombre, importe); el reparto se lee antes de ligar.
 *  4. Liga: el folio del cobro y el número del depósito, en la misma fila y en el resultado.
 *  5. Le toca a la captura (quien captura, permiso de Caja General), no a supervisión de CAOS.
 *
 * Jerarquía: primario = lo que queda del depósito / lo que se queda en caja; secundario = la lista;
 * terciario = la glosa.
 */
@Component({
  selector: 'app-deposito-cobros',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, TableModule, InputTextModule, LoadStateComponent, SegmentedComponent, MetricStripComponent, FreshnessPillComponent],
  template: `
    <section class="dc" aria-labelledby="dc-t" data-testid="dc">
      <h3 class="dc-t" id="dc-t">¿De qué cobros es este depósito?</h3>
      <p class="dc-sub">
        Marca los cobros ya capturados cuyo efectivo va en el depósito #{{ externalId() }}@if (refTexto(); as r) { «{{ r }}»}.
        Lo que no alcance se queda en caja.
      </p>
      <!-- Q.1 El veredicto primero: cuanto queda libre del deposito, cuanto ligan los marcados y cuanto se queda en caja. -->
      @if (datos()) {
        <div role="status" data-testid="dc-resumen">
          <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Reparto del depósito" [instant]="true" />
        </div>
      }

      <app-load-state class="dt-scope" [loading]="cargando()" [error]="error()" [skeletonRows]="3"
                      errorTitle="No se pudieron leer los cobros" (retry)="cargar()"
                      [isEmpty]="!!datos() && !datos()!.rows.length" emptyIcon="pi-inbox"
                      emptyTitle="No hay cobros capturados sin depósito"
                      [emptyHint]="'Del ' + dmy(datos()?.desde) + ' al ' + dmy(datos()?.deposito?.fecha) + '. Si el cobro todavía no se captura, captúralo primero.'">
        @if (datos(); as d) {
          <div class="dc-filtros">
            @if (opcionesSucursal().length > 2) {
              <app-segmented [options]="opcionesSucursal()" [value]="sucursal()" (valueChange)="sucursal.set($event)"
                             ariaLabel="Sucursal de los cobros" />
            }
            <input pInputText type="search" class="dc-buscar" [ngModel]="buscar()" (ngModelChange)="buscar.set($event)"
                   placeholder="Ruta, folio, importe…" aria-label="Buscar cobro" data-testid="dc-buscar" />
          </div>
          <p class="dc-nota">
            {{ visibles().length }} de {{ d.rows.length }} cobros, del {{ dmy(d.desde) }} al {{ dmy(d.deposito.fecha) }}@if (d.has_more) {; hay más: busca por ruta o folio}.
            <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
          </p>

          <!-- D.7 Cada fila se marca con Enter o Espacio y se recorre con flechas (pSelectableRow);
               la casilla sólo lo dibuja. El ORDEN en que se marcan decide cuál puede quedar en parte. -->
          <p-table [value]="visibles()" size="small" dataKey="cash_ledger_id" [scrollable]="true" scrollHeight="18rem"
                   selectionMode="multiple" [metaKeySelection]="false" [selection]="filasMarcadas()"
                   (selectionChange)="alSeleccionar($event)" class="dc-tbl" data-testid="dc-tabla">
            <ng-template #header>
              <tr>
                <th scope="col" class="dc-chk"><span class="sr-only">Marcar</span></th>
                <th scope="col">Fecha</th>
                <th scope="col">Folio</th>
                <th scope="col">Sucursal · ruta</th>
                <th scope="col" class="comm-num">Le falta</th>
                <th scope="col" class="comm-num">Toma</th>
              </tr>
            </ng-template>
            <ng-template #body let-c>
              <tr [pSelectableRow]="c" [class.dc-marcado]="marcado(c.cash_ledger_id)" [attr.data-folio]="c.folio">
                <td class="dc-chk">
                  <input type="checkbox" tabindex="-1" aria-hidden="true" [checked]="marcado(c.cash_ledger_id)"
                         (click)="$event.preventDefault()" />
                </td>
                <td class="mono">{{ dmy(c.fecha) }}</td>
                <td class="mono">{{ c.folio }}</td>
                <td>{{ nombreSucursal(c.sucursal) }}@if (c.ruta) { · ruta {{ c.ruta }}}</td>
                <td class="comm-num">{{ money(c.falta) }}</td>
                <td class="comm-num">
                  @if (toma().get(c.cash_ledger_id); as t) {
                    <strong>{{ money(t.monto) }}</strong>@if (t.parcial) { <span class="dc-parcial">· {{ money(c.falta - t.monto) }} se queda en caja</span>}
                  } @else if (marcado(c.cash_ledger_id)) {
                    <span class="dc-mal">ya no alcanza</span>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>

          <div class="dc-pie">
            <p-button [label]="textoBoton()" icon="pi pi-link" size="small" data-testid="dc-ligar"
                      [disabled]="!puedeLigar()" [loading]="ligando()" (onClick)="ligar()" />
          </div>
          @if (errorLigar(); as e) { <p class="dc-mal" role="alert">{{ e }}</p> }
        }
      </app-load-state>
    </section>
  `,
  styles: [`
    :host { display:block; }
    .dc { border:1px solid var(--border-color); border-radius:var(--r-md, 8px); padding:var(--sp-3); display:flex; flex-direction:column; gap:var(--sp-2); }
    .dc-t { font-size:var(--fs-body); font-weight:600; margin:0; }
    .dc-sub, .dc-nota { margin:0; color:var(--text-muted); font-size:var(--fs-sm); }
    .dc-nota { font-size:var(--fs-xs); }
    .dc-filtros { display:flex; flex-wrap:wrap; gap:var(--sp-2); align-items:center; }
    .dc-buscar { flex:1 1 12rem; min-width:0; }
    .dc-chk { width:2.25rem; }
    .dc-chk input { width:1.1rem; height:1.1rem; pointer-events:none; }
    .dc-tbl tr { cursor:pointer; }
    tr.dc-marcado td { background:color-mix(in srgb, var(--action) 8%, transparent); }
    .dc-parcial { color:var(--text-muted); font-size:var(--fs-xs); }
    .dc-pie { display:flex; justify-content:flex-end; }
    .dc-mal { color:var(--bad-fg); }
    .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    @media (pointer: coarse) { .dc-chk input { width:1.5rem; height:1.5rem; } }
  `],
})
export class DepositoCobrosComponent {
  private readonly caos = inject(CaosService);
  private readonly destroyRef = inject(DestroyRef);

  readonly device = input.required<string>();
  readonly externalId = input.required<number>();
  readonly refTexto = input<string | null>(null);
  /** Lo que quedó ligado; el padre cierra la captura y refresca la cola. */
  readonly ligado$ = output<LigarCobrosResultado>({ alias: 'ligado' });

  readonly money = money;
  readonly dmy = dmy;

  readonly datos = signal<DepositoCobros | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly sucursal = signal('todas');
  readonly buscar = signal('');
  /** En el ORDEN en que se marcaron: el último es el que puede quedar en parte. */
  readonly marcados = signal<string[]>([]);
  readonly ligando = signal(false);
  readonly errorLigar = signal<string | null>(null);
  /** §9 Cuándo se leyeron los cobros: la lista es una foto, otra persona puede ligar mientras tanto. */
  readonly leidoEn = signal<Date | null>(null);

  constructor() {
    effect(() => {
      const d = this.device(); const e = this.externalId();
      untracked(() => { if (d && Number.isFinite(e)) this.cargar(); });
    });
  }

  cargar(): void {
    this.cargando.set(true); this.error.set(null); this.marcados.set([]); this.errorLigar.set(null);
    this.caos.cobrosParaDeposito(this.device(), this.externalId()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.leidoEn.set(new Date()); this.cargando.set(false); },
      error: (err) => { this.cargando.set(false); this.error.set(err?.error?.message || 'Intenta de nuevo.'); },
    });
  }

  private plaza = (s: string) => String(s ?? '').slice(0, 2);
  nombreSucursal = (s: string) => warehouseName(this.plaza(s));

  readonly opcionesSucursal = computed<SegOption[]>(() => {
    const rows = this.datos()?.rows ?? [];
    const cuenta = new Map<string, number>();
    for (const r of rows) cuenta.set(this.plaza(r.sucursal), (cuenta.get(this.plaza(r.sucursal)) ?? 0) + 1);
    return [
      { label: `Todas ${rows.length}`, value: 'todas' },
      ...[...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ label: `${warehouseName(p)} ${n}`, value: p })),
    ];
  });

  readonly visibles = computed<DepositoCobroCandidato[]>(() => {
    const suc = this.sucursal(); const q = this.buscar();
    return (this.datos()?.rows ?? []).filter((r) =>
      (suc === 'todas' || this.plaza(r.sucursal) === suc)
      && coincideBusqueda(q, r.folio, r.ruta ? `ruta ${r.ruta}` : null, r.sucursal, warehouseName(this.plaza(r.sucursal)),
        r.glosa, r.falta.toFixed(2), dmy(r.fecha)));
  });

  marcado = (id: string) => this.marcados().includes(id);
  /** Las filas marcadas, para el `[selection]` de la tabla. */
  readonly filasMarcadas = computed(() => {
    const porId = new Map((this.datos()?.rows ?? []).map((r) => [r.cash_ledger_id, r]));
    return this.marcados().map((id) => porId.get(id)).filter((r): r is DepositoCobroCandidato => !!r);
  });
  /** La tabla devuelve el conjunto; aquí se conserva el ORDEN en que se marcaron (el último puede quedar en parte). */
  alSeleccionar(sel: DepositoCobroCandidato[] | null): void {
    if (this.ligando()) return;
    this.errorLigar.set(null);
    const ids = new Set((sel ?? []).map((r) => r.cash_ledger_id));
    this.marcados.update((m) => [...m.filter((id) => ids.has(id)), ...[...ids].filter((id) => !m.includes(id))]);
  }

  /** El MISMO reparto que hace el servidor (`repartirDeposito`, libs/contracts). */
  private readonly reparto = computed(() => {
    const d = this.datos(); if (!d) return [];
    const porId = new Map(d.rows.map((r) => [r.cash_ledger_id, r]));
    return repartirDeposito(d.deposito.libre, this.marcados().filter((id) => porId.has(id)).map((id) => ({ id, falta: porId.get(id)!.falta })));
  });
  readonly toma = computed(() => new Map(this.reparto().map((r) => [r.id, r])));
  readonly montoLigado = computed(() => Math.round(this.reparto().reduce((a, r) => a + r.monto, 0) * 100) / 100);
  readonly quedaLibre = computed(() => Math.round(((this.datos()?.deposito.libre ?? 0) - this.montoLigado()) * 100) / 100);
  readonly sinDepositar = computed(() => {
    const d = this.datos(); if (!d) return 0;
    const falta = d.rows.filter((r) => this.toma().has(r.cash_ledger_id)).reduce((a, r) => a + r.falta, 0);
    return Math.round((falta - this.montoLigado()) * 100) / 100;
  });
  /** Un cobro marcado al que ya no le alcanza nada: el servidor lo rechaza, así que no se manda. */
  private readonly sobranMarcados = computed(() => this.marcados().some((id) => !this.toma().has(id)));
  /** Q.1 El veredicto: lo libre del depósito, lo que ligan los marcados y lo que se queda en caja. */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const libre = this.datos()?.deposito.libre ?? 0;
    const hay = this.marcados().length > 0;
    const falta = this.quedaLibre();
    return [
      { label: 'Libre del depósito', value: libre, format: 'currency2' },
      { label: 'Ligas', value: this.montoLigado(), format: 'currency2',
        tone: hay && falta <= 0.005 ? 'ok' : 'default',
        sub: hay && falta > 0.005 ? `faltan cobros por ${money(falta)}` : undefined },
      { label: 'Se queda en caja', value: this.sinDepositar(), format: 'currency2', tone: 'muted' },
    ];
  });
  readonly puedeLigar = computed(() => !this.ligando() && this.reparto().length > 0 && !this.sobranMarcados());
  readonly textoBoton = computed(() => {
    const n = this.reparto().length;
    return n ? `Ligar ${n} ${n === 1 ? 'cobro' : 'cobros'}` : 'Ligar cobros';
  });

  ligar(): void {
    if (!this.puedeLigar()) return;
    this.ligando.set(true); this.errorLigar.set(null);
    this.caos.ligarCobros(this.device(), this.externalId(), { cash_ledger_ids: this.reparto().map((r) => r.id) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => { this.ligando.set(false); this.ligado$.emit(r); },
        error: (err) => { this.ligando.set(false); this.errorLigar.set(err?.error?.message || 'No se pudo ligar. Intenta de nuevo.'); },
      });
  }
}
