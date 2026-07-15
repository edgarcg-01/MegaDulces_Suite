/**
 * FISCAL.4 — Contrato del WS de Descarga Masiva del SAT (del doc de Verificación).
 */

/** EstadoSolicitud del SAT (§5.1 del doc). */
export enum EstadoSolicitud {
  Aceptada = 1,
  EnProceso = 2,
  Terminada = 3,
  Error = 4,
  Rechazada = 5,
  Vencida = 6, // 72h después de generado el paquete
}

export const ESTADO_LABEL: Record<number, string> = {
  1: 'Aceptada', 2: 'En proceso', 3: 'Terminada', 4: 'Error', 5: 'Rechazada', 6: 'Vencida',
};

/** Estado local de fiscal.download_requests. */
export type EstadoLocal = 'nueva' | 'solicitada' | 'en_proceso' | 'terminada' | 'descargada' | 'error' | 'rechazada' | 'vencida';

/** Mapea el EstadoSolicitud del SAT al estado local del request. */
export function estadoLocalDe(estadoSat: number): EstadoLocal {
  switch (estadoSat) {
    case EstadoSolicitud.Aceptada: return 'solicitada';
    case EstadoSolicitud.EnProceso: return 'en_proceso';
    case EstadoSolicitud.Terminada: return 'terminada';
    case EstadoSolicitud.Rechazada: return 'rechazada';
    case EstadoSolicitud.Vencida: return 'vencida';
    default: return 'error';
  }
}

/** Códigos de estatus (doc §"Mensajes" / "Códigos de Solicitud"). */
export const COD_ESTATUS: Record<string, string> = {
  '300': 'Usuario no válido',
  '301': 'XML mal formado',
  '302': 'Sello mal formado',
  '303': 'Sello no corresponde con RfcSolicitante',
  '304': 'Certificado revocado o caduco',
  '305': 'Certificado inválido',
  '404': 'Error no controlado',
  '5000': 'Solicitud recibida con éxito',
  '5002': 'Se agotaron las solicitudes de por vida',
  '5003': 'Tope máximo de la consulta',
  '5004': 'No se encontró la información',
  '5005': 'Solicitud duplicada',
  '5011': 'Límite de descargas por folio por día',
};

/** Códigos que son error PERMANENTE (no reintentar en el job runner).
 *  5003 (tope máximo de la consulta) es determinista: reintentar el mismo rango
 *  siempre vuelve a fallar y gasta cuota de solicitudes del SAT → permanente.
 *  5011 (límite de descargas por folio/día) puede resolverse al día siguiente,
 *  pero el backoff (cap 20min) nunca espera un día → se trata como permanente y
 *  el usuario re-encola manualmente. */
export const COD_PERMANENTES = new Set(['300', '301', '302', '303', '304', '305', '5002', '5003', '5004', '5005', '5011']);

/** EstadoSolicitud terminales de error (no re-pollear). Terminada se maneja aparte. */
export const ESTADOS_TERMINALES_ERROR = new Set<number>([
  EstadoSolicitud.Error, EstadoSolicitud.Rechazada, EstadoSolicitud.Vencida,
]);

export interface AuthToken { token: string; expires: Date; }

export interface SolicitaResult { idSolicitud: string; cod: string; mensaje: string; }

export interface VerificaResult {
  estadoSolicitud: number;
  codEstatus: string;
  codigoEstadoSolicitud: string;
  numeroCFDIs: number;
  mensaje: string;
  idsPaquetes: string[];
}

export interface SolicitaParams {
  rfcSolicitante: string;
  rol: 'emitidas' | 'recibidas';
  tipo: 'CFDI' | 'Metadata';
  fechaIni: string; // YYYY-MM-DD
  fechaFin: string;
}

/** Material de e.firma en claro (efímero) para firmar. */
export interface EfirmaMaterial { cerDer: Buffer; keyDer: Buffer; password: Buffer; }
