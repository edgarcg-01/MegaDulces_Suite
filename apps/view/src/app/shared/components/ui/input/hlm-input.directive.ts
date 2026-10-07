import { Directive, Input, computed, signal } from '@angular/core';
import { hlm } from '@spartan-ng/ui-core';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ClassValue } from 'clsx';

export const inputVariants = cva(
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-10',
        sm: 'h-8 text-xs',
        lg: 'h-12 text-lg',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);
type InputVariants = VariantProps<typeof inputVariants>;

@Directive({
  selector: '[hlmInput]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class HlmInputDirective {
  private readonly _userClass = signal<ClassValue>('');
  @Input()
  set class(userClass: ClassValue) {
    this._userClass.set(userClass);
  }

  private readonly _size = signal<InputVariants['size']>('default');
  @Input()
  set size(size: InputVariants['size']) {
    this._size.set(size);
  }

  protected _computedClass = computed(() =>
    hlm(inputVariants({ size: this._size() }), this._userClass()),
  );
}
