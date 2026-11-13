import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { coincideBusqueda } from '@megadulces/ui-web';
import { warehouseName } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { ARQUEO_TABS } from '../arqueo-tabs';
import { ArqueoPromosService, TicketConPromo, TicketsDeTurnos, asignacionesPendientes, llaveTicket } from '../arqueo-promos.service';

const SUCURSALES = ['01', '02', '03', '04', '05', '06', '07', '08'];

/**
 * `[MKT.18]` **¿Quién vendió las promociones?** — pestaña del arqueo (`/tienda/arqueo/promociones`).
 *
 * Propósito (una pregunta): ¿quién vendió cada ticket con promoción de mi sucursal? Lo contesta la
 * cajera al cerrar; NO bloquea el arqueo (es otra pestaña, opcional). Kepler no lo sabe: en
 * mostrador todo sale a nombre del vendedor «PISO» (148 de 149 tickets de PH, semana 45).
 *
 * Kepler pone el ticket, sus promociones y cantidades; la cajera sólo elige la persona, de la
 * lista del reloj checador de su sucursal. Así la suma cuadra sola con Kepler.
 *
 * `[MKT.23]` Las promociones son las de Kepler (como la app de vendedor) y se ven los tickets de
 * toda la sucursal, con su caja y cajero: filtrar por turno dejaba fuera el 35 % (el usuario de
 * caja de Kepler no coincide con el de la Suite en 19 de 36 cajas).
 *
 * Jerarquía: primario = cuántos tickets faltan y la columna «Vendió»; secundario = las promos
 * del ticket; terciario = folio, caja y turno.
 */
