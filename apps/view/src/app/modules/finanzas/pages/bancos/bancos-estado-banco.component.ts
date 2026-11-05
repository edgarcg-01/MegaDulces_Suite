import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CheckboxModule } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';
import { LoadStateComponent } from '../../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, MetricStripItem } from '../../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../../shared/components/freshness-pill/freshness-pill.component';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';
import { ArchivosDelBanco, BankService, ComoSeFijoLaCuenta, RevisionEstadoBanco } from '../../bank.service';
import { BANCOS_STYLES } from './bancos.styles';

const BANCO: Readonly<Record<RevisionEstadoBanco['banco'], string>> = {
  santander: 'Santander', banorte: 'Banorte', bbva: 'BBVA', banbajio: 'BanBajío',
};
const COMO: Readonly<Record<ComoSeFijoLaCuenta, { corto: string; largo: string; sev: 'success' | 'warn' }>> = {
  en_archivo: { corto: 'en el archivo', largo: 'el número de cuenta viene en el archivo', sev: 'success' },
  saldo_continuo: { corto: 'por saldo', largo: 'el saldo inicial es exactamente el último saldo conocido de esta cuenta', sev: 'success' },
  sin_testigo: { corto: 'sin testigo', largo: 'no hay un saldo anterior de esta cuenta con qué comprobarlo: queda guardado como «sin testigo»', sev: 'warn' },
};

/**
 * `[CB.59]` La descarga del banco (Santander, Banorte, BBVA, BanBajío) se sube aquí: el sistema la
 * lee, dice si entra completa y a qué cuenta, y sólo entonces se guarda. Reemplaza que Tesorería
 * copie los movimientos a mano al libro «CUENTAS».
 *
 * Las cinco preguntas (diseno §0b), contestadas antes de escribir:
 *  1. Qué ve y en qué orden: el botón para subir y, al soltar el archivo, el veredicto primero
 *     («se puede guardar N movimientos de BBVA 4885» o por qué no); abajo, lo que ya se subió, lo
 *     más nuevo primero.
 *  2. Qué no: los renglones uno por uno (no deciden si se guarda; el saldo encadenado ya lo prueba)
 *     ni la clasificación (CB.61, todavía no existe).
 *  3. Accesibilidad: la cuenta por nombre; si el archivo no la trae, la que coincide por saldo ya
 *     viene elegida; si ninguna coincide, guardar pide confirmar a mano la cuenta (no se pinta en
 *     verde lo que nadie comprobó); el motivo de un bloqueo en una frase, sin código.
 *  4. Ligas: viene de la banca en línea; TODAVÍA no alimenta Movimientos ni la conciliación (CB.60)
 *     — se dice en la tarjeta para que nadie lo dé por hecho.
 *  5. Le toca a Bancos › Cuentas y a quien hoy sube el libro (FINANCE_BANK_GESTIONAR); ver la lista
 *     pide FINANCE_BANK_VER, el mismo permiso de la pantalla.
 */
