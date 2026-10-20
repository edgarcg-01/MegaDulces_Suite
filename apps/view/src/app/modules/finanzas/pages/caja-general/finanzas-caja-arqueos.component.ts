import { ChangeDetectionStrategy, Component, DestroyRef, NgZone, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { environment } from '../../../../../environments/environment';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../../shared/components/side-peek/side-peek.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../../shared/context-help/context-help.component';
/**
 * ⭐ Los tipos del cruce salen del CONTRATO, no de una copia local. Mientras cada lado declaraba
 * su propia versión, el día que el backend agregara un estado o volviera nulo un campo el
 * frontend seguía compilando en verde y pintando otra cosa (ADR-052).
 */
import type {
  Freshness, CruceArqueoDia, CruceArqueoDenominacion, CruceArqueosResponse,
} from '@megadulces/contracts';
import { FINANZAS_SHARED_STYLES } from '../finanzas-shared.styles';
import { CajaTabsComponent } from '../../caja-tabs.component';
import { money, dmy } from '../finanzas-format';
import { encuestarVisible } from '../../../../core/utils/poll-visible';

/** Los nombres cortos con que esta pantalla usa el contrato. Un alias, no una segunda forma. */
export type CruceDenom = CruceArqueoDenominacion;
export type CruceDia = CruceArqueoDia;
type CruceResp = CruceArqueosResponse;

/**
 * ⭐⭐ `[CGS.2]` — **Arqueos: el mismo cajón, contado dos veces, lado a lado.**
 *
 * Pedido de Edgar (2026-10-20): *«en historial tengo que hacer scroll hasta abajo para ver los
 * arqueos; hagamos una pestaña extra que diga Arqueos, donde muestre más desglosados los
 * cortes, de forma que le daremos más visibilidad al usuario»*.
 *
 * ── Por qué es una pestaña y no una sección más ─────────────────────────────────────────────
 *
 * El mismo cajón se cuenta en DOS sistemas —el corte de la Suite y el arqueo de cierre que
 * Control captura— y hasta hoy **ninguna pantalla los ponía juntos**: el Expediente lee sólo
 * Control, Captura lee sólo la Suite. Por eso un desfase de **$19,811.50** vivió ocho días sin
 * que nadie lo viera; para encontrarlo hubo que cruzar a mano dos tablas que el producto nunca
 * cruzaba.
 *
 * ── Los tres niveles de esta pantalla (DESIGN Q.5), dichos en una línea ─────────────────────
 *
 *   primario   = cuántos días NO cuadran y por cuánto dinero;
 *   secundario = la fila del día, con las dos cifras y su diferencia;
 *   terciario  = la pieza exacta donde está la diferencia, en el cajón lateral.
 *
 * ⭐ **El total solo no alcanza, y el 19-oct lo prueba:** $500 que parecen un descuadre y son un
 * billete mal clasificado —la Suite anotó un $1,000 donde Control anotó un $500, con las otras
 * ocho denominaciones idénticas—. Por eso la fila abre el desglose (Q.3: señalar la fila, no el
 * agregado).
 *
 * ── ⛔ Lo que esta pantalla NO hace ─────────────────────────────────────────────────────────
 *
 * **No decide quién tiene razón.** Publica las dos cifras y su diferencia; cuál de los dos
 * arbitra el conteo es una decisión de negocio sobre cortes firmados y todavía no está tomada.
 * Afirmarla acá sería inventar un árbitro (ADR-059).
 *
 * **No corrige nada.** Lo de Control se corrige en Control; lo de la Suite, recontando en
 * Captura. Una pantalla que deja editar el espejo fabrica una segunda verdad.
 */
@Component({
  selector: 'app-finanzas-caja-arqueos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, ButtonModule, TableModule, TagModule,
    LoadStateComponent, SidePeekComponent, MetricStripComponent, FreshnessPillComponent,
    ContextHelpComponent, CajaTabsComponent],
  template: `
    <app-caja-tabs />
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Arqueos de Caja General</h1>
          <p class="surf-page-sub">
            El corte que selló la Suite contra el arqueo de cierre que capturó Control, día por día
            y pieza por pieza. No decide cuál de los dos tiene razón: publica los dos.
          </p>
        </div>
        <div class="cq-actions">
          <app-context-help topic="caja-arqueos" />
          <app-freshness-pill measures="data" [freshness]="frescura()" label="Arqueos de Control" />
          <button pButton type="button" class="p-button-sm p-button-outlined"
                  [loading]="cargando()" (click)="recargar()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
        </div>
      </header>

      <app-load-state [loading]="cargando() && !dias().length" [error]="error()"
                      [isEmpty]="!cargando() && !error() && !dias().length"
                      [skeletonRows]="6"
                      emptyTitle="No hay arqueos que cruzar"
                      emptyHint="El cruce necesita un arqueo de cierre en Control. Si está vacío, el carril de ese dato dejó de llegar."
                      errorTitle="No se pudo traer el cruce"
                      (retry)="recargar()" />

      @if (dias().length) {
        <!-- DESIGN Q.1 — la pantalla abre con la respuesta, no con la rejilla. -->
        <section class="cq-veredicto" aria-labelledby="cq-h-ver">
          <h2 id="cq-h-ver" class="cq-h2">{{ titular() }}</h2>
          <app-metric-strip [items]="kpis()" ariaLabel="Resultado del cruce" />
          @for (nota of notas(); track nota) { <p class="cq-nota">{{ nota }}</p> }
        </section>

        <section class="cq-block dt-scope" aria-labelledby="cq-h-dias">
          <div class="cq-bh">
            <h2 id="cq-h-dias" class="cq-h2">Día por día</h2>
            <span class="cq-hint">Da clic en un día para ver en qué pieza está la diferencia</span>
          </div>

          <p-table [value]="dias()" size="small" dataKey="fecha" [rowHover]="true"
                   class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack"
                   [paginator]="dias().length > 30" [rows]="30"
                   [rowsPerPageOptions]="[30, 60, 90]"
                   [showCurrentPageReport]="true"
                   currentPageReportTemplate="{first}–{last} de {totalRecords} días"
                   selectionMode="single" [selection]="sel()" (selectionChange)="abrir($event)">
            <ng-template #header>
              <tr>
                <th scope="col">Día</th>
                <th scope="col" class="comm-num">Contó la Suite</th>
                <th scope="col" class="comm-num">Contó Control</th>
                <th scope="col" class="comm-num">Difieren</th>
                <th scope="col">Resultado</th>
                <th scope="col">Segunda llave</th>
                <th scope="col">Folios</th>
              </tr>
            </ng-template>
            <ng-template #body let-d>
              <tr [pSelectableRow]="d">
                <td role="cell" data-label="Día"><b>{{ dmy(d.fecha) }}</b></td>
                <td role="cell" data-label="Contó la Suite" class="comm-num cq-strong">
                  @if (d.suite && d.suite.contado !== null) { {{ mx(d.suite.contado) }} }
                  @else { <span class="cq-dim">sin corte</span> }
                </td>
                <td role="cell" data-label="Contó Control" class="comm-num cq-strong">
                  @if (d.control.efectivo === null) { <span class="cq-dim">sin arqueo</span> }
                  @else { {{ mx(d.control.efectivo) }} }
                </td>
                <td role="cell" data-label="Difieren" class="comm-num"
                    [class.cq-mal]="d.cruce.estado === 'difieren'">
                  @if (d.cruce.diferencia === null) { <span class="cq-dim">—</span> }
                  @else if (d.cruce.estado === 'cuadran') { <span class="cq-dim">0.00</span> }
                  @else { {{ firmado(d.cruce.diferencia) }} }
                </td>
                <td role="cell" data-label="Resultado">
                  @switch (d.cruce.estado) {
                    @case ('cuadran') { <p-tag value="Cuadran al centavo" severity="success" styleClass="cq-tag" /> }
                    @case ('difieren') { <p-tag value="Difieren" severity="danger" styleClass="cq-tag" /> }
                    @case ('sin_arqueo') { <p-tag value="Control no cerró ese día" severity="warn" styleClass="cq-tag" /> }
                    @default { <p-tag value="Sin corte en la Suite" severity="warn" styleClass="cq-tag" /> }
                  }
                  @if (d.control.cuadra_ticket === false) {
                    <p-tag value="El ticket de Control no cuadra consigo mismo" severity="danger" styleClass="cq-tag" />
                  }
                </td>
                <td role="cell" data-label="Segunda llave">
                  @if (!d.suite) { <span class="cq-dim">—</span> }
                  @else if (d.suite.autorizado) { <p-tag value="Autorizado" severity="success" styleClass="cq-tag" /> }
                  @else { <p-tag value="Sin autorizar" severity="warn" styleClass="cq-tag" /> }
                </td>
                <td role="cell" data-label="Folios">
                  <span class="cq-mono">{{ d.control.folio || '—' }}</span>
                  <span class="cq-dim"> · Control</span>
                  @if (d.suite) {
                    <br /><span class="cq-mono">{{ d.suite.folio }}</span>
                    <span class="cq-dim"> · Suite{{ d.suite.cerro ? ' · cerró ' + d.suite.cerro : '' }}</span>
                  }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </section>
      }

      <!-- ⭐ DESIGN Q.3 — el terciario: la pieza exacta. El total dice QUE no cuadra; esto dice
           DONDE, que es lo unico con lo que alguien puede ir a buscar el billete. -->
      <app-side-peek [(open)]="peek" mode="window" [width]="900"
                     [title]="'Arqueo del ' + (sel() ? dmy(sel()!.fecha) : '')"
                     [subtitle]="subtitulo()">
        @if (sel(); as d) {
          <div class="cq-peek">
            <app-metric-strip [items]="kpisDia(d)" ariaLabel="Las dos cuentas de ese día" />

            @if (d.desglose.length) {
              <table class="cq-reja">
                <caption class="cq-reja-cap">Pieza por pieza. Sólo se listan las que algún sistema contó.</caption>
                <thead>
                  <tr>
                    <th scope="col">Pieza</th>
                    <th scope="col" class="comm-num">Control</th>
                    <th scope="col" class="comm-num">Suite</th>
                    <th scope="col" class="comm-num">Difieren</th>
                    <th scope="col" class="comm-num">En dinero</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of d.desglose; track p.clave) {
                    <tr [class.cq-fila-mal]="p.dif_piezas !== null && p.dif_piezas !== 0">
                      <td>{{ pieza(p.valor) }} <span class="cq-dim">{{ p.tipo }}</span></td>
                      <td class="comm-num">
                        @if (p.control === null) { <span class="cq-dim">no contó</span> }
                        @else { {{ p.control }} }
                      </td>
                      <td class="comm-num">
                        @if (p.suite === null) { <span class="cq-dim">no se cuenta</span> }
                        @else { {{ p.suite }} }
                      </td>
                      <td class="comm-num">
                        @if (p.dif_piezas === null) { <span class="cq-dim">—</span> }
                        @else if (p.dif_piezas === 0) { <span class="cq-dim">0</span> }
                        @else { {{ p.dif_piezas > 0 ? '+' : '−' }}{{ abs(p.dif_piezas) }} }
                      </td>
                      <td class="comm-num">
                        @if (p.dif_importe === null) { <span class="cq-dim">—</span> }
                        @else if (p.dif_importe === 0) { <span class="cq-dim">—</span> }
                        @else { {{ firmado(p.dif_importe) }} }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="cq-dim">Ese arqueo no trae desglose por denominación.</p>
            }

            @for (nota of notasDia(d); track nota) { <p class="cq-nota">{{ nota }}</p> }
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }

    .cq-actions { display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap; }

    .cq-veredicto { margin-block:var(--sp-4); padding-block:var(--sp-3); border-block:1px solid var(--border-color); }
    .cq-h2 { margin:0 0 var(--sp-2); font-size:var(--fs-h3); font-weight:600; }
    .cq-nota { margin:var(--sp-2) 0 0; font-size:var(--fs-sm); color:var(--text-muted); max-width:64rem; }

    .cq-block { margin-top:var(--sp-5); }
    .cq-bh { display:flex; align-items:baseline; gap:var(--sp-3); margin-bottom:var(--sp-2); }
    .cq-bh h2 { margin:0; font-size:var(--fs-lg); }
    .cq-hint { color:var(--text-muted); font-size:var(--fs-sm); }
    .cq-dim { color:var(--text-faint); }
    .cq-strong { font-weight:var(--fw-bold, 700); }
    .cq-mono { font-family:var(--font-mono); font-size:var(--fs-sm); }
    /* El descuadre se marca con PESO, no solo con color: en Alto Contraste de Windows el color
       de texto se reemplaza y un estado que solo vive ahi desaparece. El tag de al lado lo dice
       con palabras, que es el portador real. */
    .cq-mal { font-weight:var(--fw-bold, 700); }

    .cq-peek { display:flex; flex-direction:column; gap:var(--sp-4); }
    .cq-reja { width:100%; border-collapse:collapse; }
    .cq-reja-cap { text-align:left; color:var(--text-muted); font-size:var(--fs-sm); padding-bottom:var(--sp-2); }
    .cq-reja th, .cq-reja td {
      padding:var(--sp-1) var(--sp-2); border-bottom:1px solid var(--border-color);
      font-size:var(--fs-sm); text-align:left;
    }
    .cq-reja th { color:var(--text-muted); font-weight:var(--fw-medium, 500); }
    .cq-reja .comm-num { text-align:right; font-variant-numeric:tabular-nums; }
    .cq-fila-mal td { font-weight:var(--fw-bold, 700); }
  `],
})
export class FinanzasCajaArqueosComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/caja-control`;
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);

  readonly dias = signal<CruceDia[]>([]);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly frescura = signal<Freshness | null>(null);

  readonly sel = signal<CruceDia | null>(null);
  readonly peek = signal(false);

  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);
  protected readonly dmy = dmy;
  protected readonly abs = Math.abs;

  /** Con signo y con el menos TIPOGRÁFICO: un guion corto se confunde con un separador. */
  protected firmado(v: number): string {
    const n = Number(v) || 0;
    return `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;
  }

  protected pieza(valor: number): string {
    if (valor >= 20) return `$${valor.toLocaleString('es-MX')}`;
    if (valor >= 1) return `$${valor}`;
    return `${Math.round(valor * 100)}¢`;
  }

  ngOnInit(): void {
    this.recargar();
    /**
     * ⚠️ El arqueo de Control llega por réplica y **no avisa por socket**: sin este repaso la
     * pantalla se queda con la foto de cuando se abrió y no hay ninguna señal de que envejeció.
     * 60 s con la pestaña visible, igual que el Expediente.
     */
    encuestarVisible(60000, () => this.recargar(true), { destroyRef: this.destroyRef, zone: this.zone });
  }

  /**
   * @param silencioso El repaso no vuelve a pintar el esqueleto sobre una tabla que ya tiene
   *   datos, y un fallo suyo no borra lo que se ve: se declara sólo si no había nada.
   */
  recargar(silencioso = false): void {
    const conDatos = this.dias().length > 0;
    if (!(silencioso && conDatos)) { this.cargando.set(true); this.error.set(null); }
    this.http.get<CruceResp>(`${this.base}/cruce?limit=60`).subscribe({
      next: (r) => {
        this.dias.set(r?.rows ?? []);
        this.frescura.set(r?.frescura ?? null);
        this.cargando.set(false);
        this.error.set(null);
        // El día abierto se refresca con el resto: si no, el cajón sigue mostrando el desglose
        // viejo bajo una cabecera que ya cambió.
        const s = this.sel();
        if (s) this.sel.set((r?.rows ?? []).find((x) => x.fecha === s.fecha) ?? s);
      },
      error: () => {
        if (!(silencioso && conDatos)) this.error.set('No se pudo traer el cruce de arqueos.');
        this.cargando.set(false);
      },
    });
  }

  abrir(d: CruceDia | null): void {
    if (!d) return;
    this.sel.set(d);
    this.peek.set(true);
  }

  private readonly difieren = computed(() => this.dias().filter((d) => d.cruce.estado === 'difieren'));
  private readonly sinCorte = computed(() => this.dias().filter((d) => d.cruce.estado === 'sin_corte'));
  private readonly sinArqueo = computed(() => this.dias().filter((d) => d.cruce.estado === 'sin_arqueo'));

  /** La suma CON SIGNO. ⚠️ No es «cuánto falta»: sobrantes y faltantes se cancelan entre sí. */
  private readonly neto = computed(() => Math.round(
    this.difieren().reduce((a, d) => a + Number(d.cruce.diferencia ?? 0), 0) * 100) / 100);

  /** Y la suma en valor absoluto, que es el dinero que de verdad hay que explicar. */
  private readonly bruto = computed(() => Math.round(
    this.difieren().reduce((a, d) => a + Math.abs(Number(d.cruce.diferencia ?? 0)), 0) * 100) / 100);

  readonly titular = computed<string>(() => {
    const t = this.dias().length;
    const m = this.difieren().length;
    if (!t) return 'Sin arqueos que cruzar';
    if (!m) return `Los ${t} días cruzados coinciden al centavo`;
    return `${m} de ${t} días no coinciden, por ${money(this.bruto())}`;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const t = this.dias().length;
    if (!t) return [];
    const m = this.difieren().length;
    const sc = this.sinCorte().length;
    const sa = this.sinArqueo().length;
    const sinAut = this.dias().filter((d) => d.suite && !d.suite.autorizado).length;
    return [
      {
        label: 'Días que no coinciden', value: `${m} de ${t}`,
        tone: m ? 'bad' : 'ok',
        sub: m ? `${money(this.bruto())} que explicar` : 'coinciden al centavo',
      },
      {
        label: 'Diferencia neta', value: this.neto() === 0 ? money(0) : this.firmado(this.neto()),
        tone: this.neto() === 0 ? 'ok' : 'warn',
        sub: 'lo contado por la Suite menos lo contado por Control; sobrantes y faltantes se cancelan',
      },
      {
        label: 'Sin la segunda llave', value: sinAut,
        tone: sinAut ? 'warn' : 'ok',
        sub: sinAut ? 'cortes cerrados que nadie autorizó' : 'todos autorizados',
      },
      /**
       * ⛔ Los días con UN SOLO conteo van juntos y van declarados como **no medidos**, no como
       * días que cuadran. Son los dos huecos simétricos: a veces falta el corte de la Suite, a
       * veces el arqueo de Control. Ninguno es un descuadre y ninguno entra en la suma.
       */
      {
        label: 'Con un solo conteo', value: sa + sc,
        state: (sa + sc) ? 'no_medido' : undefined,
        stateNote: (sa + sc)
          ? 'Nadie contó ese cajón dos veces, así que no hay nada que cruzar. No es cero: es que falta el otro conteo.'
          : undefined,
        tone: 'muted',
        sub: (sa + sc) ? `${sc} sin corte en la Suite · ${sa} sin arqueo de Control` : 'todos los días tienen los dos',
      },
    ];
  });

  /**
   * ⛔ Lo que este cruce NO cubre, dicho con su número. Callarlo haría leer «coinciden» como si
   * el cruce fuera completo, y no lo es: las dos rejas no tienen las mismas piezas.
   */
  readonly notas = computed<string[]>(() => {
    const n: string[] = [];
    const t = this.dias().length;
    if (!t) return n;
    n.push('Cuál de los dos conteos manda NO está decidido: la pantalla publica los dos y su diferencia, '
      + 'no elige un árbitro. Lo de Control se corrige en Control; lo de la Suite, recontando en Captura.');
    const sc = this.sinCorte().length;
    if (sc) {
      n.push(`${sc} día(s) tienen arqueo de Control y ningún corte en la Suite. Eso no es una diferencia `
        + 'de dinero: es un conteo que falta de este lado, y por eso no entra en la suma.');
    }
    const sa = this.sinArqueo();
    if (sa.length) {
      const monto = sa.reduce((a, d) => a + Number(d.suite?.contado ?? 0), 0);
      n.push(`${sa.length} día(s) tienen corte sellado en la Suite (${money(Math.round(monto * 100) / 100)}) `
        + 'y ningún arqueo de cierre en Control contra el cual compararlo. Tampoco entra en la suma: '
        + 'no hay un segundo conteo que lo contradiga ni que lo confirme.');
    }
    n.push('El arqueo de cierre de Control se identifica por traer la custodia completa (dólares). '
      + 'Es una heurística verificada del 14-oct en adelante, no una regla del sistema: los días con '
      + 'varios arqueos con dólares pueden estar eligiendo el que no es.');
    return n;
  });

  readonly subtitulo = computed<string | null>(() => {
    const d = this.sel();
    if (!d) return null;
    const p: string[] = [];
    if (d.control.folio) p.push(`Control ${d.control.folio}`);
    if (d.suite) p.push(`Suite ${d.suite.folio}`);
    if (d.cruce.estado === 'difieren' && d.cruce.diferencia !== null) {
      p.push(`difieren ${this.firmado(d.cruce.diferencia)}`);
    } else if (d.cruce.estado === 'cuadran') {
      p.push('coinciden al centavo');
    }
    return p.join(' · ');
  });

  kpisDia(d: CruceDia): MetricStripItem[] {
    const items: MetricStripItem[] = [
      {
        label: 'Contó la Suite', value: d.suite?.contado != null ? money(d.suite.contado) : 'sin corte',
        state: d.suite?.contado != null ? undefined : 'no_medido',
        stateNote: d.suite?.contado != null ? undefined : 'Ese día nadie selló un corte en la Suite.',
        sub: d.suite ? `${d.suite.folio} · ${d.suite.autorizado ? 'autorizado' : 'sin autorizar'}` : undefined,
      },
      {
        label: 'Contó Control', value: d.control.efectivo !== null ? money(d.control.efectivo) : 'sin arqueo',
        state: d.control.efectivo !== null ? undefined : 'no_medido',
        stateNote: d.control.efectivo !== null ? undefined : 'Control no capturó un arqueo de cierre ese día.',
        sub: d.control.folio ? `${d.control.folio}${d.control.hora ? ' · ' + this.hhmm(d.control.hora) : ''}` : undefined,
      },
    ];
    if (d.cruce.diferencia !== null) {
      items.push({
        label: 'Difieren', value: d.cruce.diferencia === 0 ? money(0) : this.firmado(d.cruce.diferencia),
        tone: d.cruce.diferencia === 0 ? 'ok' : 'bad',
        sub: 'la Suite menos Control',
      });
    }
    /**
     * ⚠️ El esperado de la Suite va como CONTRASTE, no como juez: es lo que el libro creía que
     * debía haber, y en estos días quedó negativo por cobranza que nunca entró. Publicarlo al
     * lado evita que alguien lea la diferencia contra Control como si fuera la del corte.
     */
    if (d.suite?.esperado != null) {
      items.push({
        label: 'Esperaba el libro', value: money(d.suite.esperado),
        tone: 'muted', state: 'derivado',
        method: 'fondo + ingresos − gastos − depósitos ± CAOS; no es un conteo',
        sub: d.suite.diferencia != null ? `contra lo contado: ${this.firmado(d.suite.diferencia)}` : undefined,
      });
    }
    return items;
  }

  /**
   * ⭐ **Cuánto de la diferencia explican las piezas comparables, y cuánto no.** Las dos rejas no
   * son la misma: Control tiene moneda de $100 y centavos de 20/10/5 que la Suite no ofrece, y la
   * Suite junta todo lo menor a 50¢ en «morralla», que no viaja por denominación. Si la suma del
   * desglose no llega a la diferencia del día, el resto se DECLARA en vez de dejar creer que el
   * desglose la explica entera.
   */
  notasDia(d: CruceDia): string[] {
    const n: string[] = [];
    const comparables = d.desglose.filter((p) => p.dif_importe !== null);
    const sumado = Math.round(comparables.reduce((a, p) => a + Number(p.dif_importe ?? 0), 0) * 100) / 100;
    const total = d.cruce.diferencia;

    if (total !== null && Math.abs(total) > 0.005) {
      if (Math.abs(sumado - total) < 0.005) {
        n.push(`Las piezas de arriba explican la diferencia entera (${this.firmado(sumado)}).`);
      } else {
        n.push(`Las piezas comparables explican ${this.firmado(sumado)} de los ${this.firmado(total)} del día. `
          + `Los ${money(Math.abs(Math.round((total - sumado) * 100) / 100))} restantes NO están en el desglose: `
          + 'la Suite agrupa lo menor a 50¢ en «morralla» y no la reporta por pieza.');
      }
    }
    if (d.cruce.estado === 'sin_arqueo') {
      n.push('Control no capturó un arqueo de cierre ese día, así que no hay contra qué cruzar. '
        + 'Lo de arriba es lo que contó la Suite, solo — nadie lo confirmó ni lo contradijo.');
    }
    const soloControl = d.desglose.filter((p) => p.solo_en === 'control' && (p.control ?? 0) !== 0);
    if (soloControl.length) {
      const monto = soloControl.reduce((a, p) => a + (p.control ?? 0) * p.valor, 0);
      n.push(`${soloControl.length} denominación(es) sólo existen en la reja de Control `
        + `(${money(Math.round(monto * 100) / 100)}): la Suite no tiene dónde capturarlas, así que esa parte `
        + 'no se puede cruzar — no es que coincida.');
    }
    if (d.control.cuadra_ticket === false) {
      n.push('El ticket de Control no cuadra consigo mismo: la suma de sus piezas no da su propio total. '
        + 'Antes de buscar la diferencia contra la Suite, hay que corregir ese arqueo en Control.');
    }
    return n;
  }

  /** `1899-12-30T14:18:58` o `14:18:58` → `14:18`. Control guarda la hora con fecha centinela. */
  hhmm(v: string | null | undefined): string {
    const s = String(v ?? '');
    const m = s.match(/(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : '—';
  }
}
