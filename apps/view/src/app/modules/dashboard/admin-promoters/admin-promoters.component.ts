import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ComercialService } from '../../comercial/comercial.service';

/**
 * P2.6 — Admin de promotores de marca propia. Asigna marcas a un usuario:
 * ese usuario, en Control de Caducidades, solo verá/capturará los SKUs de esas
 * marcas (Canel's, De la Rosa, …). Multi-marca. Gate USUARIOS_GESTIONAR.
 */
@Component({
  selector: 'app-admin-promoters',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, TagModule, SelectModule, MultiSelectModule, ToastModule],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page in">
      <p-toast></p-toast>
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Promotores de marca</h1>
          <p class="surf-page-sub">Asigná marcas a un usuario — solo verá esos SKUs en Control de Caducidades</p>
        </div>
      </header>

      <section class="ap-form surf-card">
        <div class="ap-grid">
          <label class="ap-field">
            <span class="ap-lbl">Usuario (promotor)</span>
            <p-select [options]="users()" [(ngModel)]="selUser" optionLabel="label" optionValue="value"
              [filter]="true" filterBy="label" placeholder="Elegí un usuario" appendTo="body" styleClass="ap-full"
              (onChange)="onUserPick()"></p-select>
          </label>
          <label class="ap-field ap-col-2">
            <span class="ap-lbl">Marcas</span>
            <p-multiselect [options]="brands()" [(ngModel)]="selBrands" optionLabel="nombre" optionValue="id"
              [filter]="true" filterBy="nombre" placeholder="Elegí una o más marcas" appendTo="body" styleClass="ap-full"
              display="chip"></p-multiselect>
          </label>
        </div>
        <div class="ap-actions">
          <button pButton [disabled]="!selUser || saving()" [loading]="saving()" (click)="save()">
            <span class="p-button-icon p-button-icon-left pi pi-save" aria-hidden="true"></span> Guardar asignación
          </button>
        </div>
      </section>

      <h2 class="ap-h2">Promotores actuales</h2>
      <p-table [value]="promoters()" [loading]="loading()" styleClass="p-datatable-sm surf-table surf-table--zebra">
        <ng-template #header>
          <tr><th scope="col">Usuario</th><th scope="col">Nombre</th><th scope="col">Marcas</th><th scope="col"></th></tr>
        </ng-template>
        <ng-template #body let-p>
          <tr>
            <td class="ap-mono">{{ p.username }}</td>
            <td>{{ p.nombre || '—' }}</td>
            <td><span class="ap-chips">@for (b of p.brands; track b.id) { <span class="ap-chip">{{ b.nombre }}</span> }</span></td>
            <td class="num">
              <button pButton [text]="true" size="small" (click)="edit(p)" aria-label="Editar"><span class="p-button-icon pi pi-pencil" aria-hidden="true"></span></button>
              <button pButton [text]="true" severity="danger" size="small" (click)="clear(p)" aria-label="Quitar"><span class="p-button-icon pi pi-trash" aria-hidden="true"></span></button>
            </td>
          </tr>
        </ng-template>
        <ng-template #emptymessage>
          <tr><td colspan="4" class="comm-empty-cell"><div class="comm-empty"><div class="comm-empty-icon"><i class="pi pi-users" aria-hidden="true"></i></div><h3>Sin promotores</h3><p>Asigná marcas a un usuario arriba.</p></div></td></tr>
        </ng-template>
      </p-table>
    </div>
  `,
  styles: [`
    .surf-card { background: var(--surface-card, var(--c-bg-1)); border: 1px solid var(--border-soft, var(--c-border)); border-radius: var(--radius-lg, 12px); padding: 1rem; margin-bottom: 1.5rem; }
    .ap-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 1rem; }
    .ap-col-2 { grid-column: span 1; }
    .ap-field { display: flex; flex-direction: column; gap: .35rem; }
    .ap-lbl { font-size: var(--fs-xs, .72rem); text-transform: uppercase; letter-spacing: .03em; color: var(--c-text-2, var(--text-muted)); }
    :host ::ng-deep .ap-full { width: 100%; }
    .ap-actions { margin-top: 1rem; display: flex; justify-content: flex-end; }
    .ap-h2 { font-size: var(--fs-md, 1rem); margin: 0 0 .5rem; }
    .ap-mono { font-family: var(--font-mono, monospace); }
    .ap-chips { display: flex; flex-wrap: wrap; gap: .3rem; }
    .ap-chip { padding: .1rem .5rem; border-radius: 999px; background: var(--c-bg-2, var(--surface-100)); font-size: var(--fs-xs, .72rem); }
    @media (max-width: 640px) { .ap-grid { grid-template-columns: 1fr; } }
  `],
})
export class AdminPromotersComponent {
  private readonly svc = inject(ComercialService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  users = signal<{ label: string; value: string }[]>([]);
  brands = signal<{ id: string; nombre: string }[]>([]);
  promoters = signal<{ user_id: string; username: string; nombre?: string; brands: { id: string; nombre: string }[] }[]>([]);
  loading = signal(false);
  saving = signal(false);

  selUser = '';
  selBrands: string[] = [];

  constructor() {
    this.svc.promoterCandidateUsers()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (us) => this.users.set((us || []).map((u) => ({ label: `${u.username}${u.nombre ? ' · ' + u.nombre : ''}`, value: u.id }))) });
    this.svc.assignableBrands()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (bs) => this.brands.set(bs || []) });
    this.load();
  }

  load() {
    this.loading.set(true);
    this.svc.listPromoters()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ps) => { this.promoters.set(ps || []); this.loading.set(false); },
        error: () => { this.loading.set(false); this.toast.add({ severity: 'error', summary: 'Error al cargar promotores' }); },
      });
  }

  /** Al elegir un usuario ya promotor, pre-carga sus marcas para editar. */
  onUserPick() {
    const p = this.promoters().find((x) => x.user_id === this.selUser);
    this.selBrands = p ? p.brands.map((b) => b.id) : [];
  }

  edit(p: { user_id: string; brands: { id: string }[] }) {
    this.selUser = p.user_id;
    this.selBrands = p.brands.map((b) => b.id);
  }

  save() {
    if (!this.selUser) return;
    this.saving.set(true);
    this.svc.setPromoterBrands(this.selUser, this.selBrands)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.saving.set(false); this.toast.add({ severity: 'success', summary: 'Asignación guardada' }); this.selUser = ''; this.selBrands = []; this.load(); },
        error: () => { this.saving.set(false); this.toast.add({ severity: 'error', summary: 'No se pudo guardar' }); },
      });
  }

  clear(p: { user_id: string }) {
    this.svc.setPromoterBrands(p.user_id, [])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => { this.toast.add({ severity: 'success', summary: 'Promotor quitado' }); this.load(); },
        error: () => this.toast.add({ severity: 'error', summary: 'No se pudo quitar' }),
      });
  }
}
