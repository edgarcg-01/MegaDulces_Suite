import { HR_HOY_NOTA_NO_CONTESTO, type HrCandidatoEventoNuevo, type HrHoyCandidatoDto, type HrHoyPendienteId, type HrTalentEtapa } from '@megadulces/contracts';
import { ETAPAS, siguienteEtapa } from './reclutamiento-formato';

/**
 * Fase RH · `[RH.17.1]` — lo puro de «Hoy»: los textos de cada pendiente, las respuestas de la tarjeta «uno por uno» y
 * QUÉ GUARDA cada respuesta. La regla de en qué pendiente cae cada quien es del servidor (`logic/hoy.ts`); aquí sólo se
 * traduce lo que la persona contesta a los endpoints que ya existen (eventos y etapa), para poder probarlo sin pantalla.
 */

export const TEXTO_PENDIENTE: Readonly<Record<HrHoyPendienteId, { titulo: string; por: string; fin: string }>> = {
  nuevos: { titulo: 'Llamar a los nuevos', por: 'Mandaron su CV hace poco y nadie de RH les ha hablado.', fin: 'Llamaste a los nuevos' },
  seguimiento: { titulo: 'Dar seguimiento', por: 'Ya pasó el tiempo que RH se dio para contestarles en su etapa.', fin: 'Diste seguimiento' },
  expediente: { titulo: 'Revisar expedientes completos', por: 'Ya mandaron todos sus documentos: revísalos y pásalos de etapa.', fin: 'Revisaste los expedientes' },
  jefe: { titulo: 'Pedir la evaluación al jefe', por: 'Están en Aptitudes y el jefe que los entrevista todavía no la llena.', fin: 'Pediste las evaluaciones' },
};

/** Motivos de un clic para cerrar a alguien. Quedan escritos en su historia. */
export const MOTIVOS_CIERRE = ['No contestó', 'No le interesa', 'No cumple el perfil', 'Sueldo', 'Le queda lejos'] as const;

/** Al tercer «No contestó» se pregunta si se cierra (antes de eso, vuelve a salir en seguimiento). */
export const INTENTOS_PARA_PREGUNTAR = 3;

export type RespuestaId = 'interesa' | 'no_contesto' | 'agendo' | 'cerrar' | 'exp_bien' | 'exp_mal' | 'liga_jefe';

export interface Respuesta { id: RespuestaId; titulo: string; ayuda: string; tecla: string }

const corto = (id: HrTalentEtapa): string => ETAPAS.find((e) => e.id === id)?.corto ?? id;

/** Las respuestas de la tarjeta, según el pendiente y la etapa de la persona. */
export function respuestasDe(p: HrHoyPendienteId, c: Pick<HrHoyCandidatoDto, 'stage' | 'intentos_sin_respuesta'>): Respuesta[] {
  if (p === 'expediente') {
    const s = siguienteEtapa(c.stage);
    return [
      { id: 'exp_bien', titulo: 'Todo bien', ayuda: s ? `Pasa a ${corto(s)}` : 'Queda revisado', tecla: '1' },
      { id: 'exp_mal', titulo: 'Un documento está mal', ayuda: 'Abre su ficha para retirarlo y pedirlo otra vez', tecla: '2' },
    ];
  }
  if (p === 'jefe') {
    return [{ id: 'liga_jefe', titulo: 'Mandar la liga al jefe', ayuda: 'Se crea su liga; la mandas por WhatsApp o la copias', tecla: '1' }];
  }
  const s = siguienteEtapa(c.stage);
  const intento = c.intentos_sin_respuesta + 1;
  return [
    { id: 'interesa', titulo: 'Le interesa', ayuda: s ? `Pasa a ${corto(s)}` : 'Se anota el contacto', tecla: '1' },
    { id: 'no_contesto', titulo: 'No contestó', ayuda: intento >= INTENTOS_PARA_PREGUNTAR ? `Es su ${intento}.º intento: te pregunto si se cierra` : 'Vuelve a salir en seguimiento', tecla: '2' },
    { id: 'agendo', titulo: 'Agendé entrevista', ayuda: 'Eliges el día y la hora', tecla: '3' },
    { id: 'cerrar', titulo: 'Ya no le interesa', ayuda: 'Se cierra con su motivo', tecla: '4' },
  ];
}

