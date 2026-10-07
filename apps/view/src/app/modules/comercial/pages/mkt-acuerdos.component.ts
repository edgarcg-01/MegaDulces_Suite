import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';

import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { PROMOS_TABS } from '../promos-tabs';
import {
  PromoAgreementsService,
  AcuerdoResumen,
  AcuerdoDetalle,
  CanalExpediente,
} from '../promo-agreements.service';

/**
 * `[MKT.1]` — **Acuerdos con proveedor (MKTN001): dos módulos, un expediente.**
 *
 * ── Por qué una sola pantalla y no dos ──────────────────────────────────────────────────────
 * El pedido eran dos módulos: Mercadotecnia ve **todas** las plazas y levanta acuerdos; la gente
 * de plaza ve **sólo lo suyo** y sube su evidencia. Son dos *vistas* del mismo expediente, no dos
 * pantallas: duplicarlas obligaría a mantener dos veces la tabla, el detalle y el formato, y la
 * primera divergencia sería que una muestre la cobertura y la otra no.
 *
 * ── El recorte NO lo hace esta pantalla ─────────────────────────────────────────────────────
 * Qué plazas ve cada quien lo decide el **alcance** en el servidor (ADR-050), y el **monto**
 * negociado lo omite el servidor cuando falta `MKT_AGREEMENTS_GESTIONAR`. Acá sólo se elige qué
 * dibujar. Si el recorte viviera en un `*ngIf`, el número seguiría viajando en el JSON.
 *
 * ── La distinción que la pantalla tiene que respetar ────────────────────────────────────────
 * `monto` **ausente** («no te toca verlo») y `monto: null` («te toca, y no se pactó») se dibujan
 * distinto a propósito. Colapsarlos a «$0» diría que el acuerdo no costó nada, que es la
 * conclusión contraria a la verdadera (ADR-056).
 */
