import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService, AisleTeam, AssignableUser } from '../comercial.service';

interface Opt { label: string; value: string; }

/**
 * Fase PA.3 — Tablero de equipos por folio. Sobre el layout de pasillos (PA.1),
 * pone 1 supervisor + un equipo de contadores en cada pasillo: auto-generar
 * (parejo) + ajuste manual tocando un pasillo. Surface Operations (DESIGN.md):
 * grilla CSS 2D, tokens, sin Fraunces, acción sunset.
 */
@Component({
  selector: 'app-comercial-inventory-teams',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, ButtonModule, SelectModule, MultiSelectModule, TagModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in tm-page">
      <p-toast></p-toast>

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Equipos por pasillo</h1>
          <p class="surf-page-sub">1 supervisor por pasillo + contadores repartidos parejo. Auto-generá y ajustá a mano.</p>
        </div>
        <div class="tm-head-actions">
          <button pButton icon="pi pi-arrow-left" label="Volver al folio" [text]="true" severity="secondary" size="small"
                  [routerLink]="['/comercial/inventory/sessions', countId]"></button>
        </div>
      </header>

      <!-- Pool del día + auto-generar -->
      <div class="tm-pool">
        <div class="tm-pool-col">
          <label for="tm-sup">Supervisores disponibles</label>
          <p-multiSelect inputId="tm-sup" [options]="supOptions()" [(ngModel)]="selSup" optionLabel="label" optionValue="value"
                         placeholder="Ninguno" [filter]="true" display="chip" styleClass="tm-ms" appendTo="body"></p-multiSelect>
        </div>
        <div class="tm-pool-col">
          <label for="tm-cnt">Contadores disponibles</label>
          <p-multiSelect inputId="tm-cnt" [options]="cntOptions()" [(ngModel)]="selCnt" optionLabel="label" optionValue="value"
                         placeholder="Ninguno" [filter]="true" display="chip" styleClass="tm-ms" appendTo="body"></p-multiSelect>
        </div>
        <button pButton label="Auto-generar (parejo)" icon="pi pi-bolt" class="tm-gen-btn"
                [loading]="working()" [disabled]="!selCnt().length || !board().length" (click)="autoGenerate()"></button>
      </div>

      @if (!loading() && !board().length) {
        <div class="tm-empty">
          <i class="pi pi-th-large"></i>
          <p>Este almacén no tiene pasillos.</p>
          <small>Definilos primero en <a [routerLink]="['/comercial/inventory/aisles']">Pasillos</a>, después armá los equipos acá.</small>
        </div>
      } @else {
        <div class="tm-body">
          <div class="tm-grid-wrap">
            <div class="tm-grid" [style.gridTemplateColumns]="'repeat(' + cols() + ', minmax(150px, 1fr))'">
              @for (a of board(); track a.aisle_id) {
                <button type="button" class="tm-cell" [class.sel]="selected()?.aisle_id === a.aisle_id"
                        [class.no-sup]="!a.supervisor"
                        [style.gridColumn]="(a.grid_col + 1) + ' / span ' + a.span_cols"
                        [style.gridRow]="(a.grid_row + 1) + ' / span ' + a.span_rows"
                        (click)="select(a)" [attr.aria-pressed]="selected()?.aisle_id === a.aisle_id">
                  <span class="tm-cell-code">{{ a.code }}</span>
                  <span class="tm-sup" [class.none]="!a.supervisor">
                    <i class="pi pi-user-edit"></i> {{ a.supervisor?.name || 'Sin supervisor' }}
                  </span>
                  <div class="tm-cnts">
                    @for (c of a.counters; track c.user_id) {
                      <span class="tm-chip">{{ c.name }}</span>
                    } @empty {
                      <span class="tm-cnts-empty">Sin contadores</span>
                    }
                  </div>
                  <span class="tm-cell-count">{{ a.counters.length }}</span>
                </button>
              }
            </div>
          </div>

          @if (selected(); as sel) {
            <aside class="tm-panel">
              <div class="tm-panel-head">
                <h2>{{ sel.code }}</h2>
                <button pButton icon="pi pi-times" [text]="true" size="small" (click)="selected.set(null)" aria-label="Cerrar"></button>
              </div>
              <label class="tm-fld" for="tm-psup">Supervisor</label>
              <p-select inputId="tm-psup" [options]="supOptions()" [(ngModel)]="panelSup" optionLabel="label" optionValue="value"
                        placeholder="Sin supervisor" [showClear]="true" [filter]="true" appendTo="body" styleClass="tm-w-full"></p-select>
              <label class="tm-fld" for="tm-pcnt">Contadores</label>
              <p-multiSelect inputId="tm-pcnt" [options]="cntOptions()" [(ngModel)]="panelCnt" optionLabel="label" optionValue="value"
                             placeholder="Ninguno" [filter]="true" display="chip" appendTo="body" styleClass="tm-w-full"></p-multiSelect>
              <button pButton label="Aplicar a este pasillo" icon="pi pi-check" size="small" class="tm-apply"
                      [loading]="working()" (click)="applyAisle()"></button>
            </aside>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .tm-head-actions { display: flex; gap: .5rem; align-items: center; }
    .tm-pool { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; padding: .85rem 1rem; margin-bottom: 1rem;
      background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e8e2d7); border-radius: var(--r-lg, 16px); }
    .tm-pool-col { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: .3rem; }
    .tm-pool-col label { font-size: .75rem; font-weight: 600; color: var(--text-muted, #5e564b); text-transform: uppercase; letter-spacing: .04em; }
    :host ::ng-deep .tm-ms { width: 100%; }
    :host ::ng-deep .tm-gen-btn { white-space: nowrap; }
    .tm-empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted, #5e564b); }
    .tm-empty i { font-size: 2.5rem; opacity: .5; display: block; margin-bottom: .75rem; color: var(--text-faint, #b0a595); }
    .tm-empty p { margin: 0 0 .25rem; font-weight: 600; color: var(--text-main, #100d09); }
    .tm-empty a { color: var(--action, #f05a28); font-weight: 600; }

    .tm-body { display: flex; gap: 1rem; align-items: flex-start; }
    .tm-grid-wrap { flex: 1; min-width: 0; }
    .tm-grid { display: grid; gap: .6rem; }
    .tm-cell { display: flex; flex-direction: column; align-items: flex-start; gap: .35rem; text-align: left; cursor: pointer; position: relative;
      background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e8e2d7); border-radius: var(--r-md, 12px); padding: .7rem .75rem; min-height: 104px;
      transition: border-color 120ms, box-shadow 120ms; }
    .tm-cell:hover { border-color: var(--action, #f05a28); }
    .tm-cell.sel { border-color: var(--action, #f05a28); box-shadow: 0 0 0 2px var(--action-ring, rgba(240,90,40,.3)); }
    .tm-cell.no-sup { border-left: 3px solid var(--warn-fg, #f59e0b); }
    .tm-cell-code { font-weight: 700; font-size: .9rem; color: var(--text-main, #100d09); }
    .tm-sup { font-size: .75rem; display: inline-flex; align-items: center; gap: .3rem; color: var(--text-main, #100d09); font-weight: 600; }
    .tm-sup i { color: var(--action, #f05a28); }
    .tm-sup.none { color: var(--warn-soft-fg, #92400e); font-weight: 500; }
    .tm-sup.none i { color: var(--warn-fg, #f59e0b); }
    .tm-cnts { display: flex; flex-wrap: wrap; gap: .25rem; }
    .tm-chip { font-size: .7rem; font-weight: 500; background: var(--hover-bg, #f5f1ea); color: var(--text-main, #100d09); padding: .1rem .4rem; border-radius: var(--r-sm, 8px); white-space: nowrap; }
    .tm-cnts-empty { font-size: .72rem; color: var(--text-faint, #b0a595); }
    .tm-cell-count { position: absolute; top: .6rem; right: .7rem; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: .8rem; font-weight: 700; color: var(--text-muted, #5e564b); }

    .tm-panel { width: 300px; flex-shrink: 0; background: var(--card-bg, #fff); border: 1px solid var(--border-color, #e8e2d7); border-radius: var(--r-lg, 16px); padding: 1rem; position: sticky; top: 1rem; }
    .tm-panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .5rem; }
    .tm-panel-head h2 { font-size: 1.1rem; font-weight: 700; margin: 0; }
    .tm-fld { display: block; font-size: .75rem; font-weight: 600; color: var(--text-muted, #5e564b); text-transform: uppercase; letter-spacing: .04em; margin: .6rem 0 .25rem; }
    :host ::ng-deep .tm-w-full { width: 100%; }
    .tm-apply { width: 100%; margin-top: 1rem; }

    /* En tablet/móvil la grilla posicional 2D no sirve: colapsa a auto-flow
       (las posiciones inline grid-col/row se anulan con !important). */
    @media (max-width: 900px) {
      .tm-body { flex-direction: column; }
      .tm-panel { width: 100%; position: static; }
      .tm-grid { grid-template-columns: repeat(2, 1fr) !important; }
      .tm-cell { grid-column: auto !important; grid-row: auto !important; }
    }
    @media (max-width: 560px) {
      .tm-grid { grid-template-columns: 1fr !important; }
    }
  `],
})
export class ComercialInventoryTeamsComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  countId = this.route.snapshot.paramMap.get('id')!;
  loading = signal(false);
  working = signal(false);
  board = signal<AisleTeam[]>([]);

  supOptions = signal<Opt[]>([]);
  cntOptions = signal<Opt[]>([]);
  selSup = signal<string[]>([]);
  selCnt = signal<string[]>([]);

  selected = signal<AisleTeam | null>(null);
  panelSup = signal<string | null>(null);
  panelCnt = signal<string[]>([]);

  cols = computed(() => Math.max(3, ...this.board().map((a) => a.grid_col + a.span_cols)));

  constructor() {
    const opt = (u: AssignableUser): Opt => ({ label: u.nombre || u.username, value: u.id });
    this.svc.inventoryAssignableUsers('supervisor').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => { this.supOptions.set(us.map(opt)); this.selSup.set(us.map((u) => u.id)); } });
    this.svc.inventoryAssignableUsers('counter').pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => { this.cntOptions.set(us.map(opt)); this.selCnt.set(us.map((u) => u.id)); } });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.inventoryAisleTeams(this.countId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (b) => { this.board.set(b.aisles || []); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo cargar el tablero' }); },
      });
  }

  autoGenerate() {
    this.working.set(true);
    this.svc.inventoryGenerateTeams(this.countId, { supervisor_ids: this.selSup(), counter_ids: this.selCnt() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          this.board.set(r.teams || []);
          this.selected.set(null);
          const warn = r.aisles_without_supervisor > 0 ? ` · ${r.aisles_without_supervisor} sin supervisor` : '';
          this.toast.add({ severity: 'success', summary: 'Equipos generados', detail: `${r.aisles} pasillos · ${r.counters_assigned} contadores${warn}` });
        },
        error: (e) => { this.working.set(false); this.toast.add({ severity: 'warn', summary: 'No se pudo generar', detail: e?.error?.message }); },
      });
  }

  select(a: AisleTeam) {
    this.selected.set(a);
    this.panelSup.set(a.supervisor?.user_id ?? null);
    this.panelCnt.set(a.counters.map((c) => c.user_id));
  }

  applyAisle() {
    const sel = this.selected();
    if (!sel) return;
    // Construye el tablero completo con el cambio de este pasillo y lo persiste.
    const supId = this.panelSup();
    const cntIds = this.panelCnt();
    const teams = this.board().map((a) => ({
      aisle_id: a.aisle_id,
      supervisor_id: a.aisle_id === sel.aisle_id ? supId : (a.supervisor?.user_id ?? null),
      counter_ids: a.aisle_id === sel.aisle_id ? cntIds : a.counters.map((c) => c.user_id),
    }));
    this.working.set(true);
    this.svc.inventorySetAisleTeams(this.countId, { teams })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.working.set(false);
          this.board.set(r.teams || []);
          this.selected.set(null);
          this.toast.add({ severity: 'success', summary: `${sel.code} actualizado` });
        },
        error: (e) => { this.working.set(false); this.toast.add({ severity: 'warn', summary: 'No se pudo aplicar', detail: e?.error?.message }); },
      });
  }
}
