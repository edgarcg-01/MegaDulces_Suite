import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MOTIVO_OTRO, NOTA_MOTIVO_MAX, errorDeMotivo, type MotivoElegido, type MotivoOpcion } from '@megadulces/contracts';

/**
 * `[MCP.18]` El justificante de la vendedora: elige el motivo (un toque) y, si quiere, una nota. Con
 * «Otro motivo» la nota es obligatoria. Lo usan «Corregir» (Por entregar) y «Cancelar» un pedido que
 * ya estaba agendado (Tomar pedido). El motivo lo ven el surtidor y la caja en el mismo pedido.
 */
@Component({
  selector: 'app-vendor-motivo-sheet',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mo-backdrop" (click)="!busy() && cancel.emit()"></div>
    <div #panel class="mo" role="dialog" aria-modal="true" aria-labelledby="mo-title" tabindex="-1">
      <div class="mo-handle" aria-hidden="true"></div>
      <h2 class="mo-title" id="mo-title">{{ titulo() }}</h2>
      @if (sub()) { <p class="mo-sub">{{ sub() }}</p> }
      <div class="mo-list" role="radiogroup" aria-labelledby="mo-title">
        @for (o of opciones(); track o.key) {
          <label class="mo-opt" [class.on]="motivo() === o.key">
            <input type="radio" name="mo-motivo" [value]="o.key" [checked]="motivo() === o.key" (change)="motivo.set(o.key)" />
            <span>{{ o.label }}</span>
          </label>
        }
      </div>
      <label class="mo-lbl" for="mo-nota">{{ motivo() === otro ? '¿Cuál fue el motivo?' : 'Nota (opcional)' }}</label>
      <textarea id="mo-nota" class="mo-nota" rows="2" [attr.maxlength]="notaMax"
        [ngModel]="nota()" (ngModelChange)="nota.set($event)"
        [placeholder]="motivo() === otro ? 'Escribe el motivo' : 'Algo que deban saber el surtidor o la caja'"></textarea>
      <p class="mo-aviso">Lo verán el surtidor y la caja en este pedido.</p>
      <button type="button" class="mo-ok" [disabled]="!!error() || busy()" (click)="submit()">
        <i class="pi" [class.pi-spin]="busy()" [class.pi-spinner]="busy()" [class.pi-check]="!busy()" aria-hidden="true"></i>
        {{ busy() ? 'Guardando…' : confirmarTexto() }}
      </button>
      <button type="button" class="mo-cancel" [disabled]="busy()" (click)="cancel.emit()">Volver</button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mo-backdrop { position: fixed; inset: 0; background: rgba(16,13,9,0.45); z-index: 60; }
    .mo {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 61;
      background: var(--card-bg); border-radius: var(--r-2xl, 24px) var(--r-2xl, 24px) 0 0;
      padding: 0.6rem 1rem calc(1.2rem + env(safe-area-inset-bottom));
      max-height: 90vh; overflow-y: auto; border-top: 1px solid var(--border-color);
    }
    .mo-handle { width: 2.5rem; height: 0.25rem; border-radius: var(--r-pill, 999px); background: var(--border-color); margin: 0 auto 0.75rem; }
    .mo-title { margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--text-main); }
    .mo-sub { margin: 0.15rem 0 0.75rem; font-size: var(--fs-sm); color: var(--text-muted); }
    .mo-list { display: flex; flex-direction: column; gap: 0.45rem; }
    .mo-opt {
      display: flex; align-items: center; gap: 0.75rem; min-height: 3rem; padding: 0 0.85rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 12px);
      font-size: 1rem; font-weight: 600; color: var(--text-main); cursor: pointer;
    }
    .mo-opt input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .mo-opt.on { border-color: var(--action); background: var(--overlay-selected, transparent); }
    .mo-opt:focus-within { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .mo-lbl { display: block; margin: 0.8rem 0 0.3rem; font-size: var(--fs-sm); font-weight: 700; color: var(--text-main); }
    .mo-nota {
      width: 100%; box-sizing: border-box; padding: 0.6rem 0.75rem; font: inherit; font-size: 1rem;
      border: 1px solid var(--border-color); border-radius: var(--r-md, 12px); background: var(--card-bg); color: var(--text-main);
    }
    .mo-nota:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }
    .mo-aviso { margin: 0.4rem 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .mo-ok {
      margin-top: 0.9rem; width: 100%; min-height: 3.25rem; border: none; border-radius: var(--r-lg, 16px);
      background: var(--action); color: var(--action-ink); font-weight: 800; font-size: 1.02rem;
      display: flex; align-items: center; justify-content: center; gap: 0.5rem; cursor: pointer;
    }
    .mo-ok:disabled { opacity: 0.5; cursor: default; }
    .mo-ok:focus-visible, .mo-cancel:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .mo-cancel {
      margin-top: 0.4rem; width: 100%; min-height: 2.9rem; border: none; background: none;
      color: var(--text-muted); font-weight: 700; font-size: 0.95rem; cursor: pointer;
    }
  `],
})
export class VendorMotivoSheetComponent implements OnInit, AfterViewInit {
  readonly titulo = input('¿Por qué?');
  readonly sub = input('');
  readonly opciones = input<readonly MotivoOpcion[]>([]);
  readonly confirmarTexto = input('Continuar');
  readonly busy = input(false);
  /** `[MCP.21]` El motivo ya marcado (sugerido por lo que cambió); se cambia con un toque. Uno que no está en la lista se ignora. */
  readonly inicial = input<string | null>(null);
  readonly confirm = output<MotivoElegido>();
  readonly cancel = output<void>();

  @ViewChild('panel') private panel?: ElementRef<HTMLElement>;

  readonly otro = MOTIVO_OTRO;
  readonly notaMax = NOTA_MOTIVO_MAX;
  readonly motivo = signal<string | null>(null);
  readonly nota = signal('');
  /** El mismo validador que el servidor: lo que aquí se deja enviar, allá se acepta. */
  readonly error = computed(() => errorDeMotivo(this.opciones(), { reason_code: this.motivo() ?? '', note: this.nota() }));

  ngOnInit(): void {
    const i = this.inicial();
    if (i && this.opciones().some((o) => o.key === i)) this.motivo.set(i);
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.panel?.nativeElement.focus(), 0);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.busy()) this.cancel.emit();
  }

  submit(): void {
    const m = this.motivo();
    if (!m || this.error() || this.busy()) return;
    const n = this.nota().trim();
    this.confirm.emit(n ? { reason_code: m, note: n } : { reason_code: m });
  }
}
