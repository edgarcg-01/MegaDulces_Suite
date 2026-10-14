/**
 * Fase RH · `[RH.3.3.4]` — los DOCUMENTOS DEL EXPEDIENTE por WhatsApp, como lógica pura (sin base ni red).
 *
 * Portado de Mega Talento (`BOT-RH/src/documentos.js` y la etapa `pidiendo_documentos` de `conversacion.js`): RH le pide
 * sus documentos, la persona los manda como foto o PDF en el orden que quiera, el bot reconoce cada uno con visión
 * (`HrDocumentClassifierService`) y lo acomoda en su casillero; cuando termina escribe «listo».
 *
 * Las llaves de casillero son las del expediente de la Suite (`logic/expediente.ts`, espejo del catálogo de Mega Talento):
 * aquí sólo se agrega la PISTA que necesita la visión para reconocer cada uno.
 */
import { DOCUMENTOS_EXPEDIENTE, type EntradaDocumento } from '../logic/expediente';
import { normalizarTexto } from './registro';

/** Lo que la visión necesita para reconocer cada documento (textos de Mega Talento). */
export const PISTA_CASILLERO: Readonly<Record<string, string>> = {
  cv: 'currículum u hoja de vida (CV): historial laboral, estudios, datos de contacto.',
  ine: 'credencial para votar del INE/IFE (identificación oficial mexicana), frente o reverso.',
  curp: 'constancia de la CURP (Clave Única de Registro de Población), con la clave de 18 caracteres.',
  rfc: 'constancia de situación fiscal o cédula del RFC del SAT.',
  nss: 'documento del IMSS con el Número de Seguridad Social (NSS) de 11 dígitos.',
  comprobante: 'comprobante de domicilio: recibo de luz (CFE), agua, predial, teléfono o estado de cuenta con domicilio.',
  acta: 'acta de nacimiento oficial (formato del Registro Civil).',
  banco: 'carátula/estado de cuenta bancario o comprobante con la CLABE interbancaria de 18 dígitos.',
  avisoPrivacidad: 'aviso de privacidad firmado por el candidato.',
  licencia: 'licencia de conducir/manejo.',
  midot: 'reporte de una prueba psicométrica o de integridad aplicada al candidato (MIDOT u otro proveedor).',
  contrato: 'contrato laboral firmado.',
};

/** Las llaves entre las que elige la visión (más «otro»). */
export const CASILLEROS = DOCUMENTOS_EXPEDIENTE.map((d) => d.key);

/** Lo que decidió la visión. `slot: null` = no se reconoció (queda como «otro» para que RH lo mire). */
export interface ClasificacionDocumento {
  slot: string | null;
  motivo: string;
  /** false = no se pudo preguntar (sin IA, error, formato que no lee). Distinto de «lo vio y no es ninguno». */
  clasificado: boolean;
}

export const sinClasificar = (motivo: string): ClasificacionDocumento => ({ slot: null, motivo, clasificado: false });

/** La respuesta de la visión, revisada: una llave fuera del catálogo NO se acepta (no se inventan casilleros). */
export function veredictoDocumento(r: { slot?: unknown; motivo?: unknown } | null | undefined): ClasificacionDocumento {
  if (!r || typeof r.slot !== 'string') return sinClasificar('sin respuesta');
  const motivo = typeof r.motivo === 'string' ? r.motivo.trim().slice(0, 300) : '';
  if (r.slot === 'otro') return { slot: null, motivo, clasificado: true };
  if (!CASILLEROS.includes(r.slot)) return sinClasificar(`casillero desconocido: ${r.slot.slice(0, 40)}`);
  return { slot: r.slot, motivo, clasificado: true };
}

/** Lo de los documentos que vive en la conversación (`talent.bot_conversations.documents`). */
export interface DocsConversacion {
  /** Los casilleros que RH le pidió. */
  solicitados?: string[];
  pedidos_en?: string;
  /** Lo que mandó antes de ser candidato (ya en el bucket); viaja a su expediente al postularse. */
  apartados?: EntradaDocumento[];
}

export function etiqueta(slot: string): string {
  return DOCUMENTOS_EXPEDIENTE.find((d) => d.key === slot)?.label ?? slot;
}

