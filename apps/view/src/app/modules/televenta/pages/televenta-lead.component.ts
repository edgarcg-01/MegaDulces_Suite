import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { SelectModule } from 'primeng/select';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { CheckboxModule } from 'primeng/checkbox';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageService } from 'primeng/api';
import {
  TeleventaService,
  CustomerSnapshot,
  CallOutcome,
} from '../televenta.service';

interface OutcomeOption {
  label: string;
  value: CallOutcome;
  severity: 'success' | 'danger' | 'warn' | 'info' | 'secondary';
}

const OUTCOMES: OutcomeOption[] = [
  { label: 'Venta confirmada', value: 'sale', severity: 'success' },
  { label: 'No vendió', value: 'no_sale', severity: 'danger' },
  { label: 'Llamar después (callback)', value: 'callback_scheduled', severity: 'warn' },
  { label: 'No contestó', value: 'no_answer', severity: 'info' },
  { label: 'Contacto equivocado', value: 'wrong_contact', severity: 'secondary' },
  { label: 'Otro', value: 'other', severity: 'secondary' },
];

@Component({
  selector: 'app-televenta-lead',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    ButtonModule,
    TagModule,
    DialogModule,
    InputTextModule,
    TextareaModule,
    SelectModule,
    InputNumberModule,
    DatePickerModule,
    CheckboxModule,
    ProgressSpinnerModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *ngIf="!loading() && snapshot() as snap; else loadingTpl" class="lead">
      <a routerLink="/televenta/queue" class="back-link">
        <i class="pi pi-arrow-left" aria-hidden="true"></i> Volver a la cola
      </a>

      <header class="card head">
        <div>
          <p class="code">{{ snap.customer.code }}</p>
          <h1>{{ snap.customer.name }}</h1>
          <div class="contact">
            <a *ngIf="snap.customer.phone" [href]="'tel:' + snap.customer.phone">
              <i class="pi pi-phone" aria-hidden="true"></i> {{ snap.customer.phone }}
            </a>
            <a *ngIf="snap.customer.email" [href]="'mailto:' + snap.customer.email">
              <i class="pi pi-envelope" aria-hidden="true"></i> {{ snap.customer.email }}
            </a>
          </div>
        </div>
        <div *ngIf="snap.reservation as res" class="reservation">
          <p class="ttl-label">Reservado por vos · vence en</p>
          <p class="ttl">{{ formatTtl(res.expires_in_seconds) }}</p>
        </div>
      </header>

      <!-- Acciones principales -->
      <div class="actions-row">
        <button
          pButton
          icon="pi pi-shopping-cart"
          label="Tomar pedido"
          (click)="takeOrder(snap.customer.id)"
        ></button>
        <button
          pButton
          icon="pi pi-pencil"
          label="Registrar llamada"
          severity="secondary"
          (click)="openLogModal()"
        ></button>
      </div>

      <!-- Info comercial -->
      <div class="card">
        <h2>Datos comerciales</h2>
        <dl class="kv">
          <div>
            <dt>Límite de crédito</dt>
            <dd>\${{ (snap.customer.credit_limit ?? 0) | number:'1.0-2' }} MXN</dd>
          </div>
          <div>
            <dt>Saldo actual</dt>
            <dd [class.over]="(snap.customer.balance ?? 0) > (snap.customer.credit_limit ?? 0)">
              \${{ (snap.customer.balance ?? 0) | number:'1.0-2' }} MXN
            </dd>
          </div>
          <div>
            <dt>Plazo de pago</dt>
            <dd>{{ snap.customer.payment_terms_days ?? 0 }} días</dd>
          </div>
        </dl>
        <p *ngIf="snap.customer.notes" class="notes">
          <i class="pi pi-info-circle" aria-hidden="true"></i> {{ snap.customer.notes }}
        </p>
      </div>

      <!-- Recent orders -->
      <div class="card">
        <h2>Últimos pedidos <span class="count">({{ snap.recent_orders.length }})</span></h2>
        <div *ngIf="snap.recent_orders.length === 0" class="empty-mini">Sin pedidos recientes.</div>
        <ul class="orders">
          <li *ngFor="let o of snap.recent_orders" class="order">
            <span class="o-code">{{ o.code }}</span>
            <p-tag [value]="o.status" [severity]="orderSeverity(o.status)"></p-tag>
            <span class="o-total">\${{ o.total | number:'1.0-2' }}</span>
            <time class="o-date">{{ o.created_at | date:'short' }}</time>
          </li>
        </ul>
      </div>

      <!-- Recent calls -->
      <div class="card">
        <h2>Historial de llamadas <span class="count">({{ snap.recent_calls.length }})</span></h2>
        <div *ngIf="snap.recent_calls.length === 0" class="empty-mini">Sin llamadas previas.</div>
        <ul class="calls">
          <li *ngFor="let c of snap.recent_calls" class="call">
            <div class="call-head">
              <p-tag [value]="outcomeLabel(c.outcome)" [severity]="outcomeSeverity(c.outcome)"></p-tag>
              <time>{{ c.called_at | date:'short' }}</time>
            </div>
            <p *ngIf="c.notes" class="call-notes">{{ c.notes }}</p>
            <p class="call-meta">Por {{ c.operator_username || '—' }}</p>
          </li>
        </ul>
      </div>
    </section>

    <ng-template #loadingTpl>
      <div class="loading" aria-live="polite">
        <p-progressSpinner styleClass="w-12 h-12"></p-progressSpinner>
      </div>
    </ng-template>

    <!-- Modal: Registrar llamada -->
    <p-dialog
      [(visible)]="showLogModalRef"
      [modal]="true"
      [closable]="!saving()"
      header="Registrar resultado de la llamada"
      [style]="{ width: '92vw', maxWidth: '480px' }"
    >
      <form class="log-form" (submit)="submitLog($event)">
        <label>
          <span>Resultado</span>
          <p-select
            [(ngModel)]="logOutcome"
            name="outcome"
            [options]="outcomes"
            optionLabel="label"
            optionValue="value"
            placeholder="Seleccioná"
            [style]="{ width: '100%' }"
            appendTo="body"
          ></p-select>
        </label>

        <label *ngIf="logOutcome === 'callback_scheduled'">
          <span>Cuándo volver a llamar</span>
          <p-datepicker
            [(ngModel)]="logNextAction"
            name="next_action_at"
            [showTime]="true"
            hourFormat="24"
            [minDate]="nowDate"
            [style]="{ width: '100%' }"
            appendTo="body"
          ></p-datepicker>
        </label>

        <label>
          <span>Notas</span>
          <textarea
            pTextarea
            [(ngModel)]="logNotes"
            name="notes"
            rows="3"
            placeholder="Detalle del resultado, comentarios del cliente..."
          ></textarea>
        </label>

        <label>
          <span>Duración (minutos)</span>
          <p-inputNumber
            [(ngModel)]="logDuration"
            name="duration"
            [min]="0"
            [max]="999"
            [showButtons]="true"
            [style]="{ width: '100%' }"
          ></p-inputNumber>
        </label>

        <label class="checkbox-row">
          <p-checkbox
            [(ngModel)]="logReleaseRes"
            name="release_reservation"
            binary="true"
            inputId="release"
          ></p-checkbox>
          <span for="release">Liberar reserva al guardar</span>
        </label>

        <div class="modal-actions">
          <button
            pButton
            type="button"
            label="Cancelar"
            severity="secondary"
            [text]="true"
            (click)="showLogModalRef = false"
            [disabled]="saving()"
          ></button>
          <button
            pButton
            type="submit"
            label="Guardar"
            icon="pi pi-check"
            [disabled]="!canSubmit() || saving()"
            [loading]="saving()"
          ></button>
        </div>
      </form>
    </p-dialog>
  `,
  styles: [
    `
      .lead { display: flex; flex-direction: column; gap: 1rem; }
      .back-link {
        display: inline-flex; align-items: center; gap: 0.4rem;
        color: var(--text-color-secondary); font-size: 0.875rem;
        text-decoration: none; min-height: 36px;
      }
      .back-link:hover { color: var(--primary-color); }
      .card {
        background: var(--surface-card);
        border: 1px solid var(--surface-border);
        border-radius: 16px;
        padding: 1.25rem;
      }
      .card h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.75rem; color: var(--text-color); display: flex; align-items: center; gap: 0.5rem; }
      .count { font-size: 0.8rem; color: var(--text-color-secondary); font-weight: 400; }
      .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
      .head h1 { font-size: 1.5rem; font-weight: 700; margin: 0.25rem 0; color: var(--text-color); }
      .code { font-size: 0.75rem; color: var(--text-color-secondary); margin: 0; font-weight: 600; letter-spacing: 0.04em; }
      .contact { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 0.5rem; }
      .contact a { color: var(--primary-color); text-decoration: none; font-size: 0.875rem; min-height: 28px; display: inline-flex; align-items: center; gap: 0.3rem; }
      .contact a:hover { text-decoration: underline; }
      .reservation { background: var(--warn-soft-bg); border: 1px solid var(--warn-border); border-radius: 12px; padding: 0.75rem; text-align: right; }
      .ttl-label { font-size: 0.7rem; color: var(--warn-soft-fg); margin: 0; }
      .ttl { font-size: 1.1rem; font-weight: 700; color: var(--brand-700); margin: 0.1rem 0 0; }
      .actions-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 0; }
      .kv > div { background: var(--neutral-50); padding: 0.75rem; border-radius: 10px; }
      .kv dt { font-size: 0.7rem; color: var(--text-color-secondary); margin: 0; letter-spacing: 0.03em; }
      .kv dd { font-size: 1rem; font-weight: 600; margin: 0.2rem 0 0; color: var(--text-color); }
      .kv dd.over { color: var(--bad-fg); }
      .notes { font-size: 0.85rem; color: var(--text-color); background: var(--info-soft-bg); padding: 0.6rem; border-radius: 8px; margin: 0.75rem 0 0; display: flex; gap: 0.4rem; align-items: flex-start; }
      .notes i { color: var(--info-fg); margin-top: 0.15rem; }
      .empty-mini { font-size: 0.85rem; color: var(--text-color-secondary); font-style: italic; }
      .orders, .calls { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
      .order { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0.75rem; background: var(--neutral-50); border-radius: 10px; flex-wrap: wrap; }
      .o-code { font-weight: 600; font-size: 0.85rem; font-family: ui-monospace, monospace; }
      .o-total { font-weight: 600; margin-left: auto; font-size: 0.95rem; }
      .o-date { font-size: 0.75rem; color: var(--text-color-secondary); }
      .call { padding: 0.75rem; background: var(--neutral-50); border-radius: 10px; }
      .call-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
      .call-head time { font-size: 0.75rem; color: var(--text-color-secondary); }
      .call-notes { font-size: 0.85rem; margin: 0.5rem 0 0; color: var(--text-color); white-space: pre-wrap; }
      .call-meta { font-size: 0.7rem; color: var(--text-color-secondary); margin: 0.3rem 0 0; }
      .loading { display: flex; justify-content: center; padding: 4rem 0; }
      .log-form { display: flex; flex-direction: column; gap: 1rem; padding-top: 0.5rem; }
      .log-form label { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.875rem; }
      .log-form label > span:first-child { font-weight: 500; color: var(--text-color); }
      .checkbox-row { flex-direction: row !important; align-items: center; gap: 0.5rem !important; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--surface-border); margin-top: 0.5rem; }
    `,
  ],
})
export class TeleventaLeadComponent implements OnInit {
  private readonly svc = inject(TeleventaService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(MessageService);

  readonly outcomes = OUTCOMES;
  readonly nowDate = new Date();

  readonly snapshot = signal<CustomerSnapshot | null>(null);
  readonly loading = signal<boolean>(true);
  readonly showLogModal = signal<boolean>(false);
  readonly saving = signal<boolean>(false);
  customerId = '';

  // ngModel state of modal form
  logOutcome: CallOutcome | null = null;
  logNotes = '';
  logDuration: number | null = null;
  logNextAction: Date | null = null;
  logReleaseRes = true;

  // Bridge para [(visible)] del p-dialog (espera property regular).
  get showLogModalRef(): boolean { return this.showLogModal(); }
  set showLogModalRef(v: boolean) { this.showLogModal.set(v); }

  ngOnInit(): void {
    this.customerId = this.route.snapshot.paramMap.get('customer_id') || '';
    this.refresh();
  }

  refresh(): void {
    if (!this.customerId) return;
    this.loading.set(true);
    this.svc.getCustomerSnapshot(this.customerId).subscribe({
      next: (snap) => { this.snapshot.set(snap); this.loading.set(false); },
      error: (err) => {
        this.loading.set(false);
        this.toast.add({
          severity: 'error', summary: 'Error',
          detail: err?.error?.message || 'No se pudo cargar el cliente.',
        });
      },
    });
  }

  openLogModal(): void {
    this.logOutcome = null;
    this.logNotes = '';
    this.logDuration = null;
    this.logNextAction = null;
    this.logReleaseRes = true;
    this.showLogModal.set(true);
  }

  canSubmit(): boolean {
    if (!this.logOutcome) return false;
    if (this.logOutcome === 'callback_scheduled' && !this.logNextAction) return false;
    return true;
  }

  submitLog(ev: Event): void {
    ev.preventDefault();
    if (!this.canSubmit() || !this.logOutcome) return;
    this.saving.set(true);
    this.svc
      .logCall({
        customer_id: this.customerId,
        outcome: this.logOutcome,
        notes: this.logNotes || undefined,
        duration_minutes: this.logDuration ?? undefined,
        next_action_at: this.logNextAction ? this.logNextAction.toISOString() : undefined,
        release_reservation: this.logReleaseRes,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.showLogModal.set(false);
          this.toast.add({
            severity: 'success', summary: 'Registrado',
            detail: this.logReleaseRes ? 'Llamada guardada y reserva liberada.' : 'Llamada guardada.',
          });
          if (this.logReleaseRes) {
            this.router.navigate(['/televenta/queue']);
          } else {
            this.refresh();
          }
        },
        error: (err) => {
          this.saving.set(false);
          this.toast.add({
            severity: 'error', summary: 'Error',
            detail: err?.error?.message || 'No se pudo registrar la llamada.',
          });
        },
      });
  }

  takeOrder(customerId: string): void {
    this.router.navigate(['/televenta/lead', customerId, 'take-order']);
  }

  formatTtl(secs: number): string {
    if (secs <= 0) return 'expirada';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  outcomeLabel(o: string): string {
    return OUTCOMES.find((x) => x.value === o)?.label || o;
  }
  outcomeSeverity(o: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    return OUTCOMES.find((x) => x.value === o)?.severity || 'secondary';
  }
  orderSeverity(s: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    if (s === 'fulfilled') return 'success';
    if (s === 'confirmed') return 'info';
    if (s === 'cancelled') return 'danger';
    if (s === 'draft') return 'secondary';
    return 'warn';
  }
}
