import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ErpOrderMatch, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { BinLocationService, PickSuggestion } from '../bin-location.service';
import { AndenState, AndenLinea } from './anden.state';
import { AndenFolioComponent } from './components/anden-folio.component';
import { AndenCotejoComponent } from './components/anden-cotejo.component';
import { AndenRenglonComponent, RenglonConfirmado } from './components/anden-renglon.component';

/**
 * **Andén de Entrada** — reemplaza el recorrido de cuatro pantallas de la sección
 * Entrada por una sola pasada junto al camión.
 *
 * Hoy dar de alta un renglón cuesta 23 toques repartidos en tres pantallas, con
 * el almacén elegido dos veces; un vale de cinco líneas son 79. Acá el mismo vale
 * son 24: 2 para traerlo de Kepler, 11 para contar y dar acceso, y 2 por renglón
 * en la puerta 2.
 *
 * Es **pantalla de foco**: cuelga fuera del shell de tabs, igual que el conteo
 * físico y el detalle del vale. El operario entra escaneando el folio del papel,
 * no eligiendo de una lista.
 *
 * **Alcance de esta entrega:** las dos puertas. El tablero del supervisor, el
 * endpoint `settle` transaccional y el renombre de estados van aparte. Por eso la
 * puerta 2 hace **dos** llamadas (`evaluate` + `put-away`): si la segunda falla,
 * el renglón queda marcado `sinUbicar` y **no** se da por terminado.
 */
