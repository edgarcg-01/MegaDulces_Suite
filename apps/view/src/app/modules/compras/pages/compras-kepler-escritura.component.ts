import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { TableModule } from 'primeng/table';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ToastModule } from 'primeng/toast';
import { ButtonModule } from 'primeng/button';
import { ConfirmationService, MessageService } from 'primeng/api';
import { warehouseName } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ComprasService, KeplerSwitchRow, KeplerTipo } from '../compras.service';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { SEGUIMIENTO_COMPRA_TABS } from '../seguimiento-compra-tabs';

/** Una sucursal con sus dos tipos lado a lado: es lo que se compara al decidir. */
interface FilaSucursal { sucursal: string; compra: KeplerSwitchRow; traspaso: KeplerSwitchRow }

/**
 * `[PQ.20]` **Escritura a Kepler** — encender, apagar y topar sin desplegar.
 *
 * Antes la palanca era el secreto k3s `kepler-push` + reiniciar `api` (Edgar, 2026-10-28: *«no
 * quiero tener que estar haciendo deploy para apagar o encender la escritura»*). Ahora vive en
 * `commercial.kepler_push_switch` y el servidor la lee en cada envío: el cambio vale en la
 * siguiente requisición que se apruebe.
 *
 * Jerarquía: primario = cuántas sucursales escriben hoy, por tipo · secundario = el interruptor
 * de cada una · terciario = quién lo cambió y cuándo.
 *
 * ⛔ «Encendida» en la Suite no basta: si el secreto no trae la conexión o la plantilla de ese
 * servidor, el envío rebota igual. La fila lo DICE en vez de pintarse como si escribiera.
 */