@Component({
  selector: 'app-mkt-acuerdos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    DialogModule, InputTextModule, PageTabsComponent, SegmentedComponent, MetricStripComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="promoTabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Acuerdos con proveedor</h1>
          <p class="surf-page-sub">
            Formato MKTN001 · lo negociado, las plazas que participan y su evidencia
          </p>
        </div>
        <div class="ac-head-actions">
          @if (puedeAmbas()) {
            <app-segmented [options]="vistas" [value]="vista()" (valueChange)="vista.set($event)"
                           ariaLabel="Vista del módulo" />
          }
          <button pButton [text]="true" severity="secondary" size="small" (click)="recargar()"
                  [loading]="cargando()" aria-label="Recargar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <!-- ══════════════════ TABLERO (Mercadotecnia: todas las plazas del alcance) ═══════════ -->
      @if (vista() === 'tablero') {
        <app-metric-strip [items]="kpis()" />

        <div class="ac-split">
          <p-table [value]="acuerdos()" [loading]="cargando()" styleClass="p-datatable-sm surf-table"
                   selectionMode="single" [(selection)]="seleccion" (selectionChange)="abrir($event)"
                   [scrollable]="true" scrollHeight="flex" [paginator]="true" [rows]="25">
            <ng-template #header>
              <tr>
                <th scope="col">Folio</th>
                <th scope="col">Proveedor</th>
                <th scope="col">Mecánica</th>
                <th scope="col">Vigencia</th>
                <th scope="col" class="ac-num">Expediente</th>
                @if (veDinero()) { <th scope="col" class="ac-num">Monto</th> }
                <th scope="col">Estado</th>
              </tr>
            </ng-template>
            <ng-template #body let-a>
              <tr [pSelectableRow]="a" [class.ac-row-alerta]="enRiesgo(a)">
                <td class="ac-mono">{{ a.folio || '—' }}</td>
                <td class="ac-prov">{{ a.proveedor }}</td>
                <td class="ac-mec" [title]="a.mecanica">{{ a.mecanica }}</td>
                <td class="ac-vig">{{ vigencia(a) }}</td>
                <td class="ac-num">
                  <!-- La cobertura es el dato del módulo: cuántas plazas comprobaron ejecución. -->
                  <span [class.ac-falta]="a.canales_con_evidencia < a.canales_total">
                    {{ a.canales_con_evidencia }} / {{ a.canales_total }}
                  </span>
                </td>
                @if (veDinero()) {
                  <td class="ac-num">
                    <!-- "null" = se puede ver y NO se pactó monto. Nunca $0. -->
                    @if (a.monto === null || a.monto === undefined) {
                      <span class="ac-sin-dato" title="No se pactó un monto">sin monto</span>
                    } @else { {{ a.monto | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                  </td>
                }
                <td><p-tag [value]="etiquetaEstado(a.status)" [severity]="tonoEstado(a.status)"></p-tag></td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td [attr.colspan]="veDinero() ? 7 : 6" class="comm-empty-cell">
                <div class="comm-empty">
                  <div class="comm-empty-icon"><i class="pi pi-file-edit" aria-hidden="true"></i></div>
                  <h3>Sin acuerdos</h3>
                  <p>Todavía no se ha levantado ningún formato MKTN001.</p>
                </div>
              </td></tr>
            </ng-template>
          </p-table>

          <!-- ───────── Detalle: el expediente, plaza por plaza ───────── -->
          @if (detalle(); as d) {
            <aside class="ac-detalle" aria-label="Expediente del acuerdo">
              <div class="ac-det-head">
                <div>
                  <h2>{{ $any(d.cabecera)['proveedor'] }}</h2>
                  <p class="ac-det-folio">{{ $any(d.cabecera)['folio'] || 'Borrador — sin folio' }}</p>
                </div>
                <button pButton [text]="true" size="small" severity="secondary" (click)="cerrar()"
                        aria-label="Cerrar expediente">
                  <span class="p-button-icon pi pi-times" aria-hidden="true"></span>
                </button>
              </div>

              <dl class="ac-det-datos">
                <div><dt>Apoyo</dt><dd>{{ etiquetaApoyo($any(d.cabecera)['apoyo']) }}</dd></div>
                <div><dt>Mecánica</dt><dd>{{ $any(d.cabecera)['mecanica'] }}</dd></div>
                <div><dt>Recurso</dt><dd>{{ etiquetaRecurso(d.cabecera) }}</dd></div>
                @if (veDinero()) {
                  <div>
                    <dt>Monto</dt>
                    <dd>
                      @if ($any(d.cabecera)['monto'] == null) {
                        <span class="ac-sin-dato">no se pactó monto</span>
                      } @else { {{ $any(d.cabecera)['monto'] | currency:'MXN':'symbol-narrow':'1.2-2' }} }
                    </dd>
                  </div>
                } @else {
                  <!-- Se DECLARA que hay un dato y que no le toca verlo. Omitirlo en silencio
                       haría pensar que el acuerdo no tiene monto. -->
                  <div><dt>Monto</dt><dd class="ac-sin-dato">reservado a Mercadotecnia</dd></div>
                }
              </dl>

              @if (d.codigos.length) {
                <h3 class="ac-det-sub">Códigos ({{ d.codigos.length }})</h3>
                <ul class="ac-codigos">
                  @for (c of d.codigos; track c.position) {
                    <li><span class="ac-mono">{{ c.code }}</span> {{ c.descripcion }}</li>
                  }
                </ul>
              }

              <h3 class="ac-det-sub">
                Expediente por plaza
                <span class="ac-cobertura">{{ completos(d.canales) }} de {{ d.canales.length }} con evidencia</span>
              </h3>
              <ul class="ac-canales">
                @for (c of d.canales; track c.id) {
                  <li [class.ok]="c.completo">
                    <div class="ac-canal-id">
                      <span class="ac-mono">{{ c.warehouse_code }}</span>
                      <span class="ac-canal-nom">{{ c.warehouse_name }}</span>
                    </div>
                    <div class="ac-canal-cajas">{{ c.cajas_texto || '—' }}</div>
                    <div class="ac-canal-ev">
                      <i class="pi" [class.pi-check-circle]="c.completo" [class.pi-clock]="!c.completo"
                         aria-hidden="true"></i>
                      {{ c.evidence_count }} / {{ c.evidence_required }}
                    </div>
                    @if (puedeSubir()) {
                      <button pButton [text]="true" size="small" (click)="pedirEvidencia(c)">Subir</button>
                    }
                  </li>
                }
              </ul>
            </aside>
          }
        </div>
      }

      <!-- ══════════════════ MI PLAZA (sólo lo que le toca ejecutar) ═══════════════════════ -->
      @if (vista() === 'plaza') {
        @if (!miPlaza()) {
          <div class="comm-empty">
            <div class="comm-empty-icon"><i class="pi pi-map-marker" aria-hidden="true"></i></div>
            <h3>Sin sucursal asignada</h3>
            <!-- Se DECLARA por qué no hay nada, en vez de mostrar una tabla vacía que se lee
                 como "no hay acuerdos para tu plaza". -->
            <p>Tu usuario no tiene una sucursal asignada, así que no se puede saber qué expediente
               te toca. Pediselo a quien administra los accesos.</p>
          </div>
        } @else {
          <p class="ac-plaza-head">
            Acuerdos que corren en <strong>{{ miPlaza() }}</strong> — subí la foto de la exhibición
            armada para cerrar tu expediente.
          </p>
          <p-table [value]="mios()" [loading]="cargando()" styleClass="p-datatable-sm surf-table"
                   [scrollable]="true" scrollHeight="flex">
            <ng-template #header>
              <tr>
                <th scope="col">Proveedor</th>
                <th scope="col">Qué hay que hacer</th>
                <th scope="col">Cajas</th>
                <th scope="col">Vence</th>
                <th scope="col" class="ac-num">Evidencia</th>
                <th scope="col"></th>
              </tr>
            </ng-template>
            <ng-template #body let-m>
              <tr [class.ac-row-alerta]="!m.canal.completo">
                <td class="ac-prov">{{ m.acuerdo.proveedor }}</td>
                <td class="ac-mec">{{ m.acuerdo.mecanica }}</td>
                <td>{{ m.canal.cajas_texto || '—' }}</td>
                <td class="ac-vig">{{ vigencia(m.acuerdo) }}</td>
                <td class="ac-num">
                  <span [class.ac-falta]="!m.canal.completo">
                    {{ m.canal.evidence_count }} / {{ m.canal.evidence_required }}
                  </span>
                </td>
                <td>
                  @if (puedeSubir()) {
                    <button pButton size="small" [text]="true" (click)="pedirEvidencia(m.canal)">
                      Subir evidencia
                    </button>
                  }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage>
              <tr><td colspan="6" class="comm-empty-cell">
                <div class="comm-empty">
                  <div class="comm-empty-icon"><i class="pi pi-check-circle" aria-hidden="true"></i></div>
                  <h3>Nada pendiente</h3>
                  <p>No hay acuerdos corriendo en tu plaza ahora mismo.</p>
                </div>
              </td></tr>
            </ng-template>
          </p-table>
        }
      }

      <!-- ───────── Subir evidencia ───────── -->
      <p-dialog [(visible)]="dialogoAbierto" [modal]="true" [style]="{ width: '30rem' }"
                header="Subir evidencia de ejecución">
        <div class="ac-form">
          <p class="ac-form-ctx">
            Plaza <strong>{{ canalActivo()?.warehouse_code }}</strong> ·
            lleva {{ canalActivo()?.evidence_count }} de {{ canalActivo()?.evidence_required }}
          </p>
          <label for="ev-nombre">Nombre del archivo</label>
          <input pInputText id="ev-nombre" [(ngModel)]="evNombre" placeholder="exhibicion-armada.jpg" />
          <label for="ev-url">Enlace</label>
          <input pInputText id="ev-url" [(ngModel)]="evUrl" placeholder="https://…" />
          <label for="ev-nota">Nota (opcional)</label>
          <input pInputText id="ev-nota" [(ngModel)]="evNota" />
        </div>
        <ng-template #footer>
          <button pButton [text]="true" severity="secondary" (click)="dialogoAbierto = false">Cancelar</button>
          <button pButton (click)="confirmarEvidencia()" [disabled]="!evNombre.trim() || !evUrl.trim()">
            Subir
          </button>
        </ng-template>
      </p-dialog>
    </div>
  `,
  styles: [`
    .ac-head-actions { display: flex; align-items: center; gap: .5rem; }
    .ac-mono { font-family: var(--font-mono, monospace); }
    .ac-num { text-align: right; font-variant-numeric: tabular-nums; }
    .ac-prov { font-weight: 600; }
    .ac-mec, .ac-vig { max-width: 26rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ac-falta { color: var(--tone-warn, #b45309); font-weight: 600; }
    .ac-sin-dato { color: var(--text-muted, #78716c); font-style: italic; }
    .ac-row-alerta td:first-child { box-shadow: inset 3px 0 0 var(--tone-warn, #b45309); }

    .ac-split { display: grid; grid-template-columns: 1fr; gap: 1rem; }
    @media (min-width: 68.75rem) { .ac-split:has(.ac-detalle) { grid-template-columns: minmax(0,1fr) 24rem; } }

    .ac-detalle { border: 1px solid var(--surf-line, #e7e5e4); border-radius: var(--radius-md, .5rem); padding: 1rem; }
    .ac-det-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .5rem; }
    .ac-det-head h2 { font-size: 1rem; margin: 0; }
    .ac-det-folio { margin: .125rem 0 0; font-family: var(--font-mono, monospace); font-size: var(--fs-sm); color: var(--text-muted, #78716c); }
    .ac-det-datos { margin: 1rem 0; display: grid; gap: .5rem; }
    .ac-det-datos dt { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); }
    .ac-det-datos dd { margin: .125rem 0 0; font-size: var(--fs-body); }
    .ac-det-sub { font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: .04em; margin: 1rem 0 .5rem;
                  display: flex; justify-content: space-between; gap: .5rem; align-items: baseline; }
    .ac-cobertura { text-transform: none; letter-spacing: 0; color: var(--text-muted, #78716c); font-weight: 400; }
    .ac-codigos { list-style: none; padding: 0; margin: 0; font-size: var(--fs-sm); display: grid; gap: .25rem; }
    .ac-canales { list-style: none; padding: 0; margin: 0; display: grid; gap: .25rem; }
    .ac-canales li { display: grid; grid-template-columns: 1fr auto auto auto; gap: .5rem; align-items: center;
                     font-size: var(--fs-sm); padding: .375rem .5rem; border-radius: var(--radius-sm, .25rem);
                     background: var(--surf-sunken, #fafaf9); }
    .ac-canales li.ok { background: color-mix(in srgb, var(--tone-ok, #15803d) 8%, transparent); }
    .ac-canal-id { display: flex; gap: .375rem; align-items: baseline; min-width: 0; }
    .ac-canal-nom { color: var(--text-muted, #78716c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ac-canal-cajas, .ac-canal-ev { white-space: nowrap; font-variant-numeric: tabular-nums; }

    .ac-plaza-head { margin: 0 0 .75rem; font-size: var(--fs-body); }
    .ac-form { display: grid; gap: .375rem; }
    .ac-form label { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #78716c); margin-top: .5rem; }
    .ac-form-ctx { margin: 0 0 .5rem; font-size: var(--fs-sm); color: var(--text-muted, #78716c); }
  `],
})
export class MktAcuerdosComponent {
  readonly promoTabs = PROMOS_TABS;
  private readonly svc = inject(PromoAgreementsService);
  private readonly toast = inject(MessageService);
  private readonly auth = inject(AuthService);
  private readonly perms = inject(PermissionsService);

  readonly vistas = [
    { label: 'Tablero', value: 'tablero' },
    { label: 'Mi plaza', value: 'plaza' },
  ];

  // ── Quién es quien mira ───────────────────────────────────────────────────
  private tiene(p: Permission): boolean {
    return this.perms.isAdmin() || this.auth.user()?.permissions?.[p] === true;
  }
  /** `MKT_AGREEMENTS_GESTIONAR` es la única clave que ve el dinero. */
  readonly veDinero = computed(() => this.tiene(Permission.MKT_AGREEMENTS_GESTIONAR));
  readonly puedeSubir = computed(() => this.tiene(Permission.MKT_AGREEMENT_EVIDENCE_SUBIR));
  private readonly puedeTablero = computed(
    () => this.tiene(Permission.MKT_AGREEMENTS_VER) || this.veDinero(),
  );
  /** El selector sólo aparece si de verdad hay dos vistas que elegir. */
  readonly puedeAmbas = computed(() => this.puedeTablero() && this.puedeSubir());
  readonly miPlaza = computed(() => this.auth.user()?.warehouse_code ?? null);

  /** Quien sólo puede subir evidencia arranca en su plaza, no en un tablero que verá recortado. */
  readonly vista = signal<string>(this.puedeTablero() ? 'tablero' : 'plaza');

  // ── Estado ────────────────────────────────────────────────────────────────
  readonly acuerdos = signal<AcuerdoResumen[]>([]);
  readonly mios = signal<{ acuerdo: AcuerdoResumen; canal: CanalExpediente }[]>([]);
  readonly detalle = signal<AcuerdoDetalle | null>(null);
  readonly cargando = signal(false);
  private readonly resumenKpi = signal<Record<string, number | null | undefined> | null>(null);

  seleccion: AcuerdoResumen | null = null;
  dialogoAbierto = false;
  readonly canalActivo = signal<CanalExpediente | null>(null);
  evNombre = '';
  evUrl = '';
  evNota = '';

  constructor() {
    // Cambiar de vista recarga lo que esa vista necesita: no se traen las dos siempre.
    effect(() => { this.vista(); this.recargar(); });
  }

  recargar(): void {
    this.cargando.set(true);
    if (this.vista() === 'tablero') {
      this.svc.listar().subscribe({
        next: (r) => { this.acuerdos.set(r); this.cargando.set(false); },
        error: () => { this.cargando.set(false); this.error('No se pudieron cargar los acuerdos'); },
      });
      this.svc.resumen().subscribe({ next: (r) => this.resumenKpi.set(r as never), error: () => this.resumenKpi.set(null) });
    } else {
      const code = this.miPlaza();
      if (!code) { this.cargando.set(false); this.mios.set([]); return; }
      this.svc.porSucursal(code).subscribe({
        next: (r) => { this.mios.set(r); this.cargando.set(false); },
        error: () => { this.cargando.set(false); this.error('No se pudo cargar tu plaza'); },
      });
    }
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resumenKpi();
    if (!r) return [];
    const total = Number(r['expedientes_total'] ?? 0);
    const listos = Number(r['expedientes_completos'] ?? 0);
    const items: MetricStripItem[] = [
      { label: 'Acuerdos activos', value: Number(r['activos'] ?? 0), format: 'number' },
      {
        label: 'Expedientes con evidencia',
        value: `${listos} / ${total}`,
        format: 'text',
        tone: total > 0 && listos === total ? 'ok' : 'default',
        sub: total > 0 ? `${Math.round((listos / total) * 100)}% de cobertura` : 'sin plazas asignadas',
      },
      {
        label: 'Plazas sin comprobar',
        value: Number(r['canales_sin_evidencia'] ?? 0),
        format: 'number',
        tone: Number(r['canales_sin_evidencia'] ?? 0) > 0 ? 'warn' : 'ok',
      },
    ];
    // La clave sólo llega con permiso de gestión. Si no viene, NO se dibuja un $0.
    if ('monto_comprometido' in r) {
      const m = r['monto_comprometido'];
      items.push(
        m === null || m === undefined
          ? { label: 'Comprometido', value: 'sin monto pactado', format: 'text', tone: 'default' }
          : { label: 'Comprometido', value: Number(m), format: 'currency' },
      );
    }
    return items;
  });

  // ── Detalle ───────────────────────────────────────────────────────────────
  abrir(a: AcuerdoResumen | null): void {
    if (!a) { this.detalle.set(null); return; }
    this.svc.obtener(a.id).subscribe({
      next: (d) => this.detalle.set(d),
      error: () => this.error('No se pudo abrir el expediente'),
    });
  }
  cerrar(): void { this.detalle.set(null); this.seleccion = null; }

  completos(canales: CanalExpediente[]): number {
    return canales.filter((c) => c.completo).length;
  }

  // ── Evidencia ─────────────────────────────────────────────────────────────
  pedirEvidencia(c: CanalExpediente): void {
    this.canalActivo.set(c);
    this.evNombre = ''; this.evUrl = ''; this.evNota = '';
    this.dialogoAbierto = true;
  }

  confirmarEvidencia(): void {
    const c = this.canalActivo();
    if (!c || !this.evNombre.trim() || !this.evUrl.trim()) return;
    this.svc.subirEvidencia(c.id, {
      file_name: this.evNombre.trim(),
      file_url: this.evUrl.trim(),
      nota: this.evNota.trim() || undefined,
    }).subscribe({
      next: () => {
        this.dialogoAbierto = false;
        this.toast.add({ severity: 'success', summary: 'Evidencia subida', detail: `Plaza ${c.warehouse_code}` });
        this.recargar();
        if (this.detalle()) this.abrir(this.seleccion);
      },
      // El servidor contesta 403 cuando la plaza no es del alcance: se muestra su motivo, no uno
      // genérico, porque "no alcanza" y "falló la subida" se arreglan de maneras distintas.
      error: (e) => this.error(e?.error?.message ?? 'No se pudo subir la evidencia'),
    });
  }

  // ── Presentación ──────────────────────────────────────────────────────────
  /** La vigencia termina en fecha O en condición — se dibujan las dos formas. */
  vigencia(a: AcuerdoResumen): string {
    const d = a.vigencia_desde ? this.fecha(a.vigencia_desde) : '—';
    const h = a.vigencia_hasta ? this.fecha(a.vigencia_hasta) : (a.vigencia_hasta_texto || '—');
    return `${d} → ${h}`;
  }
  /** ⚠️ Se corta el string: `new Date('2026-09-01')` en hora de México imprime el 31 de agosto. */
  private fecha(v: string): string {
    const [y, m, d] = String(v).slice(0, 10).split('-');
    return d ? `${d}/${m}/${y.slice(2)}` : String(v);
  }

  /** Vigente y con plazas sin comprobar: lo que el tablero tiene que gritar. */
  enRiesgo(a: AcuerdoResumen): boolean {
    return (a.status === 'vigente' || a.status === 'autorizado')
      && a.canales_total > 0 && a.canales_con_evidencia < a.canales_total;
  }

  etiquetaEstado(s: string): string {
    return { borrador: 'Borrador', autorizado: 'Autorizado', vigente: 'Vigente',
             cerrado: 'Cerrado', cancelado: 'Cancelado' }[s] ?? s;
  }
  tonoEstado(s: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
    return ({ vigente: 'success', autorizado: 'info', borrador: 'warn',
              cancelado: 'danger', cerrado: 'secondary' } as const)[s] ?? 'secondary';
  }
  etiquetaApoyo(a: string): string {
    return { sell_out: 'Sell out', sell_in: 'Sell in', exhibicion: 'Exhibición',
             promocional: 'Promocional', otro: 'Otro' }[a] ?? a;
  }
  etiquetaRecurso(cab: Record<string, unknown>): string {
    const r = String(cab['recurso'] ?? '');
    const base = { cedis_nota_credito: 'CEDIS (nota de crédito)', proveedor_sin_cargo: 'Proveedor sin cargo',
                   proveedor_promocionales: 'Proveedor (promocionales)',
                   presupuesto_a_favor: 'Presupuesto a favor', otros: 'Otros' }[r] ?? r;
    const otros = cab['recurso_otros'];
    return otros ? `${base}: ${otros}` : base;
  }

  private error(msg: string): void {
    this.toast.add({ severity: 'error', summary: 'Error', detail: msg });
  }
}
