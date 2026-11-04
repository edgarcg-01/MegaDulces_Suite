import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import {
  valorDePiezas, type PersonaDeCustodia, type ResultadoConteo, type ResultadoHecho, type SaldosDelLibro, type TopeDelCajon, type UsuarioDeMaquina,
} from '@megadulces/contracts';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { Permission } from '../../../../core/constants/permissions';
import { todayMx } from '../../../../core/utils/mx-date';
import { uuidV4 } from '../../../../core/utils/uuid';
import { LibroEfectivoService, type HallazgoDelLibro, type SolicitudDelLibro } from '../../libro-efectivo.service';
import { ConteoCajonComponent } from '../../components/conteo-cajon.component';
import { money, dmy } from '../finanzas-format';

type Conteo = 'cierre' | 'sorpresa' | 'arranque';

/**
 * ⭐ `[LE.6.3]` `[LE.6.4]` `[LE.6.6]` **Tu día**: la barra de la Ventanilla (§5.2). Lo que no es la
 * cola —abrir el día, el saldo de arranque, contar para cerrar, el arqueo sorpresa, cerrar con la firma
 * de Tesorería, los hallazgos y lo que espera firma— vive aquí, a un botón, y se abre en una ventana.
 *
 * Las cinco preguntas (`diseno` §0b):
 * 1. Qué ve: qué día está abierto (y si NO es hoy, eso primero: un día viejo abierto se cierra antes
 *    de operar hoy), cuántos hallazgos y cuántas firmas esperan.
 * 2. Qué no: el esperado del cajón antes de contar (el conteo es ciego, B11); en un arqueo sorpresa,
 *    ni después (lo ve quien concilia).
 * 3. Accesibilidad: cada acción es un botón con su verbo; los resultados se anuncian (`role="status"`).
 * 4. Ligado a: el libro (jornadas, conteos, hallazgos, solicitudes); la firma de Tesorería (D21).
 * 5. Quién: opera quien tiene GESTIONAR; cierra y firma quien tiene AUTORIZAR (nunca lo propio: la base).
 */
