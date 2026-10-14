/**
 * Fase RH · `[RH.3.3.2]` — ¿lo que mandó ES un CV? La regla y los mensajes, puros. Portado de `validarCV` (`ia.js`) y
 * del rechazo de `conversacion.js` de Mega Talento.
 *
 * Hasta el 18/08/2026, allá, lo que llegara cuando el bot esperaba el CV se etiquetaba como CV SIN mirarlo: expedientes
 * con el PDF de un recibo, la foto de una credencial, y el dictamen «leyendo el CV» de algo que no lo era.
 *
 * LA REGLA: pasa sólo lo que el modelo identificó como currículum u HOJA DE SOLICITUD DE EMPLEO (lo que entrega mucha
 * gente que aplica a piso, y sirve igual). Lo demás se rechaza, incluido lo ilegible (si el modelo no lo lee, RH
 * tampoco). PERO si la IA está apagada o falla, se ACEPTA y se marca para revisión: es una falla nuestra, no un juicio
 * sobre el archivo, y no puede costarle la postulación a nadie. Lo que pasó con duda también se marca para revisión.
 */

export const TIPOS_DOCUMENTO = [
  'cv', 'solicitud_empleo', 'identificacion', 'comprobante', 'certificado_estudios', 'carta_recomendacion',
  'otro_documento', 'foto_persona', 'ilegible',
] as const;
export type TipoDocumentoCv = (typeof TIPOS_DOCUMENTO)[number];

/** El veredicto sobre el archivo. `revisar`: que lo mire una persona (pasó con duda, o no se pudo revisar). */
export interface ValidacionCv {
  valido: boolean;
  tipo: TipoDocumentoCv | 'sin_revisar' | 'no_revisable' | 'demasiadas_paginas';
  motivo: string;
  revisar: boolean;
}

const VALIDOS: readonly string[] = ['cv', 'solicitud_empleo'];

/** Lo que el modelo contestó → el veredicto. Un tipo desconocido no se acepta a ciegas: se marca para revisión. */
export function veredictoCv(r: { tipo?: unknown; seguro?: unknown; que_es?: unknown } | null): ValidacionCv {
  if (!r || typeof r.tipo !== 'string' || !(TIPOS_DOCUMENTO as readonly string[]).includes(r.tipo)) return sinRevisar('respuesta del modelo no reconocida');
  const valido = VALIDOS.includes(r.tipo);
  return { valido, tipo: r.tipo as TipoDocumentoCv, motivo: String(r.que_es ?? '').trim().slice(0, 200), revisar: valido && r.seguro !== true };
}

/** No se pudo revisar (IA apagada, caída, o un formato que la visión no lee): se acepta y se marca. */
export function sinRevisar(motivo: string): ValidacionCv {
  return { valido: true, tipo: 'sin_revisar', motivo, revisar: true };
}

/**
 * Un CV no tiene 100 páginas: si el proveedor rechaza el PDF por tamaño o páginas, ESO ya es la respuesta (allá, un
 * archivo de 228 páginas entraba como CV porque el error caía en el respaldo que deja pasar todo).
 */
export function esErrorDeTamano(mensaje: string): boolean {
  return /PDF pages|too large|exceeds|maximum|too many pages/i.test(mensaje);
}

export const DEMASIADAS_PAGINAS: ValidacionCv = {
  valido: false, tipo: 'demasiadas_paginas', motivo: 'el archivo es enorme (un currículum son 1 o 2 páginas)', revisar: false,
};

const QUE_ES: Partial<Record<ValidacionCv['tipo'], string>> = {
  identificacion: 'una identificación',
  comprobante: 'un comprobante',
  certificado_estudios: 'un certificado de estudios',
  carta_recomendacion: 'una carta',
  foto_persona: 'una foto',
  demasiadas_paginas: 'un documento muy largo',
};

/**
 * Lo que se le dice cuando no pasa. A quien mandó algo ILEGIBLE no se le dice que mandó lo incorrecto (es acusarlo de
 * algo que no hizo, y la forma más fácil de perder a alguien que ya hizo todo el registro): se le pide otra foto.
 */
export function mensajeCvRechazado(v: ValidacionCv): string {
  if (v.tipo === 'ilegible') {
    return `Recibí tu archivo, pero *no alcanzo a leerlo* 😕${v.motivo ? ` (${v.motivo})` : ''}.\n\n`
      + '¿Me lo mandas otra vez? Tips para que salga bien:\n• Con *buena luz* y sin sombras\n'
      + '• Que se vea la *hoja completa*, derecha\n• Si lo tienes en *PDF*, mándalo así mejor';
  }
  const eso = QUE_ES[v.tipo] ?? 'otro documento';
  return `Recibí tu archivo, pero parece ${eso}${v.motivo ? ` — ${v.motivo}.` : '.'}\n\n`
    + 'Para terminar tu postulación necesito tu *currículum* 📄\n\nSirve cualquiera de estos:\n'
    + '• Tu *CV* en PDF o foto (aunque sea sencillo)\n• Una *hoja de solicitud de empleo* llenada\n\nMándamelo por aquí 🙌';
}

/** Lo que la visión puede leer: PDF y las imágenes que acepta el proveedor (HEIC no). */
export function visionPuedeLeer(contentType: string): boolean {
  return ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType);
}
