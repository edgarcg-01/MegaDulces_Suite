import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LabelModel } from './components/label.component';

export interface SearchHit { product_id: string; sku: string | null; name: string; barcode: string | null; }

/**
 * `[ETQ-CAMBIOS.2]` Un cambio de precio, con su ANTES y su DESPUÉS. Sale de la bitácora nativa de
 * Kepler, la única fuente que guarda el precio anterior.
 *
 * `es_baja` = el precio nuevo es cero. No es rebaja: el ERP le quitó el precio, y esa etiqueta
 * diría SIN PRECIO. Se marca en vez de esconderse, porque es lo que hay que ir a ver al anaquel.
 */
export interface PriceChange {
  sku: string;
  name: string | null;
  unidad: string | null;
  precio_anterior: number | null;
  precio_nuevo: number | null;
  delta: number | null;
  es_baja: boolean;
  hora: string | null;
}
/** `[ETQ-CAMBIOS.6]` Una plaza que la bitácora SÍ puede servir. `ultimo_dia` deja ver de un
 *  vistazo si alguna se quedó atrás, sin tener que entrar a cada una. */
export interface PriceChangeBranch {
  sucursal: string;
  nombre: string | null;
  ultimo_dia: string;
}
export interface PriceChangesResult {
  items: PriceChange[];
  fecha: string;
  /** El backend alcanzó su tope. Se DICE en la pantalla; un recorte mudo se lee como "no hubo más". */
  truncado: boolean;
  /**
   * Hasta qué día llegó la bitácora. Sin esto, "ese día no cambió nada" y "ese día todavía no
   * llegó" se ven idénticos en la pantalla, y son lo contrario.
   */
  fuente_al: string | null;
  /**
   * `[ETQ-CAMBIOS.4]` Cuántos movimientos de **un centavo** se ocultaron ese día. Medido: son el
   * 41.9% de la semana y el 93% de un domingo, de 116 SKUs que oscilan ~36 veces cada uno. Se
   * filtran porque no justifican caminar al anaquel, pero el número VIAJA: un filtro mudo que se
   * lleva casi todo se lee como "no hubo cambios".
   */
  ocultos_centavo: number;
  freshness: Freshness | null;
}

/**
 * [OBS.6.2] Qué tan viejo es el precio que se está por imprimir.
 *
 * El 2026-09-02 el carril del ODS llevaba 6 días parado y esta pantalla imprimió precios de hace
 * una semana sin decir nada — uno de ellos 54% bajo costo. No bloquea: declara.
 *
 * [VP.2.1] El tipo estaba re-declarado a mano acá (copia del de `libs/commercial/.../freshness.ts`,
 * a tres días de que naciera). Ahora los dos lados importan la MISMA forma de
 * `@megadulces/contracts` → un cambio de shape es error de compilación en ambos, en vez de dos
 * definiciones que se separan en silencio.
 *
 * `status: 'unknown'` = no se pudo medir. Llega con `stale: true` a propósito: antes llegaba con
 * `stale: false` y la pantalla callaba, que es el silencio que la fase vino a matar.
 */
export type { Freshness, FreshnessInput, FreshnessStatus } from '@megadulces/contracts';
import type { Freshness } from '@megadulces/contracts';

export interface ResolveResult { labels: LabelModel[]; not_found: string[]; freshness?: Freshness; }

@Injectable({ providedIn: 'root' })
export class EtiquetasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/labels`;

  search(q: string): Observable<SearchHit[]> {
    return this.http.get<SearchHit[]>(`${this.base}/search`, { params: { q } });
  }

  /**
   * `[NORM.3]` `sucursal` = la tienda para la que se imprime. El precio de Kepler es POR PLAZA
   * (1,039 SKUs con precio de pieza distinto entre plazas retail, 1,164 grupos de mayoreo de
   * paquete), y hasta ahora la etiqueta salía con la moda entre las ocho.
   *
   * Se manda la que tiene el usuario (`warehouse_code`). Si no tiene ninguna —un rol global— va
   * sin ella y el backend responde la forma consolidada de siempre: sin plaza no hay a qué
   * seguir, y **declararlo es mejor que elegir una tienda al azar**.
   */
  resolve(codes: string[], sucursal?: string | null): Observable<ResolveResult> {
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : null;
    return this.http.post<ResolveResult>(`${this.base}/resolve`, suc ? { codes, sucursal: suc } : { codes });
  }

  /**
   * `[ETQ-CAMBIOS.1]` Los productos cuyo precio cambió en esta tienda, para reimprimir.
   *
   * ⛔ Sin plaza la respuesta viene VACÍA, y es correcto: el reloj de cambio es por
   * (producto, sucursal). Mezclar plazas diría que cambió algo que en TU tienda no cambió.
   */
  priceChanges(sucursal: string | null, fecha: string): Observable<PriceChangesResult> {
    const suc = /^[0-9]{2}$/.test(String(sucursal ?? '')) ? String(sucursal) : '';
    return this.http.get<PriceChangesResult>(
      `${this.base}/price-changes?sucursal=${encodeURIComponent(suc)}&fecha=${encodeURIComponent(fecha)}`);
  }

  /**
   * `[ETQ-CAMBIOS.6]` Las plazas que la bitácora puede servir. Sólo la necesita quien NO tiene
   * tienda propia; quien la tiene queda anclado a la suya y nunca ve este selector.
   */
  priceChangeBranches(): Observable<PriceChangeBranch[]> {
    return this.http.get<PriceChangeBranch[]>(`${this.base}/price-changes/branches`);
  }
}
