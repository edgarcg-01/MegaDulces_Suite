import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { firstValueFrom } from 'rxjs';
import { ErpOrderMatch, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService, ReceivingCapture } from '../receiving-auditor.service';
import { BinLocationService, WarehouseBin } from '../bin-location.service';
import { AndenState, AndenLinea, AndenLote, Seccion, claveLote } from './anden.state';
import { AndenDraftService } from './anden-draft.service';
import { AndenFolioComponent } from './components/anden-folio.component';
import { AndenSegmentedComponent, SegItem } from './components/anden-segmented.component';
import { AndenCaducidadComponent, FechadoConfirmado } from './components/anden-caducidad.component';
import { AndenFechaMasivaComponent, AvanceMasivo, FechadoMasivo } from './components/anden-fecha-masiva.component';
import { AndenUbicacionComponent, UbicacionNueva, UbicadoConfirmado } from './components/anden-ubicacion.component';
import { AndenCartelComponent, CartelUbicacion } from './components/anden-cartel.component';
import { ScanFieldComponent } from './components/scan-field.component';
import { formatExpiryEcho } from '../shared/expiry-short';
import { Buscable, coincide, normalizar } from './filtro.util';

/**
 * **Andén de Entrada** — del folio del papel a la mercancía fechada y acomodada,
 * en una sola pasada.
 *
 * **Dos secciones, en este orden:**
 *
 *  - **Fechas.** Con el folio aparece el vale de Kepler con sus renglones. Lo
 *    único que se captura es lote, caducidad y cuántas piezas llegaron — y
 *    cuando toda la entrega caduca el mismo día (el caso normal de un proveedor)
 *    se captura **una vez para todos**. Ahí entra la mercancía a existencia.
 *  - **Ubicación.** A cada lote ya fechado se le da su rack o su tarima. Si la
 *    ubicación todavía no existe, se crea acá mismo y **se imprime su cartel**:
 *    medido, `warehouse_bins` está en CERO, así que crear es el camino normal,
 *    no la excepción.
 *
 * **Fechar es contar.** No hay un paso de cotejo aparte: la cantidad declarada al
 * fechar es la recibida y se escribe en `received_qty` cuando el renglón queda
 * cerrado. Eso es lo que mantiene vivos los reclamos de WMS-REC.8 — el faltante
 * contra Kepler se sigue viendo, y se levanta al cerrar el vale.
 *
 * La sección activa **no vive en la ruta**: es estado de pantalla. El vale es el
 * contexto y sobrevive al salto; en la URL, el back del navegador rompería el
 * flujo a media captura.
 */
