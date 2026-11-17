import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import {
  describeLocationCode,
  parseLocationCode,
  type AssignmentRole,
  type ProductAssignment,
  type ProductLocationDetail,
  type ProductPresentation,
  type WarehouseLocationRow,
} from '@megadulces/contracts';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { clasificarLectura, papelLabel, papelParaUbicacion, presentacionDeLectura, tipoLabel, tipoPorDefecto } from './ubicaciones-censo.logica';

/** Lo asignado en esta sesión de escaneo, para verlo y poder quitarlo en el acto. */
interface Hecho { id: string; code: string; sku: string; nombre: string; rotulo: string | null; papel: AssignmentRole; movido_de: string | null }
type Aviso = { tono: 'ok' | 'mal' | 'info'; texto: string };

/**
 * `[UB.3b]` Censo con lector: escanear el cartel de la ubicación y después cada producto que está ahí
 * (FASE_UB §5, camino 3; pedido de Edgar 2026-11-17: «a la hora de capturar la ubicación, asignar ya
 * el producto que está ahí», «que se pueda leer con el código de barras»).
 *
 * Un solo campo, pensado para el lector que «teclea» y manda Enter: lo que tiene forma de ubicación
 * (`BA053`) cambia la ubicación de trabajo; todo lo demás se busca como producto. La presentación sale
 * del código de barras y el papel, de la ubicación: no se teclea nada más. Si la ubicación no existe,
 * se da de alta ahí mismo. Las lecturas que llegan mientras se procesa la anterior esperan su turno:
 * un lector rápido no pierde ninguna.
 */
