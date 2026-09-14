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
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { debounceTime, Subject } from 'rxjs';
import type { PersonaFila } from '@megadulces/contracts';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AdminService, OpcionCatalogo } from '../admin.service';
import { ADMIN_TABS } from '../admin-tabs';
import { PersonaDetalleComponent } from '../components/persona-detalle.component';

/**
 * `[AU.2]` — **El padrón: personas con un puesto, no credenciales con permisos.**
 *
 * Reemplaza `dashboard/admin-users`, que eran **3,070 líneas en un componente**
 * con un formulario de 700 líneas adentro de un drawer.
 *
 * ── Lo que cambia de fondo ──────────────────────────────────────────────────
 * La ficha deja de ser una lista de campos sueltos y pasa a organizarse por las
 * cinco preguntas que se le hacen a una persona: **quién es · qué abre · qué
 * datos ve · de qué responde · qué pasó con ella**. El puesto deja de ser un
 * `select` más: al elegirlo se pide `GET /users/positions/:code/propuesta` y se
 * pintan las CUATRO propuestas (rol, complementos, jefe, responsabilidades).
 *
 * Superficie **Operations**: tabla densa + master-detail en `side-peek`, KPIs en
 * `MetricStrip` (ADR-033), `app-load-state` (vacío ≠ error de red), estado en la
 * URL, cero hex crudo.
 *
 * ⛔ **Lectura y escritura son distintas.** La pantalla abre con `USUARIOS_VER`
 * (`[AU.1]`: 10 personas rebotaban) y los controles de escritura exigen
 * `USUARIOS_GESTIONAR`. El botón escondido es cortesía: la barrera de verdad la
 * pone el backend en cada `POST`/`PUT`/`DELETE`.
 */
@Component({
  selector: 'app-admin-personas',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    SelectModule, InputTextModule,
    MetricStripComponent, SidePeekComponent, LoadStateComponent, PageTabsComponent,
    PersonaDetalleComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ap-page">
      <p-toast></p-toast>
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
        <p-select [options]="deptOpts()" [(ngModel)]="fDept" (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" ariaLabel="Departamento"></p-select>
        <p-select [options]="puestoOpts()" [(ngModel)]="fPuesto" (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" [filter]="true" filterBy="label"
                  ariaLabel="Puesto"></p-select>
        <p-select [options]="kindOpts" [(ngModel)]="fKind" (onChange)="onFiltro()" optionLabel="label"
                  optionValue="value" styleClass="ap-sel" appendTo="body" ariaLabel="Tipo de cuenta"></p-select>
        <span class="ap-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input pInputText type="search" [(ngModel)]="fSearch" (ngModelChange)="buscar$.next($event)"
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
                  <p-tag [value]="u.kind" severity="secondary" styleClass="ap-chip"></p-tag>
                } @else {
                  <p-tag [value]="u.activo ? 'Activa' : 'Suspendida'"
                         [severity]="u.activo ? 'success' : 'warn'" styleClass="ap-chip"></p-tag>
                }
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

      <app-side-peek [open]="peek()" (openChange)="cerrarFicha($event)" [width]="620"
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
  readonly page = signal(1);
  readonly pageSize = signal(50);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sel = signal<PersonaFila | null>(null);
  readonly peek = signal(false);

  /** Catálogos para los filtros. Se cargan una vez. */
  private readonly departamentos = signal<OpcionCatalogo[]>([]);
  private readonly puestos = signal<OpcionCatalogo[]>([]);

  fSearch = '';
  fDept: string | null = null;
  fPuesto: string | null = null;
  fKind: string | null = 'interno';

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
    () => !!this.fSearch || !!this.fDept || !!this.fPuesto || this.fKind !== 'interno',
  );

  /**
   * ⚠️ Los KPI se calculan sobre la PÁGINA, no sobre el padrón: decir «12 sin
   * puesto» cuando sólo se miraron 50 de 122 sería inventar. Por eso el rótulo
   * dice de qué universo habla.
   */
  readonly kpis = computed<MetricStripItem[]>(() => {
    const f = this.filas();
    const sinPuesto = f.filter((u) => u.kind === 'interno' && !u.position_code).length;
    const sinJefe = f.filter((u) => u.kind === 'interno' && !u.supervisor_id).length;
    const sesionLarga = f.filter((u) => u.token_ttl_days != null).length;
    return [
      { label: 'En el padrón', value: this.total(), format: 'number' },
      { label: 'En esta página', value: f.length, format: 'number' },
      { label: 'Sin puesto', value: sinPuesto, format: 'number', tone: sinPuesto ? 'warn' : undefined },
      { label: 'Con sesión larga', value: sesionLarga, format: 'number', sub: 'kiosco o tableta' },
      { label: 'Sin jefe directo', value: sinJefe, format: 'number', sub: 'lo hereda del puesto' },
    ];
  });

  ngOnInit(): void {
    this.buscar$
      .pipe(debounceTime(250), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.page.set(1);
        this.cargar();
      });

    // `[DESIGN §Ing.UI 9]` El estado vive en la URL: compartir el link comparte
    // lo que el otro va a ver.
    const q = this.route.snapshot.queryParamMap;
    this.fSearch = q.get('q') ?? '';
    this.fDept = q.get('dept');
    this.fPuesto = q.get('puesto');
    if (q.get('kind') !== null) this.fKind = q.get('kind');

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
        search: this.fSearch || undefined,
        page: this.page(),
        pageSize: this.pageSize(),
        department_code: this.fDept || undefined,
        position_code: this.fPuesto || undefined,
        kind: this.fKind || undefined,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.filas.set(r.rows);
          this.total.set(r.total);
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
        q: this.fSearch || null,
        dept: this.fDept || null,
        puesto: this.fPuesto || null,
        kind: this.fKind === 'interno' ? null : this.fKind,
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
    this.fSearch = '';
    this.fDept = null;
    this.fPuesto = null;
    this.fKind = 'interno';
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

  /** El detalle avisa cuando guardó. Recargar es más honesto que parchear la fila. */
  onGuardado(msg: string): void {
    this.toast.add({ severity: 'success', summary: 'Guardado', detail: msg, life: 4000 });
    this.peek.set(false);
    this.sel.set(null);
    this.cargar();
  }
}
