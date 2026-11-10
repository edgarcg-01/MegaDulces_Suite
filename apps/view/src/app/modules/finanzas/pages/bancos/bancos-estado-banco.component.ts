import { ChangeDetectionStrategy, Component, DestroyRef, HostListener, OnInit, computed, inject, output, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
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
import { ArchivosDelBanco, BankService, ComoSeFijoLaCuenta, ContraElLibro, CuentaContraElLibro, DiaContraElLibro, RevisionEstadoBanco, VeredictoDelDia } from '../../bank.service';
import { BANCOS_STYLES } from './bancos.styles';

const BANCO: Readonly<Record<RevisionEstadoBanco['banco'], string>> = {
  santander: 'Santander', banorte: 'Banorte', bbva: 'BBVA', banbajio: 'BanBajío',
};
const COMO: Readonly<Record<ComoSeFijoLaCuenta, { corto: string; largo: string; sev: 'success' | 'warn' }>> = {
  en_archivo: { corto: 'en el archivo', largo: 'el número de cuenta viene en el archivo', sev: 'success' },
  saldo_continuo: { corto: 'por saldo', largo: 'arranca exactamente donde cerró esa cuenta', sev: 'success' },
  sin_testigo: { corto: 'sin testigo', largo: 'no había un saldo anterior con qué comprobar la cuenta', sev: 'warn' },
};

/** Un archivo soltado, de que se lee a que se guarda. */
export interface ArchivoEnLote {
  id: number;
  nombre: string;
  b64: string;
  estado: 'leyendo' | 'leido' | 'guardando' | 'error';
  revision: RevisionEstadoBanco | null;
  cuentaElegida: string | null;
  aceptado: boolean;
  error: string | null;
}
/** Lo que la fila le dice a la persona, en una palabra y una frase. */
export interface Veredicto { tono: 'ok' | 'warn' | 'bad' | 'muted'; icono: string; texto: string; listo: boolean }

/**
 * `[CB.59]` La descarga del banco (Santander, Banorte, BBVA, BanBajío) se suelta aquí, una o varias a
 * la vez: el sistema detecta el banco y la cuenta de cada una, dice si entra completa, y guarda las
 * que están listas. Reemplaza que Tesorería copie los movimientos a mano al libro «CUENTAS».
 *
 * Las cinco preguntas (diseno §0b), contestadas antes de escribir (rehecha el 2026-11-05 por Edgar:
 * «el 80 % de la pantalla se lo lleva donde adjuntar; que sea un espacio pequeño donde se arrastre
 * uno o más documentos y los detecte»):
 *  1. Qué ve y en qué orden: cuántas cuentas tienen su descarga; una franja de una línea para
 *     soltar archivos; al soltarlos, una fila por archivo con su veredicto, y un solo botón
 *     «Guardar N listos»; abajo, lo ya subido, lo más nuevo primero.
 *  2. Qué no: un vacío grande cuando no hay nada (el resumen ya dice «0 de 17»), ni una ventana
 *     aparte para revisar: se ve, se corrige y se guarda en la misma fila (Edgar, 2026-10-28).
 *  3. Accesibilidad: la cuenta por nombre; la que coincide por saldo ya viene elegida; si ninguna
 *     coincide, la fila pide confirmar la cuenta a mano y no se pinta en verde; el motivo de un
 *     bloqueo en una frase. Soltar es atajo, no requisito: «Elegir archivos» hace lo mismo.
 *  4. Ligas: viene de la banca en línea; TODAVÍA no alimenta Movimientos ni la conciliación (CB.60).
 *  5. Le toca a Bancos › Cuentas y a quien hoy sube el libro (FINANCE_BANK_GESTIONAR); ver la lista
 *     pide FINANCE_BANK_VER, el mismo permiso de la pantalla.
 */
@Component({
  selector: 'bancos-estado-banco',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, FormsModule, ButtonModule, SelectModule, TableModule, TagModule, CheckboxModule, LoadStateComponent, MetricStripComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card-premium card-flat fb-tablewrap eb-card" aria-labelledby="eb-titulo"
             (dragover)="alArrastrar($event)" (dragleave)="encima.set(false)" (drop)="alSoltar($event)">
      <div class="eb-head">
        <h3 id="eb-titulo" class="fb-card-title eb-title">Estados de cuenta del banco</h3>
        <app-freshness-pill measures="data" [since]="ultimaSubida()" label="última subida" [staleAfterSec]="129600" />
      </div>
      <p class="eb-sub">La descarga de la banca en línea, tal cual. No depende del periodo elegido arriba y todavía no alimenta Movimientos ni la conciliación: se compara contra el libro día por día.
        @if (sinLector().length) { {{ sinLector().join(', ') }} no se puede subir aún: no hay lector de su banco. }</p>

      <app-load-state [loading]="cargando()" [error]="error()" [skeletonRows]="2" (retry)="cargar()">
        <!-- Primario: de qué cuentas hay descarga y hasta qué día llega la más atrasada. -->
        <div class="eb-resumen">
          <app-metric-strip [items]="resumen()" density="compact" ariaLabel="Descargas del banco por cuenta" />
        </div>

        @if (puedeSubir()) {
          <div class="eb-soltar" [class.encima]="encima()">
            <i class="pi pi-cloud-upload" aria-hidden="true"></i>
            <span>Arrastra aquí una o varias descargas: Santander y Banorte (CSV), BBVA (.exp), BanBajío (Excel)</span>
            <input #elegir type="file" multiple accept=".csv,.exp,.txt,.xlsx" hidden (change)="alElegir($event)">
            <button pButton type="button" class="p-button-sm p-button-text eb-elegir" (click)="elegir.click()">
              <span class="p-button-label">Elegir archivos</span></button>
          </div>
        }

        <!-- Lo soltado: una fila por archivo, se ve, se corrige y se guarda aquí mismo. -->
        @if (lote().length) {
          <div class="eb-lote" aria-label="Archivos por guardar">
            <p-table [value]="lote()" dataKey="id" size="small" class="surf-table surf-table--plain">
              <ng-template #header>
                <tr>
                  <th>Archivo</th><th>Cuenta</th><th>Periodo</th><th class="comm-num">Movimientos</th>
                  <th class="comm-num">Saldo inicial → final</th><th>Estado</th><th><span class="sr-only">Quitar</span></th>
                </tr>
              </ng-template>
              <ng-template #body let-a>
                <tr>
                  <td><span class="eb-strong">{{ a.revision ? banco(a.revision.banco) : '' }}</span> <span class="muted eb-nombre">{{ a.nombre }}</span></td>
                  <td>
                    @if (a.revision; as r) {
                      @if (r.como_se_fijo === 'en_archivo' || !r.candidatas.length) { <span class="eb-strong">{{ r.cuenta?.alias || '—' }}</span> }
                      @else {
                        <p-select [options]="opciones(r)" optionLabel="label" optionValue="value" [ngModel]="a.cuentaElegida"
                                  (ngModelChange)="elegirCuenta(a, $event)" placeholder="Elige la cuenta" appendTo="body"
                                  [disabled]="a.estado !== 'leido' || guardando()" [ariaLabel]="'Cuenta de ' + a.nombre" styleClass="eb-sel" />
                      }
                    }
                  </td>
                  <td class="mono">@if (a.revision?.desde) { {{ a.revision.desde | date:'dd/MM' }} – {{ a.revision.hasta | date:'dd/MM/yy' }} }</td>
                  <td class="comm-num mono">@if (a.revision; as r) { {{ r.nuevos }}@if (r.ya_cargados) { <span class="muted"> (+{{ r.ya_cargados }} ya estaban)</span> } }</td>
                  <td class="comm-num mono">@if (a.revision?.saldo_inicial !== null && a.revision) { {{ num(a.revision.saldo_inicial) | currency:'MXN':'symbol-narrow':'1.2-2' }} → {{ num(a.revision.saldo_final) | currency:'MXN':'symbol-narrow':'1.2-2' }} }</td>
                  <td class="eb-estado">
                    <span [class]="'eb-v eb-v--' + veredicto(a).tono"><i [class]="'pi ' + veredicto(a).icono" aria-hidden="true"></i> {{ veredicto(a).texto }}</span>
                    @if (a.estado === 'leido' && a.revision?.como_se_fijo === 'sin_testigo' && a.revision?.puede_confirmar && !a.revision?.ya_subido) {
                      <label class="eb-acepto"><p-checkbox [binary]="true" [ngModel]="a.aceptado" (ngModelChange)="aceptar(a, $event)" [inputId]="'eb-acepto-' + a.id" />
                        <span>Confirmo que es de {{ a.revision?.cuenta?.alias }}</span></label>
                    }
                  </td>
                  <td><button pButton type="button" class="p-button-sm p-button-text p-button-rounded" [disabled]="a.estado === 'guardando'"
                              (click)="quitar(a)" [attr.aria-label]="'Quitar ' + a.nombre"><span class="pi pi-times" aria-hidden="true"></span></button></td>
                </tr>
              </ng-template>
            </p-table>
            <div class="eb-lote-pie">
              <span class="muted">{{ resumenLote() }}</span>
              <button pButton type="button" class="p-button-sm" [disabled]="!listos().length || guardando() || leyendo()" [loading]="guardando()" (click)="guardar()">
                <span class="p-button-icon p-button-icon-left pi pi-check" aria-hidden="true"></span>
                <span class="p-button-label">{{ textoGuardar() }}</span></button>
            </div>
          </div>
        }

        <!-- [CB.60] La compuerta de D2: por cuenta, si la descarga dice lo mismo que el libro. Primero lo que difiere. -->
        @if (cuentasContra().length) {
          <h4 class="eb-sec">Contra el libro <span class="muted">· desde el {{ contra()?.desde | date:'dd/MM/yy' }}</span></h4>
          <p-table [value]="cuentasContra()" dataKey="id" size="small" class="surf-table surf-table--plain">
            <ng-template #header>
              <tr>
                <th class="eb-tog"><span class="sr-only">Ver los días</span></th><th>Cuenta</th><th>Contra el libro</th>
                <th class="comm-num">Días que cuadran</th><th class="comm-num">Difieren</th><th class="comm-num">Sin libro</th><th>Abierto</th>
              </tr>
            </ng-template>
            <ng-template #body let-c let-expanded="expanded">
              <tr>
                <td class="eb-tog"><p-button type="button" [pRowToggler]="c" [icon]="expanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'"
                          styleClass="p-button-text p-button-sm" [ariaLabel]="'Ver los días de ' + c.alias" /></td>
                <td class="eb-strong">{{ c.alias }}</td>
                <td><span [class]="'eb-v eb-v--' + estadoContra(c).tono"><i [class]="'pi ' + estadoContra(c).icono" aria-hidden="true"></i> {{ estadoContra(c).texto }}</span></td>
                <td class="comm-num mono">{{ c.resumen.cuadra }}</td>
                <td class="comm-num mono">{{ c.resumen.difiere }}</td>
                <td class="comm-num mono">{{ c.resumen.sin_libro }}</td>
                <td class="mono">{{ c.hasta | date:'dd/MM' }}</td>
              </tr>
            </ng-template>
            <ng-template #expandedrow let-c>
              <tr><td colspan="7">
                <ul class="eb-dias" [attr.aria-label]="'Días de ' + c.alias + ' contra el libro'">
                  @for (d of c.dias; track d.fecha) {
                    <li>
                      <span class="mono eb-strong">{{ d.fecha | date:'dd/MM' }}</span>
                      <span [class]="'eb-v eb-v--' + diaTono(d.veredicto)">{{ diaTexto(d) }}</span>
                      <span class="muted">banco {{ d.movimientos_banco }} · libro {{ d.renglones_libro }}@if (d.fecha_distinta) { · {{ d.fecha_distinta }} con otra fecha en el libro }@if (d.veredicto === 'difiere' && d.cierre_banco !== d.cierre_libro) { · cierra en {{ num(d.cierre_banco) | currency:'MXN':'symbol-narrow':'1.2-2' }} el banco y en {{ num(d.cierre_libro) | currency:'MXN':'symbol-narrow':'1.2-2' }} el libro }</span>
                      @if (d.veredicto === 'difiere') {
                        @for (x of d.solo_banco; track x.id) {
                          <div class="eb-suelto">Sólo en el banco: {{ x.lado }} <span class="mono">{{ x.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> <span class="muted">{{ x.concepto }}</span></div>
                        }
                        @for (x of d.solo_libro; track x.id) {
                          <div class="eb-suelto">Sólo en el libro: {{ x.lado }} <span class="mono">{{ x.importe | currency:'MXN':'symbol-narrow':'1.2-2' }}</span> <span class="muted">{{ x.concepto }}</span></div>
                        }
                      }
                    </li>
                  }
                </ul>
              </td></tr>
            </ng-template>
          </p-table>
          <p class="eb-leyenda"><b>cuadra</b>: cada movimiento del banco tiene su renglón en el libro (mismo lado e importe) y el día cierra con el mismo saldo ·
            <b>abierto</b>: el último día de la descarga puede haberse bajado a medias, no se juzga. Así se decide cuándo una cuenta deja el libro.</p>
        }
        @if (contraError(); as ce) { <p class="eb-leyenda eb-v--bad">{{ ce }}</p> }

        @if (archivos().length) {
          <h4 class="eb-sec">Archivos subidos</h4>
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
                <td class="comm-num mono">{{ f.lines_in_file }}@if (f.lines_in_file > f.lines_new) { <span class="muted"> ({{ f.lines_in_file - f.lines_new }} ya estaban)</span> }</td>
                <td class="comm-num mono">{{ num(f.opening_balance) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td class="comm-num mono eb-strong">{{ num(f.closing_balance) | currency:'MXN':'symbol-narrow':'1.2-2' }}</td>
                <td><p-tag [value]="como(f.account_check).corto" [severity]="como(f.account_check).sev" /></td>
                <td><span class="mono">{{ f.created_at | date:'dd/MM HH:mm' }}</span>@if (f.created_by) {<span class="muted"> · {{ f.created_by }}</span>}</td>
              </tr>
            </ng-template>
          </p-table>
          @if (datos(); as d) { @if (d.total > d.archivos.length) {
            <p class="eb-leyenda">Se muestran los {{ d.archivos.length }} más recientes de {{ d.total }} archivos subidos; el resumen de arriba cuenta todos.</p>
          } }
          <p class="eb-leyenda">Cuenta comprobada: <b>en el archivo</b>, el banco pone el número de cuenta ·
            <b>por saldo</b>, el archivo arranca exactamente donde cerró esa cuenta ·
            <b>sin testigo</b>, no había un saldo anterior con qué comprobarla.</p>
        }
      </app-load-state>
    </section>
  `,
  styles: [BANCOS_STYLES, `
    :host { display: block; }
    .eb-card { margin-bottom: var(--sp-3); }
    .eb-card.fb-tablewrap { padding-bottom: var(--sp-2); }
    .eb-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-3) 0; }
    .eb-title { margin: 0; }
    .eb-sub { margin: var(--sp-1) 0 var(--sp-2); padding: 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .eb-strong { font-weight: 600; color: var(--text-main); }
    .eb-resumen { padding: 0 var(--sp-3) var(--sp-2); }

    /* La franja para soltar: una línea, no un panel. */
    .eb-soltar { display: flex; align-items: center; gap: var(--sp-2); min-height: 44px; margin: 0 var(--sp-3) var(--sp-2);
      padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3); border: 1px dashed var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-sm); color: var(--text-muted); }
    .eb-soltar > span { flex: 1 1 auto; min-width: 0; }
    .eb-soltar.encima { border-style: solid; border-color: var(--action); background: color-mix(in srgb, var(--action) 6%, transparent); color: var(--text-main); }
    .eb-elegir { flex: none; }

    .eb-lote { margin: 0 var(--sp-3) var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .eb-lote-pie { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--border-color); font-size: var(--fs-sm); }
    .eb-nombre { font-size: var(--fs-xs); word-break: break-all; }
    :host ::ng-deep .eb-sel.p-select { min-width: 14rem; font-size: var(--fs-sm); }
    .eb-estado { min-width: 14rem; }
    .eb-v { display: inline-flex; align-items: baseline; gap: var(--sp-1); font-size: var(--fs-sm); font-weight: 600; }
    .eb-v--ok { color: var(--ok-soft-fg); }
    .eb-v--warn { color: var(--warn-soft-fg); }
    .eb-v--bad { color: var(--bad-fg); }
    .eb-v--muted { color: var(--text-muted); font-weight: 400; }
    .eb-acepto { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-main); cursor: pointer; }
    .eb-leyenda { margin: 0; padding: var(--sp-2) var(--sp-3) 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .eb-sec { margin: var(--sp-3) 0 var(--sp-1); padding: 0 var(--sp-3); font-size: var(--fs-sm); font-weight: 600; color: var(--text-main); }
    .eb-tog { width: 2.5rem; }
    .eb-dias { list-style: none; margin: 0; padding: var(--sp-1) 0; display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
    .eb-dias > li { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-1) var(--sp-3); }
    .eb-suelto { flex-basis: 100%; padding-left: var(--sp-5); font-size: var(--fs-xs); color: var(--text-main); }

    @media (max-width: 40rem) {
      .eb-soltar { flex-wrap: wrap; }
    }
  `],
})
export class BancosEstadoBancoComponent implements OnInit {
  private readonly api = inject(BankService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  /** Se guardó al menos un archivo: la pantalla refresca el número de la pestaña y el aviso del Cierre. */
  readonly guardado = output<void>();

  readonly puedeSubir = computed(() => this.auth.user()?.permissions?.[Permission.FINANCE_BANK_GESTIONAR] === true);

  readonly datos = signal<ArchivosDelBanco | null>(null);
  readonly archivos = computed(() => this.datos()?.archivos ?? []);
  /** Cuentas activas cuyo banco no tiene lector (hoy Banamex): no cuentan como «faltan». */
  readonly sinLector = computed(() => (this.datos()?.cuentas ?? []).filter((c) => !c.con_lector).map((c) => c.alias));
  readonly cargando = signal(true);
  readonly error = signal<string | null>(null);

  /** [CB.60] Cada cuenta con descarga contra el libro. Lo que difiere va primero. */
  readonly contra = signal<ContraElLibro | null>(null);
  readonly contraError = signal<string | null>(null);
  readonly cuentasContra = computed(() => [...(this.contra()?.cuentas ?? [])]
    .sort((a, b) => b.resumen.difiere - a.resumen.difiere || a.alias.localeCompare(b.alias)));

  readonly lote = signal<ArchivoEnLote[]>([]);
  readonly encima = signal(false);
  readonly guardando = signal(false);
  readonly leyendo = computed(() => this.lote().some((a) => a.estado === 'leyendo'));
  readonly listos = computed(() => this.lote().filter((a) => this.veredicto(a).listo));
  private siguienteId = 1;

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
      ...this.itemContra(),
      { label: 'Sin testigo', value: sinTestigo, format: 'number', tone: sinTestigo ? 'warn' : 'muted', sub: 'archivos guardados sin poder comprobar la cuenta' },
    ];
  });

  readonly resumenLote = computed(() => {
    const l = this.lote();
    const pendientes = l.filter((a) => a.estado === 'leido' && !this.veredicto(a).listo && !a.revision?.ya_subido).length;
    const partes = [`${this.listos().length} de ${l.length} listos`];
    if (pendientes) partes.push(`${pendientes} piden algo`);
    return partes.join(' · ');
  });
  readonly textoGuardar = computed(() => {
    const n = this.listos().length;
    return n === 1 ? 'Guardar 1 listo' : `Guardar ${n} listos`;
  });

  ngOnInit(): void { this.cargar(); }

  cargar(): void {
    this.cargando.set(true);
    this.error.set(null);
    this.api.archivosDelBanco().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => { this.datos.set(d); this.cargando.set(false); },
      error: (e: HttpErrorResponse) => { this.error.set(this.mensaje(e, 'No se pudo leer la lista de estados de cuenta subidos.')); this.cargando.set(false); },
    });
    this.contraError.set(null);
    this.api.contraElLibro().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (c) => this.contra.set(c),
      // Si la comparación no se pudo leer se DICE; no se pinta como «cuadra» ni como cero.
      error: (e: HttpErrorResponse) => { this.contra.set(null); this.contraError.set(this.mensaje(e, 'No se pudo comparar la descarga contra el libro.')); },
    });
  }

  /** El renglón del resumen: cuántas cuentas cuadran con el libro y cuáles difieren. Sin comparación, no se afirma nada. */
  private itemContra(): MetricStripItem[] {
    const cuentas = this.contra()?.cuentas ?? [];
    const juzgadas = cuentas.filter((c) => c.resumen.cuadra + c.resumen.difiere > 0);
    if (!juzgadas.length) return [];
    const difieren = juzgadas.filter((c) => c.resumen.difiere).map((c) => c.alias);
    return [{ label: 'Cuadran con el libro', value: `${juzgadas.length - difieren.length} de ${juzgadas.length}`, format: 'text', tone: difieren.length ? 'bad' : 'ok',
      sub: difieren.length ? `difieren ${difieren.join(', ')}` : 'cuentas con días cerrados para comparar' }];
  }

  estadoContra(c: CuentaContraElLibro): { tono: Veredicto['tono']; icono: string; texto: string } {
    const r = c.resumen;
    if (r.difiere) return { tono: 'bad', icono: 'pi-times-circle', texto: r.difiere === 1 ? 'difiere en 1 día' : `difiere en ${r.difiere} días` };
    if (r.cuadra) return { tono: 'ok', icono: 'pi-check-circle', texto: r.cuadra === 1 ? 'cuadra 1 día' : `cuadra ${r.cuadra} días` };
    if (r.sin_libro) return { tono: 'muted', icono: 'pi-minus-circle', texto: 'el libro no llega a esos días' };
    return { tono: 'muted', icono: 'pi-minus-circle', texto: 'sin días cerrados todavía' };
  }

  diaTono(v: VeredictoDelDia): Veredicto['tono'] {
    return v === 'cuadra' ? 'ok' : v === 'difiere' ? 'bad' : 'muted';
  }

  diaTexto(d: DiaContraElLibro): string {
    switch (d.veredicto) {
      case 'cuadra': return 'cuadra';
      case 'difiere': return `difiere: ${d.solo_banco.length} sólo en el banco, ${d.solo_libro.length} sólo en el libro`;
      case 'sin_libro': return 'el libro no tiene ese día';
      default: return `abierto (no se juzga)${d.solo_banco.length ? ` · ${d.solo_banco.length} del banco aún sin renglón en el libro` : ''}`;
    }
  }

  /** El veredicto de una fila: lo que la persona tiene que saber o hacer, y si está lista para guardar. */
  veredicto(a: ArchivoEnLote): Veredicto {
    const r = a.revision;
    if (a.estado === 'leyendo') return { tono: 'muted', icono: 'pi-spin pi-spinner', texto: 'Leyendo…', listo: false };
    if (a.estado === 'guardando') return { tono: 'muted', icono: 'pi-spin pi-spinner', texto: 'Guardando…', listo: false };
    if (a.error) return { tono: 'bad', icono: 'pi-times-circle', texto: a.error, listo: false };
    if (!r) return { tono: 'muted', icono: 'pi-minus', texto: '—', listo: false };
    if (r.ya_subido) return { tono: 'muted', icono: 'pi-info-circle', texto: `Ya se subió el ${this.fechaHora(r.ya_subido.subido_el)}`, listo: false };
    if (!r.puede_confirmar) {
      const elegir = r.motivos_bloqueo.length === 1 && /elige la cuenta/.test(r.motivos_bloqueo[0]);
      return elegir ? { tono: 'warn', icono: 'pi-arrow-left', texto: 'Elige la cuenta', listo: false }
        : { tono: 'bad', icono: 'pi-times-circle', texto: 'No se puede: ' + r.motivos_bloqueo.join('; '), listo: false };
    }
    if (r.como_se_fijo === 'sin_testigo') {
      return a.aceptado ? { tono: 'warn', icono: 'pi-exclamation-triangle', texto: 'Listo, sin comprobar', listo: true }
        : { tono: 'warn', icono: 'pi-exclamation-triangle', texto: 'Ningún saldo lo comprueba', listo: false };
    }
    return { tono: 'ok', icono: 'pi-check-circle', texto: r.nuevos ? `Listo: ${r.nuevos} nuevos` : 'Listo: nada nuevo, sólo se registra', listo: true };
  }

  /** Un archivo soltado FUERA de la tarjeta no debe abrirse en el navegador y sacar a la persona de la pantalla. */
  @HostListener('window:dragover', ['$event'])
  @HostListener('window:drop', ['$event'])
  noAbrirFuera(ev: DragEvent): void {
    if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
  }

  alArrastrar(ev: DragEvent): void {
    if (!this.puedeSubir() || !ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    this.encima.set(true);
  }

  alSoltar(ev: DragEvent): void {
    if (!this.puedeSubir()) return;
    ev.preventDefault();
    this.encima.set(false);
    void this.leerArchivos(Array.from(ev.dataTransfer?.files ?? []));
  }

  alElegir(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    void this.leerArchivos(files);
  }

  private async leerArchivos(files: File[]): Promise<void> {
    const leidos = await Promise.all(files.map((f) => new Promise<{ nombre: string; b64: string } | null>((res) => {
      const r = new FileReader();
      r.onload = () => res({ nombre: f.name, b64: String(r.result || '') });
      r.onerror = () => { this.falla(`No se pudo leer ${f.name}.`); res(null); };
      r.readAsDataURL(f);
    })));
    await this.agregarArchivos(leidos.filter((x): x is { nombre: string; b64: string } => !!x));
  }

  /** Agrega archivos al lote y los revisa uno por uno (en el servidor, sin guardar). */
  async agregarArchivos(archivos: { nombre: string; b64: string }[]): Promise<void> {
    const nuevos: ArchivoEnLote[] = archivos.map((x) => ({ id: this.siguienteId++, nombre: x.nombre, b64: x.b64, estado: 'leyendo', revision: null, cuentaElegida: null, aceptado: false, error: null }));
    this.lote.update((l) => [...l, ...nuevos]);
    for (const a of nuevos) await this.revisar(a.id, true);
  }

  /** La primera vez, si UNA cuenta coincide por saldo, la elige sola. */
  private async revisar(id: number, primera: boolean): Promise<void> {
    const a = this.lote().find((x) => x.id === id);
    if (!a) return;
    this.cambiar(id, { estado: 'leyendo', error: null });
    try {
      let r = await firstValueFrom(this.api.revisarEstadoBanco(a.b64, a.nombre, a.cuentaElegida));
      const coinciden = r.candidatas.filter((c) => c.coincide);
      if (primera && !r.cuenta && coinciden.length === 1) {
        r = await firstValueFrom(this.api.revisarEstadoBanco(a.b64, a.nombre, coinciden[0].id));
      }
      this.cambiar(id, { estado: 'leido', revision: r, cuentaElegida: r.como_se_fijo === 'en_archivo' ? null : (r.cuenta?.id ?? null) });
    } catch (e) {
      this.cambiar(id, { estado: 'error', error: this.mensaje(e as HttpErrorResponse, 'No se pudo leer el archivo.') });
    }
  }

  elegirCuenta(a: ArchivoEnLote, id: string | null): void {
    this.cambiar(a.id, { cuentaElegida: id, aceptado: false });
    void this.revisar(a.id, false);
  }

  aceptar(a: ArchivoEnLote, v: boolean): void { this.cambiar(a.id, { aceptado: v }); }

  quitar(a: ArchivoEnLote): void { this.lote.update((l) => l.filter((x) => x.id !== a.id)); }

  /** Guarda los listos uno por uno; los que fallan se quedan en el lote con su motivo. */
  async guardar(): Promise<void> {
    const listos = this.listos();
    if (!listos.length || this.guardando()) return;
    this.guardando.set(true);
    let ok = 0;
    let fallaron = 0;
    for (const a of listos) {
      this.cambiar(a.id, { estado: 'guardando' });
      try {
        await firstValueFrom(this.api.confirmarEstadoBanco(a.b64, a.nombre, a.cuentaElegida, a.aceptado));
        ok++;
        this.quitar(a);
      } catch (e) {
        fallaron++;
        const err = e as HttpErrorResponse;
        const motivos: string[] | undefined = err?.error?.motivos;
        this.cambiar(a.id, { estado: 'leido', error: motivos?.length ? 'No se guardó: ' + motivos.join('; ') : this.mensaje(err, 'No se pudo guardar.') });
      }
    }
    this.guardando.set(false);
    this.toast.add({
      severity: fallaron ? 'warn' : 'success', summary: 'Estados de cuenta', life: 5000,
      detail: fallaron ? `${ok} guardado(s) · ${fallaron} sin guardar: siguen en la lista con su motivo.` : `${ok} guardado(s).`,
    });
    if (ok) { this.cargar(); this.guardado.emit(); }
  }

  opciones(r: RevisionEstadoBanco) {
    return r.candidatas.map((c) => ({
      value: c.id,
      label: c.coincide ? `${c.alias} · su saldo coincide`
        : c.saldo_conocido === null ? `${c.alias} · sin saldo anterior` : `${c.alias} · cerró en ${this.pesos(c.saldo_conocido)}`,
    }));
  }
  banco(b: RevisionEstadoBanco['banco']): string { return BANCO[b] ?? b; }
  como(c: ComoSeFijoLaCuenta) { return COMO[c] ?? COMO.sin_testigo; }
  /** Los numeric de Postgres llegan como string por JSON. */
  num(v: number | string | null | undefined): number | null { return v === null || v === undefined ? null : Number(v); }

  private cambiar(id: number, p: Partial<ArchivoEnLote>): void {
    this.lote.update((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }
  private fecha(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y.slice(2)}`;
  }
  private fechaHora(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