/**
 * Qué se le pide: lo que RH eligió (sólo casilleros conocidos, sin repetir), o por omisión los OBLIGATORIOS que le faltan.
 * El CV no se pide aquí: ya lo mandó al postularse (si faltara, RH lo pide desde la ficha).
 */
export function solicitudDeDocumentos(elegidos: readonly string[] | null | undefined, faltantesObligatorios: readonly string[]): string[] {
  const base = elegidos && elegidos.length ? elegidos : faltantesObligatorios;
  return [...new Set(base)].filter((k) => k !== 'cv' && CASILLEROS.includes(k));
}

/** Lo pedido que todavía no llega a su casillero. */
export function pendientes(solicitados: readonly string[], recibidos: Iterable<string>): string[] {
  const ya = new Set(recibidos);
  return solicitados.filter((k) => !ya.has(k));
}

const numerar = (slots: readonly string[]): string => slots.map((k, i) => `${i + 1}. ${etiqueta(k)}`).join('\n');

/** El mensaje con el que se le piden (lo manda RH desde la ficha, `[RH.3.3.4]`). */
export function mensajePedirDocumentos(nombre: string | null, solicitados: readonly string[]): string {
  const primero = String(nombre ?? '').trim().split(/\s+/)[0] ?? '';
  return '📄 *Documentos para tu expediente*\n\n'
    + `Hola${primero ? ' ' + primero : ''} 👋, para continuar con tu proceso necesitamos estos documentos `
    + '(mándalos como *foto* o *PDF*, en el orden que quieras — yo los acomodo):\n\n'
    + numerar(solicitados)
    + '\n\nEnvíalos aquí. Cuando termines, escribe *listo* ✅';
}

/** Lo que se le dice al recibir un documento. `enEtapa`: RH se los pidió (se le dice qué falta). */
export function acuseDocumento(c: ClasificacionDocumento, faltan: readonly string[], enEtapa: boolean): string {
  const detectado = c.slot
    ? `✅ Recibí tu *${etiqueta(c.slot)}* y lo guardé en tu expediente.`
    : '📎 Recibí tu documento, pero no identifiqué cuál es; un reclutador lo va a revisar.';
  if (!enEtapa) return `${detectado}\n\nTu postulación sigue en revisión; si necesitamos algo más, te escribimos por aquí. 🙌`;
  return faltan.length
    ? `${detectado}\n\nAún me faltan:\n${numerar(faltan)}\n\nCuando termines, escribe *listo* ✅`
    : `${detectado}\n\n¡Ya tengo todos los documentos que te pedimos! Escribe *listo* para terminar. ✅`;
}

/** Escribió algo que no es «listo» mientras se le piden documentos. */
export function recordatorioDocumentos(faltan: readonly string[]): string {
  if (!faltan.length) return 'Ya tengo todos tus documentos ✅. Si quieres mandar alguno más, adelante; o escribe *listo* para terminar.';
  return `Aún me faltan estos documentos (como *foto* o *PDF*):\n\n${numerar(faltan)}\n\nCuando termines, escribe *listo* ✅`;
}

/** ¿Dice que ya terminó? (Mega Talento, `esFinDocumentos`.) */
export function esFinDocumentos(texto: string | null | undefined): boolean {
  const t = normalizarTexto(texto);
  return /\b(listo|termine|termino|acabe|finalice|ya\s*(esta|quedo|termine|acabe|estuvo)|eso\s*es\s*todo|es\s*todo)\b/.test(t)
    || ['ya', 'ok', 'okay', 'terminar', 'finalizar'].includes(t.trim());
}

export function cierreDocumentos(faltan: readonly string[]): string {
  const base = '¡Perfecto! ✅ Recibimos tus documentos. Un reclutador los va a revisar y te dará seguimiento. ¡Muchas gracias! 🙌';
  return faltan.length ? `${base}\n\n_Si después consigues ${faltan.length === 1 ? 'el que falta' : 'los que faltan'}, mándalo${faltan.length === 1 ? '' : 's'} por aquí._` : base;
}

/** Se le pedía el CV y mandó otro documento del expediente: se le dice que se guardó, así no se le vuelve a pedir. */
export function apartadoAlPedirCv(slot: string): string {
  return `De todos modos guardé tu *${etiqueta(slot)}* para tu expediente; no te lo volveré a pedir. 🗂️`;
}
