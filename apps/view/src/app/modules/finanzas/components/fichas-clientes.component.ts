import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { from, of } from 'rxjs';
import { catchError, concatMap, map, toArray } from 'rxjs/operators';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FichasClientesService, FichaClienteBandeja, CobroCandidato, BandejaFichas } from '../deposito-cliente.service';

/**
 * `[CC.20]` **La bandeja de Cobranza: las fichas de depósito que subieron los clientes desde su enlace.**
 *
 * Cuestionario de diseño (skill `diseno` §0b):
 *  1. **Qué ve primero:** las que esperan revisión, la más vieja arriba (es la que lleva más tiempo sin respuesta), con
 *     lo que DECLARÓ el cliente junto a lo que LEYÓ la Suite en la foto y si cuadran.
 *  2. **Qué no ve:** el detalle del OCR crudo ni la cartera del cliente (está a un clic, en Cartera).
 *  3. **Accesibilidad:** dos acciones por ficha — «Ligar al cobro» (abre los cobros de Kepler que pueden ser, los del
 *     cliente primero) y «Rechazar» (con un motivo que el cliente va a leer). La foto abre en otra pestaña.
 *  4. **Ligado a:** el cobro de Kepler (folio) al ligar, y la ficha del cliente en Cartera y en su enlace (estado).
 *  5. **¿Le toca?** Sí: es el trabajo de Cobranza; la Suite no registra cobros en Kepler, sólo los liga.
 *
 * `[CC.21]` **La columna «Banco»: ¿la ficha entró al banco?** (Edgar: «validar ese monto que haya entrado a movimientos
 * de bancos»). Se cruza la ficha con el estado de cuenta y con el cobro que la conciliación ya le ligó a ese abono:
 *  1. **Qué ve primero:** arriba, cuántas ya entraron y Kepler ya las aplicó a ESE cliente (un botón las liga todas), y
 *     cuántas entraron sin cobro en Kepler (el dinero que nadie ha aplicado). En la fila, el veredicto en una palabra y
 *     el abono (banco, cuenta, día, monto).
 *  2. **Qué no ve:** el estado de cuenta completo ni la conciliación (están en Bancos).
 *  3. **Accesibilidad:** la acción que corresponde al veredicto va en la fila («Ligar a 0001234», «Marcar el abono como
 *     suyo»); el veredicto lleva palabra además del color.
 *  4. **Ligado a:** el abono del banco y el cobro de Kepler (folio) que la conciliación le ligó.
 *  5. **¿Le toca?** Sí: es la evidencia con la que Cobranza decide. ⚠️ El estado de cuenta se sube a mano cada 1 a 5
 *     días (medido): «no aparece» sólo se dice si ya está cargado después del depósito; si no, se dice hasta cuándo.
 */
