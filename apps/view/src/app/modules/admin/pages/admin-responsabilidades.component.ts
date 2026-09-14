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
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';
import type { PuestoFila, ResponsabilidadDePuesto, ResponsabilidadFila } from '@megadulces/contracts';

import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { AdminService } from '../admin.service';
import { ADMIN_TABS } from '../admin-tabs';

/**
 * `[AU.4]` — **De qué responde cada puesto.**
 *
 * ── ⛔ Lo que esta pantalla NO hace ─────────────────────────────────────────
 * No otorga permisos. Cuando un puesto responde de algo que su perfil no abre,
 * lo **muestra en rojo y manda a `/admin/roles`**. Que la responsabilidad
 * concediera el permiso sería un cuarto sistema de autorización — el defecto
 * que ADR-054 retiró tras medir 4 compuertas muertas por tener la autorización
 * en dos lugares.
 *
 *   el PERMISO decide si podés abrirlo · la RESPONSABILIDAD decide si es tuyo
 *
 * ⚠️ Una responsabilidad **sin `permission_keys` declaradas** no se pinta verde:
 * se declara como no juzgable. Hoy están así las dos de conciliación que agregó
 * `[SN.17]`, y mientras tanto el cruce responsabilidad × permiso no las alcanza.
 */
@Component({
  selector: 'app-admin-responsabilidades',
  standalone: true,
  imports: [
    CommonModule, FormsModule, RouterLink, ButtonModule, TableModule, TagModule, ToastModule,
    SelectModule, MetricStripComponent, SidePeekComponent, LoadStateComponent, PageTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MessageService],
  template: `
    <div class="surf-page in ar-page">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs"></app-page-tabs>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Responsabilidades</h1>
          <p class="surf-page-sub">
            De qué responde cada puesto. <strong>El permiso decide si podés abrirlo; la
            responsabilidad decide si es tuyo.</strong> Asignar acá no concede ningún permiso: si el
            perfil del puesto no abre la bandeja, lo que corresponde es arreglar el rol.
          </p>
        </div>
      </header>

      <app-metric-strip [items]="kpis()" ariaLabel="Resumen de responsabilidades"></app-metric-strip>

      @if (sinClaves().length) {
        <div class="ar-note" role="status">
          <i class="pi pi-question-circle" aria-hidden="true"></i>
          <span>
            <strong>{{ sinClaves().length }}</strong> responsabilidad(es) no declaran qué permiso las
            abre ({{ sinClaves().join(', ') }}), así que el cruce con el perfil
            <strong>no las puede juzgar</strong>. No es que estén bien: es que no se sabe.
          </span>
        </div>
      }

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!filas().length" [skeletonRows]="8"
                      emptyIcon="pi-flag" emptyTitle="Sin responsabilidades en el catálogo"
                      emptyHint="El catálogo se siembra con las bandejas de trabajo que la suite ya conoce."
                      (retry)="cargar()">
        <p-table [value]="filas()" [scrollable]="true" scrollHeight="flex"
                 styleClass="p-datatable-sm ar-table" [rowHover]="true" dataKey="key"
                 [tableStyle]="{ 'min-width': '52rem' }">
          <ng-template #header>
            <tr>
              <th class="ar-sticky">Responsabilidad</th>
              <th>Eje de reparto</th>
              <th>Qué permiso la abre</th>
              <th class="ar-r">Puestos</th>
              <th class="ar-r">Personas directas</th>
            </tr>
          </ng-template>
          <ng-template #body let-r>
            <tr class="ar-row" [class.ar-row-sel]="sel()?.key === r.key" (click)="abrir(r)"
                tabindex="0" (keydown.enter)="abrir(r)" [attr.aria-label]="'Responsabilidad ' + r.label">
              <td class="ar-sticky">
                <span class="ar-nombre">{{ r.label }}</span>
                <span class="ar-code mono">{{ r.key }}</span>
              </td>
              <td>
                @if (r.dimension) {
                  <span class="comm-code">{{ r.dimension }}</span>
                } @else {
                  <span class="ar-falta">sin eje · se reparte por responsabilidad sola</span>
                }
              </td>
              <td>
                @if (r.claves_declaradas) {
                  @for (k of r.permission_keys; track k) {
                    <span class="comm-code ar-mas">{{ k }}</span>
                  }
                } @else {
                  <span class="ar-falta">sin declarar</span>
                }
              </td>
              <td class="ar-r comm-num">{{ r.puestos }}</td>
              <td class="ar-r comm-num">{{ r.personas_directas }}</td>
            </tr>
          </ng-template>
        </p-table>
      </app-load-state>

      <p class="ar-foot">
        <strong>Personas directas</strong> son excepciones asignadas a alguien en particular y no a
        su puesto. Cada una lleva un motivo escrito: es lo que distingue una decisión de un descuido
        seis meses después.
      </p>

      <app-side-peek [open]="peek()" (openChange)="cerrar($event)" [width]="560"
                     [title]="sel()?.label || ''" [subtitle]="sel()?.key || ''">
        @if (peek() && sel(); as r) {
          <div class="ar-peek">
            @if (msg()) {
              <div class="ar-error" role="alert">
                <i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>{{ msg() }}</span>
              </div>
            }

            <p class="ar-desc">{{ r.descripcion || 'Sin descripción en el catálogo.' }}</p>

            <h3>Puestos que responden</h3>
            @if (cargandoPuestos()) {
              <p class="ar-vacio">Leyendo…</p>
            } @else if (!asignados().length) {
              <p class="ar-vacio">
                Nadie responde de esto. El trabajo de esta bandeja no tiene a quién dirigirse.
              </p>
            } @else {
              <ul class="ar-lista">
                @for (a of asignados(); track a.position_code) {
                  <li>
                    <span>{{ a.position_name }}</span>
                    @if (a.es_principal) {
                      <p-tag value="principal" severity="info" styleClass="ar-tag"></p-tag>
                    } @else {
                      <p-tag value="secundario" severity="secondary" styleClass="ar-tag"></p-tag>
                    }
                    @if (a.abre === false) {
                      <p-tag value="su perfil NO lo abre" severity="danger" styleClass="ar-tag"></p-tag>
                    } @else if (a.abre === null) {
                      <p-tag value="no juzgable" severity="secondary" styleClass="ar-tag"></p-tag>
                    }
                    <span class="ar-sub">{{ a.personas }} persona(s)</span>
                    @if (puedeEscribir()) {
                      <button pButton type="button" class="icon-btn-ghost-bad"
                              (click)="quitar(a.position_code)"
                              [attr.aria-label]="'Quitar ' + a.position_name">
                        <span class="pi pi-times" aria-hidden="true"></span>
                      </button>
                    }
                  </li>
                }
              </ul>
            }

            @if (hayNoAbre()) {
              <div class="ar-aviso" role="status">
                <i class="pi pi-shield" aria-hidden="true"></i>
                <div>
                  Algún puesto responde de esto y <strong>su perfil no lo abre</strong>. Esta pantalla
                  no lo repara: darle el permiso desde acá crearía una segunda verdad sobre «puede
                  ver».
                  <a class="ar-link" routerLink="/admin/roles">Arreglar el rol →</a>
                </div>
              </div>
            }

            @if (puedeEscribir()) {
              <div class="ar-asignar">
                <p-select [options]="puestoOpts()" [(ngModel)]="nuevoPuesto" optionLabel="label"
                          optionValue="value" [filter]="true" filterBy="label" appendTo="body"
                          placeholder="Agregar un puesto"></p-select>
                <p-select [options]="rangoOpts" [(ngModel)]="nuevoPrincipal" optionLabel="label"
                          optionValue="value" appendTo="body"></p-select>
                <button pButton type="button" class="p-button-sm" severity="contrast"
                        [disabled]="!nuevoPuesto" (click)="asignar()">
                  <span class="p-button-label">Asignar</span>
                </button>
                <p class="ar-hint">
                  Un solo <strong>principal</strong> por responsabilidad: con dos, «¿quién responde?»
                  tiene dos respuestas y el reparto no sabe a cuál apuntar.
                </p>
              </div>
            }

            <footer class="ar-acc">
              <button pButton type="button" class="p-button-sm p-button-text" (click)="cerrar(false)">
                <span class="p-button-label">Cerrar</span>
              </button>
            </footer>
          </div>
        }
      </app-side-peek>
    </div>
  `,
  styleUrls: ['./admin-responsabilidades.component.css'],
})
export class AdminResponsabilidadesComponent implements OnInit {
  private api = inject(AdminService);
  private perms = inject(PermissionsService);
  private toast = inject(MessageService);
  private destroyRef = inject(DestroyRef);

