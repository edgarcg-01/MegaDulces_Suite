import {
  VERIFICADOR_SNAPSHOT_FORMATO,
  expandirTier,
  warehouseName,
  type VerificadorPrecioOk,
  type VerificadorSnapshot,
  type VerificadorSnapshotItem,
} from '@megadulces/contracts';
import { escalonesDe, presentacionesDe, unidadDelCodigo, unidadesDelRespaldo, type Escalon, type PresentacionMostrador } from '@megadulces/ui-web';
import { esSinSenal } from '../../core/http/sin-senal';
import { MX_TZ, toMxDateKey } from '../../core/utils/mx-date';

/**
 * `[VTK.17]` **Checador de precios del vendedor — lo que se decide sin Angular.**
 *
 * El precio es EL MISMO del verificador de la tienda (`/tienda/verificador`, decisión del dueño del item): el
 * de Kepler en la sucursal de surtido del vendedor, por presentación. Sale de los mismos dos
 * endpoints (`/api/kp/precio` en vivo y `/api/kp/precios-todos` para la copia sin señal) y se cuenta
 * con la misma regla (`presentacionesDe` de `@megadulces/ui-web`). NO son las listas de precio por
 * cliente de Tomar pedido: la pantalla lo dice.
 *
 * Lo que manda aquí es ADR-056: un precio nunca se muestra sin decir de dónde salió y de cuándo es.
 * La copia guardada en el teléfono no se presenta como si fuera de hoy.
 */

/** Por qué se contestó con la copia y no en línea. */
export type MotivoCopia = 'sin_senal' | 'lento' | 'servidor' | 'rechazo';

export const TEXTO_MOTIVO: Record<MotivoCopia, string> = {
  sin_senal: 'Sin señal',
  lento: 'El servidor tardó en contestar',
  servidor: 'El servidor falló',
  rechazo: 'El servidor rechazó la consulta',
};

/**
 * Clasifica el fallo de la consulta en vivo. «Sin señal» primero (`esSinSenal` de `[VTK.16]`: en el
 * navegador, sin red el service worker contesta 504 sin cuerpo, y eso NO es un error del servidor).
 */
export function motivoDeFallo(e: unknown, enLinea?: boolean): MotivoCopia {
  if (esSinSenal(e, enLinea)) return 'sin_senal';
  if ((e as { name?: unknown } | null)?.name === 'TimeoutError') return 'lento';
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return 'rechazo';
  return 'servidor';
}

/** Lo que la pantalla muestra de UN producto. */
export interface FichaPrecio {
  clave: string;
  nombre: string;
  presentaciones: PresentacionMostrador[];
  /** La presentación del código que se leyó; `null` = el código no la dice (la clave, por ejemplo). */
  unidadLeida: string | null;
  /**
   * `[VTK.17]` Los escalones de mayoreo de Kepler (el de pieza y el de paquete), en la presentación en que
   * se capturan, con la regla compartida del mostrador (`escalonesDe`). David: «agrega ambos precios de mayoreo».
   */
  mayoreo: Escalon[];
  /** `false` = la respuesta no trae mayoreo (copia de formato viejo): se DECLARA, no se pinta «sin mayoreo». */
  mayoreoSabido: boolean;
  /** `[ETQ-PROMO.2]` Una promoción de Kepler: su «precio» es el centavo simbólico y NO se muestra. */
  esPromocion: boolean;
  /** `[TDA.9]` Otros productos con el MISMO código: lo de la ficha es uno de ellos, no «el» producto. */
  otrosConElCodigo: string[];
  /** El precio varía entre plazas y no se pudo acotar a la del vendedor. */
  precioAmbiguo: boolean;
  /** La sucursal del vendedor no tiene el producto: el precio es de otra plaza. */
  deOtraPlaza: boolean;
  /** Lo corrigió una persona: es el mismo de la etiqueta del anaquel. */
  corregidoAMano: boolean;
}

