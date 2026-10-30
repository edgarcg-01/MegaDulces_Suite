import { ChangeDetectionStrategy, Component, computed, effect, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import {
  CLASE_PAPEL_TEXTO, SALIDAS_DE, SALIDA_TEXTO, textoDocumento,
  type ApartadoEnCaja, type ClasePapel, type DocumentoArqueoInput, type DocumentoEnCaja, type SalidaDocumento,
  type TipoDocumentoCaja,
} from '@megadulces/contracts';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { money, dmy } from '../pages/finanzas-format';

/** Lo que se dijo de un documento que ya estaba: sigue o salió, y por qué. */
interface Marca { estado: 'esta' | 'salio' | ''; salida: SalidaDocumento | null; nota: string }

/** Un documento nuevo, mientras se teclea. */
export interface DocumentoNuevo {
  id: number;
  clase: ClasePapel | null;
  monto: number | null;
  banco: string;
  numero: string;
  de_quien: string;
  concepto: string;
  fecha: Date | null;
}

const SIN_MARCA: Marca = { estado: '', salida: null, nota: '' };
const SIGUE: SegOption[] = [{ label: 'Sigue', value: 'esta' }, { label: 'Salió', value: 'salio' }];
const CLASES: SegOption[] = (['vale', 'credito'] as const).map((c) => ({ label: CLASE_PAPEL_TEXTO[c], value: c }));
const aIso = (d: Date | null): string | null =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
const llave = (banco: string | null, numero: string | null): string =>
  `${String(banco ?? '').trim().toUpperCase()}|${String(numero ?? '').trim()}`;

/**
 * ⭐ `[CGS.59]` **Un apartado del arqueo: los cheques, o los vales y papeles, uno por uno.**
 *
 * Edgar, 2026-10-30: *«cuando hay un cheque, crédito o papel… cómo agregar esos apartados»*. Antes
 * era UN importe tecleado, y Control re-declaró el mismo importe de papeles en 383 arqueos sin que
 * nadie supiera quién debía ni por qué.
 *
 * Lo que había en el último arqueo se marca UNO POR UNO —sigue o salió, y si salió, por qué—; no
 * hay «todos siguen»: un clic por documento es lo mínimo que obliga a mirarlo. Lo nuevo se agrega
 * con lo que lo identifica. El importe del apartado no se teclea: es la suma de lo que está.
 *
 * Sin tocar nada, el apartado queda «no se contó» (`null`): distinto de «no hay» (`[]`).
 */
@Component({
  selector: 'app-arqueo-documentos',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputNumberModule, InputTextModule, SelectModule, DatePickerModule, SegmentedComponent],
  template: `
    <fieldset class="ad">
      <legend>{{ titulo() }}</legend>
      @if (bloqueo(); as b) {
        <p class="ad-nota">{{ b }}</p>
      } @else {
        @if (apartado()?.sin_detalle; as s) {
          <p class="ad-nota">
            Lo último que se sabía {{ s.origen === 'control' ? 'viene de Control' : 'es un arqueo sin detalle' }} ({{ dmy(s.at.slice(0, 10)) }}):
            <b class="ad-num">{{ mx(s.monto) }}</b> sin decir cuáles. Anota uno por uno lo que haya; lo que no anotes ya no cuenta.
          </p>
        }
        @if (anteriores().length) {
          <p class="ad-sub">Había {{ anteriores().length }} en el arqueo anterior: di de cada uno si sigue en la caja.</p>
          <ul class="ad-lista">
            @for (d of anteriores(); track d.pieza) {
              <li class="ad-fila">
                <span class="ad-txt">{{ texto(d) }} <span class="ad-dim">· en caja desde el {{ dmy(d.visto_desde) }}</span></span>
                <span class="ad-num">{{ mx(d.monto) }}</span>
                <app-segmented [options]="SIGUE" [value]="marca(d.pieza).estado" (valueChange)="marcar(d.pieza, $event)"
                               [ariaLabel]="'¿Sigue en la caja? ' + texto(d)" />
                @if (marca(d.pieza).estado === 'salio') {
                  <span class="ad-salida">
                    <p-select [options]="salidas()" optionLabel="label" optionValue="value" placeholder="¿Por qué salió?"
                              [ngModel]="marca(d.pieza).salida" (ngModelChange)="ponerSalida(d.pieza, $event)"
                              [ariaLabel]="'Por qué salió ' + texto(d)" appendTo="body" />
                    @if (marca(d.pieza).salida === 'otro') {
                      <input pInputText placeholder="Qué pasó" [attr.aria-label]="'Qué pasó con ' + texto(d)"
                             [ngModel]="marca(d.pieza).nota" (ngModelChange)="ponerNota(d.pieza, $event)" />
                    }
                  </span>
                }
              </li>
            }
          </ul>
        }
        @for (n of nuevos(); track n.id; let i = $index) {
          <div class="ad-nuevo" role="group" [attr.aria-label]="(tipo() === 'cheque' ? 'Cheque nuevo ' : 'Papel nuevo ') + (i + 1)">
            @if (tipo() === 'cheque') {
              <input pInputText placeholder="Banco" aria-label="Banco" [ngModel]="n.banco" (ngModelChange)="poner(n.id, 'banco', $event)" />
              <input pInputText placeholder="Número" aria-label="Número del cheque" [ngModel]="n.numero" (ngModelChange)="poner(n.id, 'numero', $event)" />
              <input pInputText class="ad-ancho" placeholder="De quién (quién lo firma)" aria-label="De quién es el cheque"
                     [ngModel]="n.de_quien" (ngModelChange)="poner(n.id, 'de_quien', $event)" />
            } @else {
              <app-segmented [options]="CLASES" [value]="n.clase ?? ''" (valueChange)="poner(n.id, 'clase', $event)" ariaLabel="Es vale o crédito" />
              <input pInputText placeholder="Quién debe" aria-label="Quién debe" [ngModel]="n.de_quien" (ngModelChange)="poner(n.id, 'de_quien', $event)" />
              <input pInputText class="ad-ancho" placeholder="Por qué" aria-label="Por qué se debe" [ngModel]="n.concepto" (ngModelChange)="poner(n.id, 'concepto', $event)" />
            }
            <p-inputnumber mode="currency" currency="MXN" locale="es-MX" [min]="0" placeholder="Importe" ariaLabel="Importe"
                           [ngModel]="n.monto" (ngModelChange)="poner(n.id, 'monto', $event)" />
            <p-datepicker [ngModel]="n.fecha" (ngModelChange)="poner(n.id, 'fecha', $event)" dateFormat="dd/mm/yy"
                          placeholder="Fecha (opcional)" ariaLabel="Fecha del documento" appendTo="body" />
            <p-button icon="pi pi-times" size="small" [text]="true" severity="secondary" (onClick)="quitar(n.id)"
                      [ariaLabel]="'Quitar ' + (tipo() === 'cheque' ? 'el cheque nuevo ' : 'el papel nuevo ') + (i + 1)" />
          </div>
        }
        <div class="ad-pie">
          <p-button [label]="tipo() === 'cheque' ? 'Agregar cheque' : 'Agregar papel'" icon="pi pi-plus" size="small"
                    severity="secondary" [outlined]="true" (onClick)="agregar()" />
          @if (!contado() && !anteriores().length) {
            <p-button [label]="tipo() === 'cheque' ? 'No hay cheques' : 'No hay papeles'" size="small" [text]="true" (onClick)="contado.set(true)" />
          }
          @if (contado()) {
            <p-button label="Dejar sin contar" size="small" [text]="true" severity="secondary" (onClick)="reiniciar()" />
          }
          <span class="ad-total" role="status">
            @if (contado()) { {{ titulo() }}: <b class="ad-num">{{ mx(total()) }}</b> · {{ enCaja() }} en caja }
            @else { Sin contar: queda como «no se contó». }
          </span>
        </div>
      }
    </fieldset>
  `,
  styles: [`
    :host { display: block; }
    .ad { border: 1px solid var(--border-color); border-radius: var(--r-sm, 8px); padding: .6rem .75rem; margin: .75rem 0 0; min-width: 0; }
    .ad legend { font-size: var(--fs-sm, .875rem); font-weight: 600; padding: 0 .25rem; }
    .ad-nota, .ad-sub { margin: .25rem 0 .5rem; font-size: var(--fs-xs, .8rem); color: var(--text-muted); }
    .ad-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: .35rem; }
    .ad-fila { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .3rem 0; border-bottom: 1px solid var(--border-color); }
    .ad-txt { flex: 1 1 14rem; min-width: 0; font-size: var(--fs-sm, .875rem); }
    .ad-dim { color: var(--text-muted); font-size: var(--fs-xs, .8rem); }
    .ad-num { font-variant-numeric: tabular-nums; }
    .ad-salida { display: flex; flex-wrap: wrap; gap: .4rem; flex-basis: 100%; }
    .ad-nuevo { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: .4rem; align-items: center; margin-top: .5rem; }
    .ad-nuevo .ad-ancho { grid-column: span 2; }
    .ad-pie { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .6rem; }
    .ad-total { margin-left: auto; font-size: var(--fs-sm, .875rem); }
  `],
})
export class ArqueoDocumentosComponent {
  readonly tipo = input.required<TipoDocumentoCaja>();
  /** Lo que había en el último arqueo que contó este apartado. `null` mientras se lee. */
  readonly apartado = input<ApartadoEnCaja | null>(null);
  /** Por qué no se puede contar ahora (la lectura falló, la base no lo tiene). `null` = se puede. */
  readonly bloqueo = input<string | null>(null);

