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
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import type { PuestoDetalle, PuestoFila } from '@megadulces/contracts';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AdminService } from '../admin.service';
import { ADMIN_TABS } from '../admin-tabs';

/**
 * `[AU.3]` — **El puesto y la cadena de mando.**
 *
 * Hasta acá el catálogo de puestos, lo que cada uno propone y quién manda a quién
 * **sólo se podían tocar por migración**: `identity.positions` tenía lectura por
 * API y cero create/update/delete. Un modelo cuya unidad es el puesto no puede
 * exigir un deploy para crear un puesto.
 *
 * ⚠️ El organigrama es por ZONA: el mismo puesto existe varias veces con jefes
 * distintos. Por eso la cadena se declara **entre puestos** y la zona desempata
 * al resolver — el puesto da el TIPO de jefe, no la persona.
 */
@Component({
  selector: 'app-admin-puestos',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, TableModule, TagModule, ToastModule,
    SelectModule, InputTextModule,
    MetricStripComponent, SidePeekComponent, LoadStateComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ax-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs"></app-page-tabs>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Puestos</h1>
          <p class="surf-page-sub">
            El puesto es la unidad: de él salen el perfil de acceso que se propone, el jefe y de
            qué se responde. La cadena se declara <strong>entre puestos</strong>, no entre personas
            — la zona desempata cuál de los tres jefes del mismo tipo corresponde.
          </p>
        </div>
        @if (puedeEscribir()) {
          <button pButton type="button" class="p-button-sm" severity="contrast" (click)="abrirAlta()">
            <span class="p-button-icon p-button-icon-left pi pi-plus" aria-hidden="true"></span>
            <span class="p-button-label">Nuevo puesto</span>
          </button>
        }
      </header>

      <app-metric-strip [items]="kpis()" ariaLabel="Resumen del catálogo de puestos"></app-metric-strip>

      <div class="ax-filters">
        <p-select [options]="deptOpts()" [(ngModel)]="fDept" optionLabel="label" optionValue="value"
                  styleClass="ax-sel" appendTo="body" ariaLabel="Departamento"></p-select>
        <p-select [options]="ocupacionOpts" [(ngModel)]="fOcupacion" optionLabel="label" optionValue="value"
                  styleClass="ax-sel" appendTo="body" ariaLabel="Ocupación"></p-select>
        <span class="ax-count">{{ visibles().length | number }} de {{ puestos().length | number }} puesto(s)</span>
      </div>

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!visibles().length" [skeletonRows]="10"
                      emptyIcon="pi-sitemap" emptyTitle="Ningún puesto con estos filtros"
                      emptyHint="Probá con «Todos los departamentos»."
                      (retry)="cargar()">
        <p-table [value]="visibles()" [scrollable]="true" scrollHeight="flex"
                 styleClass="p-datatable-sm ax-table" [rowHover]="true" dataKey="code"
                 [tableStyle]="{ 'min-width': '56rem' }">
          <ng-template #header>
            <tr>
              <th class="ax-sticky">Puesto</th>
              <th>Departamento</th>
              <th>Perfil que propone</th>
              <th>Reporta a</th>
              <th class="ax-r">Personas</th>
              <th class="ax-r">Responde de</th>
              <th class="ax-r">A cargo</th>
            </tr>
          </ng-template>
          <ng-template #body let-p>
            <tr class="ax-row" [class.ax-row-sel]="sel()?.code === p.code" (click)="abrir(p)"
                tabindex="0" (keydown.enter)="abrir(p)" [attr.aria-label]="'Puesto ' + p.name">
              <td class="ax-sticky">
                <span class="ax-nombre">{{ p.name }}</span>
                <span class="ax-code mono">{{ p.code }}</span>
              </td>
              <td>
                {{ p.department_name || '—' }}
                <span class="ax-sub">eje {{ p.eje_efectivo || 'sin declarar' }}</span>
              </td>
              <td>
                @if (p.default_role) {
                  <span class="comm-code">{{ p.default_role }}</span>
                  @for (c of p.default_complements; track c) {
                    <span class="comm-code ax-mas">+ {{ c }}</span>
                  }
                } @else {
                  <span class="ax-falta">no propone</span>
                }
              </td>
              <td>
                @if (p.reports_to_name) {
                  {{ p.reports_to_name }}
                } @else {
                  <span class="ax-falta">raíz</span>
                }
              </td>
              <td class="ax-r comm-num">{{ p.personas }}</td>
              <td class="ax-r comm-num">{{ p.responsabilidades }}</td>
              <td class="ax-r comm-num">{{ p.puestos_a_cargo }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="ax-foot">
        <strong>Raíz</strong> significa que el puesto no cuelga de ningún otro. Algunos lo son a
        propósito (Dirección); otros quedaron sueltos y son un escalamiento que no llega a nadie.
      </p>

      <app-side-peek [open]="peek()" (openChange)="cerrar($event)" [width]="560"
                     [title]="sel()?.name || 'Nuevo puesto'"
                     [subtitle]="sel()?.code || 'Un puesto nuevo empieza por su departamento'">
        @if (peek()) {
          <div class="ax-peek">
            @if (msg()) {
              <div class="ax-error" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ msg() }}</span>
              </div>
            }

            <label class="ax-lbl" for="ax-name">Nombre</label>
            <input pInputText id="ax-name" [(ngModel)]="fName" [disabled]="!puedeEscribir()" />

            @if (!sel()) {
              <label class="ax-lbl" for="ax-code">Código</label>
              <input pInputText id="ax-code" [(ngModel)]="fCode" class="mono"
                     placeholder="auxiliar_compras" [disabled]="!puedeEscribir()" />
              <p class="ax-hint">Minúsculas, sin espacios ni acentos. No se renombra después.</p>
            }

            <label class="ax-lbl" for="ax-dept">Departamento</label>
            <p-select inputId="ax-dept" [options]="deptSoloOpts()" [(ngModel)]="fDeptEdit"
                      optionLabel="label" optionValue="value" appendTo="body"
                      [disabled]="!puedeEscribir()"></p-select>

            <label class="ax-lbl" for="ax-rol">Perfil que propone</label>
            <p-select inputId="ax-rol" [options]="rolOpts()" [(ngModel)]="fRol" optionLabel="label"
                      optionValue="value" [filter]="true" filterBy="label" appendTo="body"
                      [disabled]="!puedeEscribir()" placeholder="Ninguno"></p-select>
            <p class="ax-hint">⛔ Propone, no otorga: quien concede sigue siendo el rol de la persona.</p>

            <label class="ax-lbl" for="ax-jefe">Reporta a</label>
            <p-select inputId="ax-jefe" [options]="jefeOpts()" [(ngModel)]="fJefe" optionLabel="label"
                      optionValue="value" [filter]="true" filterBy="label" appendTo="body"
                      [disabled]="!puedeEscribir()" placeholder="Ninguno (raíz)"></p-select>

            @if (detalle(); as d) {
              <h3>Quién lo ocupa</h3>
              @if (!d.ocupantes.length) {
                <p class="ax-vacio">Vacante. Un jefe declarado sobre un puesto vacante es una cadena
                  correcta cuyo escalamiento no llega a nadie.</p>
              } @else {
                <ul class="ax-lista">
                  @for (o of d.ocupantes; track o.id) {
                    <li>{{ o.nombre || o.username }} <span class="ax-sub mono">&#64;{{ o.username }}</span></li>
                  }
                </ul>
              }

              <h3>De qué responde</h3>
              @if (!d.responsabilidades_detalle.length) {
                <p class="ax-vacio">Nada asignado.</p>
              } @else {
                <ul class="ax-lista">
                  @for (r of d.responsabilidades_detalle; track r.responsibility_key) {
                    <li>
                      <span>{{ r.label }}</span>
                      @if (r.es_principal) { <p-tag value="principal" severity="info" styleClass="ax-tag"></p-tag> }
                      @if (r.abre === false) {
                        <p-tag value="su perfil no lo abre" severity="danger" styleClass="ax-tag"></p-tag>
                      } @else if (r.abre === null) {
                        <p-tag value="sin claves declaradas" severity="secondary" styleClass="ax-tag"></p-tag>
                      }
                    </li>
                  }
                </ul>
              }
            }

            <footer class="ax-acc">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="cerrar(false)">
                <span class="p-button-label">Cerrar</span>
              </button>
              @if (puedeEscribir()) {
                <button pButton type="button" class="p-button-sm" severity="contrast"
                        [disabled]="guardando() || !fName.trim() || (!sel() && !fCode.trim())"
                        (click)="guardar()">
                  <span class="p-button-label">{{ sel() ? 'Guardar' : 'Crear puesto' }}</span>
                </button>
              }
            </footer>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styleUrls: ['./admin-puestos.component.css'],
})
export class AdminPuestosComponent implements OnInit {
  private api = inject(AdminService);
  private perms = inject(PermissionsService);
  private toast = inject(MessageService);
  private destroyRef = inject(DestroyRef);