@Component({
  selector: 'app-fichas-clientes',
  standalone: true,
  imports: [FormsModule, SegmentedComponent, LoadStateComponent, SucursalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fc-bar">
      <app-segmented [options]="opciones()" [value]="estado()" (valueChange)="cambiar($event)" ariaLabel="Estado de las fichas" />
      <span class="fc-hint">Llegan por el enlace personal de cada cliente (WhatsApp y el QR del estado de cuenta).</span>
    </div>
    <app-load-state [loading]="cargando() && !datos()" [error]="datos() ? null : error()" [isEmpty]="!!datos() && !datos()!.fichas.length"
                    [skeletonRows]="6" emptyIcon="pi-inbox" [emptyTitle]="vacioTitulo()" emptyHint="Cuando un cliente suba su ficha desde su enlace, aparece aquí."
                    (retry)="cargar()">
      @if (datos(); as d) {
        @if (error()) { <p class="fc-err" role="alert">{{ error() }}</p> }
        @if (estado() === 'recibido' && d.fichas.length) {
          <div class="fc-resumen">
            @if (d.banco_medido === false) {
              <span class="fc-muted">No se pudo revisar el banco ahora: las fichas se ven sin ese cruce.</span>
            } @else {
              <span>
                <b>{{ resumen().aplicadas.length }}</b> ya entraron al banco y Kepler las aplicó a ese cliente
                · <b>{{ resumen().sinAplicar }}</b> entraron sin cobro en Kepler
                · <b>{{ resumen().noAparecen }}</b> no aparecen en el banco
                @if (resumen().sinCargar) { · <b>{{ resumen().sinCargar }}</b> esperan el siguiente estado de cuenta }
              </span>
              @if (resumen().aplicadas.length) {
                <button type="button" class="fc-btn fc-btn-main" [disabled]="!!trabajando()" (click)="ligarConfirmadas()">
                  Ligar las {{ resumen().aplicadas.length }} que el banco confirma
                </button>
              }
            }
          </div>
        }
        <table class="surf-table surf-table--plain fc-tabla">
          <thead>
            <tr>
              <th scope="col">Cliente</th>
              <th scope="col" class="comm-num">Declaró</th>
              <th scope="col">La foto dice</th>
              @if (estado() === 'recibido') { <th scope="col">Banco</th> }
              <th scope="col">Enviada</th>
              <th scope="col"><span class="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            @for (f of d.fichas; track f.id) {
              <tr>
                <td>
                  <b>{{ f.cliente_nombre || f.cliente_code }}</b>
                  <span class="fc-muted">{{ f.cliente_code }} · {{ f.cuenta_sucursal | sucursal }}</span>
                  @if (f.nota) { <span class="fc-nota">«{{ f.nota }}»</span> }
                </td>
                <td class="comm-num"><b>{{ money(f.monto) }}</b><span class="fc-muted">{{ f.fecha || '—' }}</span></td>
                <td>
                  @if (f.ocr_monto != null) {
                    <span>{{ money(f.ocr_monto) }} · {{ f.ocr_fecha || '—' }}</span>
                    @if (f.monto_match === true) { <span class="fc-ok">Cuadra</span> }
                    @else if (f.monto_match === false) { <span class="fc-bad">No cuadra con lo declarado</span> }
                    <span class="fc-muted">{{ f.ocr_banco || '' }}{{ f.ocr_referencia ? ' · ref ' + f.ocr_referencia : '' }}</span>
                  } @else {
                    <span class="fc-muted">No se pudo leer: revísala en la foto</span>
                  }
                  @for (a of f.files; track a.url; let i = $index) {
                    <a [href]="a.url" target="_blank" rel="noopener" class="fc-link">Ver {{ a.kind === 'pdf' ? 'PDF' : 'foto' }}{{ f.files.length > 1 ? ' ' + (i + 1) : '' }}</a>
                  }
                </td>
                @if (estado() === 'recibido') {
                  <td class="fc-banco">
                    @if (f.banco; as b) {
                      @switch (b.estado) {
                        @case ('aplicado') {
                          <span class="fc-ok">Entró al banco</span>
                          <span class="fc-muted">Kepler la aplicó a este cliente: cobro {{ b.cobro?.folio }} · {{ b.cobro?.sucursal | sucursal }}</span>
                        }
                        @case ('sin_aplicar') {
                          <span class="fc-warn">Entró al banco, sin cobro en Kepler</span>
                          <!-- [CC.22] Decía sólo «ya está marcado» y nada más: quien lo presiona puede creer que
                               terminó, y el cobro NO se escribe desde aquí. Hasta que alguien lo capture en Kepler,
                               el cliente sigue debiendo en el sistema lo que ya pagó y su factura no recibe
                               complemento de pago (el de un cobro de noviembre vence el 5 de diciembre). -->
                          @if (b.abonos[0]?.declarado === f.cliente_code) {
                            <span class="fc-muted">Marcado como de este cliente.</span>
                            <span class="fc-warn">Falta capturar el cobro en Kepler: hasta entonces sigue debiendo esto en el sistema y su factura no recibe complemento de pago.</span>
                          }
                        }
                        @case ('de_otro_cliente') {
                          <span class="fc-bad">El abono es de otro cliente</span>
                          <span class="fc-muted">Kepler lo aplicó a {{ b.abonos[0]?.cobros?.[0]?.cliente_nombre || b.abonos[0]?.cobros?.[0]?.cliente_code }}</span>
                        }
                        @case ('varios') { <span class="fc-neutro">{{ b.abonos.length }} abonos de ese monto</span> }
                        @case ('no_aparece') {
                          <span class="fc-bad">No aparece en el banco</span>
                          <span class="fc-muted">El estado de cuenta ya llega al {{ b.cargado_hasta }}</span>
                        }
                        @case ('banco_sin_cargar') {
                          <span class="fc-neutro">Aún no se puede revisar</span>
                          <span class="fc-muted">El estado de cuenta llega hasta el {{ b.cargado_hasta || '—' }}</span>
                        }
                        @default { <span class="fc-muted">Sin monto o fecha para buscar</span> }
                      }
                      @for (a of b.abonos.slice(0, 3); track a.id) {
                        <span class="fc-muted">{{ a.banco }} {{ a.cuenta }} · {{ a.fecha }} · {{ money(a.monto) }}</span>
                      }
                      @if (b.disputado_con) { <span class="fc-bad">Otra ficha apunta al mismo abono</span> }
                    } @else {
                      <span class="fc-muted">No se pudo revisar</span>
                    }
                  </td>
                }
                <td><span class="fc-muted">{{ cuando(f.enviado) }}</span></td>
                <td class="fc-acc">
                  @switch (f.status) {
                    @case ('validado') { <span class="fc-ok">Ligada al cobro {{ f.folio }}</span> }
                    @case ('rechazado') { <span class="fc-bad" [title]="f.motivo_rechazo || ''">Rechazada</span> }
                    @default {
                      @if (f.banco?.estado === 'aplicado' && f.banco?.cobro && !f.banco?.disputado_con) {
                        <button type="button" class="fc-btn fc-btn-main" [disabled]="trabajando() === f.id" (click)="ligarAlCobroDelBanco(f)">Ligar a {{ f.banco?.cobro?.folio }}</button>
                      }
                      @if (f.banco?.estado === 'sin_aplicar' && !f.banco?.disputado_con && f.banco?.abonos?.[0]?.declarado !== f.cliente_code) {
                        <button type="button" class="fc-btn fc-btn-main" [disabled]="trabajando() === f.id" (click)="declararAbono(f)">Marcar el abono como suyo</button>
                      }
                      <button type="button" class="fc-btn" [class.fc-btn-main]="!botonDelBanco(f)" [disabled]="trabajando() === f.id" (click)="abrirLigar(f)">{{ botonDelBanco(f) ? 'Otro cobro' : 'Ligar al cobro' }}</button>
                      <button type="button" class="fc-btn" [disabled]="trabajando() === f.id" (click)="abrirRechazo(f)">Rechazar</button>
                    }
                  }
                </td>
              </tr>
              @if (abierta() === f.id && modo() === 'ligar') {
                <tr class="fc-panel"><td [attr.colspan]="estado() === 'recibido' ? 6 : 5">
                  @if (candidatos(); as cs) {
                    @if (cs.length) {
                      <p class="fc-muted">Cobros de Kepler por el mismo monto (±$1) cerca de la fecha. Los del cliente van primero.</p>
                      <ul class="fc-cands">
                        @for (c of cs; track c.sucursal + c.folio) {
                          <li>
                            <span><b>{{ c.folio }}</b> · {{ c.sucursal | sucursal }} · {{ c.cobro_date || '—' }} · {{ money(c.monto) }}</span>
                            <span class="fc-muted">{{ c.cliente_nombre || c.cliente_code }}{{ c.del_cliente ? '' : ' (otro cliente)' }}{{ c.deposits ? ' · ya tiene ficha' : '' }}</span>
                            <button type="button" class="fc-btn fc-btn-main" [disabled]="trabajando() === f.id" (click)="ligar(f, c)">Ligar</button>
                          </li>
                        }
                      </ul>
                    } @else {
                      <p class="fc-muted">Todavía no hay un cobro en Kepler por ese monto. Regístralo en Kepler y vuelve a abrir esta ficha.</p>
                    }
                  } @else { <p class="fc-muted">Buscando cobros…</p> }
                  <button type="button" class="fc-btn" (click)="cerrar()">Cerrar</button>
                </td></tr>
              }
              @if (abierta() === f.id && modo() === 'rechazar') {
                <tr class="fc-panel"><td [attr.colspan]="estado() === 'recibido' ? 6 : 5">
                  <label class="fc-campo"><span>¿Por qué? El cliente lo va a leer en su enlace.</span>
                    <input type="text" [(ngModel)]="motivo" maxlength="200" placeholder="Por ejemplo: la foto no se lee, súbela otra vez" aria-label="Motivo del rechazo" />
                  </label>
                  <button type="button" class="fc-btn fc-btn-bad" [disabled]="motivo.trim().length < 3 || trabajando() === f.id" (click)="rechazar(f)">Rechazar ficha</button>
                  <button type="button" class="fc-btn" (click)="cerrar()">Cancelar</button>
                </td></tr>
              }
            }
          </tbody>
        </table>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; }
    .fc-bar { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; margin-bottom: var(--sp-3); }
    .fc-hint, .fc-muted { color: var(--text-muted); font-size: var(--fs-sm); }
    .fc-muted { display: block; }
    .fc-nota { display: block; font-size: var(--fs-sm); font-style: italic; }
    .fc-tabla td { vertical-align: top; }
    .fc-ok { display: inline-block; color: var(--ok-soft-fg); background: var(--ok-soft-bg); border-radius: var(--r-pill, 999px); padding: 0 8px; font-size: var(--fs-xs); font-weight: 600; margin-left: 4px; }
    .fc-bad { display: inline-block; color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-radius: var(--r-pill, 999px); padding: 0 8px; font-size: var(--fs-xs); font-weight: 600; margin-left: 4px; }
    .fc-warn { display: inline-block; color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-radius: var(--r-pill, 999px); padding: 0 8px; font-size: var(--fs-xs); font-weight: 600; }
    .fc-neutro { display: inline-block; color: var(--text-main); background: var(--surface-2); border-radius: var(--r-pill, 999px); padding: 0 8px; font-size: var(--fs-xs); font-weight: 600; }
    .fc-banco .fc-ok, .fc-banco .fc-bad { margin-left: 0; }
    .fc-resumen { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; justify-content: space-between; margin-bottom: var(--sp-3); font-size: var(--fs-sm); }
    .fc-resumen .fc-btn { margin-left: 0; }
    .fc-link { display: inline-block; margin-right: var(--sp-2); color: var(--action); font-size: var(--fs-sm); }
    .fc-acc { white-space: nowrap; text-align: right; }
    .fc-btn { min-height: 32px; padding: 0 var(--sp-3); border-radius: var(--r-md, 8px); border: 1px solid var(--border-color); background: transparent; color: var(--text-main); font: inherit; font-size: var(--fs-sm); cursor: pointer; margin-left: var(--sp-2); }
    .fc-btn:focus-visible, .fc-campo input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .fc-btn-main { background: var(--action); color: var(--action-ink); border-color: var(--action); }
    .fc-btn-bad { color: var(--bad-fg); border-color: var(--bad-border); }
    .fc-btn[disabled] { opacity: .55; cursor: default; }
    .fc-panel td { background: var(--surface-2); }
    .fc-cands { list-style: none; margin: var(--sp-2) 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
    .fc-cands li { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .fc-campo { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--text-muted); margin-bottom: var(--sp-2); }
    .fc-campo input { min-height: 36px; padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-md, 8px); background: var(--surface-card); color: var(--text-main); }
    .fc-err { color: var(--bad-soft-fg); background: var(--bad-soft-bg); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md, 8px); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `],
})
export class FichasClientesComponent {
  private readonly svc = inject(FichasClientesService);
  private readonly destroyRef = inject(DestroyRef);

  readonly estado = signal('recibido');
  readonly datos = signal<BandejaFichas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly abierta = signal<string | null>(null);
  readonly modo = signal<'ligar' | 'rechazar' | null>(null);
  readonly candidatos = signal<CobroCandidato[] | null>(null);
  readonly trabajando = signal<string | null>(null);
  motivo = '';

  readonly opciones = signal([
    { label: 'Por revisar', value: 'recibido' }, { label: 'Ligadas', value: 'validado' }, { label: 'Rechazadas', value: 'rechazado' },
  ]);
  readonly vacioTitulo = (): string => ({ recibido: 'No hay fichas por revisar', validado: 'Todavía no hay fichas ligadas', rechazado: 'No hay fichas rechazadas' } as Record<string, string>)[this.estado()] || 'Sin fichas';

  /** `[CC.21]` Lo que dice el banco de las fichas por revisar, para el renglón de arriba. */
  readonly resumen = computed(() => {
    const fs = (this.datos()?.fichas || []).filter((f) => f.status === 'recibido');
    const cuenta = (e: string): number => fs.filter((f) => f.banco?.estado === e).length;
    return {
      aplicadas: fs.filter((f) => f.banco?.estado === 'aplicado' && !!f.banco.cobro && !f.banco.disputado_con),
      sinAplicar: cuenta('sin_aplicar'), noAparecen: cuenta('no_aparece'), sinCargar: cuenta('banco_sin_cargar'),
    };
  });

  constructor() { this.cargar(); }

  /** ¿La fila ya tiene una acción que propuso el banco? Entonces «Ligar al cobro» pasa a ser «Otro cobro». */
  botonDelBanco(f: FichaClienteBandeja): boolean {
    const b = f.banco;
    if (!b || b.disputado_con) return false;
    return (b.estado === 'aplicado' && !!b.cobro) || (b.estado === 'sin_aplicar' && b.abonos[0]?.declarado !== f.cliente_code);
  }

  /** `[CC.21]` Liga al cobro que la conciliación ya le puso al abono (del mismo cliente). */
  ligarAlCobroDelBanco(f: FichaClienteBandeja): void {
    const c = f.banco?.cobro;
    if (!c || this.trabajando()) return;
    this.trabajando.set(f.id); this.error.set(null);
    this.svc.ligar(f.id, c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.trabajando.set(null); this.cargar(); },
      error: (e) => { this.trabajando.set(null); this.error.set(e?.error?.message || 'No se pudo ligar la ficha.'); },
    });
  }

  /**
   * `[CC.21]` Liga de una vez todas las que el banco confirma. De a una (el endpoint ya probado) y sin detenerse en la
   * primera falla: al final dice cuántas se ligaron y cuáles no, para reintentar sólo ésas.
   */
  ligarConfirmadas(): void {
    const lista = this.resumen().aplicadas;
    if (!lista.length || this.trabajando()) return;
    this.trabajando.set('lote'); this.error.set(null);
    from(lista).pipe(
      concatMap((f) => this.svc.ligar(f.id, f.banco!.cobro!.sucursal, f.banco!.cobro!.folio).pipe(
        map(() => null as string | null),
        catchError(() => of(f.cliente_nombre || f.cliente_code || f.id)),
      )),
      toArray(),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((fallas) => {
      const malas = fallas.filter((x): x is string => !!x);
      this.trabajando.set(null);
      this.cargar(); // primero: `cargar()` limpia el error al empezar
      if (malas.length) this.error.set(`Se ligaron ${lista.length - malas.length} de ${lista.length}. No se pudo: ${malas.join(', ')}.`);
    });
  }

  /** `[CC.21]` El dinero entró y Kepler no tiene el cobro: el abono queda declarado como de este cliente. */
  declararAbono(f: FichaClienteBandeja): void {
    if (this.trabajando()) return;
    this.trabajando.set(f.id); this.error.set(null);
    this.svc.declararAbono(f.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.trabajando.set(null); this.cargar(); },
      error: (e) => { this.trabajando.set(null); this.error.set(e?.error?.message || 'No se pudo marcar el abono.'); },
    });
  }

  /** Público: la pantalla de Cobranza lo llama cuando llega el aviso en vivo de una ficha nueva. */
  cargar(): void {
    this.cargando.set(true); this.error.set(null);
    this.svc.bandeja(this.estado()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.datos.set(d); this.cargando.set(false);
        const n = d.por_estado || {};
        this.opciones.set([
          { label: `Por revisar (${n['recibido'] ?? 0})`, value: 'recibido' },
          { label: `Ligadas (${n['validado'] ?? 0})`, value: 'validado' },
          { label: `Rechazadas (${n['rechazado'] ?? 0})`, value: 'rechazado' },
        ]);
      },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message || 'No se pudo cargar la bandeja.'); },
    });
  }

  cambiar(v: string): void { this.estado.set(v); this.cerrar(); this.cargar(); }

  abrirLigar(f: FichaClienteBandeja): void {
    this.abierta.set(f.id); this.modo.set('ligar'); this.candidatos.set(null);
    this.svc.candidatos(f.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.candidatos.set(r.cobros),
      error: (e) => { this.candidatos.set([]); this.error.set(e?.error?.message || 'No se pudieron buscar los cobros.'); },
    });
  }
  abrirRechazo(f: FichaClienteBandeja): void { this.abierta.set(f.id); this.modo.set('rechazar'); this.motivo = ''; }
  cerrar(): void { this.abierta.set(null); this.modo.set(null); this.candidatos.set(null); }

  ligar(f: FichaClienteBandeja, c: CobroCandidato): void {
    if (this.trabajando()) return;
    this.trabajando.set(f.id); this.error.set(null);
    this.svc.ligar(f.id, c.sucursal, c.folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.trabajando.set(null); this.cerrar(); this.cargar(); },
      error: (e) => { this.trabajando.set(null); this.error.set(e?.error?.message || 'No se pudo ligar la ficha.'); },
    });
  }

  rechazar(f: FichaClienteBandeja): void {
    const m = this.motivo.trim();
    if (m.length < 3 || this.trabajando()) return;
    this.trabajando.set(f.id); this.error.set(null);
    this.svc.rechazar(f.id, m).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.trabajando.set(null); this.cerrar(); this.cargar(); },
      error: (e) => { this.trabajando.set(null); this.error.set(e?.error?.message || 'No se pudo rechazar la ficha.'); },
    });
  }

  money(v: number | null | undefined): string {
    return v == null ? '—' : Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  cuando(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const min = Math.round((Date.now() - d.getTime()) / 60_000);
    if (min < 60) return `hace ${Math.max(min, 1)} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' });
  }
}