@Component({
  selector: 'app-ubicaciones-censo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ButtonModule, InputTextModule],
  template: `
    <section class="cs-block" aria-labelledby="cs-h">
      <div class="cs-bh">
        <h2 id="cs-h">Escanear · {{ warehouse().name }}</h2>
        <p class="cs-sub">Escanea el cartel de la ubicación y después cada producto que está ahí. Para cambiar de ubicación, escanea otro cartel.</p>
      </div>

      <form class="cs-step cs-form" (ngSubmit)="leer()">
        <label class="cs-l" for="cs-in">Lectura</label>
        <input #campo pInputText id="cs-in" name="lectura" class="mono cs-in" autocomplete="off" autocapitalize="characters" spellcheck="false"
          [ngModel]="entrada()" (ngModelChange)="entrada.set($event)" placeholder="Escanea, o escribe y pulsa Enter" aria-describedby="cs-ubic" />
        <button pButton type="submit" class="p-button-sm"><span class="p-button-label">Leer</span></button>
        @if (cargandoUbicaciones()) { <span class="cs-sub" aria-busy="true">Leyendo las ubicaciones de {{ warehouse().name }}…</span> }
      </form>

      <div class="cs-step" id="cs-ubic">
        @if (ubic(); as u) {
          <div class="cs-ubic">
            <span class="cs-code mono">{{ u.code }}</span>
            <span class="cs-desc">{{ descripcion(u) }}<br><b>{{ papelDeUbic() }}</b></span>
          </div>
        } @else {
          <p class="cs-sub">Todavía no hay ubicación: escanea su cartel (o escribe su código, como BA053).</p>
        }
      </div>

      @if (aviso(); as a) {
        <p class="cs-step cs-msg cs-{{ a.tono }}" [attr.role]="a.tono === 'mal' ? 'alert' : 'status'">{{ a.texto }}</p>
      }

      @if (porDarDeAlta(); as c) {
        <div class="cs-step cs-acc">
          <span>{{ c }} no está dada de alta en {{ warehouse().name }}.</span>
          <span class="cs-btns">
            <button pButton type="button" class="p-button-sm" [loading]="ocupado()" (click)="darDeAlta(c)"><span class="p-button-label">Darla de alta como {{ tipoAlta(c) }}</span></button>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="porDarDeAlta.set(null); enfocar()"><span class="p-button-label">Cancelar</span></button>
          </span>
        </div>
      }

      @if (elegir(); as e) {
        <div class="cs-step cs-acc" role="group" [attr.aria-label]="'¿Qué presentación de ' + e.detalle.product.nombre + '?'">
          <span><b>{{ e.detalle.product.nombre }}</b>: ¿qué presentación es?</span>
          <span class="cs-btns">
            @for (p of e.opciones; track p.peldano) {
              <button pButton type="button" class="p-button-sm p-button-outlined" (click)="elegirPresentacion(e.detalle, p.peldano)"><span class="p-button-label">{{ p.rotulo || 'Presentación ' + p.peldano }}</span></button>
            }
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="elegir.set(null); enfocar()"><span class="p-button-label">Cancelar</span></button>
          </span>
        </div>
      }

      @if (mover(); as m) {
        <div class="cs-step cs-acc">
          <span><b>{{ m.detalle.product.nombre }}</b> · {{ m.asignacion.presentacion_rotulo || 'presentación ' + m.asignacion.presentacion }} ya tiene {{ papelTexto(m.asignacion.papel) }} en <b class="mono">{{ m.asignacion.code }}</b>.</span>
          <span class="cs-btns">
            <button pButton type="button" class="p-button-sm" [loading]="ocupado()" (click)="moverAqui(m.detalle, m.asignacion)"><span class="p-button-label">Moverlo a {{ ubic()?.code }}</span></button>
            <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" (click)="mover.set(null); enfocar()"><span class="p-button-label">Dejarlo en {{ m.asignacion.code }}</span></button>
          </span>
        </div>
      }

      @if (ubic(); as u) {
        <div class="cs-step">
          <h3 class="cs-h3">Asignados en {{ u.code }} en este escaneo ({{ hechosAqui().length }})</h3>
          @if (hechosAqui().length) {
            <ul class="cs-lista">
              @for (h of hechosAqui(); track h.id) {
                <li class="cs-item">
                  <span class="cs-nom">{{ h.nombre }} <span class="mono cs-sub">{{ h.sku }}</span></span>
                  <span class="cs-sub">{{ h.rotulo || 'presentación' }} · {{ papelTexto(h.papel) }}@if (h.movido_de) { · antes en {{ h.movido_de }} }</span>
                  <button pButton type="button" class="p-button-sm p-button-text p-button-secondary" [attr.aria-label]="'Quitar ' + h.nombre + ' de ' + h.code" [disabled]="ocupado()" (click)="quitar(h)"><span class="p-button-label">Quitar</span></button>
                </li>
              }
            </ul>
          } @else {
            <p class="cs-sub">Escanea el primer producto que está en {{ u.code }}.</p>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    :host { display:block; }
    .cs-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); }
    .cs-bh { padding:.6rem .85rem; border-bottom:1px solid var(--border-color); display:flex; flex-direction:column; gap:.25rem; }
    .cs-bh h2 { margin:0; font-size:var(--fs-h3); font-weight:700; }
    .cs-step { padding:.75rem .85rem; border-top:1px solid var(--border-color); margin:0; }
    .cs-bh + .cs-step { border-top:0; }
    .cs-form { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
    .cs-l { font-size:var(--fs-sm); font-weight:600; }
    .cs-in { flex:1 1 16rem; min-width:0; min-height:var(--tap-min); font-size:var(--fs-body); }
    .cs-ubic { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
    .cs-code { font-size:2.25rem; font-weight:800; line-height:1; letter-spacing:.02em; }
    .cs-desc { font-size:var(--fs-sm); color:var(--text-muted); line-height:1.4; }
    .cs-desc b { color:var(--text-main); }
    .cs-msg { font-size:var(--fs-sm); font-weight:600; }
    .cs-ok { color:var(--ok-soft-fg); }
    .cs-mal { color:var(--bad-fg); }
    .cs-info { color:var(--text-main); }
    .cs-acc { display:flex; flex-wrap:wrap; gap:.5rem 1rem; align-items:center; font-size:var(--fs-sm); }
    .cs-btns { display:inline-flex; flex-wrap:wrap; gap:.4rem; }
    .cs-h3 { margin:0 0 .5rem; font-size:var(--fs-sm); font-weight:700; }
    .cs-lista { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
    .cs-item { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:.1rem .75rem; align-items:center; padding:.4rem 0; border-top:1px solid var(--border-color); }
    .cs-item:first-child { border-top:0; }
    .cs-item .cs-sub { grid-column:1; }
    .cs-item button { grid-column:2; grid-row:1 / span 2; }
    .cs-nom { font-size:var(--fs-sm); font-weight:600; min-width:0; overflow-wrap:anywhere; }
    .cs-sub { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
  `],
})
export class UbicacionesCensoComponent {
  private readonly api = inject(AlmacenUbicacionesCatalogoService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly campo = viewChild<ElementRef<HTMLInputElement>>('campo');

  readonly warehouse = input.required<{ id: string; code: string; name: string }>();
  /** Algo cambió en las asignaciones: la lista de la pantalla se relee. */
  readonly cambio = output<void>();

  readonly entrada = signal('');
  readonly ubic = signal<WarehouseLocationRow | null>(null);
  readonly aviso = signal<Aviso | null>(null);
  readonly porDarDeAlta = signal<string | null>(null);
  readonly elegir = signal<{ detalle: ProductLocationDetail; opciones: ProductPresentation[] } | null>(null);
  readonly mover = signal<{ detalle: ProductLocationDetail; asignacion: ProductAssignment } | null>(null);
  readonly hechos = signal<Hecho[]>([]);
  readonly ocupado = signal(false);
  readonly cargandoUbicaciones = signal(false);

  readonly hechosAqui = computed(() => this.hechos().filter((h) => h.code === this.ubic()?.code));
  readonly papelDeUbic = computed(() => {
    const u = this.ubic();
    if (!u) return '';
    const p = papelParaUbicacion(u);
    return 'papel' in p ? `Lo que escanees queda como: ${papelLabel(p.papel).toLowerCase()}` : p.motivo;
  });

  private ubicaciones = new Map<string, WarehouseLocationRow>();
  private cola: string[] = [];
  private folioAlmacen = 0;

  constructor() {
    // Cambiar de almacén: lo visto era del anterior. Se limpia todo y se leen sus ubicaciones.
    effect(() => {
      const w = this.warehouse();
      untracked(() => {
        this.folioAlmacen++;
        this.cola = [];
        this.ubic.set(null);
        this.aviso.set(null);
        this.porDarDeAlta.set(null);
        this.elegir.set(null);
        this.mover.set(null);
        this.cargarUbicaciones(w.id);
        this.enfocar();
      });
    });
  }

  descripcion(u: WarehouseLocationRow): string {
    const p = parseLocationCode(u.code);
    return `${p.ok ? describeLocationCode(p.parts) : u.code} · ${tipoLabel(u.tipo)}`;
  }
  tipoAlta(code: string): string {
    const p = parseLocationCode(code);
    return p.ok ? tipoLabel(tipoPorDefecto(p.parts.zona)).toLowerCase() : '';
  }
  papelTexto(p: AssignmentRole): string { return papelLabel(p).toLowerCase(); }

  enfocar(): void {
    queueMicrotask(() => this.campo()?.nativeElement.focus());
  }

  private cargarUbicaciones(id: string): void {
    const folio = this.folioAlmacen;
    this.cargandoUbicaciones.set(true);
    this.api.list(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (folio !== this.folioAlmacen) return;
        this.ubicaciones = new Map(r.ubicaciones.map((u) => [u.code, u]));
        this.cargandoUbicaciones.set(false);
        void this.procesarCola();
      },
      error: (e: HttpErrorResponse) => {
        if (folio !== this.folioAlmacen) return;
        this.cargandoUbicaciones.set(false);
        this.aviso.set({ tono: 'mal', texto: mensaje(e, 'No se pudieron leer las ubicaciones del almacén.') });
      },
    });
  }

  /** Enter del lector o del teclado: la lectura entra a la fila y se procesa en orden. */
  leer(): void {
    const raw = this.entrada().trim();
    this.entrada.set('');
    this.enfocar();
    if (!raw) return;
    this.cola.push(raw);
    void this.procesarCola();
  }

  private async procesarCola(): Promise<void> {
    if (this.ocupado() || this.cargandoUbicaciones()) return;
    const raw = this.cola.shift();
    if (raw === undefined) return;
    this.ocupado.set(true);
    try {
      await this.procesar(raw);
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
    void this.procesarCola();
  }

  private async procesar(raw: string): Promise<void> {
    const l = clasificarLectura(raw);
    if (l.tipo === 'vacia') return;
    this.elegir.set(null);
    this.mover.set(null);
    if (l.tipo === 'ubicacion') {
      this.porDarDeAlta.set(null);
      const u = this.ubicaciones.get(l.code);
      if (!u) {
        this.porDarDeAlta.set(l.code);
        this.aviso.set({ tono: 'info', texto: `${l.code} no está dada de alta. Dala de alta aquí para empezar a escanear sus productos.` });
        return;
      }
      this.cambiarUbicacion(u);
      return;
    }
    const u = this.ubic();
    if (!u) { this.aviso.set({ tono: 'mal', texto: 'Primero escanea el cartel de la ubicación.' }); return; }
    const papel = papelParaUbicacion(u);
    if (!('papel' in papel)) { this.aviso.set({ tono: 'mal', texto: papel.motivo }); return; }
    await this.buscarYAsignar(l.texto, papel.papel);
  }

  private cambiarUbicacion(u: WarehouseLocationRow): void {
    this.ubic.set(u);
    const p = papelParaUbicacion(u);
    this.aviso.set('papel' in p
      ? { tono: 'info', texto: `Ubicación ${u.code}: escanea los productos que están ahí.` }
      : { tono: 'mal', texto: p.motivo });
  }

  private async buscarYAsignar(texto: string, papel: AssignmentRole): Promise<void> {
    const w = this.warehouse().id;
    let lista;
    try {
      lista = await firstValueFrom(this.api.products(w, { q: texto, filtro: 'todos', limit: 5, offset: 0 }));
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo buscar el producto.') });
      return;
    }
    const exacto = lista.filas.filter((f) => f.sku.toUpperCase() === texto.toUpperCase());
    const filas = exacto.length === 1 ? exacto : lista.filas;
    if (!filas.length) { this.aviso.set({ tono: 'mal', texto: `No encontré «${texto}» en ${this.warehouse().name}.` }); return; }
    if (filas.length > 1) { this.aviso.set({ tono: 'mal', texto: `«${texto}» coincide con ${lista.total} productos: escanea su código de barras o escribe la clave completa.` }); return; }
    let detalle: ProductLocationDetail;
    try {
      detalle = await firstValueFrom(this.api.productDetail(w, filas[0].product_id));
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo leer el producto.') });
      return;
    }
    if (!detalle.presentaciones.length) { this.aviso.set({ tono: 'mal', texto: `${detalle.product.nombre} no tiene ficha en Kepler de ${this.warehouse().name}: no hay presentación que asignar.` }); return; }
    const pres = presentacionDeLectura(detalle, texto);
    if ('opciones' in pres) {
      this.elegir.set({ detalle, opciones: pres.opciones });
      this.aviso.set({ tono: 'info', texto: `${detalle.product.nombre}: elige la presentación (el código no lo dice).` });
      return;
    }
    await this.asignar(detalle, pres.peldano, papel);
  }

  /** Botón de presentación cuando el código no la decía. */
  elegirPresentacion(detalle: ProductLocationDetail, peldano: 1 | 2 | 3): void {
    const u = this.ubic();
    const p = u ? papelParaUbicacion(u) : null;
    this.elegir.set(null);
    if (!u || !p || !('papel' in p)) return;
    this.ocupado.set(true);
    void this.asignar(detalle, peldano, p.papel).finally(() => { this.ocupado.set(false); this.enfocar(); });
  }

  private async asignar(detalle: ProductLocationDetail, peldano: 1 | 2 | 3, papel: AssignmentRole): Promise<void> {
    const u = this.ubic()!;
    const rotulo = detalle.presentaciones.find((p) => p.peldano === peldano)?.rotulo ?? null;
    const igual = detalle.asignaciones.find((a) => a.presentacion === peldano && a.papel === papel && a.code === u.code);
    if (igual) { this.aviso.set({ tono: 'ok', texto: `${detalle.product.nombre} · ${rotulo ?? ''} ya estaba en ${u.code}.` }); return; }
    // Lugar fijo y reserva son uno por presentación: si ya lo tiene en otra ubicación, se ofrece moverlo.
    const unico = papel !== 'exhibicion_tienda';
    const otra = unico ? detalle.asignaciones.find((a) => a.presentacion === peldano && a.papel === papel) : undefined;
    if (otra) {
      this.mover.set({ detalle, asignacion: otra });
      this.aviso.set({ tono: 'info', texto: `${detalle.product.nombre} ya tiene ${this.papelTexto(papel)} en ${otra.code}.` });
      return;
    }
    try {
      const a = await firstValueFrom(this.api.createAssignment({ warehouse_id: this.warehouse().id, product_id: detalle.product.id, presentacion: peldano, papel, bin_code: u.code }));
      this.anotar(a.id, u.code, detalle, rotulo, papel, null);
      this.aviso.set({ tono: 'ok', texto: `${detalle.product.nombre} · ${rotulo ?? 'presentación ' + peldano} → ${u.code}.` });
      this.cambio.emit();
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo asignar.') });
    }
  }

  async moverAqui(detalle: ProductLocationDetail, asignacion: ProductAssignment): Promise<void> {
    const u = this.ubic();
    if (!u) return;
    this.ocupado.set(true);
    try {
      const a = await firstValueFrom(this.api.updateAssignment(asignacion.id, { bin_code: u.code }));
      this.mover.set(null);
      this.anotar(a.id, u.code, detalle, asignacion.presentacion_rotulo, asignacion.papel, asignacion.code);
      this.aviso.set({ tono: 'ok', texto: `${detalle.product.nombre} se movió de ${asignacion.code} a ${u.code}.` });
      this.cambio.emit();
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo mover.') });
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  async darDeAlta(code: string): Promise<void> {
    const p = parseLocationCode(code);
    if (!p.ok) return;
    this.ocupado.set(true);
    try {
      const u = await firstValueFrom(this.api.create({ warehouse_id: this.warehouse().id, code, tipo: tipoPorDefecto(p.parts.zona) }));
      this.ubicaciones.set(u.code, u);
      this.porDarDeAlta.set(null);
      this.cambiarUbicacion(u);
      this.aviso.set({ tono: 'ok', texto: `${u.code} quedó dada de alta. Escanea los productos que están ahí.` });
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo dar de alta la ubicación.') });
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  async quitar(h: Hecho): Promise<void> {
    this.ocupado.set(true);
    try {
      await firstValueFrom(this.api.removeAssignment(h.id));
      this.hechos.update((l) => l.filter((x) => x.id !== h.id));
      this.aviso.set({ tono: 'ok', texto: `${h.nombre} ya no está asignado a ${h.code}.` });
      this.cambio.emit();
    } catch (e) {
      this.aviso.set({ tono: 'mal', texto: mensaje(e as HttpErrorResponse, 'No se pudo quitar.') });
    } finally {
      this.ocupado.set(false);
      this.enfocar();
    }
  }

  private anotar(id: string, code: string, d: ProductLocationDetail, rotulo: string | null, papel: AssignmentRole, movidoDe: string | null): void {
    this.hechos.update((l) => [{ id, code, sku: d.product.sku, nombre: d.product.nombre, rotulo, papel, movido_de: movidoDe }, ...l.filter((x) => x.id !== id)]);
  }
}

function mensaje(e: HttpErrorResponse, fallback: string): string {
  const m = e?.error?.message;
  return typeof m === 'string' ? m : Array.isArray(m) ? m.join(' · ') : fallback;
}
