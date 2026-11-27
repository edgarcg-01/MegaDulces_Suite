import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { NOMBRE_DE_LA_REGLA, type BandejaFueraDeNorma, type DecisionNorma, type DecisionTomada, type FacturaFueraDeNorma } from '@megadulces/contracts';
import { fechaCortaMx } from '@megadulces/contracts/finance/cfdi-factura';
import type { MotivoNorma, ReglaNorma, VeredictoNorma } from '@megadulces/contracts/finance/norma-fiscal-cfdi';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import { Permission } from '../../../core/constants/permissions';
import { PermissionsService } from '../../../core/services/permissions.service';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { CfdiVisorComponent } from '../../../shared/components/cfdi-visor/cfdi-visor.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { FacturasFueraDeNormaService } from '../facturas-fuera-de-norma.service';
import { PagosTabsComponent } from '../pagos-tabs.component';

type Vista = 'por' | 'hechas';
interface Borrador { decision: DecisionNorma | null; motivo: string }

const SEVERIDAD: Record<VeredictoNorma, 'danger' | 'warn' | 'info' | 'secondary'> = {
  solo_informativa: 'danger', requiere_autorizacion: 'warn', sin_medir: 'info', apta: 'secondary',
};
const VEREDICTO: Record<VeredictoNorma, string> = {
  solo_informativa: 'No se paga', requiere_autorizacion: 'Pide decisión', sin_medir: 'Sin medir', apta: 'Aviso',
};

/** Caracteres reales, como los cuenta el servidor (un emoji son dos unidades de JavaScript). */
const largo = (s: string) => [...s.trim()].length;

/**
 * `[PGP.229]` — **Facturas fuera de norma** (anexo NF §8).
 *
 * Lo que espera la decisión de Administración o Contabilidad: una recibida con uso S01 o con un régimen que no es
 * 612 no se autoriza en el Calendario hasta que alguien con la llave diga «se usa» o «no se usa». Primero lo que
 * ya está en un pago (el que sale antes), luego la más nueva. La regla y el armado viven en libs/contracts; aquí
 * sólo se muestra, se decide y se revoca.
 */
