import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormGroup } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { Customer } from '../comercial.service';
import { Route } from '../../logistica/logistica.service';

/**
 * Diálogo de alta/edición de cliente. Presentacional: el padre es dueño del
 * FormGroup y de la lógica (save/cancel/open). Extraído de comercial-customers
 * (CV.3) para adelgazar el god component. Usa clases globales `.comm-form-grid`.
 */
@Component({
  selector: 'app-customer-form-dialog',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    DialogModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog
      [visible]="visible"
      (visibleChange)="visibleChange.emit($event)"
      [modal]="true"
      [draggable]="false"
      [style]="{ width: '560px' }"
      [header]="editing ? 'Editar cliente' : 'Nuevo cliente'"
    >
      <form [formGroup]="form" class="comm-form-grid" *ngIf="form">
        <label>
          <span>Código <em>*</em></span>
          <input pInputText formControlName="code" placeholder="ej: ABARROTES-001" />
        </label>
        <label>
          <span>Nombre <em>*</em></span>
          <input pInputText formControlName="name" />
        </label>
        <label class="full">
          <span>Razón social</span>
          <input pInputText formControlName="legal_name" />
        </label>
        <label>
          <span>RFC</span>
          <input pInputText formControlName="rfc" maxlength="13" style="text-transform:uppercase" />
        </label>
        <label>
          <span>Email</span>
          <input pInputText formControlName="email" type="email" />
        </label>
        <label>
          <span>Teléfono</span>
          <input pInputText formControlName="phone" />
        </label>
        <label>
          <span>Límite de crédito (MXN)</span>
          <p-inputNumber formControlName="credit_limit" mode="currency" currency="MXN" locale="es-MX" />
        </label>
        <label>
          <span>Días de pago</span>
          <p-inputNumber formControlName="payment_terms_days" [min]="0" [max]="180" />
        </label>
        <label class="full">
          <span>Ruta de reparto</span>
          <p-select
            formControlName="route_id"
            [options]="routes"
            optionLabel="name"
            optionValue="id"
            placeholder="— Sin ruta asignada —"
            [filter]="true"
            filterBy="name"
            [showClear]="true"
            appendTo="body"
            styleClass="store-select"
          ></p-select>
          <span class="comm-muted is-small">
            La ruta se hereda automáticamente a cada pedido del cliente,
            así logística puede armar embarques agrupados por ruta.
          </span>
        </label>
        <label>
          <span>WhatsApp</span>
          <input pInputText formControlName="whatsapp" placeholder="10 dígitos (ej. 3331234567)" inputmode="tel" />
          <span class="comm-muted is-small">Número del cliente para contacto/bot. Se normaliza a +52…</span>
        </label>
        <label class="full" *ngIf="editingStoreName">
          <span>Tienda de origen (Trade Marketing)</span>
          <input pInputText [value]="editingStoreName" disabled />
          <span class="comm-muted is-small">
            Cada tienda de Trade es un cliente (1:1). El vínculo se fija al alta de la tienda — es de solo lectura.
          </span>
        </label>
        <label class="full">
          <span>Notas internas</span>
          <input pInputText formControlName="notes" placeholder="Visible solo para personal interno" />
        </label>
      </form>
      <ng-template pTemplate="footer">
        <button pButton label="Cancelar" severity="secondary" [outlined]="true" (click)="cancel.emit()"></button>
        <button pButton [label]="editing ? 'Guardar' : 'Crear'" icon="pi pi-check"
                [loading]="saving"
                [disabled]="form.invalid"
                (click)="save.emit()"></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    :host ::ng-deep .p-select.store-select { width: 100%; }
  `],
})
export class CustomerFormDialogComponent {
  @Input() visible = false;
  @Input({ required: true }) form!: FormGroup;
  @Input() editing: Customer | null = null;
  @Input() saving = false;
  @Input() routes: Route[] = [];
  @Input() editingStoreName: string | null = null;

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() save = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();
}
