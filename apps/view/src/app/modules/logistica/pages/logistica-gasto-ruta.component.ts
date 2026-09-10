import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import {
  GastoRutaService, ExpenseType, RouteExpense, ExpenseList,
  OperationPayload, OperationPeriod, CostSheet,
} from '../gasto-ruta.service';

/**
 * RD.4 + RD.5 — Gasto de flota y operación de la Ruta Directa.
 * Reemplaza las hojas `CONTROL DE GASTOS RD` y `OPERACION DE LAS RUTAS` del workbook.
 *
 * Es la pantalla que faltaba: el dato estaba cargado en prod desde el 2026-09-08 (782 gastos,
 * 187 lecturas de odómetro) y **no había dónde corregirlo**. La decisión de negocio del
 * 2026-09-09 fue *"se corrige desde la UI y se captura manual"* (§9.7 y §9.8 de FASE_RD).
 *
 * Surface Operations: tabla densa sin zebra, hairline 1px sin sombra, cifras en Geist Mono con
 * `tabular-nums`, header sticky. Answer-first (regla §15 de DESIGN.md): arriba va **qué falta**
 * —lo sin clasificar y lo que no se puede medir— y recién abajo el grid crudo.
 *
 * Lo que la pantalla NO hace, a propósito:
 *  · No adivina el tipo de un gasto. Los `SIN CLASIFICAR` se listan y se reclasifican a mano;
 *    cuatro *parecen* gasolina y uno "CAMBIOS DE MUELLES" *parece* reparación, y parecer no basta.
 *  · No corrige el odómetro sola. Las lecturas con dígitos comidos (`205095 → 23174` es `223174`)
 *    se marcan con su `km_status` y se editan una por una; un retroceso exige nota.
 *  · No dibuja $/km donde no hay ficha de costo (rutas 28, 321, 322): sale vacío con su motivo.
 */