@Component({
  selector: 'app-anden',
  standalone: true,
  imports: [ButtonModule, ToastModule, AndenFolioComponent, AndenCotejoComponent, AndenRenglonComponent],
  providers: [MessageService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="an">
      <p-toast />

      <header class="an-top">
        <div class="an-id">
          <span class="an-marca">MEGA DULCES · CEDIS</span>
          @if (s.vale(); as v) {
            <span class="an-vale">{{ v.folio }} · {{ s.proveedor() }}</span>
            <span class="an-alm">{{ s.almacenLabel() }}</span>
          } @else {
            <span class="an-vale an-espera">Esperando camión</span>
            <span class="an-alm">sin identificar</span>
          }
        </div>
        <div class="an-toques">
          <span class="an-toques-n">{{ s.toques() }}</span>
          <span class="an-toques-l">toques</span>
        </div>
      </header>

      @if (s.vale()) {
        <nav class="an-puertas" role="tablist">
          <button role="tab" [attr.aria-selected]="s.puerta() === 'cotejo'"
            [class.is-on]="s.puerta() === 'cotejo'" (click)="irA('cotejo')">1 · Cotejo y acceso</button>
          <button role="tab" [attr.aria-selected]="s.puerta() === 'fechado'"
            [class.is-on]="s.puerta() === 'fechado'" [disabled]="!accesoDado()"
            (click)="irA('fechado')">2 · Fechado y acomodo</button>
        </nav>
      }

      <main class="an-cuerpo">
        @switch (s.puerta()) {
          @case ('folio') {
            <app-anden-folio
              [folio]="s.folio()" [buscando]="s.buscando()" [candidatos]="s.candidatos()"
              (folioChange)="s.folio.set($event)" (buscar)="buscar()" (elegir)="abrirVale($event)" />
          }

          @case ('cotejo') {
            <app-anden-cotejo
              [lineas]="s.lineas()" [cotejo]="s.cotejo()"
              [puedeDarAcceso]="s.puedeDarAcceso()" [guardando]="s.guardando()"
              (contar)="contar($event.linea, $event.cantidad)"
              (abrirLinea)="s.toque()"
              (darAcceso)="darAcceso()" />
          }

          @case ('fechado') {
            @if (s.fechadoCompleto()) {
              <div class="an-fin">
                <h2>Vale terminado</h2>
                <p>Todas las líneas quedaron fechadas y en su rack.</p>
                <button pButton type="button" (click)="otroCamion()">Recibir otro camión</button>
              </div>
            } @else if (s.lineaActiva(); as l) {
              @if (s.resueltas().length) {
                <p class="an-hechas">{{ s.resueltas().length }} de {{ s.lineas().length }} renglones listos</p>
              }
              <app-anden-renglon #renglon
                [linea]="l" [sugerido]="sugerido()"
                [minShelfLife]="minShelfLife()" [existingMinExpiry]="existingMinExpiry()"
                [guardando]="s.guardando()"
                (pedirOcr)="correrOcr($event)"
                (confirmar)="confirmarRenglon($event)" />
            }
          }
        }
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100dvh; background: var(--surface-layout, var(--surface-ground)); }
    .an { max-width: min(720px, 100vw); margin: 0 auto; padding: var(--sp-3) var(--sp-3) var(--sp-8); }
    .an-top {
      display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-3);
      padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border-color); margin-bottom: var(--sp-4);
    }
    .an-id { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .an-marca { font-size: var(--fs-micro); letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }
    .an-vale { font-size: var(--fs-h3); font-weight: var(--fw-bold); overflow: hidden; text-overflow: ellipsis; }
    .an-espera { color: var(--text-muted); font-weight: var(--fw-medium); }
    .an-alm { font-size: var(--fs-xs); color: var(--text-muted); }
    .an-toques { flex: 0 0 auto; text-align: right; }
    .an-toques-n { display: block; font-size: var(--fs-h2); font-weight: var(--fw-black); font-variant-numeric: tabular-nums; color: var(--action); }
    .an-toques-l { font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: .08em; color: var(--text-faint); }
    .an-puertas { display: flex; gap: 2px; padding: 3px; margin-bottom: var(--sp-4);
      background: var(--surface-ground); border: 1px solid var(--border-color); border-radius: var(--r-pill); }
    .an-puertas button {
      flex: 1; min-height: 44px; padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r-pill);
      background: none; color: var(--text-muted); font: inherit; font-size: var(--fs-sm);
      font-weight: var(--fw-medium); cursor: pointer; white-space: nowrap;
    }
    .an-puertas button.is-on { background: var(--card-bg); color: var(--action); box-shadow: 0 0 0 1px var(--border-color); }
    .an-puertas button:disabled { opacity: .45; cursor: not-allowed; }
    .an-hechas { margin: 0 0 var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
    .an-fin { text-align: center; padding: var(--sp-8) var(--sp-3); }
    .an-fin h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-h2); font-weight: var(--fw-bold); }
    .an-fin p { margin: 0 0 var(--sp-4); color: var(--text-muted); font-size: var(--fs-sm); }
  `],
})
export class AndenComponent implements OnInit {
  private readonly sessions = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);
  private readonly bins = inject(BinLocationService);
  private readonly toast = inject(MessageService);
  private readonly destroyRef = inject(DestroyRef);

  readonly s = new AndenState();
  readonly accesoDado = signal(false);
  readonly sugerido = signal<PickSuggestion | null>(null);

  /**
   * La política aplicable debería venir por renglón desde el backend
   * (`resolvePolicy()` es privado dentro de `receiving-auditor.service`). Hasta
   * que exista `GET /policy/resolve`, el semáforo se pinta sólo con los días de
   * vida — **no se duplica la cascada producto→categoría→proveedor en el front**,
   * porque se desincronizaría del backend y terminaría mintiendo.
   */
  readonly minShelfLife = signal<number | null>(null);
  readonly existingMinExpiry = signal<string | null>(null);

  private readonly renglon = viewChild<AndenRenglonComponent>('renglon');

  ngOnInit(): void { /* el andén arranca vacío: esperando camión */ }

  irA(p: 'cotejo' | 'fechado'): void {
    this.s.toque();
    this.s.puerta.set(p);
    if (p === 'fechado') this.activarSiguiente(null);
  }

  // ── Paso 0 ────────────────────────────────────────────────────────────────

  buscar(): void {
    const folio = this.s.folio().trim();
    if (!folio) return;
    this.s.toque();
    this.s.buscando.set(true);
    this.sessions.searchErpOrders(folio).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (ms) => {
        this.s.buscando.set(false);
        this.s.candidatos.set(ms || []);
        if (!ms?.length) {
          this.toast.add({ severity: 'warn', summary: 'Sin resultados', detail: `Kepler no tiene el vale ${folio}.` });
          return;
        }
        // Una sola coincidencia se abre sola: es el caso normal y ahorra un toque.
        if (ms.length === 1) this.abrirVale(ms[0]);
      },
      error: (e) => {
        this.s.buscando.set(false);
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo buscar el vale' });
      },
    });
  }

  abrirVale(m: ErpOrderMatch): void {
    this.s.toque();
    this.s.erp.set(m);
    this.s.cargando.set(true);
    // El almacén NO se manda: lo deriva el backend del mapa sucursal→almacén.
    this.sessions.open({ source_kind: 'erp_receipt', erp_sucursal: m.sucursal, erp_folio: m.folio })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (v) => this.cargarDetalle(v.id, 'cotejo'),
        error: (e) => {
          this.s.cargando.set(false);
          const yaRecibido = e?.error?.code === 'folio_ya_recibido' || /ya.*recib/i.test(e?.error?.message || '');
          this.toast.add({
            severity: yaRecibido ? 'warn' : 'error',
            summary: yaRecibido ? 'Ese folio ya tiene vale' : 'Error',
            detail: e?.error?.message || 'No se pudo abrir el vale',
          });
        },
      });
  }

  private cargarDetalle(id: string, puerta?: 'cotejo' | 'fechado'): void {
    this.s.cargando.set(true);
    this.sessions.detail(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => {
        this.s.cargando.set(false);
        this.s.cargarDesdeVale(v);
        if (v.status === 'closed') this.accesoDado.set(true);
        if (puerta) this.s.puerta.set(puerta);
      },
      error: (e) => {
        this.s.cargando.set(false);
        // No tragarse la falla: un vale vacío y un 500 se ven igual.
        this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo cargar el vale' });
      },
    });
  }

  // ── Puerta 1 ──────────────────────────────────────────────────────────────

  contar(l: AndenLinea, cantidad: number): void {
    const v = this.s.vale();
    if (!v) return;
    this.s.toque();
    this.s.guardando.set(true);
    this.sessions.setLine(v.id, l.id, { received_qty: cantidad })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (upd) => { this.s.guardando.set(false); this.s.cargarDesdeVale(upd); },
        error: (e) => {
          this.s.guardando.set(false);
          this.toast.add({ severity: 'error', summary: 'Error', detail: e?.error?.message || 'No se pudo guardar la cantidad' });
        },
      });
  }

  darAcceso(): void {
    const v = this.s.vale();
    if (!v) return;
    this.s.toque();
    this.s.guardando.set(true);
    this.sessions.close(v.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (upd) => {
        this.s.guardando.set(false);
        this.s.cargarDesdeVale(upd);
        this.accesoDado.set(true);
        this.toast.add({
          severity: 'success', summary: 'Acceso dado',
          detail: 'La mercancía entró en lote NA. El camión se puede ir.',
        });
        this.s.puerta.set('fechado');
        this.activarSiguiente(null);
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo dar acceso', detail: e?.error?.message || 'Error' });
      },
    });
  }

  // ── Puerta 2 ──────────────────────────────────────────────────────────────

  private activarSiguiente(desde: string | null): void {
    const id = this.s.siguientePendiente(desde);
    this.s.lineaActivaId.set(id);
    this.sugerido.set(null);
    this.minShelfLife.set(null);
    this.existingMinExpiry.set(null);
    if (!id) return;
    const l = this.s.lineas().find((x) => x.id === id);
    const wh = this.s.warehouseId();
    if (l?.product_id && wh) {
      this.bins.pickSuggestion(wh, l.product_id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (ss) => {
          this.sugerido.set(ss?.[0] ?? null);
          // La caducidad más próxima ya en stock alimenta el semáforo anticipado.
          // Comparación lexicográfica sobre ISO YYYY-MM-DD, que ordena bien por fecha.
          const fechas = (ss || []).map((x) => x.expiry_date).filter((d): d is string => !!d).sort();
          this.existingMinExpiry.set(fechas[0] ?? null);
          setTimeout(() => this.renglon()?.precargar(), 0);
        },
        error: () => setTimeout(() => this.renglon()?.precargar(), 0),
      });
    } else {
      setTimeout(() => this.renglon()?.precargar(), 0);
    }
  }

  correrOcr(dataUri: string): void {
    this.auditor.ocr(dataUri).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.renglon()?.aplicarOcr(r),
      error: () => {
        this.renglon()?.ocrFallo();
        this.toast.add({ severity: 'warn', summary: 'OCR', detail: 'No se distinguió lote/caducidad. Capturalo a mano.' });
      },
    });
  }

  /**
   * Fechar + acomodar. Son **dos** llamadas hasta que exista el endpoint `settle`
   * transaccional: si el put-away falla después de que la caducidad se guardó, el
   * renglón queda `sinUbicar` y NO se marca terminado — que es justo el modo en
   * que hoy se acumula mercancía fantasma.
   */
  confirmarRenglon(r: RenglonConfirmado): void {
    const v = this.s.vale();
    const wh = this.s.warehouseId();
    if (!v || !wh || !r.linea.product_id) return;
    this.s.toque();
    this.s.guardando.set(true);

    this.auditor.evaluate({
      warehouse_id: wh,
      product_id: r.linea.product_id,
      supplier_code: v.supplier_code || undefined,
      source_ref: v.folio,
      receiving_line_id: r.linea.id,
      quantity: r.cantidad,
      confirmed_lot: r.lote,
      confirmed_expiry: r.caducidadIso || undefined,
      photo_data_uri: r.fotoDataUri || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (cap) => {
        if (cap.verdict === 'red') {
          this.s.guardando.set(false);
          this.toast.add({
            severity: 'error', summary: 'Rojo · retenido',
            detail: 'No entró a inventario: necesita autorización de un supervisor.',
          });
          this.cargarDetalle(v.id);
          return;
        }
        this.ubicar(v.id, wh, r);
      },
      error: (e) => {
        this.s.guardando.set(false);
        this.toast.add({ severity: 'error', summary: 'No se pudo fechar', detail: e?.error?.message || 'Error' });
      },
    });
  }

  private ubicar(sessionId: string, wh: string, r: RenglonConfirmado): void {
    const productId = r.linea.product_id;
    if (!productId) return;
    if (!r.binId && !r.binCode) {
      // Sin rack no hay acomodo: se fechó, falta ubicar. Se dice, no se oculta.
      this.s.guardando.set(false);
      this.s.parchear(r.linea.id, { sinUbicar: true });
      this.toast.add({ severity: 'warn', summary: 'Fechado sin rack', detail: 'Falta acomodarlo en una ubicación.' });
      this.cargarDetalle(sessionId);
      return;
    }
    this.bins.putAway({
      warehouse_id: wh,
      product_id: productId,
      lot_code: r.lote,
      expiry_date: r.caducidadIso || undefined,
      bin_id: r.binId || undefined,
      bin_code: r.binCode || undefined,
      quantity: r.cantidad,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.s.guardando.set(false);
        this.s.parchear(r.linea.id, { sinUbicar: false });
        this.toast.add({ severity: 'success', summary: 'Listo', detail: `${r.linea.product_name || 'Renglón'} fechado y acomodado.` });
        this.sessions.detail(sessionId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: (v) => { this.s.cargarDesdeVale(v); this.activarSiguiente(r.linea.id); },
          error: () => this.activarSiguiente(r.linea.id),
        });
      },
      error: (e) => {
        // La caducidad SÍ se guardó. No marcar el renglón como terminado.
        this.s.guardando.set(false);
        this.s.parchear(r.linea.id, { sinUbicar: true });
        this.toast.add({
          severity: 'error', summary: 'Se fechó pero no se acomodó',
          detail: e?.error?.message || 'El rack no se guardó. El renglón queda pendiente de ubicar.',
        });
        this.cargarDetalle(sessionId);
      },
    });
  }

  otroCamion(): void {
    this.s.reset();
    this.accesoDado.set(false);
    this.sugerido.set(null);
  }
}
