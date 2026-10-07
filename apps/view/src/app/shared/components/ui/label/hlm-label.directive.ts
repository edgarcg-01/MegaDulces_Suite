import { Directive, Input, computed, signal } from '@angular/core';
import { hlm } from '@spartan-ng/ui-core';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ClassValue } from 'clsx';

export const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
  {
    variants: {
      variant: {
        default: '',
        destructive: 'text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);
type LabelVariants = VariantProps<typeof labelVariants>;

@Directive({
  selector: 'label[hlmLabel]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class HlmLabelDirective {
  private readonly _userClass = signal<ClassValue>('');
  @Input()
  set class(userClass: ClassValue) {
    this._userClass.set(userClass);
  }

  private readonly _variant = signal<LabelVariants['variant']>('default');
  @Input()
  set variant(variant: LabelVariants['variant']) {
    this._variant.set(variant);
  }

  protected _computedClass = computed(() =>
    hlm(labelVariants({ variant: this._variant() }), this._userClass()),
  );
}
