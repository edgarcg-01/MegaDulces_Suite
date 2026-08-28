import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, of, switchMap, catchError, debounceTime } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { ENTRADAS_CONTROL_TABS } from '../entradas-control-tabs';
import { EntradasService, TwinPair, TwinsReport } from '../entradas.service';
import { branchName } from '../../../core/constants/store-branches';
import { money } from '../../../shared/util';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[RE.14.4]` — **Órdenes capturadas dos veces**: la pantalla donde el par sucursal ↔ oficinas
 * se resuelve.
 *
 * El hecho de fondo: la misma recepción se captura en el Kepler de la sucursal y otra vez en el
 * de **oficinas** (servidor 9.95, sucursal `'00'`). La de la sucursal es la buena —trae los
 * productos y movió inventario—; la de oficinas suele ser un solo renglón de concepto con el
 * total. Mientras las dos anden sueltas, esa compra se cuenta **dos veces** y a la sucursal se
 * le puede pedir evidencia de una orden que ya está cubierta.
 *
 * El detector aparea solo lo que puede defender. Lo que queda acá es lo que **una persona tiene
 * que decidir**, y son casos genuinamente ambiguos, no ruido:
 *
 *   · el importe casa al centavo y el día también, pero **el proveedor no**, porque cada
 *     servidor tiene su catálogo (`DIONICIO CALDERON` en la sucursal = `BOTANAS CALDERON` en
 *     oficinas — mismo señor);
 *   · o la copia de oficinas trae productos propios, así que podría ser una compra suya.
 *
 * Por eso la tabla pone los dos lados enfrentados con sus dos importes y su Δ: la decisión se
 * toma mirando eso, no un score. Y el KPI de arriba dice cuánto dinero se está contando dos
 * veces por no decidir — que es el costo de dejar la bandeja llena.
 */
@Component({
  selector: 'app-compras-entradas-gemelas',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TagModule, ToastModule, SegmentedComponent, LoadStateComponent, PageTabsComponent, MetricStripComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page in eg">
      <p-toast />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Centro de control · Capturadas dos veces</h1>
          <p class="surf-page-sub">
            La misma recepción vive en el Kepler de la <strong>sucursal</strong> y en el de
            <strong>oficinas</strong>. El motor las enlaza solo cada 5 minutos; acá quedan las que
            <strong>no puede afirmar sin una persona</strong>. La que se confirma deja de contarse
            dos veces.
          </p>
        </div>
        <div class="eg-head">
          <app-segmented [options]="estadoOpts" [value]="estado()" (valueChange)="setEstado($any($event))" />
          <input pInputText type="search" class="eg-search" [ngModel]="search()" (ngModelChange)="setSearch($event)"
                 placeholder="Folio, proveedor o importe" aria-label="Buscar pares" />
          @if (canDecide()) {
            <button pButton type="button" class="p-button-sm p-button-text" [loading]="scanning()"
                    (click)="buscarAhora()"
                    title="El motor corre solo cada 5 minutos; esto lo dispara ahora para este tenant">
              <span class="p-button-icon p-button-icon-left pi pi-sync" aria-hidden="true"></span>
              <span class="p-button-label">Buscar pares ahora</span>
            </button>
          }
        </div>
      </header>

      <app-page-tabs [tabs]="tabs" />

      <!-- Answer-first: lo primero es cuánto cuesta no decidir, no cuántas filas hay.
           MetricStrip (ADR-033) y no cajitas propias: es el mismo header de KPIs que las
           otras pestañas del Centro de control, así cambiar de pestaña no cambia el
           idioma visual. -->
      @if (report()) {
        <app-metric-strip [items]="kpis()" ariaLabel="Pares capturados dos veces" />
      }

      <section class="surf-card eg-card">
        @if (error()) {
          <app-load-state [error]="error()" (retry)="reload()" />
        } @else if (loading() && !report()) {
          <app-load-state [loading]="true" [skeletonRows]="5" />
        } @else if (rows().length === 0) {
          <app-load-state [isEmpty]="true" emptyIcon="pi-check-circle"
                          [emptyTitle]="estado() === 'propuesto' ? 'Nada esperando dictamen' : 'Sin pares en este filtro'"
                          [emptyHint]="estado() === 'propuesto'
                            ? 'El motor no encontró ninguna recepción capturada dos veces que necesite decisión humana.'
                            : 'Probá con otro estado o quitá el texto de la búsqueda.'" />
        } @else {
          <div class="eg-scroll">
            <table class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first eg-table">
              <thead>
                <tr>
                  <th scope="col">En la sucursal</th>
                  <th scope="col" class="comm-num">Su importe</th>
                  <th scope="col">En oficinas</th>
                  <th scope="col" class="comm-num">Su importe</th>
                  <th scope="col" class="comm-num">Δ</th>
                  <th scope="col">Apareo</th>
                  <th scope="col" class="eg-th-acts">Dictamen</th>
                </tr>
              </thead>
              <tbody>
                @for (p of rows(); track p.cedis_folio) {
                  <tr [class.busy]="decidiendo() === p.cedis_folio">
                    <td>
                      <b class="mono">{{ p.sucursal }}/{{ p.folio }}</b>
                      <em class="eg-sub">{{ suc(p.sucursal) }} · {{ p.suc_date | date:'dd/MM/yy' }}</em>
                      <em class="eg-prov">{{ p.suc_prov || '—' }}</em>
                    </td>
                    <td class="comm-num">{{ p.suc_monto == null ? '—' : money(p.suc_monto) }}</td>
                    <td>
                      <b class="mono">00/{{ p.cedis_folio }}</b>
                      <em class="eg-sub">Oficinas · {{ p.cedis_date | date:'dd/MM/yy' }}
                        @if (p.delta_dias) { <span [title]="'Capturada ' + abs(p.delta_dias) + ' día(s) ' + (p.delta_dias > 0 ? 'después' : 'antes')">({{ p.delta_dias > 0 ? '+' : '' }}{{ p.delta_dias }}d)</span> }
                      </em>
                      <!-- El proveedor del otro lado es EL dato de la decisión: si los dos nombres
                           son la misma persona con otro alta, es la misma orden. -->
                      <em class="eg-prov" [class.is-diff]="distintoProv(p)">{{ p.cedis_prov || '—' }}</em>
                    </td>
                    <td class="comm-num">{{ p.cedis_monto == null ? '—' : money(p.cedis_monto) }}</td>
                    <td class="comm-num" [class.is-diff]="!!p.delta_monto">
                      {{ p.delta_monto ? money(p.delta_monto) : '—' }}
                    </td>
                    <td>
                      <p-tag [value]="reglaLabel(p.match_rule)" [severity]="reglaSev(p.match_rule)" />
                      @if (p.status !== 'propuesto') {
                        <em class="eg-sub">{{ p.status === 'confirmado' ? 'confirmado por ' + (p.decided_by || '?') : 'automático' }}</em>
                      }
                    </td>
                    <td class="eg-acts">
                      @if (p.status === 'propuesto' && canDecide()) {
                        <button pButton type="button" class="p-button-sm p-button-text eg-ok"
                                [disabled]="decidiendo() === p.cedis_folio" (click)="decidir(p, 'confirmar')">
                          <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                          <span class="p-button-label">Es la misma</span>
                        </button>
                        <button pButton type="button" class="p-button-sm p-button-text eg-no"
                                [disabled]="decidiendo() === p.cedis_folio" (click)="decidir(p, 'rechazar')">
                          <span class="p-button-icon p-button-icon-left pi pi-times" aria-hidden="true"></span>
                          <span class="p-button-label">Son distintas</span>
                        </button>
                      } @else if (p.status === 'propuesto') {
                        <em class="eg-sub">requiere permiso de validación</em>
                      } @else {
                        <i class="pi pi-check-circle eg-done" aria-hidden="true" title="Par vigente: no se cuenta dos veces"></i>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (rows().length >= 200) {
            <!-- Regla del repo: nunca cortar en silencio. -->
            <p class="eg-corte">Se muestran los primeros {{ rows().length }} pares del filtro.</p>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    /* Esta pantalla se escribió con rem sueltos (.5/.7/.82/1.15rem) y quedaba con otra
       densidad y otro tamaño de letra que sus pestañas hermanas: cambiar de pestaña se
       sentía cambiar de app. Todo lo de acá sale ahora de la escala (--sp-* / --fs-*). */
    :host { display: block; }
    .eg-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .eg-search { min-width: 15rem; }
    .eg-card { padding: 0; overflow: hidden; }

    .eg-scroll { overflow-x: auto; }
    /* Base compartida (surf-table--plain). Lo único propio: las celdas de esta tabla llevan
       dos líneas (folio + proveedor), así que se alinean arriba y no al medio. */
    .eg-table > tbody > tr > td { vertical-align: top; padding-top: var(--sp-2); padding-bottom: var(--sp-2); }
    .eg-table tr.busy { opacity: .55; }
    .eg-table .mono { font-family: var(--font-mono, inherit); font-variant-numeric: tabular-nums; }
    .eg-th-acts { text-align: right; }
    .eg-sub, .eg-prov { display: block; font-style: normal; font-size: var(--fs-xs); color: var(--text-muted); }
    .eg-prov { max-width: 15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Los dos datos que cambian la decisión se marcan; el resto queda neutro. Ámbar y no
       --action: el naranja es el color de "acá se hace clic", y un dato que difiere no es
       una acción. Pintarlo de --action invitaba a clickear un texto muerto. */
    .eg-prov.is-diff, td.is-diff { color: var(--warn-fg); font-weight: 600; }
    .eg-acts { white-space: nowrap; }
    .eg-ok .p-button-label { color: var(--text-main); }
    .eg-no .p-button-label { color: var(--text-muted); }
    .eg-done { color: var(--text-muted); }
    .eg-corte { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
  `],
})
export class ComprasEntradasGemelasComponent {
  private readonly svc = inject(EntradasService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabs = ENTRADAS_CONTROL_TABS;
  readonly report = signal<TwinsReport | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly estado = signal<'propuesto' | 'vigente' | 'todos'>('propuesto');
  readonly search = signal('');
  /** Folio en vuelo: bloquea sus botones sin congelar la tabla entera. */
  readonly decidiendo = signal<string | null>(null);
  readonly scanning = signal(false);

  readonly estadoOpts = [
    { label: 'Por dictaminar', value: 'propuesto' },
    { label: 'Ya resueltos', value: 'vigente' },
    { label: 'Todos', value: 'todos' },
  ];

  readonly rows = computed(() => this.report()?.rows ?? []);
  readonly canDecide = computed(() =>
    this.perms.can('manage', 'all') || this.auth.user()?.permissions?.[Permission.COMPRAS_ENTRADAS_VALIDAR] === true);

  /**
   * Los tres KPIs, en el orden en que importan: cuántas esperan a una persona, **cuánto dinero
   * se está contando dos veces mientras nadie decide** (el costo de la bandeja llena) y cuántas
   * ya se resolvieron. El dinero va sin `tone` a propósito: es una magnitud, no una alarma —
   * la alarma es que haya pares sin dictaminar.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const k = this.report()?.kpis;
    if (!k) return [];
    return [
      { label: 'Por dictaminar', value: k.propuestos, format: 'number', tone: k.propuestos ? 'warn' : 'ok' },
      { label: 'Contado dos veces', value: k.monto_propuesto, format: 'currency-short', tone: 'default',
        sub: 'mientras nadie decide' },
      { label: 'Pares resueltos', value: k.vigentes, format: 'number', tone: 'default' },
    ];
  });

  private readonly pedir = new Subject<void>();

  constructor() {
    this.pedir.pipe(
      // El buscador escribe letra por letra; sin debounce cada tecla es una consulta.
      debounceTime(250),
      switchMap(() => {
        this.loading.set(true);
        return this.svc.twins({ estado: this.estado(), search: this.search().trim() || undefined }).pipe(
          catchError((e) => { this.error.set(e?.error?.message || 'No se pudieron cargar los pares'); return of(null); }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((r) => {
      this.loading.set(false);
      if (r) { this.report.set(r); this.error.set(null); }
    });
    this.pedir.next();
  }

  reload() { this.error.set(null); this.pedir.next(); }
  setEstado(v: 'propuesto' | 'vigente' | 'todos') { this.estado.set(v); this.pedir.next(); }
  setSearch(v: string) { this.search.set(v || ''); this.pedir.next(); }

  /**
   * Dispara el motor de apareo. Existe porque el cron corre cada 5 minutos y quien está mirando
   * la bandeja después de que oficinas capturó un bonche no tiene por qué esperar el tick.
   */
  buscarAhora() {
    this.scanning.set(true);
    this.svc.scanTwins().subscribe({
      next: (r) => {
        this.scanning.set(false);
        this.toast.add({
          severity: r?.nuevas ? 'success' : 'info',
          summary: r?.nuevas ? `${r.nuevas} par(es) nuevo(s)` : 'Sin pares nuevos',
          detail: r
            ? `${r.propuestas} esperan dictamen${r.obsoletas ? ` · ${r.obsoletas} obsoleta(s) limpiada(s)` : ''}`
            : 'El motor no devolvió resultado',
        });
        this.pedir.next();
      },
      error: (e) => {
        this.scanning.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo correr el motor', detail: e?.error?.message || 'Intentá de nuevo' });
      },
    });
  }

  /**
   * Dictamina y **saca la fila de la lista** en el filtro "por dictaminar": el trabajo se hace
   * de arriba hacia abajo y una fila ya resuelta que se queda ahí se vuelve a leer.
   */
  decidir(p: TwinPair, decision: 'confirmar' | 'rechazar') {
    this.decidiendo.set(p.cedis_folio);
    this.svc.decideTwin(p.cedis_folio, decision).subscribe({
      next: () => {
        this.decidiendo.set(null);
        this.toast.add({
          severity: 'success',
          summary: decision === 'confirmar' ? 'Es la misma orden' : 'Quedan como órdenes distintas',
          detail: decision === 'confirmar'
            ? `00/${p.cedis_folio} deja de contarse: la buena es ${p.sucursal}/${p.folio}.`
            : `00/${p.cedis_folio} vuelve a contar como compra de oficinas.`,
        });
        const r = this.report();
        if (!r) return;
        const fuera = this.estado() === 'propuesto';
        this.report.set({
          ...r,
          rows: fuera
            ? r.rows.filter((x) => x.cedis_folio !== p.cedis_folio)
            : r.rows.map((x) => (x.cedis_folio === p.cedis_folio
              ? { ...x, status: decision === 'confirmar' ? 'confirmado' : 'rechazado', decided_by: this.auth.user()?.username || null }
              : x)),
          kpis: {
            ...r.kpis,
            propuestos: Math.max(0, r.kpis.propuestos - 1),
            vigentes: decision === 'confirmar' ? r.kpis.vigentes + 1 : r.kpis.vigentes,
            monto_propuesto: Math.max(0, r.kpis.monto_propuesto - (p.cedis_monto || 0)),
          },
        });
      },
      error: (e) => {
        this.decidiendo.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Intentá de nuevo' });
      },
    });
  }

  /** Nombres distintos entre catálogos = el caso a mirar. Se compara normalizado, sin acentos. */
  distintoProv(p: TwinPair): boolean {
    const n = (v: string | null) => (v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
    return !!p.suc_prov && !!p.cedis_prov && n(p.suc_prov) !== n(p.cedis_prov);
  }

  reglaLabel(r: string | null): string {
    return ({
      exacta: 'Mismo día, importe y proveedor',
      monto_fecha: 'Mismo importe, días distintos',
      centavos: 'Difieren centavos',
      sugerida: 'Mismo importe, otro proveedor',
      manual: 'A mano',
    } as Record<string, string>)[r || ''] || (r || '—');
  }
  reglaSev(r: string | null): 'success' | 'info' | 'warn' | 'secondary' {
    return ({ exacta: 'success', monto_fecha: 'info', centavos: 'info', sugerida: 'warn' } as Record<string, 'success' | 'info' | 'warn' | 'secondary'>)[r || ''] || 'secondary';
  }
  suc(c: string): string { return branchName(c) || c; }
  abs(n: number): number { return Math.abs(n); }
  money = money;
}