  readonly tabs = ADMIN_TABS;
  readonly puedeEscribir = this.perms.has$(Permission.USUARIOS_GESTIONAR);

  readonly filas = signal<ResponsabilidadFila[]>([]);
  readonly puestos = signal<PuestoFila[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly sel = signal<ResponsabilidadFila | null>(null);
  readonly peek = signal(false);
  readonly msg = signal<string | null>(null);
  readonly cargandoPuestos = signal(false);

  /** Puesto × esta responsabilidad, armado cruzando el catálogo con cada puesto. */
  readonly asignados = signal<
    Array<{ position_code: string; position_name: string; es_principal: boolean; abre: boolean | null; personas: number }>
  >([]);

  nuevoPuesto: string | null = null;
  nuevoPrincipal = false;

  readonly rangoOpts = [
    { label: 'Secundario', value: false },
    { label: 'Principal', value: true },
  ];

  readonly puestoOpts = computed(() => {
    const yaEstan = new Set(this.asignados().map((a) => a.position_code));
    return this.puestos()
      .filter((p) => !yaEstan.has(p.code))
      .map((p) => ({ label: p.name, value: p.code }));
  });

  readonly sinClaves = computed(() => this.filas().filter((r) => !r.claves_declaradas).map((r) => r.key));

  readonly hayNoAbre = computed(() => this.asignados().some((a) => a.abre === false));

  readonly kpis = computed<MetricStripItem[]>(() => {
    const f = this.filas();
    const sinPuesto = f.filter((r) => r.puestos === 0).length;
    return [
      { label: 'En el catálogo', value: f.length, format: 'number' },
      { label: 'Con responsable', value: f.length - sinPuesto, format: 'number' },
      { label: 'Sin nadie', value: sinPuesto, format: 'number', tone: sinPuesto ? 'warn' : undefined },
      { label: 'Sin eje de reparto', value: f.filter((r) => !r.dimension).length, format: 'number' },
      {
        label: 'No juzgables',
        value: this.sinClaves().length,
        format: 'number',
        sub: 'no declaran su permiso',
      },
    ];
  });

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.responsabilidades().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.filas.set(r);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.message ?? 'No se pudo leer el catálogo.');
        this.loading.set(false);
      },
    });
    this.api.puestos().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => this.puestos.set(p),
      error: () => this.puestos.set([]),
    });
  }

  abrir(r: ResponsabilidadFila): void {
    this.sel.set(r);
    this.msg.set(null);
    this.nuevoPuesto = null;
    this.nuevoPrincipal = false;
    this.peek.set(true);
    this.recargarAsignados(r.key);
  }

  /**
   * ⚠️ No hay endpoint «qué puestos responden de X»: hay «de qué responde el
   * puesto Y». Se cruza sobre los puestos que YA declaran responsabilidades, que
   * es el dato que la lista trae, en vez de preguntar por los 57.
   */
  private recargarAsignados(key: string): void {
    this.cargandoPuestos.set(true);
    const conResp = this.puestos().filter((p) => p.responsabilidades > 0);
    if (!conResp.length) {
      this.asignados.set([]);
      this.cargandoPuestos.set(false);
      return;
    }
    let pendientes = conResp.length;
    const acc: Array<{ position_code: string; position_name: string; es_principal: boolean; abre: boolean | null; personas: number }> = [];
    for (const p of conResp) {
      this.api
        .responsabilidadesDePuesto(p.code)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (rs: ResponsabilidadDePuesto[]) => {
            const m = rs.find((x) => x.responsibility_key === key);
            if (m) {
              acc.push({
                position_code: p.code,
                position_name: p.name,
                es_principal: m.es_principal,
                abre: m.abre,
                personas: p.personas,
              });
            }
            if (--pendientes === 0) this.cerrarCarga(acc);
          },
          error: () => {
            if (--pendientes === 0) this.cerrarCarga(acc);
          },
        });
    }
  }

  private cerrarCarga(acc: Array<{ position_code: string; position_name: string; es_principal: boolean; abre: boolean | null; personas: number }>): void {
    acc.sort((a, b) => Number(b.es_principal) - Number(a.es_principal) || a.position_name.localeCompare(b.position_name));
    this.asignados.set(acc);
    this.cargandoPuestos.set(false);
  }

  cerrar(abierto: boolean): void {
    this.peek.set(abierto);
    if (!abierto) {
      this.sel.set(null);
      this.asignados.set([]);
    }
  }

  asignar(): void {
    const r = this.sel();
    if (!r || !this.nuevoPuesto) return;
    this.api
      .asignarAPuesto(this.nuevoPuesto, r.key, this.nuevoPrincipal)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.add({ severity: 'success', summary: 'Asignada', detail: r.label, life: 3500 });
          this.nuevoPuesto = null;
          this.nuevoPrincipal = false;
          this.cargar();
          this.recargarAsignados(r.key);
        },
        error: (e) => this.msg.set(this.mensajeDe(e)),
      });
  }

  quitar(positionCode: string): void {
    const r = this.sel();
    if (!r) return;
    this.api
      .quitarDePuesto(positionCode, r.key)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cargar();
          this.recargarAsignados(r.key);
        },
        error: (e) => this.msg.set(this.mensajeDe(e)),
      });
  }

  private mensajeDe(e: unknown): string {
    const err = e as { error?: { message?: string | string[] } };
    const m = err?.error?.message;
    if (Array.isArray(m)) return m.join(' · ');
    return m ?? 'No se pudo guardar. Nada cambió.';
  }
}
