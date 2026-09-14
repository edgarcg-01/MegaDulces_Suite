import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ConfirmationService, MessageService } from 'primeng/api';
import { debounceTime, Subject } from 'rxjs';
import type { EstadoDePersona, PersonaFila, ResumenDelPadron } from '@megadulces/contracts';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AdminService, OpcionCatalogo } from '../admin.service';
import { ADMIN_TABS } from '../admin-tabs';
import { PersonaDetalleComponent } from '../components/persona-detalle.component';

/**
 * `[AU.2]` — El padrón: personas con un puesto, no credenciales con permisos.
 *
 * ⛔ Lectura y escritura son distintas: la pantalla abre con `USUARIOS_VER` y los
 * controles de escritura exigen `USUARIOS_GESTIONAR`. El botón escondido es
 * cortesía; la barrera la pone el backend en cada `POST`/`PUT`/`DELETE`.
 */
@Component({
  selector: 'app-admin-personas',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    ConfirmDialogModule, SelectModule, InputTextModule,
    MetricStripComponent, SidePeekComponent, LoadStateComponent, PageTabsComponent,
    FreshnessPillComponent, ContextHelpComponent, PersonaDetalleComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService, ConfirmationService],
  template: `
    <div class="surf-page in ap-page">
      <p-toast></p-toast>
      <p-confirmdialog></p-confirmdialog>
      <app-page-tabs [tabs]="tabs"></app-page-tabs>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Personas</h1>
          <p class="surf-page-sub">
            Cada persona ocupa un <strong>puesto</strong>, y del puesto salen su perfil de acceso,
            su jefe y de qué responde. Apartarse de lo que el puesto propone se puede, dejando
            escrito el motivo.
          </p>
        </div>
        <div class="ap-head-actions">
          <app-context-help topic="organizacion-personas" />
          <app-freshness-pill measures="data" [since]="medidoAt()" label="Medido"></app-freshness-pill>
          <button pButton type="button" class="p-button-sm p-button-text" [disabled]="loading()"
                  (click)="recargar()" aria-label="Actualizar el padrón">
            <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
            <span class="p-button-label">Actualizar</span>
          </button>
          @if (puedeEscribir()) {
            <button pButton type="button" class="p-button-sm" severity="contrast" (click)="abrirAlta()">
              <span class="p-button-icon p-button-icon-left pi pi-user-plus" aria-hidden="true"></span>
              <span class="p-button-label">Dar de alta</span>
            </button>
          }
        </div>
      </header>

      @if (!puedeEscribir()) {
        <div class="ap-note" role="status">
          <i class="pi pi-eye" aria-hidden="true"></i>
          <span>Estás viendo el padrón en <strong>modo lectura</strong>. Editar exige el permiso de gestión de usuarios.</span>
        </div>
      }

      <app-metric-strip [items]="kpis()" ariaLabel="Resumen del padrón"></app-metric-strip>

      <div class="ap-filters">
        <p-select [options]="deptOpts()" [ngModel]="fDept()" (ngModelChange)="fDept.set($event)"
                  (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" ariaLabel="Departamento"></p-select>
        <p-select [options]="puestoOpts()" [ngModel]="fPuesto()" (ngModelChange)="fPuesto.set($event)"
                  (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" [filter]="true" filterBy="label"
                  ariaLabel="Puesto"></p-select>
        <p-select [options]="kindOpts" [ngModel]="fKind()" (ngModelChange)="fKind.set($event)"
                  (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" ariaLabel="Tipo de cuenta"></p-select>
        <span class="ap-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" [ngModel]="fSearch()"
                 (ngModelChange)="fSearch.set($event); buscar$.next($event)"
                 placeholder="Nombre, usuario, puesto o sucursal" aria-label="Buscar personas" />
        </span>
        @if (hayFiltro()) {
          <button pButton type="button" class="p-button-sm p-button-text" (click)="limpiarFiltros()"
                  aria-label="Quitar todos los filtros">
            <span class="p-button-icon p-button-icon-left pi pi-filter-slash" aria-hidden="true"></span>
            <span class="p-button-label">Limpiar</span>
          </button>
        }
        <span class="ap-count">{{ total() | number }} persona(s)</span>
      </div>

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!filas().length" [skeletonRows]="10"
                      emptyIcon="pi-users"
                      [emptyTitle]="hayFiltro() ? 'Nadie con estos filtros' : 'El padrón está vacío'"
                      [emptyHint]="hayFiltro()
                        ? 'Probá quitando el departamento o limpiando la búsqueda. La búsqueda tolera acentos y errores de tecleo.'
                        : 'Lo que ves acá está acotado a tu alcance: quien administra ve a todos, un encargado ve a su sucursal y un supervisor a su equipo.'"
                      [emptyCta]="hayFiltro() ? 'Limpiar filtros' : null"
                      emptyCtaIcon="pi pi-filter-slash"
                      (retry)="recargar()" (cta)="limpiarFiltros()">
        <p-table [value]="filas()" [scrollable]="true" scrollHeight="flex" styleClass="p-datatable-sm ap-table"
                 [rowHover]="true" dataKey="id" [tableStyle]="{ 'min-width': '58rem' }"
                 [lazy]="true" [paginator]="total() > pageSize()" [rows]="pageSize()" [totalRecords]="total()"
                 [first]="(page() - 1) * pageSize()" (onLazyLoad)="paginar($any($event))">
          <ng-template #header>
            <tr>
              <th class="ap-sticky">Persona</th>
              <th>Puesto · Departamento</th>
              <th>Perfil de acceso</th>
              <th>Dónde opera</th>
              <th>Estado</th>
              <th class="ap-r">Última entrada</th>
            </tr>
          </ng-template>
          <ng-template #body let-u>
            <tr class="ap-row" [class.ap-row-sel]="sel()?.id === u.id" (click)="abrirFicha(u)"
                tabindex="0" (keydown.enter)="abrirFicha(u)"
                [attr.aria-label]="'Ficha de ' + (u.nombre || u.username)">
              <td class="ap-sticky">
                <div class="ap-persona">
                  <span class="ap-nombre">{{ u.nombre || u.username }}</span>
                  <span class="ap-user mono">&#64;{{ u.username }}</span>
                </div>
              </td>
              <td>
                @if (u.position_name) {
                  <span class="ap-puesto">{{ u.position_name }}</span>
                } @else {
                  <span class="ap-falta">sin puesto</span>
                }
                <span class="ap-sub">{{ u.department_name || '—' }}</span>
              </td>
              <td>
                <span class="comm-code">{{ u.role_name || '—' }}</span>
              </td>
              <td>
                @if (u.warehouse_name) {
                  <span>{{ u.warehouse_name }}</span>
                } @else if (u.route_name_today) {
                  <span>{{ u.route_name_today }}</span>
                } @else if (u.zona) {
                  <span>{{ u.zona }}</span>
                } @else {
                  <span class="ap-falta">red</span>
                }
              </td>
              <td>
                @if (u.kind !== 'interno') {
                  <p-tag [value]="claseDeCuenta(u.kind)" severity="secondary" styleClass="ap-chip"></p-tag>
                }
                <p-tag [value]="estadoLabel(u.status)" [severity]="estadoTono(u.status)"
                       styleClass="ap-chip"></p-tag>
              </td>
              <td class="ap-r comm-num">{{ u.last_login_at ? (u.last_login_at | date: 'dd/MM/yy') : 'nunca' }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="ap-foot">
        La lista está acotada a tu alcance y la búsqueda corre en el servidor: tolera acentos,
        errores de tecleo y varias palabras en cualquier orden. <strong>No</strong> incluye
        contraseñas ni datos de nómina — esta pantalla administra acceso, no legajos.
      </p>

      <app-side-peek [open]="peek()" (openChange)="cerrarFicha($event)" [width]="560"
                     [title]="sel() ? (sel()!.nombre || sel()!.username) : 'Dar de alta'"
                     [subtitle]="sel() ? ('@' + sel()!.username) : 'Una persona nueva empieza por su puesto'">
        @if (peek()) {
          <app-persona-detalle [persona]="sel()" [puedeEscribir]="puedeEscribir()"
                               (guardado)="onGuardado($event)" (cancelado)="cerrarFicha(false)">
          </app-persona-detalle>
        }
      </app-side-peek>
    </div>
  `,
  styleUrls: ['./admin-personas.component.css'],
})
export class AdminPersonasComponent implements OnInit {
  private api = inject(AdminService);
  private perms = inject(PermissionsService);
  private toast = inject(MessageService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  readonly tabs = ADMIN_TABS;
  readonly puedeEscribir = this.perms.has$(Permission.USUARIOS_GESTIONAR);

  readonly filas = signal<PersonaFila[]>([]);
  readonly total = signal(0);
  readonly resumen = signal<ResumenDelPadron>({
    sin_puesto: 0,
    sin_jefe: 0,
    sesion_larga: 0,
    nunca_entraron: 0,
  });
  readonly medidoAt = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sel = signal<PersonaFila | null>(null);
  readonly peek = signal(false);

  /** Catálogos para los filtros. Se cargan una vez. */
  private readonly departamentos = signal<OpcionCatalogo[]>([]);
  private readonly puestos = signal<OpcionCatalogo[]>([]);

  // Signals y no props planas: `hayFiltro()` las lee desde un `computed`, y con
  // props planas quedaba congelado en su primer valor — el botón «Limpiar» no
  // aparecía nunca y el vacío-por-filtro se leía como «el padrón está vacío».
  readonly fSearch = signal('');
  readonly fDept = signal<string | null>(null);
  readonly fPuesto = signal<string | null>(null);
  readonly fKind = signal<string | null>('interno');

  readonly buscar$ = new Subject<string>();

  readonly kindOpts = [
    { label: 'Personas', value: 'interno' },
    { label: 'Todas las cuentas', value: null },
    { label: 'Dispositivos', value: 'dispositivo' },
    { label: 'Clientes', value: 'cliente' },
  ];

  readonly deptOpts = computed(() => [
    { label: 'Todos los departamentos', value: null },
    ...this.departamentos().map((d) => ({ label: d.name, value: d.code })),
  ]);

  readonly puestoOpts = computed(() => [
    { label: 'Todos los puestos', value: null },
    ...this.puestos().map((p) => ({ label: p.name, value: p.code })),
  ]);

  readonly hayFiltro = computed(
    () => !!this.fSearch() || !!this.fDept() || !!this.fPuesto() || this.fKind() !== 'interno',
  );

  /**
   * Las cifras las cuenta el servidor sobre el mismo alcance y los mismos
   * filtros que la tabla, antes de paginar. Calcularlas acá sobre `filas()`
   * contaba la página y se leía como el padrón: decía «sin puesto 25» con 81
   * sin puesto, y el número cambiaba al pasar de página.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const r = this.resumen();
    const items: MetricStripItem[] = [
      { label: 'En el padrón', value: this.total(), format: 'number' },
      {
        label: 'Sin puesto',
        value: r.sin_puesto,
        format: 'number',
        tone: r.sin_puesto ? 'warn' : undefined,
        sub: 'no heredan perfil ni jefe',
      },
      {
        label: 'Sin jefe directo',
        value: r.sin_jefe,
        format: 'number',
        sub: 'lo hereda del puesto',
      },
      { label: 'Nunca entraron', value: r.nunca_entraron, format: 'number' },
    ];
    // Sólo cuando el filtro los incluye: el TTL largo vive en kioscos y tabletas,
    // así que con `kind='interno'` esta cifra sería 0 por construcción.
    if (this.fKind() !== 'interno') {
      items.push({
        label: 'Con sesión larga',
        value: r.sesion_larga,
        format: 'number',
        sub: 'kiosco o tableta',
      });
    }
    return items;
  });

  ngOnInit(): void {
    this.buscar$
      .pipe(debounceTime(250), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.page.set(1);
        this.sincronizarUrl();
        this.cargar();
      });

    // `[DESIGN §Ing.UI 9]` El estado vive en la URL: compartir el link comparte
    // lo que el otro va a ver.
    const q = this.route.snapshot.queryParamMap;
    this.fSearch.set(q.get('q') ?? '');
    this.fDept.set(q.get('dept'));
    this.fPuesto.set(q.get('puesto'));
    if (q.get('kind') !== null) this.fKind.set(q.get('kind'));

    this.api.departamentos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.departamentos.set(d),
      error: () => this.departamentos.set([]),
    });
    this.api.puestosSimples().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => this.puestos.set(p),
      error: () => this.puestos.set([]),
    });

    this.cargar();
  }

  private cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .padron({
        search: this.fSearch() || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
        department_code: this.fDept() || undefined,
        position_code: this.fPuesto() || undefined,
        kind: this.fKind() || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.filas.set(r.rows);
          this.total.set(r.total);
          if (r.resumen) this.resumen.set(r.resumen);
          this.medidoAt.set(r.medido_at ?? null);
          this.loading.set(false);
        },
        error: (e) => {
          this.error.set(e?.error?.message ?? 'No se pudo leer el padrón.');
          this.loading.set(false);
        },
      });
  }

  onFiltro(): void {
    this.page.set(1);
    this.sincronizarUrl();
    this.cargar();
  }

  private sincronizarUrl(): void {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        q: this.fSearch() || null,
        dept: this.fDept() || null,
        puesto: this.fPuesto() || null,
        kind: this.fKind() === 'interno' ? null : this.fKind(),
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  paginar(e: { first?: number; rows?: number }): void {
    const rows = e.rows ?? this.pageSize();
    const first = e.first ?? 0;
    this.pageSize.set(rows);
    this.page.set(Math.floor(first / rows) + 1);
    this.cargar();
  }

  limpiarFiltros(): void {
    this.fSearch.set('');
    this.fDept.set(null);
    this.fPuesto.set(null);
    this.fKind.set('interno');
    this.onFiltro();
  }

  recargar(): void {
    this.cargar();
  }

  abrirFicha(u: PersonaFila): void {
    this.sel.set(u);
    this.peek.set(true);
  }

  abrirAlta(): void {
    this.sel.set(null);
    this.peek.set(true);
  }

  cerrarFicha(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) this.sel.set(null);
  }

  /**
   * Los cuatro estados llevan cuatro etiquetas. Con el booleano `activo`, una
   * persona dada de baja se leía «Suspendida», que es otra cosa: suspendida
   * vuelve, dada de baja no. En prod son 11 personas.
   */
  estadoLabel(s: EstadoDePersona | null): string {
    switch (s) {
      case 'invited': return 'Invitada';
      case 'active': return 'Activa';
      case 'suspended': return 'Suspendida';
      case 'terminated': return 'Dada de baja';
      default: return 'sin estado';
    }
  }

  estadoTono(s: EstadoDePersona | null): 'success' | 'warn' | 'danger' | 'info' | 'secondary' {
    switch (s) {
      case 'invited': return 'info';
      case 'active': return 'success';
      case 'suspended': return 'warn';
      case 'terminated': return 'danger';
      default: return 'secondary';
    }
  }

  claseDeCuenta(kind: string): string {
    switch (kind) {
      case 'dispositivo': return 'Dispositivo';
      case 'cliente': return 'Cliente';
      case 'servicio': return 'Servicio';
      default: return kind;
    }
  }

  /** El detalle avisa cuando guardó. Recargar es más honesto que parchear la fila. */
  onGuardado(msg: string): void {
    this.toast.add({ severity: 'success', summary: 'Guardado', detail: msg, life: 4000 });
    this.peek.set(false);
    this.sel.set(null);
    this.cargar();
  }
}
