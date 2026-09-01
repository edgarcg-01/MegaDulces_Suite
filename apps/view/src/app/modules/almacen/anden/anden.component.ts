import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ErpOrderMatch, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { BinLocationService } from '../bin-location.service';
import { AndenState, AndenLinea, Seccion } from './anden.state';
import { AndenDraftService } from './anden-draft.service';
import { AndenFolioComponent } from './components/anden-folio.component';
import { AndenLlegadaComponent } from './components/anden-llegada.component';
import { AndenSegmentedComponent, SegItem } from './components/anden-segmented.component';
import { AndenCaducidadComponent, FechadoConfirmado } from './components/anden-caducidad.component';
import { AndenUbicacionComponent, UbicadoConfirmado } from './components/anden-ubicacion.component';
import { ScanFieldComponent } from './components/scan-field.component';
import { Buscable, coincide, normalizar } from './filtro.util';

/**
 * **Andén de Entrada** — reemplaza el recorrido de cuatro pantallas de la sección
 * Entrada por una sola pasada junto al camión.
 *
 * **Dos puertas con dos relojes, y la segunda partida en dos colas hermanas:**
 *
 *  - **Llegada** corre contra el chofer: folio del papel, cotejo contra Kepler,
 *    acceso. La mercancía entra en lote `NA` y el camión se va. Nada lento acá.
 *  - **Caducidad** y **Ubicación** corren contra el anaquel, en paralelo. Son
 *    **secciones, no pasos**: las puede trabajar gente distinta en momentos
 *    distintos, que es exactamente como pasa en la bodega.
 *
 * La sección activa **no vive en la ruta**: es estado de pantalla. El vale es el
 * contexto y sobrevive al salto; en la URL, el back del navegador rompería el
 * flujo a media captura.
 *
 * **El borrador se persiste en cada cambio.** Un handheld se queda sin batería o
 * Android mata la app en segundo plano; volver a entrar tiene que devolver el
 * vale donde estaba, no obligar a re-contar con el camión enfrente.
 */
