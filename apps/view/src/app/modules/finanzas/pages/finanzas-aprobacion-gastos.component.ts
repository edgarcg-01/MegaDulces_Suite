import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { environment } from '../../../../environments/environment';
import { ComprobacionesService } from '../comprobaciones.service';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';

interface Grupo {
  clave: string;
  etiqueta: string;
  origen?: 'capturado' | 'solicitud' | 'sin_clasificar';
  n: number;
  monto: number;
  ids: string[];
}

interface Pendiente {
  id: string;
  folio_solicitud: string;
  sucursal: string | null;
  fecha_gasto: string | null;
  created_at: string;
  importe: number;
  departamento: string | null;
  solicitante: string | null;
  concepto: string | null;
  proveedor: string | null;
  clasificacion: string | null;
  forma_pago: string | null;
  forma_pago_detalle: string | null;
  comentarios: string | null;
  created_by: string | null;
  evidencia_en_vivo: boolean;
  files: { role: string; url: string }[];
}

interface PorAprobar {
  total: number;
  monto_total: number;
  por_fecha: Grupo[];
  por_departamento: Grupo[];
  filas: Pendiente[];
}

const FORMA_PAGO_LABEL: Record<string, string> = {
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia',
  cheque: 'Cheque', vales: 'Vales', otro: 'Otro',
};

/**
 * `[GX.17]` — **Aprobación de gastos.** Donde se da la luz verde.
 *
 * La otra mitad de la partición: `/finanzas/gastos` es para quien captura (todos),
 * y ésta para quien **autoriza** — hoy cuatro personas.
 *
 * Agrupa lo pendiente por **fecha** y por **departamento** porque quien firma no revisa
 * renglones sueltos: revisa «lo del martes de Logística». La agrupación la hace el
 * servidor (`agruparParaAprobacion`, función pura con sus pruebas), no esta pantalla.
 *
 * ## ⚠️ El departamento no siempre es un departamento
 * Cuando quien capturó no puso uno, el expediente guarda `Sucursal NN` —que es una plaza—
 * y el respaldo es el área de la solicitud de Kepler. Cada grupo dice **de dónde salió su
 * etiqueta**; juntarlas sin decirlo haría que «Sucursal 00» y «LOGISTICA» convivan como si
 * fueran lo mismo.
 *
 * ## ⛔ Aprobar es de a uno
 * No hay «aprobar el grupo entero». Agrupar es para **leer**, no para firmar en bloque: un
 * botón que autoriza 40 gastos de un clic convierte la revisión en un trámite. El grupo
 * filtra la lista; la firma sigue siendo por expediente.
 */
