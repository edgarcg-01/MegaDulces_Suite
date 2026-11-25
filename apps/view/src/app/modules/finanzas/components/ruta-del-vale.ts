import type { ComprobacionEnLaCola, KeplerDelVale } from '@megadulces/contracts';
import { lineaDelGasto, polizaCorta } from '../pages/esperan-kepler.ayudas';
import { requiereEvidencia, type ValeGasto } from '../comprobaciones.service';

/**
 * `[PGP.123]` G-RED.1 (2026-11-23) — **La ruta del vale**: los cinco pasos de un gasto, en orden, con dónde va.
 *
 * Nace de la auditoría de usuario del 2026-11-23 (`AUDITORIA_UX_GASTO_2026-11-23.md`): quien pidió un gasto no
 * encontraba «dónde veo mi solicitud, dónde capturo la comprobación, dónde se ve la autorización». Cada dato existía,
 * repartido en cuatro pantallas y en secciones del panel sin orden de proceso. La ruta no agrega datos: **ordena los que
 * el panel ya tiene** y dice cuál paso toca ahora y a quién.
 *
 * ## ⚠️ Lo que no llega no se dibuja como hecho ni como pendiente
 * - Quién firmó y cuándo sólo viaja cuando la página pasa la solicitud de Kepler (`kepler.suite.firmo`). Sin ella el
 *   paso dice «Firmado», sin nombre: no se inventa.
 * - El gasto en Kepler de un vale cerrado se consulta aparte; mientras no llega es `sin_medir`, nunca «pendiente».
 */
export type EstadoDelPaso = 'hecho' | 'actual' | 'pendiente' | 'no_aplica' | 'mal' | 'sin_medir';

export type ClaveDelPaso = 'pedido' | 'firma' | 'comprobante' | 'revision' | 'gasto' | 'rechazo';

/** A qué sección del panel lleva el paso («Ver …»). `null` = no tiene una sección propia. */
export type SeccionDelPaso = 'kepler' | 'evidencia' | 'gasto' | null;

export interface PasoDeLaRuta {
  clave: ClaveDelPaso;
  /** Sustantivo, no participio: «Firma», no «Firmado» (un paso pendiente no puede decir que ya pasó). */
  nombre: string;
  estado: EstadoDelPaso;
  texto: string;
  seccion: SeccionDelPaso;
}

/** La palabra del estado, para quien no ve el color ni el ícono (lector de pantalla y la versión apilada). */
export const ESTADO_DEL_PASO_TEXTO: Record<EstadoDelPaso, string> = {
  hecho: 'Hecho',
  actual: 'Toca ahora',
  pendiente: 'Después',
  no_aplica: 'No aplica',
  mal: 'Con problema',
  sin_medir: 'Sin leer',
};

type ValeDeLaRuta = Pick<ValeGasto, 'status' | 'requiere_evidencia' | 'tiene_evidencia' | 'created_by' | 'folio_solicitud' | 'validated_by' | 'motivo_rechazo'>
  & Partial<Pick<ValeGasto, 'clasificacion' | 'files'>>;

const SOLICITUD_MAL = ['stuck', 'rejected_by_kepler'];
const GASTO_MAL = ['cancelled', 'stuck', 'rejected_by_kepler'];

/**
 * G-RED.1b — **¿Trae comprobante?** `/mine` (Mis gastos) no manda `tiene_evidencia`: se deriva de los archivos, con los
 * roles que el servidor cuenta como comprobante (`approve` mira `comprobante*`; el día, `evidencia*`). Sin bandera y
 * sin archivos que leer = `undefined`: no se afirma ni «subido» ni «sin comprobante».
 */
export function tieneComprobante(v: Pick<ValeDeLaRuta, 'tiene_evidencia' | 'files'>): boolean | undefined {
  if (typeof v.tiene_evidencia === 'boolean') return v.tiene_evidencia;
  if (!Array.isArray(v.files)) return undefined;
  return v.files.some((f) => /^(comprobante|evidencia)/.test(String(f?.role ?? '')) && !!f?.url);
}

