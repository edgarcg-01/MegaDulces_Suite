import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ThotCurationService, ThotExampleRow, ThotCandidateRow } from '../thot-curation.service';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ANALYTICS_TABS } from '../analytics-tabs';

/**
 * TC.4a/5a — Curaduría de Thot: revisar la cola de 👍 y promover a ejemplo dorado
 * (few-shot), + alta manual y enable/disable. Así Thot "aprende" del uso real.
 */
@Component({
  selector: 'app-comercial-thot-curation',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, DialogModule, InputTextModule, TextareaModule, ToastModule, TooltipModule, PageTabsComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <app-page-tabs [tabs]="tabs" />

      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Curaduría de Thot</h1>
          <p class="surf-page-sub">Promové las buenas respuestas (👍) a ejemplos dorados; Thot las reusa como few-shot.</p>
        </div>
        <div class="tcur-actions">
          <p-select [options]="profiles" [(ngModel)]="profile" optionLabel="label" optionValue="value" (onChange)="loadExamples()" styleClass="tcur-sel"></p-select>
          <button pButton icon="pi pi-plus" label="Nuevo ejemplo" size="small" severity="contrast" (click)="openAdd()"></button>
          <button pButton icon="pi pi-sync" label="Reindexar" size="small" [outlined]="true" (click)="reindex()" [loading]="reindexing()" pTooltip="Re-embeber ejemplos en la DB vector (few-shot semántico)"></button>
          <button pButton icon="pi pi-refresh" [text]="true" severity="secondary" size="small" (click)="reload()" [loading]="loading()"></button>
        </div>
      </header>

      <!-- Cola de curaduría -->
      <h3 class="tcur-h">Cola de curaduría <span class="tcur-badge">{{ candidates().length }}</span></h3>
      <p-table [value]="candidates()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [paginator]="candidates().length > 10" [rows]="10">
        <ng-template pTemplate="header">
          <tr><th>Pregunta</th><th>Respuesta</th><th>Tools</th><th>Usuario</th><th></th></tr>
        </ng-template>
        <ng-template pTemplate="body" let-c>
          <tr>
            <td class="tcur-q">{{ c.question }}</td>
            <td class="tcur-a">{{ (c.answer || '') | slice:0:120 }}…</td>
            <td><span class="tcur-tools">{{ toolNames(c.tools_used) }}</span></td>
            <td>{{ c.user_name || '—' }}</td>
            <td class="tcur-right"><button pButton icon="pi pi-star" label="Promover" size="small" (click)="promote(c)"></button></td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-thumbs-up"></i></div><h3>Sin candidatos</h3><p>Cuando los usuarios marquen 👍 respuestas, aparecerán acá para promover.</p></div></td></tr>
        </ng-template>
      </p-table>

      <!-- Ejemplos verificados -->
      <h3 class="tcur-h">Ejemplos verificados <span class="tcur-badge">{{ examples().length }}</span></h3>
      <p-table [value]="examples()" [loading]="loading()" styleClass="p-datatable-sm surf-table" [paginator]="examples().length > 15" [rows]="15">
        <ng-template pTemplate="header">
          <tr><th>Perfil</th><th>Pregunta</th><th>Tools</th><th>Estado</th><th></th></tr>
        </ng-template>
        <ng-template pTemplate="body" let-e>
          <tr [class.tcur-off]="!e.enabled">
            <td><p-tag [value]="e.profile" severity="secondary"></p-tag></td>
            <td class="tcur-q">{{ e.question }}</td>
            <td><span class="tcur-tools">{{ toolNames(e.tools) }}</span></td>
            <td><p-tag [value]="e.enabled ? 'Activo' : 'Pausado'" [severity]="e.enabled ? 'success' : 'secondary'"></p-tag></td>
            <td class="tcur-right">
              <button pButton [icon]="e.enabled ? 'pi pi-pause' : 'pi pi-play'" size="small" [text]="true" severity="secondary" (click)="toggle(e)"></button>
            </td>
          </tr>
        </ng-template>
        <ng-template pTemplate="emptymessage">
          <tr><td colspan="5" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-book"></i></div><h3>Sin ejemplos curados</h3><p>Promové de la cola o creá uno manual. (Hay ejemplos semilla en código que ya guían a Thot.)</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>

    <p-dialog [(visible)]="addOpen" [modal]="true" [draggable]="false" [style]="{ width: '560px' }" header="Nuevo ejemplo dorado">
      <div class="tcur-form">
        <label>Perfil
          <p-select [options]="profilesNoAll" [(ngModel)]="form.profile" optionLabel="label" optionValue="value" appendTo="body" styleClass="tcur-w"></p-select>
        </label>
        <label>Pregunta *
          <input pInputText [(ngModel)]="form.question" placeholder="¿Cuánto vendí…?" />
        </label>
        <label>Respuesta modelo (estilo, sin cifras fijas)
          <textarea pTextarea [(ngModel)]="form.answer" rows="3" placeholder="Arrancá con la conclusión en negrita…"></textarea>
        </label>
        <label>Tools esperadas (coma)
          <input pInputText [(ngModel)]="form.toolsStr" placeholder="thot_flexible_aggregate, thot_resolve_entity" />
        </label>
        <label>Nota (por qué es buen ejemplo)
          <input pInputText [(ngModel)]="form.note" />
        </label>
      </div>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" [text]="true" severity="secondary" (click)="addOpen.set(false)"></button>
        <button pButton label="Guardar" severity="contrast" [disabled]="!form.question.trim()" (click)="save()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    .tcur-actions { display: flex; gap: .5rem; align-items: center; }
    :host ::ng-deep .tcur-sel { min-width: 170px; }
    .tcur-h { margin: 1.4rem 0 .5rem; font-size: 1rem; display: flex; align-items: center; gap: .5rem; }
    .tcur-badge { background: var(--surface-100,var(--c-surface-2)); border-radius: 999px; padding: .1rem .55rem; font-size: .78rem; color: var(--text-muted,var(--c-text-2)); }
    .tcur-q { max-width: 320px; }
    .tcur-a { max-width: 280px; color: var(--text-muted,var(--c-text-2)); font-size: .82rem; }
    .tcur-tools { font-family: var(--font-mono,monospace); font-size: .76rem; color: var(--text-muted,var(--c-text-2)); }
    .tcur-right { text-align: right; }
    .tcur-off { opacity: .5; }
    .tcur-form { display: flex; flex-direction: column; gap: .8rem; }
    .tcur-form label { display: flex; flex-direction: column; gap: .3rem; font-size: .82rem; color: var(--text-muted,var(--c-text-2)); }
    .tcur-form input, .tcur-form textarea { width: 100%; }
    :host ::ng-deep .tcur-w { width: 100%; }
  `],
})
export class ComercialThotCurationComponent {
  readonly tabs = ANALYTICS_TABS;
  readonly profiles = [{ label: 'Todos los perfiles', value: '' }, { label: 'Admin', value: 'admin' }, { label: 'Portal', value: 'portal' }, { label: 'Vendedor', value: 'vendor' }];
  readonly profilesNoAll = this.profiles.slice(1);

  private readonly svc = inject(ThotCurationService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  examples = signal<ThotExampleRow[]>([]);
  candidates = signal<ThotCandidateRow[]>([]);
  loading = signal(false);
  reindexing = signal(false);
  profile = '';
  addOpen = signal(false);
  form = { profile: 'admin', question: '', answer: '', toolsStr: '', note: '' };

  constructor() { this.reload(); }

  reload() { this.loadExamples(); this.loadCandidates(); }

  loadExamples() {
    this.loading.set(true);
    this.svc.listExamples(this.profile || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.examples.set(r || []); this.loading.set(false); },
      error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar ejemplos' }); },
    });
  }
  loadCandidates() {
    this.svc.candidates().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.candidates.set(r || []) });
  }

  toolNames(tools: any): string {
    if (!Array.isArray(tools)) return '—';
    return tools.map((t) => t?.name || t).join(', ') || '—';
  }

  promote(c: ThotCandidateRow) {
    this.svc.promote(c.id, {}).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.toast.add({ severity: 'success', summary: 'Promovido a ejemplo dorado' }); this.reload(); },
      error: () => this.toast.add({ severity: 'error', summary: 'No se pudo promover' }),
    });
  }
  toggle(e: ThotExampleRow) {
    this.svc.toggle(e.id, !e.enabled).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { e.enabled = !e.enabled; this.examples.update((x) => [...x]); },
      error: () => this.toast.add({ severity: 'error', summary: 'No se pudo cambiar' }),
    });
  }

  reindex() {
    this.reindexing.set(true);
    this.svc.reindex().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => { this.reindexing.set(false); this.toast.add({ severity: 'success', summary: `Reindexado: ${r?.indexed ?? 0} ejemplos` }); },
      error: () => { this.reindexing.set(false); this.toast.add({ severity: 'warn', summary: 'Reindex no disponible', detail: 'Verificá VECTOR_DATABASE_URL y VOYAGE_API_KEY' }); },
    });
  }

  openAdd() { this.form = { profile: 'admin', question: '', answer: '', toolsStr: '', note: '' }; this.addOpen.set(true); }
  save() {
    const tools = this.form.toolsStr.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
    this.svc.add({ profile: this.form.profile, question: this.form.question, answer: this.form.answer, tools, note: this.form.note })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => { this.toast.add({ severity: 'success', summary: 'Ejemplo guardado' }); this.addOpen.set(false); this.loadExamples(); },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo guardar' }),
      });
  }
}
