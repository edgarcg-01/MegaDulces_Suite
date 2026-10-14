/**
 * Fase RH · `[RH.2.4]` — las REGLAS para aceptar o rechazar una postulación, iguales para la web y para el bot.
 * Funciones puras (se prueban en CI).
 *
 * Decididas con David el 13-oct-2026 (se conservan las dos entradas, web y WhatsApp, con reglas):
 *
 *   1. Una persona, UN proceso a la vez. Si ya está en proceso —para la misma vacante o para otra— la
 *      postulación nueva se rechaza. Lo que traiga y a su proceso le falte (un CV, un correo) se le agrega.
 *   2. Volver a la MISMA vacante después de cerrado su proceso (rechazado o contratado): se acepta pasados
 *      90 días; antes, se rechaza.
 *   3. La persona se reconoce por el teléfono (últimos 10 dígitos, `phone_key`), sea cual sea la entrada.
 *   4. Lista negra: la postulación se recibe y NO se le avisa a la persona; RH la ve en Revisiones.
 *
 * ⚠️ Lo que se le CONTESTA a quien se postula por la web nunca dice para qué vacante está ni si está en la
 * lista negra: cualquiera puede teclear el teléfono de otro. Por WhatsApp sí se dice la vacante, porque ahí
 * el teléfono es de quien escribe.
 */

/** Días que tienen que pasar para volver a la misma vacante después de cerrado el proceso. */
export const DIAS_PARA_REPOSTULAR = 90;

/** Etapas que CIERRAN un proceso. */
export const ETAPAS_CERRADAS = ['rechazado', 'contratado'] as const;

export interface ProcesoExistente {
  id: string;
  stage: string | null;
  job_posting_id: string | null;
  position_interest: string | null;
  /** Nombre de su vacante, si apunta a una (para comparar contra el texto que manda el bot). */
  job_posting_name?: string | null;
  deleted_at: string | null;
  is_spam: boolean;
  no_rehire: boolean;
  /** Cuándo se cerró (último paso a rechazado/contratado). `null` si sigue abierto o no se sabe. */
  cerrado_en: string | null;
  created_at: string;
}

export interface PostulacionNueva {
  job_posting_id: string | null;
  job_posting_name?: string | null;
  position_interest: string | null;
}

export type MotivoRechazo = 'en_proceso_misma_vacante' | 'en_proceso_otra_vacante' | 'cerrada_hace_poco';

export type Decision =
  /** `candidato_id` lo agrega `postular` al crear (la regla pura no lo conoce). */
  | { accion: 'crear'; en_lista_negra: boolean; candidato_id?: string }
  | { accion: 'rechazar'; motivo: MotivoRechazo; candidato_id: string; vacante: string | null; puede_desde: string | null; en_lista_negra: boolean };

/** Texto de vacante comparable: minúsculas, sin acentos, sin signos, espacios colapsados. */
export function normalizarVacante(t: string | null | undefined): string {
  return String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ¿Es la misma vacante? Por id cuando los dos lo tienen; si no, por el texto (el bot manda el puesto como lo
 * escribió la persona). Si a alguno le falta todo, NO se puede decir que es la misma: `false`.
 */
export function mismaVacante(a: { job_posting_id: string | null; job_posting_name?: string | null; position_interest: string | null },
  b: { job_posting_id: string | null; job_posting_name?: string | null; position_interest: string | null }): boolean {
  if (a.job_posting_id && b.job_posting_id) return a.job_posting_id === b.job_posting_id;
  const ta = normalizarVacante(a.job_posting_name || a.position_interest);
  const tb = normalizarVacante(b.job_posting_name || b.position_interest);
  return !!ta && ta === tb;
}

const cerrada = (stage: string | null) => (ETAPAS_CERRADAS as readonly string[]).includes(String(stage));

/** ¿Este registro cuenta como un proceso abierto? (vivo, no spam, no cerrado). */
export function enProceso(p: ProcesoExistente): boolean {
  return !p.deleted_at && !p.is_spam && !cerrada(p.stage);
}

export function decidirPostulacion(existentes: ProcesoExistente[], nueva: PostulacionNueva, ahora: Date = new Date()): Decision {
  const en_lista_negra = existentes.some((p) => p.no_rehire);
  const vacanteDe = (p: ProcesoExistente) => p.job_posting_name || p.position_interest || null;

  // 1) Ya está en proceso: el más reciente manda.
  const abiertos = existentes.filter(enProceso).sort((x, y) => (x.created_at < y.created_at ? 1 : -1));
  if (abiertos.length) {
    const p = abiertos[0];
    return {
      accion: 'rechazar', motivo: mismaVacante(p, nueva) ? 'en_proceso_misma_vacante' : 'en_proceso_otra_vacante',
      candidato_id: p.id, vacante: vacanteDe(p), puede_desde: null, en_lista_negra,
    };
  }

  // 2) La misma vacante, cerrada hace menos de 90 días.
  const limite = ahora.getTime() - DIAS_PARA_REPOSTULAR * 86_400_000;
  const reciente = existentes
    .filter((p) => !p.deleted_at && cerrada(p.stage) && mismaVacante(p, nueva))
    .map((p) => ({ p, t: new Date(p.cerrado_en ?? p.created_at).getTime() }))
    .filter((x) => !Number.isNaN(x.t) && x.t > limite)
    .sort((x, y) => y.t - x.t)[0];
  if (reciente) {
    return {
      accion: 'rechazar', motivo: 'cerrada_hace_poco', candidato_id: reciente.p.id, vacante: vacanteDe(reciente.p),
      puede_desde: new Date(reciente.t + DIAS_PARA_REPOSTULAR * 86_400_000).toISOString(), en_lista_negra,
    };
  }

  return { accion: 'crear', en_lista_negra };
}

/**
 * Lo que se le contesta a la persona. `porWhatsapp`: el teléfono es suyo, así que se puede nombrar la vacante;
 * por la web NO (cualquiera teclea el teléfono de otro). La lista negra nunca se menciona.
 */
export function respuestaPublica(d: Decision, porWhatsapp: boolean): string {
  if (d.accion === 'crear') return 'Recibimos tu postulación. Te vamos a contactar.';
  const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'long', year: 'numeric' }) : '');
  if (d.motivo === 'cerrada_hace_poco') {
    return porWhatsapp && d.vacante
      ? `Ya participaste para ${d.vacante}. Puedes volver a postularte a partir del ${fecha(d.puede_desde)}.`
      : `Ya participaste hace poco para esta vacante. Puedes volver a postularte a partir del ${fecha(d.puede_desde)}.`;
  }
  if (porWhatsapp && d.vacante) {
    return d.motivo === 'en_proceso_misma_vacante'
      ? `Ya tienes una postulación para ${d.vacante} y sigue en proceso.`
      : `Ya estás en proceso para ${d.vacante}. Sólo se puede estar en un proceso a la vez.`;
  }
  return 'Ya hay una postulación en proceso con este teléfono. Sólo se puede estar en un proceso a la vez.';
}
