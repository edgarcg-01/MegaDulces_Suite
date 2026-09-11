import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, from, of, switchMap } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { OfflineDatabaseService } from '../../core/services/offline-database.service';
// `[TDA.4]` El escalón de mayoreo y su forma de cable salen del vocabulario común: el backend
// los emite y esta pantalla los consume —en vivo y desde el respaldo— con UNA definición.
import { type MayoreoTier, type MayoreoTierCompacto, expandirTier } from '@megadulces/contracts';

/** Se reexporta para que la pantalla lo importe de acá, junto al servicio que lo entrega. */
export type { MayoreoTier } from '@megadulces/contracts';

/** Una unidad de venta con su precio (PZA, PAQUETE, CAJA...). Espejo de KpService.UnidadPrecio. */
export interface UnidadPrecio {
  u: string;
  precio_con_iva: number;
  precio_sin_iva: number;
  factor: number;
}

/** Lo que la pantalla necesita mostrar de un producto. */
export interface ProductoPrecio {
  codigo: string;
  nombre: string;
  unidades: UnidadPrecio[];
  iva_pct: number | null;
  ieps_pct: number | null;
  /**
   * `[TDA.4]` Los escalones de mayoreo. **Vacío = no hay mayoreo que se pueda afirmar**, no
   * "no se consultó": el backend descarta el tier sin umbral real en vez de inventar uno.
   */
  mayoreo: MayoreoTier[];
  /** Gramaje de la etiqueta ("50 g"), o `null` si el catálogo no lo tiene. */
  contenido: string | null;
  /**
   * `[TDA.8]` La llave con la que viaja el aviso `label_prices_changed`.
   *
   * **`null` NO significa "no cambió": significa "no se puede saber".** Llega en null desde el
   * respaldo (el snapshot no lo lleva) y cuando el código no casó una fila de etiqueta. La
   * pantalla trata ese caso como el `truncated` del evento — no se puede descartar que le hable
   * a ella, así que se verifica en vez de callarse (ADR-056).
   */
  product_id: string | null;
}

/**
 * De dónde salió el precio que se está mostrando. Es parte del resultado, no un
 * detalle interno: la pantalla tiene que poder decirlo (DESIGN §PWA 5 — "sin
 * conexión" nunca falla en silencio).
 *
 *  - `live`     → lo contestó el ODS ahora mismo.
 *  - `respaldo` → salió del snapshot local; el precio puede haber cambiado.
 */
export type OrigenPrecio = 'live' | 'respaldo';

/**
 * `[TDA.2]` Con qué se calculó el precio que se está mostrando (ADR-056).
 *
 * `origen` ya decía de DÓNDE viene el dato (vivo o respaldo). Esto dice algo distinto y que faltaba:
 * si el número es el de la plaza o uno que varía entre plazas, y si lo corrigió una persona.
 *
 * Todos opcionales: el camino del respaldo (snapshot en IndexedDB) no los trae, y ausencia se lee
 * como "no aplica", nunca como "todo bien".
 */
export interface ProcedenciaPrecio {
  /**
   * `[TDA.3]` La UNIDAD del código que se escaneó (`PZA`/`PAQ`/`CJA`/`KG`…), o `null` si el código
   * no dice de qué unidad es (el SKU mismo, o un código interno de Kepler).
   *
   * Es lo que hace que el precio grande responda a lo que se escaneó. Antes el número grande era
   * SIEMPRE el de la unidad base: escanear la caja mostraba el precio de la pieza.
   *
   * ⚠️ Su techo está medido: **10,771 de 11,506 SKUs (93.6 %) tienen UNA sola unidad registrada**,
   * así que en 9 de cada 10 escaneos esto devuelve la única que hay y no expresa ninguna elección.
   */
  unidadEscaneada?: string | null;
  /** La unidad de factor 1 — a ella se refieren los `factor` de las demás. */
  unidadBase?: string | null;
  /** El precio varía entre plazas y no se pudo acotar a una. */
  precioAmbiguo?: boolean;
  /** Cuántos precios distintos hay entre plazas para este código. */
  plazasDistintas?: number;
  /** Se pidió una plaza y esa plaza no tiene el producto (existe en otras). */
  plazaSinDato?: boolean;
  /** `override_manual` = alguien lo corrigió a mano; es el que se imprime en el anaquel. */
  origenPrecio?: 'kepler' | 'override_manual';
}

