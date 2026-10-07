import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import type { HrLotePendienteDto, HrOrdenDto, HrRelojBody, HrRelojDto, HrRelojEstadoDto, HrSiteDto } from '@megadulces/contracts';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { RhService, SEMAFORO_LABEL, haceCuanto, rhError } from '../rh.service';

/**
 * Fase RH · `[RH.1.7]` — Relojes checadores (`/rh/relojes`). Antes: el semáforo, el padrón de relojes, los lotes
 * pendientes y los cambios en relojes de Mega Talento.
 *
 * Regla de producto heredada: la pantalla nunca parece al día cuando no lo está. El semáforo mide la última SEÑAL
 * del lector (no la última checada): un reloj vivo sin nadie checando es verde; uno sin señal es rojo. Falta de
 * dato NO es falta del empleado, pero el atraso tiene que verse.
 */
interface FormReloj { serie: string; nuevo: boolean; site_code: string; label: string; ip_address: string; port: number; ingest_mode: 'agente' | 'push' | 'manual'; comm_key: number; is_active: boolean; is_paused: boolean; notes: string }

@Component({
  selector: 'app-rh-relojes',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, InputTextModule, ButtonModule, LoadStateComponent, SidePeekComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rr-page">
      <header class="rr-head">
        <div>
          <h1>Relojes checadores</h1>
          <p>Lo que importa es la última señal del lector: un reloj sin señal puede tener checadas guardadas que todavía no llegan.</p>
        </div>
        <div class="rr-head-btns">
          @if (gestiona()) { <p-button icon="pi pi-plus" label="Agregar reloj" severity="secondary" [outlined]="true" (onClick)="editar(null)" /> }
          <p-button icon="pi pi-refresh" label="Actualizar" severity="secondary" [outlined]="true" [loading]="loading()" (onClick)="cargar()" />
        </div>
      </header>

      <section class="rr-kpis" aria-label="Resumen">
        @for (k of resumen(); track k.s) {
          <div class="rr-kpi" [attr.data-s]="k.s"><b>{{ k.n }}</b><span>{{ semaforoLabel[k.s] }}</span></div>
        }
      </section>

      <app-load-state [loading]="loading() && !estado().length" [error]="error()" [isEmpty]="!loading() && !error() && !estado().length"
                      emptyIcon="pi-clock" emptyTitle="No hay relojes dados de alta" [emptyHint]="gestiona() ? 'Agrega el primero con su número de serie.' : null" (retry)="cargar()">
        <section class="rr-list" aria-label="Relojes">
          <div class="rr-wrap dt-scope">
            <table class="rr-table dt-stack">
              <thead><tr><th>Reloj</th><th>Sitio</th><th>Estado</th><th>Última señal</th><th class="opc">Última checada</th><th class="num opc">Checadas reloj / base</th><th>Problema</th></tr></thead>
              <tbody>
                @for (r of estado(); track r.serie) {
                  <tr (click)="gestiona() && editar(r.serie)" [attr.tabindex]="gestiona() ? 0 : null" (keydown.enter)="gestiona() && editar(r.serie)">
                    <td class="dt-id" role="cell" data-label="Reloj"><b>{{ r.alias || r.serie }}</b><small class="mono">{{ r.serie }}@if (r.ip) { · {{ r.ip }} }</small></td>
                    <td role="cell" data-label="Sitio">{{ nombreSitio(r.sucursalId) }}</td>
                    <td role="cell" data-label="Estado"><span class="pill" [attr.data-s]="r.semaforo">{{ semaforoLabel[r.semaforo] }}</span></td>
                    <td class="mono" role="cell" data-label="Última señal">{{ hace(r.segundosSinSenal) }}</td>
                    <td class="mono opc" role="cell" data-label="Última checada">{{ r.ultimaChecada ? (r.ultimaChecada | date: 'd MMM HH:mm') : '—' }}</td>
                    <td class="num opc" role="cell" data-label="Checadas reloj / base">{{ r.logsEnReloj ?? '—' }} / {{ r.logsEnBase ?? '—' }}</td>
                    <td class="rr-err" role="cell" data-label="Problema">{{ r.ultimoError || '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </app-load-state>

      @if (lotes().length) {
        <section class="rr-card" aria-label="Lotes sin aplicar">
          <h2>Llegaron checadas que no se aplicaron</h2>
          <p class="rr-nota">El dato no se perdió: está guardado. Se aplica en cuanto la serie esté dada de alta o el reloj salga de pausa.</p>
          <ul class="rr-lotes">
            @for (l of lotes(); track l.serial_number + l.status) {
              <li>
                <span class="mono">{{ l.serial_number }}</span> · {{ l.status === 'sin_registrar' ? 'serie sin dar de alta' : 'reloj en pausa' }}
                · {{ l.lotes }} lote(s), {{ l.registros }} checadas · último {{ l.ultimo | date: 'd MMM HH:mm' }}
                @if (gestiona()) {
                  @if (l.status === 'sin_registrar') { <p-button label="Dar de alta" size="small" [text]="true" (onClick)="editarNueva(l.serial_number)" /> }
                  <p-button label="Aplicar ahora" size="small" [text]="true" [loading]="ocupado()" (onClick)="reprocesar(l.serial_number)" />
                }
              </li>
            }
          </ul>
        </section>
      }

      <section class="rr-card" aria-label="Cambios en los relojes">
        <h2>Cambios en los relojes</h2>
        <p class="rr-nota">El cambio lo ejecuta el lector en el equipo de la plaza; aquí se ve si ya quedó. Sólo se envía a los relojes donde la persona está registrada.</p>
        <div class="rr-ordenes-ctl">
          <p-select [options]="sitios()" optionLabel="name" optionValue="code" [ngModel]="sitioOrdenes()" (ngModelChange)="setSitioOrdenes($event)"
                    placeholder="Sitio" appendTo="body" ariaLabel="Sitio de los cambios" />
          <input pInputText [ngModel]="persona()" (ngModelChange)="persona.set($event)" placeholder="Número de la persona" aria-label="Número de la persona" (keydown.enter)="cargarOrdenes()" />
          <p-button label="Ver" size="small" severity="secondary" [outlined]="true" (onClick)="cargarOrdenes()" />
          @if (gestiona() && persona().trim()) {
            <input pInputText [ngModel]="nombreNuevo()" (ngModelChange)="nombreNuevo.set($event)" placeholder="Nombre nuevo en el reloj" aria-label="Nombre nuevo" maxlength="23" />
            <p-button label="Renombrar" size="small" [disabled]="!nombreNuevo().trim()" [loading]="ocupado()" (onClick)="renombrar()" />
            <p-button label="Volver a darlo de alta" size="small" [text]="true" [loading]="ocupado()" (onClick)="restaurar()" />
          }
        </div>
        @if (avisoOrdenes(); as a) { <p class="rr-banner" [class.bad]="a.mal" role="status">{{ a.texto }}</p> }
        @if (ordenes().length) {
          <ul class="rr-ordenes">
            @for (o of ordenes(); track o.id) {
              <li>
                <span class="pill" [attr.data-o]="o.status">{{ o.status }}</span>
                {{ o.command }} #{{ o.person_code }} en {{ o.label || o.serial_number }}
                @if (o.command === 'renombrar' && o.payload?.['nombre']) { → «{{ o.payload?.['nombre'] }}» }
                <small>{{ o.requested_at | date: 'd MMM HH:mm' }}@if (o.detail) { · {{ o.detail }} }</small>
                @if (gestiona() && o.status === 'pendiente') { <p-button label="Cancelar" size="small" [text]="true" (onClick)="cancelar(o)" /> }
              </li>
            }
          </ul>
        } @else if (ordenesCargadas()) {
          <p class="rr-nota">Sin cambios recientes en este sitio.</p>
        }
      </section>

      <app-side-peek [open]="peek()" (openChange)="peek.set($event)" [title]="form()?.nuevo ? 'Agregar reloj' : 'Editar reloj'" [subtitle]="form()?.serie ?? null">
        @if (form(); as f) {
          <form class="rr-form" (ngSubmit)="guardar()" aria-label="Datos del reloj">
            @if (f.nuevo) { <label>Número de serie <input pInputText name="serie" [(ngModel)]="f.serie" required /></label> }
            <label>Sitio de checado
              <p-select [options]="sitios()" optionLabel="name" optionValue="code" name="sitio" [(ngModel)]="f.site_code" appendTo="body" ariaLabel="Sitio de checado" />
            </label>
            <label>Nombre <input pInputText name="alias" [(ngModel)]="f.label" /></label>
            <label>IP <input pInputText name="ip" [(ngModel)]="f.ip_address" /></label>
            <label>Puerto <input pInputText type="number" name="puerto" [(ngModel)]="f.port" /></label>
            <label>Modo
              <p-select [options]="modos" optionLabel="label" optionValue="value" name="modo" [(ngModel)]="f.ingest_mode" appendTo="body" ariaLabel="Modo" />
            </label>
            <label>Clave de comunicación <input pInputText type="number" name="clave" [(ngModel)]="f.comm_key" /></label>
            <label class="rr-check"><input type="checkbox" name="activo" [(ngModel)]="f.is_active" /> Activo</label>
            <label class="rr-check"><input type="checkbox" name="pausa" [(ngModel)]="f.is_paused" /> En pausa (guarda lo que llegue sin aplicarlo)</label>
            <label>Nota <input pInputText name="nota" [(ngModel)]="f.notes" /></label>
            @if (avisoForm(); as a) { <p class="rr-banner bad" role="alert">{{ a }}</p> }
            <div class="rr-form-btns">
              <p-button type="submit" label="Guardar" [loading]="ocupado()" />
              <p-button label="Cancelar" [text]="true" severity="secondary" (onClick)="peek.set(false)" />
            </div>
          </form>
        }
      </app-side-peek>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .rr-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); }
    .rr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .rr-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); letter-spacing: -0.01em; }
    .rr-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); max-width: 70ch; }
    .rr-head-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    .rr-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); }
    .rr-kpi { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); }
    .rr-kpi b { font: 700 var(--fs-h2)/1 var(--font-mono); color: var(--text-main); }
    .rr-kpi span { font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-kpi[data-s='mudo'] b { color: var(--bad-fg); }
    .rr-kpi[data-s='atrasado'] b { color: var(--warn-fg); }
    .rr-list, .rr-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); min-width: 0; }
    .rr-card { padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
    .rr-card h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-main); }
    .rr-nota { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-wrap { overflow: auto; }
    .rr-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .rr-table th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600; color: var(--text-muted); font-size: var(--fs-micro); padding: var(--sp-2) var(--sp-3); white-space: nowrap; }
    .rr-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); vertical-align: top; }
    .rr-table tbody tr:hover { background: var(--surface-hover-bg); }
    .rr-table tbody tr[tabindex] { cursor: pointer; }
    .rr-table tbody tr:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
    td small { display: block; color: var(--text-muted); font-size: var(--fs-xs); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .rr-err { color: var(--bad-soft-fg); font-size: var(--fs-xs); overflow-wrap: anywhere; max-width: 22rem; }
    .pill { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); white-space: nowrap; background: var(--surface-2); color: var(--text-muted); }
    .pill[data-s='ok'], .pill[data-o='hecho'] { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .pill[data-s='atrasado'], .pill[data-o='pendiente'] { background: var(--warn-soft-bg); color: var(--warn-soft-fg); }
    .pill[data-s='mudo'], .pill[data-o='error'] { background: var(--bad-soft-bg); color: var(--bad-soft-fg); font-weight: 600; }
    .rr-lotes, .rr-ordenes { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-main); }
    .rr-ordenes small { color: var(--text-muted); font-size: var(--fs-xs); margin-left: var(--sp-2); }
    .rr-ordenes-ctl { display: flex; gap: var(--sp-2); flex-wrap: wrap; align-items: center; }
    .rr-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .rr-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .rr-form { display: flex; flex-direction: column; gap: var(--sp-3); }
    .rr-form label { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
    .rr-form .rr-check { flex-direction: row; align-items: center; gap: var(--sp-2); }
    .rr-form-btns { display: flex; gap: var(--sp-2); }
    @media (max-width: 40rem) {
      .rr-page { padding: var(--sp-3); }
      .rr-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `],
})
export class RhRelojesComponent implements OnInit {
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);

  readonly semaforoLabel = SEMAFORO_LABEL;
  readonly modos = [
    { value: 'agente', label: 'Lo lee el lector (agente)' },
    { value: 'push', label: 'El reloj envía solo (push)' },
    { value: 'manual', label: 'Manual' },
  ];

  readonly sitios = signal<HrSiteDto[]>([]);
  readonly relojes = signal<HrRelojDto[]>([]);
  readonly estado = signal<HrRelojEstadoDto[]>([]);
  readonly lotes = signal<HrLotePendienteDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly ocupado = signal(false);
  readonly peek = signal(false);
  readonly form = signal<FormReloj | null>(null);
  readonly avisoForm = signal<string | null>(null);
  readonly sitioOrdenes = signal<string | null>(null);
  readonly persona = signal('');
  readonly nombreNuevo = signal('');
  readonly ordenes = signal<HrOrdenDto[]>([]);
  readonly ordenesCargadas = signal(false);
  readonly avisoOrdenes = signal<{ texto: string; mal: boolean } | null>(null);

  readonly gestiona = computed(() => this.perms.has(Permission.HR_DEVICES_GESTIONAR));
  /** Cuántos relojes en cada color; los cuatro siempre, aunque sea cero (un cero también informa). */
  readonly resumen = computed(() => (['ok', 'atrasado', 'mudo', 'pendiente'] as const).map((s) => ({ s, n: this.estado().filter((r) => r.semaforo === s).length })));
  private readonly nombresSitio = computed(() => new Map(this.sitios().map((s) => [s.code, s.name])));

  ngOnInit(): void {
    this.api.sitios().subscribe({
      next: (s) => { this.sitios.set(s); if (!this.sitioOrdenes() && s.length) this.sitioOrdenes.set(s[0].code); },
      error: () => this.sitios.set([]),
    });
    this.cargar();
  }

  cargar(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.estadoRelojes().subscribe({
      next: (e) => { this.estado.set(e); this.loading.set(false); },
      error: (e) => { this.error.set(rhError(e, 'No se pudo leer el estado de los relojes.')); this.loading.set(false); },
    });
    this.api.relojes().subscribe({ next: (r) => this.relojes.set(r), error: () => this.relojes.set([]) });
    this.api.lotesPendientes().subscribe({ next: (l) => this.lotes.set(l), error: () => this.lotes.set([]) });
  }

  nombreSitio(code: string | null): string { return (code && this.nombresSitio().get(code)) || code || '—'; }
  hace(s: number | null): string { return haceCuanto(s); }

  editar(serie: string | null): void {
    const r = serie ? this.relojes().find((x) => x.serial_number === serie) : null;
    this.avisoForm.set(null);
    this.form.set(r
      ? { serie: r.serial_number, nuevo: false, site_code: r.site_code ?? '', label: r.label ?? '', ip_address: r.ip_address ?? '', port: r.port,
          ingest_mode: r.ingest_mode, comm_key: r.comm_key, is_active: r.is_active, is_paused: r.is_paused, notes: r.notes ?? '' }
      : { serie: '', nuevo: true, site_code: this.sitios()[0]?.code ?? '', label: '', ip_address: '', port: 4370, ingest_mode: 'agente',
          comm_key: 0, is_active: true, is_paused: false, notes: '' });
    this.peek.set(true);
  }

  /** Una serie que mandó checadas sin estar dada de alta: el formulario ya trae su número. */
  editarNueva(serie: string): void {
    this.editar(null);
    const f = this.form();
    if (f) this.form.set({ ...f, serie });
  }

  /** Lo que se manda; público para que la prueba verifique QUÉ se envía. */
  cuerpo(f: FormReloj): HrRelojBody {
    return {
      site_code: f.site_code, label: f.label.trim() || null, ip_address: f.ip_address.trim() || null, port: Number(f.port) || 4370,
      ingest_mode: f.ingest_mode, comm_key: Number(f.comm_key) || 0, is_active: f.is_active, is_paused: f.is_paused, notes: f.notes.trim() || null,
    };
  }

  guardar(): void {
    const f = this.form();
    if (!f || !f.serie.trim() || !f.site_code) { this.avisoForm.set('Faltan el número de serie y el sitio.'); return; }
    this.ocupado.set(true);
    this.api.guardarReloj(f.serie.trim(), this.cuerpo(f)).subscribe({
      next: () => { this.ocupado.set(false); this.peek.set(false); this.cargar(); },
      error: (e) => { this.ocupado.set(false); this.avisoForm.set(rhError(e, 'No se pudo guardar el reloj.')); },
    });
  }

  reprocesar(serie: string): void {
    this.ocupado.set(true);
    this.api.reprocesar(serie).subscribe({
      next: (r) => {
        this.ocupado.set(false);
        this.avisoOrdenes.set({ texto: `${serie}: ${r.aplicados} de ${r.lotes} lote(s) aplicados, ${r.aceptadas} checadas nuevas.`, mal: r.aplicados < r.lotes });
        this.cargar();
      },
      error: (e) => { this.ocupado.set(false); this.avisoOrdenes.set({ texto: rhError(e, 'No se pudieron aplicar los lotes.'), mal: true }); },
    });
  }

  setSitioOrdenes(s: string): void { this.sitioOrdenes.set(s); this.cargarOrdenes(); }

  cargarOrdenes(): void {
    const site = this.sitioOrdenes();
    if (!site) return;
    this.api.ordenes({ site_code: site, person_code: this.persona().trim() || undefined }).subscribe({
      next: (r) => { this.ordenes.set(r.ordenes); this.ordenesCargadas.set(true); },
      error: (e) => this.avisoOrdenes.set({ texto: rhError(e, 'No se pudieron leer los cambios.'), mal: true }),
    });
  }

  renombrar(): void {
    const site = this.sitioOrdenes();
    if (!site) return;
    this.ocupado.set(true);
    this.api.renombrar(site, this.persona().trim(), this.nombreNuevo()).subscribe({
      next: (r) => { this.ocupado.set(false); this.nombreNuevo.set(''); this.avisoOrdenes.set({ texto: `Quedó «${r.nombre}» en ${r.relojes} reloj(es); el lector lo aplica en el equipo.`, mal: false }); this.cargarOrdenes(); },
      error: (e) => { this.ocupado.set(false); this.avisoOrdenes.set({ texto: rhError(e, 'No se pudo enviar el cambio.'), mal: true }); },
    });
  }

  restaurar(): void {
    const site = this.sitioOrdenes();
    if (!site) return;
    this.ocupado.set(true);
    this.api.restaurar(site, this.persona().trim()).subscribe({
      next: (r) => { this.ocupado.set(false); this.avisoOrdenes.set({ texto: `Se volverá a dar de alta en ${r.relojes} reloj(es). La huella y el rostro hay que registrarlos de nuevo en el equipo.`, mal: false }); this.cargarOrdenes(); },
      error: (e) => { this.ocupado.set(false); this.avisoOrdenes.set({ texto: rhError(e, 'No se pudo enviar el cambio.'), mal: true }); },
    });
  }

  cancelar(o: HrOrdenDto): void {
    this.api.cancelarOrden(o.id).subscribe({
      next: () => this.cargarOrdenes(),
      error: (e) => this.avisoOrdenes.set({ texto: rhError(e, 'No se pudo cancelar.'), mal: true }),
    });
  }
}