@Component({
  selector: 'app-ventanilla-dia',
  standalone: true,
  imports: [FormsModule, ButtonModule, DialogModule, InputTextModule, ConteoCajonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="vd" aria-label="Tu día">
      <p class="vd-estado" role="status" data-testid="dia-estado">
        @if (estado() === 'sin_medir') {
          No se pudo leer el día del libro.
        } @else if (!jornada()) {
          No hay día abierto.
        } @else if (jornada() !== hoy) {
          <b>El día abierto es el {{ dmy(jornada()!) }}, no hoy:</b> se cuenta y se cierra antes de operar hoy.
        } @else {
          Día abierto: <b>hoy, {{ dmy(jornada()!) }}</b>.
        }
      </p>
      <div class="vd-acciones">
        @if (!jornada() && estado() !== 'sin_medir') {
          <p-button size="small" label="Abrir el día" [disabled]="!gestionar()" (onClick)="abrirDia()" />
        }
        @if (jornada()) {
          @if (sinArranque()) {
            <p-button size="small" label="Saldo de arranque" [disabled]="!gestionar()" (onClick)="abrirConteo('arranque')" />
          }
          <p-button size="small" severity="secondary" [outlined]="true" label="Contar para cerrar" [disabled]="!gestionar()" (onClick)="abrirConteo('cierre')" />
          <p-button size="small" severity="secondary" [outlined]="true" label="Arqueo sorpresa" [disabled]="!gestionar()" (onClick)="abrirConteo('sorpresa')" />
          @if (autorizar()) {
            <p-button size="small" severity="secondary" [outlined]="true" label="Cerrar el día" (onClick)="cerrarDia()" />
          }
        }
        <p-button size="small" severity="secondary" [text]="true" [label]="'Firmas por dar (' + solicitudes().length + ')'" (onClick)="verFirmas.set(true)" />
        <p-button size="small" severity="secondary" [text]="true" label="Tope y usuarios de la máquina" (onClick)="abrirCatalogos()" />
        <p-button size="small" severity="secondary" [text]="true" [label]="'Hallazgos (' + hallazgos().length + ')'" (onClick)="verHallazgos.set(true)" />
      </div>
      <p class="vd-tope" data-testid="dia-tope">
        @if (tope()?.monto_minor) { Tope del cajón: <b>{{ minor(tope()!.monto_minor) }}</b> }
        @else { Sin tope del cajón fijado: al cerrar no se revisa el excedente. }
      </p>
      @if (aviso()) { <p class="vd-aviso" role="status" data-testid="dia-aviso">{{ aviso() }}</p> }
    </section>

    <p-dialog [visible]="!!conteo()" (visibleChange)="!$event && conteo.set(null)" [modal]="true" [draggable]="false" [style]="{ width: '38rem' }"
              [header]="conteo() === 'arranque' ? 'Saldo de arranque' : conteo() === 'sorpresa' ? 'Arqueo sorpresa' : 'Contar el cajón para cerrar'">
      @if (resultado(); as r) {
        <div class="vd-resultado" role="status" data-testid="resultado-conteo">
          @if (r.tipo === 'hecho') {
            <p>{{ r.hecho.estado === 'por_autorizar' ? 'Contado. El saldo de arranque lo firma Tesorería; con su firma abre el libro.' : 'Listo: el saldo de arranque quedó en el libro.' }}</p>
          } @else if (r.conteo.ciego) {
            <p>Contado: <b>{{ minor(r.conteo.total_minor) }}</b>. La diferencia la ve quien concilia, no quien cuenta.</p>
          } @else {
            <p>Contado: <b>{{ minor(r.conteo.total_minor) }}</b> · el libro esperaba {{ minor(r.conteo.esperado_minor) }}.</p>
            <p>{{ r.conteo.diferencia_minor === '0' ? 'Cuadra.' : 'No cuadra por ' + minor(r.conteo.diferencia_minor) + ': quedó un hallazgo con dueño.' }}</p>
            @if (excedeTope(r.conteo.total_minor); as ex) {
              <p class="vd-aviso--mal" data-testid="excede-tope">Pasa del tope por {{ minor(ex) }}: deposita lo que sobra en la máquina antes de cerrar (V1).</p>
            }
          }
        </div>
      } @else {
        <p class="muted">{{ conteo() === 'sorpresa' ? 'Cuenta un tercero, sin ver lo que el libro espera.' : 'Se cuenta todo el cajón por pieza, sin ver lo que el libro espera.' }}</p>
        <app-conteo-cajon sentido="entra" [total]="0" [(piezas)]="piezas" [conMorralla]="false" />
        @if (conteo() === 'sorpresa') {
          <label class="vd-lbl" for="vd-testigo">Quién está presente (testigo)</label>
          <input pInputText id="vd-testigo" class="vd-in" [ngModel]="testigo()" (ngModelChange)="testigo.set($event)" autocomplete="off" />
        }
        @if (error()) { <p class="vd-aviso vd-aviso--mal" role="alert">{{ error() }}</p> }
      }
      <ng-template #footer>
        @if (resultado()) {
          <p-button label="Listo" (onClick)="cerrarConteo()" />
        } @else {
          <p-button label="Cancelar" severity="secondary" [text]="true" (onClick)="conteo.set(null)" />
          <p-button label="Registrar el conteo" [disabled]="!listoParaContar()" [loading]="enviando()" (onClick)="registrarConteo()" />
        }
      </ng-template>
    </p-dialog>

    <p-dialog [visible]="verFirmas()" (visibleChange)="verFirmas.set($event)" [modal]="true" [draggable]="false" [style]="{ width: '38rem' }" header="Firmas por dar">
      @if (autorizar() && solicitudes().length) {
        <label class="vd-lbl" for="vd-nota">Motivo, si rechazas</label>
        <input pInputText id="vd-nota" class="vd-in" [ngModel]="nota()" (ngModelChange)="nota.set($event)" autocomplete="off" />
      }
      @for (s of solicitudes(); track s.id) {
        <div class="vd-fila" [attr.data-solicitud]="s.id">
          <span>{{ etiquetaEvento(s.event_kind) }} · <b class="num">{{ minor(s.gross_minor) }}</b> · {{ dmy(s.created_at) }}</span>
          @if (autorizar()) {
            <span class="vd-botones">
              <p-button size="small" label="Firmar" (onClick)="firmar(s.id)" />
              <p-button size="small" severity="secondary" [text]="true" label="Rechazar" [disabled]="nota().trim().length < 5" (onClick)="rechazar(s.id)" />
            </span>
          }
        </div>
      } @empty {
        <p class="muted">Nada espera firma.</p>
      }
      @if (!autorizar() && solicitudes().length) { <p class="muted">Las firma Tesorería (quien opera no firma, V9).</p> }
    </p-dialog>

    <p-dialog [visible]="verCatalogos()" (visibleChange)="verCatalogos.set($event)" [modal]="true" [draggable]="false" [style]="{ width: '40rem' }"
              header="Tope del cajón y usuarios de la máquina">
      <p class="vd-lbl">Tope del cajón {{ autorizar() ? '' : '(lo fija quien firma caja)' }}</p>
      @if (autorizar()) {
        <div class="vd-fila">
          <input pInputText class="vd-in" inputmode="numeric" aria-label="Tope en pesos" [ngModel]="nuevoTope()" (ngModelChange)="nuevoTope.set($event)" placeholder="pesos" />
          <p-button size="small" label="Fijar" [disabled]="!topeValido()" (onClick)="fijarTope()" />
        </div>
      }
      <p class="vd-lbl">Quién es cada usuario de la máquina</p>
      @for (u of usuarios(); track u.device + u.user_external) {
        <div class="vd-fila" [attr.data-usuario]="u.user_external">
          <span><b>{{ u.user_external }}</b> · {{ u.movimientos }} movimientos · {{ u.nombre ?? 'sin asignar' }}</span>
          @if (autorizar()) {
            <p-button size="small" severity="secondary" [text]="true" label="Asignar" (onClick)="asignando.set(u)" />
          }
        </div>
      } @empty {
        <p class="muted">La máquina no tiene movimientos con usuario en 90 días.</p>
      }
      @if (asignando(); as a) {
        <label class="vd-lbl" for="vd-busca">¿Quién es «{{ a.user_external }}»?</label>
        <input pInputText id="vd-busca" class="vd-in" [ngModel]="busca()" (ngModelChange)="buscar($event)" placeholder="Nombre o usuario" autocomplete="off" />
        @for (p of halladas(); track p.usuario_id) {
          <div class="vd-fila"><span>{{ p.nombre }}</span><p-button size="small" label="Es esta persona" (onClick)="asignar(a, p.usuario_id)" /></div>
        }
      }
    </p-dialog>

    <p-dialog [visible]="verHallazgos()" (visibleChange)="verHallazgos.set($event)" [modal]="true" [draggable]="false" [style]="{ width: '38rem' }" header="Hallazgos abiertos">
      @for (h of hallazgos(); track h.id) {
        <div class="vd-fila" [attr.data-hallazgo]="h.id">
          <span>{{ h.source }} · {{ h.account_code ?? '—' }} · <b class="num">{{ h.amount_minor === null ? '—' : minor(h.amount_minor) }}</b>
            · {{ h.dias_abierto ?? 0 }} días</span>
        </div>
      } @empty {
        <p class="muted">No hay hallazgos abiertos.</p>
      }
    </p-dialog>
  `,
  styles: [`
    .vd { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-4);
      margin: 0 0 var(--sp-4); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-subtle, var(--border)); border-radius: var(--r-sm, 8px); }
    .vd-estado { margin: 0; font-size: var(--fs-sm); }
    .vd-tope { flex-basis: 100%; margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .vd-acciones { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
    .vd-aviso { flex-basis: 100%; margin: 0; font-size: var(--fs-sm); }
    .vd-aviso--mal { color: var(--bad-fg); }
    .vd-resultado p { margin: 0 0 var(--sp-2); }
    .vd-lbl { display: block; margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); }
    .vd-in { width: 100%; }
    .vd-fila { display: flex; justify-content: space-between; gap: var(--sp-3); align-items: center; padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-subtle, var(--border)); font-size: var(--fs-sm); }
    .vd-botones { display: flex; gap: var(--sp-1); }
    .num { font-variant-numeric: tabular-nums; }
  `],
})
export class VentanillaDiaComponent implements OnInit {
  private readonly libro = inject(LibroEfectivoService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);
  /** Algo cambió en el libro: la Ventanilla vuelve a leer. */
  readonly cambio = output<void>();

  readonly dmy = dmy;
  readonly minor = (m: string | null | undefined): string => money(Number(m ?? 0) / 100);
  readonly hoy = todayMx();

  readonly estado = signal<'medido' | 'sin_medir'>('medido');
  readonly saldos = signal<SaldosDelLibro | null>(null);
  readonly jornada = computed(() => this.saldos()?.jornada_abierta ?? null);
  /** El cajón nunca tuvo un asiento: falta el saldo de arranque (D11). */
  readonly sinArranque = computed(() => {
    const c = this.saldos()?.cuentas.find((x) => x.code === 'CAJA_MXN');
    return !c || c.last_seq === '0';
  });
  readonly hallazgos = signal<HallazgoDelLibro[]>([]);
  readonly solicitudes = signal<SolicitudDelLibro[]>([]);
  readonly verFirmas = signal(false);
  readonly verHallazgos = signal(false);
  readonly aviso = signal<string | null>(null);
  // `[LE.1.15]` `[LE.2.10]` El tope y quién es cada usuario de la máquina.
  readonly tope = signal<TopeDelCajon | null>(null);
  readonly verCatalogos = signal(false);
  readonly nuevoTope = signal('');
  readonly topeValido = computed(() => /^\d+$/.test(this.nuevoTope().trim()) && Number(this.nuevoTope()) > 0);
  readonly usuarios = signal<UsuarioDeMaquina[]>([]);
  readonly asignando = signal<UsuarioDeMaquina | null>(null);
  readonly busca = signal('');
  readonly halladas = signal<PersonaDeCustodia[]>([]);
  /** El motivo de un rechazo: la base lo exige (un rechazo sin porqué no se registra). */
  readonly nota = signal('');

  readonly conteo = signal<Conteo | null>(null);
  readonly piezas = signal<Record<string, number>>({});
  readonly testigo = signal('');
  readonly enviando = signal(false);
  readonly error = signal<string | null>(null);
  readonly resultado = signal<{ tipo: 'conteo'; conteo: ResultadoConteo } | { tipo: 'hecho'; hecho: ResultadoHecho } | null>(null);
  private llave = '';

  readonly gestionar = computed(() => this.perms.has(Permission.FINANCE_CAJA_GESTIONAR));
  readonly autorizar = computed(() => this.perms.has(Permission.FINANCE_CAJA_AUTORIZAR));
  readonly listoParaContar = computed(() => {
    if (!this.conteo() || this.enviando() || !this.gestionar()) return false;
    const n = valorDePiezas(Object.fromEntries(Object.entries(this.piezas()).filter(([, v]) => Number(v) > 0)), 'MXN');
    if (n <= 0n) return false;
    return this.conteo() !== 'sorpresa' || this.testigo().trim().length >= 3;
  });

  ngOnInit(): void { this.leer(); }

  leer(): void {
    forkJoin({
      s: this.libro.saldos().pipe(catchError(() => of(null))),
      h: this.libro.hallazgos().pipe(catchError(() => of([] as HallazgoDelLibro[]))),
      q: this.libro.solicitudes().pipe(catchError(() => of([] as SolicitudDelLibro[]))),
      t: this.libro.tope().pipe(catchError(() => of(null))),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ s, h, q, t }) => {
      this.saldos.set(s); this.estado.set(s ? 'medido' : 'sin_medir'); this.hallazgos.set(h); this.solicitudes.set(q); this.tope.set(t);
    });
  }

  private hecho(msg: string): void { this.aviso.set(msg); this.leer(); this.cambio.emit(); }
  private fallo(e: unknown, porDefecto: string): void {
    const err = (e as { error?: { mensaje?: string; message?: string } })?.error;
    this.aviso.set(err?.mensaje ?? err?.message ?? porDefecto);
  }

  abrirDia(): void {
    this.libro.abrirJornada(this.hoy).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => this.hecho(`Día abierto: ${dmy(this.hoy)}.`), error: (e) => this.fallo(e, 'No se abrió el día.'),
    });
  }

  cerrarDia(): void {
    const j = this.jornada();
    if (!j) return;
    this.libro.cerrarJornada(j).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.hecho(r.excedente ? `Día ${dmy(j)} cerrado con tu firma. El cajón pasaba del tope: quedó un hallazgo a nombre de quien cerró.` : `Día ${dmy(j)} cerrado con tu firma.`),
      error: (e) => this.fallo(e, 'No se cerró el día.'),
    });
  }

  abrirConteo(t: Conteo): void {
    this.conteo.set(t); this.piezas.set({}); this.testigo.set(''); this.error.set(null); this.resultado.set(null);
    this.llave = uuidV4();
  }

  registrarConteo(): void {
    const t = this.conteo();
    if (!t || !this.listoParaContar()) return;
    const piezas = Object.fromEntries(Object.entries(this.piezas()).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, String(n)]));
    this.enviando.set(true);
    this.error.set(null);
    const fin = { error: (e: unknown) => { this.enviando.set(false); const err = (e as { error?: { mensaje?: string } })?.error; this.error.set(err?.mensaje ?? 'No se registró.'); } };
    if (t === 'arranque') {
      this.libro.registrarHecho({ tipo: 'apertura', moneda: 'MXN', fecha: this.jornada() ?? this.hoy, conteos: [{ cuenta: 'CAJA_MXN', piezas }] }, this.llave)
        .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (h) => { this.enviando.set(false); this.resultado.set({ tipo: 'hecho', hecho: h }); }, ...fin });
      return;
    }
    this.libro.contar({ cuenta: 'CAJA_MXN', tipo: t, piezas, contado_en: new Date().toISOString(), ...(t === 'sorpresa' ? { testigo: this.testigo().trim() } : {}) })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (c) => { this.enviando.set(false); this.resultado.set({ tipo: 'conteo', conteo: c }); }, ...fin });
  }

  cerrarConteo(): void { this.conteo.set(null); this.resultado.set(null); this.leer(); this.cambio.emit(); }

  firmar(id: string): void {
    this.libro.autorizar(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.hecho('Firmado.'), error: (e) => this.fallo(e, 'No se firmó.') });
  }

  rechazar(id: string): void {
    if (this.nota().trim().length < 5) return;
    this.libro.rechazar(id, this.nota().trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => this.hecho('Rechazada.'), error: (e) => this.fallo(e, 'No se rechazó.') });
  }

  /** Lo contado arriba del tope, en centavos; `null` si no pasa o no hay tope fijado. */
  excedeTope(totalMinor: string): string | null {
    const t = this.tope()?.monto_minor;
    if (!t) return null;
    const d = BigInt(totalMinor) - BigInt(t);
    return d > 0n ? d.toString() : null;
  }

  abrirCatalogos(): void {
    this.verCatalogos.set(true); this.asignando.set(null); this.busca.set(''); this.halladas.set([]); this.nuevoTope.set('');
    this.libro.usuariosDeMaquina().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (u) => this.usuarios.set(u), error: () => this.usuarios.set([]) });
  }

  fijarTope(): void {
    if (!this.topeValido()) return;
    this.libro.fijarTope(String(Number(this.nuevoTope().trim()) * 100)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (t) => { this.tope.set(t); this.nuevoTope.set(''); this.aviso.set('Tope fijado.'); }, error: (e) => this.fallo(e, 'No se fijó el tope.'),
    });
  }

  buscar(q: string): void {
    this.busca.set(q);
    if (q.trim().length < 2) { this.halladas.set([]); return; }
    this.libro.personas(q.trim()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (p) => this.halladas.set(p), error: () => this.halladas.set([]) });
  }

  asignar(u: UsuarioDeMaquina, persona: string): void {
    this.libro.asignarUsuarioDeMaquina({ device: u.device, user_external: u.user_external, persona }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (l) => { this.usuarios.set(l); this.asignando.set(null); this.cambio.emit(); }, error: (e) => this.fallo(e, 'No se asignó.'),
    });
  }

  etiquetaEvento(k: string): string {
    return ({ apertura: 'Saldo de arranque', otro_ingreso: 'Otro ingreso', entrega_ruta: 'Cobro de ruta', clasificar_suspenso: 'Explicación de Suspenso',
      retiro_a_custodia: 'Custodia del cajón', faltante: 'Faltante', sobrante: 'Sobrante', ajuste: 'Ajuste', reversa: 'Reversa' } as Record<string, string>)[k] ?? k;
  }
}
