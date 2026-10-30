import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { CheckboxModule } from 'primeng/checkbox';
import { textoDocumento, type DocumentoEnCaja, type DocumentoQueEntra, type DocumentosDeMovimientoInput } from '@megadulces/contracts';
import { money, dmy } from '../pages/finanzas-format';

/** Un cheque o papel que llega con un cobro, mientras se teclea. */
export interface DocumentoQueEntraUI {
  tipo: 'cheque' | 'papel';
  monto: number | null;
  banco: string;
  numero: string;
  de_quien: string;
  concepto: string;
}

export function documentoNuevo(tipo: 'cheque' | 'papel', d: Partial<DocumentoQueEntraUI> = {}): DocumentoQueEntraUI {
  return { tipo, monto: null, banco: '', numero: '', de_quien: '', concepto: '', ...d };
}

const largo = (s: string, k: number) => String(s ?? '').trim().length >= k;

/** ¿Este documento ya dice todo lo que lo identifica? (las mismas reglas que el servidor) */
export function documentoCompleto(d: DocumentoQueEntraUI): boolean {
  if (!(Number(d.monto) > 0) || !largo(d.de_quien, 3)) return false;
  return d.tipo === 'cheque' ? largo(d.banco, 2) && largo(d.numero, 1) : largo(d.concepto, 3);
}

/** Lo que NO es efectivo del movimiento: lo que entró en cheque o papel, o los cheques con que se pagó. */
export function totalDeDocumentos(entran: readonly DocumentoQueEntraUI[], salen: readonly string[], enCaja: readonly DocumentoEnCaja[] | null): number {
  const e = entran.reduce((s, d) => s + (Number(d.monto) > 0 ? Number(d.monto) : 0), 0);
  const porPieza = new Map((enCaja ?? []).map((d) => [d.pieza, d.monto]));
  const s = salen.reduce((a, p) => a + (porPieza.get(p) ?? 0), 0);
  return Math.round((e + s) * 100) / 100;
}

/** Lo que se manda al servidor. `null` = el movimiento fue todo en efectivo. */
export function documentosParaGuardar(entran: readonly DocumentoQueEntraUI[], salen: readonly string[]): DocumentosDeMovimientoInput | null {
  if (!entran.length && !salen.length) return null;
  return {
    entran: entran.map((d): DocumentoQueEntra => ({
      tipo: d.tipo, monto: Number(d.monto), de_quien: d.de_quien.trim(),
      ...(d.tipo === 'cheque' ? { banco: d.banco.trim(), numero: d.numero.trim() } : { concepto: d.concepto.trim() }),
    })),
    salen: salen.map((pieza) => ({ pieza })),
  };
}

/**
 * ⭐ `[CGS.60]` **Con cheque o papel.** Edgar, 2026-10-30: «y si un movimiento se quiere hacer con
 * cheque, o papel (crédito)». En un cobro, lo que llegó en cheque o en papel (un cliente quedó a
 * deber); en un pago, los cheques de la caja con que se pagó. Nada de esto es efectivo: el monto
 * del movimiento es el efectivo contado MÁS esto, y el corte sólo pide el efectivo.
 *
 * Sustituye al campo «Venta a crédito», que era un importe sin decir quién debía: el papel lo dice.
 * La mayoría de los movimientos son todo en efectivo, por eso arranca en un renglón con dos botones.
 */
