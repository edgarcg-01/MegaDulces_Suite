import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe, DatePipe, NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DialogModule } from 'primeng/dialog';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import type {
  CoberturaLevantamiento, FichaPublicada, FichasPublicadas, RevisionBandeja, RevisionDecision, RevisionFicha, RevisionFoto, RevisionMotivo,
} from '@megadulces/contracts';
import { REVISION_MOTIVO_TEXTO, warehouseName } from '@megadulces/contracts';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { LoadStateComponent } from '../../../shared/components/load-state/load-state.component';
import { MetricStripComponent, type MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FreshnessPillComponent } from '../../../shared/components/freshness-pill/freshness-pill.component';
import { SegmentedComponent, type SegOption } from '../../../shared/components/segmented/segmented.component';
import { DocViewerComponent, type DocViewerFile } from '../../../shared/components/doc-viewer/doc-viewer.component';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { CatalogoDigitalService } from '../catalogo-digital.service';

const CARA: Record<string, string> = { frente: 'Frente', reverso: 'Reverso', lateral_izq: 'Lado izq.', lateral_der: 'Lado der.', base: 'Base' };
const PALABRA: Record<string, string> = { PZA: 'pieza', PAQ: 'paquete', CJA: 'caja', BTO: 'bulto', CUB: 'cubeta', KG: 'kilo' };
const MOTIVOS: RevisionMotivo[] = ['sin_analizar', 'caras_saltadas', 'entro_por_busqueda', 'foto_repetida'];

/** Las dos secciones de la pestaña. Viven en el mismo componente: la ruta (y `app.routes.ts`) no cambia. */
export type SeccionCatalogoDigital = 'revision' | 'publicadas';

/** Lo que comparten una ficha por revisar y una publicada: lo que dibujan las fotos y el dato de Kepler. */
type FichaComun = Pick<RevisionFicha, 'sku' | 'name' | 'branch_code' | 'branch_name' | 'unit_label' | 'unit_factor' | 'scanned_code' | 'kepler_codes' | 'photos'>;

const ENTERO = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * `[NP.7.L.5]` El % de la venta como lo dio la API, **sin redondear a entero**.
 *
 * Regla (declarada; la cobra el spec): dos decimales por debajo de 10 % (0.888 → «0.89 %»), uno de 10 % en
 * adelante (48.25 → «48.3 %»). Un valor mayor que 0 que con dos decimales se leería «0.00 %» se escribe
 * «menos de 0.01 %», y uno menor que 100 que se leería «100.0 %» se escribe «más de 99.9 %»: los dos extremos
 * son los que un redondeo convierte en una afirmación falsa (nada cubierto / todo cubierto). `null`, un texto
 * no numérico o un no-finito devuelven `null`: es «no medible», nunca un cero (ADR-056). Llega como número o
 * como texto (un `numeric` de Postgres viaja como string por JSON): por eso el `Number()`.
 */
