import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { TextareaModule } from 'primeng/textarea';
import {
  FaltantesService, MOTIVOS, ETIQUETA_MOTIVO, ETIQUETA_DECISION, ETIQUETA_DESTINO,
  type Faltante, type ResumenFaltantes, type StockoutDecision, type StockoutDestino,
  type StockoutKind,
} from '../../tienda/faltantes.service';

/**
 * `[FLT.12]` FALTANTES DE PISO — la bandeja de Compras (`/compras/faltantes`).
 *
 * ── Qué llega acá y por qué vale ─────────────────────────────────────────────────────────────
 * Lo que las cajeras y anaquelistas reportan desde el mostrador: lo que un cliente pidió y no
 * había. **Es la única señal de demanda de la suite que no sale de ningún feed**, porque una venta
 * que no ocurrió no deja rastro en `kepler_ods` — no hay ticket, no hay movimiento, no hay nada.
 * La bandeja de Hallazgos de reabastecimiento, en cambio, la llena un barrido nocturno sobre
 * existencias: ve lo que se acabó, nunca lo que nunca se tuvo.
 *
 * ── Answer-first (DESIGN pre-vuelo §15) ──────────────────────────────────────────────────────
 * Arriba el veredicto, abajo el grid. Y cada número dice con qué se calculó:
 *  · el dinero es una **estimación** (precio de pieza × veces pedido), etiquetada como tal;
 *  · **«sin valorar» se cuenta aparte y nunca se suma como $0** — no tener precio con qué valorar
 *    no es valer cero, y un cero dibujado se lee como «no importa» (ADR-056);
 *  · los que **contradicen al ERP** se separan a propósito: la persona vio cero y el sistema dice
 *    que hay. Eso no es una compra, es un descuadre de inventario, y mezclarlos haría comprar
 *    mercancía que ya está en la tienda.
 *
 * ── La decisión es la mitad que sostiene el módulo ───────────────────────────────────────────
 * Si la cajera reporta y nunca sabe qué pasó, deja de reportar en dos semanas y la fuente se seca.
 * Por eso toda fila se cierra con una respuesta que **vuelve a su pantalla**, y por eso
 * «no se trabaja» exige motivo escrito: es lo que la sucursal va a leer, y un «no» a secas no se
 * puede rebatir. Medido en la landing de esta misma suite: hay bandejas con **0 resueltas en 30
 * días** — nacen congeladas cuando nadie las trabaja.
 */