/** ¿Su clase pide comprobante? La bandera del servidor, o la clasificación con la misma regla. `undefined` = no se sabe. */
function pideComprobante(v: Pick<ValeDeLaRuta, 'requiere_evidencia' | 'clasificacion'>): boolean | undefined {
  if (typeof v.requiere_evidencia === 'boolean') return v.requiere_evidencia;
  return typeof v.clasificacion === 'string' && v.clasificacion ? requiereEvidencia(v.clasificacion) : undefined;
}

export function rutaDelVale(
  v: ValeDeLaRuta | null | undefined,
  k: KeplerDelVale | null | undefined,
  g: ComprobacionEnLaCola | null | undefined,
): PasoDeLaRuta[] {
  if (!v) return [];
  const pedido: PasoDeLaRuta = {
    clave: 'pedido', nombre: 'Pedido', estado: 'hecho', seccion: null,
    texto: v.created_by ? `Lo pidió ${v.created_by}` : 'Levantado en la Suite',
  };

  // Rechazado: la ruta termina ahí. No se sabe en qué paso se rechazó (el vale no lo guarda), y no se adivina.
  if (v.status === 'rechazada') {
    return [pedido, {
      clave: 'rechazo', nombre: 'Rechazo', estado: 'mal', seccion: null,
      texto: `Se rechazó${v.motivo_rechazo ? `: ${v.motivo_rechazo}` : ''}. La ruta termina aquí; se vuelve a capturar`,
    }];
  }

  const st = v.status;
  const firmado = st !== 'recibida';
  const solicitud = k?.solicitud ?? (v.folio_solicitud ? `solicitud ${v.folio_solicitud}` : null);
  const escrituraMal = SOLICITUD_MAL.includes(k?.nace_en_la_suite?.status ?? '');
  const firma: PasoDeLaRuta = !firmado
    ? {
        clave: 'firma', nombre: 'Firma', estado: 'actual', seccion: k ? 'kepler' : null,
        texto: k?.nace_en_la_suite
          ? 'Espera la firma de quien aprueba gastos; al firmarla se escribe la solicitud en Kepler'
          : 'Espera la firma de quien aprueba gastos',
      }
    : {
        clave: 'firma', nombre: 'Firma', estado: escrituraMal ? 'mal' : 'hecho', seccion: k ? 'kepler' : null,
        texto: [
          k?.suite?.firmo ? `Firmó ${k.suite.firmo}` : 'Firmado',
          escrituraMal ? 'la solicitud no quedó en Kepler' : (solicitud ? `${solicitud.startsWith('solicitud') ? '' : 'solicitud '}${solicitud} en Kepler` : null),
        ].filter(Boolean).join(' · '),
      };

  /*
   * G-RED.1b — El comprobante, con el contrato de `approve` (servidor): un vale sólo queda en `aprobada` si es provisional
   * o si su clase pide comprobante y no lo trae; un gasto que no lo pide cierra directo en `validada`. Así que
   * `aprobada` SIEMPRE es «falta el comprobante», sin importar las banderas (que `/mine` no manda). «Ver el comprobante»
   * sólo cuando hay un archivo que ver: llevar a «este vale no trae ningún archivo» no es un destino.
   */
  const tiene = tieneComprobante(v);
  const pide = pideComprobante(v);
  const ver: SeccionDelPaso = tiene ? 'evidencia' : null;
  const C = { clave: 'comprobante' as const, nombre: 'Comprobante' };
  let comprobante: PasoDeLaRuta;
  if (st === 'aprobada') {
    comprobante = { ...C, estado: 'actual', seccion: null, texto: 'Falta subir el comprobante; lo sube quien lo pidió' };
  } else if (st === 'revision' || st === 'validada') {
    comprobante = tiene === true ? { ...C, estado: 'hecho', seccion: ver, texto: 'Subido' }
      : tiene === false && pide === false ? { ...C, estado: 'no_aplica', seccion: null, texto: 'Este gasto no pedía comprobante' }
      : tiene === false ? { ...C, estado: 'hecho', seccion: null, texto: 'Se cerró sin comprobante adjunto' }
      : { ...C, estado: 'hecho', seccion: null, texto: 'Se cerró en la Suite' };
  } else if (tiene) {
    comprobante = { ...C, estado: 'hecho', seccion: ver, texto: 'Vino con el pedido' };
  } else if (pide === false) {
    comprobante = { ...C, estado: 'no_aplica', seccion: null, texto: 'Este gasto no pide comprobante' };
  } else {
    comprobante = { ...C, estado: 'pendiente', seccion: null, texto: 'Se sube cuando llegue la factura' };
  }

  // La sección del comprobante ya la abre su paso: la revisión no repite «Ver el comprobante».
  let revision: PasoDeLaRuta;
  if (st === 'validada') {
    revision = { clave: 'revision', nombre: 'Revisión', estado: 'hecho', seccion: null, texto: v.validated_by ? `Lo cerró ${v.validated_by}` : 'Cerrado en la Suite' };
  } else if (st === 'revision') {
    revision = { clave: 'revision', nombre: 'Revisión', estado: 'actual', seccion: null, texto: 'Finanzas revisa el comprobante' };
  } else {
    revision = { clave: 'revision', nombre: 'Revisión', estado: 'pendiente', seccion: null, texto: 'Finanzas revisa el comprobante' };
  }

  return [pedido, firma, comprobante, revision, pasoDelGasto(st, g)];
}

