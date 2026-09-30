import {
  ChangeDetectionStrategy, Component, OnInit, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { AuthService } from '../../../core/services/auth.service';
import { VerificadorService, type SucursalVerificador } from '../verificador.service';
import {
  RetirosService, MOTIVOS, MOTIVO_LABEL,
  type Retiro, type ResumenSupervisor, type VoidReason,
} from '../retiros.service';

type Pestana = 'registrar' | 'bitacora' | 'supervisores';
type Aviso = { tono: 'ok' | 'warn' | 'bad'; texto: string; detalle?: string } | null;

/**
 * `[BP.7]` RETIROS EN CAJA (`/tienda/retiros`) — donde se registra el renglón que se quitó del
 * ticket, con el supervisor que lo autorizó.
 *
 * ── Por qué existe esta pantalla ─────────────────────────────────────────────────────────────
 * Medido el 2026-09-28 contra las 9 ramas y en vivo en una caja: **Kepler exige contraseña de
 * supervisor para quitar un renglón y después no guarda el hecho en ningún lado.** La marca
 * "ELIMINADO" vive en la memoria de la caja y el guardado rechaza el renglón en cantidad 0, así
 * que nunca toca la base — cero coincidencias en las 46 columnas de texto de `kdm2`. Tampoco hay
 * parámetro que prender, y parchear el programa no sirve porque el cliente re-descarga las
 * páginas del servidor al abrir. El único instrumento que queda es la persona que autorizó.
 *
 * ── Quién la usa, y por qué NO es la cajera ──────────────────────────────────────────────────
 * Lo que se registra es una AUTORIZACIÓN, y la firma es de quien la dio. Un cajero registrando
 * sus propios retiros sin el autorizante sería un log que no prueba nada. Por eso el permiso de
 * captura deriva de supervisión de tienda, al revés que en la Lista de faltantes.
 *
 * ── Lo que la pantalla NO hace ───────────────────────────────────────────────────────────────
 * No dibuja $0 cuando no puede valorar. Si la cantidad viene en cajas o el producto no resuelve,
 * muestra **por qué** no hay monto (`est_motivo`). Y en el resumen por supervisor, el total
 * valorado viaja SIEMPRE con cuántos eventos quedaron fuera: leer "$1,200 retirados" donde en
 * realidad hay $1,200 más N de monto desconocido afirma algo distinto.
 */
@Component({
  selector: 'app-tienda-retiros',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TagModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  <div class="pg">
    <header class="hd">
      <div>
        <h1>Retiros en caja</h1>
        <p class="sub">Lo que se quitó del ticket y quién lo autorizó. Kepler pide la contraseña pero no guarda el hecho.</p>
      </div>
      <p-select [options]="sucursales()" optionLabel="nombre" optionValue="codigo"
                [ngModel]="sucursal()" (ngModelChange)="cambiarSucursal($event)"
                placeholder="Elegí la sucursal" styleClass="sel" [filter]="true" filterBy="nombre,codigo">
      </p-select>
    </header>

    <nav class="tabs">
      <button type="button" [class.on]="tab()==='registrar'" (click)="tab.set('registrar')">Registrar</button>
      <button type="button" [class.on]="tab()==='bitacora'" (click)="irA('bitacora')">Bitácora</button>
      <button type="button" [class.on]="tab()==='supervisores'" (click)="irA('supervisores')">Por supervisor</button>
    </nav>

    @if (!sucursal()) {
      <p class="vacio"><i class="pi pi-arrow-up"></i> Elegí una sucursal para empezar.</p>
    } @else if (tab() === 'registrar') {
      <section class="form">
        <div class="fila">
          <label>Clave del supervisor que autorizó <span class="req">*</span>
            <input [(ngModel)]="supervisorCode" name="sup" placeholder="la misma que teclea en Kepler" />
          </label>
          <label>Caja
            <input [(ngModel)]="caja" name="caja" placeholder="1, 2, 3…" />
          </label>
          <label>Clave del cajero
            <input [(ngModel)]="cashierCode" name="caj" placeholder="opcional" />
          </label>
        </div>

        <div class="fila">
          <label class="ancho">Producto — clave o código de barras
            <input [(ngModel)]="sku" name="sku" placeholder="ej. 70001" />
          </label>
          <label class="ancho">…o el nombre, si no resuelve
            <input [(ngModel)]="productName" name="pn" placeholder="ej. LA ROSA MAZAPAN /30" />
          </label>
        </div>

        <div class="fila">
          <label>Cantidad original <span class="req">*</span>
            <input type="number" min="0" step="0.001" [(ngModel)]="qtyOriginal" name="qo" />
          </label>
          <label>Quedó en
            <input type="number" min="0" step="0.001" [(ngModel)]="qtyFinal" name="qf" />
          </label>
          <label>Unidad
            <input [(ngModel)]="unidad" name="u" placeholder="PZA / PAQ / CJA" />
          </label>
        </div>

        <div class="fila">
          <label class="ancho">Motivo <span class="req">*</span>
            <p-select [options]="motivos" optionLabel="label" optionValue="value"
                      [(ngModel)]="motivo" name="m" styleClass="sel"></p-select>
          </label>
          <label class="ancho">
            Detalle @if (motivo === 'otro') { <span class="req">* obligatorio con "Otro"</span> }
            <input [(ngModel)]="nota" name="n" placeholder="qué pasó" />
          </label>
        </div>

        <div class="acciones">
          <p-button label="Registrar retiro" icon="pi pi-check" [loading]="guardando()"
                    [disabled]="!puedeGuardar()" (onClick)="registrar()"></p-button>
          @if (!puedeGuardar() && !guardando()) {
            <span class="pista">{{ queFalta() }}</span>
          }
        </div>

        @if (aviso(); as a) {
          <div class="aviso" [class]="a.tono">
            <strong>{{ a.texto }}</strong>
            @if (a.detalle) { <span>{{ a.detalle }}</span> }
          </div>
        }
      </section>
    } @else if (tab() === 'bitacora') {
      @if (cargando()) { <p class="vacio">Cargando…</p> }
      @else if (!retiros().length) { <p class="vacio">Sin retiros registrados en los últimos 30 días.</p> }
      @else {
        <table class="tb">
          <thead><tr>
            <th>Cuándo</th><th>Caja</th><th>Supervisor</th><th>Producto</th>
            <th class="n">Retirado</th><th class="n">Monto</th><th>Motivo</th>
          </tr></thead>
          <tbody>
            @for (r of retiros(); track r.id) {
              <tr>
                <td class="mono">{{ r.occurred_at | date:'dd/MM HH:mm' }}</td>
                <td>{{ r.caja || '—' }}</td>
                <td>{{ r.supervisor_name || r.supervisor_code }}</td>
                <td>
                  <span class="prod">{{ r.product_name || '(sin nombre)' }}</span>
                  @if (r.sku) { <span class="mono sku">{{ r.sku }}</span> }
                </td>
                <td class="n mono">{{ r.qty_retirada }} {{ r.unidad || '' }}</td>
                <td class="n mono">
                  @if (r.est_value !== null) { {{ r.est_value | currency:'MXN':'symbol-narrow' }} }
                  @else { <span class="sindato" title="No se pudo valorar. Un cero sería mentira.">sin dato</span> }
                </td>
                <td>
                  <p-tag [value]="etiqueta(r.reason)" severity="warn"></p-tag>
                  @if (r.reason_note) { <span class="nota">{{ r.reason_note }}</span> }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    } @else {
      @if (cargando()) { <p class="vacio">Cargando…</p> }
      @else if (!resumen().length) { <p class="vacio">Sin datos en los últimos 30 días.</p> }
      @else {
        <table class="tb">
          <thead><tr>
            <th>Supervisor</th><th class="n">Autorizaciones</th>
            <th class="n">Monto valorado</th><th class="n">Sin valorar</th>
          </tr></thead>
          <tbody>
            @for (s of resumen(); track s.supervisor_code) {
              <tr>
                <td>{{ s.supervisor_name || s.supervisor_code }}</td>
                <td class="n mono">{{ s.eventos }}</td>
                <td class="n mono">
                  @if (s.valor_total !== null) { {{ s.valor_total | currency:'MXN':'symbol-narrow' }} }
                  @else { <span class="sindato">sin dato</span> }
                </td>
                <td class="n mono" [class.ojo]="s.eventos_sin_valorar > 0">{{ s.eventos_sin_valorar }}</td>
              </tr>
            }
          </tbody>
        </table>
        <p class="pie">
          <i class="pi pi-info-circle"></i>
          El monto suma <strong>sólo lo que se pudo valorar</strong>. La última columna dice cuántos
          eventos quedaron fuera — leer el total sin ella afirma algo que el dato no sostiene.
        </p>
      }
    }
  </div>
  `,
  styles: [`
    .pg { padding: 1rem 1.25rem; max-width: 1200px; }
    .hd { display: flex; gap: 1rem; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; margin-bottom: .75rem; }
    h1 { font-size: 1.15rem; font-weight: 700; margin: 0; color: var(--text-1, #1c1917); }
    .sub { margin: .2rem 0 0; font-size: .8rem; color: var(--text-3, #78716c); max-width: 62ch; }
    .tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--border-1, #e7e5e4); margin-bottom: 1rem; }
    .tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: .5rem .8rem;
      font: inherit; font-size: .84rem; color: var(--text-3, #78716c); cursor: pointer; }
    .tabs button.on { color: var(--action, #c2410c); border-bottom-color: var(--action, #c2410c); font-weight: 600; }
    .form { display: flex; flex-direction: column; gap: .75rem; }
    .fila { display: flex; gap: .75rem; flex-wrap: wrap; }
    label { display: flex; flex-direction: column; gap: .25rem; font-size: .76rem;
      color: var(--text-3, #78716c); flex: 1 1 180px; }
    label.ancho { flex: 1 1 300px; }
    input { padding: .45rem .6rem; border: 1px solid var(--border-1, #d6d3d1); border-radius: 6px;
      font: inherit; font-size: .86rem; color: var(--text-1, #1c1917); background: var(--surface-0, #fff); }
    input:focus-visible { outline: 2px solid var(--action, #c2410c); outline-offset: 1px; }
    .req { color: var(--action, #c2410c); font-weight: 600; }
    .acciones { display: flex; align-items: center; gap: .75rem; margin-top: .25rem; }
    .pista { font-size: .78rem; color: var(--text-3, #78716c); }
    .aviso { padding: .6rem .8rem; border-radius: 6px; font-size: .84rem; display: flex; flex-direction: column; gap: .15rem; }
    .aviso.ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
    .aviso.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
    .aviso.bad { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .tb { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .tb th { text-align: left; font-weight: 600; font-size: .72rem; text-transform: uppercase;
      letter-spacing: .03em; color: var(--text-3, #78716c); padding: .4rem .5rem;
      border-bottom: 1px solid var(--border-1, #e7e5e4); }
    .tb td { padding: .4rem .5rem; border-bottom: 1px solid var(--border-2, #f5f5f4); vertical-align: top; }
    .tb .n { text-align: right; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: .78rem; }
    .prod { display: block; }
    .sku { color: var(--text-3, #78716c); }
    .nota { display: block; font-size: .74rem; color: var(--text-3, #78716c); margin-top: .15rem; }
    .sindato { color: var(--text-3, #a8a29e); font-style: italic; }
    .ojo { color: var(--action, #c2410c); font-weight: 600; }
    .vacio { color: var(--text-3, #78716c); font-size: .86rem; padding: 1.5rem 0; }
    .pie { font-size: .76rem; color: var(--text-3, #78716c); margin-top: .6rem; max-width: 72ch; }
    @media (max-width: 640px) { .pg { padding: .75rem; } .fila { flex-direction: column; } }
  `],
})
export class TiendaRetirosComponent implements OnInit {
  private readonly svc = inject(RetirosService);
  private readonly verificador = inject(VerificadorService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  readonly sucursales = signal<SucursalVerificador[]>([]);
  readonly sucursal = signal<string | null>(null);
  readonly tab = signal<Pestana>('registrar');
  readonly cargando = signal(false);
  readonly guardando = signal(false);
  readonly aviso = signal<Aviso>(null);
  readonly retiros = signal<Retiro[]>([]);
  readonly resumen = signal<ResumenSupervisor[]>([]);

  readonly motivos = MOTIVOS.map((v) => ({ value: v, label: MOTIVO_LABEL[v] }));

  supervisorCode = '';
  caja = '';
  cashierCode = '';
  sku = '';
  productName = '';
  qtyOriginal: number | null = null;
  qtyFinal = 0;
  unidad = '';
  motivo: VoidReason = 'error_captura';
  nota = '';

  readonly puedeGuardar = computed(() => !!this.sucursal() && !this.guardando());

  etiqueta(r: VoidReason): string { return MOTIVO_LABEL[r] ?? r; }

  /** Lo que falta se DICE, en vez de dejar el botón apagado sin explicación. */
  queFalta(): string {
    if (!this.sucursal()) return 'Falta elegir la sucursal.';
    return '';
  }

  ngOnInit(): void {
    this.verificador.sucursales().subscribe({
      next: (s) => {
        this.sucursales.set(s ?? []);
        // Precedencia: `?sucursal=NN` (la máquina del mostrador sin cuenta de esa tienda) →
        // la sucursal de la ficha → nada, y entonces se pide. Nunca se adivina.
        const q = this.route.snapshot.queryParamMap.get('sucursal');
        const propia = this.auth.user()?.warehouse_code ?? null;
        const elegida = [q, propia].find((c) => c && (s ?? []).some((x) => x.codigo === c)) ?? null;
        if (elegida) this.cambiarSucursal(elegida);
      },
      error: () => this.sucursales.set([]),
    });
  }

  cambiarSucursal(code: string | null): void {
    this.sucursal.set(code);
    this.retiros.set([]);
    this.resumen.set([]);
    if (code && this.tab() !== 'registrar') this.irA(this.tab());
  }

  irA(t: Pestana): void {
    this.tab.set(t);
    const suc = this.sucursal();
    if (!suc || t === 'registrar') return;
    this.cargando.set(true);
    // Dos ramas separadas y no un Observable de tipo unión: TypeScript no puede resolver la
    // sobrecarga de `subscribe` sobre una unión de observables con cargas distintas.
    if (t === 'bitacora') {
      this.svc.porSucursal(suc, 30).subscribe({
        next: (r) => { this.retiros.set(r ?? []); this.cargando.set(false); },
        error: () => this.falloLectura(),
      });
    } else {
      this.svc.porSupervisor(suc, 30).subscribe({
        next: (r) => { this.resumen.set(r ?? []); this.cargando.set(false); },
        error: () => this.falloLectura(),
      });
    }
  }

  /** Falla de red: se DICE. Una tabla vacía en silencio se lee como "no hubo retiros". */
  private falloLectura(): void {
    this.cargando.set(false);
    this.aviso.set({
      tono: 'bad',
      texto: 'No se pudo leer la bitácora.',
      detalle: 'Revisá la conexión y volvé a entrar a la pestaña.',
    });
  }

  registrar(): void {
    const suc = this.sucursal();
    if (!suc) return;
    const qo = Number(this.qtyOriginal);
    const qf = Number(this.qtyFinal ?? 0);

    // Se valida acá para no hacer viajar un error obvio — pero el motor tiene los mismos CHECK,
    // así que un cliente equivocado o saltado no puede meter una fila incoherente.
    if (!this.supervisorCode.trim()) {
      this.aviso.set({ tono: 'warn', texto: 'Falta la clave del supervisor.', detalle: 'Es la firma del registro: sin ella el log no prueba nada.' });
      return;
    }
    if (!Number.isFinite(qo) || qo <= 0) {
      this.aviso.set({ tono: 'warn', texto: 'La cantidad original tiene que ser mayor a cero.' });
      return;
    }
    if (!Number.isFinite(qf) || qf < 0 || qf >= qo) {
      this.aviso.set({ tono: 'warn', texto: 'La cantidad que quedó tiene que ser menor a la original.', detalle: 'Si no bajó, no hubo retiro que registrar.' });
      return;
    }
    if (this.motivo === 'otro' && !this.nota.trim()) {
      this.aviso.set({ tono: 'warn', texto: 'Con motivo "Otro" hay que escribir cuál.', detalle: 'Un "otro" sin explicación deja la fila muda.' });
      return;
    }

    this.guardando.set(true);
    this.aviso.set(null);
    this.svc.registrar({
      warehouse_code: suc,
      caja: this.caja.trim() || null,
      supervisor_code: this.supervisorCode.trim(),
      cashier_code: this.cashierCode.trim() || null,
      sku: this.sku.trim() || null,
      scanned_code: this.sku.trim() || null,
      product_name: this.productName.trim() || null,
      qty_original: qo,
      qty_final: qf,
      unidad: this.unidad.trim() || null,
      reason: this.motivo,
      reason_note: this.nota.trim() || null,
    }).subscribe({
      next: (r) => {
        this.guardando.set(false);
        const monto = r.est_value !== null
          ? `Valorado en $${r.est_value.toFixed(2)}.`
          : `Sin monto: ${r.est_motivo ?? 'no se pudo valorar'}.`;
        this.aviso.set({
          tono: r.est_value !== null ? 'ok' : 'warn',
          texto: `Registrado: ${r.qty_retirada} de ${r.product_name ?? r.sku ?? 'producto sin resolver'}.`,
          detalle: monto,
        });
        // Se limpia lo del producto, NO la identidad: el mismo supervisor suele registrar varios
        // seguidos y re-teclear su clave en cada uno es lo que hace que se deje de usar.
        this.sku = ''; this.productName = ''; this.qtyOriginal = null; this.qtyFinal = 0;
        this.unidad = ''; this.nota = ''; this.motivo = 'error_captura';
      },
      error: (e: { error?: { message?: string } }) => {
        this.guardando.set(false);
        this.aviso.set({
          tono: 'bad',
          texto: 'No se guardó.',
          detalle: e?.error?.message ?? 'Revisá la conexión y volvé a intentar. Nada se perdió: el formulario sigue como estaba.',
        });
      },
    });
  }
}