@Component({
  selector: 'app-finanzas-aprobacion-gastos',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TagModule, InputTextModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in ap">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Aprobación de gastos</h1>
          <p class="surf-page-sub">Lo que espera luz verde, junto. Agrupado por fecha y por departamento.</p>
        </div>
        <button pButton type="button" class="p-button-text" (click)="cargar()" [loading]="cargando()">
          <i class="pi pi-refresh" aria-hidden="true"></i>&nbsp;Actualizar
        </button>
      </header>

      @if (cargando()) { <div class="ap-muted">Cargando…</div> }
      @else if (error()) { <div class="ap-err">{{ error() }}</div> }
      @else if (datos(); as d) {
        @if (!d.total) {
          <div class="ap-vacio">
            <i class="pi pi-check-circle" aria-hidden="true"></i>
            <div><strong>No hay nada esperando tu visto bueno.</strong>
              <div class="ap-muted">Cuando alguien capture un gasto con su forma de pago y su foto, aparece acá.</div>
            </div>
          </div>
        } @else {
          <div class="ap-kpis">
            <div class="ap-kpi"><span class="ap-k">Esperando</span><b>{{ d.total }}</b></div>
            <div class="ap-kpi"><span class="ap-k">Monto</span><b>{{ money(d.monto_total) }}</b></div>
            <div class="ap-kpi"><span class="ap-k">Días</span><b>{{ d.por_fecha.length }}</b></div>
            <div class="ap-kpi"><span class="ap-k">Departamentos</span><b>{{ d.por_departamento.length }}</b></div>
          </div>

          <div class="ap-cols">
            <aside class="ap-grupos">
              <div class="ap-seg">
                <button type="button" [class.on]="dim() === 'fecha'" (click)="dim.set('fecha')">Por fecha</button>
                <button type="button" [class.on]="dim() === 'depto'" (click)="dim.set('depto')">Por departamento</button>
              </div>
              <button type="button" class="ap-grupo" [class.on]="!grupo()" (click)="grupo.set(null)">
                <span class="ap-g-t">Todos</span>
                <span class="ap-g-n">{{ d.total }}</span>
              </button>
              @for (g of grupos(); track g.clave) {
                <button type="button" class="ap-grupo" [class.on]="grupo() === g.clave" (click)="grupo.set(g.clave)">
                  <span class="ap-g-t">
                    {{ dim() === 'fecha' ? (g.clave | date: 'EEE d MMM') : g.etiqueta }}
                    @if (g.origen === 'solicitud') { <em class="ap-org" title="La etiqueta sale del área de la solicitud de Kepler, no de lo capturado">área</em> }
                    @if (g.origen === 'sin_clasificar') { <em class="ap-org warn">sin clasificar</em> }
                  </span>
                  <span class="ap-g-m">{{ money(g.monto) }}</span>
                  <span class="ap-g-n">{{ g.n }}</span>
                </button>
              }
            </aside>

            <section class="ap-lista">
              @for (p of visibles(); track p.id) {
                <article class="ap-item">
                  <div class="ap-it-head">
                    <span class="ap-folio">{{ p.folio_solicitud }}</span>
                    <span class="ap-suc">suc {{ p.sucursal }}</span>
                    <span class="ap-grow"></span>
                    <span class="ap-imp">{{ money(p.importe) }}</span>
                  </div>
                  <div class="ap-it-con">{{ p.concepto || p.proveedor || '—' }}</div>
                  <div class="ap-it-meta">
                    <span>{{ p.departamento || p.solicitante || 'sin departamento' }}</span>
                    <span>·</span>
                    <span>{{ p.fecha_gasto ? (p.fecha_gasto | date: 'dd/MM/yy') : (p.created_at | date: 'dd/MM/yy') }}</span>
                    <span>·</span>
                    <span>{{ p.created_by || '—' }}</span>
                  </div>
                  <div class="ap-it-chips">
                    @if (p.forma_pago) {
                      <span class="ap-chip ok">{{ formaPago(p.forma_pago) }}@if (p.forma_pago_detalle) { · {{ p.forma_pago_detalle }} }</span>
                    } @else {
                      <span class="ap-chip bad">sin forma de pago</span>
                    }
                    @if (p.evidencia_en_vivo) {
                      <span class="ap-chip ok">foto en vivo</span>
                    } @else {
                      <span class="ap-chip warn">foto sin sello de cámara</span>
                    }
                    @if (p.clasificacion) { <span class="ap-chip">{{ p.clasificacion }}</span> }
                  </div>
                  @if (p.comentarios) { <div class="ap-it-nota">“{{ p.comentarios }}”</div> }

                  <div class="ap-it-act">
                    @if (p.files.length) {
                      <a class="ap-ver" [href]="p.files[0].url" target="_blank" rel="noopener">Ver comprobante</a>
                    } @else {
                      <span class="ap-chip bad">sin archivos</span>
                    }
                    <span class="ap-grow"></span>
                    <button pButton type="button" class="p-button-text p-button-sm" [disabled]="actuando() === p.id"
                            (click)="rechazar(p)">Rechazar</button>
                    <button pButton type="button" class="p-button-sm" [loading]="actuando() === p.id"
                            (click)="aprobar(p)">Aprobar</button>
                  </div>
                </article>
              }
              @if (!visibles().length) { <div class="ap-muted">Ese grupo ya no tiene pendientes.</div> }
            </section>
          </div>
        }
      }
    </div>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    .ap { display: flex; flex-direction: column; gap: var(--sp-3); }
    .ap-muted { font-size: var(--fs-sm); color: var(--fg-2); padding: var(--sp-3); }
    .ap-err { font-size: var(--fs-sm); color: var(--bad-fg); padding: var(--sp-3);
      border: 1px solid var(--bad-border); border-radius: var(--r-md); }
    .ap-vacio { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-5);
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .ap-vacio .pi { color: var(--ok-fg); font-size: 1.4rem; }

    .ap-kpis { display: flex; background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3) 0; }
    .ap-kpi { flex: 1; padding: 0 var(--sp-4); border-left: 1px solid var(--c-divider); }
    .ap-kpi:first-child { border-left: 0; }
    .ap-k { display: block; font-size: var(--fs-micro); text-transform: uppercase;
      letter-spacing: .05em; color: var(--fg-3); }
    .ap-kpi b { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-h2); }

    .ap-cols { display: flex; gap: var(--sp-3); align-items: flex-start; }
    .ap-grupos { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px;
      background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md);
      padding: var(--sp-2); position: sticky; top: var(--sp-3); }
    .ap-seg { display: flex; gap: 2px; margin-bottom: var(--sp-2); }
    .ap-seg button { flex: 1; height: 28px; border: 0; border-radius: var(--r-sm); background: transparent;
      color: var(--fg-2); font: inherit; font-size: var(--fs-xs); cursor: pointer; }
    .ap-seg button.on { background: var(--fg-1); color: var(--card-bg); font-weight: var(--fw-bold); }
    .ap-grupo { display: flex; align-items: center; gap: var(--sp-2); width: 100%; border: 0;
      background: transparent; border-radius: var(--r-sm); padding: 6px 8px; font: inherit;
      font-size: var(--fs-sm); color: var(--fg-1); cursor: pointer; text-align: left; }
    .ap-grupo:hover { background: var(--hover-bg); }
    .ap-grupo.on { background: rgba(var(--ink-rgb), .06); box-shadow: inset 2px 0 0 var(--action); }
    .ap-g-t { flex-grow: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ap-g-m { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .ap-g-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2);
      background: var(--layout-bg); border-radius: var(--r-sm); padding: 0 6px; }
    .ap-org { font-size: var(--fs-nano); font-style: normal; color: var(--fg-3);
      border: 1px solid var(--border-color); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
    .ap-org.warn { color: var(--warn-fg); border-color: var(--warn-border); }

    .ap-lista { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .ap-item { background: var(--card-bg); border: 1px solid var(--border-color);
      border-radius: var(--r-md); padding: var(--sp-3); display: flex; flex-direction: column; gap: 4px; }
    .ap-it-head { display: flex; align-items: baseline; gap: var(--sp-2); }
    .ap-folio { font-family: var(--font-mono); font-weight: var(--fw-bold); }
    .ap-suc { font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-grow { flex-grow: 1; }
    .ap-imp { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
      font-size: var(--fs-lg); font-weight: var(--fw-bold); }
    .ap-it-con { font-size: var(--fs-sm); color: var(--fg-1); }
    .ap-it-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .ap-it-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
    .ap-chip { font-size: var(--fs-nano); border: 1px solid var(--border-color); color: var(--fg-2);
      border-radius: var(--r-sm); padding: 1px 7px; }
    .ap-chip.ok { color: var(--ok-fg); border-color: var(--ok-border); }
    .ap-chip.warn { color: var(--warn-fg); border-color: var(--warn-border); }
    .ap-chip.bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .ap-it-nota { font-size: var(--fs-xs); color: var(--fg-2); font-style: italic; }
    .ap-it-act { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-2);
      padding-top: var(--sp-2); border-top: 1px solid var(--c-divider); }
    .ap-ver { font-size: var(--fs-xs); }

    @media (max-width: 60rem) {
      .ap-cols { flex-direction: column; }
      .ap-grupos { width: 100%; position: static; }
    }
  `],
})
export class FinanzasAprobacionGastosComponent {
  private readonly http = inject(HttpClient);
  private readonly svc = inject(ComprobacionesService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly datos = signal<PorAprobar | null>(null);
  readonly cargando = signal(true);
  readonly error = signal('');
  readonly dim = signal<'fecha' | 'depto'>('fecha');
  readonly grupo = signal<string | null>(null);
  readonly actuando = signal<string | null>(null);

  constructor() { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.http.get<PorAprobar>(`${environment.apiUrl}/finance/expenses/proofs/por-aprobar`,
      { params: new HttpParams().set('limit', '500') })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (d) => { this.datos.set(d); this.grupo.set(null); this.cargando.set(false); },
        // Un error NO se pinta como «no hay nada que aprobar»: eso es otra afirmación, y
        // la equivocada deja dinero esperando sin que nadie lo sepa.
        error: () => { this.error.set('No se pudo cargar lo pendiente. Reintentá.'); this.cargando.set(false); },
      });
  }

  readonly grupos = computed<Grupo[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return this.dim() === 'fecha' ? d.por_fecha : d.por_departamento;
  });

  readonly visibles = computed<Pendiente[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const g = this.grupo();
    if (!g) return d.filas;
    const sel = this.grupos().find((x) => x.clave === g);
    if (!sel) return d.filas;
    const ids = new Set(sel.ids);
    return d.filas.filter((f) => ids.has(f.id));
  });

  money(v: number | null | undefined): string {
    return (Number(v ?? 0) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  }

  formaPago(id: string): string { return FORMA_PAGO_LABEL[id] ?? id; }

  aprobar(p: Pendiente): void {
    this.actuando.set(p.id);
    this.svc.approve(p.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.toast.add({ severity: 'success', summary: 'Aprobado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar();
      },
      error: (e) => {
        this.actuando.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo aprobar', detail: e?.error?.message || 'Reintentá' });
      },
    });
  }

  /**
   * Rechazar **exige motivo**. Sin él, quien capturó recibe un «no» sin saber qué corregir
   * y vuelve a subir lo mismo — que es como se hace eterna una bandeja.
   */
  rechazar(p: Pendiente): void {
    const motivo = (globalThis.prompt?.(`¿Por qué se rechaza la solicitud ${p.folio_solicitud}?`) ?? '').trim();
    if (!motivo) return;
    this.actuando.set(p.id);
    this.svc.reject(p.id, motivo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.actuando.set(null);
        this.toast.add({ severity: 'info', summary: 'Rechazado', detail: `Solicitud ${p.folio_solicitud}` });
        this.cargar();
      },
      error: (e) => {
        this.actuando.set(null);
        this.toast.add({ severity: 'error', summary: 'No se pudo rechazar', detail: e?.error?.message || 'Reintentá' });
      },
    });
  }
}