@Component({
  selector: 'bancos-estado-banco',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, ButtonModule, DialogModule, SelectModule, TableModule, TagModule, CheckboxModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card-premium card-flat fb-tablewrap eb-card" aria-labelledby="eb-titulo">
      <div class="eb-head">
        <div>
          <h3 id="eb-titulo" class="fb-card-title eb-title">Estados de cuenta del banco</h3>
          <p class="eb-sub">La descarga de la banca en línea, tal cual: Santander y Banorte (CSV), BBVA (.exp) y BanBajío (Excel).
            No depende del periodo elegido arriba y todavía no alimenta Movimientos ni la conciliación.
            @if (sinLector().length) { {{ sinLector().join(', ') }} no se puede subir aún: no hay lector de su banco. }</p>
        </div>
        @if (puedeSubir()) {
          <input #archivo type="file" accept=".csv,.exp,.txt,.xlsx" hidden (change)="alElegir($event)">
          <button pButton type="button" class="p-button-sm" [loading]="leyendo()" (click)="archivo.click()">
            <span class="p-button-icon p-button-icon-left pi pi-upload" aria-hidden="true"></span><span class="p-button-label">Subir descarga del banco</span></button>
        }
      </div>

      <!-- Primario: de qué cuentas hay descarga y hasta qué día llega la más atrasada. -->
      @if (!cargando() && !error()) {
        <div class="eb-resumen">
          <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Descargas del banco por cuenta" />
          <app-freshness-pill measures="data" [since]="ultimaSubida()" label="última subida" [staleAfterSec]="129600" />
        </div>
      }

      <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="!archivos().length" [skeletonRows]="3"
        emptyTitle="Todavía no se ha subido ninguna descarga del banco"
        [emptyHint]="puedeSubir() ? 'Descarga los movimientos de la cuenta en la banca en línea y súbelos con el botón de arriba.' : null"
        (retry)="cargar()">
        <p-table [value]="archivos()" dataKey="id" size="small" class="surf-table surf-table--plain surf-table--sticky" [scrollable]="true" scrollHeight="40vh">
          <ng-template #header>
            <tr>
              <th>Cuenta</th><th>Periodo</th><th class="comm-num">Movimientos</th>
              <th class="comm-num">Saldo inicial</th><th class="comm-num">Saldo final</th>
              <th>Cuenta comprobada</th><th>Subido</th>
            </tr>
          </ng-template>
          <ng-template #body let-f>
            <tr>
              <td class="eb-strong">{{ f.alias || f.account_label }}</td>
              <td class="mono">{{ f.date_from | date:'dd/MM/yy' }} – {{ f.date_to | date:'dd/MM/yy' }}</td>
              <td class="comm-num mono">{{ f.lines_in_file }}@if (f.lines_in_file > f.lines_new) { <span class="muted">({{ f.lines_in_file - f.lines_new }} ya estaban)</span> }</td>
              <td class="comm-num mono">{{ num(f.opening_balance) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td class="comm-num mono eb-strong">{{ num(f.closing_balance) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
              <td><p-tag [value]="como(f.account_check).corto" [severity]="como(f.account_check).sev" /></td>
              <td><span class="mono">{{ f.created_at | date:'dd/MM HH:mm' }}</span> <span class="muted">{{ f.created_by || '' }}</span></td>
            </tr>
          </ng-template>
        </p-table>
        @if (datos(); as d) { @if (d.total > d.archivos.length) {
          <p class="eb-leyenda">Se muestran los {{ d.archivos.length }} más recientes de {{ d.total }} archivos subidos; el resumen de arriba cuenta todos.</p>
        } }
        <p class="eb-leyenda">Cuenta comprobada: <b>en el archivo</b>, el banco pone el número de cuenta ·
          <b>por saldo</b>, el archivo arranca exactamente donde cerró el anterior de esa cuenta ·
          <b>sin testigo</b>, no había un saldo anterior con qué comprobarla.</p>
      </app-load-state>
    </section>

    <p-dialog [visible]="abierto()" (visibleChange)="$event ? null : cerrar()" [modal]="true" [draggable]="false"
              [style]="{ width: '40rem', maxWidth: '96vw' }" [header]="tituloDialogo()" styleClass="eb-dlg">
      @if (revision(); as r) {
        <!-- Primario: el veredicto. -->
        @if (r.ya_subido; as ya) {
          <p class="eb-veredicto" role="status"><i class="pi pi-info-circle" aria-hidden="true"></i>
            Este mismo archivo ya se subió el {{ ya.subido_el | date:'dd/MM/yy HH:mm' }}@if (ya.subido_por) { por {{ ya.subido_por }} }. No hay nada nuevo que guardar.</p>
        } @else if (r.puede_confirmar && r.como_se_fijo === 'sin_testigo') {
          <div class="eb-veredicto warn" role="status">
            <p><i class="pi pi-exclamation-triangle" aria-hidden="true"></i> No hay con qué comprobar que este archivo es de {{ r.cuenta?.alias }}.</p>
            <p class="eb-veredicto-sub">Ni el libro ni otra descarga de esa cuenta terminan en el saldo inicial del archivo ({{ num(r.saldo_inicial) | currency:'MXN':'symbol-narrow':'1.2-2' }}). Si eliges la cuenta equivocada, sus {{ r.nuevos }} movimientos quedan en ella.</p>
            <label class="eb-acepto"><p-checkbox [binary]="true" [ngModel]="aceptado()" (ngModelChange)="aceptado.set($event)" inputId="eb-acepto" />
              <span>Confirmo que el archivo es de <b>{{ r.cuenta?.alias }}</b></span></label>
          </div>
        } @else if (r.puede_confirmar) {
          <p class="eb-veredicto ok" role="status"><i class="pi pi-check-circle" aria-hidden="true"></i>
            @if (r.nuevos > 0) { Se pueden guardar {{ r.nuevos }} movimientos nuevos de {{ r.cuenta?.alias }}. }
            @else { Los {{ r.movimientos }} movimientos de {{ r.cuenta?.alias }} ya estaban guardados; se puede registrar el archivo sin duplicar nada. }</p>
        } @else {
          <div class="eb-veredicto bad" role="alert">
            <p><i class="pi pi-times-circle" aria-hidden="true"></i> No se puede guardar:</p>
            <ul>@for (m of r.motivos_bloqueo; track m) { <li>{{ m }}</li> }</ul>
          </div>
        }

        <!-- La cuenta: del archivo, o elegida (la que coincide por saldo ya viene puesta). -->
        <div class="eb-fila">
          <span class="eb-et">Cuenta</span>
          @if (r.como_se_fijo === 'en_archivo') {
            <span><b>{{ r.cuenta?.alias }}</b> <span class="muted">— {{ como('en_archivo').largo }}</span></span>
          } @else {
            <div class="eb-cuenta">
              <p-select [options]="opcionesCuenta()" optionLabel="label" optionValue="value" [ngModel]="cuentaElegida()"
                        (ngModelChange)="elegirCuenta($event)" placeholder="Elige la cuenta" appendTo="body"
                        [disabled]="leyendo() || guardando()" ariaLabel="Cuenta del estado de cuenta" styleClass="eb-sel" />
              @if (r.como_se_fijo) { <span class="muted eb-nota">{{ como(r.como_se_fijo).largo }}</span> }
            </div>
          }
        </div>

        <!-- Secundario: lo que trae el archivo y su control. -->
        <dl class="eb-datos">
          <div><dt>Periodo</dt><dd class="mono">{{ r.desde | date:'dd/MM/yy' }} – {{ r.hasta | date:'dd/MM/yy' }}</dd></div>
          <div><dt>Movimientos</dt><dd class="mono">{{ r.movimientos }} @if (r.ya_cargados) { <span class="muted">({{ r.ya_cargados }} ya estaban)</span> }</dd></div>
          <div><dt>Saldo inicial → final</dt><dd class="mono">{{ num(r.saldo_inicial) | currency:'MXN':'symbol-narrow':'1.2-2' }} → {{ num(r.saldo_final) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
          <div><dt>Abonos · cargos</dt><dd class="mono">{{ num(r.total_abonos) | currency:'MXN':'symbol-narrow':'1.2-2' }} · {{ num(r.total_cargos) | currency:'MXN':'symbol-narrow':'1.2-2' }}</dd></div>
          <div><dt>¿Falta algún renglón?</dt><dd>
            @if (r.cuadra) { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> No: cada saldo es el anterior más el movimiento</span> }
            @else { <span class="bad"><i class="pi pi-times" aria-hidden="true"></i> El saldo se rompe en {{ r.eslabones_rotos.length }} renglón(es)</span> }
          </dd></div>
          @if (r.totales_declarados_coinciden !== null) {
            <div><dt>Totales del banco</dt><dd>
              @if (r.totales_declarados_coinciden) { <span class="ok"><i class="pi pi-check" aria-hidden="true"></i> coinciden con lo leído</span> }
              @else { <span class="bad"><i class="pi pi-times" aria-hidden="true"></i> no coinciden con lo leído</span> }
            </dd></div>
          }
        </dl>

        @if (r.no_leidos.length) {
          <div class="eb-noleidos">
            <p class="eb-et">Renglones que no se pudieron leer</p>
            <ul>@for (n of r.no_leidos; track n.linea) { <li><span class="mono">línea {{ n.linea }}</span> — {{ n.motivo }}</li> }</ul>
          </div>
        }
      }

      <ng-template #footer>
        <button pButton type="button" class="p-button-sm p-button-text" (click)="cerrar()" [disabled]="guardando()">
          <span class="p-button-label">{{ revision()?.ya_subido ? 'Cerrar' : 'Cancelar' }}</span></button>
        @if (!revision()?.ya_subido) {
          <button pButton type="button" class="p-button-sm" [disabled]="!puedeGuardar()" [loading]="guardando()" (click)="guardar()">
            <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
            <span class="p-button-label">{{ textoGuardar() }}</span></button>
        }
      </ng-template>
    </p-dialog>
  `,
  styles: [BANCOS_STYLES, `
    :host { display: block; }
    .eb-card { margin-bottom: var(--sp-3); }
    .eb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-3) var(--sp-2); }
    .eb-title { margin: 0; }
    .eb-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 48rem; }
    .eb-strong { font-weight: 600; color: var(--text-main); }
    .eb-resumen { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: 0 var(--sp-3) var(--sp-2); }
    .eb-leyenda { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }

    /* Primario del diálogo: el veredicto, más grande que el título (que queda terciario). */
    .eb-veredicto { display: flex; align-items: baseline; gap: var(--sp-2); margin: 0 0 var(--sp-4); font-size: var(--fs-lg); font-weight: var(--fw-bold, 700); color: var(--text-main); }
    .eb-veredicto.ok { color: var(--ok-soft-fg); }
    div.eb-veredicto.warn { display: block; color: var(--warn-soft-fg); }
    .eb-veredicto.warn p { margin: 0; }
    .eb-veredicto .eb-veredicto-sub { margin-top: var(--sp-1); font-size: var(--fs-sm); font-weight: 400; color: var(--text-main); }
    .eb-acepto { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); font-size: var(--fs-sm); font-weight: 400; color: var(--text-main); cursor: pointer; }
    :host ::ng-deep .eb-dlg .p-dialog-title { font-size: var(--fs-sm); font-weight: var(--fw-medium, 500); color: var(--text-muted); }
    div.eb-veredicto.bad { display: block; color: var(--bad-fg); }
    .eb-veredicto.bad p { margin: 0; }
    .eb-veredicto.bad ul { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-weight: 400; color: var(--text-main); font-size: var(--fs-sm); }

    .eb-fila { display: grid; grid-template-columns: 7rem 1fr; gap: var(--sp-3); align-items: baseline; margin-bottom: var(--sp-4); font-size: var(--fs-sm); }
    .eb-et { font-size: var(--fs-xs); color: var(--text-muted); margin: 0; }
    .eb-cuenta { display: flex; flex-direction: column; gap: var(--sp-1); }
    .eb-nota { font-size: var(--fs-xs); }
    :host ::ng-deep .eb-sel.p-select { min-width: 18rem; font-size: var(--fs-sm); }

    .eb-datos { display: grid; grid-template-columns: 7rem 1fr; gap: var(--sp-2) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .eb-datos > div { display: contents; }
    .eb-datos dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .eb-datos dd { margin: 0; color: var(--text-main); }
    .eb-datos .ok, .eb-datos .bad { display: inline-flex; align-items: baseline; gap: var(--sp-1); }
    .eb-datos .ok { color: var(--ok-soft-fg); }

    .eb-noleidos { margin-top: var(--sp-4); font-size: var(--fs-sm); }
    .eb-noleidos ul { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); }

    @media (max-width: 40rem) {
      .eb-head { flex-direction: column; }
      .eb-fila, .eb-datos { grid-template-columns: 1fr; gap: var(--sp-1); }
    }
  `],
})
export class BancosEstadoBancoComponent implements OnInit {
  private readonly api = inject(BankService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly puedeSubir = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_BANK_GESTIONAR] === true);

  readonly datos = signal<ArchivosDelBanco | null>(null);
  readonly archivos = computed(() => this.datos()?.archivos ?? []);
  /** Cuentas activas cuyo banco no tiene lector (hoy Banamex): no cuentan como «faltan». */
  readonly sinLector = computed(() => (this.datos()?.cuentas ?? []).filter((c) => !c.con_lector).map((c) => c.alias));
  readonly aceptado = signal(false);
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);

  readonly abierto = signal(false);
  readonly leyendo = signal(false);
  readonly guardando = signal(false);
  readonly revision = signal<RevisionEstadoBanco | null>(null);
  readonly cuentaElegida = signal<string | null>(null);
  private archivo: { b64: string; nombre: string } | null = null;

  readonly ultimaSubida = computed(() => this.archivos()[0]?.created_at ?? null);
  /**
   * Por cuenta de banco activa con lector: hasta qué día llega su descarga. Lo calcula el servidor sobre
   * TODOS los archivos: la lista de abajo trae tope y un resumen hecho con ella mentiría.
   */
  readonly resumen = computed<MetricStripItem[]>(() => {
    const cuentas = (this.datos()?.cuentas ?? []).filter((c) => c.con_lector);
    const con = cuentas.filter((c) => c.hasta);
    const faltan = cuentas.filter((c) => !c.hasta).map((c) => c.alias);
    const conDescarga: MetricStripItem = { label: 'Cuentas con descarga', value: `${con.length} de ${cuentas.length}`, format: 'text', tone: faltan.length ? 'warn' : 'ok',
      sub: faltan.length ? `faltan ${faltan.slice(0, 3).join(', ')}${faltan.length > 3 ? ` y ${faltan.length - 3} más` : ''}` : 'todas' };
    if (!con.length) return [conDescarga];
    const atrasada = [...con].sort((a, b) => a.hasta!.localeCompare(b.hasta!))[0];
    const sinTestigo = cuentas.reduce((n, c) => n + c.sin_testigo, 0);
    return [
      conDescarga,
      { label: 'La más atrasada llega al', value: this.fecha(atrasada.hasta!), format: 'text', sub: atrasada.alias },
      { label: 'Sin testigo', value: sinTestigo, format: 'number', tone: sinTestigo ? 'warn' : 'muted', sub: 'archivos guardados sin poder comprobar la cuenta' },
    ];
  });

  readonly tituloDialogo = computed(() => {
    const r = this.revision();
    return r ? `Estado de cuenta ${BANCO[r.banco]}${r.archivo ? ' · ' + r.archivo : ''}` : 'Estado de cuenta';
  });
  readonly opcionesCuenta = computed(() => (this.revision()?.candidatas ?? []).map((c) => ({
    value: c.id,
    label: c.coincide ? `${c.alias} · su último saldo coincide`
      : c.saldo_conocido === null ? `${c.alias} · sin saldo anterior` : `${c.alias} · último saldo ${this.pesos(c.saldo_conocido)}`,
  })));
  readonly puedeGuardar = computed(() => {
    const r = this.revision();
    return !!r && r.puede_confirmar && !r.ya_subido && !this.leyendo() && !this.guardando()
      && (r.como_se_fijo !== 'sin_testigo' || this.aceptado());
  });
  readonly textoGuardar = computed(() => {
    const r = this.revision();
    const n = r?.nuevos ?? 0;
    if (r?.como_se_fijo === 'sin_testigo') return 'Guardar sin comprobar';
    return n === 0 ? 'Registrar el archivo' : n === 1 ? 'Guardar 1 movimiento' : `Guardar ${n} movimientos`;
  });

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.archivosDelBanco().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.error.set(this.mensaje(e, 'No se pudo leer la lista de estados de cuenta subidos.')); this.cargando.set(false); },
    });
  }

  alElegir(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.leyendo.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      this.archivo = { b64: String(reader.result || ''), nombre: file.name };
      this.cuentaElegida.set(null);
      this.aceptado.set(false);
      this.revisar(true);
    };
    reader.onerror = () => { this.leyendo.set(false); this.falla('No se pudo leer el archivo.'); };
    reader.readAsDataURL(file);
  }

  elegirCuenta(id: string | null): void {
    this.cuentaElegida.set(id);
    this.aceptado.set(false);
    this.revisar(false);
  }

  /** Lee el archivo en el servidor sin guardar. La primera vez, si UNA cuenta coincide por saldo, la elige sola. */
  private revisar(primera: boolean): void {
    if (!this.archivo) return;
    this.leyendo.set(true);
    this.api.revisarEstadoBanco(this.archivo.b64, this.archivo.nombre, this.cuentaElegida())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (r) => {
          this.leyendo.set(false);
          const coinciden = r.candidatas.filter((c) => c.coincide);
          if (primera && !r.cuenta && coinciden.length === 1) { this.elegirCuenta(coinciden[0].id); return; }
          this.cuentaElegida.set(r.como_se_fijo === 'en_archivo' ? null : (r.cuenta?.id ?? this.cuentaElegida()));
          this.revision.set(r);
          this.abierto.set(true);
        },
        error: (e: HttpErrorResponse) => { this.leyendo.set(false); this.falla(this.mensaje(e, 'No se pudo leer el archivo.')); },
      });
  }

  guardar(): void {
    if (!this.archivo || !this.puedeGuardar()) return;
    this.guardando.set(true);
    this.api.confirmarEstadoBanco(this.archivo.b64, this.archivo.nombre, this.cuentaElegida(), this.aceptado())
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (c) => {
          this.guardando.set(false);
          this.toast.add({
            severity: 'success', summary: 'Estado de cuenta guardado', life: 4000,
            detail: c.ya_existia ? 'Ese archivo ya estaba guardado.' : `${c.cuenta?.alias}: ${c.nuevos} movimiento(s) nuevo(s).`,
          });
          this.cerrar();
          this.cargar();
        },
        error: (e: HttpErrorResponse) => {
          this.guardando.set(false);
          const motivos: string[] | undefined = e?.error?.motivos;
          const r = this.revision();
          if (r && motivos?.length) this.revision.set({ ...r, puede_confirmar: false, motivos_bloqueo: motivos });
          else this.falla(this.mensaje(e, 'No se pudo guardar el estado de cuenta.'));
        },
      });
  }

  cerrar(): void {
    if (this.guardando()) return;
    this.abierto.set(false);
    this.revision.set(null);
    this.cuentaElegida.set(null);
    this.aceptado.set(false);
    this.archivo = null;
  }

  como(c: ComoSeFijoLaCuenta) { return COMO[c] ?? COMO.sin_testigo; }
  /** Los numeric de Postgres llegan como string por JSON. */
  num(v: number | string | null | undefined): number | null { return v === null || v === undefined ? null : Number(v); }
  private fecha(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }
  private pesos(v: number): string {
    return Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
  private mensaje(e: HttpErrorResponse, defecto: string): string {
    const m = e?.error?.message;
    return typeof m === 'string' && m ? m.charAt(0).toUpperCase() + m.slice(1) + '.' : defecto;
  }
  private falla(detail: string): void {
    this.toast.add({ severity: 'error', summary: 'Estado de cuenta', detail, life: 6000 });
  }
}
