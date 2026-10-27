import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { CatalogoProductosService } from '../catalogo-productos.service';
import { ProductosFlujoService } from '../productos-flujo.service';
import { armarFicha, numeroFicha } from './producto-ficha.component';
import {
  EtiquetasProducto, comoVaLaVenta, comprasTexto, etiquetasTexto, factoresDe, loteTexto, margenReal, queHacer, sucursalesDetalladas,
} from '../catalogo-detallado';

/** Un error de HTTP en una frase (el mensaje del servidor si lo trae). */
function mensajeDe(e: unknown, porDefecto: string): string {
  // rxResource envuelve lo que no es Error (un HttpErrorResponse) y deja el original en cause.
  const c = (e as { cause?: unknown })?.cause;
  if (c) e = c;
  const msg = (e as { error?: { message?: unknown }; message?: unknown })?.error?.message ?? (e as { message?: unknown })?.message;
  return typeof msg === 'string' && msg ? msg : porDefecto;
}

/**
 * Ficha de un producto en la vista DETALLADO del Catálogo de Compras. En este orden:
 *   1. Etiquetas (las del renglón: Líder, Nuevo, Caducidad).
 *   2. Identidad y «Unidades y precio»: lo mismo que Sencillo (mismos datos y la misma `armarFicha`).
 *   3. Qué hacer: el veredicto del motor PF, su porqué y «Mover antes de comprar» en cajas/paquetes.
 *   4. Dónde se mueve y dónde se estancó: vendido este mes, existencia y días sin vender por sucursal.
 *   5. ¿Cómo va la venta este mes?: en palabras y dos barras (sin gráfica).
 *   6. Margen real (30 días) — sólo con permiso de costo.
 *   7. Compras (90 días); el costo de la última sólo con permiso de costo.
 *   8. Caducidad por lote (sólo si tiene lotes registrados).
 * Sin «Editar producto» (el usuario lo quitó).
 *
 * Jerarquía: primario = qué hacer; secundario = el precio por unidad y las sucursales; terciario = identidad,
 * compras, lotes. Lo que no se midió se declara («Sin dato», «Calculando…», «No se pudo…»), nunca un cero.
 */