/** Una llamada a la API, en el orden en que se hace. */
export type Paso = { tipo: 'evento'; cuerpo: HrCandidatoEventoNuevo } | { tipo: 'etapa'; stage: HrTalentEtapa };

/**
 * Lo que guarda cada respuesta, como pasos sobre los endpoints que ya existen. El ORDEN importa: si el segundo paso
 * falla, el primero ya quedó, así que primero va lo que no se puede perder (el contacto o el cambio de etapa).
 */
export function planDe(r: RespuestaId, c: Pick<HrHoyCandidatoDto, 'stage'>, extra: { motivo?: string; cuando?: string } = {}): Paso[] {
  const s = siguienteEtapa(c.stage);
  switch (r) {
    case 'interesa':
      return [{ tipo: 'evento', cuerpo: { event_type: 'contacto', channel: 'llamada', note: 'Le interesa' } }, ...(s ? [{ tipo: 'etapa', stage: s } as Paso] : [])];
    case 'no_contesto':
      return [{ tipo: 'evento', cuerpo: { event_type: 'contacto', channel: 'llamada', note: HR_HOY_NOTA_NO_CONTESTO } }];
    case 'agendo':
      return [{ tipo: 'evento', cuerpo: { event_type: 'entrevista', channel: 'llamada', note: `Entrevista agendada: ${extra.cuando ?? 'sin fecha'}` } },
        ...(c.stage === 'filtro_inicial' ? [{ tipo: 'etapa', stage: 'entrevista_rh' } as Paso] : [])];
    case 'cerrar':
      return [{ tipo: 'etapa', stage: 'rechazado' }, { tipo: 'evento', cuerpo: { event_type: 'nota', channel: 'portal', note: `Se cerró: ${extra.motivo ?? 'sin motivo'}` } }];
    case 'exp_bien':
      return [...(s ? [{ tipo: 'etapa', stage: s } as Paso] : []), { tipo: 'evento', cuerpo: { event_type: 'nota', channel: 'portal', note: 'Expediente revisado: completo' } }];
    default:
      return [];   // exp_mal abre la ficha; liga_jefe usa POST …/links (deja su propia nota)
  }
}

/** Cómo se cuenta cada respuesta en el resumen de «Terminaste». */
export function resultadoDe(r: RespuestaId, c: Pick<HrHoyCandidatoDto, 'stage'>): string {
  const s = siguienteEtapa(c.stage);
  switch (r) {
    case 'interesa': return s ? `Pasaron a ${corto(s)}` : 'Se anotó el contacto';
    case 'no_contesto': return 'No contestaron (vuelven a salir)';
    case 'agendo': return 'Con entrevista agendada';
    case 'cerrar': return 'Se cerraron con su motivo';
    case 'exp_bien': return s ? `Expediente bien: pasaron a ${corto(s)}` : 'Expediente revisado';
    case 'exp_mal': return 'Con un documento por corregir';
    case 'liga_jefe': return 'Liga enviada al jefe';
  }
}

/** Los próximos días hábiles (lunes a sábado) para agendar, como opciones de un selector. */
export function diasParaAgendar(desde: Date = new Date(), n = 6): Array<{ label: string; value: string }> {
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const out: Array<{ label: string; value: string }> = [];
  for (let d = 1; out.length < n && d < 14; d++) {
    const f = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate() + d);
    if (f.getDay() === 0) continue;
    const etiqueta = `${dias[f.getDay()]} ${f.getDate()} ${meses[f.getMonth()]}`;
    out.push({ label: d === 1 ? `mañana, ${etiqueta}` : etiqueta, value: etiqueta });
  }
  return out;
}

export const HORAS_ENTREVISTA = ['09:00', '10:00', '11:00', '12:00', '13:00', '16:00', '17:00'];