export type ResultadoBusqueda =
  | ({ estado: 'encontrado'; origen: OrigenPrecio; producto: ProductoPrecio; snapshotAl: string | null } & ProcedenciaPrecio)
  | { estado: 'no_encontrado'; origen: OrigenPrecio; codigo: string; snapshotAl: string | null }
  | { estado: 'sin_datos'; codigo: string };

/** Sucursal vigente + frescura del ODS de esa plaza (`datos_al` lo calcula el backend). */
export interface SucursalVerificador {
  codigo: string;
  nombre: string;
  direccion: string;
  ciudad: string;
  almacenes: string[];
  datos_al: string | null;
}

/** Un renglón del snapshot, tal como lo serializa `KpService.getPreciosTodos`. */
interface SnapshotItem {
  c: string;
  b: string[];
  /**
   * `[TDA.3]` La UNIDAD de cada barcode, en el mismo índice que `b`. `null` = ese código no dice
   * de qué unidad es (el SKU mismo, o `c96`, que trae códigos internos de Kepler).
   *
   * Opcional porque un respaldo descargado ANTES de este cambio no lo trae. Ausente se lee como
   * "no sé de qué unidad es", que degrada al comportamiento viejo (precio de la unidad base) —
   * nunca como "es la base". Los kioscos lo ganan solos al vencer el TTL de 12 h.
   */
  bu?: (string | null)[];
  n: string;
  u: Array<{ u: string; p: number; s: number }>;
  /**
   * `[TDA.4]` Mayoreo, con las claves cortas del cable. Opcional: un respaldo descargado antes
   * de este cambio no lo trae, y ausente se lee como "este respaldo no sabe de mayoreo" —
   * degrada al comportamiento anterior, nunca a un tier inventado.
   */
  m?: MayoreoTierCompacto[];
  /** Gramaje. */
  g?: string;
}

interface SnapshotPayload {
  total: number;
  sucursal: string | null;
  generado: string;
  productos: SnapshotItem[];
}

/** Estado del respaldo local, para pintarlo en la pantalla. */
export interface EstadoSnapshot {
  sucursal: string;
  total: number;
  generado: string;
  descargadoAl: string;
}

/** Cuánto se espera al ODS antes de caer al respaldo. En mostrador, 2.5s ya es una eternidad. */
const TIMEOUT_LIVE_MS = 2500;

