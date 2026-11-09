import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type { HrBajaPlazaDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { RhMarcoComponent } from '../components/rh-marco.component';
import { RhAsistenciaEstado } from '../rh-asistencia.estado';
import { RhService, rhError } from '../rh.service';
import { fechaHoraMx } from '../reclutamiento-formato';

/**
 * Fase RH · `[RH.7.2]` — Bajas (`/rh/asistencia/bajas`): la papelera de empleados de Mega Talento, por plaza. Quien está
 * aquí no cuenta en el reporte de esa plaza (sin faltas de quien ya se fue). Lo primero es quien SIGUE checando
 * después de su baja: o la baja fue un error, o alguien usa su código. De aquí se reactiva.
 *
 * La baja se da desde la ficha de la persona en Checadas, con motivo. Es baja EN LA PLAZA: quien rota sigue activo en
 * las otras. No borra la huella del reloj físico.
 */
@Component({
  selector: 'app-rh-bajas',
  standalone: true,
  imports: [
    FormsModule, SelectModule, InputTextModule, ButtonModule, TableModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent,
    RhMarcoComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rb-page">
      <app-rh-marco [barra]="false" [franja]="false" />
      <section class="rb-bar" aria-label="Plaza">
        <p-select [options]="est.sitios()" optionLabel="name" optionValue="code" [ngModel]="est.sitio()" (ngModelChange)="est.setSitio($event)"
                  placeholder="Plaza" appendTo="body" ariaLabel="Plaza" class="rb-plaza" />
        <input pInputText type="search" class="rb-buscar" [ngModel]="buscar()" (ngModelChange)="buscar.set($event)"
               placeholder="Buscar por nombre, código o sección" aria-label="Buscar en las bajas" />
        <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        <app-freshness-pill measures="fetch" [since]="leidoEn()" label="Leído" />
      </section>

      <app-load-state [loading]="loading() && !lista()" [error]="error()" (retry)="cargar()">
        <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Bajas de la plaza" />
        <section class="rb-card" aria-label="Bajas de la plaza">
          <p class="rb-nota">Quien está aquí <b>no cuenta en el reporte de esta plaza</b>: no le salen faltas. La baja se da desde su ficha en
            Checadas, con motivo. Quien sigue checando después de su baja aparece primero: o la baja fue un error, o alguien usa su código.</p>
          @if (aviso(); as a) { <p class="rb-aviso" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
          @if (!filas().length) {
            <p class="rb-vacio">{{ lista()?.length ? 'Nadie coincide con «' + buscar() + '».' : 'Nadie está de baja en esta plaza.' }}</p>
          } @else {
            <!-- Con flechas se recorren las filas; Enter (o clic) en una fila pide confirmar su reactivación (D.7). -->
            <p-table [value]="filas()" dataKey="person_code" class="dt-stack surf-table surf-table--plain surf-table--sticky" size="small"
                     [rowHover]="true" [tableStyle]="{ 'min-width': '52rem' }" [selectionMode]="gestiona() ? 'single' : undefined"
                     (onRowSelect)="confirmar.set($any($event).data?.person_code ?? null)">
              <ng-template #header>
                <tr>
                  <th scope="col">Clv</th><th scope="col">Nombre</th><th scope="col">Sección</th><th scope="col">De baja desde</th>
                  <th scope="col">Motivo</th><th scope="col" class="comm-num">Checadas después</th><th scope="col"><span class="sr-only">Acción</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-b>
                    <tr [class.rb-sigue]="b.checadas_desde_baja > 0" [pSelectableRow]="b">
                      <td class="mono" role="cell" data-label="Clv">{{ b.person_code }}</td>
                      <td role="cell" data-label="Nombre"><b>{{ b.nombre || 'Sin persona ligada' }}</b>@if (b.promotora) { <span class="rb-tag">promotora</span> }</td>
                      <td role="cell" data-label="Sección">{{ b.seccion || 'sin sección' }}</td>
                      <td class="mono" role="cell" data-label="De baja desde">{{ fecha(b.desde) }}</td>
                      <td role="cell" data-label="Motivo">
                        @if (b.origen === 'mega_talento') { <span class="rb-muted">Llegó de baja desde Mega Talento</span> }
                        @else { {{ b.motivo || '—' }}@if (b.por) { <span class="rb-muted"> · {{ b.por }}</span> } }
                      </td>
                      <td class="mono comm-num" role="cell" data-label="Checadas después">
                        @if (b.checadas_desde_baja > 0) { <span class="rb-bad">{{ b.checadas_desde_baja }}</span> · la última {{ fecha(b.ultima_checada) }} }
                        @else { 0 }
                      </td>
                      <td class="rb-acc" role="cell">
                        @if (gestiona()) {
                          @if (confirmar() === b.person_code) {
                            <p-button label="Sí, reactivar" size="small" [loading]="guardando()" (onClick)="reactivar(b)" />
                            <p-button label="No" [text]="true" severity="secondary" size="small" (onClick)="confirmar.set(null)" />
                          } @else {
                            <p-button label="Reactivar" severity="secondary" [outlined]="true" size="small" (onClick)="confirmar.set(b.person_code)" />
                          }
                        }
                      </td>
                    </tr>
              </ng-template>
            </p-table>
          }
        </section>
      </app-load-state>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rb-page { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); }
    .rb-bar { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .rb-plaza { min-width: 14rem; }
    .rb-buscar { flex: 1 1 16rem; max-width: 24rem; }
    .rb-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; padding-bottom: var(--sp-2); }
    .rb-nota { margin: 0; padding: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); max-width: 90ch; line-height: 1.5; }
    .rb-nota b { color: var(--text-main); }
    .rb-aviso { margin: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-sm); color: var(--ok-soft-fg); }
    .rb-aviso.bad { color: var(--bad-fg); }
    .rb-vacio { margin: 0; padding: var(--sp-4) var(--sp-3); color: var(--text-muted); font-size: var(--fs-sm); }
    tr.rb-sigue td { background: var(--warn-soft-bg); }
    .rb-tag { display: inline-block; margin-left: var(--sp-1); font: 700 var(--fs-micro)/1 var(--font-mono); padding: 2px 4px; border-radius: var(--r-sm);
      background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .rb-muted { color: var(--text-muted); }
    .rb-bad { color: var(--bad-fg); font-weight: 700; }
    .rb-acc { text-align: right; white-space: nowrap; }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    @media (max-width: 40rem) { .rb-page { padding: var(--sp-3); } }
  `],
})
export class RhBajasComponent {
  readonly est = inject(RhAsistenciaEstado);
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);

  readonly lista = signal<HrBajaPlazaDto[] | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly buscar = signal('');
  readonly confirmar = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly aviso = signal<{ texto: string; mal: boolean } | null>(null);
  private seq = 0;

  readonly gestiona = computed(() => this.perms.has(Permission.HR_DEVICES_GESTIONAR));
  /** Quien sigue checando va primero; después, la baja más reciente (el orden del servidor). */
  readonly filas = computed(() => {
    const todas = filtrarPorBusqueda(this.lista() ?? [], this.buscar(), (b) => [b.person_code, b.nombre ?? '', b.seccion ?? '']);
    return [...todas].sort((a, b) => Number(b.checadas_desde_baja > 0) - Number(a.checadas_desde_baja > 0));
  });
  readonly siguen = computed(() => (this.lista() ?? []).filter((b) => b.checadas_desde_baja > 0));
  readonly leidoEn = signal<Date | null>(null);
  /** Lo primero que se ve: cuántas bajas y cuántas siguen checando (lo que hay que revisar). */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const l = this.lista();
    if (!l) return [];
    const n = this.siguen().length;
    return [
      { label: 'De baja en la plaza', value: l.length },
      { label: 'Siguen checando', value: n, tone: n ? 'warn' : 'muted', sub: n ? '¿la baja fue un error?' : 'en los últimos 30 días' },
    ];
  });
  readonly fecha = fechaHoraMx;

  constructor() {
    // Sólo la plaza dispara la lectura; lo que `cargar` toca adentro no se rastrea.
    effect(() => { if (this.est.sitio()) untracked(() => this.cargar()); });
  }

  cargar(): void {
    const site = this.est.sitio();
    if (!site) return;
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.bajas(site).subscribe({
      next: (l) => { if (mi !== this.seq) return; this.lista.set(l); this.leidoEn.set(new Date()); this.loading.set(false); },
      error: (e) => { if (mi !== this.seq) return; this.error.set(rhError(e, 'No se pudieron leer las bajas.')); this.loading.set(false); },
    });
  }

  reactivar(b: HrBajaPlazaDto): void {
    const site = this.est.sitio();
    if (!site || this.guardando()) return;
    this.guardando.set(true);
    this.api.reactivar({ site_code: site, person_code: b.person_code }).subscribe({
      next: () => {
        this.guardando.set(false);
        this.confirmar.set(null);
        this.aviso.set({ texto: `${b.nombre || 'El código ' + b.person_code} vuelve al reporte de la plaza.`, mal: false });
        this.cargar();
        this.est.asegurar(true);
      },
      error: (e) => { this.guardando.set(false); this.aviso.set({ texto: rhError(e, 'No se pudo reactivar.'), mal: true }); },
    });
  }
}
