import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { folioVale, validarNuevoVale, type ValeResumen } from '@megadulces/contracts';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { ValesService } from '../vales.service';
import { diasDesde, etiquetaEstadoVale, severidadEstadoVale } from '../vales-formato';

const ETIQUETA_SCOPE: Record<string, string> = { mine: 'Míos', queue: 'Cola', all: 'Todos' };

/**
 * `[MDT.3.4]` Vales de servicio — ¿qué vales me tocan ahora?
 *
 * Una sola lista; el alcance (míos, cola, todos) lo decide el servidor según la llave. Lo vivo primero (en
 * proceso, abiertos) y el folio más nuevo arriba. Se busca en el SERVIDOR (folio sin ceros, área, lo que se
 * necesita, quién lo pidió): la lista se topa en 200 y lo dice, así que buscar sólo en lo cargado mentiría.
 */
@Component({
  selector: 'app-vales-lista',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, DialogModule, InputTextModule, TableModule, TagModule, TextareaModule, ToastModule,
    LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  providers: [MessageService],
  template: `
    <div class="surf-page vl-page">
      <p-toast position="top-center"></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Vales de servicio</h1>
          <p class="surf-page-sub">La constancia de cada servicio: quién lo pidió, quién lo atiende, qué se hizo. Continúa el folio del talonario.</p>
        </div>
        <div class="vl-acciones">
          <app-freshness-pill measures="fetch" [since]="cargado()" label="Actualizado" [staleAfterSec]="300" />
          <app-context-help topic="vales-servicio" />
          <button pButton type="button" class="vl-levantar" (click)="abrirAlta()">
            <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
            <span class="p-button-label">Levantar vale</span>
          </button>
        </div>
      </header>

      @if (datos()) { <app-metric-strip [items]="kpis()" ariaLabel="Vales de este alcance" /> }

      <div class="vl-filtros">
        @if (scopes().length > 1) {
          <app-segmented [options]="scopes()" [value]="scope()" (valueChange)="cambiarScope($event)" ariaLabel="Qué vales ver" />
        }
        <input pInputText type="search" enterkeyhint="search" class="vl-buscar" [value]="texto()" (input)="escribir($any($event.target).value)"
               placeholder="Folio, área, lo que se necesita o quién lo pidió" aria-label="Buscar vales" />
      </div>

      <app-load-state [loading]="res.isLoading() && !datos()" [error]="error()" [isEmpty]="!!datos() && !vales().length"
                      emptyIcon="pi-file-edit" [emptyTitle]="q() ? 'Ningún vale coincide' : vacio()"
                      [emptyHint]="q() ? null : 'Un vale se levanta con «Levantar vale»: área, lugar y lo que se necesita.'"
                      (retry)="res.reload()">
        @if (datos()?.has_more) {
          <p class="vl-tope" role="status">Mostrando {{ vales().length }} de {{ datos()!.total }}: busca por folio o por área para llegar a los demás.</p>
        }
        <p-table [value]="vales()" dataKey="id" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack"
                 [rowHover]="true" selectionMode="single" (onRowSelect)="abrir($event.data)">
          <ng-template #header>
            <tr>
              <th scope="col">Folio</th>
              <th scope="col">Qué se necesita</th>
              <th scope="col">Estado</th>
              <th scope="col">Lo atiende</th>
              <th scope="col" class="comm-num">Firmas</th>
            </tr>
          </ng-template>
          <ng-template #body let-v>
            <tr [pSelectableRow]="v" tabindex="0" (keydown.enter)="abrir(v)">
              <td data-label="Folio" class="vl-folio">{{ folio(v.folio) }}<span class="vl-sub">{{ antiguedad(v) }}</span></td>
              <td data-label="Qué se necesita"><span class="vl-act">{{ v.activity }}</span><span class="vl-sub">{{ v.requesting_area }} · pidió {{ v.requester_name }}</span></td>
              <td data-label="Estado"><p-tag [value]="etiquetaEstadoVale(v.status)" [severity]="severidadEstadoVale(v.status)" /></td>
              <td data-label="Lo atiende">{{ v.assignee_name || 'Nadie todavía' }}</td>
              <td data-label="Firmas" class="comm-num">{{ v.firmas }} de 3</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p-dialog [visible]="alta()" (visibleChange)="!$event && cerrarAlta()" [modal]="true" header="Levantar vale de servicio"
                [style]="{ width: 'min(36rem, 96vw)' }" [draggable]="false">
        <div class="vl-form">
          <label class="vl-campo" for="vl-area"><span class="vl-rotulo">Área que lo pide</span>
            <input pInputText id="vl-area" maxlength="120" [value]="nArea()" (input)="nArea.set($any($event.target).value)" placeholder="Ej. Sucursal Centro, Almacén, Oficinas" />
          </label>
          <label class="vl-campo" for="vl-lugar"><span class="vl-rotulo">Lugar (opcional)</span>
            <input pInputText id="vl-lugar" maxlength="200" [value]="nLugar()" (input)="nLugar.set($any($event.target).value)" placeholder="Ej. Baño de personal, Caja 2" />
          </label>
          <label class="vl-campo" for="vl-act"><span class="vl-rotulo">Qué se necesita</span>
            <textarea pTextarea id="vl-act" rows="3" maxlength="300" [value]="nAct()" (input)="nAct.set($any($event.target).value)"
                      placeholder="Describe el servicio: qué falla o qué hay que hacer"></textarea>
          </label>
          @if (errorAlta(); as e) { <p class="vl-error" role="alert">{{ e }}</p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" (click)="cerrarAlta()" [disabled]="guardando()"><span class="p-button-label">Cancelar</span></button>
          <button pButton type="button" (click)="levantar()" [disabled]="guardando() || !!faltaAlta()">
            <span class="p-button-label">{{ guardando() ? 'Levantando…' : 'Levantar vale' }}</span></button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; }
    .vl-page { display: flex; flex-direction: column; gap: var(--sp-4); }
    .vl-acciones { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
    .vl-levantar { min-height: 44px; }
    .vl-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
    .vl-buscar { flex: 1 1 18rem; max-width: 28rem; }
    .vl-folio { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .vl-act { display: block; font-weight: 600; }
    .vl-sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
    .vl-tope { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .vl-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .vl-campo { display: flex; flex-direction: column; gap: var(--sp-1); }
    .vl-rotulo { font-size: var(--fs-sm); font-weight: 600; }
    .vl-error { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); background: var(--bad-soft-bg); color: var(--bad-soft-fg); border-radius: var(--r-sm); }
    @container (max-width: 40rem) { .vl-buscar { max-width: none; } }
  `],
})
export class ValesListaComponent {
  private readonly svc = inject(ValesService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MessageService);