@Component({
  selector: 'app-anden',
  standalone: true,
  imports: [
    DecimalPipe, ButtonModule, ToastModule,
    AndenFolioComponent, AndenLlegadaComponent, AndenSegmentedComponent,
    AndenCaducidadComponent, AndenUbicacionComponent, ScanFieldComponent,
  ],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="an">
      <p-toast />

      <header class="an-hd">
        <div class="an-id">
          <span class="an-fol">{{ s.abierto() ? s.vale()!.folio : '—' }}</span>
          <span class="an-prov">{{ s.proveedor() }}</span>
        </div>
        <div class="an-pills">
          <span class="an-pill" [class.an-on]="s.acceso()">{{ s.estado() }}</span>
          @if (s.guardado()) { <span class="an-save">Guardado ✓</span> }
        </div>
      </header>

      @if (s.abierto()) {
        <app-anden-segmented [items]="segmentos()" [activa]="s.seccion()" (elegir)="irA($event)" />
      }

      <main class="an-bd">
        @switch (s.seccion()) {

          @case ('llegada') {
            @if (!s.abierto()) {
              <app-anden-folio
                [folio]="s.folio()" [buscando]="s.buscando()" [candidatos]="s.candidatos()"
                (folioChange)="s.folio.set($event)" (buscar)="buscar()" (elegir)="abrirVale($event)" />
            } @else if (s.acceso()) {
              <div class="an-fin">
                <div class="an-big">✓</div>
                <h2>Acceso dado</h2>
                <p>
                  {{ s.unidades() | number }} piezas entraron en lote <b>NA</b>. El chofer se puede ir.
                  Quedan <b>{{ s.pendientesFechar().length }}</b> por fechar y
                  <b>{{ s.pendientesUbicar().length }}</b> por ubicar.
                </p>
                @if (s.pendientesFechar().length) {
                  <button pButton type="button" [outlined]="true" (click)="irA('caducidad')">Ir a Caducidad →</button>
                }
                <button pButton type="button" [text]="true" severity="secondary" (click)="otroCamion()">
                  Recibir otro camión
                </button>
              </div>
            } @else {
              @if (!s.capturando()) {
                <app-scan-field
                  [valor]="consulta()" [visibles]="visLlegada().length" [total]="s.lineas().length"
                  [refocoTick]="refoco()"
                  etiqueta="Escanear o buscar en Llegada"
                  placeholder="Escaneá la caja o buscá por nombre"
                  (valorChange)="consulta.set($event)" (enter)="enter()"
                  (sinCamara)="avisarCamara($event)" />
              }
              @if (sinCoincidencias(visLlegada())) {
                <p class="an-vacio">
                  Nada en este vale coincide con <b>«{{ consulta() }}»</b>. Si el producto llegó
                  igual, no lo fuerces contra otro renglón: hay que agregarlo como renglón nuevo.
                </p>
              }
              <app-anden-llegada
                [lineas]="visLlegada()" [contadas]="s.contadas()" [unidades]="s.unidades()"
                [diferencias]="s.diferencias()" [listo]="s.cotejoListo()"
                [siguiente]="s.siguienteCotejar()" [capturando]="s.capturando()"
                [guardando]="s.guardando()"
                (abrir)="abrirCaptura($event)" (cerrarCaptura)="cerrarCaptura()"
                (contar)="contar($event.linea, $event.cantidad)" (darAcceso)="darAcceso()" />
            }
          }

          @case ('caducidad') {
            @if (s.actual(); as l) {
              <app-anden-caducidad #fechar
                [linea]="l" [minShelfLife]="minShelfLife()" [existingMinExpiry]="existingMinExpiry()"
                [guardando]="s.guardando()"
                (pedirOcr)="correrOcr($event)" (confirmar)="confirmarFechado($event)"
                (volver)="volverALista()" />
            } @else if (!s.pendientesFechar().length) {
              <div class="an-fin">
                <div class="an-big">✓</div>
                <h2>Todo fechado</h2>
                <p>
                  Las {{ s.lineas().length }} líneas tienen lote y caducidad.
                  @if (s.pendientesUbicar().length) {
                    Quedan <b>{{ s.pendientesUbicar().length }}</b> por ubicar.
                  } @else { Nada pendiente en Ubicación tampoco. }
                </p>
                @if (s.pendientesUbicar().length) {
                  <button pButton type="button" [outlined]="true" (click)="irA('ubicacion')">Ir a Ubicación →</button>
                }
              </div>
            } @else {
              <p class="an-nota">
                Estas líneas entraron en lote <b>NA</b>, sin fecha. Mientras sigan así, el vale no cierra.
              </p>
              <app-scan-field
                [valor]="consulta()" [visibles]="visFechar().length" [total]="s.pendientesFechar().length"
                [refocoTick]="refoco()"
                etiqueta="Escanear o buscar en Caducidad"
                placeholder="Escaneá la caja o buscá por nombre"
                (valorChange)="consulta.set($event)" (enter)="enter()"
                (sinCamara)="avisarCamara($event)" />
              @if (sinCoincidencias(visFechar())) {
                <p class="an-vacio">
                  Nada por fechar coincide con <b>«{{ consulta() }}»</b>. Puede que ya esté fechado
                  o que sea de otro vale.
                </p>
              }
              <ul class="an-lista">
                @for (l of visFechar(); track l.id) {
                  <li><button type="button" class="an-row" (click)="abrirFechar(l)">
                    <span class="an-row-nm">{{ nombre(l) }}</span>
                    <span class="an-row-sk">sin fecha · lote NA</span>
                    <span class="an-row-qt">{{ l.faltaFechar | number }}</span>
                  </button></li>
                }
              </ul>
            }
          }

          @case ('ubicacion') {
            @if (s.actual(); as l) {
              <app-anden-ubicacion #ubicar
                [linea]="l" [guardando]="s.guardando()"
                (confirmar)="confirmarUbicado($event)" (volver)="volverALista()"
                (sinCamara)="avisarCamara($event)" />
            } @else if (!s.pendientesUbicar().length) {
              <div class="an-fin">
                <div class="an-big">✓</div>
                <h2>Todo acomodado</h2>
                <p>
                  @if (s.pendientesFechar().length) {
                    Quedan <b>{{ s.pendientesFechar().length }}</b> por fechar antes de cerrar el vale.
                  } @else { Vale cerrado: cero pendientes en las tres secciones. }
                </p>
              </div>
            } @else {
              <p class="an-nota">
                Mercancía en existencia que todavía no tiene rack. El surtidor no la encuentra.
              </p>
              <!-- Acá la barra también busca por rack: teclear R04 deja a la vista todo lo que
                   va a ese pasillo, y el bodeguero camina una sola vez en vez de cuatro. -->
              <app-scan-field
                [valor]="consulta()" [visibles]="visUbicar().length" [total]="s.pendientesUbicar().length"
                [refocoTick]="refoco()"
                etiqueta="Escanear o buscar en Ubicación"
                placeholder="Escaneá la caja, o buscá por nombre o rack"
                (valorChange)="consulta.set($event)" (enter)="enter()"
                (sinCamara)="avisarCamara($event)" />
              @if (sinCoincidencias(visUbicar())) {
                <p class="an-vacio">
                  Nada por ubicar coincide con <b>«{{ consulta() }}»</b>. Si buscaste por rack,
                  puede que ese pasillo ya esté acomodado.
                </p>
              }
              <ul class="an-lista">
                @for (l of visUbicar(); track l.id) {
                  <li><button type="button" class="an-row" (click)="abrirUbicar(l)">
                    <span class="an-row-nm">{{ nombre(l) }}</span>
                    <span class="an-row-sk">{{ l.binSugerido ? 'sugerido ' + l.binSugerido : 'sin ubicación previa' }}</span>
                    <span class="an-row-qt">{{ l.contado | number }}</span>
                  </button></li>
                }
              </ul>
            }
          }
        }
      </main>
    </div>
  `,
  styles: [`
    /* Los colores salen SIEMPRE del token, nunca de un hex: la paleta clara vive
       en tokens.css y el bloque oscuro sólo redefine los mismos nombres. Un color
       declarado únicamente para un tema pinta texto de un tema sobre el fondo del
       otro, y eso no se ve hasta que alguien cambia el tema en producción. */
    :host { display: block; min-height: 100dvh; background: var(--surface-layout, var(--surface-ground)); }
    .an { max-width: min(560px, 100vw); margin: 0 auto; padding: var(--sp-3) var(--sp-3) var(--sp-8); }
    .an-hd {
      display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3);
      padding-bottom: var(--sp-2);
    }
    .an-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .an-fol { font-size: var(--fs-h3); font-weight: var(--fw-bold); font-variant-numeric: tabular-nums; }
    .an-prov { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; }
    .an-pills { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
    .an-pill {
      font-size: var(--fs-micro); font-weight: var(--fw-bold); letter-spacing: .07em; text-transform: uppercase;
      padding: 3px 8px; border-radius: var(--r-pill);
      background: var(--info-soft-bg, var(--surface-ground)); color: var(--info-fg, var(--text-muted));
    }
    .an-on { background: var(--good-soft-bg, var(--surface-ground)); color: var(--good-fg, var(--text-main)); }
    .an-save { font-size: var(--fs-micro); color: var(--text-faint); }
    .an-bd { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
    .an-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .an-nota b { color: var(--text-main); }
    /* El vacío por filtro dice qué hacer. "Sin resultados" a secas deja al
       bodeguero parado con el producto en la mano y sin salida. */
    .an-vacio {
      margin: 0; padding: var(--sp-3);
      background: var(--warn-soft-bg, var(--card-bg));
      border: 1px dashed var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45;
    }
    .an-vacio b { color: var(--text-main); }
    .an-lista { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
    .an-row {
      display: grid; grid-template-columns: 1fr auto; gap: 2px var(--sp-3); align-items: center;
      width: 100%; min-height: 52px; padding: var(--sp-2) var(--sp-3); text-align: left; cursor: pointer;
      background: var(--card-bg); color: var(--text-main);
      border: 1px solid var(--border-color); border-radius: var(--r-md); font: inherit;
    }
    .an-row:hover { border-color: var(--action); }
    .an-row-nm { font-size: var(--fs-sm); font-weight: var(--fw-medium); min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .an-row-sk { font-size: var(--fs-micro); color: var(--text-faint); grid-column: 1; }
    .an-row-qt { grid-column: 2; grid-row: 1 / 3; align-self: center; font-weight: var(--fw-bold);
      font-variant-numeric: tabular-nums; }
    .an-fin { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2);
      text-align: center; padding: var(--sp-8) var(--sp-3); }
    .an-big { font-size: 48px; font-weight: var(--fw-black); line-height: 1; color: var(--good-fg, var(--action)); }
    .an-fin h2 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); }
    .an-fin p { margin: 0 0 var(--sp-2); max-width: 30ch; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class AndenComponent implements OnInit {
  private readonly sessions = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly bins = inject(BinLocationService);
  private readonly drafts = inject(AndenDraftService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly s = new AndenState();
  readonly minShelfLife = signal<number | null>(null);
  readonly existingMinExpiry = signal<string | null>(null);

  /**
   * Lo tecleado o disparado en la barra única. **Una sola por sección**, y la
   * misma para escanear y para buscar: dos campos peleándose el foco es lo que
   * rompe una pistola en modo wedge.
   */
  readonly consulta = signal('');
  /** Se incrementa para devolverle el foco a la barra tras guardar o cerrar panel. */
  readonly refoco = signal(0);

  private readonly fechar = viewChild<AndenCaducidadComponent>('fechar');
  private readonly ubicar = viewChild<AndenUbicacionComponent>('ubicar');

  /** `scan_uuid` ya enviados: reenviar tras recuperar el borrador no duplica. */
  private scans: string[] = [];

  readonly segmentos = computed<SegItem[]>(() => {
    const abierto = this.s.abierto();
    const acceso = this.s.acceso();
    return [
      { key: 'llegada', label: 'Llegada', on: true,
        pend: abierto && !acceso ? this.s.porCotejar() : 0, done: acceso },
      { key: 'caducidad', label: 'Caducidad', on: acceso,
        pend: this.s.pendientesFechar().length, done: acceso && !this.s.pendientesFechar().length },
      { key: 'ubicacion', label: 'Ubicación', on: acceso,
        pend: this.s.pendientesUbicar().length, done: acceso && !this.s.pendientesUbicar().length },
    ];
  });

  ngOnInit(): void {
    // Si este equipo dejó un vale a medias, se retoma donde estaba. Es la razón
    // de existir del borrador: el bodeguero no vuelve a contar la tarima.
    this.drafts.ultimoAbierto().then((b) => {
      if (!b) return;
      this.scans = b.scans || [];
      this.sessions.detail(b.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (v) => {
          this.s.cargarDesdeVale(v);
          // El server manda: el borrador sólo repone lo que el server no sabe.
          this.s.aplicarBorrador(b);
          this.s.guardado.set(true);
          this.toast.add({ severity: 'info', summary: 'Vale recuperado', detail: `${v.folio} — seguí donde lo dejaste.` });
        },
        error: () => this.drafts.borrar(b.sessionId),
      });
    });
  }

  nombre(l: AndenLinea): string {
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  }

  // ── Barra única ───────────────────────────────────────────────────────────

  /** Qué campos de la línea ve la barra. El rack sólo importa en Ubicación. */
  private buscable(l: AndenLinea): Buscable {
    return {
      nombre: this.nombre(l),
      sku: l.sku || l.expected_sku,
      barcode: l.barcode_scanned,
      rack: l.ubicado || l.binSugerido,
    };
  }

  private aplicarFiltro(ls: AndenLinea[]): AndenLinea[] {
    const q = this.consulta();
    if (!normalizar(q)) return ls;
    return ls.filter((l) => coincide(this.buscable(l), q));
  }

  readonly visLlegada = computed(() => this.aplicarFiltro(this.s.lineas()));
  readonly visFechar = computed(() => this.aplicarFiltro(this.s.pendientesFechar()));
  readonly visUbicar = computed(() => this.aplicarFiltro(this.s.pendientesUbicar()));

  /** Vacío por filtro (hay que decir algo) vs. vacío real (ya hay otra pantalla). */
  sinCoincidencias(vis: AndenLinea[]): boolean {
    return !!normalizar(this.consulta()) && !vis.length;
  }

  /**
   * Enter, tanto del disparo de la pistola como del teclado. **Una sola
   * coincidencia abre ese renglón**: apuntar y disparar es el gesto completo.
   * Con varias no se adivina — se deja el filtro puesto y el operario elige.
   */
  enter(): void {
    if (!normalizar(this.consulta())) return;
    switch (this.s.seccion()) {
      case 'llegada': {
        const vis = this.visLlegada();
        if (vis.length === 1) this.abrirCaptura(vis[0]);
        break;
      }
      case 'caducidad': {
        const vis = this.visFechar();
        if (vis.length === 1) this.abrirFechar(vis[0]);
        break;
      }
      case 'ubicacion': {
        const vis = this.visUbicar();
        if (vis.length === 1) this.abrirUbicar(vis[0]);
        break;
      }
    }
  }

  /** La cámara no abrió: se dice por qué, no se deja un botón mudo. */
  avisarCamara(motivo: string): void {
    this.toast.add({ severity: 'warn', summary: 'Cámara', detail: motivo });
  }

  /** Al abrir un renglón la consulta ya cumplió: se limpia para el siguiente. */
  private limpiarBarra(): void {
    this.consulta.set('');
  }

  /** Al volver a la lista, el foco vuelve a la barra sin que nadie la toque. */
  private volverALaBarra(): void {
    this.limpiarBarra();
    this.refoco.update((n) => n + 1);
  }

  private guardarBorrador(): void {
    const b = this.s.aBorrador(this.scans);
    if (!b) return;
    this.drafts.guardar(b).then((ok) => this.s.guardado.set(ok));
  }

  irA(sec: Seccion): void {
    this.s.seccion.set(sec);
    this.s.actual.set(null);
    this.s.capturando.set(null);
    this.volverALaBarra();
    if (sec === 'caducidad') this.siguienteFechar();
    if (sec === 'ubicacion') this.siguienteUbicar();
    this.guardarBorrador();
  }

  // ── Llegada ───────────────────────────────────────────────────────────────

  buscar(): void {
    const folio = this.s.folio().trim();
    if (!folio) return;
    this.s.buscando.set(true);
    this.sessions.searchErpOrders(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ms) => {
        this.s.buscando.set(false);
        this.s.candidatos.set(ms || []);
        if (!ms?.length) {
          this.toast.add({ severity: 'warn', summary: 'Sin resultados', detail: `Kepler no tiene el vale ${folio}.` });
          return;
        }
        if (ms.length === 1) this.abrirVale(ms[0]);
      },
      error: (e) => {
        this.s.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo buscar el vale' });
      },
    });
  }

  abrirVale(m: ErpOrderMatch): void {
    this.s.erp.set(m);
    this.s.cargando.set(true);
    // El almacén NO se manda: lo deriva el backend del mapa sucursal→almacén.
    this.sessions.open({ source_kind: 'erp_receipt', erp_sucursal: m.sucursal, erp_folio: m.folio })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (v) => this.cargarDetalle(v.id),
        error: (e) => {
          this.s.cargando.set(false);
          const dup = /ya.*recib/i.test(e?.error?.message || '');
          this.toast.add({
            severity: dup ? 'warn' : 'error',
            summary: dup ? 'Ese folio ya tiene vale' : 'Error',
            detail: e?.error?.message || 'No se pudo abrir el vale',
          });
        },
      });
  }

  private cargarDetalle(id: string, tras?: () => void): void {
    this.sessions.detail(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => {
        this.s.cargando.set(false);
        this.s.cargarDesdeVale(v);
        this.guardarBorrador();
        tras?.();
      },
      error: (e) => {
        this.s.cargando.set(false);
        // No tragarse la falla: un vale vacío y un 500 se ven igual en pantalla.
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el vale' });
      },
    });
  }

  abrirCaptura(l: AndenLinea): void {
    this.s.capturando.set(l);
    this.limpiarBarra();
  }

  contar(l: AndenLinea, cantidad: number): void {
    const v = this.s.vale();
    if (!v) return;
    this.s.guardando.set(true);
    this.scans.push(this.nuevoScanId());
    this.sessions.setLine(v.id, l.id, { received_qty: cantidad })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (upd) => {
          this.s.guardando.set(false);
          this.s.capturando.set(null);
          this.volverALaBarra();
          this.s.cargarDesdeVale(upd);
          this.guardarBorrador();
          const esp = Number(l.expected_qty) || 0;
          this.toast.add(cantidad === esp
            ? { severity: 'success', summary: 'Cotejado', detail: `${this.nombre(l)} — ${cantidad} pz, cuadra con Kepler.` }
            : { severity: 'warn', summary: cantidad < esp ? 'Faltante' : 'Sobrante',
                detail: `Kepler mandó ${esp} y contaste ${cantidad}. El proveedor lo va a ver en su scorecard.` });
        },
        error: (e) => {
          this.s.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar la cantidad' });
        },
      });
  }

  darAcceso(): void {
    const v = this.s.vale();
    if (!v) return;
    this.s.guardando.set(true);
    this.sessions.close(v.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => {
        this.s.guardando.set(false);
        this.s.cargarDesdeVale(upd);
        this.s.acceso.set(true);
        this.guardarBorrador();
        this.toast.add({ severity: 'success', summary: 'Acceso dado',
          detail: 'La mercancía entró en lote NA. El camión se puede ir.' });
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo dar acceso', detail: e?.error?.message || 'Error' });
      },
    });
  }

  // ── Caducidad ─────────────────────────────────────────────────────────────

  abrirFechar(l: AndenLinea): void {
    this.s.actual.set(l);
    this.limpiarBarra();
    this.cargarContexto(l);
    setTimeout(() => this.fechar()?.limpiar(), 0);
  }

  private siguienteFechar(): void {
    const l = this.s.siguienteFechar();
    if (l) this.abrirFechar(l);
  }

  /**
   * Contexto del semáforo. La caducidad más próxima ya en stock se deriva de
   * `pick-suggestion` (que ordena por caducidad). La vida útil mínima **no** se
   * calcula acá: `resolvePolicy()` sigue privado y duplicar la cascada
   * producto→departamento→proveedor la desincronizaría del backend.
   */
  private cargarContexto(l: AndenLinea): void {
    this.minShelfLife.set(null);
    this.existingMinExpiry.set(null);
    const wh = this.s.warehouseId();
    if (!wh || !l.product_id) return;
    this.bins.pickSuggestion(wh, l.product_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ss) => {
        const fechas = (ss || []).map((x) => x.expiry_date).filter((d): d is string => !!d).sort();
        this.existingMinExpiry.set(fechas[0] ?? null);
        const bin = (ss || []).find((x) => x.bin_code)?.bin_code ?? null;
        if (bin) this.s.parchear(l.id, { binSugerido: bin });
      },
      error: () => { /* sin sugerencia: el semáforo muestra sólo los días */ },
    });
  }

  correrOcr(dataUri: string): void {
    this.auditor.ocr(dataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.fechar()?.aplicarOcr(r),
      error: () => {
        this.fechar()?.ocrFallo();
        this.toast.add({ severity: 'warn', summary: 'OCR', detail: 'No se distinguió lote/caducidad. Capturalo a mano.' });
      },
    });
  }

  confirmarFechado(f: FechadoConfirmado): void {
    const v = this.s.vale();
    const wh = this.s.warehouseId();
    if (!v || !wh || !f.linea.product_id) return;
    this.s.guardando.set(true);
    this.auditor.evaluate({
      warehouse_id: wh,
      product_id: f.linea.product_id,
      supplier_code: v.supplier_code || undefined,
      source_ref: v.folio,
      receiving_line_id: f.linea.id,
      quantity: f.cantidad,
      confirmed_lot: f.lote,
      confirmed_expiry: f.caducidadIso,
      photo_data_uri: f.fotoDataUri || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cap) => {
        this.s.guardando.set(false);
        this.toast.add(cap.verdict === 'red'
          ? { severity: 'error', summary: 'Retenida',
              detail: 'Fechada, pero 🔴: un supervisor tiene que liberarla antes de cerrar el vale.' }
          : { severity: 'success', summary: 'Fechada',
              detail: `${this.nombre(f.linea)} — lote ${f.lote}.` });
        // Recarga y encadena al siguiente pendiente: sin volver a la lista.
        this.cargarDetalle(v.id, () => {
          this.s.actual.set(null);
          this.volverALaBarra();
          this.siguienteFechar();
        });
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo fechar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  // ── Ubicación ─────────────────────────────────────────────────────────────

  abrirUbicar(l: AndenLinea): void {
    this.s.actual.set(l);
    this.limpiarBarra();
    if (!l.binSugerido) this.cargarContexto(l);
  }

  private siguienteUbicar(): void {
    const l = this.s.siguienteUbicar();
    if (l) this.abrirUbicar(l);
  }

  confirmarUbicado(u: UbicadoConfirmado): void {
    const wh = this.s.warehouseId();
    const productId = u.linea.product_id;
    if (!wh || !productId) return;
    this.s.guardando.set(true);
    this.bins.putAway({
      warehouse_id: wh,
      product_id: productId,
      bin_code: u.binCode,
      quantity: u.cantidad,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.s.guardando.set(false);
        this.s.parchear(u.linea.id, { ubicado: u.binCode });
        this.guardarBorrador();
        this.toast.add({ severity: 'success', summary: 'Acomodado',
          detail: `${this.nombre(u.linea)} — en ${u.binCode}.` });
        this.s.actual.set(null);
        this.volverALaBarra();
        this.siguienteUbicar();
        setTimeout(() => this.ubicar()?.enfocar(), 0);
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo acomodar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  /** Cerrar el panel sin guardar también devuelve el foco a la barra. */
  cerrarCaptura(): void {
    this.s.capturando.set(null);
    this.volverALaBarra();
  }

  volverALista(): void {
    this.s.actual.set(null);
    this.volverALaBarra();
  }

  otroCamion(): void {
    const v = this.s.vale();
    if (v) this.drafts.borrar(v.id);
    this.scans = [];
    this.s.reset();
  }

  /** `crypto.randomUUID` no existe en contextos no seguros (http en LAN). */
  private nuevoScanId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return 'scan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}
