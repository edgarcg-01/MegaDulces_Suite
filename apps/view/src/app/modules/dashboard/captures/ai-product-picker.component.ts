import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import {
  AiProductMatcherService,
  MatchedItem,
  MatchedProduct,
  MatchResponse,
} from './ai-product-matcher.service';
import { BrandGroup } from './daily-capture.models';
import { HapticService } from '../../../core/services/haptic.service';

type UiState = 'idle' | 'loading' | 'preview' | 'error';

/**
 * Item de UI: extiende `MatchedItem` con la decisión local del usuario
 * (`selectedProductId` puede ser el suggested, una alternativa, o null si
 * descartó). `confirmed` significa "este item se va a aplicar".
 */
interface UiItem extends MatchedItem {
  selectedProductId: string | null;
  confirmed: boolean;
}

@Component({
  selector: 'app-ai-product-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    InputTextModule,
    TagModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './ai-product-picker.component.html',
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      height: 100%;
    }
  `],
})
export class AiProductPickerComponent {
  private readonly svc = inject(AiProductMatcherService);
  private readonly toast = inject(MessageService);
  private readonly haptic = inject(HapticService);

  /** Catálogo agrupado por marca, para mostrar nombre + lookup en alternativas. */
  @Input() catalog: BrandGroup[] = [];

  /** Lista actual de pids ya seleccionados — los reflejamos como "ya añadido". */
  @Input() currentSelected: string[] = [];

  /** Emite los pids netos a agregar a `productosMarcados` (sin los ya seleccionados). */
  @Output() applied = new EventEmitter<string[]>();

  /** Emite cuando el usuario cancela / cierra el modal sin aplicar. */
  @Output() cancelled = new EventEmitter<void>();

  readonly state = signal<UiState>('idle');
  readonly errorMsg = signal<string>('');
  readonly rawText = signal<string>('');
  readonly items = signal<UiItem[]>([]);
  readonly meta = signal<MatchResponse['meta'] | null>(null);

  readonly canApply = computed(() => {
    const its = this.items();
    return its.some((it) => it.confirmed && it.selectedProductId);
  });

  readonly summary = computed(() => {
    const its = this.items();
    return {
      total: its.length,
      autoConfirmed: its.filter((it) => it.suggested?.autoConfirm).length,
      confirmed: its.filter((it) => it.confirmed && it.selectedProductId).length,
      notFound: its.filter((it) => !it.suggested).length,
    };
  });

  async onSubmit(): Promise<void> {
    const text = this.rawText().trim();
    if (!text) return;

    this.state.set('loading');
    this.errorMsg.set('');

    try {
      const res = await new Promise<MatchResponse>((resolve, reject) => {
        this.svc.match(text).subscribe({ next: resolve, error: reject });
      });

      const ui: UiItem[] = res.items.map((it) => ({
        ...it,
        // Pre-selección: si el sugerido tiene autoConfirm, lo dejamos checked
        // por default. Si no, queda sin selección — usuario decide.
        selectedProductId: it.suggested?.autoConfirm ? it.suggested.product_id : null,
        confirmed: !!it.suggested?.autoConfirm,
      }));
      this.items.set(ui);
      this.meta.set(res.meta);
      this.state.set('preview');
      this.haptic.impact('light');
    } catch (err: any) {
      const status = err?.status;
      let msg = err?.error?.message || err?.message || 'Error desconocido';
      if (status === 401) msg = 'Sesión expirada. Recarga la página.';
      else if (status === 429) msg = 'Demasiados pedidos. Esperá un minuto.';
      else if (status === 400) msg = `Texto inválido: ${msg}`;
      this.errorMsg.set(msg);
      this.state.set('error');
      this.haptic.notification('error');
    }
  }

  onSelectAlternative(itemIndex: number, productId: string): void {
    this.haptic.selection();
    this.items.update((list) =>
      list.map((it, i) =>
        i === itemIndex ? { ...it, selectedProductId: productId, confirmed: true } : it,
      ),
    );
  }

  onToggleConfirm(itemIndex: number): void {
    this.haptic.selection();
    this.items.update((list) =>
      list.map((it, i) => {
        if (i !== itemIndex) return it;
        const willConfirm = !it.confirmed;
        // Si no hay selección y se está confirmando, default al suggested.
        const selectedProductId =
          willConfirm && !it.selectedProductId
            ? it.suggested?.product_id ?? null
            : it.selectedProductId;
        return { ...it, confirmed: willConfirm, selectedProductId };
      }),
    );
  }

  onReset(): void {
    this.rawText.set('');
    this.items.set([]);
    this.meta.set(null);
    this.state.set('idle');
    this.errorMsg.set('');
  }

  onApply(): void {
    const its = this.items();
    const pids = its
      .filter((it) => it.confirmed && it.selectedProductId)
      .map((it) => it.selectedProductId!) // safe por filter
      .filter((pid) => !this.currentSelected.includes(pid)); // dedupe contra ya seleccionados

    if (pids.length === 0) {
      this.haptic.notification('warning');
      this.toast.add({
        severity: 'warn',
        summary: 'Nada para agregar',
        detail: 'No hay items confirmados o ya estaban todos seleccionados.',
        life: 3000,
      });
      return;
    }
    this.haptic.impact('medium');
    this.applied.emit(pids);
  }

  onCancel(): void {
    this.cancelled.emit();
  }

  /**
   * Color del border / tag según el score del suggested.
   *   - verde: backend lo marcó autoConfirm (score >= 0.40 post-K.1.7).
   *   - amarillo: score >= 0.30 (revisión humana recomendada).
   *   - rojo: < 0.30 o sin suggested (no encontrado).
   */
  severity(item: UiItem): 'success' | 'warn' | 'danger' {
    if (!item.suggested) return 'danger';
    if (item.suggested.autoConfirm) return 'success';
    if (item.suggested.score >= 0.3) return 'warn';
    return 'danger';
  }

  alreadyInList(productId: string): boolean {
    return this.currentSelected.includes(productId);
  }

  trackByRawIndex(idx: number, _it: UiItem): number {
    return idx;
  }

  trackByProductId(_: number, p: MatchedProduct): string {
    return p.product_id;
  }
}
