import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import type { VerificadorPrecioResponse, VerificadorSnapshot, VerificadorSnapshotItem } from '@megadulces/contracts';
import { aBuscable, buscarEnCatalogo, productosPorCodigo, type Buscable, type Coincidencia } from '@megadulces/ui-web';
import { environment } from '../../../environments/environment';
import { OfflineDatabaseService } from '../../core/services/offline-database.service';
import {
  copiaVencida,
  estadoDeCopia,
  fichaDeCopia,
  fichaDeVivo,
  motivoDeFallo,
  type EstadoCopia,
  type MotivoCopia,
  type ResultadoConsulta,
} from './checador-precios';

/** Cuánto se espera a Kepler antes de contestar con la copia (el mismo plazo del verificador). */
export const TIMEOUT_EN_LINEA_MS = 2500;

type BuscableCopia = Buscable<VerificadorSnapshotItem>;
export type HalladoEnCopia = Coincidencia<VerificadorSnapshotItem>;

/** `[VTK.18]` A qué producto corresponde un código leído en Tomar pedido. */
export type ClaveDeCodigo =
  | { estado: 'hallado'; clave: string; nombre: string; ambiguo: boolean }
  | { estado: 'no_esta' }
  | { estado: 'no_se_pudo' };

/**
 * `[VTK.17]` Checador de precios del vendedor: en línea primero, copia del teléfono después.
 *
 * Consume los endpoints que YA existen (`KpModule` de `apps/api`): `/api/kp/precio` y
 * `/api/kp/precios-todos`. Son públicos (`@Public()`) porque los usa el kiosco de la tienda; acá
 * viajan con la sesión del vendedor igual. No se crea backend nuevo.
 *
 * ── Por qué la copia la guarda ESTE servicio y no el service worker ─────────────────────────────
 * Una respuesta servida desde la caché del service worker no trae su fecha real, y la pantalla
 * tiene que decir de cuándo es el precio. Por eso `/api/kp/**` NO va en `ngsw-config.json`: la
 * copia se guarda en la Dexie del teléfono con su `generado` (cuándo la armó el servidor desde
 * Kepler) y su fecha de descarga.
 *
 * ⚠️ El flujo «en vivo → copia» es el mismo contrato que `VerificadorService` de `apps/view`, escrito
 * otra vez porque aquél está atado a la base y al `environment` de esa app. La búsqueda y la cuenta
 * de presentaciones sí son las mismas (`@megadulces/ui-web`). Deuda con nombre: `[VTK.17.D2]`.
 */
@Injectable({ providedIn: 'root' })
export class ChecadorPreciosService {
  private readonly http = inject(HttpClient);
  private readonly offline = inject(OfflineDatabaseService);
  private readonly base = environment.apiUrl;

  /** La copia de la sucursal activa. `null` = no hay copia en este teléfono. */
  readonly copia = signal<EstadoCopia | null>(null);

  private buscables: BuscableCopia[] = [];
  private cargadaDe: string | null = null;
  private bajando: Promise<EstadoCopia> | null = null;

  /**
   * Precio de UN código (de barras, clave o SKU): en línea primero; si no hay señal, tarda más de
   * 2.5 s o el servidor falla, sale de la copia y se dice por qué. Un «no encontrado» que contesta
   * el servidor es la respuesta y NO se re-pregunta a la copia: Kepler sabe más que una copia.
   */
  async consultar(codigo: string, sucursal: string): Promise<ResultadoConsulta> {
    const q = String(codigo ?? '').trim();
    let motivo: MotivoCopia;
    try {
      const params = new HttpParams().set('q', q).set('sucursal', sucursal);
      const r = await firstValueFrom(
        this.http.get<VerificadorPrecioResponse>(`${this.base}/kp/precio`, { params }).pipe(timeout(TIMEOUT_EN_LINEA_MS)),
      );
      const al = new Date().toISOString();
      if (!r || r.ok !== true) return { estado: 'no_encontrado', origen: 'en_linea', codigo: q, al };
      return { estado: 'encontrado', origen: 'en_linea', ficha: fichaDeVivo(r), al };
    } catch (e) {
      motivo = motivoDeFallo(e);
    }
    return this.consultarEnCopia(q, sucursal, motivo);
  }

  /** Contesta con la copia del teléfono, diciendo de cuándo es y por qué se usó. */
  async consultarEnCopia(codigo: string, sucursal: string, motivo: MotivoCopia): Promise<ResultadoConsulta> {
    const hay = await this.cargar(sucursal);
    const copia = this.copia();
    if (!hay || !copia) return { estado: 'sin_datos', codigo, motivo };
    const hallados = productosPorCodigo(this.buscables, codigo);
    if (!hallados.length) return { estado: 'no_encontrado', origen: 'copia', codigo, al: copia.generado, motivo };
    const items = hallados.map((b) => b.item);
    return { estado: 'encontrado', origen: 'copia', ficha: fichaDeCopia(items[0], codigo, items), al: copia.generado, motivo };
  }

  /**
   * Busca por nombre, proveedor, clave o código de barras EN LA COPIA (instantáneo y sin señal).
   * `null` = no hay copia: «no puedo buscar» no es lo mismo que «no hay resultados».
   */
  async buscarEnCopia(sucursal: string, texto: string, limite = 30): Promise<HalladoEnCopia[] | null> {
    if (!String(texto ?? '').trim()) return [];
    const hay = await this.cargar(sucursal);
    if (!hay) return null;
    return buscarEnCatalogo(this.buscables, texto, limite);
  }