  protected readonly SIGUE = SIGUE;
  protected readonly CLASES = CLASES;
  protected readonly dmy = dmy;
  protected readonly mx = (v: unknown): string => money(Number(v ?? 0) || 0);

  readonly contado = signal(false);
  readonly marcas = signal<Record<string, Marca>>({});
  readonly nuevos = signal<DocumentoNuevo[]>([]);
  private siguiente = 1;

  readonly titulo = computed(() => (this.tipo() === 'cheque' ? 'Cheques' : 'Vales y papeles'));
  readonly anteriores = computed<DocumentoEnCaja[]>(() => this.apartado()?.piezas ?? []);
  readonly salidas = computed(() => SALIDAS_DE[this.tipo()].map((s) => ({ label: SALIDA_TEXTO[s], value: s })));

  constructor() {
    // Otro arqueo (o lo que había, recién leído): se empieza de cero.
    effect(() => {
      this.apartado();
      untracked(() => this.reiniciar());
    });
  }

  texto(d: DocumentoEnCaja): string {
    return textoDocumento(d);
  }

  marca(pieza: string): Marca {
    return this.marcas()[pieza] ?? SIN_MARCA;
  }

  marcar(pieza: string, estado: string): void {
    const e = estado === 'esta' || estado === 'salio' ? estado : '';
    this.marcas.update((m) => ({ ...m, [pieza]: { ...(m[pieza] ?? SIN_MARCA), estado: e, ...(e === 'esta' ? { salida: null, nota: '' } : {}) } }));
    this.contado.set(true);
  }

