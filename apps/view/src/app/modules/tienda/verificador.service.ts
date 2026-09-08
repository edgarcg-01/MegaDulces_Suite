import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, from, of, switchMap } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { OfflineDatabaseService } from '../../core/services/offline-database.service';

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

export type ResultadoBusqueda =
  | { estado: 'encontrado'; origen: OrigenPrecio; producto: ProductoPrecio; snapshotAl: string | null }
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
  n: string;
  u: Array<{ u: string; p: number; s: number }>;
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
   * `sucursal` sólo se usa para elegir el snapshot: `/api/kp/precio` no toma sucursal
   * (busca el código en el ODS y devuelve la primera fila), así que el respaldo puede
   * traer un precio de plaza más preciso que el live. Eso está declarado en la pantalla.
   */
  buscar(codigo: string, sucursal: string | null): Observable<ResultadoBusqueda> {
    const q = (codigo || '').trim();
    if (!q) return of({ estado: 'sin_datos' as const, codigo: q });

    return this.http.get<any>(`${this.base}/kp/precio`, { params: { q } }).pipe(
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
          },
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

    return {
      estado: 'encontrado',
      origen: 'respaldo',
      snapshotAl: snapAl,
      producto: {
        codigo: item.c,
        nombre: item.n,
        unidades: (item.u || []).map((x) => ({ u: x.u, precio_con_iva: x.p, precio_sin_iva: x.s, factor: 1 })),
        // El snapshot no lleva las tasas: el respaldo declara lo que tiene, no inventa un 0.
        iva_pct: null,
        ieps_pct: null,
      },
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
    for (const it of payload.productos) {
      if (it.c) {
        m.set(it.c, it);
        // La clave viaja con ceros a la izquierda (LPAD 5). El escáner y el teclado
        // dan la forma corta, así que se indexan las dos.
        const corta = it.c.replace(/^0+/, '');
        if (corta && !m.has(corta)) m.set(corta, it);
      }
      for (const b of it.b || []) if (b && !m.has(b)) m.set(b, it);
    }
    this.indice = m;
    this.indiceDe = sucursal;
  }
}