@Component({
  selector: 'app-logistica-gasto-ruta',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="gr-page">
      <header class="gr-head">
        <div>
          <h1>Gasto de flota — Ruta Directa</h1>
          <p class="gr-sub">Factura por factura, con litros y $/litro · y el odómetro del que sale el $/km</p>
        </div>
        <label class="gr-year">Año
          <select [ngModel]="anio()" (ngModelChange)="anio.set(+$event); reload()">
            @for (y of anios; track y) { <option [value]="y">{{ y }}</option> }
          </select>
        </label>
      </header>

      <!-- Answer-first: qué falta, antes del grid -->
      @if (pendientes().length) {
        <div class="gr-todo" role="status">
          <i class="pi pi-exclamation-triangle" aria-hidden="true"></i>
          <div>
            <strong>Falta capturar o corregir:</strong>
            @for (p of pendientes(); track p.label) {
              <button type="button" class="gr-todo-link" (click)="p.go()">{{ p.label }}</button>
            }
          </div>
        </div>
      } @else if (!loading()) {
        <p class="gr-ok"><i class="pi pi-check-circle" aria-hidden="true"></i> Nada pendiente de clasificar ni de corregir en {{ anio() }}.</p>
      }

      <nav class="gr-tabs" aria-label="Secciones">
        <button type="button" class="gr-tab" [class.sel]="tab() === 'gasto'" (click)="tab.set('gasto')">
          Gasto <span class="gr-tab-n">{{ gasto()?.total_filas ?? '—' }}</span>
        </button>
        <button type="button" class="gr-tab" [class.sel]="tab() === 'operacion'" (click)="tab.set('operacion')">
          Operación <span class="gr-tab-n">{{ oper()?.total_filas ?? '—' }}</span>
        </button>
        <button type="button" class="gr-tab" [class.sel]="tab() === 'fichas'" (click)="tab.set('fichas')">
          Fichas de costo <span class="gr-tab-n">{{ fichas().length || '—' }}</span>
        </button>
      </nav>

      @if (err()) { <p class="gr-err"><i class="pi pi-times-circle" aria-hidden="true"></i> {{ err() }}</p> }

      <!-- ════════════ GASTO ════════════ -->
      @if (tab() === 'gasto') {
        <div class="gr-filters">
          <label>Ruta
            <select [ngModel]="fRuta()" (ngModelChange)="fRuta.set($event); loadGasto()">
              <option value="">Todas</option>
              @for (r of rutas; track r) { <option [value]="r">{{ r }}</option> }
            </select>
          </label>
          <label>Tipo
            <select [ngModel]="fTipo()" (ngModelChange)="fTipo.set($event); loadGasto()">
              <option value="">Todos</option>
              @for (t of tipos(); track t.code) { <option [value]="t.code">{{ t.code }} · {{ t.nombre }}</option> }
            </select>
          </label>
          <label class="gr-check">
            <input type="checkbox" [ngModel]="soloSin()" (ngModelChange)="soloSin.set($event); loadGasto()" />
            Sólo sin clasificar
          </label>
        </div>

        @if (loading()) {
          @for (i of skeleton; track i) { <div class="gr-skel"></div> }
        } @else if (!gasto()?.rows?.length) {
          <p class="gr-empty">
            Ningún gasto de flota registrado para los filtros de {{ anio() }}.
            @if (fRuta() || fTipo() || soloSin()) {
              <button type="button" class="gr-link" (click)="limpiarFiltros()">Quitar los filtros</button>
            }
          </p>
        } @else {
          <div class="gr-table-wrap">
            <table class="gr-table">
              <thead>
                <tr>
                  <th>Ruta</th><th>Fecha</th><th>Tipo</th><th>Proveedor</th><th>Descripción</th>
                  <th>Folio</th><th class="num">Litros</th><th class="num">Total</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (g of gasto()!.rows; track g.id) {
                  <tr [class.sin]="g.expense_type === 0">
                    <td class="mono">{{ g.route_code }}</td>
                    <td class="mono">{{ g.expense_date }}</td>
                    <td>
                      @if (editId() === g.id) {
                        <select class="gr-inline" [ngModel]="editTipo()" (ngModelChange)="editTipo.set(+$event)"
                                (keydown.escape)="cancelar()" [attr.aria-label]="'Tipo de gasto de ' + g.route_code">
                          @for (t of tipos(); track t.code) { <option [value]="t.code">{{ t.code }} · {{ t.nombre }}</option> }
                        </select>
                      } @else if (g.expense_type === 0) {
                        <span class="gr-chip warn">Sin clasificar</span>
                      } @else {
                        <span class="gr-tipo"><span class="mono">{{ g.expense_type }}</span> {{ g.tipo_nombre }}</span>
                      }
                    </td>
                    <td class="gr-trunc">{{ g.supplier || '—' }}</td>
                    <td class="gr-trunc">{{ g.description || '—' }}</td>
                    <td class="mono">{{ g.folio || '—' }}</td>
                    <td class="num mono" [class.gr-flag]="incoherente(g)">
                      {{ num2(g.liters) }}
                      @if (incoherente(g)) {
                        <i class="pi pi-flag" aria-hidden="true"
                           [title]="'Tipo ' + g.expense_type + ' no debería traer litros'"></i>
                      }
                    </td>
                    <td class="num mono strong">{{ money(g.total) }}</td>
                    <td class="gr-row-actions">
                      @if (canManage()) {
                        @if (editId() === g.id) {
                          <button type="button" class="gr-icon ok" (click)="guardarTipo(g)" [disabled]="busy()" aria-label="Guardar tipo">
                            <i class="pi pi-check" aria-hidden="true"></i>
                          </button>
                          <button type="button" class="gr-icon" (click)="cancelar()" aria-label="Cancelar">
                            <i class="pi pi-times" aria-hidden="true"></i>
                          </button>
                        } @else {
                          <button type="button" class="gr-icon" (click)="editar(g)" [attr.aria-label]="'Cambiar tipo del gasto ' + (g.folio || g.id)">
                            <i class="pi pi-pencil" aria-hidden="true"></i>
                          </button>
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="6">{{ int(gasto()!.total_filas) }} filas</td>
                  <td class="num mono">{{ num2(gasto()!.total_litros) }} lts</td>
                  <td class="num mono">{{ money(gasto()!.total_monto) }}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          @if (gasto()!.sin_clasificar > 0) {
            <p class="gr-note">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              {{ gasto()!.sin_clasificar }} de estas filas no tienen tipo, así que <strong>el resumen por tipo está
              incompleto a propósito</strong>. El tipo no se adivina desde la descripción.
            </p>
          }
        }
      }

      <!-- ════════════ OPERACIÓN ════════════ -->
      @if (tab() === 'operacion') {
        <div class="gr-filters">
          <label class="gr-check">
            <input type="checkbox" [ngModel]="soloProblemas()" (ngModelChange)="soloProblemas.set($event); loadOper()" />
            Sólo lecturas que no se pueden usar
          </label>
          @if (oper(); as o) {
            <span class="gr-cover">
              {{ o.con_km_utilizable }} de {{ o.total_filas }} con km utilizable
              @if (o.sin_ficha_de_costo) { · {{ o.sin_ficha_de_costo }} sin ficha de costo }
            </span>
          }
        </div>

        @if (loading()) {
          @for (i of skeleton; track i) { <div class="gr-skel"></div> }
        } @else if (!oper()?.rows?.length) {
          <p class="gr-empty">Sin lecturas de odómetro ni gasto para {{ anio() }}.</p>
        } @else {
          <div class="gr-table-wrap">
            <table class="gr-table">
              <thead>
                <tr>
                  <th>Ruta</th><th class="num">Q</th>
                  <th class="num">Km inicial</th><th class="num">Km final</th><th class="num">Km</th>
                  <th>Lectura</th><th class="num">Litros</th><th class="num">Km/L</th>
                  <th class="num">$/km fijo</th><th class="num">Gasto</th><th class="num">$/km total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (p of oper()!.rows; track p.route_code + '-' + p.period_no) {
                  <tr [class.sin]="p.km_status !== 'ok'">
                    <td class="mono">{{ p.route_code }}</td>
                    <td class="num mono">{{ p.period_no }}</td>
                    @if (odoKey() === p.route_code + '-' + p.period_no) {
                      <td class="num"><input class="gr-inline num mono" type="number" [ngModel]="odoIni()" (ngModelChange)="odoIni.set($event)" aria-label="Km inicial" /></td>
                      <td class="num"><input class="gr-inline num mono" type="number" [ngModel]="odoFin()" (ngModelChange)="odoFin.set($event)" aria-label="Km final" /></td>
                      <td colspan="8">
                        <input class="gr-inline gr-notes" type="text" [ngModel]="odoNota()" (ngModelChange)="odoNota.set($event)"
                               placeholder="Motivo de la corrección (obligatorio si el final queda menor que el inicial)"
                               aria-label="Motivo de la corrección" />
                      </td>
                      <td class="gr-row-actions">
                        <button type="button" class="gr-icon ok" (click)="guardarOdo(p)" [disabled]="busy()" aria-label="Guardar lectura">
                          <i class="pi pi-check" aria-hidden="true"></i>
                        </button>
                        <button type="button" class="gr-icon" (click)="cancelar()" aria-label="Cancelar">
                          <i class="pi pi-times" aria-hidden="true"></i>
                        </button>
                      </td>
                    } @else {
                      <td class="num mono">{{ p.km_inicial ?? '—' }}</td>
                      <td class="num mono">{{ p.km_final ?? '—' }}</td>
                      <td class="num mono strong">{{ p.km_recorridos ?? '—' }}</td>
                      <td><span class="gr-chip" [class]="chipKm(p.km_status)">{{ etiquetaKm(p.km_status) }}</span></td>
                      <td class="num mono">{{ num2(p.litros) }}</td>
                      <td class="num mono">{{ num2(p.km_por_litro) }}</td>
                      <td class="num mono">{{ num2(p.costo_fijo_por_km) }}</td>
                      <td class="num mono">{{ money0(p.gasto_total) }}</td>
                      <td class="num mono strong">{{ num2(p.costo_por_km) }}</td>
                      <td class="gr-row-actions">
                        @if (canManage()) {
                          <button type="button" class="gr-icon" (click)="editarOdo(p)" [attr.aria-label]="'Corregir odómetro de ruta ' + p.route_code + ' quincena ' + p.period_no">
                            <i class="pi pi-pencil" aria-hidden="true"></i>
                          </button>
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="gr-note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            Las lecturas fuera de banda <strong>no se corrigen solas</strong>: casi todas son un dígito comido
            (<span class="mono">205095 → 23174</span> es <span class="mono">223174</span>) y poner el dígito
            que falta sería inventar la lectura. Donde falta la ficha de costo el <span class="mono">$/km</span>
            sale vacío, no en cero.
          </p>
        }
      }

      <!-- ════════════ FICHAS ════════════ -->
      @if (tab() === 'fichas') {
        @if (!fichas().length) {
          <p class="gr-empty">No hay fichas de costo fijo cargadas.</p>
        } @else {
          <div class="gr-table-wrap gr-narrow">
            <table class="gr-table">
              <thead>
                <tr><th>Ruta</th><th class="num">Gasto anual</th><th class="num">Km base anual</th><th class="num">$/km fijo</th></tr>
              </thead>
              <tbody>
                @for (f of fichas(); track f.route_code) {
                  <tr>
                    <td class="mono">{{ f.route_code }}</td>
                    <td class="num mono">{{ money(f.costo_fijo_anual) }}</td>
                    <td class="num mono">{{ int(f.km_base_anual) }}</td>
                    <td class="num mono strong">{{ num2(f.costo_fijo_por_km) }}</td>
                  </tr>
                }
                @for (r of rutasSinFicha(); track r) {
                  <tr class="sin">
                    <td class="mono">{{ r }}</td>
                    <td colspan="3" class="gr-muted">Sin ficha en el workbook — el $/km de esta ruta sale vacío, no en cero</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="gr-note">
            <i class="pi pi-info-circle" aria-hidden="true"></i>
            El <span class="mono">$/km</span> se deriva de la ficha (<span class="mono">gasto anual ÷ km base</span>).
            En el Excel esta columna da <strong>1</strong> para todas las rutas porque su <span class="mono">SUMIF</span>
            apunta a la columna PERIODO de su propia hoja; acá va el valor real, entre 6.12 y 9.13.
            Las fichas se editan en <span class="mono">/logistica/config</span> (categoría <span class="mono">costo_km</span>).
          </p>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display:block; }
    .gr-page { padding:1rem 1.1rem 2rem; }
    .gr-head { display:flex; align-items:flex-start; gap:1rem; margin-bottom:.9rem; }
    .gr-head h1 { margin:0; font-size:var(--fs-xl,1.25rem); font-weight:var(--fw-bold); color:var(--c-text-1); }
    .gr-sub { margin:.15rem 0 0; font-size:var(--fs-sm); color:var(--c-text-3); }
    .gr-year { margin-left:auto; display:inline-flex; gap:.4rem; align-items:center; font-size:var(--fs-sm); color:var(--c-text-2); }
    .gr-year select, .gr-filters select {
      padding:.3rem .45rem; border:1px solid var(--border-color); border-radius:var(--r-sm,6px);
      background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }

    .gr-todo { display:flex; gap:.5rem; align-items:flex-start; margin-bottom:.9rem; padding:.55rem .7rem;
      border:1px solid color-mix(in srgb, var(--warn-fg) 35%, transparent); border-radius:var(--r-md,8px);
      background:color-mix(in srgb, var(--warn-fg) 8%, transparent); font-size:var(--fs-sm); color:var(--c-text-2); }
    .gr-todo i { color:var(--warn-fg); margin-top:.15rem; }
    .gr-todo-link { margin-left:.4rem; padding:0; border:0; background:none; font:inherit; font-size:var(--fs-sm);
      color:var(--action); text-decoration:underline; cursor:pointer; }
    .gr-ok { display:flex; gap:.4rem; align-items:center; margin:0 0 .9rem; font-size:var(--fs-sm); color:var(--c-text-3); }
    .gr-ok i { color:var(--ok-fg); }

    .gr-tabs { display:flex; gap:.3rem; margin-bottom:.7rem; }
    .gr-tab { display:inline-flex; gap:.35rem; align-items:center; padding:.3rem .7rem; border:1px solid var(--border-color);
      border-radius:99px; background:var(--card-bg); color:var(--c-text-2); font:inherit; font-size:var(--fs-sm); cursor:pointer; }
    .gr-tab.sel { border-color:var(--action); color:var(--action); background:color-mix(in srgb, var(--action) 8%, transparent); }
    .gr-tab-n { font-size:var(--fs-micro); color:var(--c-text-3); font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }

    .gr-filters { display:flex; gap:.8rem; align-items:center; flex-wrap:wrap; margin-bottom:.6rem;
      font-size:var(--fs-sm); color:var(--c-text-2); }
    .gr-filters label { display:inline-flex; gap:.4rem; align-items:center; }
    .gr-check { cursor:pointer; }
    .gr-cover { margin-left:auto; font-size:var(--fs-micro); color:var(--c-text-3);
      font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }

    .gr-table-wrap { overflow-x:auto; border:1px solid var(--border-color); border-radius:var(--r-md,8px); }
    .gr-narrow { max-width:640px; }
    .gr-table { width:100%; border-collapse:collapse; font-size:var(--fs-sm); }
    .gr-table th { position:sticky; top:0; z-index:1; background:var(--card-bg); text-align:left; padding:.4rem .6rem;
      font-size:var(--fs-micro); text-transform:uppercase; letter-spacing:.05em; color:var(--c-text-3);
      font-weight:var(--fw-bold); border-bottom:1px solid var(--c-divider); white-space:nowrap; }
    .gr-table td { padding:.4rem .6rem; border-top:1px solid var(--c-divider); white-space:nowrap; }
    .gr-table th.num, .gr-table td.num { text-align:right; }
    .gr-table tbody tr:hover { background:var(--overlay-hover); }
    .gr-table tbody tr.sin td { color:var(--c-text-2); }
    .gr-table tfoot td { padding:.45rem .6rem; border-top:2px solid var(--c-divider); font-weight:var(--fw-bold);
      background:var(--c-surface-2); white-space:nowrap; }
    .mono { font-family:var(--font-mono,'Geist Mono',monospace); font-variant-numeric:tabular-nums; }
    .mono.strong { font-weight:var(--fw-bold); }
    .gr-trunc { max-width:190px; overflow:hidden; text-overflow:ellipsis; }
    .gr-tipo { display:inline-flex; gap:.35rem; align-items:baseline; }
    .gr-flag { color:var(--warn-fg); }
    .gr-flag i { margin-left:.25rem; font-size:.7rem; }

    .gr-row-actions { text-align:right; }
    .gr-icon { display:inline-flex; align-items:center; justify-content:center; min-width:24px; min-height:24px;
      padding:.15rem .3rem; border:1px solid transparent; border-radius:var(--r-sm,6px);
      background:none; color:var(--c-text-3); cursor:pointer; }
    .gr-icon:hover:not(:disabled) { background:var(--overlay-hover); color:var(--c-text-1); }
    .gr-icon.ok { color:var(--ok-fg); }
    .gr-icon:disabled { opacity:.5; cursor:default; }
    @media (pointer: coarse) { .gr-icon { min-width:44px; min-height:44px; } }

    .gr-inline { padding:.2rem .35rem; border:1px solid var(--action); border-radius:var(--r-sm,6px);
      background:var(--card-bg); color:var(--c-text-1); font:inherit; font-size:var(--fs-sm); }
    .gr-inline.num { text-align:right; width:6.5rem; }
    .gr-notes { width:100%; }

    .gr-chip { font-size:var(--fs-micro); font-weight:var(--fw-bold); padding:.1rem .45rem; border-radius:99px;
      text-transform:uppercase; letter-spacing:.03em; }
    .gr-chip.ok { background:color-mix(in srgb, var(--ok-fg) 15%, transparent); color:var(--ok-fg); }
    .gr-chip.warn { background:color-mix(in srgb, var(--warn-fg) 15%, transparent); color:var(--warn-fg); }
    .gr-chip.bad { background:color-mix(in srgb, var(--bad-fg) 15%, transparent); color:var(--bad-fg); }
    .gr-chip.info { background:var(--c-surface-2); color:var(--c-text-2); }

    .gr-skel { height:36px; margin-bottom:.25rem; border-radius:var(--r-md,8px); background:var(--c-surface-2);
      animation:grPulse 1.2s ease-in-out infinite; }
    @keyframes grPulse { 0%,100% { opacity:.55 } 50% { opacity:1 } }
    @media (prefers-reduced-motion: reduce) { .gr-skel { animation:none } }

    .gr-note { display:flex; gap:.4rem; align-items:flex-start; margin:.7rem 0 0; font-size:var(--fs-sm); color:var(--c-text-3); }
    .gr-note i { margin-top:.15rem; }
    .gr-err { display:flex; gap:.4rem; align-items:center; color:var(--bad-fg); font-size:var(--fs-sm); margin:.4rem 0; }
    .gr-empty { color:var(--c-text-3); font-size:var(--fs-sm); }
    .gr-muted { color:var(--c-text-3); }
    .gr-link { padding:0 0 0 .35rem; border:0; background:none; font:inherit; font-size:var(--fs-sm);
      color:var(--action); text-decoration:underline; cursor:pointer; }
  `],
})
export class LogisticaGastoRutaComponent {
  private readonly api = inject(GastoRutaService);
  private readonly auth = inject(AuthService);

  readonly anios = [2026, 2027];
  readonly rutas = ['21', '22', '23', '26', '27', '28', '321', '322', '501', '502', '503', '504', '505'];
  readonly skeleton = Array.from({ length: 8 }, (_, i) => i);

  readonly anio = signal(new Date().getFullYear());
  readonly tab = signal<'gasto' | 'operacion' | 'fichas'>('gasto');
  readonly tipos = signal<ExpenseType[]>([]);
  readonly gasto = signal<ExpenseList | null>(null);
  readonly oper = signal<OperationPayload | null>(null);
  readonly fichas = signal<CostSheet[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly err = signal<string | null>(null);

  // filtros
  readonly fRuta = signal('');
  readonly fTipo = signal<string>('');
  readonly soloSin = signal(false);
  readonly soloProblemas = signal(false);

  // edición inline
  readonly editId = signal<string | null>(null);
  readonly editTipo = signal<number>(0);
  readonly odoKey = signal<string | null>(null);
  readonly odoIni = signal<number | null>(null);
  readonly odoFin = signal<number | null>(null);
  readonly odoNota = signal('');

  readonly canManage = computed(() =>
    !!this.auth.user()?.permissions?.[Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR]);

  /** Answer-first: lo que hay que ir a arreglar, con su atajo. Vacío = de verdad no hay nada. */
  readonly pendientes = computed(() => {
    const out: { label: string; go: () => void }[] = [];
    const sin = this.gasto()?.sin_clasificar ?? 0;
    if (sin > 0) {
      out.push({
        label: `${sin} gasto${sin === 1 ? '' : 's'} sin tipo`,
        go: () => { this.tab.set('gasto'); this.soloSin.set(true); this.loadGasto(); },
      });
    }
    const malas = this.oper()?.sin_km_utilizable ?? 0;
    if (malas > 0) {
      out.push({
        label: `${malas} lectura${malas === 1 ? '' : 's'} de odómetro sin usar`,
        go: () => { this.tab.set('operacion'); this.soloProblemas.set(true); this.loadOper(); },
      });
    }
    const sf = this.oper()?.sin_ficha_de_costo ?? 0;
    if (sf > 0) out.push({ label: `${sf} periodo${sf === 1 ? '' : 's'} sin ficha de costo`, go: () => this.tab.set('fichas') });
    return out;
  });

  readonly rutasSinFicha = computed(() => {
    const con = new Set(this.fichas().map((f) => f.route_code));
    return this.rutas.filter((r) => !con.has(r));
  });

  constructor() { this.reload(); }

  reload() {
    this.api.types().subscribe({ next: (t) => this.tipos.set(t), error: () => { /* el catálogo no bloquea la tabla */ } });
    this.api.costSheets().subscribe({ next: (f) => this.fichas.set(f), error: () => { /* idem */ } });
    this.loadGasto();
    this.loadOper();
  }

  loadGasto() {
    this.loading.set(true); this.err.set(null);
    this.api.list({
      from: `${this.anio()}-01-01`, to: `${this.anio()}-12-31`,
      route_code: this.fRuta() || undefined,
      expense_type: this.fTipo() === '' ? undefined : Number(this.fTipo()),
      sin_clasificar: this.soloSin() || undefined,
      limit: 500,
    }).subscribe({
      next: (r) => { this.gasto.set(r); this.loading.set(false); },
      error: (e) => { this.err.set(this.msg(e)); this.loading.set(false); },
    });
  }

  loadOper() {
    this.api.periods({ anio: this.anio(), solo_problemas: this.soloProblemas() || undefined }).subscribe({
      next: (r) => this.oper.set(r),
      error: (e) => this.err.set(this.msg(e)),
    });
  }

  limpiarFiltros() {
    this.fRuta.set(''); this.fTipo.set(''); this.soloSin.set(false);
    this.loadGasto();
  }

  // ── edición del tipo de gasto ───────────────────────────────────────────
  editar(g: RouteExpense) { this.editId.set(g.id); this.editTipo.set(g.expense_type); this.err.set(null); }
  cancelar() { this.editId.set(null); this.odoKey.set(null); this.err.set(null); }

  guardarTipo(g: RouteExpense) {
    if (this.busy()) return;
    this.busy.set(true); this.err.set(null);
    const nuevo = this.editTipo();
    this.api.updateExpense(g.id, { expense_type: nuevo }).subscribe({
      next: () => {
        // Optimista: la fila se actualiza en memoria y el contador de pendientes baja con ella.
        const cur = this.gasto();
        if (cur) {
          const t = this.tipos().find((x) => x.code === nuevo);
          const rows = cur.rows.map((r) => r.id === g.id
            ? { ...r, expense_type: nuevo, tipo_nombre: t?.nombre ?? null, lleva_litros: t?.lleva_litros ?? null }
            : r);
          this.gasto.set({ ...cur, rows, sin_clasificar: rows.filter((r) => r.expense_type === 0).length });
        }
        this.editId.set(null); this.busy.set(false);
        this.loadOper(); // el gasto por tipo alimenta el combustible del periodo
      },
      error: (e) => { this.err.set(this.msg(e)); this.busy.set(false); },
    });
  }

  // ── edición del odómetro ────────────────────────────────────────────────
  editarOdo(p: OperationPeriod) {
    this.odoKey.set(`${p.route_code}-${p.period_no}`);
    this.odoIni.set(p.km_inicial); this.odoFin.set(p.km_final); this.odoNota.set('');
    this.err.set(null);
  }

  guardarOdo(p: OperationPeriod) {
    if (this.busy()) return;
    this.busy.set(true); this.err.set(null);
    this.api.saveOdometer({
      route_code: p.route_code, anio: p.anio, period_no: p.period_no,
      km_inicial: this.odoIni(), km_final: this.odoFin(),
      notes: this.odoNota().trim() || null,
    }).subscribe({
      next: () => { this.odoKey.set(null); this.busy.set(false); this.loadOper(); },
      error: (e) => { this.err.set(this.msg(e)); this.busy.set(false); },
    });
  }

  // ── helpers de lectura ──────────────────────────────────────────────────
  /** Un tipo que no lleva litros y trae litros: se marca, no se corrige solo. */
  incoherente(g: RouteExpense): boolean {
    return g.lleva_litros === false && g.liters !== null && Number(g.liters) > 0;
  }

  chipKm(s: string): string {
    if (s === 'ok') return 'ok';
    if (s === 'retroceso' || s === 'salto_implausible') return 'bad';
    if (s === 'sin_lectura' || s === 'incompleto') return 'info';
    return 'warn';
  }

  etiquetaKm(s: string): string {
    switch (s) {
      case 'ok': return 'ok';
      case 'retroceso': return 'retrocede';
      case 'salto_implausible': return 'salto';
      case 'sin_movimiento': return 'sin mover';
      case 'incompleto': return 'incompleta';
      default: return 'sin lectura';
    }
  }

  /** `es-MX` como la pantalla hermana de comisiones; NULL sale como guion, nunca como 0. */
  money(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 }).format(Number(n));
  }

  money0(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n));
  }

  num2(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));
  }

  int(n: number | null | undefined): string {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 }).format(Number(n));
  }

  private msg(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'No se pudo completar la operación.';
  }
}