  ponerSalida(pieza: string, salida: SalidaDocumento | null): void {
    this.marcas.update((m) => ({ ...m, [pieza]: { ...(m[pieza] ?? SIN_MARCA), salida } }));
  }

  ponerNota(pieza: string, nota: string): void {
    this.marcas.update((m) => ({ ...m, [pieza]: { ...(m[pieza] ?? SIN_MARCA), nota: nota ?? '' } }));
  }

  agregar(): void {
    const id = this.siguiente++;
    this.nuevos.update((l) => [...l, { id, clase: null, monto: null, banco: '', numero: '', de_quien: '', concepto: '', fecha: null }]);
    this.contado.set(true);
  }

  poner<K extends keyof DocumentoNuevo>(id: number, campo: K, valor: DocumentoNuevo[K] | string): void {
    this.nuevos.update((l) => l.map((n) => (n.id === id ? { ...n, [campo]: valor } : n)));
  }

  quitar(id: number): void {
    this.nuevos.update((l) => l.filter((n) => n.id !== id));
  }

  reiniciar(): void {
    this.contado.set(false);
    this.marcas.set({});
    this.nuevos.set([]);
  }

  private completo(n: DocumentoNuevo): boolean {
    const largo = (s: string, k: number) => String(s ?? '').trim().length >= k;
    if (!(Number(n.monto) > 0) || !largo(n.de_quien, 3)) return false;
    return this.tipo() === 'cheque'
      ? largo(n.banco, 2) && largo(n.numero, 1)
      : (n.clase === 'vale' || n.clase === 'credito') && largo(n.concepto, 3);
  }

