import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, SegOption } from '../../../shared/components/segmented/segmented.component';
import { BoardSort, ComercialSupervisorBoardComponent, ymdMx } from './comercial-supervisor-board.component';
import { ComercialVendorMenuComponent } from './comercial-vendor-menu.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { VENDEDORES_TABS } from '../vendedores-tabs';

type CarteraView = 'tablero' | 'vendedores';

/**
 * V.0d — Cartera de ventas (supervisor de ventas).
 *
 * `[MCP.3.10]` Dos pestañas y UNA barra (pedido de David, 2026-10-22: «estos hay que ponerlos en un
 * mismo menú»):
 *  · **Mis vendedores** — el tablero del día (vendedor, ruta, visitados, venta de hoy);
 *  · **Asignar rutas** — el menú de vendedores: clic en uno → su Resumen y su Configurar (ruta,
 *    sucursal, meta, clientes a visitar).
 *
 * Se quitaron «Sucursal por ruta» (la sucursal se pone ahora en el Configurar de cada vendedor) y el
 * orden de visita (decisión de David). La fecha vale para las dos pestañas.
 */
@Component({
  selector: 'app-comercial-cartera',
  standalone: true,
  imports: [
    FormsModule, ButtonModule, DatePickerModule, ToastModule,
    FreshnessPillComponent, SegmentedComponent, ComercialSupervisorBoardComponent, ComercialVendorMenuComponent, PageTabsComponent,
  ],
  providers: [MessageService],
  template: `
    <div class="surf-page ca">
      <p-toast />
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cartera de ventas</h1>
        </div>
      </header>

      <app-page-tabs [tabs]="apartadoTabs" />

      <div class="ca-bar" role="toolbar" aria-label="Cartera de ventas">
        <app-segmented [options]="views" [value]="view()" (valueChange)="setView($any($event))" ariaLabel="Apartado" />
        @if (view() === 'tablero') {
          <span class="ca-sep" aria-hidden="true"></span>
          <span class="ca-lbl">Ordenar</span>
          <app-segmented [options]="sortOpts" [value]="sort()" (valueChange)="sort.set($any($event))" ariaLabel="Ordenar vendedores" />
        }
        <span class="ca-tools">
          <p-datepicker [ngModel]="dateObj()" (ngModelChange)="setDate($event)" dateFormat="yy-mm-dd"
            [maxDate]="maxDate" [showIcon]="true" appendTo="body" inputId="ca-fecha" ariaLabel="Fecha" styleClass="ca-date" />
          @if (view() === 'tablero') {
            <app-freshness-pill measures="data" [freshness]="boardFreshness()" label="Venta Kepler" />
          }
          <button pButton type="button" [text]="true" severity="secondary" size="small" (click)="refresh()" aria-label="Actualizar">
            <span class="p-button-icon pi pi-refresh" aria-hidden="true"></span></button>
        </span>
      </div>

      @if (view() === 'tablero') {
        <app-comercial-supervisor-board [date]="date()" [sort]="sort()" (openVendor)="openVendor($event)" />
      } @else {
        <app-comercial-vendor-menu [date]="date()" [initialVendor]="pendingVendor()" />
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ca-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-4); }
    .ca-sep { width: 1px; align-self: stretch; background: var(--border-color); }
    .ca-lbl { font-size: var(--fs-xs); color: var(--text-muted); }
    .ca-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin-left: auto; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComercialCarteraComponent implements OnInit {
  /** [NAV.8] La barra del apartado «Vendedores» del sidebar de Comercial: la pintan todas sus páginas. */
  readonly apartadoTabs = VENDEDORES_TABS;
  private readonly ruta = inject(ActivatedRoute);
  private readonly boardRef = viewChild(ComercialSupervisorBoardComponent);
  private readonly menuRef = viewChild(ComercialVendorMenuComponent);

  readonly views: SegOption[] = [
    { label: 'Mis vendedores', value: 'tablero' },
    { label: 'Asignar rutas', value: 'vendedores' },
  ];
  readonly sortOpts: SegOption[] = [
    { label: 'Venta', value: 'venta' },
    { label: 'Nombre', value: 'nombre' },
  ];

  /** Abre en «Mis vendedores» (el tablero): es lo que el supervisor revisa a diario. */
  readonly view = signal<CarteraView>('tablero');
  readonly sort = signal<BoardSort>('venta');
  /** Vendedor que se pidió desde el tablero: el menú lo abre en su Resumen. */
  readonly pendingVendor = signal<string | null>(null);

  readonly maxDate = new Date();
  readonly date = signal(ymdMx(new Date()));
  readonly dateObj = computed(() => new Date(`${this.date()}T12:00:00`));

  /** La frescura de la venta del tablero, en la barra («Venta Kepler»). */
  readonly boardFreshness = computed(() => this.boardRef()?.data()?.freshness ?? null);

  ngOnInit(): void {
    // Enlaces viejos: ?vista=vendedores y ?vista=sucursales (ya no existe) abren «Asignar rutas».
    const v = this.ruta.snapshot.queryParamMap.get('vista');
    if (v === 'vendedores' || v === 'sucursales') this.view.set('vendedores');
  }

  setView(v: CarteraView): void {
    this.view.set(v);
  }

  /** Del tablero al Resumen del vendedor (misma fecha). */
  openVendor(userId: string): void {
    this.pendingVendor.set(userId);
    this.view.set('vendedores');
  }

  setDate(d: Date | null): void {
    if (!d) return;
    this.date.set(ymdMx(d));
  }

  refresh(): void {
    if (this.view() === 'tablero') this.boardRef()?.load();
    else {
      this.menuRef()?.loadList();
      this.menuRef()?.loadSummary();
    }
  }
}
