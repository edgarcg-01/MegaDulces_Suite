import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { SelectButtonModule } from 'primeng/selectbutton';
import { MessageService, ConfirmationService } from 'primeng/api';
import {
  Checklist,
  ChecklistItem,
  ChecklistResponse,
  ChecklistType,
  LogisticaService,
  Shipment,
} from '../logistica.service';

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

@Component({
  selector: 'app-logistica-checklist',
  standalone: true,
  imports: [
    CommonModule, RouterLink, FormsModule,
    ButtonModule, CardModule, TagModule, InputTextModule, TextareaModule,
    ToastModule, ConfirmDialogModule, SelectButtonModule,
  ],
  providers: [MessageService, ConfirmationService],
  template: `
    <p-toast></p-toast>
    <p-confirmDialog></p-confirmDialog>

    <header class="surf-page-head" *ngIf="shipment() as s">
      <div class="surf-page-head-text">
        <a [routerLink]="['/logistica/shipments', s.id]" class="back"><i class="pi pi-arrow-left"></i> Volver al embarque</a>
        <h1>Checklists — <code>{{ s.folio }}</code></h1>
        <p class="surf-page-sub">Estado actual: <p-tag [value]="s.status" [severity]="severityStatus(s.status)"></p-tag></p>
      </div>
    </header>

    <!-- Crear nuevo checklist -->
    <p-card *ngIf="shipment() as s">
      <h3>Nuevo checklist</h3>
      <div class="new-row">
        <p-selectButton
          [options]="typeOptions"
          [(ngModel)]="newType"
          optionLabel="label"
          optionValue="value"
        ></p-selectButton>
        <button pButton icon="pi pi-plus" label="Crear checklist" (click)="createNew()" [loading]="creating()"></button>
      </div>
    </p-card>

    <!-- Lista de checklists del shipment -->
    <ng-container *ngIf="checklists() as list">
      <p-card *ngFor="let cl of list" class="checklist-card">
        <div class="cl-header">
          <h3>
            <i [class]="cl.type === 'salida' ? 'pi pi-sign-out' : 'pi pi-sign-in'"></i>
            Checklist {{ cl.type === 'salida' ? 'de salida' : 'de llegada' }}
          </h3>
          <p-tag
            [value]="cl.status"
            [severity]="cl.status === 'completado' ? 'success' : 'warn'"
          ></p-tag>
        </div>
        <p class="muted" *ngIf="cl.completed_at">
          Completado: {{ cl.completed_at | date:'short' }}
        </p>

        <div class="items-grid">
          <div *ngFor="let item of cl.items" class="item-row">
            <div class="item-label">
              <strong>{{ item.label }}</strong>
              <span class="req" *ngIf="item.required">*</span>
              <small *ngIf="item.group" class="group-tag">{{ item.group }}</small>
            </div>
            <div class="item-controls" *ngIf="cl.status === 'pendiente'">
              <p-selectButton
                [options]="okOptions"
                [(ngModel)]="responses[cl.id][item.id].ok"
                optionLabel="label"
                optionValue="value"
              ></p-selectButton>
              <input
                pInputText
                [(ngModel)]="responses[cl.id][item.id].comment"
                placeholder="Comentario (opcional)"
                class="comment-input"
              />
            </div>
            <div class="item-result" *ngIf="cl.status === 'completado' && cl.responses">
              <p-tag
                [value]="responseFor(cl, item.id)?.ok ? 'OK' : 'Issue'"
                [severity]="responseFor(cl, item.id)?.ok ? 'success' : 'danger'"
              ></p-tag>
              <span *ngIf="responseFor(cl, item.id)?.comment" class="comment-shown">
                {{ responseFor(cl, item.id)?.comment }}
              </span>
            </div>
          </div>
        </div>

        <div class="cl-footer" *ngIf="cl.status === 'pendiente'">
          <label>
            Notas generales
            <textarea pTextarea rows="2" [(ngModel)]="notesByChecklist[cl.id]"></textarea>
          </label>
          <button
            pButton
            icon="pi pi-check"
            label="Marcar completado"
            (click)="complete(cl)"
            [loading]="completing() === cl.id"
          ></button>
        </div>
      </p-card>

      <p-card *ngIf="!list.length">
        <p class="muted">No hay checklists todavía para este embarque. Crea uno con los botones de arriba.</p>
      </p-card>
    </ng-container>
  `,
  styles: [`
    :host { display:block; }
    .back { color: var(--primary-color); text-decoration:none; font-size:.85rem; }
    .muted { color: var(--text-color-secondary); font-size:.85rem; margin:0; }
    .new-row { display:flex; gap:1rem; align-items:center; flex-wrap:wrap; }
    .checklist-card { margin-top:1rem; }
    .cl-header { display:flex; justify-content:space-between; align-items:center; }
    .cl-header h3 { margin:0; font-size:1.1rem; }
    .items-grid { display:flex; flex-direction:column; gap:.5rem; margin-top:1rem; }
    .item-row { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.5rem; border:1px solid var(--surface-200); border-radius:6px; flex-wrap:wrap; }
    .item-label { display:flex; flex-direction:column; gap:.15rem; }
    .req { color: var(--red-500); margin-left:.25rem; }
    .group-tag { background: var(--surface-100); padding:.1rem .4rem; border-radius:4px; font-size:.7rem; color: var(--text-color-secondary); }
    .item-controls { display:flex; gap:.5rem; align-items:center; }
    .comment-input { min-width: 200px; }
    .item-result { display:flex; gap:.5rem; align-items:center; }
    .comment-shown { font-size:.85rem; color: var(--text-color-secondary); }
    .cl-footer { display:flex; gap:1rem; align-items:flex-end; margin-top:1rem; flex-wrap:wrap; }
    .cl-footer label { flex:1; display:flex; flex-direction:column; gap:.25rem; font-size:.8rem; color: var(--text-color-secondary); min-width:240px; }
    .cl-footer textarea { width:100%; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogisticaChecklistComponent {
  private readonly api = inject(LogisticaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);
  private readonly confirm = inject(ConfirmationService);

  readonly shipmentId = signal<string>('');
  readonly shipment = signal<Shipment | null>(null);
  readonly checklists = signal<Checklist[]>([]);
  readonly creating = signal(false);
  readonly completing = signal<string | null>(null);

  newType: ChecklistType = 'salida';
  responses: Record<string, Record<string, ChecklistResponse>> = {};
  notesByChecklist: Record<string, string> = {};

  readonly typeOptions = [
    { label: 'Salida (pre-departure)', value: 'salida' },
    { label: 'Llegada (post-arrival)', value: 'llegada' },
  ];
  readonly okOptions = [
    { label: 'OK', value: true },
    { label: 'Issue', value: false },
  ];

  constructor() {
    const id = this.route.snapshot.paramMap.get('shipmentId');
    if (!id) {
      this.router.navigate(['/logistica/shipments']);
      return;
    }
    this.shipmentId.set(id);
    this.loadShipment();
    this.loadChecklists();
  }

  loadShipment(): void {
    this.api.getShipment(this.shipmentId()).subscribe({
      next: (s) => this.shipment.set(s),
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargó shipment' }),
    });
  }

  loadChecklists(): void {
    this.api.listChecklistsByShipment(this.shipmentId()).subscribe({
      next: (list) => {
        this.checklists.set(list);
        // Init responses + notes maps
        for (const cl of list) {
          if (!this.responses[cl.id]) {
            this.responses[cl.id] = {};
            for (const it of cl.items) {
              this.responses[cl.id][it.id] = { ok: true };
            }
          }
        }
      },
      error: () => this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se cargaron checklists' }),
    });
  }

  createNew(): void {
    this.creating.set(true);
    this.api.getChecklistTemplate(this.newType).subscribe({
      next: (tpl) => {
        this.api.createChecklist({
          shipment_id: this.shipmentId(),
          type: tpl.type,
          items: tpl.items,
        }).subscribe({
          next: () => {
            this.toast.add({ severity: 'success', summary: 'Checklist creado', detail: `Tipo ${this.newType}` });
            this.creating.set(false);
            this.loadChecklists();
          },
          error: (e) => {
            this.creating.set(false);
            const msg = e?.error?.message || 'No se creó checklist';
            this.toast.add({ severity: 'error', summary: 'Error', detail: msg });
          },
        });
      },
      error: () => {
        this.creating.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: 'No se obtuvo template' });
      },
    });
  }

  complete(cl: Checklist): void {
    this.completing.set(cl.id);
    this.api.completeChecklist(cl.id, {
      responses: this.responses[cl.id] || {},
      notes: this.notesByChecklist[cl.id],
    }).subscribe({
      next: () => {
        this.toast.add({ severity: 'success', summary: 'Completado', detail: 'Checklist marcado completado' });
        this.completing.set(null);
        this.loadChecklists();
      },
      error: (e) => {
        this.completing.set(null);
        const msg = e?.error?.message || 'No se completó';
        this.toast.add({ severity: 'error', summary: 'Error', detail: msg });
      },
    });
  }

  responseFor(cl: Checklist, itemId: string): ChecklistResponse | undefined {
    if (!cl.responses) return undefined;
    return cl.responses[itemId];
  }

  severityStatus(s: string): Severity {
    if (s === 'cerrado') return 'success';
    if (s === 'cancelado') return 'danger';
    if (s === 'en_ruta') return 'info';
    return 'warn';
  }
}