@Component({
  selector: 'app-compras-faltantes',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule, DialogModule, TextareaModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cf-page">
      <header class="cf-head">
        <div>
          <h1>Faltantes de piso</h1>
          <p>Lo que el cliente pidió en mostrador y no había. Lo reportan las cajeras y anaquelistas.</p>
        </div>
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true"
                  (onClick)="cargar()" [loading]="cargando()" />
      </header>

      <!-- Veredicto primero. Cada cifra con su lectura en llano al lado. -->
      @if (resumen(); as r) {
        <section class="cf-kpis" aria-label="Resumen de faltantes">
          <div class="cf-kpi">
            <span class="cf-kpi-n">{{ r.abiertos }}</span>
            <span class="cf-kpi-l">Por resolver</span>
          </div>
          <div class="cf-kpi">
            <span class="cf-kpi-n">{{ r.dinero_estimado | currency:'MXN':'symbol-narrow':'1.0-0':'es-MX' }}</span>
            <span class="cf-kpi-l">Venta perdida estimada</span>
            @if (r.abiertos_sin_valorar > 0) {
              <!-- Lo no medido se DECLARA: sin esta línea el total se lee como completo. -->
              <span class="cf-kpi-nota">
                No incluye {{ r.abiertos_sin_valorar }} sin precio con qué valorar
              </span>
            }
          </div>
          <!-- FLT.24 — Va ANTES que el resto: es la única fila cuya venta todavía no se perdió.
               El anaquelista la resuelve hoy caminando a la bodega. -->
          <div class="cf-kpi" [class.alerta]="r.recuperable_hoy > 0">
            <span class="cf-kpi-n">{{ r.recuperable_hoy }}</span>
            <span class="cf-kpi-l">Recuperable HOY</span>
            <span class="cf-kpi-nota">
              Hay existencia, faltó en el anaquel — va a piso
              @if (r.dinero_recuperable_hoy > 0) {
                · {{ r.dinero_recuperable_hoy | currency:'MXN':'symbol-narrow':'1.0-0':'es-MX' }}
              }
            </span>
          </div>
          <div class="cf-kpi">
            <span class="cf-kpi-n">{{ r.no_en_catalogo }}</span>
            <span class="cf-kpi-l">No los trabajamos</span>
            <span class="cf-kpi-nota">Demanda que ningún reporte puede ver</span>
          </div>
          <div class="cf-kpi" [class.alerta]="r.contradicen_al_erp > 0">
            <span class="cf-kpi-n">{{ r.contradicen_al_erp }}</span>
            <span class="cf-kpi-l">Buscado y no estaba</span>
            <span class="cf-kpi-nota">Descuadre afirmado — va a inventario</span>
          </div>
        </section>
      }

      <section class="cf-filtros">
        <p-select [options]="opcionesMotivo" [ngModel]="motivo()" (ngModelChange)="filtrar('kind', $event)"
                  optionLabel="label" optionValue="value" placeholder="Todos los motivos"
                  [showClear]="true" styleClass="cf-sel" appendTo="body" ariaLabel="Filtrar por motivo" />
        <p-select [options]="opcionesEstado" [ngModel]="estado()" (ngModelChange)="filtrar('status', $event)"
                  optionLabel="label" optionValue="value" placeholder="Por resolver"
                  [showClear]="true" styleClass="cf-sel" appendTo="body" ariaLabel="Filtrar por estado" />
        <span class="cf-conteo">{{ filas().length }} renglón(es)</span>
      </section>

      @if (cargando()) {
        <div class="cf-skel" aria-hidden="true">
          @for (i of [1,2,3,4,5,6]; track i) { <div class="cf-skel-row"></div> }
        </div>
      } @else if (error()) {
        <div class="cf-aviso">
          <strong>No se pudo cargar la bandeja.</strong>
          <span>{{ error() }}</span>
          <p-button label="Reintentar" size="small" severity="secondary" (onClick)="cargar()" />
        </div>
      } @else if (!filas().length) {
        <div class="cf-empty">
          <i class="pi pi-inbox" aria-hidden="true"></i>
          <p><strong>Nada por resolver.</strong></p>
          <span>Cuando el mostrador reporte un faltante, aparece aquí ordenado por lo que más cuesta.</span>
        </div>
      } @else {
        <table class="cf-tabla">
          <thead>
            <tr>
              <th scope="col">Producto</th>
              <th scope="col">Sucursal</th>
              <th scope="col">Le toca a</th>
              <th scope="col">Motivo</th>
              <th scope="col" class="num">Veces</th>
              <th scope="col" class="num">Estimado</th>
              <th scope="col">Acción</th>
            </tr>
          </thead>
          <tbody>
            @for (f of filas(); track f.id) {
              <tr [class.contra]="f.contradice_al_erp">
                <td>
                  <span class="cf-prod">{{ f.product_name || f.scanned_code || 'Sin nombre' }}</span>
                  @if (f.sku) { <span class="cf-sku mono">{{ f.sku }}</span> }
                  @if (f.contradice_al_erp) {
                    <span class="cf-flag">
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
                      El sistema dice que hay {{ f.on_hand_at_report }} — revisar inventario
                    </span>
                  }
                </td>
                <td>{{ f.warehouse_name || f.warehouse_code }}</td>
                <!-- FLT.24 — El destino lo DERIVA el servidor de (motivo, existencia). Acá no se
                     vuelve a calcular: dos copias de la misma regla divergen el día que cambie. -->
                <td><span class="cf-destino" [class]="'d-' + f.destino">{{ etiquetaDestino(f.destino) }}</span></td>
                <td><p-tag [value]="etiquetaMotivo(f.kind)" [severity]="severidad(f.kind)" /></td>
                <td class="num mono"><b>{{ f.times_reported }}</b></td>
                <td class="num mono">
                  @if (f.est_lost_revenue !== null) {
                    {{ f.est_lost_revenue | currency:'MXN':'symbol-narrow':'1.2-2':'es-MX' }}
                  } @else {
                    <!-- Nunca $0: sin precio no es sin valor. -->
                    <em class="cf-muted">sin valorar</em>
                  }
                </td>
                <td>
                  @if (f.decision) {
                    <span class="cf-dec">{{ etiquetaDecision(f.decision) }}</span>
                  } @else {
                    <p-button label="Responder" size="small" severity="secondary" [outlined]="true"
                              (onClick)="abrir(f)" />
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }

      <!-- Responder. Lo que se elija acá se lo lleva la sucursal a su pantalla. -->
      <p-dialog [(visible)]="dialogo" [modal]="true" [style]="{ width: '30rem' }"
                header="Responder al mostrador" [draggable]="false" (onHide)="cerrar()">
        @if (elegido(); as f) {
          <p class="cf-dlg-prod">{{ f.product_name || f.scanned_code }}</p>
          <p class="cf-dlg-sub">
            {{ etiquetaMotivo(f.kind) }} ·
            {{ f.times_reported }} {{ f.times_reported === 1 ? 'vez' : 'veces' }}
            en {{ f.warehouse_name || f.warehouse_code }}
          </p>

          <label class="cf-dlg-lbl" for="cf-dec">¿Qué se hace?</label>
          <p-select id="cf-dec" [options]="opcionesDecision" [(ngModel)]="decision"
                    optionLabel="label" optionValue="value" placeholder="Elige una respuesta"
                    styleClass="cf-sel-full" appendTo="body" />

          <label class="cf-dlg-lbl" for="cf-nota">
            Motivo
            @if (decision === 'no_se_trabaja') { <b class="cf-req">— obligatorio</b> }
          </label>
          <textarea pTextarea id="cf-nota" [(ngModel)]="nota" rows="3" class="cf-dlg-nota"
                    placeholder="Lo va a leer quien lo reportó"></textarea>

          @if (errorDialogo()) { <p class="cf-dlg-err">{{ errorDialogo() }}</p> }
        }
        <!-- ⚠️ Va con #footer, NO con pTemplate="footer": en PrimeNG 22 el segundo NO proyecta
             nada y el diálogo sale SIN botones — sin manera de guardar ni de cancelar, y sin
             ningún error en consola que lo delate. Se ve en pantalla, no en el build.
             SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. -->
        <ng-template #footer>
          <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="cerrar()" />
          <p-button label="Guardar respuesta" (onClick)="guardar()" [loading]="guardando()"
                    [disabled]="!decision" />
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    /* Operations (DESIGN §O). Cero hex crudo para que el modo oscuro salga solo. */
    .cf-page { padding: 1rem 1.15rem 2rem; display: flex; flex-direction: column; gap: 1rem; }

    .cf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .cf-head h1 { font-size: var(--fs-lg, 1.15rem); font-weight: 800; margin: 0; color: var(--text-main); }
    .cf-head p { margin: .2rem 0 0; font-size: var(--fs-sm, .82rem); color: var(--text-muted); max-width: 46rem; }

    /* MetricStrip: sin caja por métrica, separadas por hairline (DESIGN ADR-033). */
    .cf-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      border: 1px solid var(--border-color); border-radius: var(--r-md, 10px); background: var(--card-bg); }
    .cf-kpi { display: flex; flex-direction: column; gap: .1rem; padding: .8rem 1rem;
      border-left: 1px solid var(--border-color); }
    .cf-kpi:first-child { border-left: 0; }
    .cf-kpi-n { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: 1.5rem; font-weight: 800; color: var(--text-main); line-height: 1.1; }
    .cf-kpi.alerta .cf-kpi-n { color: var(--tone-warn); }
    .cf-kpi-l { font-size: var(--fs-sm, .8rem); font-weight: 700; color: var(--text-main); }
    .cf-kpi-nota { font-size: var(--fs-xs, .7rem); color: var(--text-muted); }

    .cf-filtros { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .cf-conteo { margin-left: auto; font-size: var(--fs-sm, .8rem); color: var(--text-muted);
      font-variant-numeric: tabular-nums; }

    .cf-tabla { width: 100%; border-collapse: collapse; font-size: var(--fs-sm, .82rem); }
    .cf-tabla th { text-align: left; font-size: var(--fs-xs, .7rem); text-transform: uppercase;
      letter-spacing: .05em; color: var(--text-muted); font-weight: 700; padding: .5rem .6rem;
      border-bottom: 1px solid var(--border-color); position: sticky; top: 0; background: var(--card-bg); z-index: 1; }
    .cf-tabla td { padding: .55rem .6rem; border-bottom: 1px solid var(--border-color);
      color: var(--text-main); vertical-align: top; }
    .cf-tabla .num { text-align: right; }
    .cf-tabla .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cf-tabla tr:hover td { background: color-mix(in srgb, var(--ink) 3%, transparent); }

    .cf-prod { display: block; font-weight: 600; }
    .cf-sku { display: inline-block; font-size: var(--fs-xs, .7rem); color: var(--text-muted); }
    /* El aviso lleva icono Y texto: el color nunca es el único portador del significado. */
    .cf-flag { display: flex; align-items: center; gap: .3rem; margin-top: .15rem;
      font-size: var(--fs-xs, .7rem); color: var(--tone-warn); font-weight: 600; }
    .cf-muted { color: var(--text-muted); font-style: normal; }

    /* FLT.24 — El destino: color + TEXTO, nunca color solo. Piso resalta porque es lo único
       que todavía se puede salvar hoy.
       SIN ACENTOS GRAVES ACÁ: esto vive dentro de un template literal y lo cierran. */
    .cf-destino { display: inline-block; font-size: var(--fs-xs, .72rem); font-weight: 700;
      padding: .15rem .5rem; border-radius: 999px; white-space: nowrap;
      border: 1px solid var(--border-color); color: var(--text-muted); }
    .cf-destino.d-piso { color: var(--tone-ok);
      border-color: color-mix(in srgb, var(--tone-ok) 45%, transparent); }
    .cf-destino.d-inventario { color: var(--tone-warn);
      border-color: color-mix(in srgb, var(--tone-warn) 45%, transparent); }
    .cf-destino.d-compras { color: var(--text-main); }
    .cf-dec { font-weight: 700; font-size: var(--fs-sm, .8rem); }

    .cf-empty, .cf-aviso { display: flex; flex-direction: column; align-items: center; gap: .35rem;
      padding: 2.5rem 1rem; text-align: center; color: var(--text-muted);
      border: 1px dashed var(--border-color); border-radius: var(--r-md, 10px); }
    .cf-empty i { font-size: 1.5rem; }
    .cf-empty p, .cf-aviso strong { margin: 0; color: var(--text-main); }
    .cf-empty span, .cf-aviso span { font-size: var(--fs-sm, .8rem); }

    .cf-skel { display: flex; flex-direction: column; gap: .4rem; }
    .cf-skel-row { height: 2.6rem; border-radius: var(--r-sm, 6px);
      background: color-mix(in srgb, var(--ink) 7%, transparent); animation: cfPulse 1.4s ease-in-out infinite; }
    @keyframes cfPulse { 0%, 100% { opacity: .5 } 50% { opacity: .9 } }
    @media (prefers-reduced-motion: reduce) { .cf-skel-row { animation: none; } }

    .cf-dlg-prod { margin: 0; font-weight: 700; color: var(--text-main); }
    .cf-dlg-sub { margin: .1rem 0 .9rem; font-size: var(--fs-sm, .8rem); color: var(--text-muted); }
    .cf-dlg-lbl { display: block; margin: .7rem 0 .3rem; font-size: var(--fs-sm, .8rem);
      font-weight: 700; color: var(--text-main); }
    .cf-req { color: var(--tone-warn); }
    .cf-dlg-nota { width: 100%; }
    .cf-dlg-err { margin: .6rem 0 0; font-size: var(--fs-sm, .8rem); color: var(--tone-bad); }
    :host ::ng-deep .cf-sel-full { width: 100%; }

    @media (max-width: 48rem) {
      .cf-kpi { border-left: 0; border-top: 1px solid var(--border-color); }
      .cf-kpi:first-child { border-top: 0; }
    }
  `],
})
export class ComprasFaltantesComponent implements OnInit {
  private readonly api = inject(FaltantesService);

  readonly resumen = signal<ResumenFaltantes | null>(null);
  readonly filas = signal<Faltante[]>([]);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly motivo = signal<StockoutKind | null>(null);
  readonly estado = signal<string | null>(null);

  dialogo = false;
  decision: StockoutDecision | null = null;
  nota = '';
  readonly elegido = signal<Faltante | null>(null);
  readonly guardando = signal(false);
  readonly errorDialogo = signal<string | null>(null);

  readonly opcionesMotivo = MOTIVOS.map((m) => ({ label: m.label, value: m.kind }));
  readonly opcionesEstado = [
    { label: 'Por resolver', value: '' },
    { label: 'Resueltos', value: 'resolved' },
    { label: 'Descartados', value: 'dismissed' },
  ];
  readonly opcionesDecision: Array<{ label: string; value: StockoutDecision }> = [
    { label: 'Se da de alta', value: 'alta_catalogo' },
    { label: 'Ya viene en camino', value: 'ya_en_camino' },
    { label: 'No se trabaja', value: 'no_se_trabaja' },
    { label: 'Código corregido', value: 'codigo_corregido' },
    { label: 'No era faltante', value: 'era_error' },
  ];

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.bandeja({
      kind: this.motivo() ?? undefined,
      status: this.estado() || undefined,
    }).subscribe({
      next: (r) => { this.filas.set(r ?? []); this.cargando.set(false); },
      error: (e) => {
        this.filas.set([]);
        this.cargando.set(false);
        this.error.set(e?.error?.message || 'Revisa la conexión e intenta de nuevo.');
      },
    });
    this.api.resumen().subscribe({
      next: (r) => this.resumen.set(r),
      error: () => this.resumen.set(null),
    });
  }

  filtrar(campo: 'kind' | 'status', valor: string | null): void {
    if (campo === 'kind') this.motivo.set((valor as StockoutKind) || null);
    else this.estado.set(valor ?? null);
    this.cargar();
  }

  abrir(f: Faltante): void {
    this.elegido.set(f);
    this.decision = null;
    this.nota = '';
    this.errorDialogo.set(null);
    this.dialogo = true;
  }

  cerrar(): void { this.dialogo = false; this.elegido.set(null); }

  guardar(): void {
    const f = this.elegido();
    if (!f || !this.decision || this.guardando()) return;
    // El backend también lo exige; acá se avisa antes para no gastarle un viaje a la persona.
    if (this.decision === 'no_se_trabaja' && !this.nota.trim()) {
      this.errorDialogo.set('Escribe el motivo: es lo que va a leer la sucursal.');
      return;
    }
    this.guardando.set(true);
    this.api.decidir(f.id, this.decision, this.nota.trim() || undefined).subscribe({
      next: () => { this.guardando.set(false); this.cerrar(); this.cargar(); },
      error: (e) => {
        this.guardando.set(false);
        this.errorDialogo.set(e?.error?.message || 'No se pudo guardar. Intenta de nuevo.');
      },
    });
  }

  etiquetaMotivo(k: StockoutKind): string { return ETIQUETA_MOTIVO[k] ?? k; }
  etiquetaDecision(d: string): string { return ETIQUETA_DECISION[d as StockoutDecision] ?? d; }
  etiquetaDestino(d: StockoutDestino): string { return ETIQUETA_DESTINO[d] ?? d; }

  severidad(k: StockoutKind): 'danger' | 'warn' | 'info' | 'secondary' {
    if (k === 'agotado') return 'danger';
    if (k === 'no_en_anaquel') return 'warn';
    if (k === 'no_en_catalogo') return 'warn';
    if (k === 'codigo_no_pasa') return 'info';
    return 'secondary';
  }
}