export type ResultadoConsulta =
  /** `al` = cuándo se consultó (en línea) o de cuándo es la copia (`generado` del servidor). */
  | { estado: 'encontrado'; origen: 'en_linea'; ficha: FichaPrecio; al: string }
  | { estado: 'encontrado'; origen: 'copia'; ficha: FichaPrecio; al: string; motivo: MotivoCopia }
  | { estado: 'no_encontrado'; origen: 'en_linea'; codigo: string; al: string }
  | { estado: 'no_encontrado'; origen: 'copia'; codigo: string; al: string; motivo: MotivoCopia }
  /** Ni en línea ni copia: no se puede contestar. NO es «no existe». */
  | { estado: 'sin_datos'; codigo: string; motivo: MotivoCopia };

/** La ficha a partir de la respuesta EN VIVO de `/api/kp/precio`. */
export function fichaDeVivo(r: VerificadorPrecioOk): FichaPrecio {
  const unidades = (Array.isArray(r.unidades) ? r.unidades : [])
    .filter((x) => x && x.precio_con_iva != null)
    .map((x) => ({ u: x.u, precio_con_iva: Number(x.precio_con_iva), factor: Number(x.factor) || 1 }));
  const escaneada = r.unidad_escaneada ?? null;
  const candidatos = Array.isArray(r.productos_candidatos) ? r.productos_candidatos : [];
  return {
    clave: String(r.codigo ?? ''),
    nombre: String(r.nombre ?? ''),
    presentaciones: presentacionesDe(unidades),
    unidadLeida: escaneada && unidades.some((x) => x.u === escaneada) ? escaneada : null,
    mayoreo: escalonesDe(unidades, Array.isArray(r.mayoreo) ? r.mayoreo : []),
    mayoreoSabido: Array.isArray(r.mayoreo),
    esPromocion: r.es_promocion === true,
    otrosConElCodigo: r.codigo_ambiguo === true
      ? candidatos.filter((c) => c.codigo !== r.codigo).map((c) => c.nombre)
      : [],
    precioAmbiguo: r.precio_ambiguo === true,
    deOtraPlaza: r.plaza_pedida_sin_dato === true,
    corregidoAMano: r.origen_precio === 'override_manual',
  };
}

/**
 * La ficha a partir de un renglón de la COPIA. La copia no trae ambigüedad entre plazas ni
 * correcciones a mano (es de UNA sucursal y no lleva esa marca): esas banderas quedan en `false`
 * porque la copia no las afirma, y la pantalla dice de cuándo es la copia.
 */
export function fichaDeCopia(item: VerificadorSnapshotItem, codigoLeido: string, otros: readonly VerificadorSnapshotItem[] = []): FichaPrecio {
  const unidades = unidadesDelRespaldo(item);
  return {
    clave: item.c,
    nombre: item.n || '',
    presentaciones: presentacionesDe(unidades),
    unidadLeida: unidadDelCodigo(item, codigoLeido),
    ...mayoreoDelRespaldo(item),
    esPromocion: item.pm === 1,
    otrosConElCodigo: otros.filter((o) => o.c !== item.c).map((o) => o.n),
    precioAmbiguo: false,
    deOtraPlaza: false,
    corregidoAMano: false,
  };
}

/**
 * `[VTK.17]` El mayoreo de un renglón de la COPIA. `m` ausente = «este respaldo no sabe de mayoreo»
 * (formato anterior a VAC.L11): se declara con `mayoreoSabido: false`, nunca se dice «no tiene».
 */
export function mayoreoDelRespaldo(item: Pick<VerificadorSnapshotItem, 'u' | 'm'>): { mayoreo: Escalon[]; mayoreoSabido: boolean } {
  return {
    mayoreo: escalonesDe(unidadesDelRespaldo(item), (item.m ?? []).map(expandirTier)),
    mayoreoSabido: item.m !== undefined,
  };
}

/** El estado de la copia guardada en el teléfono, para pintarlo. */
export interface EstadoCopia {
  sucursal: string;
  nombreSucursal: string;
  total: number;
  /** De cuándo es el dato: cuando el servidor armó la copia desde Kepler. */
  generado: string;
  /** Cuándo la bajó este teléfono. */
  guardadaAl: string;
  /** `[VAC.L11]` Formato anterior al que sabe leer esta pantalla: se re-baja en cuanto hay red. */
  formatoAnterior: boolean;
}