/** Un respaldo más viejo que esto se re-descarga solo al entrar (elección de Edgar, CV.24). */
const SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Verificador de precios de mostrador (`/tienda/verificador`).
 *
 * Consume los endpoints que YA existen en `apps/api` (`KpModule`, absorbido del app
 * standalone en el consolidado del 2026-09-08): `/api/kp/precio`,
 * `/api/kp/precios-todos` y `/api/sucursales`. Los tres derivan de `kepler_ods.*`
 * (regla #1: derive-no-copy) y son públicos porque el kiosco no tiene con quién
 * autenticarse. Acá NO se crea conexión ni backend nuevo.
 *
 * **Híbrido, con el orden que importa:** cada consulta va primero al ODS y sólo cae al
 * respaldo local cuando la red falla o tarda más de 2.5s. Un "no encontrado" que
 * contesta el servidor es autoritativo y NO se re-pregunta al respaldo: el ODS sabe
 * más que un snapshot de hace horas.
 *
 * El respaldo es un snapshot por SUCURSAL en IndexedDB (Dexie, la misma base offline de
 * la app). Por sucursal porque el mismo código tiene precio distinto entre plazas.
 */
@Injectable({ providedIn: 'root' })
export class VerificadorService {
  private readonly http = inject(HttpClient);
  private readonly offline = inject(OfflineDatabaseService);

  private readonly base = environment.apiUrl;

  /** Índice en memoria del snapshot cargado (clave interna y códigos de barras → producto). */
  private indice = new Map<string, SnapshotItem>();
  /** `[TDA.3]` código de barras → UNIDAD a la que pertenece. Ver `armarIndice`. */
  private indiceUnidad = new Map<string, string>();
  private indiceDe: string | null = null;

  /** Estado del respaldo de la sucursal activa. `null` = no hay respaldo descargado. */
  readonly snapshot = signal<EstadoSnapshot | null>(null);

  /** Sucursales vigentes con su frescura de ODS. */
  sucursales(): Observable<SucursalVerificador[]> {
    return this.http.get<SucursalVerificador[]>(`${this.base}/sucursales`);
  }

  /**
   * Precio de un producto: ODS primero, respaldo después.
   *
   * `[TDA.2]` La sucursal ahora VIAJA al live, no sólo elige el snapshot.
   *
   * Antes `/api/kp/precio` no la tomaba: buscaba el código en el ODS y devolvía la primera fila,
   * en orden arbitrario. Como `kdii` trae una fila por plaza y **712 de 9,348 códigos (7.6 %,
   * medido en prod el 2026-09-09) tienen precio distinto entre plazas**, el precio del mostrador
   * podía cambiar solo cada vez que una sucursal se re-sincronizaba, y podía ser el de CEDIS — la
   * fila que la etiquetera excluye a propósito. O sea: el respaldo local, que sí elegía plaza, era
   * MÁS preciso que la consulta en vivo.
   *
   * Ahora el live contesta la plaza pedida, y cuando no se puede acotar lo **declara**
   * (`precio_ambiguo`) en vez de publicar un número inestable como si fuera el único.
   */
  buscar(codigo: string, sucursal: string | null): Observable<ResultadoBusqueda> {
    const q = (codigo || '').trim();
    if (!q) return of({ estado: 'sin_datos' as const, codigo: q });

    const params: Record<string, string> = { q };
    if (sucursal) params['sucursal'] = sucursal;

    return this.http.get<any>(`${this.base}/kp/precio`, { params }).pipe(
      timeout(TIMEOUT_LIVE_MS),
      map((r): ResultadoBusqueda => {
        // El backend contesta 200 con `ok:false` cuando no lo encuentra — no es un error
        // de red, es una respuesta. Se respeta tal cual.
        if (!r?.ok) {
          return { estado: 'no_encontrado', origen: 'live', codigo: q, snapshotAl: this.snapshot()?.generado ?? null };
        }
        return {
          estado: 'encontrado',
          origen: 'live',
          snapshotAl: null,
          producto: {
            codigo: String(r.codigo ?? q),
            nombre: String(r.nombre ?? ''),
            unidades: Array.isArray(r.unidades) ? r.unidades : [],
            iva_pct: r.iva_pct ?? null,
            ieps_pct: r.ieps_pct ?? null,
            // `[TDA.4]` Vienen computados y filtrados por el backend: la pantalla pinta, no decide.
            mayoreo: Array.isArray(r.mayoreo) ? r.mayoreo : [],
            contenido: r.contenido ?? null,
            // `[TDA.8]` La llave del aviso en vivo. El backend la publica desde la misma fila de
            // etiqueta de la que sale el mayoreo.
            product_id: r.product_id ?? null,
          },
          // `[TDA.2]` Procedencia del número: de qué plaza salió, si varía entre plazas, y si lo
          // corrigió una persona (ese override es el que se imprime en el anaquel, y el mostrador
          // lo tenía invisible porque leía el ERP crudo).
          precioAmbiguo: r.precio_ambiguo === true,
          plazasDistintas: Number(r.plazas_con_precio_distinto) || 1,
          plazaSinDato: r.plaza_pedida_sin_dato === true,
          origenPrecio: r.origen_precio === 'override_manual' ? 'override_manual' : 'kepler',
          // `[TDA.3]` De qué unidad es el código escaneado. Lo resuelve el backend contra la misma
          // fila de la que sale el precio, así que unidad y precio no pueden discrepar.
          unidadEscaneada: r.unidad_escaneada ?? null,
          unidadBase: r.unidad_base ?? null,
        };
      }),
      // Sin red / timeout / 5xx → respaldo. Si tampoco hay respaldo, se dice.
      catchError(() => from(this.buscarEnRespaldo(q, sucursal))),
    );
  }

  /** Resuelve un código contra el snapshot local de esa sucursal. */
  private async buscarEnRespaldo(codigo: string, sucursal: string | null): Promise<ResultadoBusqueda> {
    const suc = sucursal;
    if (!suc) return { estado: 'sin_datos', codigo };

    const cargado = await this.cargarIndice(suc);
    if (!cargado) return { estado: 'sin_datos', codigo };

    const snapAl = this.snapshot()?.generado ?? null;
    const item = this.indice.get(codigo) ?? this.indice.get(codigo.replace(/^0+/, '')) ?? this.indice.get(codigo.padStart(5, '0'));
    if (!item) return { estado: 'no_encontrado', origen: 'respaldo', codigo, snapshotAl: snapAl };

    const unidades = (item.u || []).map((x) => ({ u: x.u, precio_con_iva: x.p, precio_sin_iva: x.s, factor: 1 }));
    // `[TDA.3]` La unidad del código escaneado, del segundo índice del snapshot. Se busca con las
    // mismas tres formas del código que el índice principal, o un pad distinto perdería la unidad
    // aunque el producto sí se haya encontrado.
    const uEsc =
      this.indiceUnidad.get(codigo) ??
      this.indiceUnidad.get(codigo.replace(/^0+/, '')) ??
      this.indiceUnidad.get(codigo.padStart(5, '0')) ??
      null;

    return {
      estado: 'encontrado',
      origen: 'respaldo',
      snapshotAl: snapAl,
      producto: {
        codigo: item.c,
        nombre: item.n,
        unidades,
        // El snapshot no lleva las tasas: el respaldo declara lo que tiene, no inventa un 0.
        iva_pct: null,
        ieps_pct: null,
        // `[TDA.4]` Se expande con la inversa que vive junto a su compresora, en el contrato.
        mayoreo: (item.m || []).map(expandirTier),
        contenido: item.g ?? null,
        // `[TDA.8]` El snapshot NO lleva product_id y no se inventa uno: desde el respaldo la
        // pantalla no puede casar un aviso, y eso se DECLARA con null. En la práctica casi no
        // pasa —si estás en respaldo es porque no hay red, y sin red no hay socket— pero el
        // camino tiene que decir la verdad igual, no apoyarse en que la otra falla lo tape.
        product_id: null,
      },
      // Sólo se afirma la unidad si además tiene precio en este respaldo: decir "escaneaste CJA"
      // y no poder mostrar el precio de CJA sería peor que no decir nada.
      unidadEscaneada: uEsc && unidades.some((x) => x.u === uEsc) ? uEsc : null,
      unidadBase: unidades[0]?.u ?? null,
    };
  }

  /**
   * Deja el respaldo listo: lo lee de IndexedDB y lo re-descarga si falta o si ya pasó
   * su TTL de 12h. Devuelve el estado resultante (o `null` si no se pudo armar ninguno).
   */
  asegurarSnapshot(sucursal: string): Observable<EstadoSnapshot | null> {
    return from(this.offline.getSnapshotPrecios(sucursal)).pipe(
      switchMap((guardado) => {
        if (guardado?.datos) {
          const payload = guardado.datos as SnapshotPayload;
          const estado: EstadoSnapshot = {
            sucursal,
            total: payload.total ?? payload.productos?.length ?? 0,
            generado: payload.generado,
            descargadoAl: guardado.ultima_sincronizacion,
          };
          this.snapshot.set(estado);
          const edad = Date.now() - Date.parse(guardado.ultima_sincronizacion);
          const vencido = !Number.isFinite(edad) || edad > SNAPSHOT_TTL_MS;
          if (!vencido || !navigator.onLine) return of(estado);
          // Vencido: se intenta refrescar, pero el viejo sirve igual si la bajada falla.
          return this.descargarSnapshot(sucursal).pipe(catchError(() => of(estado)));
        }
        if (!navigator.onLine) return of(null);
        return this.descargarSnapshot(sucursal).pipe(catchError(() => of(null)));
      }),
    );
  }

  /** Baja el catálogo completo de esa sucursal y lo persiste. Es la acción del botón. */
  descargarSnapshot(sucursal: string): Observable<EstadoSnapshot> {
    return this.http.get<SnapshotPayload>(`${this.base}/kp/precios-todos`, { params: { sucursal } }).pipe(
      switchMap((payload) => {
        if (!payload?.productos?.length) throw new Error('El catálogo llegó vacío');
        return from(
          this.offline.guardarSnapshotPrecios(sucursal, payload, payload.generado).then(() => {
            const estado: EstadoSnapshot = {
              sucursal,
              total: payload.total ?? payload.productos.length,
              generado: payload.generado,
              descargadoAl: new Date().toISOString(),
            };
            this.snapshot.set(estado);
            this.armarIndice(sucursal, payload);
            return estado;
          }),
        );
      }),
    );
  }

  /** Carga el índice en memoria desde IndexedDB si hace falta. `false` = no hay respaldo. */
  private async cargarIndice(sucursal: string): Promise<boolean> {
    if (this.indiceDe === sucursal && this.indice.size) return true;
    const guardado = await this.offline.getSnapshotPrecios(sucursal);
    if (!guardado) return false;
    const payload = guardado.datos as SnapshotPayload | undefined;
    if (!payload?.productos?.length) return false;
    this.snapshot.set({
      sucursal,
      total: payload.total ?? payload.productos.length,
      generado: payload.generado,
      descargadoAl: guardado.ultima_sincronizacion,
    });
    this.armarIndice(sucursal, payload);
    return true;
  }

  /**
   * Indexa por clave interna Y por cada código de barras. Kepler no tiene "una" columna
   * de código de barras: tiene cinco casillas y el capturista usa la que encuentra libre
   * (`KpService.COLS_PRECIO`), así que el snapshot trae todas y todas tienen que resolver.
   */
  private armarIndice(sucursal: string, payload: SnapshotPayload): void {
    const m = new Map<string, SnapshotItem>();
    const u = new Map<string, string>();
    for (const it of payload.productos) {
      if (it.c) {
        m.set(it.c, it);
        // La clave viaja con ceros a la izquierda (LPAD 5). El escáner y el teclado
        // dan la forma corta, así que se indexan las dos.
        const corta = it.c.replace(/^0+/, '');
        if (corta && !m.has(corta)) m.set(corta, it);
      }
      const bcs = it.b || [];
      for (let i = 0; i < bcs.length; i++) {
        const b = bcs[i];
        if (!b) continue;
        if (!m.has(b)) m.set(b, it);
        // `[TDA.3]` Segundo índice: código → UNIDAD. Es lo que le faltaba al modo offline para
        // contestar lo mismo que el modo en línea; sin esto el kiosco sin red mostraba siempre el
        // precio de la unidad base, aunque se hubiera escaneado la caja.
        const unidad = it.bu?.[i];
        if (unidad && !u.has(b)) u.set(b, unidad);
      }
    }
    this.indice = m;
    this.indiceUnidad = u;
    this.indiceDe = sucursal;
  }
}
