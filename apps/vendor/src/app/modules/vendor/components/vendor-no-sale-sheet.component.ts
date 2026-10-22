import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, computed, input, output, signal, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NO_SALE_OPTIONS, NoSaleKey, noSaleIsValid } from '../visit-protocol';

/**
 * `[MCP.3.7]` «El cliente no pidió nada»: el vendedor escoge el motivo y la visita se cierra sin
 * pedido. «Otro» pide una explicación corta (sin ella el supervisor no sabe qué pasó).
 */
@Component({
  selector: 'app-vendor-no-sale-sheet',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ns-backdrop" (click)="cancel.emit()"></div>
    <div #panel class="ns" role="dialog" aria-modal="true" aria-labelledby="ns-title" tabindex="-1">
      <div class="ns-handle" aria-hidden="true"></div>
      <h2 class="ns-title" id="ns-title">¿Por qué no pidió nada?</h2>
      <p class="ns-who">{{ customerName() }}</p>
      <div class="ns-list" role="radiogroup" aria-labelledby="ns-title">
        @for (o of options; track o.key) {
          <label class="ns-opt" [class.on]="reason() === o.key">
            <input type="radio" name="ns-reason" [value]="o.key" [checked]="reason() === o.key" (change)="reason.set(o.key)" />
            <i class="pi {{ o.icon }}" aria-hidden="true"></i>
            <span>{{ o.label }}</span>
          </label>
        }
      </div>
      @if (reason() === 'otro') {
        <label class="ns-lbl" for="ns-notes">¿Qué pasó?</label>
        <textarea id="ns-notes" class="ns-notes" rows="2" maxlength="300"
          [ngModel]="notes()" (ngModelChange)="notes.set($event)"
          placeholder="Escribe el motivo"></textarea>
      }
      <button type="button" class="ns-ok" [disabled]="!valid() || busy()" (click)="submit()">
        <i class="pi" [class.pi-spin]="busy()" [class.pi-spinner]="busy()" [class.pi-check]="!busy()" aria-hidden="true"></i>
        {{ busy() ? 'Guardando…' : 'Cerrar visita sin pedido' }}
      </button>
      <button type="button" class="ns-cancel" [disabled]="busy()" (click)="cancel.emit()">Volver</button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ns-backdrop { position: fixed; inset: 0; background: rgba(16,13,9,0.45); z-index: 60; }
    .ns {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 61;
      background: var(--card-bg); border-radius: var(--r-2xl, 24px) var(--r-2xl, 24px) 0 0;
      padding: 0.6rem 1rem calc(1.2rem + env(safe-area-inset-bottom));
      max-height: 90vh; overflow-y: auto; border-top: 1px solid var(--border-color);
    }
    .ns-handle { width: 2.5rem; height: 0.25rem; border-radius: var(--r-pill, 999px); background: var(--border-color); margin: 0 auto 0.75rem; }
    .ns-title { margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--text-main); }
    .ns-who { margin: 0.15rem 0 0.75rem; font-size: var(--fs-sm); color: var(--text-muted); }
    .ns-list { display: flex; flex-direction: column; gap: 0.45rem; }
    .ns-opt {
      display: flex; align-items: center; gap: 0.75rem; min-height: 3rem; padding: 0 0.85rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 12px);
      font-size: 1rem; font-weight: 600; color: var(--text-main); cursor: pointer;
    }
    .ns-opt input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .ns-opt i { width: 1.4rem; text-align: center; color: var(--text-muted); }
    .ns-opt.on { border-color: var(--action); background: var(--overlay-selected, transparent); }
    .ns-opt.on i { color: var(--action); }
    .ns-opt:focus-within { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .ns-lbl { display: block; margin: 0.8rem 0 0.3rem; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .ns-notes {
      width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; font: inherit; font-size: 1rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); color: var(--text-main);
    }
    .ns-notes:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 1px; }
    .ns-ok {
      margin-top: 0.9rem; width: 100%; min-height: 3.25rem; border: none; border-radius: var(--r-lg, 16px);
      background: var(--action); color: var(--action-ink); font-weight: 800; font-size: 1.02rem;
      display: flex; align-items: center; justify-content: center; gap: 0.5rem; cursor: pointer;
    }
    .ns-ok:disabled { opacity: 0.5; cursor: default; }
    .ns-ok:focus-visible, .ns-cancel:focus-visible { outline: 2px solid var(--action-ring); outline-offset: 2px; }
    .ns-cancel {
      margin-top: 0.4rem; width: 100%; min-height: 2.9rem; border: none; background: none;
      color: var(--text-muted); font-weight: 700; font-size: 0.95rem; cursor: pointer;
    }
  `],
})
export class VendorNoSaleSheetComponent implements AfterViewInit {
  readonly customerName = input('');
  readonly busy = input(false);
  readonly confirm = output<{ reason: NoSaleKey; notes: string }>();
  readonly cancel = output<void>();

  @ViewChild('panel') private panel?: ElementRef<HTMLElement>;

  readonly options = NO_SALE_OPTIONS;
  readonly reason = signal<NoSaleKey | null>(null);
  readonly notes = signal('');
  readonly valid = computed(() => {
    const r = this.reason();
    const n = this.notes();
    return noSaleIsValid(r, n);
  });

  ngAfterViewInit(): void {
    setTimeout(() => this.panel?.nativeElement.focus(), 0);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.busy()) this.cancel.emit();
  }

  submit(): void {
    const r = this.reason();
    if (!r || !this.valid() || this.busy()) return;
    this.confirm.emit({ reason: r, notes: this.notes() });
  }
}