@Component({
  selector: 'app-movimiento-documentos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputNumberModule, InputTextModule, CheckboxModule],
  template: `
    <section class="md" aria-label="Con cheque o papel">
      <div class="md-cab">
        <span class="md-titulo">{{ tipo() === 'ingreso' ? '¿Llegó en cheque o en papel?' : '¿Se pagó con un cheque de la caja?' }}</span>
        @if (tipo() === 'ingreso') {
          <p-button label="Agregar cheque" icon="pi pi-plus" size="small" severity="secondary" [text]="true" (onClick)="agregar('cheque')" />
          <p-button label="Agregar papel (crédito)" icon="pi pi-plus" size="small" severity="secondary" [text]="true" (onClick)="agregar('papel')" />
        } @else if (!verCheques()) {
          <p-button label="Elegir cheque" icon="pi pi-list" size="small" severity="secondary" [text]="true" (onClick)="abrirCheques()" />
        }
      </div>

      @for (d of entran(); track $index; let i = $index) {
        <div class="md-fila" role="group" [attr.aria-label]="(d.tipo === 'cheque' ? 'Cheque ' : 'Papel ') + (i + 1)">
          <span class="md-tipo">{{ d.tipo === 'cheque' ? 'Cheque' : 'Papel' }}</span>
          @if (d.tipo === 'cheque') {
            <input pInputText placeholder="Banco" aria-label="Banco" [ngModel]="d.banco" (ngModelChange)="poner(i, 'banco', $event)" />
            <input pInputText placeholder="Número" aria-label="Número del cheque" [ngModel]="d.numero" (ngModelChange)="poner(i, 'numero', $event)" />
            <input pInputText class="md-ancho" placeholder="De quién (quién lo firma)" aria-label="De quién es el cheque"
                   [ngModel]="d.de_quien" (ngModelChange)="poner(i, 'de_quien', $event)" />
          } @else {
            <input pInputText placeholder="Quién debe" aria-label="Quién debe" [ngModel]="d.de_quien" (ngModelChange)="poner(i, 'de_quien', $event)" />
            <input pInputText class="md-ancho" placeholder="Por qué" aria-label="Por qué se debe" [ngModel]="d.concepto" (ngModelChange)="poner(i, 'concepto', $event)" />
          }
          <p-inputnumber mode="currency" currency="MXN" locale="es-MX" [min]="0" placeholder="Importe" ariaLabel="Importe"
                         [ngModel]="d.monto" (ngModelChange)="poner(i, 'monto', $event)" />
          <p-button icon="pi pi-times" size="small" [text]="true" severity="secondary" (onClick)="quitar(i)"
                    [ariaLabel]="'Quitar ' + (d.tipo === 'cheque' ? 'el cheque ' : 'el papel ') + (i + 1)" />
        </div>
      }

      @if (tipo() === 'gasto' && verCheques()) {
        @if (bloqueo(); as b) {
          <p class="md-nota">{{ b }}</p>
        } @else if (!enCaja()?.length) {
          <p class="md-nota">No hay cheques en la caja.</p>
        } @else {
          <ul class="md-lista">
            @for (c of enCaja(); track c.pieza) {
              <li class="md-cheque">
                <p-checkbox [inputId]="'md-' + c.pieza" [binary]="true" [ngModel]="salen().includes(c.pieza)" (ngModelChange)="elegir(c.pieza, $event)" />
                <label [for]="'md-' + c.pieza">{{ texto(c) }} <span class="md-dim">· en caja desde el {{ dmy(c.visto_desde) }}</span></label>
                <span class="md-num">{{ mx(c.monto) }}</span>
              </li>
            }
          </ul>
        }
      }

      @if (total() > 0) {
        <p class="md-total" role="status">En cheque o papel: <b class="md-num">{{ mx(total()) }}</b> · no es efectivo: el corte no lo pide en el cajón.</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .md { border-top: 1px solid var(--border-color); padding: .5rem 0; margin: .5rem 0; }
    .md-cab { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; }
    .md-titulo { font-size: var(--fs-sm, .875rem); color: var(--text-muted); margin-right: auto; }
    .md-fila { display: grid; grid-template-columns: 4rem repeat(auto-fit, minmax(8rem, 1fr)) auto; gap: .4rem; align-items: center; margin-top: .4rem; }
    .md-fila .md-ancho { grid-column: span 2; }
    .md-tipo { font-size: var(--fs-xs, .8rem); color: var(--text-muted); }
    .md-lista { list-style: none; margin: .4rem 0 0; padding: 0; display: grid; gap: .3rem; }
    .md-cheque { display: flex; align-items: center; gap: .5rem; }
    .md-cheque label { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm, .875rem); }
    .md-dim { color: var(--text-muted); font-size: var(--fs-xs, .8rem); }
    .md-num { font-variant-numeric: tabular-nums; }
    .md-nota, .md-total { margin: .4rem 0 0; font-size: var(--fs-xs, .8rem); color: var(--text-muted); }
  `],
})
export class MovimientoDocumentosComponent {
  readonly tipo = input.required<'ingreso' | 'gasto'>();
  /** Cobro: lo que llegó en cheque o en papel. Lo guarda el padre (es parte del monto). */
  readonly entran = model<DocumentoQueEntraUI[]>([]);
  /** Pago: las piezas de los cheques de la caja con que se pagó. */
  readonly salen = model<string[]>([]);
  /** Los cheques que hay en la caja (para el pago). `null` mientras no se pide la lista. */
  readonly enCaja = input<DocumentoEnCaja[] | null>(null);
  /** Por qué no se puede elegir cheque ahora (la lista no se pudo leer). `null` = se puede. */
  readonly bloqueo = input<string | null>(null);
  /** Abrir «Elegir cheque»: el padre lee la lista de la caja. */
  readonly pedirCheques = output<void>();
  /** Cambió algo: el padre recalcula el monto. */
  readonly cambio = output<void>();

  protected readonly dmy = dmy;
  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);
  protected readonly verCheques = computed(() => this.salen().length > 0 || this.enCaja() !== null || this.bloqueo() !== null);

  readonly total = computed(() => totalDeDocumentos(this.entran(), this.salen(), this.enCaja()));

  texto(d: DocumentoEnCaja): string { return textoDocumento(d); }

  agregar(tipo: 'cheque' | 'papel'): void {
    this.entran.update((l) => [...l, documentoNuevo(tipo)]);
    this.cambio.emit();
  }

  poner<K extends keyof DocumentoQueEntraUI>(i: number, campo: K, valor: DocumentoQueEntraUI[K]): void {
    this.entran.update((l) => l.map((d, j) => (j === i ? { ...d, [campo]: valor } : d)));
    this.cambio.emit();
  }

  quitar(i: number): void {
    this.entran.update((l) => l.filter((_, j) => j !== i));
    this.cambio.emit();
  }

  abrirCheques(): void {
    this.pedirCheques.emit();
  }

  elegir(pieza: string, si: boolean): void {
    this.salen.update((l) => (si ? (l.includes(pieza) ? l : [...l, pieza]) : l.filter((p) => p !== pieza)));
    this.cambio.emit();
  }
}
