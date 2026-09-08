import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ComercialService, Warehouse } from '../../comercial/comercial.service';
import { PendingExpiryLine, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/** Un plazo corto es riesgo inmediato: entra y hay que sacarlo casi de inmediato. */
const PLAZO_RIESGOSO_DIAS = 30;
/** Intermedio: sirve, pero hay que traerlo vigilado. */
const PLAZO_INTERMEDIO_DIAS = 90;

/**
 * Una llegada = un vale de entrada cerrado que todavía tiene mercancía sin fecha.
 * Es la unidad de trabajo real: la gente no persigue renglones sueltos, persigue
 * "lo que llegó de tal proveedor el martes".
 */
interface Arrival {
  session_id: string;
  vale_folio: string;
  source_ref: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  closed_at: string;
  dias_esperando: number;
  lines: PendingExpiryLine[];
  /** Unidades del vale que todavía nadie fechó. */
  falta: number;
  /** Fechadas pero 🔴: esperan que un supervisor las autorice. */
  retenido: number;
  /** Totales del vale completo, incluidos los renglones ya terminados. */
  recibido: number;
  fechado: number;
  avance: number;
}

/**
 * WMS-REC (ADR-044, revisión Opción A) — **Caducidades · Productos por fechar**.
 *
 * Seguimiento de la mercancía que ya entró a inventario y todavía no dice cuándo
 * vence. Recepción le dio luz verde y la dio de alta con lote `NA`; acá se le pone
 * lote y caducidad. Poner la fecha reclasifica `NA` → lote fechado: el total del
 * inventario no se mueve, sólo se vuelve trazable.
 *
 * La unidad de la lista es el **producto**: una entrega de 30 cajas surtidas es, para
 * quien la fecha, N productos distintos y cada uno lleva su propia caducidad. Todos
 * quedan a la vista con su campo listo; nada escondido detrás de un expansor.
 *
 * La **llegada** es el encabezado que agrupa: da el contexto de dónde vino cada cosa
 * y su avance sobre el total recibido —no sólo sobre lo que falta—, para que no se
 * fecha media tarima y se la crea terminada.
 *
 * Se ordena por antigüedad —lo que lleva más días esperando primero— porque el
 * costo de no saber cuándo vence algo crece con el tiempo que lleva en el piso.
 *
 * Pantalla separada del vale a propósito: recepción verifica que llegó lo que dice
 * el papel (y aprueba); el bodeguero acomoda y lee las etiquetas. Son dos trabajos,
 * de dos personas y dos momentos.
 */
@Component({
  selector: 'app-almacen-caducidades-por-fechar',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TagModule, SelectModule,
    InputTextModule, ToastModule, TooltipModule,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Caducidades · Productos por fechar</h1>
          <p class="surf-page-sub">
            Mercancía que ya entró a inventario y todavía no dice cuándo vence, separada por producto.
            Lo que lleva más tiempo esperando, arriba.
          </p>
        </div>
        <div class="cll-head-actions">
          <p-select [options]="warehouseOptions()" [(ngModel)]="warehouseFilter" optionLabel="label" optionValue="value"
            (onChange)="load()" styleClass="cll-wh" placeholder="Todos los almacenes"></p-select>
          <button pButton [text]="true" size="small" severity="secondary" (click)="load()">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span> Actualizar
          </button>
        </div>
      </header>

      @if (arrivals().length || retenidos().length) {
        <div class="cll-summary" role="status">
          <span><strong>{{ enFila() }}</strong> producto(s) en la fila</span>
          <span class="cll-dot" aria-hidden="true">·</span>
          <span><strong>{{ totalPendiente() }}</strong> unidades sin fecha</span>
          @if (totalRetenido() > 0) {
            <span class="cll-dot" aria-hidden="true">·</span>
            <span><strong>{{ totalRetenido() }}</strong> retenidas por autorizar</span>
          }
          @if (masViejo() > 0) {
            <span class="cll-dot" aria-hidden="true">·</span>
            <span>el más viejo lleva <strong>{{ masViejo() }}</strong> día(s)</span>
          }
        </div>
      }

      <!-- Captura por lector. El orden es el del trabajo físico: se lee la etiqueta,
           se cuenta lo que hay, se mira la fecha. Enter encadena los tres campos y al
           guardar el foco vuelve al código, listo para el siguiente producto.

           El código se resuelve SÓLO contra lo que está esperando fecha: si se escanea
           algo que no viene en ninguna entrada pendiente, se avisa en vez de dar de alta
           mercancía por un camino que no es el de recepción. -->
      @if (canCapture()) {
        <div class="cll-scan surf-card">
          <div class="cll-scan-grid">
            <label class="cll-f">
              <span>Código de barras / SKU</span>
              <input pInputText #codeInput [(ngModel)]="code" (keyup.enter)="resolverCodigo()"
                placeholder="Escaneá o tecleá y Enter" class="cll-code" autofocus />
            </label>
            <label class="cll-f">
              <span>Cantidad @if (sel(); as s) { <em>({{ unidadDe(s) }})</em> }</span>
              <input pInputText #qtyInput type="number" min="1" [(ngModel)]="cantidad"
                [disabled]="!sel()" (keyup.enter)="focusVence()" class="cll-qty" />
            </label>
            <label class="cll-f">
              <span>Caducidad</span>
              <input pInputText #venceInput type="date" [(ngModel)]="vence"
                [disabled]="!sel()" (keyup.enter)="guardar()" />
            </label>
            <label class="cll-f">
              <span>Lote <em>(opcional)</em></span>
              <input pInputText [(ngModel)]="lote" [disabled]="!sel()" placeholder="Como viene en la etiqueta"
                (keyup.enter)="guardar()" />
            </label>
            <button pButton [disabled]="!puedeGuardar() || guardando()" [loading]="guardando()" (click)="guardar()">
              <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span> Fechar
            </button>
          </div>

          @if (scanError(); as err) {
            <p class="cll-scan-err" role="alert"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ err }}</p>
          }
          @if (sel(); as s) {
            <div class="cll-scan-hit" role="status">
              <i class="pi pi-check-circle" aria-hidden="true"></i>
              <strong>{{ s.product_name || s.sku }}</strong>
              <span class="surf-muted">· vale {{ s.vale_folio }}</span>
              <span class="surf-muted">· {{ s.warehouse_code || s.warehouse_name }}</span>
              <span class="cll-scan-falta">faltan {{ s.pending_qty }} {{ unidadDe(s) }}</span>
              <button pButton [text]="true" size="small" severity="secondary" (click)="limpiar()">Cancelar</button>
            </div>
            @if (plazo() !== null) {
              <p class="cll-plazo" [class]="'cll-plazo--' + clasificacion()">
                <i class="pi" [class.pi-check-circle]="clasificacion() === 'bueno'"
                   [class.pi-exclamation-triangle]="clasificacion() === 'intermedio'"
                   [class.pi-times-circle]="clasificacion() === 'malo'" aria-hidden="true"></i>
                {{ plazo() }} días de vida · {{ etiquetaPlazo() }}
              </p>
            }
          }
        </div>
      }

      <!-- LA FILA DE ESPERA. Lo que llegó y todavía no tiene fecha, agrupado por la
           entrada de la que vino. En cuanto se fecha, el producto sale de acá. -->
      @for (a of arrivals(); track a.session_id) {
        <section class="cll-grp">
          <header class="cll-grp-head">
            <div class="cll-grp-id">
              <strong class="surf-mono">{{ a.vale_folio }}</strong>
              <span class="surf-muted">{{ a.supplier_name || a.supplier_code || 'sin proveedor' }}</span>
              <span class="surf-muted">· {{ a.warehouse_code || a.warehouse_name || '—' }}</span>
              <span class="surf-muted">· llegó {{ a.closed_at | date:'dd/MM/yy' }}</span>
            </div>
            <div class="cll-grp-meta">
              <span class="cll-grp-n">{{ a.lines.length }} producto(s)</span>
              <div class="cll-prog" [attr.aria-label]="a.fechado + ' de ' + a.recibido + ' unidades fechadas'">
                <div class="cll-prog-bar"><span [style.width.%]="a.avance"></span></div>
                <span class="cll-prog-txt">{{ a.fechado }} / {{ a.recibido }}</span>
              </div>
              @if (a.retenido > 0) {
                <p-tag [value]="a.retenido + ' retenidas'" severity="danger"
                  pTooltip="Ya tienen fecha pero quedaron retenidas: un supervisor debe autorizarlas"></p-tag>
              }
              <p-tag [value]="a.dias_esperando + ' d'" [severity]="esperaSeverity(a.dias_esperando)"></p-tag>
            </div>
          </header>

          <div class="cll-det">
            @for (l of a.lines; track l.line_id) {
              <div class="cll-line" [class.cll-line--sel]="sel()?.line_id === l.line_id">
                <div class="cll-line-id">
                  <strong>{{ l.product_name || '—' }}</strong>
                  <span class="cll-sub surf-mono">{{ l.sku || 'sin SKU' }}</span>
                </div>

                <div class="cll-line-nums">
                  <span><em>Recibido</em>{{ l.received_qty }}</span>
                  <span><em>Fechado</em>{{ l.declared_qty }}</span>
                  @if (l.held_qty > 0) {
                    <span class="cll-held"><em>Retenido</em>{{ l.held_qty }}</span>
                  }
                  <span class="cll-falta"><em>Falta</em>{{ l.pending_qty }} {{ unidadDe(l) }}</span>
                </div>

                @if (canCapture()) {
                  <!-- Sin lector a mano (o sin código legible en la caja) se elige de la
                       lista: carga el producto en la barra de arriba, no captura acá. -->
                  <button pButton [text]="true" size="small" severity="secondary" (click)="elegir(l)">
                    <span class="p-button-icon p-button-icon-left pi pi-arrow-up" aria-hidden="true"></span> Fechar este
                  </button>
                }
              </div>
            }
          </div>
        </section>
      } @empty {
        @if (!loading()) {
          <div class="comm-empty">
            <div class="comm-empty-icon"><i class="pi pi-check-circle" aria-hidden="true"></i></div>
            <h3>La fila está vacía</h3>
            <p>Toda la mercancía aprobada en recepción ya tiene su caducidad declarada.</p>
          </div>
        }
      }

      <!-- Fuera de la fila: ya tienen fecha, lo que falta es que alguien los libere.
           Se listan para perseguirlos, no para volver a fecharlos. -->
      @if (retenidos().length) {
        <section class="cll-hold">
          <header class="cll-hold-head">
            <i class="pi pi-lock" aria-hidden="true"></i>
            <strong>{{ retenidos().length }} producto(s) esperando autorización</strong>
            <span class="surf-muted">
              Ya tienen fecha y salieron de la fila, pero no entran a FEFO hasta que un supervisor los libere.
            </span>
          </header>
          @for (l of retenidos(); track l.line_id) {
            <div class="cll-hold-row">
              <span class="cll-hold-prod">{{ l.product_name || l.sku || '—' }}</span>
              <span class="surf-muted surf-mono">{{ l.vale_folio }}</span>
              <span class="surf-muted">{{ l.warehouse_code || l.warehouse_name || '—' }}</span>
              <span class="cll-held"><strong>{{ l.held_qty }}</strong> {{ unidadDe(l) }} retenidas</span>
              <p-tag [value]="l.dias_esperando + ' d'" [severity]="esperaSeverity(l.dias_esperando)"></p-tag>
            </div>
          }
        </section>
      }

      @if (loading()) { <p class="cll-loading">Cargando…</p> }
    </div>
  `,
  styles: [`
    .cll-head-actions { display:flex; align-items:center; gap:.5rem; }
    .cll-wh { min-width:14rem; }
    .cll-summary {
      display:flex; align-items:center; gap:.5rem; flex-wrap:wrap;
      font-size:.8125rem; color:var(--surf-text-muted, #6b7280);
      padding:.5rem .75rem; margin-bottom:.5rem;
      background:var(--surf-panel, #fafaf9); border:1px solid var(--surf-border, #e7e5e4); border-radius:.5rem;
    }
    .cll-dot { opacity:.5; }
    .cll-sub { display:block; font-size:.6875rem; color:var(--surf-text-muted, #6b7280); }

    .cll-prog { display:flex; align-items:center; gap:.5rem; }
    .cll-prog-bar {
      flex:1; height:.375rem; border-radius:999px; overflow:hidden;
      background:var(--surf-border, #e7e5e4);
    }
    .cll-prog-bar > span { display:block; height:100%; background:var(--action, #ea580c); border-radius:999px; }
    .cll-prog-txt { font-size:.6875rem; font-variant-numeric:tabular-nums; color:var(--surf-text-muted, #6b7280); }

    .cll-grp { margin-bottom:1rem; border:1px solid var(--surf-border, #e7e5e4); border-radius:.625rem;
      background:var(--surf-panel, #fafaf9); overflow:hidden; }
    .cll-grp-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;
      padding:.5rem .75rem; border-bottom:1px solid var(--surf-border, #e7e5e4); font-size:.8125rem; }
    .cll-grp-id { display:flex; align-items:baseline; gap:.375rem; flex-wrap:wrap; min-width:0; }
    .cll-grp-meta { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
    .cll-grp-n { font-size:.75rem; font-weight:600; color:var(--surf-text-muted, #6b7280); }
    .cll-grp-meta .cll-prog { width:9rem; }
    .cll-det { padding:.625rem .75rem; display:flex; flex-direction:column; gap:.5rem; }
    .cll-loading { font-size:.8125rem; color:var(--surf-text-muted, #6b7280); }

    .cll-line {
      display:flex; flex-wrap:wrap; align-items:flex-end; gap:.75rem 1rem;
      padding:.625rem .75rem;
      background:var(--surf-bg, #fff); border:1px solid var(--surf-border, #e7e5e4); border-radius:.5rem;
    }
    .cll-line-id { min-width:14rem; flex:1 1 14rem; font-size:.8125rem; }
    .cll-line-nums { display:flex; gap:1rem; font-size:.8125rem; font-variant-numeric:tabular-nums; }
    .cll-line-nums em { display:block; font-style:normal; font-size:.625rem; text-transform:uppercase;
      letter-spacing:.04em; color:var(--surf-text-muted, #6b7280); }
    .cll-line-nums .cll-falta { font-weight:700; }
    .cll-line-nums .cll-held { color:#dc2626; font-weight:600; }

    /* Barra de captura: el código manda y por eso es el campo ancho; la 6ª columna
       vacía evita que el botón se estire a todo lo que sobra. */
    .cll-scan { padding:.75rem 1rem; margin-bottom:1rem;
      background:var(--surf-bg, #fff); border:1px solid var(--surf-border, #e7e5e4); border-radius:.625rem; }
    .cll-scan-grid { display:grid; grid-template-columns: minmax(12rem, 22rem) 7.5rem 10rem 10rem max-content 1fr;
      gap:.5rem .75rem; align-items:end; }
    .cll-f { display:flex; flex-direction:column; gap:.25rem; min-width:0; }
    .cll-f > span { font-size:.75rem; font-weight:600; color:var(--surf-text-muted, #6b7280); }
    .cll-f > span em { font-style:normal; font-weight:400; }
    .cll-f input { width:100%; }
    .cll-code { font-size:1.05rem; }
    .cll-scan-grid > button { justify-self:start; }
    .cll-scan-err { display:flex; align-items:center; gap:.375rem; margin:.625rem 0 0;
      font-size:.8125rem; font-weight:600; color:#dc2626; }
    .cll-scan-hit { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; margin-top:.625rem;
      font-size:.8125rem; color:#16a34a; }
    .cll-scan-hit strong { color:var(--surf-text, #1c1917); }
    .cll-scan-falta { font-weight:700; color:var(--surf-text, #1c1917); }
    .cll-line--sel { outline:2px solid var(--action, #ea580c); outline-offset:1px; }
    .cll-hold { margin-top:1.25rem; border:1px solid var(--surf-border, #e7e5e4); border-radius:.625rem;
      background:var(--surf-panel, #fafaf9); overflow:hidden; }
    .cll-hold-head { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; padding:.5rem .75rem;
      border-bottom:1px solid var(--surf-border, #e7e5e4); font-size:.8125rem; color:#dc2626; }
    .cll-hold-head .surf-muted { font-weight:400; }
    .cll-hold-row { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap;
      padding:.5rem .75rem; font-size:.8125rem; border-top:1px solid var(--surf-border, #e7e5e4); }
    .cll-hold-row:first-of-type { border-top:0; }
    .cll-hold-prod { font-weight:600; min-width:12rem; }

    .cll-plazo { flex-basis:100%; display:flex; align-items:center; gap:.375rem; margin:0; font-size:.75rem; font-weight:600; }
    .cll-plazo--bueno { color:#16a34a; }
    .cll-plazo--intermedio { color:#d97706; }
    .cll-plazo--malo { color:#dc2626; }
  `],
})
export class AlmacenCaducidadesPorFecharComponent implements OnInit {
  private readonly api = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly comercial = inject(ComercialService);
  private readonly perms = inject(PermissionsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);


  readonly rows = signal<PendingExpiryLine[]>([]);
  readonly loading = signal(false);
  readonly guardando = signal<string | null>(null);
  readonly warehouses = signal<Warehouse[]>([]);

  warehouseFilter: string | null = null;

  /** Renglón que el código resolvió; null = todavía no hay producto elegido. */
  readonly sel = signal<PendingExpiryLine | null>(null);
  readonly scanError = signal<string | null>(null);

  code = '';
  cantidad = 1;
  vence = '';
  lote = '';

  @ViewChild('codeInput') codeInput?: ElementRef<HTMLInputElement>;
  @ViewChild('qtyInput') qtyInput?: ElementRef<HTMLInputElement>;
  @ViewChild('venceInput') venceInput?: ElementRef<HTMLInputElement>;

  readonly warehouseOptions = computed(() => [
    { label: 'Todos los almacenes', value: null },
    ...this.warehouses().map((w) => ({ label: `${w.code} — ${w.name}`, value: w.id })),
  ]);

  /**
   * La FILA DE ESPERA: sólo lo que todavía necesita fecha.
   *
   * Al fechar algo el renglón sale de acá inmediatamente, que es lo que uno espera
   * de una fila. Lo que quedó retenido por el auditor NO vuelve a la fila —ya tiene
   * su fecha, el pendiente es que un supervisor lo autorice— y se muestra aparte:
   * dejarlo mezclado hacía que fechar no descontara nada y la fila nunca vaciara.
   *
   * El backend devuelve los totales del vale completo, así que el avance se mide
   * contra todo lo recibido y no contra lo que queda (que se encoge al trabajar).
   */
  readonly arrivals = computed<Arrival[]>(() => {
    const porVale = new Map<string, Arrival>();
    for (const l of this.rows()) {
      if (Number(l.pending_qty) <= 0) continue;
      let a = porVale.get(l.session_id);
      if (!a) {
        const recibido = Number(l.session_received_qty) || 0;
        const fechado = Number(l.session_declared_qty) || 0;
        a = {
          session_id: l.session_id,
          vale_folio: l.vale_folio,
          source_ref: l.source_ref,
          supplier_code: l.supplier_code,
          supplier_name: l.supplier_name,
          warehouse_id: l.warehouse_id,
          warehouse_code: l.warehouse_code,
          warehouse_name: l.warehouse_name,
          closed_at: l.closed_at,
          dias_esperando: Number(l.dias_esperando) || 0,
          lines: [],
          falta: 0,
          retenido: 0,
          recibido,
          fechado,
          avance: recibido > 0 ? Math.min(100, Math.round((fechado / recibido) * 100)) : 0,
        };
        porVale.set(l.session_id, a);
      }
      a.lines.push(l);
      a.falta += Number(l.pending_qty) || 0;
      a.retenido += Number(l.held_qty) || 0;
    }
    // Lo más viejo primero; a igual espera, primero lo que más falta por fechar.
    return [...porVale.values()].sort((x, y) => y.dias_esperando - x.dias_esperando || y.falta - x.falta);
  });

  /**
   * Fechados pero detenidos por el auditor. Salieron de la fila (ya tienen fecha)
   * pero siguen siendo trabajo abierto: sin autorización no entran a FEFO. Se listan
   * aparte para que se persigan, no para volver a fecharlos.
   */
  readonly retenidos = computed<PendingExpiryLine[]>(() =>
    this.rows()
      .filter((l) => Number(l.held_qty) > 0)
      .sort((x, y) => Number(y.dias_esperando) - Number(x.dias_esperando)),
  );

  /** Productos en la fila (no llegadas): es lo que la persona ve por delante. */
  readonly enFila = computed(() => this.arrivals().reduce((a, r) => a + r.lines.length, 0));

  readonly totalPendiente = computed(() => this.arrivals().reduce((a, r) => a + r.falta, 0));
  readonly totalRetenido = computed(() => this.retenidos().reduce((a, r) => a + Number(r.held_qty), 0));
  readonly masViejo = computed(() => this.arrivals().reduce((a, r) => Math.max(a, r.dias_esperando), 0));

  // Mismo criterio que la hoja de anaquel: manage-all o el permiso puntual del JWT.
  private readonly puedeCapturar =
    this.perms.isAdmin() || !!this.auth.user()?.permissions?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR];
  canCapture = () => this.puedeCapturar;

  /** Unidad en la que se cuenta este renglón (la del vale). */
  unidadDe(l: PendingExpiryLine): string {
    const u = (l.expected_unit || '').trim();
    if (!u || u === 'ambigua') return 'unidades';
    return u.toLowerCase();
  }

  /**
   * Resuelve lo escaneado contra lo que está esperando fecha — y sólo contra eso.
   *
   * Buscar en el catálogo completo permitiría fechar mercancía que nunca pasó por
   * recepción, que es justo el camino que este flujo no debe abrir. Si el código no
   * está en la bandeja, se avisa y no se selecciona nada.
   */
  resolverCodigo(): void {
    const c = this.code.trim().toLowerCase();
    this.scanError.set(null);
    if (!c) return;
    const pendientes = this.rows().filter((r) => Number(r.pending_qty) > 0);
    const hits = pendientes.filter(
      (r) => String(r.sku || '').trim().toLowerCase() === c || String(r.barcode || '').trim().toLowerCase() === c,
    );
    if (!hits.length) {
      this.sel.set(null);
      this.scanError.set(`'${this.code.trim()}' no está esperando fecha. Sólo se puede fechar mercancía que ya se recibió.`);
      return;
    }
    // El mismo producto puede venir en dos entradas distintas: primero la más vieja,
    // que es la que urge y la que el FEFO va a sacar antes.
    const hit = hits.sort((a, b) => Number(b.dias_esperando) - Number(a.dias_esperando))[0];
    this.elegir(hit);
  }

  /** Carga un renglón en la barra de captura y salta a la cantidad. */
  elegir(l: PendingExpiryLine): void {
    this.sel.set(l);
    this.scanError.set(null);
    this.code = l.sku || l.barcode || this.code;
    this.cantidad = Number(l.pending_qty) || 1;
    this.vence = '';
    this.lote = '';
    setTimeout(() => { this.qtyInput?.nativeElement.focus(); this.qtyInput?.nativeElement.select(); });
  }

  limpiar(): void {
    this.sel.set(null);
    this.scanError.set(null);
    this.code = '';
    this.cantidad = 1;
    this.vence = '';
    this.lote = '';
    setTimeout(() => this.codeInput?.nativeElement.focus());
  }

  focusVence(): void {
    this.venceInput?.nativeElement.focus();
  }

  /**
   * Días de vida que le quedan al producto contados desde hoy.
   *
   * Se compara texto `YYYY-MM-DD` convertido a UTC a mediodía, no `new Date()` del
   * input: construir la fecha en zona local corre el día a la anterior según la hora
   * y el resultado saldría desfasado por uno.
   */
  // Método, no `computed`: `vence` lo escribe `[(ngModel)]` sobre un campo plano, no
  // una señal, así que un computed nunca se invalidaría y el semáforo no aparecería.
  plazo(): number | null {
    const v = (this.vence || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const hoy = new Date();
    const hoyUtc = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 12);
    const [y, m, d] = v.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d, 12) - hoyUtc) / 86400000);
  }

  clasificacion(): 'bueno' | 'intermedio' | 'malo' {
    const p = this.plazo();
    if (p === null) return 'bueno';
    if (p < PLAZO_RIESGOSO_DIAS) return 'malo';
    if (p < PLAZO_INTERMEDIO_DIAS) return 'intermedio';
    return 'bueno';
  }

  etiquetaPlazo(): string {
    switch (this.clasificacion()) {
      case 'malo': return 'plazo corto — sacarlo pronto';
      case 'intermedio': return 'plazo intermedio — vigilar';
      default: return 'buen plazo';
    }
  }

  /** La espera se pinta como riesgo: a más días sin fecha, peor. */
  esperaSeverity(dias: number): 'success' | 'warn' | 'danger' {
    if (dias >= 7) return 'danger';
    if (dias >= 2) return 'warn';
    return 'success';
  }

  /** El lote es opcional (el backend lo deja en 'NA'); la fecha y la cantidad no. */
  puedeGuardar(): boolean {
    const s = this.sel();
    return !!s && this.plazo() !== null && this.cantidad > 0 && this.cantidad <= Number(s.pending_qty);
  }

  ngOnInit(): void {
    this.comercial.listWarehouses(true).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (w: Warehouse[]) => this.warehouses.set(w || []),
      error: () => this.warehouses.set([]),
    });
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api
      .pendingExpiry({ warehouse_id: this.warehouseFilter || undefined, limit: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r: PendingExpiryLine[]) => {
          this.rows.set(r || []);
          this.loading.set(false);
          // Si el renglón seleccionado sigue pendiente, se refresca con su nuevo faltante
          // (una tarima con varios lotes se declara de a uno y queda saldo).
          const sel = this.sel();
          if (sel) {
            const vivo = (r || []).find((x) => x.line_id === sel.line_id && Number(x.pending_qty) > 0);
            this.sel.set(vivo || null);
            if (vivo) this.cantidad = Number(vivo.pending_qty) || 1;
          }
        },
        error: (e: any) => {
          this.loading.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo cargar', detail: e?.error?.message || 'Error' });
        },
      });
  }

  guardar(): void {
    const l = this.sel();
    if (!l || !this.puedeGuardar() || this.guardando()) return;
    const lote = this.lote.trim();
    const cantidad = this.cantidad;
    const unidad = this.unidadDe(l);
    this.guardando.set(l.line_id);
    this.auditor
      .evaluate({
        warehouse_id: l.warehouse_id,
        product_id: l.product_id,
        receiving_line_id: l.line_id,
        source_ref: l.source_ref || undefined,
        supplier_code: l.supplier_code || undefined,
        quantity: cantidad,
        confirmed_lot: lote || undefined,
        confirmed_expiry: this.vence.slice(0, 10),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cap: { verdict?: string; rule_broken?: string | null }) => {
          this.guardando.set(null);
          // El veredicto del auditor se comunica tal cual: rojo NO entra a FEFO
          // hasta que un supervisor lo libere, y eso el bodeguero tiene que saberlo.
          const rojo = cap.verdict === 'red';
          this.toast.add({
            severity: rojo ? 'warn' : 'success',
            summary: rojo ? 'Queda pendiente de autorización' : 'Caducidad declarada',
            detail: rojo
              ? `${cantidad} ${unidad} marcadas ${cap.rule_broken || 'fuera de política'} — un supervisor debe autorizarlas`
              : `${cantidad} ${unidad}${lote ? ' · lote ' + lote : ''}`,
          });
          // Listo para el siguiente producto: el flujo es escanear, contar, fechar,
          // escanear el que sigue. Volver a mano al primer campo lo rompería.
          this.limpiar();
          this.load();
        },
        error: (e: any) => {
          this.guardando.set(null);
          this.toast.add({ severity: 'error', summary: 'No se pudo guardar', detail: e?.error?.message || 'Error' });
        },
      });
  }
}