@Component({
  selector: 'app-producto-ficha-detallada',
  standalone: true,
  imports: [TableModule, TagModule, LoadStateComponent, FreshnessPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-load-state [loading]="cargando()" [error]="error()" [isEmpty]="false" [skeletonRows]="8"
                    errorTitle="No se pudo cargar la ficha del producto" (retry)="recargar()">
      @if (vm(); as v) {
        <article class="fd" [attr.aria-label]="'Ficha de ' + v.nombre">
          @if (etiquetasVm().length) {
            <div class="tags" aria-label="Etiquetas">
              @for (t of etiquetasVm(); track t.texto) { <span class="tag" [class]="'tag tag--' + t.clase">{{ t.texto }}</span> }
            </div>
          }

          <!-- 2. Identidad (como en Sencillo) -->
          <dl class="ident">
            <div>
              <dt>SKU</dt>
              <dd>
                @if (v.sku) {
                  <span class="mono">{{ v.sku }}</span>
                  <button type="button" class="copiar" (click)="copiar(v.sku)" [attr.aria-label]="'Copiar SKU ' + v.sku">
                    <i class="pi" [class.pi-copy]="copiado() !== v.sku" [class.pi-check]="copiado() === v.sku" aria-hidden="true"></i>
                    {{ copiado() === v.sku ? 'copiado' : 'copiar' }}
                  </button>
                } @else {
                  <span class="sin">Sin SKU</span>
                }
              </dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd><p-tag [severity]="v.activo ? 'success' : 'secondary'" [value]="v.activo ? 'Activo' : 'Inactivo'" [rounded]="true" /></dd>
            </div>
            <div>
              <dt>{{ v.codigos.length > 1 ? 'Códigos de barras' : 'Código de barras' }}</dt>
              <dd>
                @if (v.codigos.length) {
                  <span class="cods">
                    @for (c of v.codigos; track c; let i = $index) {
                      <span class="mono">{{ c }}@if (i === 0 && v.codigos.length > 1) {&ngsp;<small class="nota">principal</small> }</span>
                    }
                  </span>
                } @else {
                  <span class="sin">Sin código</span>
                }
              </dd>
            </div>
            <div>
              <dt>Proveedor</dt>
              <dd>@if (v.proveedor) { {{ v.proveedor }} } @else { <span class="sin">Sin proveedor</span> }</dd>
            </div>
            @if (v.descripcion) {
              <div class="ancho"><dt>Descripción</dt><dd>{{ v.descripcion }}</dd></div>
            }
          </dl>

          <section class="bloque" aria-labelledby="fd-up-t">
            <h3 class="bloque-t" id="fd-up-t">Unidades y precio</h3>
            @if (v.unidades.length) {
              <p-table [value]="v.unidades" class="surf-table surf-table--plain fd-tabla" [tableStyle]="{ width: '100%' }">
                <ng-template #header>
                  <tr class="cab">
                    <th scope="col">Unidad</th>
                    <th scope="col">Equivale a</th>
                    <th scope="col" class="r comm-num">Precio</th>
                    <th scope="col" class="r comm-num">Mayoreo</th>
                  </tr>
                </ng-template>
                <ng-template #body let-u>
                  <tr>
                    <td role="cell"><span class="ud">{{ u.unidad }}</span></td>
                    <td role="cell" class="equiv" data-label="Equivale a">{{ u.equivale }}</td>
                    <td role="cell" class="r comm-num" data-label="Precio">
                      @if (u.precio) { <span class="precio">{{ u.precio }}</span> } @else { <span class="sin">Sin precio</span> }
                    </td>
                    <td role="cell" class="r comm-num" data-label="Mayoreo">
                      @if (u.mayoreo) { <span class="mono">{{ u.mayoreo.precio }}<small class="nota">desde {{ u.mayoreo.desde }}</small></span> }
                      @else { <span class="sin" aria-label="Sin mayoreo">—</span> }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
              <p class="red" [class.red--varia]="v.red.tipo === 'varia'" [class.red--sin]="v.red.tipo === 'sin'">{{ v.red.texto }}</p>
            } @else {
              <p class="sin">Sin unidades registradas.</p>
            }
          </section>

          <!-- 3. Que hacer: el veredicto del motor de flujo -->
          <section class="bloque compra" [class]="'bloque compra q-' + (que()?.veredicto ?? 'cargando')" aria-labelledby="fd-q-t">
            <h3 class="bloque-t" id="fd-q-t">Qué hacer</h3>
            @if (que(); as q) {
              <p class="q-linea"><span class="q-chip" [class]="'q-chip q-chip--' + q.veredicto">{{ q.etiqueta }}</span> <span class="q-titulo">{{ q.titulo }}</span></p>
              @if (q.motivos.length) {
                <ul class="lista">@for (m of q.motivos; track $index) { <li>{{ m }}</li> }</ul>
              }
              @if (q.traspasos.length) {
                <p class="sub">Mover antes de comprar</p>
                <ul class="lista">
                  @for (t of q.traspasos; track $index) { <li><b class="mono">{{ t.cantidad }}</b> de {{ t.desde }} a {{ t.hacia }}</li> }
                </ul>
              }
            } @else if (flujoError()) {
              <p class="aviso" role="alert">{{ flujoError() }}</p>
            } @else {
              <p class="nota-bloque">Calculando…</p>
            }
          </section>

          <!-- 4. Sucursales -->
          <section class="bloque" aria-labelledby="fd-suc-t">
            <div class="bloque-cab">
              <h3 class="bloque-t" id="fd-suc-t">Dónde se mueve y dónde se estancó</h3>
              <app-freshness-pill measures="fetch" [since]="v.calculadoAl" />
            </div>
            @if (sucursales().length) {
              <p-table [value]="sucursales()" class="surf-table surf-table--plain fd-tabla fd-suc" [tableStyle]="{ width: '100%' }">
                <ng-template #header>
                  <tr class="cab">
                    <th scope="col">Sucursal</th>
                    <th scope="col" class="r comm-num">Vendido este mes</th>
                    <th scope="col" class="r comm-num">Existencia</th>
                    <th scope="col" class="r comm-num">Sin vender</th>
                  </tr>
                </ng-template>
                <ng-template #body let-s>
                  <tr>
                    <td role="cell" class="c-suc">{{ s.nombre }}</td>
                    <td role="cell" class="r comm-num" data-label="Vendido este mes">
                      @if (s.monto) {
                        <span class="pila"><span class="precio">{{ s.monto }}</span>@if (s.unidades) { <small class="bajo">{{ s.unidades }}</small> }</span>
                      } @else if (s.vendidoMedido) { <span class="sin">Sin venta</span> } @else { <span class="sin">Sin dato</span> }
                    </td>
                    <td role="cell" class="r comm-num" data-label="Existencia">
                      @switch (s.existencia.tipo) {
                        @case ('sin_dato') { <span class="sin">Sin dato</span> }
                        @case ('agotado') { <span class="agotado">Agotado</span> }
                        @default { <span class="mono">{{ s.existencia.texto }}</span> }
                      }
                    </td>
                    <td role="cell" class="r" data-label="Sin vender">
                      @if (det()) { {{ s.sinVender }} } @else { <span class="sin">Calculando…</span> }
                    </td>
                  </tr>
                </ng-template>
              </p-table>
            } @else {
              <p class="sin">Ninguna sucursal lo vende ni lo tiene.</p>
            }
          </section>

          <!-- 5. Como va la venta: en palabras y dos barras -->
          <section class="bloque" aria-labelledby="fd-fl-t">
            <h3 class="bloque-t" id="fd-fl-t">¿Cómo va la venta este mes?</h3>
            @if (comoVa(); as c) {
              <div class="vb">
                <p class="vb-titulo" [class]="'vb-titulo vb-' + c.tono"><span aria-hidden="true">{{ c.flecha }}</span> {{ c.titulo }}</p>
                <p class="vb-frase">{{ c.frase }}</p>
                @for (b of c.barras; track b.clase) {
                  <div class="vb-fila">
                    <span class="vb-etq">{{ b.etiqueta }}</span>
                    <span class="vb-pista" aria-hidden="true"><span class="vb-barra" [class]="'vb-barra vb-' + b.clase" [style.width.%]="b.pct"></span></span>
                    <span class="vb-val">{{ b.monto }}</span>
                  </div>
                }
              </div>
            } @else if (flujoError()) {
              <p class="aviso" role="alert">{{ flujoError() }}</p>
            } @else {
              <p class="nota-bloque">Calculando…</p>
            }
          </section>

          <!-- 6. Margen: solo con permiso de costo -->
          @if (det()?.costo_visible) {
            <section class="bloque" aria-labelledby="fd-mg-t">
              <h3 class="bloque-t" id="fd-mg-t">Margen real (últimos {{ det()!.criterio.ventanaMargen }} días)</h3>
              @if (margenesRes.error()) {
                <p class="aviso" role="alert">No se pudo calcular el margen.</p>
              } @else if (margenesRes.hasValue()) {
                @if (margen(); as m) {
                  <dl class="ident ent">
                    <div><dt>Margen</dt><dd><span class="mono" [class.neg]="m.negativo">{{ m.margen }}</span><small class="nota candado"><i class="pi pi-lock" aria-hidden="true"></i> sólo con permiso de costo</small></dd></div>
                    <div><dt>Venta sin impuestos</dt><dd><span class="mono">{{ m.venta }}</span>@if (m.cubre) { <small class="nota">{{ m.cubre }}</small> }</dd></div>
                  </dl>
                } @else {
                  <p class="sin">Sin venta en los últimos {{ det()!.criterio.ventanaMargen }} días cerrados: no hay margen que medir.</p>
                }
              } @else {
                <p class="nota-bloque">Calculando…</p>
              }
            </section>
          }

          <!-- 7. Compras -->
          <section class="bloque" aria-labelledby="fd-co-t">
            <h3 class="bloque-t" id="fd-co-t">Compras (últimos {{ compras()?.dias ?? 90 }} días)</h3>
            @if (comprasRes.error()) {
              <p class="aviso" role="alert">No se pudieron cargar las compras.</p>
            } @else if (compras(); as c) {
              @if (c.entradas || c.ultima) {
                <dl class="ident ent">
                  <div><dt>Entradas</dt><dd><span class="mono">{{ c.entradas }}</span></dd></div>
                  <div><dt>Comprado</dt><dd>@if (c.comprado) { <span class="mono">{{ c.comprado }}</span> } @else { <span class="sin">Nada en la ventana</span> }</dd></div>
                  <div><dt>Primera</dt><dd>@if (c.primera) { {{ c.primera }} } @else { <span class="sin">—</span> }</dd></div>
                  <div><dt>Última</dt><dd>@if (c.ultima) { {{ c.ultima }} } @else { <span class="sin">—</span> }</dd></div>
                  @if (c.costoUltima; as k) {
                    <div><dt>Costo de la última</dt><dd><span class="mono">{{ k.monto }}</span>&ngsp;por {{ k.unidad }}<small class="nota candado"><i class="pi pi-lock" aria-hidden="true"></i> sólo con permiso de costo</small></dd></div>
                  }
                </dl>
              } @else {
                <p class="sin">Sin entradas de mercancía registradas.</p>
              }
            } @else {
              <p class="nota-bloque">Calculando…</p>
            }
          </section>

          <!-- 8. Caducidad por lote: solo si tiene lotes -->
          @if (lotes().length) {
            <section class="bloque" aria-labelledby="fd-ca-t">
              <h3 class="bloque-t" id="fd-ca-t">Caducidad por lote</h3>
              <p-table [value]="lotes()" class="surf-table surf-table--plain fd-tabla" [tableStyle]="{ width: '100%' }">
                <ng-template #header>
                  <tr class="cab">
                    <th scope="col">Sucursal</th>
                    <th scope="col">Caduca</th>
                    <th scope="col" class="r comm-num">Registrado</th>
                  </tr>
                </ng-template>
                <ng-template #body let-l>
                  <tr>
                    <td role="cell" class="c-suc">{{ l.sucursal }}@if (l.lote) { <small class="bajo">Lote {{ l.lote }}</small> }</td>
                    <td role="cell" data-label="Caduca"><span class="est" [class]="'est est--' + l.tono">{{ l.caduca }}</span> <small class="bajo">{{ l.cuando }}</small></td>
                    <td role="cell" class="r comm-num" data-label="Registrado"><span class="mono">{{ l.cantidad }}</span></td>
                  </tr>
                </ng-template>
              </p-table>
            </section>
          }
        </article>
      }
    </app-load-state>
  `,
  styles: [`
    :host { display: block; container-type: inline-size; container-name: fichad; }
    .fd { display: flex; flex-direction: column; gap: var(--sp-6); color: var(--text-main); }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .sin { color: var(--text-faint); font-size: var(--fs-sm); }
    .nota { font-size: var(--fs-xs); color: var(--text-muted); margin-left: var(--sp-1); font-family: var(--font-body); }
    .aviso { margin: 0; font-size: var(--fs-sm); color: var(--bad-fg); }
    .neg { color: var(--bad-fg); }

    /* 1. Etiquetas */
    .tags { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
    .tag { font-size: var(--fs-xs); font-weight: var(--fw-bold); border-radius: var(--r-pill); padding: 0 var(--sp-2); border: 1px solid currentColor; line-height: 1.5; }
    .tag--lider { color: var(--action); }
    .tag--nuevo { color: var(--text-muted); }
    .tag--cad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }

    /* 2. Identidad (las mismas reglas de la ficha Sencillo) */
    .ident { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-5); margin: 0; }
    .ident > div { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
    .ident > div.ancho { grid-column: 1 / -1; }
    .ident dt { font-size: var(--fs-xs); color: var(--text-muted); }
    .ident dd { margin: 0; font-size: var(--fs-body); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; overflow-wrap: anywhere; }
    .cods { display: flex; flex-direction: column; gap: var(--sp-1); }
    .copiar {
      display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); background: var(--card-bg);
      border: 1px solid var(--border-color); border-radius: var(--r-sm); padding: 0 var(--sp-2); min-height: 1.5rem; cursor: pointer;
    }
    .copiar:hover { color: var(--text-main); background: var(--overlay-hover); }
    .copiar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .copiar .pi { font-size: var(--fs-xs); }

    /* Bloques */
    .bloque { display: flex; flex-direction: column; min-width: 0; }
    .bloque-cab { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
    .bloque-t { margin: 0 0 var(--sp-2); font-size: var(--fs-micro); letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); font-weight: var(--fw-bold); }
    .nota-bloque { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
    .sub { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-bold); color: var(--text-muted); }
    .lista { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); display: flex; flex-direction: column; gap: var(--sp-1); }

    /* Tablas */
    .r { text-align: right; white-space: nowrap; }
    .ud { font-family: var(--font-mono); font-weight: var(--fw-bold); font-size: var(--fs-xs); padding: 0 var(--sp-2); border-radius: var(--r-sm);
      background: var(--overlay-hover); border: 1px solid var(--border-color); }
    .equiv { color: var(--text-muted); font-size: var(--fs-sm); }
    .precio { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); font-size: var(--fs-body); }
    .pila { display: inline-flex; flex-direction: column; align-items: flex-end; }
    .bajo { display: block; font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-body); }
    .agotado { color: var(--bad-fg); font-weight: var(--fw-bold); font-size: var(--fs-sm); }
    .red { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); display: flex; align-items: center; gap: var(--sp-2); }
    .red::before { content: ""; flex: none; width: .42rem; height: .42rem; border-radius: var(--r-pill); background: var(--ok-fg); }
    .red--varia::before { background: var(--warn-fg); }
    .red--sin::before { background: transparent; box-shadow: inset 0 0 0 1px var(--text-faint); }
    .candado .pi { font-size: var(--fs-micro); }

    /* 3. Que hacer: el primario de la ficha */
    .compra { border: 1px solid var(--border-color); border-left-width: 3px; border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); }
    .compra.q-comprar { border-left-color: var(--bad-fg); }
    .compra.q-traspasar { border-left-color: var(--warn-fg); }
    .compra.q-sobra, .compra.q-no_comprar { border-left-color: var(--ok-fg); }
    .q-linea { margin: 0; display: flex; gap: var(--sp-2); align-items: baseline; flex-wrap: wrap; }
    .q-titulo { font-size: var(--fs-body); font-weight: var(--fw-bold); }
    .q-chip { font-size: var(--fs-xs); font-weight: var(--fw-bold); border-radius: var(--r-pill); padding: 0 var(--sp-2); border: 1px solid var(--border-color); color: var(--text-muted); white-space: nowrap; }
    .q-chip--comprar { color: var(--bad-soft-fg); background: var(--bad-soft-bg); border-color: var(--bad-border); }
    .q-chip--traspasar { color: var(--warn-soft-fg); background: var(--warn-soft-bg); border-color: var(--warn-border); }
    .q-chip--sobra, .q-chip--no_comprar { color: var(--ok-fg); background: var(--ok-soft-bg); }

    /* 5. Como va la venta */
    .vb { border: 1px solid var(--border-color); border-radius: var(--r-lg); padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
    .vb-titulo { margin: 0; font-size: var(--fs-body); font-weight: var(--fw-bold); display: flex; gap: var(--sp-2); align-items: center; }
    .vb-sube { color: var(--ok-fg); }
    .vb-baja { color: var(--bad-fg); }
    .vb-igual { color: var(--text-main); }
    .vb-frase { margin: 0; font-size: var(--fs-sm); line-height: 1.5; }
    .vb-fila { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr) auto; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
    .vb-etq { color: var(--text-muted); }
    .vb-pista { height: .7rem; background: var(--overlay-hover); border-radius: var(--r-pill); overflow: hidden; }
    .vb-barra { display: block; height: 100%; border-radius: var(--r-pill); }
    .vb-act { background: var(--action); }
    .vb-ant { background: var(--text-faint); }
    .vb-val { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: var(--fw-bold); text-align: right; }

    /* 8. Lotes */
    .est { font-size: var(--fs-xs); font-weight: var(--fw-bold); border-radius: var(--r-pill); padding: 0 var(--sp-2); white-space: nowrap; }
    .est--bad { color: var(--bad-soft-fg); background: var(--bad-soft-bg); }
    .est--warn { color: var(--warn-soft-fg); background: var(--warn-soft-bg); }
    .est--ok { color: var(--ok-fg); background: var(--ok-soft-bg); }

    @container fichad (min-width: 30rem) {
      .ident { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    /* Angosto: un dato por renglon y las tablas apiladas con su etiqueta por celda */
    @container fichad (max-width: 24rem) {
      .ident { grid-template-columns: 1fr; gap: 0; }
      .ident > div { flex-direction: row; justify-content: space-between; align-items: center; gap: var(--sp-3);
        padding: var(--sp-2) 0; border-bottom: 1px solid var(--border-color); }
      .ident > div:last-child { border-bottom: 0; }
      .ident dd { justify-content: flex-end; text-align: right; }
      .ident > div.ancho { flex-direction: column; align-items: flex-start; }
      .ident > div.ancho dd { justify-content: flex-start; text-align: left; }
      .cods { align-items: flex-end; }
      .vb-fila { grid-template-columns: 1fr auto; }
      .vb-pista { grid-column: 1 / -1; grid-row: 2; }

      :host ::ng-deep .fd-tabla table,
      :host ::ng-deep .fd-tabla tbody { display: block; width: 100%; }
      .cab { display: none; }
      tr:not(.cab) { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: var(--sp-1) var(--sp-3);
        padding: var(--sp-3) 0; border-bottom: 1px solid var(--border-color); }
      tr:not(.cab) > td { padding: 0; border: 0; }
      td.c-suc { grid-column: 1 / -1; font-weight: var(--fw-bold); }
      td[data-label] { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); text-align: right; }
      td[data-label]::before { content: attr(data-label); color: var(--text-muted); font-size: var(--fs-xs); font-family: var(--font-body); font-weight: var(--fw-regular); }
      td.equiv[data-label] { grid-column: auto; justify-content: flex-end; }
      td.equiv[data-label]::before { content: none; }
    }
  `],
})
export class ProductoFichaDetalladaComponent {
  readonly productId = input.required<string>();
  /** Las etiquetas del renglón (Líder, Nuevo, Caducidad): las mismas que la lista, de la misma respuesta. */
  readonly etiquetas = input<EtiquetasProducto | null>(null);

  private readonly catalogo = inject(CatalogoProductosService);
  private readonly flujo = inject(ProductosFlujoService);
  private readonly recarga = signal(0);
  readonly copiado = signal<string | null>(null);

  private readonly fichaRes = rxResource({
    params: () => ({ id: this.productId(), v: this.recarga() }),
    stream: ({ params }) => this.catalogo.ficha(params.id, null),
  });
  private readonly flujoRes = rxResource({
    params: () => ({ id: this.productId(), v: this.recarga() }),
    stream: ({ params }) => this.flujo.detalle(params.id),
  });
  readonly comprasRes = rxResource({
    params: () => ({ id: this.productId(), v: this.recarga() }),
    stream: ({ params }) => this.catalogo.compras(params.id),
  });
  /** El margen sólo se pide con permiso de costo (el servidor lo niega sin él). */
  readonly margenesRes = rxResource({
    params: () => {
      const d = this.det();
      return d?.costo_visible ? d.product_id : undefined;
    },
    stream: ({ params }) => this.flujo.margenes(params),
  });

  readonly cargando = computed(() => this.fichaRes.isLoading() && !this.fichaRes.hasValue());
  readonly error = computed(() => (this.fichaRes.error() ? mensajeDe(this.fichaRes.error(), 'Error de red o del servidor. Intenta de nuevo.') : null));
  private readonly ficha = computed(() => (this.fichaRes.hasValue() ? this.fichaRes.value() : null));
  /** El flujo del MISMO producto (al cambiar de producto no se ve el anterior). */
  readonly det = computed(() => {
    const d = this.flujoRes.hasValue() ? this.flujoRes.value() : null;
    const id = this.productId();
    return d && d.product_id === id ? d : null;
  });
  readonly flujoError = computed(() => (this.flujoRes.error() ? mensajeDe(this.flujoRes.error(), 'No se pudo calcular el flujo de venta.') : null));

  readonly vm = computed(() => {
    const f = this.ficha();
    return f ? armarFicha(f) : null;
  });
  private readonly factores = computed(() => factoresDe(this.ficha()));
  private readonly base = computed(() => this.ficha()?.unidadBase ?? '');

  readonly etiquetasVm = computed(() => etiquetasTexto(this.etiquetas()));
  readonly que = computed(() => {
    const d = this.det();
    const factores = this.factores();
    const base = this.base();
    return d ? queHacer(d, factores, base) : null;
  });
  readonly sucursales = computed(() => {
    const f = this.ficha();
    const d = this.det();
    return f ? sucursalesDetalladas(f, d) : [];
  });
  readonly comoVa = computed(() => {
    const d = this.det();
    return d ? comoVaLaVenta(d.resumen.mes, d.resumen.mes_anterior_mismo, d.resumen.variacion, d.periodos) : null;
  });
  readonly margen = computed(() => (this.margenesRes.hasValue() ? margenReal(this.margenesRes.value()) : null));
  readonly compras = computed(() => {
    const c = this.comprasRes.hasValue() ? this.comprasRes.value() : null;
    const factores = this.factores();
    const base = this.base();
    return c ? comprasTexto(c, factores, base) : null;
  });
  readonly lotes = computed(() => {
    const d = this.det();
    const factores = this.factores();
    const base = this.base();
    return d ? [...d.lotes].sort((a, b) => a.dias - b.dias).map((l) => loteTexto(l, factores, base)) : [];
  });

  readonly num = numeroFicha;

  recargar(): void {
    this.recarga.update((n) => n + 1);
  }

  copiar(texto: string): void {
    const portapapeles = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!portapapeles?.writeText) return;
    portapapeles.writeText(texto).then(
      () => {
        this.copiado.set(texto);
        setTimeout(() => { if (this.copiado() === texto) this.copiado.set(null); }, 1500);
      },
      () => this.copiado.set(null),
    );
  }
}