  /** Lo que se manda: `null` = no se contó. */
  readonly valor = computed<DocumentoArqueoInput[] | null>(() => {
    if (!this.contado()) return null;
    const m = this.marcas();
    const ya: DocumentoArqueoInput[] = this.anteriores().map((d) => {
      const x = m[d.pieza];
      return x?.estado === 'salio'
        ? { pieza: d.pieza, estado: 'salio', salida: x.salida, salida_nota: x.nota.trim() || null }
        : { pieza: d.pieza, estado: 'esta' };
    });
    const nuevos: DocumentoArqueoInput[] = this.nuevos().map((n) => ({
      estado: 'esta', monto: n.monto, de_quien: n.de_quien.trim(), fecha: aIso(n.fecha),
      ...(this.tipo() === 'cheque'
        ? { banco: n.banco.trim(), numero: n.numero.trim() }
        : { clase: n.clase, concepto: n.concepto.trim() }),
    }));
    return [...ya, ...nuevos];
  });

  /** Lo que suma lo que está: lo que sigue y lo nuevo. */
  readonly total = computed(() => {
    const m = this.marcas();
    const siguen = this.anteriores().filter((d) => m[d.pieza]?.estado === 'esta').reduce((s, d) => s + d.monto, 0);
    const nuevos = this.nuevos().reduce((s, n) => s + (Number(n.monto) > 0 ? Number(n.monto) : 0), 0);
    return Math.round((siguen + nuevos) * 100) / 100;
  });

  readonly enCaja = computed(() => {
    const m = this.marcas();
    return this.anteriores().filter((d) => m[d.pieza]?.estado === 'esta').length + this.nuevos().length;
  });

  /** Poka-yoke: lo que falta para poder guardar, en palabras. `null` = está bien (o no se contó). */
  readonly falta = computed<string | null>(() => {
    if (!this.contado()) return null;
    const cheque = this.tipo() === 'cheque';
    const m = this.marcas();
    const sinMarca = this.anteriores().filter((d) => !m[d.pieza]?.estado).length;
    if (sinMarca) {
      return `${this.titulo()}: marca ${sinMarca === 1 ? (cheque ? 'el cheque' : 'el papel') : `los ${sinMarca} ${cheque ? 'cheques' : 'papeles'}`} que había: si sigue o si salió.`;
    }
    for (const d of this.anteriores()) {
      const x = m[d.pieza];
      if (x?.estado !== 'salio') continue;
      if (!x.salida) return `Di por qué salió ${this.texto(d)}.`;
      if (x.salida === 'otro' && x.nota.trim().length < 3) return `Escribe qué pasó con ${this.texto(d)}.`;
    }
    if (this.nuevos().some((n) => !this.completo(n))) {
      return cheque
        ? 'Completa el cheque nuevo: banco, número, de quién es e importe.'
        : 'Completa el papel nuevo: si es vale o crédito, quién debe, por qué e importe.';
    }
    if (cheque) {
      const llaves = [...this.anteriores().map((d) => llave(d.banco, d.numero)), ...this.nuevos().map((n) => llave(n.banco, n.numero))];
      if (new Set(llaves).size !== llaves.length) return 'Ese cheque ya está en la lista (mismo banco y número).';
    }
    return null;
  });
}
