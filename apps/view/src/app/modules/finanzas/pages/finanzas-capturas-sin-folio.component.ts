import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { AutoCompleteModule } from 'primeng/autocomplete';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { CapturasSinFolioService, CapturaSinFolio, CaptureLink } from '../capturas-sin-folio.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { money } from '../../../shared/util';
import { dmy } from './finanzas-format';

/** Sugerencia del buscador de solicitudes Kepler. */
interface SolSug { folio: string; fecha: string | null; importe: number; beneficiario: string | null; sucursal: string | null; solicitante: string | null; label?: string; }

/**
 * GX.9/GX.10 — «Sin folio»: lo que llegó por link y todavía no se liga a una solicitud de
 * Kepler, más la administración de los links.
 *
 * **Nació como pantalla aparte y ahora es una etapa del embudo de Gastos.** El argumento
 * para separarla era que el tablero se arma desde las filas de Kepler y una captura sin
 * folio no tiene fila allá — cierto, pero eso obliga a que la TABLA sea distinta, no a que
 * la pantalla lo sea. Para quien trabaja es la misma bandeja: mirar gastos pendientes y
 * empujarlos. Así que el tablero muestra este panel cuando la etapa elegida es `sin_folio`.
 *
 * El trabajo del panel es uno solo: **ponerle folio a cada captura**. En cuanto lo tiene,
 * desaparece de acá y sigue el ciclo normal en las demás etapas, donde se aprueba.
 */
