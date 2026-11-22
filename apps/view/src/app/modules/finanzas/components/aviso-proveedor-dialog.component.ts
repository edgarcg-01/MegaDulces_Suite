import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import {
  normalizarCorreo, normalizarWhatsApp, type AvisoDePago, type AvisoDePagoCreado, type CanalAviso,
} from '@megadulces/contracts/finance/aviso-de-pago';
import { money } from '../../../shared/util/money.util';
import { environment } from '../../../../environments/environment';

const NOMBRE_CANAL: Record<CanalAviso, string> = { whatsapp: 'WhatsApp', correo: 'correo', liga: 'liga copiada' };

/**
 * `[PGP.194]` **Avisar al proveedor** (anexo AV, DA3 de Francisco, 2026-11-21): el desglose del pago —sus facturas,
 * las notas de crédito aplicadas y la transferencia— para que su cobranza haga el complemento de pago.
 *
 * Las cinco preguntas (`diseno` §0b), contestadas en el anexo §6:
 *  1. Primero a quién y cuánto (proveedor, fecha, importe, rastreo) y las facturas con lo pagado; luego a quién se le
 *     manda —el contacto recordado ya viene escrito— y los botones; al final, quién ya avisó y cuándo.
 *  2. No los campos del REP (saldo anterior, insoluto): son del proveedor y de sus reglas.
 *  3. A un clic desde el renglón; el PDF a un clic; todo con teclado; los errores con texto (`role="alert"`).
 *  4. El PDF lleva anexo el comprobante que se soltó en el renglón (`[PGP.191]`); el registro alimenta «Por notificar».
 *  5. Le toca al Calendario: Tesorería y Finanzas ya trabajan el pago ahí.
 *
 * ⛔ La Suite no manda nada sola: abre WhatsApp o el correo de quien presiona el botón, con el mensaje y la liga listos.
 */