  readonly tabs = ADMIN_TABS;
  readonly puedeEscribir = this.perms.has$(Permission.USUARIOS_GESTIONAR);

  readonly puestos = signal<PuestoFila[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sel = signal<PuestoFila | null>(null);
  readonly detalle = signal<PuestoDetalle | null>(null);
  readonly peek = signal(false);
  readonly guardando = signal(false);
  readonly msg = signal<string | null>(null);
  private readonly roles = signal<string[]>([]);

  fDept: string | null = null;
  fOcupacion: string | null = null;
  fName = '';
  fCode = '';
  fDeptEdit: string | null = null;
  fRol: string | null = null;
  fJefe: string | null = null;

  readonly ocupacionOpts = [
    { label: 'Todos', value: null },
    { label: 'Con gente', value: 'con' },
    { label: 'Vacantes', value: 'sin' },
    { label: 'Sin jefe (raíz)', value: 'raiz' },
  ];

  readonly deptOpts = computed(() => [
    { label: 'Todos los departamentos', value: null },
    ...this.deptSoloOpts(),
  ]);

  readonly deptSoloOpts = computed(() => {
    const vistos = new Map<string, string>();
    for (const p of this.puestos()) {
      if (p.department_code) vistos.set(p.department_code, p.department_name ?? p.department_code);
    }
    return [...vistos].map(([value, label]) => ({ label, value }));
  });

  readonly rolOpts = computed(() => [
    { label: 'Ninguno', value: null },
    ...this.roles().map((r) => ({ label: r, value: r })),
  ]);

  readonly jefeOpts = computed(() => [
    { label: 'Ninguno (raíz)', value: null },
    ...this.puestos()
      .filter((p) => p.code !== this.sel()?.code)
      .map((p) => ({ label: p.name, value: p.code })),
  ]);

  readonly visibles = computed(() => {
    let out = this.puestos();
    if (this.fDept) out = out.filter((p) => p.department_code === this.fDept);
    if (this.fOcupacion === 'con') out = out.filter((p) => p.personas > 0);
    if (this.fOcupacion === 'sin') out = out.filter((p) => p.personas === 0);
    if (this.fOcupacion === 'raiz') out = out.filter((p) => !p.reports_to_position_code);
    return out;
  });

  readonly kpis = computed<MetricStripItem[]>(() => {
    const p = this.puestos();
    const conGente = p.filter((x) => x.personas > 0).length;
    const raices = p.filter((x) => !x.reports_to_position_code).length;
    const sinPerfil = p.filter((x) => !x.default_role).length;
    return [
      { label: 'Puestos', value: p.length, format: 'number' },
      { label: 'Con gente', value: conGente, format: 'number' },
      { label: 'Vacantes', value: p.length - conGente, format: 'number' },
      { label: 'Sin perfil que proponer', value: sinPerfil, format: 'number', tone: sinPerfil ? 'warn' : undefined },
      { label: 'Raíz del organigrama', value: raices, format: 'number', sub: 'no cuelgan de nadie' },
    ];
  });

  ngOnInit(): void {
    this.cargar();
    this.api.roles().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.roles.set(r.map((x) => x.role_name)),
      error: () => this.roles.set([]),
    });
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.puestos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.puestos.set(p);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo leer el catálogo de puestos.');
        this.loading.set(false);
      },
    });
  }

  abrir(p: PuestoFila): void {
    this.sel.set(p);
    this.msg.set(null);
    this.fName = p.name;
    this.fCode = p.code;
    this.fDeptEdit = p.department_code;
    this.fRol = p.default_role;
    this.fJefe = p.reports_to_position_code;
    this.detalle.set(null);
    this.peek.set(true);
    this.api.puesto(p.code).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => this.detalle.set(d),
      error: () => this.detalle.set(null),
    });
  }

  abrirAlta(): void {
    this.sel.set(null);
    this.detalle.set(null);
    this.msg.set(null);
    this.fName = '';
    this.fCode = '';
    this.fDeptEdit = null;
    this.fRol = null;
    this.fJefe = null;
    this.peek.set(true);
  }

  cerrar(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) {
      this.sel.set(null);
      this.detalle.set(null);
    }
  }

  /**
   * ⚠️ La arista de mando va en su propio `PUT`: el ciclo lo rechaza un trigger de
   * la base y tiene que poder fallar SIN deshacer el resto de la edición.
   */
  guardar(): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.msg.set(null);

    const body = {
      name: this.fName.trim(),
      department_code: this.fDeptEdit,
      default_role: this.fRol,
    };
    const actual = this.sel();
    const obs = actual
      ? this.api.editarPuesto(actual.code, body)
      : this.api.crearPuesto({ ...body, code: this.fCode.trim() });

    obs.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        const code = actual?.code ?? this.fCode.trim();
        const jefeCambio = actual ? this.fJefe !== actual.reports_to_position_code : !!this.fJefe;
        if (!jefeCambio) return this.listo(actual ? 'Puesto actualizado.' : 'Puesto creado.');
        this.api.setJefeDePuesto(code, this.fJefe).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => this.listo(actual ? 'Puesto y cadena actualizados.' : 'Puesto creado.'),
          error: (e) => {
            this.guardando.set(false);
            this.msg.set(
              `Se guardó el puesto, pero la cadena de mando no: ${this.mensajeDe(e)}`,
            );
            this.cargar();
          },
        });
      },
      error: (e) => {
        this.guardando.set(false);
        this.msg.set(this.mensajeDe(e));
      },
    });
  }

  private listo(detalle: string): void {
    this.guardando.set(false);
    this.toast.add({ severity: 'success', summary: 'Guardado', detail: detalle, life: 4000 });
    this.peek.set(false);
    this.sel.set(null);
    this.cargar();
  }

  private mensajeDe(e: unknown): string {
    const err = e as { error?: { message?: string | string[] } };
    const m = err?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? 'No se pudo guardar. Nada cambió.';
  }
}