@Component({
  selector: 'app-tienda-arqueo-promos',
  standalone: true,
  imports: [CommonModule, FormsModule, TableModule, ButtonModule, SelectModule, InputTextModule, ToastModule, ConfirmDialogModule,
    PageTabsComponent, LoadStateComponent, FreshnessPillComponent, MetricStripComponent, SegmentedComponent, ContextHelpComponent],
  providers: [MessageService, ConfirmationService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page ap">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <app-page-tabs [tabs]="tabs" />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>¿Quién vendió las promociones? <app-context-help topic="arqueo-promos" /></h1>
          <p class="surf-page-sub">Los tickets con promoción de tu sucursal, según Kepler. Sólo elige quién atendió cada uno.</p>
        </div>
        <app-freshness-pill measures="fetch" [since]="datos()?.consultado_at ?? null" [staleAfterSec]="600"></app-freshness-pill>
      </header>

      <div class="ap-filtros">
        @if (pideSucursal() || sucursal()) {
          <p-select [options]="opcionesSucursal" optionLabel="label" optionValue="value" [ngModel]="sucursal()" (ngModelChange)="elegirSucursal($event)"
                    placeholder="Elige la sucursal" appendTo="body" ariaLabel="Sucursal"></p-select>
        }
        <app-segmented [options]="opcionesVista()" [value]="vista()" (valueChange)="vista.set($any($event))" ariaLabel="Qué tickets ver"></app-segmented>
        <app-segmented [options]="opcionesDias" [value]="'' + dias()" (valueChange)="dias.set(+$event)" ariaLabel="Desde cuándo"></app-segmented>
        <input pInputText type="search" class="ap-buscar" [ngModel]="busqueda()" (ngModelChange)="busqueda.set($event)"
               placeholder="Buscar folio o promoción" aria-label="Buscar ticket" />
      </div>

      @if (datos(); as d) {
        <app-metric-strip [items]="kpis()" ariaLabel="Tickets con promoción"></app-metric-strip>
        @if (d.ve_toda_la_sucursal) {
          <p class="ap-nota" role="status"><i class="pi pi-eye" aria-hidden="true"></i> Ves los tickets de todas las cajas de {{ nombreSucursal(d.sucursal) }}.</p>
        }
        @if (sinVendedora().length && d.personas.length) {
          <div class="ap-masivo">
            <span>Asignar los {{ sinVendedora().length }} sin vendedora a</span>
            <p-select [options]="d.personas" optionLabel="nombre" optionValue="code" [ngModel]="paraTodos()" (ngModelChange)="paraTodos.set($event)"
                      [filter]="true" filterBy="nombre" placeholder="Elige a la persona" appendTo="body" ariaLabel="Persona para todos los vacíos"></p-select>
            <button pButton type="button" class="p-button-sm p-button-outlined" (click)="asignarVacios()" [disabled]="!paraTodos()">
              <span class="p-button-label">Asignar</span></button>
          </div>
        }
      }

      <!-- [MKT.23] Pedir la sucursal no es una falla: va como estado vacío con su instrucción, no en rojo. -->
      <app-load-state [loading]="res.isLoading() && !datos()" [error]="pideSucursal() ? null : error()"
                      [isEmpty]="pideSucursal() || (!!datos() && !filas().length)"
                      [emptyIcon]="pideSucursal() ? 'pi-building' : datos()?.tickets?.length ? 'pi-check-circle' : 'pi-ticket'"
                      [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="res.reload()">
        <p-table [value]="filas()" size="small" class="surf-table surf-table--plain surf-table--sticky dt-stack">
          <ng-template #header>
            <tr>
              <th>Fecha</th>
              <th>Ticket</th>
              <th>Promociones</th>
              <th class="ap-col-quien">Vendió</th>
            </tr>
          </ng-template>
          <ng-template #body let-t>
            <tr [class.ap-cambio]="cambio(t)">
              <td data-label="Fecha">{{ fecha(t.business_date) }}</td>
              <td data-label="Ticket">
                <span class="ap-folio">{{ t.folio }}</span>
                <span class="ap-tenue">Caja {{ t.caja }}@if (t.turno_apertura) { · turno {{ t.turno_apertura }} }@if (datos()?.ve_toda_la_sucursal && t.cajero) { · {{ t.cajero }} }</span>
              </td>
              <td data-label="Promociones">
                @for (p of t.promos; track p.code) {
                  <span class="ap-promo">{{ p.mecanica }} <strong>× {{ p.cantidad | number:'1.0-2' }}</strong></span>
                }
              </td>
              <td class="ap-col-quien" data-label="Vendió">
                <p-select [options]="datos()?.personas ?? []" optionLabel="nombre" optionValue="code" [ngModel]="valor(t)" (ngModelChange)="elegir(t, $event)"
                          [filter]="true" filterBy="nombre" [showClear]="true" placeholder="¿Quién vendió?" appendTo="body"
                          [ariaLabel]="'Quién vendió el ticket ' + t.folio" class="ap-sel"></p-select>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      @if (datos() && !datos()!.personas.length) {
        <p class="ap-nota ap-nota--warn" role="status"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          Nadie checó en el reloj de esta sucursal en los últimos 30 días: no hay a quién elegir. Avisa a RH.</p>
      }

      @if (pendientes().length) {
        <div class="ap-guardar" role="region" aria-label="Cambios sin guardar">
          <span>{{ pendientes().length }} {{ pendientes().length === 1 ? 'ticket cambiado' : 'tickets cambiados' }} sin guardar</span>
          <button pButton type="button" class="p-button-sm p-button-text" (click)="descartar()" [disabled]="guardando()">
            <span class="p-button-label">Descartar</span></button>
          <button pButton type="button" class="p-button-sm" (click)="guardar()" [disabled]="guardando()" [loading]="guardando()">
            <span class="p-button-label">Guardar</span></button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ap-filtros { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin: var(--sp-4) 0 var(--sp-3); }
    .ap-buscar { min-width: 14rem; margin-left: auto; }
    .ap-nota { display: flex; gap: var(--sp-2); align-items: center; color: var(--text-muted); font-size: var(--fs-sm); margin: var(--sp-2) 0; }
    .ap-nota--warn { color: var(--warn-fg); }
    .ap-masivo { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; font-size: var(--fs-sm); }
    .ap-folio { display: block; font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .ap-tenue { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .ap-promo { display: block; }
    .ap-col-quien { min-width: 16rem; }
    .ap-sel { width: 100%; }
    tr.ap-cambio > td { background: var(--overlay-hover); }
    .ap-guardar { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-3);
      padding: var(--sp-3) var(--sp-4); margin-top: var(--sp-3); background: var(--surface-card); border-top: 1px solid var(--border); }
    @media (max-width: 48rem) { .ap-buscar { margin-left: 0; width: 100%; } .ap-col-quien { min-width: 0; } }
  `],
})
export class TiendaArqueoPromosComponent {
  private readonly api = inject(ArqueoPromosService);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);
  readonly tabs = ARQUEO_TABS;

  readonly sucursal = signal<string | null>(null);
  readonly dias = signal(7);
  readonly vista = signal<'pendientes' | 'todos'>('pendientes');
  readonly busqueda = signal('');
  /** Lo que la cajera eligió y no ha guardado: llave del ticket → clave de la persona (null = quitar). */
  readonly elegidos = signal<Record<string, string | null>>({});
  readonly paraTodos = signal<string | null>(null);
  readonly guardando = signal(false);

  readonly opcionesSucursal = SUCURSALES.map((c) => ({ value: c, label: warehouseName(c) }));
  readonly opcionesDias: SegOption[] = [{ label: '7 días', value: '7' }, { label: '30 días', value: '30' }];

  readonly res = rxResource({
    params: () => ({ sucursal: this.sucursal(), dias: this.dias() }),
    stream: ({ params }) => this.api.tickets(params.sucursal, params.dias),
  });
  readonly datos = computed<TicketsDeTurnos | undefined>(() => (this.res.hasValue() ? this.res.value() : undefined));
  private readonly falla = computed(() => {
    const e = this.res.error() as { status?: number; error?: { message?: string } } | undefined;
    return e ? { status: e.status ?? 0, mensaje: e.error?.message ?? '' } : null;
  });
  /**
   * El servidor pide sucursal cuando el usuario tiene varias, todas (admin/supervisión) o ninguna
   * asignada. En todos esos casos se ofrece elegirla: la sucursal sigue validándose en el servidor.
   */
  readonly pideSucursal = computed(() => /sucursal/i.test(this.falla()?.mensaje ?? '') && this.falla()?.status === 400);
  readonly error = computed(() => {
    const f = this.falla();
    if (!f) return null;
    if (this.pideSucursal()) return 'Elige la sucursal arriba para ver sus tickets.';
    // Un 4xx trae su motivo: se dice tal cual. Sólo sin respuesta del servidor se culpa a la conexión.
    if (f.status >= 400 && f.status < 500 && f.mensaje) return f.mensaje;
    return 'No se pudieron cargar los tickets. Revisa tu conexión y vuelve a intentar.';
  });

  valor(t: TicketConPromo): string | null {
    const k = llaveTicket(t);
    const e = this.elegidos();
    return k in e ? e[k] : (t.vendedora?.code ?? null);
  }
  cambio(t: TicketConPromo): boolean {
    const k = llaveTicket(t);
    return k in this.elegidos() && (this.elegidos()[k] || null) !== (t.vendedora?.code ?? null);
  }

  readonly sinVendedora = computed(() => (this.datos()?.tickets ?? []).filter((t) => !this.valor(t)));
  readonly pendientes = computed(() => asignacionesPendientes(this.datos()?.tickets ?? [], this.elegidos()));

  readonly filas = computed(() => {
    const q = this.busqueda();
    return (this.datos()?.tickets ?? []).filter((t) =>
      (this.vista() === 'todos' || !t.vendedora || this.cambio(t))
      && coincideBusqueda(q, t.folio, t.caja, ...t.promos.map((p) => p.mecanica)));
  });

  readonly opcionesVista = computed<SegOption[]>(() => {
    const d = this.datos();
    const sin = d ? d.tickets.filter((t) => !t.vendedora).length : 0;
    return [{ label: `Sin vendedora${d ? ` (${sin})` : ''}`, value: 'pendientes' }, { label: 'Todos', value: 'todos' }];
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    const total = d.tickets.length;
    const faltan = d.tickets.filter((t) => !t.vendedora).length;
    return [
      { label: 'Tickets con promoción', value: total, format: 'number', sub: d.dias === 7 ? 'últimos 7 días' : 'últimos 30 días' },
      { label: 'Sin vendedora', value: faltan, format: 'number', tone: faltan ? 'warn' : 'ok', sub: faltan ? 'por escribir' : 'todos tienen' },
      { label: 'Con vendedora', value: total - faltan, format: 'number' },
    ];
  });

  readonly vacioTitulo = computed(() => (this.pideSucursal() ? 'Elige una sucursal'
    : this.datos()?.tickets.length ? 'Todos tienen vendedora' : 'Sin tickets con promoción'));
  readonly vacioPista = computed(() => (this.pideSucursal() ? 'Elígela arriba para ver sus tickets con promoción.'
    : this.datos()?.tickets.length
    ? 'Cambia a «Todos» para revisarlos o corregir alguno.'
    : 'En estos días la sucursal no tiene tickets con una promoción de Kepler.'));

  nombreSucursal(c: string): string { return warehouseName(c); }
  fecha(ymd: string): string {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  elegir(t: TicketConPromo, code: string | null): void {
    this.elegidos.update((e) => ({ ...e, [llaveTicket(t)]: code || null }));
  }

  asignarVacios(): void {
    const p = this.paraTodos();
    if (!p) return;
    this.elegidos.update((e) => {
      const n = { ...e };
      for (const t of this.sinVendedora()) n[llaveTicket(t)] = p;
      return n;
    });
  }

  elegirSucursal(c: string | null): void {
    const cambiar = () => { this.elegidos.set({}); this.sucursal.set(c); };
    if (!this.pendientes().length) { cambiar(); return; }
    this.confirm.confirm({
      header: 'Hay tickets sin guardar',
      message: 'Si cambias de sucursal se pierde lo que elegiste.',
      acceptLabel: 'Descartar y cambiar', rejectLabel: 'Seguir aquí',
      acceptButtonStyleClass: 'p-button-danger', accept: cambiar,
    });
  }

  descartar(): void { this.elegidos.set({}); }

  async guardar(): Promise<void> {
    const items = this.pendientes();
    if (!items.length || this.guardando()) return;
    this.guardando.set(true);
    try {
      const r = await firstValueFrom(this.api.guardar(this.datos()?.sucursal ?? this.sucursal(), items));
      this.toast.add({ severity: 'success', summary: 'Guardado', detail: `${r.guardados} con vendedora${r.quitados ? ` · ${r.quitados} quitados` : ''}` });
      this.elegidos.set({});
      this.res.reload();
    } catch (e: unknown) {
      const m = (e as { error?: { message?: string } })?.error?.message;
      this.toast.add({ severity: 'error', summary: 'No se guardó', detail: m || 'Intenta de nuevo.' });
    } finally {
      this.guardando.set(false);
    }
  }

  /** Para `unsavedChangesGuard`: no perder lo elegido al salir de la pestaña. */
  hasUnsavedChanges(): boolean { return this.pendientes().length > 0; }
}