export function estadoDeCopia(sucursal: string, payload: Partial<VerificadorSnapshot>, guardadaAl: string): EstadoCopia {
  return {
    sucursal,
    nombreSucursal: warehouseName(sucursal) || sucursal,
    total: Number(payload.total ?? payload.productos?.length ?? 0),
    generado: String(payload.generado ?? ''),
    guardadaAl,
    formatoAnterior: (payload.v ?? 1) < VERIFICADOR_SNAPSHOT_FORMATO,
  };
}

/** Una copia más vieja que esto se vuelve a bajar al entrar (el mismo plazo del verificador, CV.24). */
export const COPIA_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * ¿Hay que volver a bajar la copia? Sí si no es de HOY (el precio pudo cambiar en la noche), si pasó
 * el plazo de 12 h, si es de un formato anterior o si su fecha no se puede leer.
 */
export function copiaVencida(e: Pick<EstadoCopia, 'generado' | 'formatoAnterior'>, ahora: Date = new Date()): boolean {
  const t = Date.parse(e.generado);
  if (!Number.isFinite(t)) return true;
  if (e.formatoAnterior) return true;
  if (ahora.getTime() - t > COPIA_TTL_MS) return true;
  return toMxDateKey(new Date(t)) !== toMxDateKey(ahora);
}

const HORA = new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const DIA = new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, day: 'numeric', month: 'short' });

/**
 * Cómo se dice una fecha en esta pantalla: «hoy 08:12», «ayer 18:03», «7 nov, 18:03». La palabra
 * «hoy» sólo sale si el día de MÉXICO es el de hoy — nunca se dice «hoy» de una copia de ayer.
 */
export function cuandoEs(iso: string | null | undefined, ahora: Date = new Date()): { texto: string; esDeHoy: boolean } {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return { texto: 'fecha desconocida', esDeHoy: false };
  const d = new Date(t);
  const dia = toMxDateKey(d);
  const hoy = toMxDateKey(ahora);
  const ayer = toMxDateKey(new Date(ahora.getTime() - 24 * 60 * 60 * 1000));
  const hora = HORA.format(d);
  if (dia === hoy) return { texto: `hoy ${hora}`, esDeHoy: true };
  if (dia === ayer) return { texto: `ayer ${hora}`, esDeHoy: false };
  return { texto: `${DIA.format(d).replace('.', '')}, ${hora}`, esDeHoy: false };
}

/** La sucursal cuyo precio se consulta, o por qué no se puede saber. */
export type SucursalChecador =
  | { ok: true; codigo: string; nombre: string; deLaCopia: boolean }
  | { ok: false; motivo: string };

type Fuente = { code?: string | null; name?: string | null; assigned?: boolean } | null | undefined;

/**
 * La sucursal sale de la MISMA fuente que Tomar pedido (`myStockSources` → sucursal de surtido).
 * No se adivina: sin sucursal, con la sucursal por omisión del tenant (`assigned:false`) o con una
 * que no tiene clave de Kepler de 2 dígitos, se dice por qué y no se consulta.
 */
export function sucursalDelChecador(sucursal: Fuente): SucursalChecador {
  if (!sucursal) {
    return { ok: false, motivo: 'No tienes sucursal de surtido: no se puede saber qué precio te toca. Pídele a tu supervisor que te asigne tu ruta.' };
  }
  if (sucursal.assigned === false) {
    return { ok: false, motivo: 'No tienes sucursal de surtido asignada: no se puede saber qué precio te toca. Pídele a tu supervisor que te asigne tu ruta.' };
  }
  const codigo = String(sucursal.code ?? '').trim();
  const nombre = String(sucursal.name ?? '').trim() || warehouseName(codigo) || codigo;
  if (!/^[0-9]{2}$/.test(codigo)) {
    return { ok: false, motivo: `Tu sucursal de surtido (${nombre || 'sin nombre'}) no tiene clave de Kepler: no se puede consultar su precio.` };
  }
  return { ok: true, codigo, nombre, deLaCopia: false };
}

/** ¿Lo escrito parece un CÓDIGO (sin espacios, con dígitos) y no un nombre? Enter lo consulta en línea. */
export function pareceCodigo(texto: string): boolean {
  const t = String(texto ?? '').trim();
  return !!t && !/\s/.test(t) && /[0-9]/.test(t) && t.length <= 64;
}