@Component({
  selector: 'app-anden',
  standalone: true,
  imports: [
    DecimalPipe, ButtonModule, ToastModule,
    AndenFolioComponent, AndenSegmentedComponent, AndenCaducidadComponent,
    AndenFechaMasivaComponent, AndenUbicacionComponent, AndenCartelComponent, ScanFieldComponent,
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
          @if (s.origen(); as o) {
            <span class="an-pill an-org" [class.an-tr]="o.kind === 'transfer'">{{ o.label }}</span>
          }
          <span class="an-pill" [class.an-on]="s.cerrado()">{{ s.estado() }}</span>
          @if (s.guardado()) { <span class="an-save">Guardado ✓</span> }
        </div>
      </header>

      @if (s.abierto()) {
        <app-anden-segmented [items]="segmentos()" [activa]="s.seccion()" (elegir)="irA($event)" />
      }

      <main class="an-bd">
        @if (carteles().length) {
          <!-- El cartel manda mientras está arriba: acabar de crear una ubicación y
               no imprimirla es dejarla sin nombre en el mundo físico. -->
          <app-anden-cartel [ubicaciones]="carteles()" (cerrar)="cerrarCartel()" />
        } @else {
          @switch (s.seccion()) {

            @case ('fechas') {
              @if (!s.abierto()) {
                <app-anden-folio
                  [folio]="s.folio()" [buscando]="s.buscando()" [candidatos]="s.candidatos()"
                  (folioChange)="s.folio.set($event)" (buscar)="buscar()" (elegir)="abrirVale($event)" />
              } @else if (masiva()) {
                <app-anden-fecha-masiva #masivo
                  [lineas]="s.pendientesFechar()" [avance]="avance()"
                  (aplicar)="fecharTodo($event)" (volver)="cerrarMasiva()" />
              } @else if (s.actual(); as l) {
                <app-anden-caducidad #fechar
                  [linea]="l" [minShelfLife]="minShelfLife()" [existingMinExpiry]="existingMinExpiry()"
                  [guardando]="s.guardando()"
                  (pedirOcr)="correrOcr($event)" (confirmar)="confirmarFechado($event)"
                  (cerrarRenglon)="cerrarRenglon($event)" (volver)="volverALista()" />
              } @else if (!s.pendientesFechar().length) {
                <div class="an-fin">
                  <div class="an-big">✓</div>
                  <h2>Todo fechado</h2>
                  <p>
                    {{ s.unidades() | number }} piezas entraron con lote y caducidad.
                    @if (s.pendientesUbicar().length) {
                      Quedan <b>{{ s.pendientesUbicar().length }}</b> lotes por acomodar.
                    } @else if (s.cerrado()) { El vale quedó cerrado. }
                    @else { Nada pendiente de acomodar tampoco. }
                  </p>
                  @if (s.pendientesUbicar().length) {
                    <button pButton type="button" [outlined]="true" (click)="irA('ubicacion')">Ir a Ubicación →</button>
                  } @else if (!s.cerrado()) {
                    <button pButton type="button" [loading]="s.guardando()" (click)="cerrarVale()">
                      Cerrar el vale
                    </button>
                  }
                  <button pButton type="button" [text]="true" severity="secondary" (click)="otroCamion()">
                    Recibir otro camión
                  </button>
                </div>
              } @else {
                <p class="an-nota">
                  Capturá lote y caducidad de cada renglón. La cantidad viene con lo que manda
                  Kepler: <b>corregila si llegó de menos</b>, porque de ahí sale el reclamo.
                </p>

                <!-- El caso normal de una entrega es una sola fecha para toda la tarima.
                     Va arriba de la lista porque resuelve el vale entero de un golpe. -->
                <button pButton type="button" class="an-masiva" [outlined]="true" (click)="masiva.set(true)">
                  Todos caducan el mismo día →
                </button>

                <app-scan-field
                  [valor]="consulta()" [visibles]="visFechar().length" [total]="s.pendientesFechar().length"
                  [refocoTick]="refoco()"
                  etiqueta="Escanear o buscar"
                  placeholder="Escaneá la caja o buscá por nombre"
                  (valorChange)="consulta.set($event)" (enter)="enter()"
                  (sinCamara)="avisarCamara($event)" />

                @if (sinCoincidencias(visFechar())) {
                  <!-- Salida accionable: que un producto no esté en el vale no
                       significa que no haya llegado. Se resuelve el código contra
                       el catálogo y se fecha igual, sin renglón: la captura suelta
                       ya es válida en el backend. -->
                  <div class="an-vacio">
                    <p class="an-vacio-t">
                      Nada por fechar coincide con <b>«{{ consulta() }}»</b>. Puede que ya esté
                      fechado, o que haya llegado sin venir en el vale.
                    </p>
                    <button pButton type="button" [outlined]="true" [loading]="resolviendo()"
                      (click)="fecharSuelto()">
                      Buscar «{{ consulta() }}» en el catálogo y fecharlo
                    </button>
                  </div>
                }

                <ul class="an-lista">
                  @for (l of visFechar(); track l.id) {
                    <li><button type="button" class="an-row" (click)="abrirFechar(l)">
                      <span class="an-row-nm">{{ nombre(l) }}</span>
                      <span class="an-row-sk">
                        {{ l.sku || l.expected_sku || '—' }} ·
                        @if (l.declarado > 0) { faltan {{ l.faltaFechar | number }} de {{ +l.expected_qty | number }} }
                        @else { sin fecha · lote NA }
                      </span>
                      <span class="an-row-qt">{{ l.faltaFechar | number }}</span>
                    </button></li>
                  }
                </ul>
              }
            }

            @case ('ubicacion') {
              @if (s.loteActual(); as l) {
                <app-anden-ubicacion #ubicar
                  [lote]="l" [bins]="bins()" [guardando]="s.guardando()" [creandoBusy]="creandoBin()"
                  [codigoNuevo]="codigoNuevo()"
                  (confirmar)="confirmarUbicado($event)" (crear)="crearUbicacion($event)"
                  (volver)="volverALista()" (sinCamara)="avisarCamara($event)" />
              } @else if (!s.pendientesUbicar().length) {
                <div class="an-fin">
                  <div class="an-big">✓</div>
                  <h2>Todo acomodado</h2>
                  <p>
                    @if (s.pendientesFechar().length) {
                      Quedan <b>{{ s.pendientesFechar().length }}</b> renglones por fechar antes de cerrar el vale.
                    } @else if (s.cerrado()) { El vale quedó cerrado: cero pendientes. }
                    @else { Cero pendientes en las dos secciones. }
                  </p>
                  @if (s.pendientesFechar().length) {
                    <button pButton type="button" [outlined]="true" (click)="irA('fechas')">Ir a Fechas →</button>
                  } @else if (!s.cerrado()) {
                    <button pButton type="button" [loading]="s.guardando()" (click)="cerrarVale()">
                      Cerrar el vale
                    </button>
                  }
                  @if (creadas().length) {
                    <button pButton type="button" [text]="true" (click)="reimprimir()">
                      Reimprimir los {{ creadas().length }} carteles de esta sesión
                    </button>
                  }
                </div>
              } @else {
                <p class="an-nota">
                  Mercancía ya fechada que todavía no tiene rack. El surtidor no la encuentra.
                </p>
                <!-- Acá la barra también busca por rack: teclear R-04 deja a la vista todo lo que
                     va a ese pasillo, y el bodeguero camina una sola vez en vez de cuatro. -->
                <app-scan-field
                  [valor]="consulta()" [visibles]="visUbicar().length" [total]="s.pendientesUbicar().length"
                  [refocoTick]="refoco()"
                  etiqueta="Escanear o buscar"
                  placeholder="Escaneá la caja, o buscá por nombre o rack"
                  (valorChange)="consulta.set($event)" (enter)="enter()"
                  (sinCamara)="avisarCamara($event)" />
                @if (sinCoincidencias(visUbicar())) {
                  <p class="an-vacio">
                    Nada por acomodar coincide con <b>«{{ consulta() }}»</b>. Si buscaste por rack,
                    puede que ese pasillo ya esté acomodado.
                  </p>
                }
                <ul class="an-lista">
                  @for (l of visUbicar(); track clave(l)) {
                    <li><button type="button" class="an-row" (click)="abrirUbicar(l)">
                      <span class="an-row-nm">{{ l.product_name || l.sku || 'Sin nombre' }}</span>
                      <span class="an-row-sk">
                        lote {{ l.lot_code }}@if (l.expiry_date) { · caduca {{ fecha(l.expiry_date) }} }
                        @if (l.binSugerido) { · sugerido {{ l.binSugerido }} }
                      </span>
                      <span class="an-row-qt">{{ l.porUbicar | number }}</span>
                    </button></li>
                  }
                </ul>
              }
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
      /* Chip NEUTRO para "en captura", no azul. DESIGN.md mata el azul en la paleta,
         y además el color acá tiene que significar algo: neutro = en curso,
         verde = cerrado. Dos chips de color distinto para dos estados que no son
         opuestos era ruido. */
      background: var(--surface-ground); color: var(--text-muted);
      border: 1px solid var(--border-color);
    }
    .an-on { background: var(--ok-soft-bg); color: var(--ok-soft-fg); border-color: transparent; }
    /* El origen NO usa el verde de "listo" ni el naranja de acción: no es un
       estado ni una acción, es una clasificación. Traspaso lleva el ámbar de
       "ojo con esto" porque el reclamo es interno; proveedor queda neutro. */
    .an-org { font-weight: var(--fw-bold); }
    .an-tr { background: var(--warn-soft-bg); color: var(--warn-fg); border-color: transparent; }
    .an-save { font-size: var(--fs-micro); color: var(--text-faint); }
    .an-bd { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-3); }
    .an-nota {
      margin: 0; padding: var(--sp-2) var(--sp-3);
      background: var(--card-bg); border: 1px solid var(--border-color);
      border-left: 3px solid var(--action); border-radius: var(--r-sm);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.4;
    }
    .an-nota b { color: var(--text-main); }
    .an-masiva { width: 100%; min-height: 50px; font-weight: var(--fw-bold); }
    /* El vacío por filtro dice qué hacer. "Sin resultados" a secas deja al
       bodeguero parado con el producto en la mano y sin salida. */
    .an-vacio {
      margin: 0; padding: var(--sp-3);
      background: var(--warn-soft-bg, var(--card-bg));
      border: 1px dashed var(--border-color); border-radius: var(--r-md);
      font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45;
    }
    .an-vacio b { color: var(--text-main); }
    .an-vacio-t { margin: 0 0 var(--sp-2); }
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
    .an-big { font-size: 48px; font-weight: var(--fw-black); line-height: 1; color: var(--ok-fg); }
    .an-fin h2 { margin: 0; font-size: var(--fs-h2); font-weight: var(--fw-bold); }
    .an-fin p { margin: 0 0 var(--sp-2); max-width: 32ch; font-size: var(--fs-sm); color: var(--text-muted); }
  `],
})
export class AndenComponent implements OnInit {
  private readonly sessions = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly binsSvc = inject(BinLocationService);
  private readonly drafts = inject(AndenDraftService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly s = new AndenState();
  readonly minShelfLife = signal<number | null>(null);
  readonly existingMinExpiry = signal<string | null>(null);

  /** Ubicaciones que ya existen en el almacén del vale. Se recarga al crear una. */
  readonly bins = signal<WarehouseBin[]>([]);
  readonly creandoBin = signal(false);
  /** Ubicaciones creadas en esta sesión de pantalla: las que hay que rotular. */
  readonly creadas = signal<CartelUbicacion[]>([]);
  /** Lo que el panel de carteles tiene arriba. Vacío = no hay cartel en pantalla. */
  readonly carteles = signal<CartelUbicacion[]>([]);
  /** La ubicación recién creada, para que el panel vuelva con ella puesta. */
  readonly codigoNuevo = signal<string | null>(null);

  /** Panel de "todos caducan el mismo día" abierto. */
  readonly masiva = signal(false);
  readonly avance = signal<AvanceMasivo | null>(null);

  /**
   * Lo tecleado o disparado en la barra única. **Una sola por sección**, y la
   * misma para escanear y para buscar: dos campos peleándose el foco es lo que
   * rompe una pistola en modo wedge.
   */
  readonly consulta = signal('');
  /** Se incrementa para devolverle el foco a la barra tras guardar o cerrar panel. */
  readonly refoco = signal(0);
  /** Resolviendo un código que no está en el vale contra el catálogo. */
  readonly resolviendo = signal(false);

  private readonly fechar = viewChild<AndenCaducidadComponent>('fechar');
  private readonly masivo = viewChild<AndenFechaMasivaComponent>('masivo');
  private readonly ubicar = viewChild<AndenUbicacionComponent>('ubicar');

  readonly segmentos = computed<SegItem[]>(() => {
    const abierto = this.s.abierto();
    const porFechar = this.s.pendientesFechar().length;
    const porUbicar = this.s.pendientesUbicar().length;
    return [
      { key: 'fechas', label: 'Fechas', on: true, pend: abierto ? porFechar : 0,
        done: abierto && porFechar === 0 },
      // Ubicación se habilita en cuanto hay UN lote fechado: no hace falta terminar
      // de fechar todo para que alguien empiece a acomodar lo que ya tiene fecha.
      { key: 'ubicacion', label: 'Ubicación', on: abierto && (porUbicar > 0 || this.s.unidades() > 0),
        pend: porUbicar, done: abierto && this.s.unidades() > 0 && porUbicar === 0 },
    ];
  });

  ngOnInit(): void {
    // Si este equipo dejó un vale a medias, se retoma donde estaba. Es la razón
    // de existir del borrador: el bodeguero no vuelve a capturar lo ya capturado.
    this.drafts.ultimoAbierto().then((b) => {
      if (!b) return;
      this.sessions.detail(b.sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (v) => {
          this.s.cargarDesdeVale(v);
          this.s.seccion.set(b.seccion);
          this.s.guardado.set(true);
          this.cargarBins();
          this.cargarLotes();
          this.toast.add({ severity: 'info', summary: 'Vale recuperado', detail: `${v.folio} — seguí donde lo dejaste.` });
        },
        error: () => this.drafts.borrar(b.sessionId),
      });
    });
  }

  nombre(l: AndenLinea): string {
    return l.product_name || l.expected_name || l.sku || l.expected_sku || 'Sin nombre';
  }

  clave(l: AndenLote): string { return claveLote(l); }
  fecha(iso: string | null): string { return formatExpiryEcho(iso); }

  // ── Barra única ───────────────────────────────────────────────────────────

  /** Qué campos de la línea ve la barra. */
  private buscable(l: AndenLinea): Buscable {
    return {
      nombre: this.nombre(l),
      sku: l.sku || l.expected_sku,
      barcode: l.barcode_scanned,
      rack: l.binSugerido,
    };
  }

  readonly visFechar = computed(() => {
    const q = this.consulta();
    const ls = this.s.pendientesFechar();
    if (!normalizar(q)) return ls;
    return ls.filter((l) => coincide(this.buscable(l), q));
  });

  readonly visUbicar = computed(() => {
    const q = this.consulta();
    const ls = this.s.pendientesUbicar();
    if (!normalizar(q)) return ls;
    return ls.filter((l) =>
      coincide({ nombre: l.product_name, sku: l.sku, barcode: null, rack: l.binSugerido }, q),
    );
  });

  /** Vacío por filtro (hay que decir algo) vs. vacío real (ya hay otra pantalla). */
  sinCoincidencias(vis: unknown[]): boolean {
    return !!normalizar(this.consulta()) && !vis.length;
  }

  /**
   * Enter, tanto del disparo de la pistola como del teclado. **Una sola
   * coincidencia abre ese renglón**: apuntar y disparar es el gesto completo.
   * Con varias no se adivina — se deja el filtro puesto y el operario elige.
   */
  enter(): void {
    if (!normalizar(this.consulta())) return;
    if (this.s.seccion() === 'fechas') {
      const vis = this.visFechar();
      if (vis.length === 1) this.abrirFechar(vis[0]);
      return;
    }
    const vis = this.visUbicar();
    if (vis.length === 1) this.abrirUbicar(vis[0]);
  }

  /**
   * **Fechar algo que no viene en el vale.**
   *
   * Pasa seguido: llegó mercancía que el vale de Kepler no trae, o el renglón ya
   * se fechó y quedó otra tarima del mismo SKU. Antes no había salida — la lista
   * solo muestra renglones del vale, así que el operario se quedaba con la caja
   * en la mano.
   *
   * El código se resuelve contra el catálogo (necesita `product_id` real; el
   * resolvedor de Conteo devuelve null y no sirve acá) y se abre el mismo panel
   * de lote/caducidad/foto. Se guarda **sin renglón**: `receiving_line_id` es
   * nullable a propósito desde WMS-REC.4, la captura suelta siempre fue válida.
   *
   * El almacén sale del vale abierto, que es lo que evita volver a preguntarlo.
   */
  fecharSuelto(): void {
    const codigo = this.consulta().trim();
    if (!codigo || this.resolviendo()) return;
    this.resolviendo.set(true);
    this.auditor.resolveForDating(codigo).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (p) => {
        this.resolviendo.set(false);
        // Se arma una línea sintética: el panel de fechado pide una `AndenLinea`,
        // y sin `id` real el guardado sabe que va sin renglón.
        const suelta = {
          id: '',
          product_id: p.product_id,
          sku: p.sku,
          product_name: p.product_name,
          expected_qty: 0,
          declarado: 0,
          retenido: 0,
          faltaFechar: 0,
          uxc: null,
          binSugerido: null,
        } as unknown as AndenLinea;
        this.s.actual.set(suelta);
        this.limpiarBarra();
        this.cargarContexto(suelta);
        this.toast.add({
          severity: 'info',
          summary: 'Fuera del vale',
          detail: `${p.product_name || p.sku} se va a fechar sin renglón. Quedará como captura suelta.`,
        });
      },
      error: (e) => {
        this.resolviendo.set(false);
        this.toast.add({
          severity: 'warn',
          summary: 'No se encontró',
          detail: e?.error?.message || `Ningún producto del catálogo tiene el código ${codigo}.`,
        });
      },
    });
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
    const b = this.s.aBorrador();
    if (!b) return;
    this.drafts.guardar(b).then((ok) => this.s.guardado.set(ok));
  }

  irA(sec: Seccion): void {
    this.s.seccion.set(sec);
    this.s.actual.set(null);
    this.s.loteActual.set(null);
    this.masiva.set(false);
    this.avance.set(null);
    this.volverALaBarra();
    if (sec === 'ubicacion') {
      this.cargarLotes(() => {
        const l = this.s.siguienteUbicar();
        if (l) this.abrirUbicar(l);
      });
    }
    this.guardarBorrador();
  }

  // ── Identificación del vale ───────────────────────────────────────────────

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
        next: (v) => this.cargarDetalle(v.id, () => { this.cargarBins(); this.cargarLotes(); }),
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

  /** Las ubicaciones que ya existen. Sin esto, el panel no puede decir si un código existe. */
  private cargarBins(tras?: () => void): void {
    const wh = this.s.warehouseId();
    if (!wh) return;
    this.binsSvc.listBins(wh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (bs) => { this.bins.set(bs || []); tras?.(); },
      // Sin la lista, el panel no puede resolver un código: se dice, no se finge
      // que el almacén está vacío (que invitaría a crear una ubicación duplicada).
      error: () => this.toast.add({
        severity: 'warn', summary: 'Ubicaciones',
        detail: 'No se pudo leer la lista de racks. Reintentá antes de crear uno nuevo.',
      }),
    });
  }

  /**
   * La cola de Ubicación sale del backend (`/unlocated`), no de la pantalla: el
   * put-away exige el lote y la caducidad exactos, y recordarlos acá los desfasa
   * en cuanto otra persona fecha desde otro equipo.
   */
  private cargarLotes(tras?: () => void): void {
    const wh = this.s.warehouseId();
    if (!wh) return;
    this.binsSvc.unlocated(wh).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (rows) => { this.s.cargarLotes(rows || []); tras?.(); },
      error: (e) => this.toast.add({
        severity: 'error', summary: 'Por acomodar',
        detail: e?.error?.message || 'No se pudo leer qué falta acomodar',
      }),
    });
  }

  // ── Fechas ────────────────────────────────────────────────────────────────

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
    this.binsSvc.pickSuggestion(wh, l.product_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ss) => {
        const fechas = (ss || []).map((x) => x.expiry_date).filter((d): d is string => !!d).sort();
        this.existingMinExpiry.set(fechas[0] ?? null);
        const bin = (ss || []).find((x) => x.bin_code)?.bin_code ?? null;
        if (bin && l.id) this.s.parchear(l.id, { binSugerido: bin });
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
    this.guardarCaptura(f).then(
      (cap) => {
        this.s.guardando.set(false);
        this.toast.add(cap.verdict === 'red'
          ? { severity: 'error', summary: 'Retenida',
              detail: 'Fechada, pero 🔴: un supervisor tiene que liberarla antes de cerrar el vale.' }
          : { severity: 'success', summary: 'Fechada',
              detail: `${this.nombre(f.linea)} — ${f.cantidad} pz, lote ${f.lote}.` });
        this.cargarDetalle(v.id, () => {
          this.s.actual.set(null);
          this.volverALaBarra();
          this.cargarLotes();
          // Una captura suelta no destraba ningún renglón del vale: encadenar al
          // "siguiente pendiente" mandaría al operario a otro producto sin que lo
          // pidiera. Sólo se encadena cuando lo que se fechó era del vale.
          if (f.linea.id) this.siguienteFechar();
        });
      },
      (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo fechar', detail: e?.error?.message || 'Error' });
      },
    );
  }

  /**
   * Una captura: evalúa + (si el renglón quedó completo) cierra el renglón con lo
   * declarado.
   *
   * **Ese `setLine` es lo que mantiene vivo el reclamo.** Sin paso de cotejo, si
   * nadie escribe `received_qty` el cierre del vale marca TODO como faltante y
   * levanta reclamos por mercancía que sí llegó. Se escribe acá, con la cantidad
   * que se declaró, que es la única que alguien miró de verdad.
   *
   * Y se escribe **al final**, no antes: mientras el renglón siga `pending` se le
   * pueden seguir agregando lotes (llegaron 12 con una fecha y 12 con otra).
   */
  private async guardarCaptura(f: FechadoConfirmado): Promise<ReceivingCapture> {
    const v = this.s.vale()!;
    const wh = this.s.warehouseId()!;
    const cap = await firstValueFrom(this.auditor.evaluate({
      warehouse_id: wh,
      product_id: f.linea.product_id!,
      supplier_code: v.supplier_code || undefined,
      source_ref: v.folio,
      // Sin `id` es una captura SUELTA (el producto no venía en el vale). El
      // backend acepta `receiving_line_id` nulo desde WMS-REC.4; mandarlo vacío
      // lo haría fallar la validación de UUID.
      receiving_line_id: f.linea.id || undefined,
      quantity: f.cantidad,
      confirmed_lot: f.lote,
      confirmed_expiry: f.caducidadIso,
      photo_data_uri: f.fotoDataUri || undefined,
    }));
    const declarado = f.linea.declarado + f.cantidad;
    if (f.linea.id && declarado + f.linea.retenido >= Number(f.linea.expected_qty)) {
      await firstValueFrom(this.sessions.setLine(v.id, f.linea.id, { received_qty: declarado }));
    }
    return cap;
  }

  /**
   * **Llegó de menos y no va a llegar más.** Cierra el renglón con lo declarado:
   * eso lo saca de la cola y deja el faltante FIRME, que es lo que el cierre del
   * vale convierte en reclamo. Sin esta salida, un renglón corto quedaría
   * pendiente para siempre y el vale no podría cerrarse.
   */
  cerrarRenglon(l: AndenLinea): void {
    const v = this.s.vale();
    if (!v || !l.id) return;
    this.s.guardando.set(true);
    this.sessions.setLine(v.id, l.id, { received_qty: l.declarado })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (upd) => {
          this.s.guardando.set(false);
          this.s.cargarDesdeVale(upd);
          this.s.actual.set(null);
          this.volverALaBarra();
          const esp = Number(l.expected_qty) || 0;
          this.toast.add({
            severity: 'warn', summary: 'Faltante',
            detail: `Kepler manda ${esp} y llegaron ${l.declarado}. Al cerrar el vale se levanta el reclamo.`,
          });
          this.siguienteFechar();
        },
        error: (e) => {
          this.s.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cerrar el renglón' });
        },
      });
  }

  cerrarMasiva(): void {
    this.masiva.set(false);
    this.avance.set(null);
    this.volverALaBarra();
  }

  /**
   * **Toda la entrega con la misma caducidad.**
   *
   * Se aplica **de a uno y en serie**, no en paralelo: cada captura escribe stock
   * y el backend resuelve la política por producto. Mandarlas todas juntas
   * ahorraría segundos y convertiría un error puntual en un lote de errores sin
   * orden. Y **no se corta al primer fallo** — los que sí se pueden fechar se
   * fechan, y los que no se listan con nombre y motivo.
   */
  async fecharTodo(m: FechadoMasivo): Promise<void> {
    const v = this.s.vale();
    if (!v || !m.lineas.length) return;
    const total = m.lineas.length;
    const fallas: { nombre: string; motivo: string }[] = [];
    let retenidas = 0;
    this.avance.set({ hechas: 0, total, fallas: [], retenidas: 0, terminado: false });

    for (const l of m.lineas) {
      try {
        if (!l.product_id) throw new Error('el renglón no tiene producto del catálogo');
        const cap = await this.guardarCaptura({
          linea: l, cantidad: l.faltaFechar, lote: m.lote, caducidadIso: m.caducidadIso, fotoDataUri: null,
        });
        if (cap.verdict === 'red') retenidas++;
      } catch (e: unknown) {
        const err = e as { error?: { message?: string }; message?: string };
        fallas.push({ nombre: this.nombre(l), motivo: err?.error?.message || err?.message || 'error desconocido' });
      }
      this.avance.update((a) => (a ? { ...a, hechas: a.hechas + 1, fallas: [...fallas], retenidas } : a));
    }

    this.avance.update((a) => (a ? { ...a, terminado: true } : a));
    // El detalle se recarga UNA vez al final: recargarlo por renglón son N viajes
    // y hace parpadear la lista mientras corre.
    this.cargarDetalle(v.id, () => this.cargarLotes());
  }

  // ── Ubicación ─────────────────────────────────────────────────────────────

  abrirUbicar(l: AndenLote): void {
    this.s.loteActual.set(l);
    this.limpiarBarra();
    if (!l.binSugerido) this.cargarSugerencia(l);
  }

  private siguienteUbicar(): void {
    const l = this.s.siguienteUbicar();
    if (l) this.abrirUbicar(l);
  }

  private cargarSugerencia(l: AndenLote): void {
    const wh = this.s.warehouseId();
    if (!wh) return;
    this.binsSvc.pickSuggestion(wh, l.product_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ss) => {
        const bin = (ss || []).find((x) => x.bin_code)?.bin_code ?? null;
        if (bin) {
          this.s.parchearLote(claveLote(l), { binSugerido: bin });
          const act = this.s.loteActual();
          if (act && claveLote(act) === claveLote(l)) this.s.loteActual.set({ ...act, binSugerido: bin });
        }
      },
      error: () => { /* sin sugerencia: se escanea el rack */ },
    });
  }

  /**
   * **Crear la ubicación que no existe.** Es el camino normal, no la excepción:
   * `warehouse_bins` arrancó en cero, así que la bodega se rotula a medida que se
   * usa. Al crearla se ofrece su cartel de una — una ubicación sin cartel pegado
   * es una ubicación que nadie vuelve a encontrar.
   */
  crearUbicacion(u: UbicacionNueva): void {
    const wh = this.s.warehouseId();
    if (!wh || this.creandoBin()) return;
    this.creandoBin.set(true);
    this.binsSvc.createBin({ warehouse_id: wh, code: u.code, label: u.label })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (b) => {
          this.creandoBin.set(false);
          const cartel: CartelUbicacion = { code: b.code, label: b.label || u.label, almacen: this.s.almacen() };
          this.creadas.update((cs) => [...cs, cartel]);
          this.codigoNuevo.set(b.code);
          this.cargarBins();
          this.carteles.set([cartel]);
          this.toast.add({
            severity: 'success', summary: 'Ubicación creada',
            detail: `${b.code} — imprimí el cartel y pegalo en el rack.`,
          });
        },
        error: (e) => {
          this.creandoBin.set(false);
          const dup = e?.status === 409;
          this.toast.add({
            severity: dup ? 'warn' : 'error',
            summary: dup ? 'Ese código ya existe' : 'No se pudo crear',
            // Un 403 acá significa que el usuario puede recibir pero no dar de alta
            // ubicaciones: hay que decirlo, no dejar un botón que no hace nada.
            detail: e?.status === 403
              ? 'Tu rol puede recibir mercancía pero no dar de alta ubicaciones. Pedí que te den el permiso de asignar.'
              : e?.error?.message || 'Error al crear la ubicación',
          });
          if (dup) this.cargarBins();
        },
      });
  }

  cerrarCartel(): void {
    this.carteles.set([]);
    setTimeout(() => this.ubicar()?.enfocar(), 0);
  }

  reimprimir(): void {
    if (this.creadas().length) this.carteles.set(this.creadas());
  }

  /**
   * **El put-away lleva el lote y la caducidad exactos.**
   *
   * Antes mandaba sólo producto y cantidad, así que el backend caía en el lote
   * `NA`. Con el fechado por delante, `NA` ya no existe — fechar RECLASIFICA el
   * lote (`assignLotToUndeclared`), y el put-away moría con "El lote no existe en
   * stock". El lote sale de `/unlocated`, que es el que lleva la cuenta de lo que
   * falta acomodar.
   */
  confirmarUbicado(u: UbicadoConfirmado): void {
    const wh = this.s.warehouseId();
    if (!wh) return;
    this.s.guardando.set(true);
    this.binsSvc.putAway({
      warehouse_id: wh,
      product_id: u.lote.product_id,
      lot_code: u.lote.lot_code,
      expiry_date: u.lote.expiry_date || undefined,
      bin_code: u.binCode,
      quantity: u.cantidad,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'success', summary: 'Acomodado',
          detail: `${u.lote.product_name || u.lote.sku} — ${u.cantidad} pz en ${u.binCode}.` });
        this.s.loteActual.set(null);
        this.volverALaBarra();
        // El código recién creado deja de mandar en cuanto se usó: el siguiente
        // lote merece SU sugerencia, que es dónde vive ese SKU.
        this.codigoNuevo.set(null);
        this.cargarLotes(() => {
          this.siguienteUbicar();
          setTimeout(() => this.ubicar()?.enfocar(), 0);
        });
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo acomodar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  volverALista(): void {
    this.s.actual.set(null);
    this.s.loteActual.set(null);
    this.volverALaBarra();
  }

  /**
   * **Cerrar el vale.** Acá —y no antes— el faltante queda firme y se levantan los
   * reclamos (WMS-REC.8). El backend descuenta lo que las capturas de lote ya
   * dieron de alta, así que cerrar después de fechar **no cuenta la mercancía dos
   * veces**.
   */
  cerrarVale(): void {
    const v = this.s.vale();
    if (!v || this.s.cerrado()) return;
    this.s.guardando.set(true);
    this.sessions.close(v.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => {
        this.s.guardando.set(false);
        this.s.cargarDesdeVale(upd);
        this.guardarBorrador();
        const n = upd?.claims?.raised ?? 0;
        const aQuien = upd?.origin?.kind === 'transfer'
          ? (upd?.origin?.name || 'la sucursal que embarcó')
          : (upd?.origin?.name || upd?.supplier_code || 'el proveedor');
        this.toast.add({
          severity: 'success', summary: 'Vale cerrado',
          detail: n > 0
            ? `Se levantaron ${n} reclamo(s) a ${aQuien}; se siguen en Compras › Reclamos.`
            : 'Sin diferencias contra Kepler.',
          life: n > 0 ? 7000 : undefined,
        });
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo cerrar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  otroCamion(): void {
    const v = this.s.vale();
    if (v) this.drafts.borrar(v.id);
    this.bins.set([]);
    this.creadas.set([]);
    this.carteles.set([]);
    this.codigoNuevo.set(null);
    this.masiva.set(false);
    this.avance.set(null);
    this.s.reset();
  }
}
