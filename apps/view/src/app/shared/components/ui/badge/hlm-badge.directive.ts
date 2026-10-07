import { Directive, Input, computed, signal } from '@angular/core';
import { hlm } from '@spartan-ng/ui-core';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ClassValue } from 'clsx';

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);
type BadgeVariants = VariantProps<typeof badgeVariants>;

@Directive({
  selector: '[hlmBadge]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class HlmBadgeDirective {
  private readonly _userClass = signal<ClassValue>('');
  @Input()
  set class(userClass: ClassValue) {
    this._userClass.set(userClass);
  }

  private readonly _variant = signal<BadgeVariants['variant']>('default');
  @Input()
  set variant(variant: BadgeVariants['variant']) {
    this._variant.set(variant);
  }

  protected _computedClass = computed(() =>
    hlm(badgeVariants({ variant: this._variant() }), this._userClass()),
  );
}