  /**
   * Deja la copia lista: la lee del teléfono y la vuelve a bajar si falta, si no es de hoy, si pasó
   * su plazo o si es de un formato anterior — sólo con señal. Sin señal sirve la que haya.
   * `fallo` = la bajada se intentó y falló (la copia que había, si había, sigue sirviendo).
   */
  async asegurarCopia(
    sucursal: string,
    enLinea = typeof navigator === 'undefined' || navigator.onLine !== false,
  ): Promise<{ copia: EstadoCopia | null; fallo: unknown }> {
    const hay = await this.cargar(sucursal);
    const actual = hay ? this.copia() : null;
    if ((actual && !copiaVencida(actual)) || !enLinea) return { copia: actual, fallo: null };
    try {
      return { copia: await this.descargarCopia(sucursal), fallo: null };
    } catch (e) {
      return { copia: actual, fallo: e ?? new Error('fallo') };
    }
  }

  /** ¿Se está bajando la copia ahora? La pantalla lo dice en vez de quedarse muda. */
  readonly bajandoCopia = signal(false);

  /** Baja la copia completa de esa sucursal (~500 KB comprimida, medido el 2026-11-09) y la guarda. */
  descargarCopia(sucursal: string): Promise<EstadoCopia> {
    if (this.bajando) return this.bajando;
    this.bajandoCopia.set(true);
    this.bajando = (async () => {
      const params = new HttpParams().set('sucursal', sucursal);
      const payload = await firstValueFrom(this.http.get<VerificadorSnapshot>(`${this.base}/kp/precios-todos`, { params }));
      if (!payload?.productos?.length) throw new Error('La copia llegó vacía');
      await this.offline.guardarCopiaPrecios(sucursal, payload, payload.generado);
      this.indexar(sucursal, payload);
      const estado = estadoDeCopia(sucursal, payload, new Date().toISOString());
      this.copia.set(estado);
      return estado;
    })().finally(() => {
      this.bajando = null;
      this.bajandoCopia.set(false);
    });
    return this.bajando;
  }

  /**
   * La copia más reciente del teléfono, de la sucursal que sea. Sirve cuando no hay señal para
   * preguntar la sucursal del día: se usa la de la última copia y la pantalla lo dice.
   */
  async ultimaCopia(): Promise<EstadoCopia | null> {
    const g = await this.offline.ultimaCopiaPrecios();
    const payload = g?.datos as VerificadorSnapshot | undefined;
    if (!g || !payload?.productos?.length) return null;
    const sucursal = g.id.replace(/^verificador-precios:/, '');
    return estadoDeCopia(sucursal, payload, g.ultima_sincronizacion);
  }

  /**
   * `[VTK.18]` La clave de Kepler de un código leído con la cámara en Tomar pedido, para buscarla en
   * el catálogo del pedido (que se indexa por nombre y SKU, no por código de barras).
   *
   * Primero la copia del teléfono (instantánea y sin señal), si la hay; si no está ahí, en línea.
   * NO baja la copia: Tomar pedido no debe gastar datos en eso.
   *
   * Tres respuestas distintas, porque se dicen distinto: `hallado`; `no_esta` (Kepler contestó que
   * no lo tiene); `no_se_pudo` (sin señal o sin respuesta, y la copia —si hay— no lo tiene). Decir
   * «no existe» cuando no se pudo preguntar sería afirmar algo que no se midió.
   */
  async claveDeCodigo(codigo: string, sucursal: string | null): Promise<ClaveDeCodigo> {
    const q = String(codigo ?? '').trim();
    if (!q) return { estado: 'no_se_pudo' };
    const suc = sucursal ?? (await this.ultimaCopia())?.sucursal ?? null;
    if (suc && (await this.cargar(suc))) {
      const hallados = productosPorCodigo(this.buscables, q);
      if (hallados.length) {
        return { estado: 'hallado', clave: hallados[0].item.c, nombre: hallados[0].item.n, ambiguo: hallados.length > 1 };
      }
    }
    try {
      let params = new HttpParams().set('q', q);
      if (sucursal) params = params.set('sucursal', sucursal);
      const r = await firstValueFrom(
        this.http.get<VerificadorPrecioResponse>(`${this.base}/kp/precio`, { params }).pipe(timeout(TIMEOUT_EN_LINEA_MS)),
      );
      if (r?.ok === true && r.codigo) {
        return { estado: 'hallado', clave: String(r.codigo), nombre: String(r.nombre ?? ''), ambiguo: r.codigo_ambiguo === true };
      }
      return { estado: 'no_esta' };
    } catch {
      return { estado: 'no_se_pudo' };
    }
  }

  /** Carga la copia de esa sucursal del teléfono a memoria si hace falta. `false` = no hay copia. */
  private async cargar(sucursal: string): Promise<boolean> {
    if (this.cargadaDe === sucursal && this.buscables.length) return true;
    const g = await this.offline.getCopiaPrecios(sucursal);
    const payload = g?.datos as VerificadorSnapshot | undefined;
    if (!g || !payload?.productos?.length) {
      // La copia en memoria era de OTRA sucursal: no se deja pintada como si fuera de ésta.
      this.buscables = [];
      this.cargadaDe = null;
      this.copia.set(null);
      return false;
    }
    this.indexar(sucursal, payload);
    this.copia.set(estadoDeCopia(sucursal, payload, g.ultima_sincronizacion));
    return true;
  }

  private indexar(sucursal: string, payload: VerificadorSnapshot): void {
    const proveedores = payload.pr ?? [];
    this.buscables = payload.productos.filter((it) => it?.c).map((it) => aBuscable(it, proveedores));
    this.cargadaDe = sucursal;
  }
}