  readonly etiquetaEstadoVale = etiquetaEstadoVale;
  readonly severidadEstadoVale = severidadEstadoVale;
  readonly folio = folioVale;

  /** `?scope=mine` llega desde Mi trabajo; el servidor lo baja si la persona no tiene ese alcance. */
  private readonly scopeUrl = toSignal(this.route.queryParamMap.pipe(map((p) => p.get('scope'))), { initialValue: null });
  readonly scopeElegido = signal<string | null>(null);
  readonly scope = computed(() => this.datos()?.scope ?? this.scopeElegido() ?? this.scopeUrl() ?? '');
  readonly texto = signal('');
  readonly q = signal('');
  private espera: ReturnType<typeof setTimeout> | null = null;
  readonly cargado = signal<Date | null>(null);

  readonly res = rxResource({
    params: () => ({ scope: this.scopeElegido() ?? this.scopeUrl(), q: this.q() }),
    stream: ({ params }) => this.svc.lista(params.scope, params.q),
  });
  readonly datos = computed(() => (this.res.hasValue() ? this.res.value() : null));
  private readonly alCargar = effect(() => { if (this.datos()) untracked(() => this.cargado.set(new Date())); });
  readonly error = computed(() => {
    const e = this.res.error();
    return e ? (e instanceof HttpErrorResponse ? e.error?.message || e.message : 'No se pudieron cargar los vales') : null;
  });
  readonly vales = computed<ValeResumen[]>(() => this.datos()?.vales ?? []);
  readonly scopes = computed<SegOption[]>(() => (this.datos()?.scopes_permitidos ?? []).map((s) => ({ label: ETIQUETA_SCOPE[s] ?? s, value: s })));
  readonly vacio = computed(() => (this.scope() === 'queue' ? 'No hay vales abiertos sin dueño' : this.scope() === 'mine' ? 'No tienes vales' : 'No hay vales'));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const vs = this.vales();
    const proceso = vs.filter((v) => v.status === 'in_progress').length;
    const abiertos = vs.filter((v) => v.status === 'open').length;
    const total = this.datos()?.total ?? vs.length;
    return [
      { label: 'En proceso', value: proceso, tone: 'default' },
      { label: 'Abiertos sin dueño', value: abiertos, tone: abiertos ? 'warn' : 'default' },
      { label: 'En este alcance', value: total, tone: 'muted', sub: this.datos()?.has_more ? `se muestran ${vs.length}` : undefined },
    ];
  });

  // ── Alta ──
  readonly alta = signal(false);
  readonly nArea = signal('');
  readonly nLugar = signal('');
  readonly nAct = signal('');
  readonly guardando = signal(false);
  readonly errorAlta = signal<string | null>(null);
  readonly faltaAlta = computed(() => validarNuevoVale({ requesting_area: this.nArea(), activity: this.nAct(), location_detail: this.nLugar() }));

  cambiarScope(s: string): void {
    this.scopeElegido.set(s);
  }

  /** Busca en el servidor medio segundo después de dejar de escribir. */
  escribir(t: string): void {
    this.texto.set(t);
    if (this.espera) clearTimeout(this.espera);
    this.espera = setTimeout(() => this.q.set(t.trim()), 400);
  }

  antiguedad(v: ValeResumen): string {
    const d = diasDesde(v.created_at);
    return d === 0 ? 'hoy' : d === 1 ? 'hace 1 día' : `hace ${d} días`;
  }

  abrir(v: ValeResumen | ValeResumen[] | undefined): void {
    if (!v || Array.isArray(v)) return;
    void this.router.navigate(['/vales/ver', v.id]);
  }

  abrirAlta(): void {
    this.nArea.set(''); this.nLugar.set(''); this.nAct.set(''); this.errorAlta.set(null);
    this.alta.set(true);
  }

  cerrarAlta(): void {
    if (this.guardando()) return;
    this.alta.set(false);
  }

  levantar(): void {
    if (this.guardando() || this.faltaAlta()) return;
    this.guardando.set(true); // síncrono en el primer clic: el doble toque no levanta dos vales
    this.errorAlta.set(null);
    this.svc.crear({ requesting_area: this.nArea().trim(), activity: this.nAct().trim(), location_detail: this.nLugar().trim() || null }).subscribe({
      next: (v) => {
        this.guardando.set(false);
        this.alta.set(false);
        this.toast.add({ severity: 'success', summary: `Vale ${folioVale(v.folio)} levantado` });
        void this.router.navigate(['/vales/ver', v.id]);
      },
      error: (err: HttpErrorResponse) => { this.guardando.set(false); this.errorAlta.set(err.error?.message || err.message); },
    });
  }
}