@Component({
  selector: 'app-compras-kepler-escritura',
  standalone: true,
  imports: [DatePipe, FormsModule, ToggleSwitchModule, InputNumberModule, TableModule, ConfirmDialogModule, ToastModule, ButtonModule,
    MetricStripComponent, FreshnessPillComponent, LoadStateComponent, PageTabsComponent, SucursalPipe],
  providers: [ConfirmationService, MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Escritura a Kepler</h1>
          <p class="surf-page-sub">Qué sucursales reciben en Kepler las requisiciones que se aprueban en la Suite. El cambio vale en la siguiente aprobación, sin reiniciar nada.</p>
        </div>
      </header>

      <app-page-tabs [tabs]="apartadoTabs" />

      <app-load-state [loading]="loading()" [error]="error()" [isEmpty]="!filas().length" [skeletonRows]="9"
                      emptyTitle="Sin sucursales" (retry)="cargar()">
        @if (!migrada()) {
          <p class="ke-aviso" role="status">
            <span class="pi pi-info-circle" aria-hidden="true"></span>
            La tabla del interruptor todavía no está en la base de producción: hoy manda la configuración del servidor y aquí no se puede cambiar nada.
          </p>
        }

        <div class="ke-top">
          <app-metric-strip [items]="metricas()" ariaLabel="Sucursales que escriben en Kepler" />
          <div class="ke-acc">
            <app-freshness-pill measures="fetch" [since]="leidoEn()" label="estado leído" />
            <button pButton type="button" class="p-button-sm p-button-text" (click)="cargar()" [disabled]="loading()">
              <span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span>
              <span class="p-button-label">Actualizar</span>
            </button>
          </div>
        </div>

        <p-table [value]="filas()" styleClass="p-datatable-sm surf-table surf-table--plain" [attr.aria-label]="'Escritura a Kepler por sucursal'">
          <ng-template #header>
            <tr>
              <th scope="col">Sucursal</th>
              <th scope="col">Compra</th>
              <th scope="col" class="comm-num">Tope diario</th>
              <th scope="col">Traspaso</th>
              <th scope="col" class="comm-num">Tope diario</th>
              <th scope="col">Último cambio</th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr>
              <td class="ke-suc">{{ f.sucursal | sucursal }}</td>
              @for (t of tipos; track t) {
                <td>
                  <div class="ke-sw">
                    <p-toggleswitch [ngModel]="f[t].encendida" [disabled]="!puedeCambiar() || guardando() === f.sucursal + t"
                                    (ngModelChange)="cambiar(f[t], $event)"
                                    [ariaLabel]="(t === 'compra' ? 'Compra' : 'Traspaso') + ' en ' + nombre(f.sucursal)" />
                    <span [class.ke-on]="f[t].encendida">{{ f[t].encendida ? 'Escribe' : 'Apagada' }}</span>
                  </div>
                  @if (f[t].encendida && !f[t].configurada) {
                    <div class="ke-bad ke-falta">Rebota: falta {{ f[t].falta }} en el servidor</div>
                  }
                </td>
                <td class="comm-num">
                  <p-inputnumber [ngModel]="f[t].tope_dia" [min]="1" [useGrouping]="false" placeholder="Sin tope"
                                 [disabled]="!puedeCambiar() || guardando() === f.sucursal + t"
                                 [ariaLabel]="'Tope diario de ' + t + ' en ' + nombre(f.sucursal)"
                                 inputStyleClass="ke-tope" (onBlur)="topar(f[t], $any($event.target).value)"
                                 (keydown.enter)="topar(f[t], $any($event.target).value)" />
                </td>
              }
              <td class="ke-quien">
                @if (ultimo(f); as u) {
                  {{ u.updated_by || 'sistema' }} <span class="ke-faint">· {{ u.updated_at | date:'dd/MM/yy HH:mm' }}</span>
                } @else { <span class="ke-faint">—</span> }
              </td>
            </tr>
          </ng-template>
        </p-table>

        <p class="ke-pie">
          Tope vacío = sin tope. Con tope, la Suite deja de escribir en esa sucursal al llegar a N documentos en el día (contados en Kepler).
          @if (!puedeCambiar()) { <b>Sólo lectura:</b> cambiarlo pide la llave «Encender la escritura a Kepler». }
        </p>
      </app-load-state>
    </div>
    <p-confirmdialog />
    <p-toast />
  `,
  styles: [`
    :host { display: block; }
    .ke-top { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); margin: 0 0 var(--sp-4); }
    .ke-acc { display: flex; align-items: center; gap: var(--sp-2); }
    .ke-bad { color: var(--bad-fg); }
    .ke-aviso { display: flex; gap: var(--sp-2); align-items: flex-start; margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
    .ke-suc { font-weight: 600; }
    .ke-sw { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
    .ke-on { color: var(--text-main); font-weight: 600; }
    .ke-falta { font-size: var(--fs-xs); margin-top: var(--sp-1); }
    .ke-quien { font-size: var(--fs-sm); color: var(--text-muted); }
    .ke-faint { color: var(--text-faint); }
    .ke-pie { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    :host ::ng-deep .ke-tope { width: 6rem; text-align: right; font-variant-numeric: tabular-nums; }
  `],
})
export class ComprasKeplerEscrituraComponent implements OnInit {
  readonly apartadoTabs = SEGUIMIENTO_COMPRA_TABS;
  readonly tipos: KeplerTipo[] = ['compra', 'traspaso'];
  private readonly api = inject(ComprasService);
  private readonly perms = inject(PermissionsService);
  private readonly confirm = inject(ConfirmationService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly rows = signal<KeplerSwitchRow[]>([]);
  readonly migrada = signal(true);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** `sucursal+tipo` que se está guardando: sus controles quedan quietos hasta la respuesta. */
  readonly guardando = signal<string | null>(null);

  readonly puedeCambiar = computed(() => this.migrada() && this.perms.has(Permission.COMPRAS_KEPLER_ESCRITURA));

  readonly filas = computed<FilaSucursal[]>(() => {
    const por = new Map<string, Partial<FilaSucursal>>();
    for (const r of this.rows()) {
      const f = por.get(r.sucursal) ?? { sucursal: r.sucursal };
      f[r.tipo] = r;
      por.set(r.sucursal, f);
    }
    return [...por.values()].filter((f): f is FilaSucursal => !!f.compra && !!f.traspaso);
  });
  readonly rebotan = computed(() => this.rows().filter((r) => r.encendida && !r.configurada).length);
  readonly leidoEn = signal<Date | null>(null);
  /** Primario: cuántas escriben, por tipo. Rebotan sólo se pinta en rojo cuando hay. */
  readonly metricas = computed<MetricStripItem[]>(() => {
    const n = this.filas().length;
    const reb = this.rebotan();
    return [
      { label: 'Compra escribe en', value: `${this.encendidas('compra')} de ${n}`, format: 'text', sub: 'sucursales' },
      { label: 'Traspaso escribe en', value: `${this.encendidas('traspaso')} de ${n}`, format: 'text', sub: 'sucursales' },
      { label: 'Encendidas que rebotan', value: reb, format: 'number', tone: reb ? 'bad' : 'muted', sub: reb ? 'falta configuración en el servidor' : 'ninguna' },
    ];
  });

  encendidas(t: KeplerTipo): number { return this.rows().filter((r) => r.tipo === t && r.encendida).length; }
  nombre(s: string): string { return warehouseName(s); }
  ultimo(f: FilaSucursal): KeplerSwitchRow | null {
    const c = [f.compra, f.traspaso].filter((r) => r.updated_at);
    return c.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
  }

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.keplerSwitch().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.rows.set(r.rows ?? []); this.migrada.set(!!r.migrada); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.message || 'No respondió el servidor.'); this.loading.set(false); },
    });
  }

  /** Encender pide confirmar (escribe en el ERP); apagar es inmediato. */
  cambiar(r: KeplerSwitchRow, encendida: boolean): void {
    if (!encendida) { this.guardar(r, { encendida: false, tope_dia: r.tope_dia }); return; }
    // El switch ya se movió en pantalla: si cancela, se recarga el estado real (reject).
    this.confirm.confirm({
      header: `Encender ${r.tipo} en ${this.nombre(r.sucursal)}`,
      message: `Cada requisición de ${r.tipo} de ${this.nombre(r.sucursal)} que se apruebe se escribirá en Kepler`
        + (r.tope_dia ? `, hasta ${r.tope_dia} por día.` : ', sin tope diario.')
        + (r.configurada ? '' : ` Ojo: hoy rebotaría, falta ${r.falta} en el servidor.`),
      acceptLabel: 'Encender', rejectLabel: 'Cancelar',
      accept: () => this.guardar(r, { encendida: true, tope_dia: r.tope_dia }),
      reject: () => this.cargar(),
    });
  }

  topar(r: KeplerSwitchRow, valor: string): void {
    const limpio = String(valor ?? '').replace(/[^\d]/g, '');
    const tope = limpio ? Number(limpio) : null;
    if (tope === r.tope_dia || (tope !== null && tope < 1)) return;
    this.guardar(r, { encendida: r.encendida, tope_dia: tope });
  }

  private guardar(r: KeplerSwitchRow, body: { encendida: boolean; tope_dia: number | null }): void {
    if (this.guardando()) return;
    this.guardando.set(r.sucursal + r.tipo);
    this.api.setKeplerSwitch(r.sucursal, r.tipo, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.rows.set(res.rows ?? []);
        this.leidoEn.set(new Date());
        this.guardando.set(null);
        this.toast.add({ severity: 'success', summary: `${this.nombre(r.sucursal)} · ${r.tipo}`,
          detail: body.encendida ? `Escribe en Kepler${body.tope_dia ? `, tope ${body.tope_dia}/día` : ', sin tope'}` : 'Apagada' });
      },
      error: (e) => {
        this.guardando.set(null);
        this.toast.add({ severity: 'error', summary: 'No se guardó', detail: e?.error?.message || 'El servidor no respondió. Sigue como estaba.' });
        this.cargar();
      },
    });
  }
}
