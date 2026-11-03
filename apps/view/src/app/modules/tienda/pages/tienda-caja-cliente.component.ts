import { ChangeDetectionStrategy, Component, OnDestroy, signal } from '@angular/core';
import { pesos } from '../caja-motor';

/**
 * [PDV.33] Pantalla del cliente: segundo monitor de la caja. Se abre desde /tienda/caja y escucha el
 * canal del navegador (misma app, otra ventana), así que no consulta nada al servidor. Muestra lo
 * que el cliente necesita para confiar: cada renglón al entrar, el total, lo que ahorró y su cambio.
 */
interface Estado {
  estado: 'venta' | 'cobro' | 'cobrado';
  total: number; ahorro: number; saldo: number; recibido: number; cambio: number;
  sucursal: string; empujon: string;
  /** Sin efectivo no hay cambio: se muestra lo pagado y con qué. */
  efectivo: boolean; formas: string;
  /** La cajera le está verificando un precio: gana sobre todo lo demás. */
  verificador: { nombre: string; unidades: { nombre: string; precio: number }[]; mayoreo: { texto: string; precio: number }[]; respaldo: string | null } | null;
  lineas: { nombre: string; cantidad: string; importe: number; quitado: boolean; sel: boolean }[];
}

@Component({
  selector: 'app-tienda-caja-cliente',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
  @if (s(); as e) {
    @if (e.verificador; as v) {
      <div class="cc-centro cc-verif" role="status">
        <div class="cc-lbl">Consulta de precio</div>
        @if (v.nombre) {
          <div class="cc-v-nombre">{{ v.nombre }}</div>
          @if (v.unidades[0]; as u) {
            <div class="cc-v-unidad">Por {{ u.nombre.toLowerCase() }}</div>
            <div class="cc-total cc-gigante">{{ dinero(u.precio) }}</div>
          }
          @for (u of v.unidades.slice(1); track u.nombre) { <div class="cc-v-fila"><span>{{ u.nombre }}</span><b>{{ dinero(u.precio) }}</b></div> }
          @if (v.mayoreo.length) {
            <div class="cc-v-may">
              <div class="cc-lbl">Precio por mayoreo</div>
              @for (t of v.mayoreo; track t.texto) { <div class="cc-v-fila"><span>{{ t.texto }}</span><b class="cc-ahorro-n">{{ dinero(t.precio) }} c/u</b></div> }
            </div>
          }
          @if (v.respaldo) { <div class="cc-tenue">Precio de respaldo de {{ v.respaldo }}</div> }
          <div class="cc-tenue">Esta consulta no se agregó a tu compra</div>
        } @else {
          <div class="cc-total">Acerca el producto al lector</div>
          <div class="cc-tenue">Te mostramos su precio aquí</div>
        }
      </div>
    } @else if (e.estado === 'cobrado') {
      <div class="cc-centro">
        <div class="cc-tenue">Gracias por tu compra</div>
        @if (e.efectivo) {
          <div class="cc-lbl">Tu cambio</div>
          <div class="cc-total cc-gigante">{{ dinero(e.cambio) }}</div>
          <div class="cc-tenue">Recibido {{ dinero(e.recibido) }} · total {{ dinero(e.total) }}</div>
        } @else {
          <div class="cc-lbl">Pagaste con {{ e.formas }}</div>
          <div class="cc-total cc-gigante">{{ dinero(e.total) }}</div>
        }
      </div>
    } @else if (!e.lineas.length) {
      <div class="cc-centro"><div class="cc-total">Bienvenido a Mega Dulces</div><div class="cc-tenue">{{ e.sucursal }}</div></div>
    } @else {
      <div class="cc-rejilla">
        <section class="cc-lista" aria-label="Tu compra">
          <div class="cc-lbl">Tu compra</div>
          @for (l of e.lineas; track $index) {
            <div class="cc-fila" [class.cc-sel]="l.sel" [class.cc-quitado]="l.quitado">
              <span>{{ l.nombre }} · {{ l.cantidad }}</span><span>{{ l.quitado ? 'quitado' : dinero(l.importe) }}</span>
            </div>
          }
          @if (e.empujon) { <div class="cc-empujon">{{ e.empujon }}</div> }
        </section>
        <aside class="cc-lado">
          <div class="cc-lbl">{{ e.estado === 'cobro' ? 'Por pagar' : 'Total a pagar' }}</div>
          <div class="cc-total">{{ dinero(e.estado === 'cobro' ? e.saldo : e.total) }}</div>
          <div class="cc-tenue">IVA e IEPS incluidos</div>
          @if (e.ahorro > 0) { <div class="cc-ahorro">Ahorraste por mayoreo {{ dinero(e.ahorro) }}</div> }
        </aside>
      </div>
    }
  } @else {
    <div class="cc-centro"><div class="cc-total">Bienvenido a Mega Dulces</div></div>
  }
  `,
  styles: [`
    :host { display: block; position: fixed; inset: 0; z-index: 10; overflow: auto; background: var(--surface-ground); color: var(--text-main); }
    .cc-centro { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-4); text-align: center; }
    .cc-rejilla { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 28rem); }
    @media (max-width: 50rem) { .cc-rejilla { grid-template-columns: 1fr; } }
    .cc-lista { padding: var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-2); border-right: 1px solid var(--border-color); overflow: auto; font-size: var(--fs-h3); }
    .cc-lado { padding: var(--sp-8); display: flex; flex-direction: column; gap: var(--sp-3); }
    .cc-lbl { font-size: var(--fs-sm); letter-spacing: .06em; text-transform: uppercase; font-weight: 600; color: var(--text-faint); }
    .cc-fila { display: flex; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-1) var(--sp-3); border-radius: var(--r-md); font-variant-numeric: tabular-nums; }
    .cc-sel { background: var(--surface-selected-bg); font-weight: 700; }
    .cc-quitado { color: var(--text-faint); text-decoration: line-through; }
    .cc-empujon { margin-top: auto; border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); background: var(--card-bg); }
    .cc-total { font-size: var(--text-display-xl); font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
    .cc-gigante { font-size: var(--text-display-xl); }
    .cc-tenue { font-size: var(--fs-lg); color: var(--text-muted); }
    .cc-ahorro { font-size: var(--fs-h3); color: var(--ok-fg); font-weight: 600; }
    .cc-verif { gap: var(--sp-3); padding: var(--sp-8); }
    .cc-v-nombre { font-size: var(--fs-h1); font-weight: 700; max-width: 40ch; }
    .cc-v-unidad { font-size: var(--fs-lg); font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-muted); }
    .cc-v-may { display: flex; flex-direction: column; gap: var(--sp-2); width: min(100%, 36rem); margin-top: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border-color); border-radius: var(--r-lg); background: var(--card-bg); }
    .cc-v-fila { display: flex; justify-content: space-between; gap: var(--sp-4); width: min(100%, 36rem); font-size: var(--fs-h3); font-variant-numeric: tabular-nums; }
    .cc-ahorro-n { color: var(--ok-fg); }
  `],
})
export class TiendaCajaClienteComponent implements OnDestroy {
  readonly s = signal<Estado | null>(null);
  readonly dinero = pesos;
  private readonly canal = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('md-caja-cliente') : null;

  constructor() {
    if (this.canal) {
      this.canal.onmessage = (m: MessageEvent<Estado | { pide: true }>) => { if (!('pide' in m.data)) this.s.set(m.data); };
      // Abierta con un ticket a medias: le pide a la caja su estado en vez de esperar al siguiente cambio.
      this.canal.postMessage({ pide: true });
    }
  }

  ngOnDestroy(): void { this.canal?.close(); }
}