function pasoDelGasto(st: string, g: ComprobacionEnLaCola | null | undefined): PasoDeLaRuta {
  const base = { clave: 'gasto' as const, nombre: 'Gasto en Kepler' };
  if (st !== 'validada') return { ...base, estado: 'pendiente', seccion: null, texto: 'Se genera cuando se cierra en la Suite' };
  if (g === undefined) return { ...base, estado: 'sin_medir', seccion: null, texto: 'Todavía no se lee de Kepler' };
  if (g === null) return { ...base, estado: 'sin_medir', seccion: 'gasto', texto: 'No se pudo leer: revísalo en Kepler' };
  const e = g.gasto;
  if (e?.folio && e.status !== 'cancelled') {
    return { ...base, estado: 'hecho', seccion: 'gasto', texto: `Folio ${e.folio}${e.poliza ? ` · póliza ${polizaCorta(e.poliza)}` : ''}` };
  }
  const l = lineaDelGasto(g);
  return { ...base, estado: GASTO_MAL.includes(e?.status ?? '') ? 'mal' : 'actual', seccion: 'gasto', texto: l.texto };
}

/** El paso que toca ahora (o el que tiene problema). `null` = el vale terminó su ruta. */
export function pasoActual(ruta: readonly PasoDeLaRuta[]): PasoDeLaRuta | null {
  return ruta.find((p) => p.estado === 'mal') ?? ruta.find((p) => p.estado === 'actual') ?? null;
}

/**
 * `[PGP.123]` G-RED.2 — **La barrita de la fila** (Mis gastos): la misma ruta, en cinco segmentos. Un rechazo corta la
 * ruta en dos pasos; los tres que ya no van a ocurrir se rellenan como `cortado`, para que todas las filas midan igual
 * sin dibujar como «después» lo que no va a pasar.
 */
export type EstadoDelSegmento = EstadoDelPaso | 'cortado';
export const PASOS_DE_LA_RUTA = 5;

export function segmentosDeLaRuta(ruta: readonly PasoDeLaRuta[]): EstadoDelSegmento[] {
  if (!ruta.length) return [];
  const s: EstadoDelSegmento[] = ruta.map((p) => p.estado);
  while (s.length < PASOS_DE_LA_RUTA) s.push('cortado');
  return s;
}

/**
 * Lo que dice la barrita en palabras, para el lector de pantalla (la barrita es `aria-hidden`): en qué paso va y cómo.
 * ⚠️ Un vale cerrado con el gasto sin leer NO es «terminado»: se dice qué falta leer.
 */
export function resumenDeLaRuta(ruta: readonly PasoDeLaRuta[]): string {
  if (!ruta.length) return '';
  const a = pasoActual(ruta);
  if (a?.clave === 'rechazo') return 'Se rechazó: la ruta termina';
  if (a) return `Paso ${ruta.indexOf(a) + 1} de ${PASOS_DE_LA_RUTA}, ${a.nombre}: ${ESTADO_DEL_PASO_TEXTO[a.estado].toLowerCase()}`;
  const sinLeer = ruta.find((p) => p.estado === 'sin_medir');
  return sinLeer ? `Cerrado en la Suite; ${sinLeer.nombre}: ${ESTADO_DEL_PASO_TEXTO.sin_medir.toLowerCase()}` : 'Ruta terminada';
}