export function pctVentaTexto(v: number | string | null | undefined): string | null {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return '0 %';
  if (n > 0 && n < 0.005) return 'menos de 0.01 %';
  const dec = Math.abs(n) < 10 ? 2 : 1;
  const txt = new Intl.NumberFormat('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);
  if (n < 100 && Number(txt.replace(/,/g, '')) >= 100) return 'más de 99.9 %';
  return txt + ' %';
}

/** La sucursal por NOMBRE (PM, 2026-10-22): el del servidor y, si no llegó, el resolvedor común. Nunca «01». */
export function nombreSucursal(f: { branch_name: string | null; branch_code: string }): string {
  return f.branch_name ?? warehouseName(f.branch_code);
}

/**
 * La meta de la cobertura todavía no existe (D15: la fija Edgar en el Tablero PM). Se dice con palabras, como en la
 * maqueta E; nunca se dibuja como un número.
 */
const META_SIN_FIJAR = 'meta: sin fijar (la fija Edgar, con fecha)';

/**
 * La respuesta de la sección en una oración: lo que dice el lector de pantalla al llegar a la tira. Abre con el %
 * de la venta (Métrica L), como pide la pregunta 1 de §10b.2: el conteo por SKU dice otra cosa (0.17 % de los
 * productos contra 0.89 % de la venta, el 2026-11-04).
 */
export function respuestaCobertura(c: CoberturaLevantamiento): string {
  const pct = pctVentaTexto(c.sales_share_pct);
  return nombreSucursal(c) + ': '
    + (pct ? pct + ' de su venta de 90 días tiene ficha publicada' : 'el % de su venta de 90 días con ficha publicada no se pudo medir')
    + ' · ' + ENTERO.format(Number(c.published)) + ' de ' + ENTERO.format(Number(c.universe)) + ' productos'
    + ' · faltan ' + ENTERO.format(Number(c.missing)) + ' · meta: sin fijar';
}

/**
 * La tira de la sección Publicadas: los números tal cual los dio la API (no se recalcula «faltan»: es el MISMO
 * de la pantalla A del levantamiento, plan §10b.3 «Unidades de conteo»). Las cifras van como texto o con
 * `instant`: un conteo animado publicaría, mientras cuenta, coberturas que no existen (`[PGP.15]`).
 *
 * Orden (pregunta 1 de §10b.2 y maqueta E): primero el % de la venta en pesos, con la meta sin fijar; después el
 * conteo de productos; al final, cuántos faltan.
 * ⚠️ Deuda con nombre (Q.4, NP.7.L.5): «Faltan» no abre la lista de los que faltan. Hace falta un endpoint que
 * pagine el MISMO universo (`UNIVERSO_LEVANTAMIENTO_SQL` sin ficha) para que la lista llegue al mismo total; los
 * sugeridos del levantamiento no sirven (sólo los que tienen existencia y no están en curso). Mientras no exista,
 * la sub-línea lo dice para que el número no aparente poder recorrerse.
 */
export function kpisCobertura(c: CoberturaLevantamiento): MetricStripItem[] {
  const pct = pctVentaTexto(c.sales_share_pct);
  const etiqueta = nombreSucursal(c) + ' · venta con ficha publicada';
  // La razón de «no medible» va VISIBLE en la sub-línea: el `stateNote` sólo llega al title del chip (§3c).
  const sinVenta = 'la venta de 90 días de la sucursal está en cero o no se pudo leer';
  return [
    pct
      ? { label: etiqueta, value: pct, format: 'text', sub: 'de su venta de 90 días, en pesos · ' + META_SIN_FIJAR }
      : { label: etiqueta, value: 'no medible', format: 'text', state: 'no_medido', stateNote: 'La venta de 90 días de la sucursal está en cero o no se pudo leer.', sub: sinVenta + ' · ' + META_SIN_FIJAR },
    {
      label: 'Productos con ficha publicada',
      value: ENTERO.format(Number(c.published)) + ' de ' + ENTERO.format(Number(c.universe)),
      format: 'text',
      sub: 'con venta de 90 días o existencia, sin promociones',
    },
    { label: 'Faltan', value: Number(c.missing), format: 'number', sub: 'sin ficha publicada, como en el levantamiento · la lista de cuáles aún no está en esta pantalla' },
  ];
}

/**
 * Junta la página siguiente de Publicadas con lo ya cargado. La lista va de la más reciente a la más vieja y se
 * pagina por posición: si entre dos clics alguien publica, la nueva entra ARRIBA, todo se recorre un lugar y la
 * página siguiente repite la última fila (y si se reemplaza una, se salta otra). Se quitan las repetidas por id
 * (también evita ids repetidos en el `track`) y `cambio` avisa que la lista se movió (el total cambió o vino una
 * repetida): la pantalla lo dice en vez de afirmar «N de N».
 * ⚠️ Paginar por llave (cursor con la fecha de publicación y el id) en la API queda como decisión pendiente.
 */
export function anexarPublicadas(d: FichasPublicadas, mas: FichasPublicadas): { datos: FichasPublicadas; cambio: boolean } {
  const vistos = new Set(d.rows.map((r) => r.id));
  const nuevas = mas.rows.filter((r) => !vistos.has(r.id));
  return { datos: { ...mas, rows: [...d.rows, ...nuevas] }, cambio: mas.total !== d.total || nuevas.length < mas.rows.length };
}

/**
 * La línea de la IA (D6). La lectura NUNCA se dibuja aquí: sólo se declara en qué estado está, para que
 * «sólo fotos» no se lea como «la IA no encontró nada».
 */
export function lineaIa(ai: FichaPublicada['ai_reading']): string {
  if (ai === 'apagada') return 'Sólo fotos: la lectura de la IA está apagada';
  if (ai === 'sin_leer') return 'Sólo fotos: la IA todavía no lee esta ficha';
  return 'La IA ya leyó esta ficha; su lectura no se muestra en esta pantalla';
}

/**
 * Catálogo digital: dos secciones con un control segmentado arriba de la lista.
 *
 * ── `[NP.7.L.3b]` Por revisar · maqueta F de `FASE_NP7_ALTA_DESDE_FOTOS.md` §10b.4 ───────────────────
 *  1. Primero, cuántas fichas esperan y por qué; luego la lista y, al lado, la ficha: fotos contra Kepler.
 *  2. No ve costo, precio, margen ni el ranking.
 *  3. Teclado completo (P publica, R pide otra foto, D descarta, flechas entre fichas; escritos en los
 *     botones), fotos ampliables sin salir (el visor compartido en una ventana), motivo en texto y no sólo en color.
 *  4. Ligada al levantamiento (de ahí llegan) y, después, a Incidencias (NP.7.L.3c, todavía no).
 *  5. Le toca a quien tenga `CATALOGO_FICHAS_REVISAR`.
 *
 * ── `[NP.7.L.5]` Publicadas · primer corte de la maqueta E (§10b.4) y fila «Cobertura» de §10b.2 ─────────
 *  1. Primero la RESPUESTA, con la edad del cálculo: «Padre Hidalgo: 0.89 % de su venta de 90 días tiene ficha
 *     publicada · 7 de 4,230 productos · faltan 4,223 · meta: sin fijar» (la tira; medido el 2026-11-04; el % de
 *     la venta va primero, como pide §10b.2). Después la lista, la más reciente primero
 *     (lo que acaban de publicar; el orden lo da el servidor) y, al lado, la ficha: fotos ampliables y el dato de
 *     Kepler, como en Por revisar (master-detail).
 *  2. NO ve costo, precio, margen ni venta por producto. La lectura de la IA no se dibuja: una sola línea
 *     («Sólo fotos: la lectura de la IA está apagada»). Sin botones de decisión: es de sólo lectura (P, R y D no
 *     hacen nada en esta sección).
 *  3. Búsqueda por nombre o SKU en el servidor (250 ms después de dejar de teclear, como el buscador del
 *     levantamiento); «Se muestran N de total» + «Ver más», así el total se recorre (cruce 1 de
 *     `auditoria-diseno`); si la lista se movió entre dos páginas, lo dice y ofrece volver a cargar; flechas
 *     entre fichas, escritas en pantalla; fotos que se amplían sin salir; sucursal por NOMBRE; texto y no sólo
 *     color. ⚠️ «Faltan» todavía no abre su lista (deuda con nombre, ver `kpisCobertura`).
 *  4. Ligada: de dónde viene (quién la levantó y cuándo; quién la publicó y cuándo) y a dónde NO va todavía:
 *     «Todavía no llega al portal ni al verificador: falta decidir si esta foto reemplaza la imagen que ya
 *     tienen» (decisión D19 del plan; en pantalla, en palabras).
 *  5. La ve quien tiene `CATALOGO_FICHAS_REVISAR` (la misma guarda de la pestaña: la clave propia de la
 *     maqueta E, `CATALOGO_LEVANTAR_COBERTURA_VER`, es otro corte de NP.7.L.5). `app-load-state` separa
 *     cargando / vacío / error en las DOS secciones.
 *
 * Jerarquía (Q.5): primario = la respuesta de la tira; secundario = la ficha elegida; terciario = la lista y
 * sus metadatos. ⚠️ Universos distintos y declarados (ley 1.6): la tira es de UNA sucursal (la nombra), la
 * lista es de toda la red (lo dice su rótulo).
 */
@Component({
  selector: 'app-compras-catalogo-digital',
  standalone: true,
  imports: [
    DecimalPipe, DatePipe, NgTemplateOutlet, DialogModule, IconFieldModule, InputIconModule, InputTextModule,
    PageTabsComponent, LoadStateComponent, MetricStripComponent, FreshnessPillComponent, SegmentedComponent, DocViewerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="surf-page cd">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Catálogo digital · {{ seccion() === 'publicadas' ? 'Publicadas' : 'Por revisar' }}</h1>
          @if (seccion() === 'publicadas') {
            <p class="cd-sub">Lo que Catálogo ya aprobó, en toda la red. Sólo lectura.
              <app-freshness-pill measures="fetch" label="calculado" [since]="pub()?.coverage?.measured_at ?? null" /></p>
          } @else {
            <p class="cd-sub">Lo que levantó el personal de sucursal. Nada se publica sin que alguien lo vea.
              <app-freshness-pill measures="fetch" [since]="cargadoEn()" /></p>
          }
        </div>
      </header>
      <app-page-tabs [tabs]="tabs" />

      <div class="cd-seccion">
        <app-segmented [options]="secciones()" [value]="seccion()" (valueChange)="cambiarSeccion($event)"
                       ariaLabel="Sección del catálogo digital" />
      </div>

      @if (seccion() === 'revision') {
        <app-metric-strip [items]="kpis()" density="compact" ariaLabel="Fichas por revisar" />
        <div class="cd-filtros" role="group" aria-label="Filtrar por motivo">
          <button type="button" class="cd-chip" [attr.aria-pressed]="motivo() === null" (click)="filtrar(null)">Todas {{ totalBandeja() | number }}</button>
          @for (m of motivos; track m) {
            @if ((datos()?.counts?.[m] ?? 0) > 0) {
              <button type="button" class="cd-chip" [attr.aria-pressed]="motivo() === m" (click)="filtrar(m)">{{ texto(m) }} {{ datos()?.counts?.[m] | number }}</button>
            }
          }
        </div>

        <app-load-state [loading]="cargando() && !datos()" [error]="error()" [isEmpty]="!!datos() && (datos()?.rows?.length ?? 0) === 0"
                        emptyIcon="pi-check-circle" emptyTitle="No hay fichas por revisar"
                        emptyHint="Todo lo levantado ya tiene decisión." (retry)="cargar()">
          <div class="cd-md">
            <ul class="cd-lista" aria-label="Fichas por revisar">
              @for (f of datos()?.rows ?? []; track f.id; let i = $index) {
                <li><button type="button" class="cd-fila" [class.on]="i === sel()" [attr.aria-current]="i === sel()" (click)="elegir(i)">
                  <span class="cd-fila-n">{{ f.name ?? f.sku }}</span>
                  <small>{{ unidad(f.unit_label, f.unit_factor) }} · {{ f.captured_by ?? 'sin nombre' }} · {{ sucursal(f) }}</small>
                  <small>{{ motivosTexto(f) }}</small>
                </button></li>
              }
              @if ((datos()?.total ?? 0) > (datos()?.rows?.length ?? 0)) {
                <li class="cd-mas">Se muestran {{ datos()?.rows?.length }} de {{ datos()?.total | number }}.
                  <button type="button" class="cd-link" (click)="masFichas()">Ver más</button></li>
              }
            </ul>

            @if (actual(); as f) {
              <section class="cd-ficha" aria-live="polite">
                <div class="cd-ficha-head">
                  <h2>{{ f.name ?? f.sku }}</h2>
                  <span class="cd-meta">{{ f.sku }} · {{ unidad(f.unit_label, f.unit_factor) }} · {{ f.captured_by ?? 'sin nombre' }} · {{ f.captured_at | date: 'd MMM, HH:mm' }} · {{ sucursal(f) }}</span>
                </div>
                <p class="cd-frase">{{ frase(f) }}</p>

                <ng-container *ngTemplateOutlet="fotosTpl; context: { $implicit: f }" />
                <ng-container *ngTemplateOutlet="keplerTpl; context: { $implicit: f }" />

                @if (pidiendoNota(); as d) {
                  <label class="cd-nota">{{ d === 'recapturar' ? 'Qué hay que volver a fotografiar' : 'Por qué se descarta' }}
                    <input type="text" id="cd-nota-input" [value]="nota()" (input)="nota.set($any($event.target).value)" (keydown.enter)="confirmar()"
                           maxlength="500" autocomplete="off" /></label>
                  <div class="cd-acciones">
                    <button type="button" class="cd-btn cd-pri" [disabled]="ocupado() || !nota().trim()" (click)="confirmar()">{{ d === 'recapturar' ? 'Pedir otra foto' : 'Descartar' }}</button>
                    <button type="button" class="cd-btn" (click)="pidiendoNota.set(null)">Cancelar</button>
                  </div>
                } @else {
                  <div class="cd-acciones">
                    <button type="button" class="cd-btn cd-pri" [disabled]="ocupado()" (click)="decidir('publicar')">Publicar <kbd>P</kbd></button>
                    <button type="button" class="cd-btn" [disabled]="ocupado()" (click)="pedirNota('recapturar')">Pedir otra foto <kbd>R</kbd></button>
                    <span class="cd-sp"></span>
                    <button type="button" class="cd-btn cd-ghost" [disabled]="ocupado()" (click)="pedirNota('descartar')">Descartar <kbd>D</kbd></button>
                  </div>
                }
                @if (aviso()) { <p class="cd-aviso" role="status">{{ aviso() }}</p> }
                <p class="cd-ayuda">Publicar = la ficha queda en el catálogo digital y suma a quien la levantó · Pedir otra foto = vuelve al celular con tu nota · Descartar = la captura no sirve; ni suma ni resta. «Confirmar hallazgo» llega con Incidencias.</p>
              </section>
            }
          </div>
        </app-load-state>
      } @else {
        <app-metric-strip [items]="kpisPub()" density="compact" [instant]="true" [ariaLabel]="respuestaPub()" />

        <div class="cd-busca">
          <p-iconfield class="cd-buscar">
            <p-inputicon class="pi pi-search" />
            <input pInputText type="search" [value]="q()" (input)="alBuscar($any($event.target).value)"
                   placeholder="Buscar por nombre o SKU" aria-label="Buscar fichas publicadas por nombre o SKU" autocomplete="off" />
          </p-iconfield>
          <!-- Mientras la búsqueda viaja, la lista de abajo es la de ANTES: se dice, para no mezclar el texto nuevo con el resultado viejo. -->
          <span class="cd-buscando" role="status">{{ estadoBusqueda() ?? '' }}</span>
        </div>

        <app-load-state [loading]="cargandoPub() && !pub()" [error]="errorPub()" [isEmpty]="!!pub() && (pub()?.rows?.length ?? 0) === 0"
                        emptyIcon="pi-images" [emptyTitle]="vacioTitulo()" [emptyHint]="vacioPista()" (retry)="cargarPublicadas()">
          <div class="cd-md">
            <ul class="cd-lista" aria-label="Fichas publicadas en toda la red, la más reciente primero" [attr.aria-busy]="estadoBusqueda() ? true : null">
              @for (f of pub()?.rows ?? []; track f.id; let i = $index) {
                <li><button type="button" class="cd-fila" [class.on]="i === selPub()" [attr.aria-current]="i === selPub()" (click)="elegirPub(i)">
                  <span class="cd-fila-n">{{ f.name ?? f.sku }}</span>
                  <small>{{ unidad(f.unit_label, f.unit_factor) }} · {{ sucursal(f) }}</small>
                  <small>@if (f.published_at) { Publicada {{ f.published_at | date: 'd MMM, HH:mm' }} } @else { Publicada, sin fecha registrada }</small>
                </button></li>
              }
              <li class="cd-mas">
                @if (listaCambio()) {
                  <span class="cd-aviso" role="status">Se publicaron o reemplazaron fichas mientras recorrías la lista: puede faltar alguna.</span>
                  <button type="button" class="cd-link" (click)="recargarPublicadas()">Volver a cargar</button>
                } @else {
                  <span>Se muestran {{ pub()?.rows?.length ?? 0 | number }} de {{ pub()?.total ?? 0 | number }} en toda la red{{ qPub() ? ' que coinciden con «' + qPub() + '»' : '' }}.</span>
                  @if ((pub()?.total ?? 0) > (pub()?.rows?.length ?? 0)) {
                    <button type="button" class="cd-link" (click)="masPublicadas()">Ver más</button>
                  }
                }
                <span class="cd-teclas"><kbd>↑</kbd> <kbd>↓</kbd> para moverte entre fichas</span>
                @if (avisoPub()) { <span class="cd-aviso" role="status">{{ avisoPub() }}</span> }
              </li>
            </ul>

            @if (actualPub(); as f) {
              <section class="cd-ficha" aria-live="polite">
                <div class="cd-ficha-head">
                  <h2>{{ f.name ?? f.sku }}</h2>
                  <span class="cd-meta">{{ f.sku }} · {{ unidad(f.unit_label, f.unit_factor) }} · {{ sucursal(f) }}</span>
                </div>
                <dl class="cd-kv">
                  <dt>Levantada</dt>
                  <dd>{{ f.captured_by ?? 'sin nombre' }} · {{ f.captured_at | date: 'd MMM y, HH:mm' }} · {{ sucursal(f) }}</dd>
                  <dt>Publicada</dt>
                  <dd>@if (f.published_at || f.published_by) {
                      {{ f.published_by ?? 'sin nombre registrado' }} · @if (f.published_at) { {{ f.published_at | date: 'd MMM y, HH:mm' }} } @else { sin fecha registrada }
                    } @else { sin registro de quién ni cuándo (ficha anterior al registro) }</dd>
                </dl>

                <ng-container *ngTemplateOutlet="fotosTpl; context: { $implicit: f }" />
                <ng-container *ngTemplateOutlet="keplerTpl; context: { $implicit: f }" />

                <p class="cd-ia">{{ ia(f.ai_reading) }}</p>
                <!-- Lo decide D19 del plan (cómo llega la foto y si reemplaza la imagen que ya existe). -->
                <p class="cd-ayuda">Todavía no llega al portal ni al verificador: falta decidir si esta foto reemplaza la imagen que ya tienen.</p>
              </section>
            }
          </div>
        </app-load-state>
      }
    </div>

    <!-- Las fotos y el dato de Kepler son los mismos en las dos secciones: una sola plantilla para cada uno. -->
    <ng-template #fotosTpl let-f>
      <div class="cd-fotos">
        @for (p of f.photos; track p.face) {
          @if (p.url) {
            <button type="button" class="cd-foto" (click)="ampliar(f, p.face)" [attr.aria-label]="'Ampliar ' + caraTexto(p.face)">
              <img [src]="p.url" [alt]="caraTexto(p.face) + ' de ' + (f.name ?? f.sku)" loading="lazy" />
              <span>{{ caraTexto(p.face) }}</span>
            </button>
          } @else if (p.skipped_reason) {
            <div class="cd-foto cd-foto-sin"><span>{{ caraTexto(p.face) }}</span><small>Saltada: {{ saltoTexto(p.skipped_reason) }}</small></div>
          } @else {
            <!-- La foto existe pero el servidor no la pudo firmar (p. ej. sin almacenamiento configurado): no es un salto. -->
            <div class="cd-foto cd-foto-sin"><span>{{ caraTexto(p.face) }}</span><small>Guardada, no se puede mostrar aquí</small></div>
          }
        }
      </div>
    </ng-template>

    <ng-template #keplerTpl let-f>
      <dl class="cd-kv">
        <dt>Código escaneado</dt><dd class="cd-mono">{{ f.scanned_code ?? 'ninguno (entró por el buscador)' }}</dd>
        <dt>En Kepler ({{ sucursal(f) }})</dt>
        <dd>{{ f.unit_label ?? 'sin rótulo' }} · factor {{ f.unit_factor ?? 'sin capturar' }} · código de barras <span class="cd-mono">{{ escaneables(f).length ? escaneables(f).join(', ') : 'ninguno' }}</span>
          @if (internas(f) > 0) { <span class="cd-meta"> · {{ internas(f) }} clave{{ internas(f) === 1 ? '' : 's' }} interna{{ internas(f) === 1 ? '' : 's' }} de Kepler (no se escanean)</span> }</dd>
      </dl>
    </ng-template>

    <!-- Ampliar sin salir: el visor compartido (zoom, girar, pantalla completa, flechas entre caras) en una ventana.
         Antes la foto se abría en otra pestaña; el visor conserva ese botón por si hace falta. -->
    <p-dialog [visible]="!!visor()" (visibleChange)="!$event && cerrarVisor()" [modal]="true" [dismissableMask]="true"
              [draggable]="false" appendTo="body" [style]="{ width: '56rem', maxWidth: '96vw' }" [header]="visor()?.titulo ?? ''">
      @if (visor(); as v) {
        <div class="cd-visor"><app-doc-viewer [files]="v.files" [(idx)]="visorIdx" emptyTitle="Sin foto" emptyHint="Esta cara se saltó al levantar." /></div>
      }
    </p-dialog>
  `,
  styles: [`
    :host { display: block; }
    .cd-sub { margin: var(--sp-1) 0 0; color: var(--fg-2); font-size: var(--fs-sm); display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .cd-seccion { margin: var(--sp-3) 0; }
    .cd-filtros { display: flex; gap: var(--sp-1); flex-wrap: wrap; margin: var(--sp-3) 0; }
    .cd-busca { margin: var(--sp-3) 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-3); }
    .cd-buscar { flex: 1 1 16rem; max-width: 28rem; }
    .cd-buscar input { width: 100%; }
    .cd-buscando { font-size: var(--fs-xs); color: var(--fg-2); }
    .cd-chip { min-height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-pill); background: var(--card-bg); color: var(--fg-2); font-size: var(--fs-xs); font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; }
    .cd-chip[aria-pressed='true'] { background: var(--fg-1); color: var(--card-bg); border-color: var(--fg-1); }
    .cd-chip:focus-visible, .cd-fila:focus-visible, .cd-btn:focus-visible, .cd-link:focus-visible, .cd-foto:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .cd-md { display: grid; grid-template-columns: minmax(240px, 300px) 1fr; gap: var(--sp-4); align-items: start; }
    @container (max-width: 47.5rem) { .cd-md { grid-template-columns: 1fr; } }
    .cd { container-type: inline-size; }
    .cd-lista { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-color); border-radius: var(--r-md); overflow: hidden; }
    .cd-fila { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: var(--sp-2) var(--sp-3); border: 0; border-bottom: 1px solid var(--border-color); background: var(--card-bg); color: var(--fg-1); text-align: left; cursor: pointer; }
    .cd-fila.on { background: var(--hover-bg); box-shadow: inset 3px 0 0 var(--fg-1); }
    .cd-fila-n { font-size: var(--fs-sm); font-weight: 600; }
    .cd-fila small { color: var(--fg-3); font-size: var(--fs-xs); }
    .cd-mas { padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--fg-3); display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); align-items: baseline; font-variant-numeric: tabular-nums; }
    .cd-teclas kbd, .cd-btn kbd { font-family: var(--font-mono, monospace); font-size: var(--fs-micro); border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
    /* Sólo en los botones (sobre fg-1 y action-ink). En la ayuda de teclas, con fg-3 debajo, la opacidad la dejaba en ~2.9:1. */
    .cd-btn kbd { opacity: .7; }
    .cd-link { border: 0; background: none; color: var(--fg-2); text-decoration: underline; cursor: pointer; font-size: var(--fs-xs); }
    .cd-ficha { border: 1px solid var(--border-color); border-radius: var(--r-md); padding: var(--sp-4); background: var(--card-bg); display: flex; flex-direction: column; gap: var(--sp-3); }
    .cd-ficha-head h2 { margin: 0; font-size: var(--fs-h3); }
    .cd-meta { font-size: var(--fs-xs); color: var(--fg-3); }
    .cd-frase { margin: 0; font-size: var(--fs-body); font-weight: 600; }
    .cd-fotos { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--sp-2); }
    .cd-foto { display: flex; flex-direction: column; gap: var(--sp-1); align-items: center; padding: 0; border: 0; background: none; font: inherit; color: var(--fg-2); font-size: var(--fs-xs); }
    button.cd-foto { cursor: zoom-in; }
    .cd-foto img { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; border-radius: var(--r-sm); border: 1px solid var(--border-color); background: var(--surface-ground); }
    .cd-foto-sin { justify-content: center; aspect-ratio: 3 / 4; border: 1px dashed var(--border-color); border-radius: var(--r-sm); text-align: center; padding: var(--sp-1); }
    .cd-foto-sin small { color: var(--fg-3); }
    .cd-kv { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-1) var(--sp-3); margin: 0; font-size: var(--fs-sm); }
    .cd-kv dt { color: var(--fg-3); }
    .cd-kv dd { margin: 0; }
    .cd-mono { font-family: var(--font-mono, monospace); font-size: var(--fs-xs); overflow-wrap: anywhere; }
    .cd-acciones { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
    .cd-sp { flex: 1; }
    .cd-btn { min-height: 36px; padding: 0 var(--sp-3); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--card-bg); color: var(--fg-1); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; display: inline-flex; gap: var(--sp-2); align-items: center; }
    .cd-btn:disabled { opacity: .5; cursor: not-allowed; }
    .cd-pri { background: var(--action); border-color: var(--action); color: var(--action-ink); }
    .cd-ghost { border-color: transparent; color: var(--fg-2); }
    .cd-nota { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--fg-2); }
    .cd-nota input { min-height: 36px; padding: 0 var(--sp-2); border: 1px solid var(--border-color); border-radius: var(--r-sm); background: var(--surface-ground); color: var(--fg-1); font-size: var(--fs-sm); }
    .cd-aviso { margin: 0; font-size: var(--fs-sm); }
    .cd-ia { margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .cd-ayuda { margin: 0; font-size: var(--fs-xs); color: var(--fg-3); }
    .cd-visor { height: min(75vh, 52rem); }
    /* En táctil, también «Ver más» y «Volver a cargar» (lo único que recorre el total) llegan a 44 px. */
    @media (pointer: coarse) {
      .cd-fila { min-height: var(--tap-min, 44px); }
      .cd-link { min-height: var(--tap-min, 44px); padding: 0 var(--sp-2); }
    }
  `],
})
export class ComprasCatalogoDigitalComponent implements OnInit {
  private readonly api = inject(CatalogoDigitalService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly tabs = CATALOGO_TABS;
  protected readonly motivos = MOTIVOS;

  /** La sección activa. `?seccion=publicadas` en la URL la abre directo (sin tocar las rutas). */
  protected readonly seccion = signal<SeccionCatalogoDigital>('revision');

  // ── Por revisar ────────────────────────────────────────────────────────────────────────────────
  protected readonly datos = signal<RevisionBandeja | null>(null);
  protected readonly cargando = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly cargadoEn = signal<Date | null>(null);
  protected readonly motivo = signal<RevisionMotivo | null>(null);
  protected readonly sel = signal(0);
  protected readonly ocupado = signal(false);
  protected readonly aviso = signal<string | null>(null);
  protected readonly pidiendoNota = signal<'recapturar' | 'descartar' | null>(null);
  protected readonly nota = signal('');

  protected readonly actual = computed<RevisionFicha | null>(() => this.datos()?.rows?.[this.sel()] ?? null);
  /** «Todas» = la suma sin filtro: con un motivo puesto, `total` es el del filtro. */
  private readonly totalSinFiltro = signal(0);
  protected readonly totalBandeja = computed(() => this.totalSinFiltro());
  protected readonly kpis = computed<MetricStripItem[]>(() => {
    const d = this.datos();
    if (!d) return [];
    return [
      { label: 'Por revisar', value: this.totalSinFiltro(), format: 'number', sub: 'fichas levantadas que esperan decisión' },
      { label: 'Sin lectura de la IA', value: d.counts.sin_analizar, format: 'number', sub: 'la IA está apagada en el piloto' },
    ];
  });

  // ── Publicadas ─────────────────────────────────────────────────────────────────────────────────
  protected readonly pub = signal<FichasPublicadas | null>(null);
  protected readonly cargandoPub = signal(false);
  protected readonly errorPub = signal<string | null>(null);
  protected readonly avisoPub = signal<string | null>(null);
  protected readonly selPub = signal(0);
  protected readonly q = signal('');
  /**
   * La búsqueda con la que se pidió lo que está en `pub()`. El vacío y el «Se muestran» hablan de ÉSA, no de lo que
   * se está tecleando: mientras la nueva viaja, la lista de abajo sigue siendo la de antes.
   */
  protected readonly qPub = signal('');
  /** «Ver más» encontró la lista movida (se publicó o se reemplazó una entre dos páginas): se dice, no se afirma «N de N». */
  protected readonly listaCambio = signal(false);
  /** Total de la red SIN búsqueda (para el conteo del control). null = todavía no se midió: no se dibuja un 0. */
  private readonly totalPubRed = signal<number | null>(null);

  protected readonly actualPub = computed<FichaPublicada | null>(() => this.pub()?.rows?.[this.selPub()] ?? null);
  protected readonly kpisPub = computed<MetricStripItem[]>(() => {
    const c = this.pub()?.coverage;
    return c ? kpisCobertura(c) : [];
  });
  protected readonly respuestaPub = computed(() => {
    const c = this.pub()?.coverage;
    return c ? respuestaCobertura(c) : 'Fichas publicadas';
  });
  protected readonly vacioTitulo = computed(() => {
    const q = this.qPub();
    return q ? 'Ninguna ficha publicada coincide con «' + q + '»' : 'Todavía no hay fichas publicadas';
  });
  protected readonly vacioPista = computed(() =>
    this.qPub() ? 'Prueba con otra parte del nombre o con el SKU.' : 'Aparecen aquí cuando Catálogo publica una ficha desde Por revisar.');
  /**
   * Qué está pasando con la búsqueda, cuando lo que se ve no corresponde a lo tecleado (o se está volviendo a
   * pedir). null = lo que se ve es la respuesta de lo que está en la caja. Todas las señales se leen siempre.
   */
  protected readonly estadoBusqueda = computed<string | null>(() => {
    const q = this.q().trim();
    const de = this.qPub();
    const cargando = this.cargandoPub();
    const hay = this.pub() !== null;
    const fallo = this.errorPub() !== null;
    if (!hay || fallo) return null;
    if (q !== de) return q ? 'Buscando «' + q + '»…' : 'Volviendo a la lista completa…';
    return cargando ? 'Actualizando…' : null;
  });

  /**
   * El control de arriba. El conteo de cada sección sólo cuando ya se midió (`undefined` ≠ 0, ADR-056).
   * Las tres señales se leen siempre, para que el computed no quede sin dependencias.
   */
  protected readonly secciones = computed<SegOption[]>(() => {
    const d = this.datos();
    const porRevisar = this.totalSinFiltro();
    const red = this.totalPubRed();
    return [
      { label: 'Por revisar', value: 'revision', count: d ? porRevisar : undefined },
      { label: 'Publicadas', value: 'publicadas', count: red ?? undefined },
    ];
  });

  // ── Visor de fotos (las dos secciones) ─────────────────────────────────────────────────────────
  protected readonly visor = signal<{ titulo: string; files: DocViewerFile[] } | null>(null);
  protected readonly visorIdx = signal(0);

  private espera: ReturnType<typeof setTimeout> | null = null;
  private consultaPub = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => { if (this.espera) clearTimeout(this.espera); });
  }

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('seccion') === 'publicadas') {
      this.seccion.set('publicadas');
      void this.cargarPublicadas();
    } else {
      void this.cargar();
    }
  }

  /**
   * Cambiar de sección VUELVE a pedir esa sección: quien acaba de publicar en Por revisar va a Publicadas a
   * verla, y una lista guardada de antes no la tendría.
   */
  protected cambiarSeccion(v: string): void {
    const s: SeccionCatalogoDigital = v === 'publicadas' ? 'publicadas' : 'revision';
    if (s === this.seccion()) return;
    this.seccion.set(s);
    this.pidiendoNota.set(null);
    this.aviso.set(null);
    void this.router.navigate([], {
      relativeTo: this.route, queryParams: { seccion: s === 'publicadas' ? 'publicadas' : null },
      queryParamsHandling: 'merge', replaceUrl: true,
    });
    void (s === 'publicadas' ? this.cargarPublicadas() : this.cargar());
  }

  async cargar(): Promise<void> {
    this.cargando.set(true);
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.api.bandeja({ reason: this.motivo(), limit: 30, offset: 0 }));
      this.datos.set(d);
      // El total SIN filtro lo manda el servidor: con un motivo puesto, «Todas» y el KPI también bajan al decidir.
      this.totalSinFiltro.set(d.total_all);
      this.cargadoEn.set(new Date());
      if (this.sel() >= d.rows.length) this.sel.set(Math.max(0, d.rows.length - 1));
    } catch (e) {
      this.error.set(this.mensajeDe(e, 'No se pudo cargar la bandeja.'));
    } finally {
      this.cargando.set(false);
    }
  }

  private masCargando = false;

  /** Un clic a la vez: dos con el mismo offset anexaban las mismas fichas dos veces. */
  async masFichas(): Promise<void> {
    const d = this.datos();
    if (!d || this.masCargando) return;
    this.masCargando = true;
    const motivo = this.motivo();
    try {
      const mas = await firstValueFrom(this.api.bandeja({ reason: motivo, limit: 30, offset: d.rows.length }));
      // Si mientras tanto cambió el filtro (o se recargó), estas filas son de OTRA lista: se tiran.
      if (this.motivo() !== motivo || this.datos() !== d) return;
      this.datos.set({ ...mas, rows: [...d.rows, ...mas.rows] });
      this.totalSinFiltro.set(mas.total_all);
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudieron cargar más fichas. Intenta de nuevo.'));
    } finally {
      this.masCargando = false;
    }
  }

  /**
   * `[NP.7.L.5]` Publicadas + la medición de la sucursal, en una llamada. Una respuesta que llega después de
   * otra búsqueda más nueva se tira: si no, la lista de «choco» pisaría la de «chocolate».
   */
  async cargarPublicadas(): Promise<void> {
    const yo = ++this.consultaPub;
    const q = this.q().trim();
    this.cargandoPub.set(true);
    this.errorPub.set(null);
    this.avisoPub.set(null);
    try {
      // ⚠️ Cada llamada (búsqueda, «Ver más») también recalcula la cobertura en el servidor (~0.5 s esperados, NO
      // MEDIDO), aunque no depende de q: pedirla una vez por entrada pide cambiar el contrato (decisión pendiente).
      const d = await firstValueFrom(this.api.publicadas({ q, limit: 30, offset: 0 }));
      if (yo !== this.consultaPub) return;
      this.pub.set(d);
      this.qPub.set(q);
      this.listaCambio.set(false);
      if (!q) this.totalPubRed.set(d.total);
      if (this.selPub() >= d.rows.length) this.selPub.set(Math.max(0, d.rows.length - 1));
    } catch (e) {
      if (yo === this.consultaPub) this.errorPub.set(this.mensajeDe(e, 'No se pudieron cargar las fichas publicadas.'));
    } finally {
      if (yo === this.consultaPub) this.cargandoPub.set(false);
    }
  }

  /** 250 ms después de dejar de teclear (el mismo ritmo que el buscador del levantamiento). */
  protected alBuscar(v: string): void {
    this.q.set(v);
    if (this.espera) clearTimeout(this.espera);
    this.espera = setTimeout(() => {
      this.espera = null;
      this.selPub.set(0);
      void this.cargarPublicadas();
    }, 250);
  }

  private masPubCargando = false;

  /** «Ver más»: la página siguiente de la MISMA búsqueda. Si la búsqueda cambió entre tanto, se tira. */
  async masPublicadas(): Promise<void> {
    const d = this.pub();
    if (!d || this.masPubCargando) return;
    this.masPubCargando = true;
    // La búsqueda de la lista que se VE (`qPub`), no lo que está en la caja: con la espera de 250 ms todavía
    // corriendo, la caja ya dice otra cosa y su página 2 se anexaría a la lista de antes.
    const q = this.qPub();
    const yo = this.consultaPub;
    try {
      const mas = await firstValueFrom(this.api.publicadas({ q, limit: 30, offset: d.rows.length }));
      if (this.pub() !== d || yo !== this.consultaPub || this.q().trim() !== q) return;
      const r = anexarPublicadas(d, mas);
      this.pub.set(r.datos);
      if (r.cambio) this.listaCambio.set(true);
    } catch (e) {
      this.avisoPub.set(this.mensajeDe(e, 'No se pudieron cargar más fichas. Intenta de nuevo.'));
    } finally {
      this.masPubCargando = false;
    }
  }

  /** «Volver a cargar» después de que la lista se movió: desde la primera página, con la misma búsqueda. */
  protected recargarPublicadas(): void {
    this.selPub.set(0);
    void this.cargarPublicadas();
  }

  protected filtrar(m: RevisionMotivo | null): void {
    this.motivo.set(m);
    this.sel.set(0);
    void this.cargar();
  }

  protected elegir(i: number): void {
    this.sel.set(i);
    this.pidiendoNota.set(null);
    this.aviso.set(null);
  }

  protected elegirPub(i: number): void { this.selPub.set(i); }

  /** Ampliar una cara sin salir de la pantalla: el visor recibe sólo las caras con foto (las saltadas no tienen). */
  protected ampliar(f: FichaComun, cara: string): void {
    const nombre = f.name ?? f.sku;
    const conFoto = f.photos.filter((p): p is RevisionFoto & { url: string } => !!p.url);
    this.visor.set({
      titulo: nombre,
      files: conFoto.map((p) => ({ url: p.url, role: this.caraTexto(p.face), name: this.caraTexto(p.face) + ' de ' + nombre, kind: 'image' })),
    });
    this.visorIdx.set(Math.max(0, conFoto.findIndex((p) => p.face === cara)));
  }

  protected cerrarVisor(): void { this.visor.set(null); }

  protected pedirNota(d: 'recapturar' | 'descartar'): void {
    this.nota.set('');
    this.pidiendoNota.set(d);
    // El cursor entra solo: el atajo R o D es para escribir la nota de inmediato, sin otro clic.
    setTimeout(() => (document.getElementById('cd-nota-input') as HTMLInputElement | null)?.focus(), 0);
  }

  /** Códigos que se pueden escanear (forma GS1). Las claves internas de Kepler (C…, CB…) sólo se cuentan. */
  protected escaneables(f: Pick<FichaComun, 'kepler_codes'>): string[] { return f.kepler_codes.filter((c) => /^([0-9]{8}|[0-9]{12,14})$/.test(c)); }
  protected internas(f: Pick<FichaComun, 'kepler_codes'>): number { return f.kepler_codes.length - this.escaneables(f).length; }

  protected confirmar(): void {
    const d = this.pidiendoNota();
    if (d && this.nota().trim()) void this.decidir(d);
  }

  /** Una decisión: el botón se apaga al primer clic (sin dobles envíos) y la ficha sale de la lista. */
  async decidir(d: RevisionDecision): Promise<void> {
    const f = this.actual();
    if (!f || this.ocupado() || this.seccion() !== 'revision') return;
    this.ocupado.set(true);
    this.aviso.set(null);
    try {
      await firstValueFrom(this.api.decidir(f.id, { decision: d, note: d === 'publicar' ? undefined : this.nota().trim() }));
      // Lo publicado cambia el conteo de «Publicadas»: el que había ya es viejo. Se deja sin número (no medido) hasta
      // volver a pedirlo; no se le suma 1 a mano, porque otro revisor pudo publicar al mismo tiempo.
      if (d === 'publicar') this.totalPubRed.set(null);
      this.pidiendoNota.set(null);
      this.nota.set('');
      await this.cargar();
    } catch (e) {
      this.aviso.set(this.mensajeDe(e, 'No se pudo guardar la decisión.'));
    } finally {
      this.ocupado.set(false);
    }
  }

  /**
   * Atajos: P / R / D y flechas en Por revisar; sólo flechas en Publicadas (es de sólo lectura). No se
   * disparan mientras se escribe, con el visor abierto (una P ahí publicaría la ficha de atrás) ni cuando otro
   * control ya atendió la tecla (las flechas del control segmentado cambian de sección, no de ficha).
   */
  @HostListener('document:keydown', ['$event'])
  protected alTeclear(e: KeyboardEvent): void {
    if (this.visor() || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.seccion() === 'publicadas') {
      const n = this.pub()?.rows?.length ?? 0;
      if (e.key === 'ArrowDown' && n) { this.elegirPub(Math.min(n - 1, this.selPub() + 1)); this.verFila(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && n) { this.elegirPub(Math.max(0, this.selPub() - 1)); this.verFila(); e.preventDefault(); }
      return;
    }
    const n = this.datos()?.rows?.length ?? 0;
    if (e.key === 'ArrowDown' && n) { this.elegir(Math.min(n - 1, this.sel() + 1)); this.verFila(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && n) { this.elegir(Math.max(0, this.sel() - 1)); this.verFila(); e.preventDefault(); }
    else if ((e.key === 'p' || e.key === 'P') && this.actual() && !this.pidiendoNota()) { void this.decidir('publicar'); }
    else if ((e.key === 'r' || e.key === 'R') && this.actual()) { this.pedirNota('recapturar'); e.preventDefault(); }
    else if ((e.key === 'd' || e.key === 'D') && this.actual()) { this.pedirNota('descartar'); e.preventDefault(); }
  }

  /** La fila elegida con flechas queda a la vista: con 30 fichas, la de abajo salía de la pantalla. */
  private verFila(): void {
    setTimeout(() => (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('.cd-fila.on')?.scrollIntoView?.({ block: 'nearest' }), 0);
  }

  protected texto(m: RevisionMotivo): string { return REVISION_MOTIVO_TEXTO[m]; }
  protected sucursal(f: { branch_name: string | null; branch_code: string }): string { return nombreSucursal(f); }
  protected ia(ai: FichaPublicada['ai_reading']): string { return lineaIa(ai); }
  protected caraTexto(c: string): string { return CARA[c] ?? c; }
  protected motivosTexto(f: RevisionFicha): string { return f.reasons.map((m) => REVISION_MOTIVO_TEXTO[m]).join(' · ') || 'Revisión normal'; }
  protected saltoTexto(m: string | null): string {
    return m === 'no_tiene_esa_cara' ? 'no tiene esa cara' : m === 'no_se_puede_girar' ? 'no se puede girar' : 'otro motivo';
  }
  protected unidad(label: string | null | undefined, factor: number | null | undefined): string {
    const r = String(label ?? '').trim().toUpperCase();
    const base = PALABRA[r] ?? (r ? r.toLowerCase() : 'presentación');
    return factor != null && factor > 1 ? base + ' de ' + factor : base;
  }

  /** La ficha en una frase (Q.2): qué se fotografió y qué falta decidir. */
  protected frase(f: RevisionFicha): string {
    // Una cara sin URL no es por fuerza un salto: puede ser una foto guardada que el servidor no pudo firmar.
    const saltos = f.photos.filter((p) => !!p.skipped_reason).length;
    const fotos = f.photos.length - saltos;
    const sinMostrar = f.photos.filter((p) => !p.skipped_reason && !p.url).length;
    const partes = [fotos + ' foto' + (fotos === 1 ? '' : 's') + ' de ' + this.unidad(f.unit_label, f.unit_factor)];
    if (saltos) partes.push(saltos + ' cara' + (saltos === 1 ? '' : 's') + ' saltada' + (saltos === 1 ? '' : 's'));
    if (sinMostrar) partes.push(sinMostrar + ' no se ' + (sinMostrar === 1 ? 'puede' : 'pueden') + ' mostrar aquí');
    if (!f.scanned_code) partes.push('entró por el buscador: revisa que sea el producto');
    else if (f.kepler_codes.length && !f.kepler_codes.includes(f.scanned_code)) partes.push('el código escaneado no está en esta unidad en Kepler');
    return partes.join(' · ') + '.';
  }

  private mensajeDe(e: unknown, porDefecto: string): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string | string[] } | null)?.message;
      if (typeof m === 'string' && m) return m;
      if (Array.isArray(m) && m.length) return m.join(' ');
    }
    return porDefecto;
  }
}
