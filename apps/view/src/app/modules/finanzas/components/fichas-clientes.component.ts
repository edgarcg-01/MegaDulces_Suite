import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SegmentedComponent } from '../../../shared/components/segmented/segmented.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FichasClientesService, FichaClienteBandeja, CobroCandidato } from '../deposito-cliente.service';

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
        <table class="surf-table surf-table--plain fc-tabla">
          <thead>
            <tr>
              <th scope="col">Cliente</th>
              <th scope="col" class="comm-num">Declaró</th>
              <th scope="col">La foto dice</th>
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
                <td><span class="fc-muted">{{ cuando(f.enviado) }}</span></td>
                <td class="fc-acc">
                  @switch (f.status) {
                    @case ('validado') { <span class="fc-ok">Ligada al cobro {{ f.folio }}</span> }
                    @case ('rechazado') { <span class="fc-bad" [title]="f.motivo_rechazo || ''">Rechazada</span> }
                    @default {
                      <button type="button" class="fc-btn fc-btn-main" [disabled]="trabajando() === f.id" (click)="abrirLigar(f)">Ligar al cobro</button>
                      <button type="button" class="fc-btn" [disabled]="trabajando() === f.id" (click)="abrirRechazo(f)">Rechazar</button>
                    }
                  }
                </td>
              </tr>
              @if (abierta() === f.id && modo() === 'ligar') {
                <tr class="fc-panel"><td colspan="5">
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
                <tr class="fc-panel"><td colspan="5">
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
    .fc-link { display: inline-block; margin-right: var(--sp-2); color: var(--action); font-size: var(--fs-sm); }
    .fc-acc { white-space: nowrap; text-align: right; }
    .fc-btn { min-height: 32px; padding: 0 var(--sp-3); border-radius: var(--r-md, 8px); border: 1px solid var(--border-color); background: transparent; color: var(--text-main); font: inherit; font-size: var(--fs-sm); cursor: pointer; margin-left: var(--sp-2); }
    .fc-btn:focus-visible, .fc-campo input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .fc-btn-main { background: var(--action); color: var(--action-fg, #fff); border-color: var(--action); }
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
  readonly datos = signal<{ por_estado: Record<string, number>; fichas: FichaClienteBandeja[] } | null>(null);
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

  constructor() { this.cargar(); }

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