@Component({
  selector: 'app-capturas-sin-folio-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ButtonModule, InputTextModule, DialogModule,
    AutoCompleteModule, ToastModule, LoadStateComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- GX.10 — panel EMBEBIDO en el tablero de Gastos, no página propia. El encabezado,
         el periodo y el embudo son del tablero; acá empieza directamente el trabajo. -->
    <div class="cf-panel">
      <p-toast />

      @if (report(); as r) {
        <p class="cf-lead">
          @if (!r.kpis.total) {
            Nada pendiente de ligar. Lo que llegue por link aparece acá hasta que se le pone folio.
          } @else {
            Hay <strong>{{ r.kpis.total }}</strong> {{ r.kpis.total === 1 ? 'captura' : 'capturas' }}
            sin folio por <strong>{{ money(r.kpis.importe) }}</strong>.
            @if (r.kpis.no_cuadran) {
              <span class="cf-warn">{{ r.kpis.no_cuadran }} {{ r.kpis.no_cuadran === 1 ? 'no cuadra' : 'no cuadran' }}
                contra lo que declararon.</span>
            }
          }
        </p>
      }

      <div class="card-premium card-flat cf-card">
        <div class="cf-tools">
          <div class="cf-field cf-grow">
            <label for="cf-q">Buscar</label>
            <input id="cf-q" pInputText [(ngModel)]="search" placeholder="Quién, a quién le pagó, de qué…"
                   (keyup.enter)="cargar()" (blur)="cargar()" />
          </div>
          <!-- Refrescar y los links bajan acá: el encabezado ahora es del tablero. -->
          <div class="cf-acts">
            <button pButton type="button" class="p-button-text p-button-sm" (click)="cargar()" [loading]="cargando()"
                    aria-label="Volver a consultar">
              <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
            </button>
            @if (puedeEmitir()) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="verLinks()">
                <span class="p-button-icon p-button-icon-left pi pi-link" aria-hidden="true"></span>
                <span class="p-button-label">Links ({{ linksVigentes() }})</span></button>
            }
          </div>
        </div>

        <app-load-state [loading]="primeraCarga()" [error]="error()" [isEmpty]="!filas().length"
                        [skeletonRows]="6" emptyIcon="pi-inbox"
                        emptyTitle="Sin capturas pendientes"
                        emptyHint="Acá caen los gastos que la gente sube por su link, hasta que alguien les pone el folio de la solicitud."
                        (retry)="cargar()">
          <p-table [value]="filas()" styleClass="p-datatable-sm cf-table" [rowHover]="true">
            <ng-template #header>
              <tr>
                <th style="width:11rem">Quién</th>
                <th style="width:12rem">A quién le pagó</th>
                <th>De qué</th>
                <th class="ta-r" style="width:8rem">Importe</th>
                <th style="width:9rem">Ticket</th>
                <th style="width:7rem">Fotos</th>
                <th class="ta-r" style="width:8rem"><span class="sr-only">Acción</span></th>
              </tr>
            </ng-template>
            <ng-template #body let-r>
              <tr>
                <td>
                  {{ r.solicitante }}
                  <span class="cf-meta">{{ r.sucursal_nombre || r.sucursal || '—' }} · {{ dmy(r.fecha_gasto) }}</span>
                  <!-- GX.13 — el trabajador pudo escribir una sucursal que no está en el
                       catálogo (plaza nueva). Sin este aviso entra como una más y nadie la
                       da de alta: sucursal_nombre viene del join con warehouses. -->
                  @if (!r.sucursal_nombre && r.sucursal) {
                    <span class="cf-bad cf-nosol" title="Esta sucursal no está en el catálogo — hay que darla de alta o corregirla">sucursal nueva</span>
                  }
                </td>
                <td>{{ r.proveedor }}</td>
                <td class="muted"><span class="cf-trunc" [title]="r.comentarios || ''">{{ r.comentarios || '—' }}</span></td>
                <td class="ta-r num strong">{{ money(r.importe) }}</td>

                <!-- El cuadre de acá es contra lo que DECLARÓ quien subió, que es lo único que
                     había sin folio. El cuadre bueno (contra Kepler) corre al ligarla. -->
                <td>
                  @if (r.clasificacion === 'no_comprobable') {
                    <span class="faint">sin comprobante</span>
                  } @else if (r.monto_match === true) {
                    <span class="cf-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> cuadra</span>
                  } @else if (r.monto_ocr != null) {
                    <span class="cf-bad" [title]="r.revision_nota || ''">
                      <i class="pi pi-exclamation-triangle" aria-hidden="true"></i> dice {{ money(r.monto_ocr) }}</span>
                  } @else {
                    <span class="faint">sin lectura</span>
                  }
                </td>

                <td>
                  <span class="cf-fotos">{{ r.fotos }}</span>
                  @if (!r.tiene_solicitud) { <span class="cf-bad cf-nosol" title="Sin la solicitud firmada no se puede aprobar">sin firmada</span> }
                  @if (r.camara === 'file') { <span class="cf-meta" title="La foto salió del selector de archivos, no de la cámara en vivo">de galería</span> }
                </td>

                <td class="ta-r">
                  @if (puedeCasar()) {
                    <button pButton type="button" class="p-button-sm p-button-outlined" (click)="abrirCasar(r)">
                      <span class="p-button-label">Ligar</span></button>
                  } @else { <span class="faint">—</span> }
                </td>
              </tr>
            </ng-template>
          </p-table>
        </app-load-state>
      </div>
    </div>

    <!-- ── Ligar con su solicitud ──────────────────────────────────────────── -->
    <p-dialog [(visible)]="casarOpen" [modal]="true" header="Ligar con su solicitud"
              [style]="{ width: '34rem', maxWidth: '95vw' }" [draggable]="false">
      @if (sel(); as s) {
        <div class="cf-dlg">
          <div class="cf-dlg-sum">
            <strong>{{ s.solicitante }}</strong> le pagó <strong>{{ money(s.importe) }}</strong>
            a {{ s.proveedor }}{{ s.fecha_gasto ? ' el ' + dmy(s.fecha_gasto) : '' }}.
          </div>

          <label class="cf-dlg-f">
            <span>Solicitud de Kepler (XA1501)</span>
            <p-autocomplete [(ngModel)]="solSel" [suggestions]="sug()" (completeMethod)="buscarSol($event)"
                            optionLabel="label" [forceSelection]="false" [showClear]="true" appendTo="body"
                            placeholder="Últimos dígitos del folio, o el beneficiario" styleClass="w-full" />
            <em>Con los últimos dígitos basta: el 23 encuentra el folio 0000023.</em>
          </label>

          <!-- La brecha se muestra ANTES de ligar: es justo lo que hay que mirar. -->
          @if (brecha(); as b) {
            <div class="cf-dlg-gap" [class.is-bad]="b.difiere">
              <i class="pi" [class.pi-check-circle]="!b.difiere" [class.pi-exclamation-triangle]="b.difiere" aria-hidden="true"></i>
              @if (b.difiere) {
                Declaró {{ money(b.declarado) }} y la solicitud pide {{ money(b.kepler) }} — difieren {{ money(b.delta) }}.
              } @else { El importe coincide con la solicitud. }
            </div>
          }

          @if (errorCasar()) { <p class="cf-dlg-err" role="alert">{{ errorCasar() }}</p> }
        </div>
      }
      <ng-template #footer>
        <button pButton type="button" text (click)="casarOpen = false"><span class="p-button-label">Cancelar</span></button>
        <button pButton type="button" (click)="casar()" [disabled]="!folioElegido() || casando()" [loading]="casando()">
          <span class="p-button-label">Ligar</span></button>
      </ng-template>
    </p-dialog>

    <!-- ── Links de captura ────────────────────────────────────────────────── -->
    <p-dialog [(visible)]="linksOpen" [modal]="true" header="Links de captura"
              [style]="{ width: '46rem', maxWidth: '96vw' }" [draggable]="false">
      <p class="cf-lk-intro">
        Cada persona tiene su link, y lo usa cada vez que gasta. Es reutilizable a propósito:
        el gasto ya ocurrió cuando acá se entera nadie, así que no hay a quién pedirle que emita uno.
        Dar de baja un link lo corta al instante.
      </p>

      @if (puedeEmitir()) {
        <div class="cf-lk-new">
          <input pInputText [(ngModel)]="nuevaPersona" placeholder="Nombre de la persona" class="cf-lk-in"
                 (keyup.enter)="emitir()" aria-label="Nombre de la persona" />
          <input pInputText [(ngModel)]="nuevaSucursal" placeholder="Sucursal (opcional)" class="cf-lk-suc"
                 aria-label="Sucursal por default" />
          <button pButton type="button" (click)="emitir()" [disabled]="!nuevaPersona.trim() || emitiendo()"
                  [loading]="emitiendo()">
            <span class="p-button-label">Emitir</span></button>
        </div>
      }

      <div class="cf-lk-list">
        @for (l of links(); track l.id) {
          <div class="cf-lk" [class.off]="!l.vigente">
            <div class="cf-lk-who">
              <strong>{{ l.persona }}</strong>
              <span class="cf-meta">
                {{ l.uses }} {{ l.uses === 1 ? 'uso' : 'usos' }}
                @if (l.sin_casar) { · {{ l.sin_casar }} sin ligar }
                @if (!l.vigente) { · dado de baja }
              </span>
            </div>
            <div class="cf-lk-act">
              @if (l.vigente) {
                <button type="button" class="cf-lk-copy" (click)="copiar(l)">
                  <i class="pi" [class.pi-copy]="copiado() !== l.id" [class.pi-check]="copiado() === l.id" aria-hidden="true"></i>
                  {{ copiado() === l.id ? 'Copiado' : 'Copiar link' }}
                </button>
                @if (puedeEmitir()) {
                  <button type="button" class="cf-lk-off" (click)="revocar(l)" [attr.aria-label]="'Dar de baja el link de ' + l.persona">
                    <i class="pi pi-ban" aria-hidden="true"></i>
                  </button>
                }
              }
            </div>
          </div>
        } @empty {
          <p class="cf-lk-empty">Todavía no hay links. Emití uno con el nombre de la persona.</p>
        }
      </div>
    </p-dialog>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display: block; }
    .cf-panel { display: block; }
    .cf-acts { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; }

    .cf-lead { margin: 0 0 var(--sp-3); max-width: 80ch; font-size: var(--fs-body); color: var(--fg-1); line-height: 1.5; }
    .cf-warn { color: var(--warn-fg); }

    .card-premium.cf-card { padding: 0; overflow: hidden; box-shadow: none; }
    .card-premium.cf-card:hover { box-shadow: none; }
    .cf-tools { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3);
      padding: var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .cf-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .cf-field > label { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .06em; color: var(--fg-3); }
    .cf-grow { flex: 1 1 18rem; }
    app-load-state { display: block; padding: var(--sp-2) var(--sp-3) var(--sp-3); }

    .cf-table th { font-size: var(--fs-micro); font-weight: var(--fw-medium); text-transform: uppercase;
      letter-spacing: .04em; color: var(--fg-3); white-space: nowrap; }
    .cf-table td { font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.3; }
    .cf-table .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cf-table .ta-r { text-align: right; }
    .cf-table .strong { font-weight: var(--fw-bold); }
    .cf-table .muted { color: var(--fg-2); }
    .cf-table .faint { color: var(--fg-3); font-size: var(--fs-xs); }
    .cf-meta { display: block; margin-top: 1px; font-size: var(--fs-xs); color: var(--fg-3); }
    .cf-trunc { display: block; max-width: 20rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cf-fotos { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .cf-ok { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--ok-fg); }
    .cf-bad { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--warn-fg); }
    .cf-nosol { display: block; margin-top: 1px; }

    /* ── Diálogo de ligar ─────────────────────────────────────────────────── */
    .cf-dlg { display: flex; flex-direction: column; gap: var(--sp-3); }
    .cf-dlg-sum { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
      background: var(--overlay-hover); font-size: var(--fs-sm); color: var(--fg-1); line-height: 1.5; }
    .cf-dlg-f { display: flex; flex-direction: column; gap: var(--sp-1); }
    .cf-dlg-f > span { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--fg-1); }
    .cf-dlg-f > em { font-size: var(--fs-xs); color: var(--fg-2); font-style: normal; }
    .cf-dlg-gap { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--ok-border, var(--border-color)); border-radius: var(--r-md);
      font-size: var(--fs-sm); color: var(--ok-fg); line-height: 1.45; }
    .cf-dlg-gap.is-bad { border-color: var(--warn-border); color: var(--warn-fg); }
    .cf-dlg-err { margin: 0; font-size: var(--fs-sm); color: var(--bad-fg, var(--warn-fg)); }

    /* ── Links ────────────────────────────────────────────────────────────── */
    .cf-lk-intro { margin: 0 0 var(--sp-3); max-width: 70ch; font-size: var(--fs-sm);
      color: var(--fg-2); line-height: 1.5; }
    .cf-lk-new { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3);
      padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border-color); }
    .cf-lk-in { flex: 1 1 14rem; }
    .cf-lk-suc { flex: 0 1 10rem; }
    .cf-lk-list { display: flex; flex-direction: column; }
    .cf-lk { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3);
      padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
    .cf-lk.off { opacity: .5; }
    .cf-lk-who strong { font-size: var(--fs-sm); color: var(--fg-1); }
    .cf-lk-act { display: flex; align-items: center; gap: var(--sp-2); }
    .cf-lk-copy { display: inline-flex; align-items: center; gap: var(--sp-1);
      min-height: max(1.9rem, var(--tap-min)); padding: 0 var(--sp-2);
      border: 1px solid var(--border-color); border-radius: var(--r-md); background: transparent;
      font: inherit; font-size: var(--fs-xs); color: var(--fg-1); cursor: pointer; }
    .cf-lk-copy:hover { background: var(--overlay-hover); }
    .cf-lk-off { display: inline-flex; align-items: center; justify-content: center;
      width: max(1.9rem, var(--tap-min)); height: max(1.9rem, var(--tap-min));
      border: 0; border-radius: var(--r-sm); background: none; color: var(--fg-3); cursor: pointer; }
    .cf-lk-off:hover { color: var(--warn-fg); background: var(--overlay-hover); }
    .cf-lk-copy:focus-visible, .cf-lk-off:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .cf-lk-empty { margin: 0; padding: var(--sp-3) 0; font-size: var(--fs-sm); color: var(--fg-3); }
  `],
})
export class FinanzasCapturasSinFolioComponent {
  private readonly svc = inject(CapturasSinFolioService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  /** Al ligar una captura cambia el contador del embudo: el tablero tiene que recargarlo. */
  readonly changed = output<void>();

  /**
   * El tablero pide abrir los links al entrar. Existe porque repartir links es circular:
   * sin links no hay capturas, y el boton vivia SOLO dentro de esta etapa — o sea escondido
   * detras de una tabla que el dia uno esta vacia. Ahora tambien se llega desde el
   * encabezado, y esa entrada aterriza aca con el dialogo ya abierto.
   */
  readonly abrirLinks = input(false);

  readonly report = signal<{ kpis: { total: number; importe: number; por_link: number; no_cuadran: number }; rows: CapturaSinFolio[] } | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly primeraCarga = computed(() => this.cargando() && !this.report());
  readonly filas = computed(() => this.report()?.rows || []);

  search = '';
  readonly money = money;
  readonly dmy = dmy;

  /** Ligar es una decisión sobre el dinero (a qué folio pertenece), no captura. */
  readonly puedeCasar = computed(() => this.perms.isAdmin()
    || this.auth.user()?.permissions?.[Permission.FINANCE_EXPENSES_COMPROBAR] === true);
  readonly puedeEmitir = this.puedeCasar;

  private yaAbrio = false;

  constructor() {
    this.cargar();
    this.cargarLinks();
    // Una sola vez: si no, volver de cerrar el dialogo lo reabriria en loop.
    effect(() => {
      if (this.abrirLinks() && !this.yaAbrio) { this.yaAbrio = true; this.verLinks(); }
    });
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.svc.sinFolio(this.search).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.report.set(r); this.cargando.set(false); },
      error: () => { this.error.set('No se pudieron cargar las capturas.'); this.cargando.set(false); },
    });
  }

  // ── Ligar ────────────────────────────────────────────────────────────────
  readonly sel = signal<CapturaSinFolio | null>(null);
  casarOpen = false;
  solSel: SolSug | string | null = null;
  readonly sug = signal<SolSug[]>([]);
  readonly casando = signal(false);
  readonly errorCasar = signal<string>('');

  abrirCasar(r: CapturaSinFolio): void {
    this.sel.set(r);
    this.solSel = null;
    this.sug.set([]);
    this.errorCasar.set('');
    this.casarOpen = true;
  }

  buscarSol(ev: { query: string }): void {
    const q = (ev?.query || '').trim();
    if (q.length < 2 && !/^\d+$/.test(q)) { this.sug.set([]); return; }
    this.svc.buscarSolicitudes(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => this.sug.set(rows.map((r) => ({
        ...r,
        label: `${r.folio} · ${money(r.importe)} · ${r.beneficiario || 's/beneficiario'}${r.fecha ? ' · ' + dmy(r.fecha) : ''}`,
      }))),
      error: () => this.sug.set([]),
    });
  }

  /** El folio elegido, venga del autocomplete o tecleado a mano. */
  folioElegido(): string {
    const s = this.solSel;
    if (!s) return '';
    return typeof s === 'string' ? s.trim() : (s.folio || '');
  }

  /** La brecha entre lo declarado y lo que pide la solicitud — se ve ANTES de ligar. */
  readonly brecha = computed(() => {
    const s = this.sel();
    const sol = this.solSel;
    if (!s || !sol || typeof sol === 'string') return null;
    const declarado = Number(s.importe) || 0;
    const kepler = Number(sol.importe) || 0;
    const delta = Math.abs(kepler - declarado);
    return { declarado, kepler, delta, difiere: delta > 0.5 };
  });

  casar(): void {
    const s = this.sel();
    const folio = this.folioElegido();
    if (!s || !folio || this.casando()) return;
    this.casando.set(true);
    this.errorCasar.set('');
    this.svc.match(s.id, folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.casando.set(false);
        this.casarOpen = false;
        const dif = Math.abs((r.importe_kepler || 0) - (r.importe_declarado || 0)) > 0.5;
        this.toast.add({
          severity: dif ? 'warn' : 'success',
          summary: `Ligada con ${r.folio_solicitud}`,
          detail: dif
            ? `Ojo: declaró ${money(r.importe_declarado)} y la solicitud pide ${money(r.importe_kepler)}.`
            : 'Ya entró al ciclo normal, en Solicitudes de gasto.',
          life: dif ? 8000 : 4000,
        });
        this.cargar();
        this.changed.emit();
      },
      error: (e) => {
        this.casando.set(false);
        this.errorCasar.set(e?.error?.message || 'No se pudo ligar.');
      },
    });
  }

  // ── Links ────────────────────────────────────────────────────────────────
  readonly links = signal<CaptureLink[]>([]);
  linksOpen = false;
  nuevaPersona = '';
  nuevaSucursal = '';
  readonly emitiendo = signal(false);
  readonly copiado = signal<string | null>(null);
  readonly linksVigentes = computed(() => this.links().filter((l) => l.vigente).length);

  private cargarLinks(): void {
    this.svc.links().pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (l) => this.links.set(l || []), error: () => this.links.set([]) });
  }
  verLinks(): void { this.linksOpen = true; this.cargarLinks(); }

  emitir(): void {
    const persona = this.nuevaPersona.trim();
    if (!persona || this.emitiendo()) return;
    this.emitiendo.set(true);
    this.svc.issueLink({ persona, sucursal: this.nuevaSucursal.trim() || undefined })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (l) => {
          this.emitiendo.set(false);
          this.nuevaPersona = ''; this.nuevaSucursal = '';
          this.cargarLinks();
          this.copiar(l);
          this.toast.add({ severity: 'success', summary: `Link de ${l.persona}`, detail: 'Copiado — mándaselo por WhatsApp.' });
        },
        error: (e) => {
          this.emitiendo.set(false);
          this.toast.add({ severity: 'error', summary: 'No se pudo emitir', detail: e?.error?.message || '' });
        },
      });
  }

  /** Copia al portapapeles. `clipboard` puede no existir (http sin TLS) → hay plan B. */
  copiar(l: CaptureLink): void {
    const ok = () => { this.copiado.set(l.id); setTimeout(() => this.copiado.set(null), 2000); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(l.url).then(ok).catch(() => this.copiarFallback(l.url, ok));
      return;
    }
    this.copiarFallback(l.url, ok);
  }
  private copiarFallback(texto: string, ok: () => void): void {
    const ta = document.createElement('textarea');
    ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ok(); } finally { document.body.removeChild(ta); }
  }

  revocar(l: CaptureLink): void {
    this.svc.revokeLink(l.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.cargarLinks(); this.toast.add({ severity: 'info', summary: `Link de ${l.persona} dado de baja` }); },
      error: (e) => this.toast.add({ severity: 'error', summary: 'No se pudo dar de baja', detail: e?.error?.message || '' }),
    });
  }
}