@Component({
  selector: 'app-aviso-proveedor-dialog',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [header]="titulo() && titulo() !== '—' ? 'Avisar al proveedor · ' + titulo() : 'Avisar al proveedor'"
              [style]="{ width: '44rem' }" [breakpoints]="{ '720px': '96vw' }" [dismissableMask]="true">
      @if (cargando()) {
        <p class="av-d" role="status"><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> Armando el aviso…</p>
      } @else if (error(); as e) {
        <p class="av-err" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> {{ e }}
          <button pButton type="button" class="p-button-text p-button-sm" label="Reintentar" (click)="cargar()"></button></p>
      } @else if (aviso(); as a) {
        <p class="av-res">
          <b>{{ a.proveedor.nombre }}</b>@if (a.proveedor.rfc) { <span class="av-d"> · RFC {{ a.proveedor.rfc }}</span> }<br />
          Transferencia del {{ fecha(a.fecha_pago) }} por <b class="comm-num">{{ money(a.importe) }}</b>
          @if (a.rastreo) { · rastreo <span class="comm-num">{{ a.rastreo }}</span> }
          @if (a.origen || a.destino) { <span class="av-d"> · {{ a.origen || '—' }} → {{ a.destino || '—' }}</span> }
        </p>
        <table class="av-fac" aria-label="Facturas que paga esta transferencia">
          <thead><tr><th scope="col">Su referencia</th><th scope="col">UUID</th><th scope="col" class="r">Notas aplicadas</th><th scope="col" class="r">Pagado</th></tr></thead>
          <tbody>
            @for (f of a.facturas; track $index) {
              <tr>
                <td><b>{{ f.referencia || '—' }}</b><span class="av-d av-doc">{{ f.documento }}</span></td>
                <td class="comm-num av-uuid">@if (f.uuid) { {{ f.uuid.slice(0, 8).toUpperCase() }}… } @else { <span class="av-falta">sin CFDI</span> }</td>
                <td class="r comm-num">@if (notas(f) > 0) { −{{ money(notas(f)) }} } @else { — }</td>
                <td class="r comm-num"><b>{{ money(f.pagado) }}</b></td>
              </tr>
            }
          </tbody>
        </table>
        @if (a.faltantes.length) {
          <ul class="av-faltan" aria-label="Lo que el aviso no puede decir">
            @for (x of a.faltantes; track x) { <li><i class="pi pi-info-circle" aria-hidden="true"></i> {{ x }}</li> }
          </ul>
        }
        @if (!a.se_puede) {
          <p class="av-err" role="alert"><i class="pi pi-ban" aria-hidden="true"></i> {{ a.motivo }}</p>
        } @else {
          <div class="av-campos">
            <label class="av-l" for="av-nom">Contacto de cobranza <span class="av-d">(opcional)</span></label>
            <input id="av-nom" pInputText type="text" autocomplete="off" [(ngModel)]="nombre" maxlength="120" />
            <label class="av-l" for="av-wa">WhatsApp</label>
            <input id="av-wa" pInputText type="tel" inputmode="tel" autocomplete="off" [(ngModel)]="whatsapp" placeholder="10 dígitos" (ngModelChange)="mensaje.set(null)" />
            <label class="av-l" for="av-mail">Correo</label>
            <input id="av-mail" pInputText type="email" inputmode="email" autocomplete="off" [(ngModel)]="email" placeholder="cobranza@proveedor.com" (ngModelChange)="mensaje.set(null)" />
          </div>
          <p class="av-d">Se recuerdan para el siguiente pago de este proveedor. El mensaje lleva la liga al PDF del aviso, con el comprobante de la transferencia anexo.</p>
          @if (mensaje(); as m) { <p [class.av-err]="m.mal" [class.av-ok]="!m.mal" [attr.role]="m.mal ? 'alert' : 'status'">{{ m.texto }}</p> }
          @if (respaldo(); as r) { <p class="av-d">Si no se abrió solo: <a [href]="r.href" target="_blank" rel="noopener">{{ r.texto }}</a></p> }
          <div class="av-acc">
            <button pButton type="button" icon="pi pi-whatsapp" label="WhatsApp" [loading]="enviando() === 'whatsapp'" [disabled]="!!enviando()" (click)="enviar('whatsapp')"></button>
            <button pButton type="button" class="p-button-outlined" icon="pi pi-envelope" label="Correo" [loading]="enviando() === 'correo'" [disabled]="!!enviando()" (click)="enviar('correo')"></button>
            <button pButton type="button" class="p-button-text" icon="pi pi-link" label="Copiar liga" [loading]="enviando() === 'liga'" [disabled]="!!enviando()" (click)="enviar('liga')"></button>
            <button pButton type="button" class="p-button-text" icon="pi pi-file-pdf" label="Ver PDF" [loading]="viendo()" (click)="verPdf()"></button>
          </div>
        }
        @if (a.avisos.length) {
          <div class="av-hist" aria-label="Avisos enviados de este pago">
            @for (h of a.avisos; track $index) {
              <p class="av-d"><i class="pi pi-check" aria-hidden="true"></i> {{ nombreCanal(h.canal) }}@if (h.destino) { a {{ h.destino }} } · {{ h.por }} · {{ fechaHora(h.el) }}</p>
            }
          </div>
        }
      }
    </p-dialog>
  `,
  styles: [`
    .av-res { margin:0 0 var(--sp-3); line-height:1.5; }
    .av-d { color:var(--text-muted); font-size:var(--fs-sm); }
    .av-doc { display:block; font-size:var(--fs-xs); }
    .av-fac { width:100%; border-collapse:collapse; font-size:var(--fs-sm); margin-bottom:var(--sp-2); }
    .av-fac th { text-align:left; font-size:var(--fs-xs); color:var(--text-muted); font-weight:600; padding:var(--sp-1); border-bottom:1px solid var(--border-color); }
    .av-fac td { padding:var(--sp-1); border-bottom:1px solid var(--border-color); vertical-align:top; }
    .av-fac .r { text-align:right; }
    .av-uuid { font-size:var(--fs-xs); }
    .av-falta { color:var(--warn-soft-fg); }
    .av-faltan { list-style:none; margin:0 0 var(--sp-3); padding:0; font-size:var(--fs-sm); color:var(--warn-soft-fg); }
    .av-campos { display:grid; grid-template-columns:max-content 1fr; gap:var(--sp-2) var(--sp-3); align-items:center; margin:var(--sp-3) 0 var(--sp-1); }
    .av-l { font-size:var(--fs-sm); font-weight:600; }
    .av-acc { display:flex; flex-wrap:wrap; gap:var(--sp-2); margin-top:var(--sp-3); }
    .av-err { color:var(--bad-fg); font-size:var(--fs-sm); }
    .av-ok { color:var(--ok-fg); font-size:var(--fs-sm); }
    .av-hist { margin-top:var(--sp-3); border-top:1px solid var(--border-color); padding-top:var(--sp-2); }
    .av-hist p { margin:0 0 var(--sp-1); }
    @media (max-width: 40rem) { .av-campos { grid-template-columns:1fr; } }
    @media (pointer: coarse) { .av-acc button { min-height:44px; } }
  `],
})
export class AvisoProveedorDialogComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/payment-notices`;

  /** Se avisó por algún canal: el Calendario puede volver a leer el día. */
  readonly avisado = output<string>();

  readonly visible = signal(false);
  readonly titulo = signal('');
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly aviso = signal<AvisoDePago | null>(null);
  readonly enviando = signal<CanalAviso | null>(null);
  readonly viendo = signal(false);
  readonly mensaje = signal<{ texto: string; mal: boolean } | null>(null);
  /** Si el navegador bloqueó la ventana, la liga para abrirla a mano. */
  readonly respaldo = signal<{ href: string; texto: string } | null>(null);
  private pagoId = '';
  nombre = '';
  whatsapp = '';
  email = '';

  readonly money = money;

  abrir(pagoId: string, titulo: string): void {
    this.pagoId = pagoId;
    this.titulo.set(titulo);
    this.aviso.set(null);
    this.mensaje.set(null);
    this.respaldo.set(null);
    this.visible.set(true);
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.http.get<AvisoDePago>(`${this.base}/${encodeURIComponent(this.pagoId)}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (a) => {
        this.aviso.set(a);
        this.nombre = a.contacto?.nombre ?? '';
        this.whatsapp = a.contacto?.whatsapp ? a.contacto.whatsapp.replace(/^52/, '') : '';
        this.email = a.contacto?.email ?? '';
        this.cargando.set(false);
      },
      error: (e) => { this.cargando.set(false); this.error.set(e?.error?.message || 'No se pudo armar el aviso de este pago.'); },
    });
  }

  notas(f: AvisoDePago['facturas'][number]): number {
    return Math.round(f.notas.reduce((s, n) => s + n.importe, 0) * 100) / 100;
  }
  nombreCanal(c: CanalAviso): string { return NOMBRE_CANAL[c] ?? c; }
  fecha(iso: string | null): string { return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'sin fecha'; }
  fechaHora(iso: string): string { return `${this.fecha(iso)} ${iso.slice(11, 16)}`; }

  enviar(canal: CanalAviso): void {
    // Se revisa aquí lo que el servidor revisaría igual, para decirlo junto al campo y no después.
    if (this.whatsapp.trim() && !normalizarWhatsApp(this.whatsapp)) { this.mensaje.set({ texto: 'El WhatsApp debe ser un número de México de 10 dígitos.', mal: true }); return; }
    if (this.email.trim() && !normalizarCorreo(this.email)) { this.mensaje.set({ texto: 'El correo no tiene forma de correo (nombre@dominio.com).', mal: true }); return; }
    this.enviando.set(canal);
    this.mensaje.set(null);
    this.respaldo.set(null);
    const body = { canal, whatsapp: this.whatsapp.trim() || null, email: this.email.trim() || null, nombre: this.nombre.trim() || null };
    this.http.post<AvisoDePagoCreado>(`${this.base}/${encodeURIComponent(this.pagoId)}`, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.enviando.set(null);
        if (canal === 'whatsapp') this.abrirFuera(r.whatsapp_url, 'Abrir WhatsApp');
        else if (canal === 'correo') { window.location.href = r.mailto; this.respaldo.set({ href: r.mailto, texto: 'Abrir el correo' }); }
        else this.copiar(r.url);
        if (canal !== 'liga') this.mensaje.set({ texto: `Listo: el mensaje va con la liga al aviso. Revísalo y envíalo desde ${canal === 'whatsapp' ? 'WhatsApp' : 'tu correo'}.`, mal: false });
        this.avisado.emit(this.pagoId);
        this.cargar();
      },
      error: (e) => { this.enviando.set(null); this.mensaje.set({ texto: e?.error?.message || 'No se pudo preparar el aviso.', mal: true }); },
    });
  }

  private abrirFuera(href: string, texto: string): void {
    // Sin el rasgo 'noopener': con él `window.open` devuelve SIEMPRE null y el respaldo saldría aunque se abriera.
    const w = window.open(href, '_blank');
    if (w) { try { w.opener = null; } catch { /* otro origen: ya no hay referencia */ } }
    else this.respaldo.set({ href, texto });
  }

  private copiar(url: string): void {
    const ok = () => this.mensaje.set({ texto: 'Liga copiada: pégala donde la vayas a mandar.', mal: false });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(ok, () => this.respaldo.set({ href: url, texto: 'la liga del aviso' }));
    else this.respaldo.set({ href: url, texto: 'la liga del aviso' });
  }

  verPdf(): void {
    this.viendo.set(true);
    this.http.get(`${this.base}/${encodeURIComponent(this.pagoId)}/pdf`, { responseType: 'blob' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => {
        this.viendo.set(false);
        const url = URL.createObjectURL(blob);
        this.abrirFuera(url, 'Ver el PDF del aviso');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      error: () => { this.viendo.set(false); this.mensaje.set({ texto: 'No se pudo generar el PDF del aviso.', mal: true }); },
    });
  }
}
