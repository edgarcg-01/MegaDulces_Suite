import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface SegOption { label: string; value: string; }

/**
 * Segmented control canónico (Operations). Track + pill activo, radiogroup accesible.
 * Reemplaza las 3 implementaciones ad-hoc (.co-segment / .so-segment / historical).
 */
@Component({
  selector: 'app-segmented',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="seg" role="radiogroup" [attr.aria-label]="ariaLabel()">
      @for (o of options(); track o.value) {
        <button type="button" role="radio" [attr.aria-checked]="value() === o.value"
                class="seg-btn" [class.on]="value() === o.value" (click)="pick(o.value)">{{ o.label }}</button>
      }
    </div>
  `,
  styles: [`
    .seg { display:inline-flex; align-items:stretch; background:var(--layout-bg); border:1px solid var(--border); border-radius:var(--r-sm,8px); padding:2px; gap:2px; }
    .seg-btn { border:0; background:transparent; padding:.4rem .7rem; font-size:var(--fs-xs,.8rem); font-weight:600; color:var(--text-muted); cursor:pointer; border-radius:6px; white-space:nowrap; transition:color 120ms var(--ease-standard), background 120ms var(--ease-standard); }
    .seg-btn:hover { color:var(--text-main); }
    .seg-btn.on { background:var(--card-bg); color:var(--text-main); box-shadow:0 1px 2px rgba(0,0,0,.08); }
  `],
})
export class SegmentedComponent {
  readonly options = input<SegOption[]>([]);
  readonly value = input<string>('');
  readonly ariaLabel = input<string>('');
  readonly valueChange = output<string>();
  pick(v: string): void { if (v !== this.value()) this.valueChange.emit(v); }
}
