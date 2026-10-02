import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import type { Observable } from 'rxjs';
import { SD_PRIORITIES, type SdClock, type SdConfigResponse, type SdPriority, type SdSlaScanResult } from '@megadulces/contracts';
import { PRIORITY_LABEL, ServiceDeskService, sdError } from '../service-desk.service';

const DIAS = [
  { n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mié' }, { n: 4, l: 'Jue' }, { n: 5, l: 'Vie' }, { n: 6, l: 'Sáb' }, { n: 0, l: 'Dom' },
];

interface PolForm { priority: SdPriority; first_response_minutes: number; resolution_minutes: number; clock: SdClock }

/**
 * `[MS.3.5]` Mesa de Servicio › Configuración (`/servicio/configuracion`) — sólo coordinación.
 *
 * Todo lo que se guarda aplica de inmediato (el servidor lee la configuración en cada operación): no
 * hay despliegue ni reinicio. **La escalación nace apagada**: primero se MIDE el SLA con datos reales
 * (el barrido marca lo vencido y el tablero lo cuenta) y recién entonces se enciende; un reloj sin
 * calibrar que avisa enseña a ignorar la alarma.
 */
@Component({
  selector: 'app-servicio-configuracion',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, InputTextModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sc-page">
      <header class="sc-head">
        <div>
          <h1>Configuración de la Mesa de Servicio</h1>
          <p>Horario, plazos, colas y categorías. Los cambios aplican de inmediato.</p>
        </div>
        <p-button icon="pi pi-bolt" label="Barrer el SLA ahora" severity="secondary" [outlined]="true" [loading]="barriendo()" (onClick)="barrer()" />
      </header>

      @if (error(); as e) { <p class="sc-banner bad" role="alert">{{ e }}</p> }
      @if (aviso(); as a) { <p class="sc-banner ok" role="status">{{ a }}</p> }
      @if (scan(); as r) {
        <p class="sc-banner info" role="status">Barrido: {{ r.marcados }} plazo(s) marcado(s) · {{ r.avisos }} aviso(s) · {{ r.autocerrados }} cierre(s) automático(s).
          @if (!cfg()?.settings?.escalation_enabled) { Con la escalación apagada se mide y se marca, pero no se avisa a nadie. }</p>
      }

      @if (cfg(); as c) {
        <section class="sc-card" aria-labelledby="h-reglas">
          <h2 id="h-reglas">Horario y reglas</h2>
          <div class="sc-grid">
            <fieldset class="sc-days"><legend>Días hábiles</legend>
              @for (d of dias; track d.n) {
                <label class="sc-chk"><input type="checkbox" [checked]="reglas.business_days.includes(d.n)" (change)="alternarDia(d.n)" /> {{ d.l }}</label>
              }
            </fieldset>
            <label class="sc-field"><span>Abre</span><input pInputText type="time" [(ngModel)]="reglas.business_start" /></label>
            <label class="sc-field"><span>Cierra</span><input pInputText type="time" [(ngModel)]="reglas.business_end" /></label>
            <label class="sc-field"><span>Zona horaria</span><input pInputText [(ngModel)]="reglas.tz" /></label>
            <label class="sc-field"><span>Cerrar solas las resueltas tras (días)</span><input pInputText type="number" min="1" max="60" [(ngModel)]="reglas.auto_close_days" /></label>
            <label class="sc-field"><span>Avisar al consumir (% del plazo)</span><input pInputText type="number" min="1" max="100" [(ngModel)]="reglas.escalate_at_pct" /></label>
            <label class="sc-field"><span>Máximo por archivo (MB)</span><input pInputText type="number" min="1" max="15" [(ngModel)]="reglas.max_attachment_mb" /></label>
          </div>
          <label class="sc-esc">
            <input type="checkbox" [(ngModel)]="reglas.escalation_enabled" />
            <span><b>Escalar y avisar los plazos vencidos</b>
              <small>Apagado de fábrica a propósito: primero revisa unos días el tablero de la bandeja (cuántas van fuera de plazo) y ajusta los plazos de abajo. Al encenderlo, el barrido avisa por correo/WhatsApp y por la campana.</small></span>
          </label>
          <div class="sc-foot"><p-button label="Guardar reglas" [loading]="guardando()" (onClick)="guardarReglas()" /></div>
        </section>

        <section class="sc-card" aria-labelledby="h-sla">
          <h2 id="h-sla">Plazos por prioridad</h2>
          <p class="sc-hint">«Primera respuesta» es cuánto tarda alguien en tomarla o contestar; «resolución», cuánto en quedar resuelta. El reloj hábil sólo corre dentro del horario de arriba; el corrido, las 24 horas.</p>
          <table class="sc-table">
            <thead><tr><th>Prioridad</th><th>Primera respuesta (min)</th><th>Resolución (min)</th><th>Reloj</th><th></th></tr></thead>
            <tbody>
              @for (p of pol; track p.priority) {
                <tr>
                  <td><span class="sc-pri" [attr.data-p]="p.priority">{{ prioridad[p.priority] }}</span></td>
                  <td><input pInputText type="number" min="1" [(ngModel)]="p.first_response_minutes" [attr.aria-label]="'Primera respuesta ' + prioridad[p.priority]" /></td>
                  <td><input pInputText type="number" min="1" [(ngModel)]="p.resolution_minutes" [attr.aria-label]="'Resolución ' + prioridad[p.priority]" /></td>
                  <td><p-select [options]="relojes" optionLabel="label" optionValue="value" [(ngModel)]="p.clock" appendTo="body" [ariaLabel]="'Reloj ' + prioridad[p.priority]" /></td>
                  <td><p-button label="Guardar" size="small" severity="secondary" [outlined]="true" [loading]="guardando()" (onClick)="guardarPolitica(p)" /></td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <section class="sc-card" aria-labelledby="h-cat">
          <h2 id="h-cat">Colas y categorías</h2>
          @for (q of c.queues; track q.id) {
            <div class="sc-queue">
              <div class="sc-qhead">
                <b>{{ q.name }}</b><span class="sc-mono">{{ q.code }}</span>
                @if (!q.active) { <em class="sc-off">apagada</em> }
                <span class="sc-sp"></span>
                <p-button [label]="q.active ? 'Apagar cola' : 'Encender cola'" size="small" severity="secondary" [text]="true" (onClick)="alternarCola(q.id, q.active)" />
              </div>
              <table class="sc-table">
                <thead><tr><th>Categoría</th><th>Prioridad por defecto</th><th>Exige sucursal</th><th>Estado</th><th></th></tr></thead>
                <tbody>
                  @for (k of categoriasDe(q.id); track k.id) {
                    <tr [class.apagada]="!k.active">
                      <td>{{ k.name }} <span class="sc-mono">{{ k.code }}</span></td>
                      <td><span class="sc-pri" [attr.data-p]="k.default_priority">{{ prioridad[k.default_priority] }}</span></td>
                      <td>{{ k.requires_branch ? 'Sí' : 'No' }}</td>
                      <td>{{ k.active ? 'Activa' : 'Apagada' }}</td>
                      <td><p-button [label]="k.active ? 'Apagar' : 'Encender'" size="small" severity="secondary" [text]="true" (onClick)="alternarCategoria(k.id, k.active)" /></td>
                    </tr>
                  } @empty { <tr><td colspan="5" class="sc-vacio">Sin categorías.</td></tr> }
                </tbody>
              </table>
            </div>
          }

          <div class="sc-new">
            <h3>Nueva categoría</h3>
            <div class="sc-grid">
              <label class="sc-field"><span>Cola</span>
                <p-select [options]="c.queues" optionLabel="name" optionValue="id" [(ngModel)]="nueva.queue_id" placeholder="Elige" appendTo="body" ariaLabel="Cola" /></label>
              <label class="sc-field"><span>Nombre</span><input pInputText [(ngModel)]="nueva.name" placeholder="Ej. Impresora de etiquetas" /></label>
              <label class="sc-field"><span>Código (minúsculas y guion bajo)</span><input pInputText [(ngModel)]="nueva.code" placeholder="impresora_etiquetas" /></label>
              <label class="sc-field"><span>Prioridad por defecto</span>
                <p-select [options]="prioridades" optionLabel="label" optionValue="value" [(ngModel)]="nueva.default_priority" appendTo="body" ariaLabel="Prioridad por defecto" /></label>
            </div>
            <label class="sc-chk"><input type="checkbox" [(ngModel)]="nueva.requires_branch" /> Exigir sucursal al reportar</label>
            <div class="sc-foot"><p-button label="Agregar categoría" icon="pi pi-plus" [loading]="guardando()" [disabled]="!nuevaValida()" (onClick)="agregarCategoria()" /></div>
          </div>
        </section>
      } @else if (!error()) {
        <p class="sc-hint">Cargando…</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .sc-page { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-4); max-width: 1100px; }
    .sc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
    .sc-head h1 { margin: 0; font: 700 var(--fs-h2)/1.2 var(--font-body); color: var(--text-main); }
    .sc-head p { margin: var(--sp-1) 0 0; color: var(--text-muted); font-size: var(--fs-sm); }
    .sc-banner { margin: 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sm); }
    .sc-banner.bad { background: var(--bad-soft-bg); color: var(--bad-soft-fg); }
    .sc-banner.ok { background: var(--ok-soft-bg); color: var(--ok-soft-fg); }
    .sc-banner.info { background: var(--info-soft-bg); color: var(--info-soft-fg); }
    .sc-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
    .sc-card h2 { margin: 0; font: 700 var(--fs-h3)/1.2 var(--font-body); color: var(--text-main); }
    .sc-card h3 { margin: 0; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .sc-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--sp-3); align-items: end; }
    .sc-field { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
    .sc-field > span { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); }
    .sc-field input, .sc-field p-select { width: 100%; }
    .sc-days { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); margin: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); grid-column: 1 / -1; }
    .sc-days legend { font-weight: 600; font-size: var(--fs-xs); color: var(--text-main); padding: 0 var(--sp-1); }
    .sc-chk { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-main); }
    .sc-esc { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); background: var(--surface-2); }
    .sc-esc span { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); color: var(--text-main); }
    .sc-esc small { color: var(--text-muted); font-size: var(--fs-xs); }
    .sc-foot { display: flex; gap: var(--sp-2); }
    .sc-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
    .sc-table th { text-align: left; background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-xs); font-weight: 600; padding: var(--sp-2) var(--sp-3); }
    .sc-table td { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); color: var(--text-main); }
    .sc-table input[type='number'] { width: 130px; }
    .sc-table tr.apagada td { color: var(--text-faint); }
    .sc-vacio { text-align: center; color: var(--text-muted); }
    .sc-mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
    .sc-pri { display: inline-block; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-xs); color: var(--text-muted); }
    .sc-pri[data-p='alta'] { color: var(--warn-fg); background: var(--warn-soft-bg); }
    .sc-pri[data-p='urgente'] { color: var(--bad-fg); background: var(--bad-soft-bg); font-weight: 600; }
    .sc-queue { display: flex; flex-direction: column; gap: var(--sp-2); overflow-x: auto; }
    .sc-qhead { display: flex; align-items: center; gap: var(--sp-2); }
    .sc-off { font-style: normal; font-size: var(--fs-xs); color: var(--warn-fg); }
    .sc-sp { flex: 1; }
    .sc-new { display: flex; flex-direction: column; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border-color); }
    @media (max-width: 640px) {
      .sc-page { padding: var(--sp-3); gap: var(--sp-3); }
      .sc-head p-button, .sc-head p-button ::ng-deep button { width: 100%; justify-content: center; }
      .sc-card { padding: var(--sp-3); }
      .sc-table { display: block; overflow-x: auto; }
    }
  `],
})
export class ServicioConfiguracionComponent implements OnInit {
  private readonly api = inject(ServiceDeskService);

  readonly dias = DIAS;
  readonly prioridad = PRIORITY_LABEL;
  readonly prioridades = SD_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));
  readonly relojes = [{ value: 'business', label: 'Hábil' }, { value: 'calendar', label: 'Corrido (24 h)' }];

  readonly cfg = signal<SdConfigResponse | null>(null);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<string | null>(null);
  readonly guardando = signal(false);
  readonly barriendo = signal(false);
  readonly scan = signal<SdSlaScanResult | null>(null);

  reglas = { business_days: [] as number[], business_start: '08:00', business_end: '19:00', tz: 'America/Mexico_City', auto_close_days: 3, escalate_at_pct: 80, escalation_enabled: false, max_attachment_mb: 8 };
  pol: PolForm[] = [];
  nueva: { queue_id: string | null; name: string; code: string; default_priority: SdPriority; requires_branch: boolean } = { queue_id: null, name: '', code: '', default_priority: 'media', requires_branch: false };

  ngOnInit(): void {
    this.api.config().subscribe({
      next: (c) => this.aplicar(c),
      error: (e) => this.error.set(sdError(e, 'No se pudo cargar la configuración.')),
    });
  }

  private aplicar(c: SdConfigResponse): void {
    this.cfg.set(c);
    this.reglas = { ...c.settings, business_days: [...c.settings.business_days] };
    this.pol = c.policies.map((p) => ({ ...p }));
    if (!this.nueva.queue_id) this.nueva.queue_id = c.queues[0]?.id ?? null;
  }

  categoriasDe(queueId: string) { return (this.cfg()?.categories ?? []).filter((k) => k.queue_id === queueId); }
  alternarDia(n: number): void {
    const d = this.reglas.business_days;
    this.reglas.business_days = d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort((a, b) => a - b);
  }

  /** Corre una operación de guardado: mensaje de éxito o el motivo exacto del servidor. */
  private guardar(op: Observable<SdConfigResponse>, ok: string): void {
    this.guardando.set(true);
    this.error.set(null);
    this.aviso.set(null);
    op.subscribe({
      next: (c) => { this.aplicar(c); this.guardando.set(false); this.aviso.set(ok); },
      error: (e) => { this.guardando.set(false); this.error.set(sdError(e, 'No se pudo guardar.')); },
    });
  }

  guardarReglas(): void {
    const r = this.reglas;
    this.guardar(this.api.updateSettings({
      business_days: r.business_days, business_start: r.business_start, business_end: r.business_end, tz: r.tz,
      auto_close_days: Number(r.auto_close_days), escalate_at_pct: Number(r.escalate_at_pct),
      escalation_enabled: r.escalation_enabled, max_attachment_mb: Number(r.max_attachment_mb),
    }), r.escalation_enabled ? 'Reglas guardadas. La escalación está ENCENDIDA: el barrido avisará los plazos vencidos.' : 'Reglas guardadas.');
  }
  guardarPolitica(p: PolForm): void {
    this.guardar(this.api.updatePolicy(p.priority, {
      first_response_minutes: Number(p.first_response_minutes), resolution_minutes: Number(p.resolution_minutes), clock: p.clock,
    }), `Plazos de «${PRIORITY_LABEL[p.priority]}» guardados.`);
  }
  alternarCola(id: string, activa: boolean): void { this.guardar(this.api.updateQueue(id, { active: !activa }), activa ? 'Cola apagada.' : 'Cola encendida.'); }
  alternarCategoria(id: string, activa: boolean): void { this.guardar(this.api.updateCategory(id, { active: !activa }), activa ? 'Categoría apagada.' : 'Categoría encendida.'); }

  nuevaValida(): boolean { return !!this.nueva.queue_id && !!this.nueva.name.trim() && /^[a-z][a-z0-9_]*$/.test(this.nueva.code.trim()); }
  agregarCategoria(): void {
    const n = this.nueva;
    if (!this.nuevaValida() || !n.queue_id) return;
    this.guardar(this.api.createCategory({
      queue_id: n.queue_id, name: n.name.trim(), code: n.code.trim(), default_priority: n.default_priority, requires_branch: n.requires_branch,
    }), 'Categoría agregada.');
    this.nueva = { ...this.nueva, name: '', code: '', requires_branch: false };
  }

  barrer(): void {
    this.barriendo.set(true);
    this.error.set(null);
    this.api.scanNow().subscribe({
      next: (r) => { this.scan.set(r); this.barriendo.set(false); },
      error: (e) => { this.barriendo.set(false); this.error.set(sdError(e, 'No se pudo correr el barrido.')); },
    });
  }
}