@Component({
  selector: 'app-finanzas-facturas-fuera-de-norma',
  standalone: true,
  imports: [
    RouterLink, ButtonModule, TableModule, TagModule, TextareaModule, ToastModule,
    LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, SidePeekComponent,
    CfdiVisorComponent, ContextHelpComponent, PagosTabsComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-toast />
    <app-pagos-tabs />
    <div class="surf-page fn-page">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1 class="surf-page-title">Facturas fuera de norma <app-context-help topic="facturas-fuera-de-norma" /></h1>
          <p class="surf-page-sub">Las facturas recibidas con uso S01 o con un régimen distinto de 612. No se autorizan en el Calendario hasta que Administración o Contabilidad decida si se usan.</p>
        </div>
        <div class="fn-head-der">
          <app-freshness-pill measures="fetch" [since]="datos()?.leido_en ?? null" />
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="cargando()" (click)="cargar()" aria-label="Volver a leer">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span>
          </button>
        </div>
      </header>

      <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="false" (retry)="cargar()">
        @if (datos(); as d) {
          <p class="fn-titular">{{ titular() }}</p>
          <app-metric-strip [items]="kpis()" mode="strip" density="compact" ariaLabel="Facturas fuera de norma" />

          <section class="fn-barra" aria-label="Vista y búsqueda">
            <app-segmented [options]="vistaOpts()" [value]="vista()" (valueChange)="cambiarVista($event)" ariaLabel="Por decidir o decididas" />
            <label class="fn-buscar">
              <span class="sr-only">Buscar por emisor, RFC, folio o UUID</span>
              <input type="search" [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Emisor, RFC, folio o UUID"
                     autocomplete="off" spellcheck="false" enterkeyhint="search" />
            </label>
          </section>

          <div class="fn-tabla dt-scope">
            <p-table [value]="filas()" size="small" dataKey="uuid"
                     class="surf-table surf-table--plain surf-table--sticky surf-table--frozen-first dt-stack">
              <ng-template #header>
                <tr>
                  <th scope="col">Emisor</th>
                  <th scope="col">Folio</th>
                  <th scope="col">Fecha</th>
                  <th scope="col" class="comm-num">Total</th>
                  <th scope="col">{{ vista() === 'por' ? 'Pide decisión' : 'Decisión' }}</th>
                  <th scope="col">Pago</th>
                  <th scope="col"><span class="sr-only">Abrir</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-f>
                <tr class="fn-fila" tabindex="0" (click)="abrir(f)" (keydown.enter)="abrir(f)" [attr.aria-label]="'Abrir la factura de ' + (f.emisor_nombre || f.emisor_rfc)">
                  <td role="cell" data-label="Emisor">
                    <div class="fn-emisor">
                      <span class="fn-nombre">{{ f.emisor_nombre || 'Sin nombre en el CFDI' }}</span>
                      <span class="fn-meta fn-mono">{{ f.emisor_rfc }}</span>
                    </div>
                  </td>
                  <td role="cell" data-label="Folio"><span class="fn-mono">{{ f.serie_folio || '—' }}</span></td>
                  <td role="cell" data-label="Fecha"><span class="fn-mono fn-nowrap">{{ fecha(f.fecha) }}</span></td>
                  <td class="comm-num" role="cell" data-label="Total"><span class="fn-mono fn-nowrap">{{ dinero(f.total) }}</span></td>
                  <td role="cell" [attr.data-label]="vista() === 'por' ? 'Pide decisión' : 'Decisión'">
                    @if (vista() === 'por') {
                      <span class="fn-reglas">
                        @for (r of f.por_decidir; track r) { <p-tag [value]="nombreRegla(r)" severity="warn" /> }
                      </span>
                    } @else {
                      <span class="fn-reglas">
                        @for (dd of f.decisiones; track dd.id) {
                          <p-tag [value]="(dd.decision === 'se_usa' ? 'Se usa' : 'No se usa') + ' · ' + nombreRegla(dd.regla)" [severity]="dd.decision === 'se_usa' ? 'success' : 'danger'" />
                        }
                      </span>
                    }
                  </td>
                  <td role="cell" data-label="Pago">
                    @if (f.pagos[0]; as p) {
                      <span class="fn-pago">
                        <span class="fn-mono fn-nowrap">{{ fecha(p.fecha) }}</span>
                        @if (p.folio) { <span class="fn-meta fn-mono">{{ p.folio }}</span> }
                        @if (p.autorizado) { <p-tag value="Autorizado" severity="info" /> }
                        @if (f.pagos.length > 1) { <span class="fn-meta">y {{ f.pagos.length - 1 }} más</span> }
                      </span>
                    } @else {
                      <span class="fn-meta fn-nowrap">Sin pago programado</span>
                    }
                  </td>
                  <td role="cell" class="fn-accion">
                    <!-- De texto en la fila: la única acción primaria de la pantalla es «Guardar decisión». -->
                    <button pButton type="button" class="p-button-sm p-button-text"
                            (click)="abrir(f); $event.stopPropagation()">{{ vista() === 'por' && puedeDecidir() ? 'Decidir' : 'Ver' }}</button>
                  </td>
                </tr>
              </ng-template>
              <ng-template #emptymessage>
                <tr><td colspan="7" class="fn-vacio">{{ vacio() }}</td></tr>
              </ng-template>
            </p-table>
          </div>

          <footer class="fn-notas">
            <p>Aparecen las facturas recibidas desde el {{ fecha(d.desde) }} que piden decisión, y de cualquier fecha las que ya están en un pago
              del Calendario o tienen una decisión. Las del IMSS, las comisiones que el banco cobra solo y los traslados no piden decisión.
              Una factura sin CFDI ligado en el Calendario no aparece: el Calendario tampoco la detiene.</p>
          </footer>
        }
      </app-load-state>
    </div>

    <app-side-peek [open]="!!abierta()" (openChange)="$event || cerrar()" [title]="tituloPeek()" [subtitle]="subtituloPeek()" [width]="560">
      @if (abierta(); as f) {
        <section class="fn-p-sec" aria-label="Qué dice la norma">
          <h3 class="fn-p-h">Qué dice la norma al pagarla</h3>
          <ul class="fn-p-motivos">
            @for (m of f.motivos; track m.regla) {
              <li><p-tag [value]="veredicto(m)" [severity]="severidad(m)" /> <span>{{ m.texto }}</span></li>
            }
          </ul>
          <dl class="fn-p-datos">
            <div><dt>Método y forma</dt><dd class="fn-mono">{{ f.metodo_pago || '—' }} · {{ f.forma_pago || '—' }}</dd></div>
            <div><dt>Uso</dt><dd class="fn-mono">{{ f.receptor_uso_cfdi || '—' }}</dd></div>
            <div><dt>Régimen a nuestro nombre</dt><dd class="fn-mono">{{ f.receptor_regimen || '—' }}</dd></div>
            <div><dt>UUID</dt><dd class="fn-mono fn-uuid">{{ f.uuid }}</dd></div>
          </dl>
        </section>

        <section class="fn-p-sec" aria-label="Pagos con esta factura">
          <h3 class="fn-p-h">En el Calendario</h3>
          @if (f.pagos.length) {
            <ul class="fn-p-pagos">
              @for (p of f.pagos; track p.allocation_id) {
                <li>
                  <a routerLink="/finanzas/calendario-pagos" [queryParams]="{ vista: 'dia', fecha: p.fecha }">Pago del {{ fecha(p.fecha) }}</a>
                  @if (p.folio) { <span class="fn-meta fn-mono">{{ p.folio }}</span> }
                  @if (p.autorizado) { <p-tag value="Autorizado" severity="info" /> }
                </li>
              }
            </ul>
          } @else {
            <p class="fn-meta">No está en ningún pago programado.</p>
          }
        </section>

        @if (puedeDecidir() && f.por_decidir.length) {
          @for (r of f.por_decidir; track r) {
            <section class="fn-p-sec fn-p-decidir" [attr.aria-label]="'Decidir: ' + nombreRegla(r)">
              <h3 class="fn-p-h">Decidir: {{ nombreRegla(r) }}</h3>
              <div class="fn-p-opciones" role="radiogroup" [attr.aria-label]="'¿Se usa? ' + nombreRegla(r)">
                <button type="button" role="radio" class="fn-op" [class.is-sel]="borrador(f, r).decision === 'se_usa'"
                        [attr.aria-checked]="borrador(f, r).decision === 'se_usa'" (click)="elegir(f, r, 'se_usa')">Se usa</button>
                <button type="button" role="radio" class="fn-op" [class.is-sel]="borrador(f, r).decision === 'no_se_usa'"
                        [attr.aria-checked]="borrador(f, r).decision === 'no_se_usa'" (click)="elegir(f, r, 'no_se_usa')">No se usa</button>
              </div>
              <label class="fn-p-motivo">
                <span>Motivo (queda para todos)</span>
                <textarea pTextarea rows="2" maxlength="300" [value]="borrador(f, r).motivo" (input)="escribir(f, r, $any($event.target).value)"
                          placeholder="Por qué se usa o por qué no"></textarea>
              </label>
              <div class="fn-p-pie">
                <span class="fn-meta">Basta tu firma: queda a tu nombre, con la fecha.</span>
                <button pButton type="button" class="p-button-sm" [disabled]="!listo(f, r) || enviando()" (click)="decidir(f, r)">Guardar decisión</button>
              </div>
            </section>
          }
        } @else if (f.por_decidir.length) {
          <p class="fn-p-sec fn-meta">Decidir esta factura es de Administración o Contabilidad.</p>
        }

        @if (f.decisiones.length) {
          <section class="fn-p-sec" aria-label="Decisiones tomadas">
            <h3 class="fn-p-h">Decisiones</h3>
            @for (dd of f.decisiones; track dd.id) {
              <div class="fn-p-decision">
                <p><p-tag [value]="dd.decision === 'se_usa' ? 'Se usa' : 'No se usa'" [severity]="dd.decision === 'se_usa' ? 'success' : 'danger'" />
                  {{ nombreRegla(dd.regla) }} · {{ dd.por }} · {{ cuando(dd.cuando) }}</p>
                <p class="fn-p-cita">{{ dd.motivo }}</p>
                @if (puedeDecidir()) {
                  @if (revocando() === dd.id) {
                    <label class="fn-p-motivo">
                      <span>Por qué se revoca</span>
                      <textarea pTextarea rows="2" maxlength="300" [value]="motivoRevocar()" (input)="motivoRevocar.set($any($event.target).value)"></textarea>
                    </label>
                    <div class="fn-p-pie">
                      <button pButton type="button" class="p-button-sm p-button-text" (click)="revocando.set(null)">Cancelar</button>
                      <button pButton type="button" class="p-button-sm p-button-danger" [disabled]="largo(motivoRevocar()) < 3 || enviando()" (click)="revocar(dd)">Revocar</button>
                    </div>
                  } @else {
                    <button pButton type="button" class="p-button-sm p-button-text fn-revocar" (click)="empezarRevocar(dd)">Revocar esta decisión</button>
                  }
                }
              </div>
            }
          </section>
        }

        <section class="fn-p-sec" aria-label="El XML">
          <h3 class="fn-p-h">La factura</h3>
          <app-cfdi-visor [uuid]="f.uuid" />
        </section>
      }
    </app-side-peek>
  `,
  styles: [`
    :host { display: block; }
    .fn-page { container-type: inline-size; }
    .fn-head-der { display: flex; align-items: center; gap: var(--sp-2); }
    .fn-titular { margin: 0 0 var(--sp-2); font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--c-text-1); line-height: 1.3; }
    .fn-barra { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
    .fn-buscar { margin-left: auto; }
    .fn-buscar input { height: 2.25rem; width: 18rem; max-width: 100%; border: 1px solid var(--c-divider); border-radius: var(--r-md);
      padding: 0 var(--sp-3); font: inherit; font-size: var(--fs-sm); background: var(--c-surface-1); color: var(--c-text-1); }
    .fn-buscar input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .fn-tabla { background: var(--c-surface-1); border: 1px solid var(--c-divider); border-radius: var(--r-lg); overflow-x: auto; }
    .fn-fila { cursor: pointer; }
    .fn-fila:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    .fn-emisor { display: flex; flex-direction: column; min-width: 0; }
    .fn-nombre { font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fn-meta { font-size: var(--fs-xs); color: var(--c-text-3); }
    .fn-mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .fn-nowrap { white-space: nowrap; }
    .fn-reglas, .fn-pago { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1); }
    .fn-accion { text-align: right; white-space: nowrap; }
    .fn-vacio { text-align: center; padding: var(--sp-6); color: var(--c-text-2); }
    .fn-notas { margin-top: var(--sp-4); font-size: var(--fs-xs); color: var(--c-text-2); line-height: 1.5; }
    .fn-notas p { margin: 0; max-width: 60rem; }
    .fn-p-sec { padding: var(--sp-3) 0; border-bottom: 1px solid var(--c-divider); }
    .fn-p-sec:last-child { border-bottom: 0; }
    .fn-p-h { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-bold); color: var(--c-text-1); }
    .fn-p-motivos { list-style: none; margin: 0 0 var(--sp-3); padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--c-text-1); }
    .fn-p-motivos li { display: flex; gap: var(--sp-2); align-items: baseline; }
    .fn-p-datos { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0; font-size: var(--fs-sm); }
    .fn-p-datos dt { font-size: var(--fs-xs); color: var(--c-text-3); }
    .fn-p-datos dd { margin: 0; color: var(--c-text-1); }
    .fn-uuid { word-break: break-all; }
    .fn-p-pagos { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .fn-p-pagos li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); min-height: 2rem; }
    .fn-p-opciones { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-2); }
    .fn-op { flex: 1 1 0; min-height: 2.5rem; border: 1px solid var(--c-divider); border-radius: var(--r-md); background: var(--c-surface-1);
      color: var(--c-text-1); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
    .fn-op:hover { background: var(--hover-bg); }
    .fn-op:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .fn-op.is-sel { border-color: var(--action); font-weight: var(--fw-bold); background: var(--hover-bg); }
    .fn-p-motivo { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--c-text-2); }
    .fn-p-motivo textarea { width: 100%; font-size: var(--fs-sm); }
    .fn-p-pie { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-2); }
    .fn-p-pie .fn-meta { margin-right: auto; }
    .fn-p-decision { padding: var(--sp-2) 0; font-size: var(--fs-sm); color: var(--c-text-1); }
    .fn-p-decision p { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
    /* (0,2,0) le gana a .fn-p-decision p (0,1,1) sin important (check:cascada). */
    .fn-p-decision .fn-p-cita { margin-top: var(--sp-1); color: var(--c-text-2); }
    .fn-revocar { margin-top: var(--sp-1); }
    /* 44 px al dedo (medido en la prueba visual: «Volver a leer» 22, «Decidir» y «Guardar» 28). */
    @media (pointer: coarse) {
      .fn-op, .fn-buscar input, .fn-p-pagos li { min-height: 44px; }
      .fn-head-der button, .fn-accion button, .fn-p-pie button, .fn-revocar { min-height: 44px; min-width: 44px; }
    }
    @container (max-width: 48rem) {
      .fn-buscar { margin-left: 0; flex: 1 1 100%; }
      .fn-buscar input { width: 100%; }
    }
  `],
})
export class FinanzasFacturasFueraDeNormaComponent {
  private readonly api = inject(FacturasFueraDeNormaService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly largo = largo;
  readonly datos = signal<BandejaFueraDeNorma | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly vista = signal<Vista>('por');
  readonly q = signal('');
  readonly abiertaUuid = signal<string | null>(null);
  readonly enviando = signal(false);
  readonly revocando = signal<string | null>(null);
  readonly motivoRevocar = signal('');
  /** Lo tecleado por factura y regla: cerrar el panel no lo pierde mientras la página siga abierta. */
  private readonly borradores = signal<Record<string, Borrador>>({});

  readonly puedeDecidir = computed(() => this.perms.has(Permission.FINANCE_CFDI_NORMA_DECIDIR));

  readonly lista = computed(() => {
    const d = this.datos();
    return d ? (this.vista() === 'por' ? d.por_decidir : d.decididas) : [];
  });
  readonly filas = computed(() => {
    const q = this.q();
    return filtrarPorBusqueda(this.lista(), q, (f) => [f.emisor_nombre, f.emisor_rfc, f.serie_folio, f.uuid]);
  });
  readonly abierta = computed(() => {
    const u = this.abiertaUuid();
    const d = this.datos();
    if (!u || !d) return null;
    return [...d.por_decidir, ...d.decididas].find((f) => f.uuid === u) ?? null;
  });

  readonly enUnPago = computed(() => (this.datos()?.por_decidir ?? []).filter((f) => f.pagos.length > 0));
  readonly titular = computed(() => {
    const d = this.datos();
    if (!d) return '';
    const n = d.por_decidir.length;
    if (!n) return 'Ninguna factura espera decisión';
    const pago = this.enUnPago();
    const partes = [`${n} ${n === 1 ? 'espera' : 'esperan'} decisión`];
    if (pago.length) {
      partes.push(`${pago.length} ${pago.length === 1 ? 'ya está' : 'ya están'} en un pago`);
      partes.push(`la más próxima sale el ${this.fecha(pago[0].pagos[0].fecha)}`);
    } else {
      partes.push('ninguna está en un pago todavía');
    }
    return partes.join(' · ');
  });
  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const pago = this.enUnPago();
    // Los conteos ya los dicen el titular y las pestañas: aquí va el dinero que espera la decisión (derivar, no repetir).
    return [
      { label: 'importe que espera decisión', value: d.por_decidir.reduce((s, f) => s + Number(f.total), 0), format: 'currency2', tone: d.por_decidir.length ? 'warn' : 'ok' },
      { label: 'ya en un pago', value: pago.length, format: 'number', tone: pago.length ? 'bad' : 'muted' },
      { label: 'importe en un pago', value: pago.reduce((s, f) => s + Number(f.total), 0), format: 'currency2', tone: pago.length ? 'bad' : 'muted' },
    ];
  });
  readonly vistaOpts = computed<SegOption[]>(() => [
    { label: 'Por decidir', value: 'por', count: this.datos()?.por_decidir.length },
    { label: 'Decididas', value: 'hechas', count: this.datos()?.decididas.length },
  ]);
  readonly vacio = computed(() => {
    if (this.q().trim() && this.lista().length) return 'Ninguna factura coincide con la búsqueda.';
    return this.vista() === 'por' ? 'Ninguna factura espera decisión.' : 'Todavía no hay decisiones.';
  });
  readonly tituloPeek = computed(() => {
    const f = this.abierta();
    return f ? f.emisor_nombre || f.emisor_rfc : '';
  });
  readonly subtituloPeek = computed(() => {
    const f = this.abierta();
    return f ? [f.serie_folio, this.fecha(f.fecha), this.dinero(f.total)].filter(Boolean).join(' · ') : '';
  });

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.bandeja().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.error.set(this.mensaje(e, 'No se pudo leer la bandeja.')); this.cargando.set(false); },
    });
  }

  cambiarVista(v: string): void { this.vista.set(v === 'hechas' ? 'hechas' : 'por'); }
  abrir(f: FacturaFueraDeNorma): void { this.abiertaUuid.set(f.uuid); this.revocando.set(null); }
  cerrar(): void { this.abiertaUuid.set(null); this.revocando.set(null); }

  borrador(f: FacturaFueraDeNorma, r: ReglaNorma): Borrador {
    return this.borradores()[`${f.uuid}|${r}`] ?? { decision: null, motivo: '' };
  }
  elegir(f: FacturaFueraDeNorma, r: ReglaNorma, decision: DecisionNorma): void {
    this.borradores.update((b) => ({ ...b, [`${f.uuid}|${r}`]: { ...this.borrador(f, r), decision } }));
  }
  escribir(f: FacturaFueraDeNorma, r: ReglaNorma, motivo: string): void {
    this.borradores.update((b) => ({ ...b, [`${f.uuid}|${r}`]: { ...this.borrador(f, r), motivo } }));
  }
  listo(f: FacturaFueraDeNorma, r: ReglaNorma): boolean {
    const b = this.borrador(f, r);
    return !!b.decision && largo(b.motivo) >= 3;
  }

  decidir(f: FacturaFueraDeNorma, r: ReglaNorma): void {
    const b = this.borrador(f, r);
    if (!b.decision || largo(b.motivo) < 3 || this.enviando()) return;
    this.enviando.set(true);                                  // síncrono: el doble clic no decide dos veces
    this.api.decidir(f.uuid, { regla: r, decision: b.decision, motivo: b.motivo.trim() }).subscribe({
      next: (d) => {
        this.enviando.set(false);
        this.borradores.update((x) => { const y = { ...x }; delete y[`${f.uuid}|${r}`]; return y; });
        this.toast.add({ severity: 'success', summary: d.decision === 'se_usa' ? 'Se usa' : 'No se usa', detail: `${this.nombreRegla(r)} · queda a nombre de ${d.por}`, life: 5000 });
        this.cargar();
      },
      error: (e: HttpErrorResponse) => {
        this.enviando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se guardó la decisión', detail: this.mensaje(e, 'Inténtalo otra vez.'), life: 10000 });
      },
    });
  }

  empezarRevocar(dd: DecisionTomada): void { this.revocando.set(dd.id); this.motivoRevocar.set(''); }
  revocar(dd: DecisionTomada): void {
    if (largo(this.motivoRevocar()) < 3 || this.enviando()) return;
    this.enviando.set(true);
    this.api.revocar(dd.id, { motivo: this.motivoRevocar().trim() }).subscribe({
      next: () => {
        this.enviando.set(false);
        this.revocando.set(null);
        this.toast.add({ severity: 'success', summary: 'Decisión revocada', detail: 'La factura vuelve a pedir decisión.', life: 5000 });
        this.cargar();
      },
      error: (e: HttpErrorResponse) => {
        this.enviando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se revocó', detail: this.mensaje(e, 'Inténtalo otra vez.'), life: 10000 });
      },
    });
  }

  nombreRegla(r: ReglaNorma): string {
    const n = NOMBRE_DE_LA_REGLA[r] ?? r;
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  veredicto(m: MotivoNorma): string { return VEREDICTO[m.veredicto]; }
  severidad(m: MotivoNorma): 'danger' | 'warn' | 'info' | 'secondary' { return SEVERIDAD[m.veredicto]; }
  fecha(ymd: string): string { return ymd ? fechaCortaMx(ymd) : '—'; }
  cuando(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  dinero(v: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(v));
  }
  private mensaje(e: HttpErrorResponse, porDefecto: string): string {
    const m = e?.error?.message;
    return Array.isArray(m) ? m.join(' · ') : (typeof m === 'string' && m ? m : porDefecto);
  }
}
