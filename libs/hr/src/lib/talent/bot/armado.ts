import {
  CMD_SEGUIR, K_CONSENTIMIENTO, PREGUNTAS, aplicables, atras, etiqueta, progreso, purgarSensibles, responder, siguiente,
  textoPregunta, type CtxSolicitud, type Respuestas,
} from './solicitud';

/**
 * Fase RH · `[RH.3.3.3]` — la CONVERSACIÓN del armado del CV, pura (la portada de los casos 4.7-a…e de `conversacion.js`
 * de Mega Talento). Cuatro estados, y cada uno existe por algo:
 *   armando_solicitud     → contestando las preguntas
 *   solicitud_pausada     → pidió parar; si no, el «ahí vengo» se guardaría como la respuesta en turno
 *   revisando_cv          → ya recibió su CV y decide si se sube
 *   corrigiendo_solicitud → dijo que algo está mal y falta saber QUÉ dato
 *
 * El servicio hace lo que necesita base o red: guardar la foto, armar el PDF (efecto `armar_cv`) y postularlo
 * (efecto `subir_cv`).
 */

export const ESTADOS_ARMADO = ['armando_solicitud', 'solicitud_pausada', 'revisando_cv', 'corrigiendo_solicitud'] as const;
export type EstadoArmado = (typeof ESTADOS_ARMADO)[number];
export const esEstadoArmado = (e: string): e is EstadoArmado => (ESTADOS_ARMADO as readonly string[]).includes(e);

/** Lo que se guarda en `bot_conversations.application`. */
export interface Aplicacion {
  respuestas: Respuestas;
  /** El consentimiento de lo sensible: la VERSIÓN del texto que aceptó (o rechazó) y cuándo. */
  consentimiento?: { version: string; acepto: boolean; en: string } | null;
  foto_key?: string | null;
  cv_key?: string | null;
  iniciada_en: string;
  terminada_en?: string | null;
}

export interface TurnoArmado {
  estado: string;
  app: Aplicacion;
  respuestas: string[];
  /** `armar_cv`: el servicio arma el PDF y se lo manda. `subir_cv`: lo postula con ese PDF. */
  efecto?: 'armar_cv' | 'subir_cv';
}

const OFRECER_ARMAR_CV = '¿No tienes *currículum*? No hay problema, *yo te lo armo* 🙌\n\n'
  + 'Te voy a hacer las preguntas de la *solicitud de empleo* y con tus respuestas te entrego tu CV hecho, con diseño y '
  + 'listo para tu postulación.\n\n⏱️ Son bastantes preguntas (unos 15-20 minutos). Puedes contestar a tu ritmo:\n'
  + '• Escribe *pausa* cuando quieras parar, y *seguir* para continuar.\n• Escribe *atrás* si te equivocaste en la anterior.\n'
  + '• Si un dato no lo tienes, escribe *no tengo* y seguimos.\n\nVa la primera 👇';

const TERMINAMOS = '¡Terminamos! 🎉 Con todo lo que me contaste te armé tu *currículum*.\n\n'
  + 'Te lo mando aquí mismo para que lo *revises antes* de subirlo a tu postulación 👇';

export const COMO_LO_VES = '¿Cómo lo ves? 📄\n\n• Si está bien, contesta *sí* y lo subo a tu postulación.\n• Si algo está mal, escribe *corregir*.';

/** Arranca el armado (desde «esperando el CV», cuando dijo que no tiene). */
export function iniciarArmado(ctx: CtxSolicitud, ahora: Date, previa?: Aplicacion | null): TurnoArmado {
  const app: Aplicacion = previa ?? { respuestas: {}, iniciada_en: ahora.toISOString() };
  const q = siguiente(app.respuestas, ctx);
  if (!q) return { estado: 'revisando_cv', app, respuestas: [TERMINAMOS], efecto: 'armar_cv' };
  return { estado: 'armando_solicitud', app, respuestas: [`${OFRECER_ARMAR_CV}\n\n${textoPregunta(q, app.respuestas, ctx)}`] };
}

/** Guarda una respuesta (con la evidencia del consentimiento si toca) y purga lo sensible sin consentimiento. */
function guardar(app: Aplicacion, k: string, valor: string, ctx: CtxSolicitud, ahora: Date): Aplicacion {
  const consentimiento = k === K_CONSENTIMIENTO && ctx.consentimiento
    ? { version: ctx.consentimiento.version, acepto: /^s[ií]$/i.test(valor), en: ahora.toISOString() }
    : app.consentimiento;
  return { ...app, consentimiento: consentimiento ?? null, respuestas: purgarSensibles({ ...app.respuestas, [k]: valor }, ctx) };
}

/** Lo siguiente tras guardar: la próxima pregunta (con ánimo si cerró un bloque), o el fin del armado. */
function continuar(app: Aplicacion, anteriorBloque: string | null, ctx: CtxSolicitud, ahora: Date): TurnoArmado {
  const q = siguiente(app.respuestas, ctx);
  if (!q) return { estado: 'revisando_cv', app: { ...app, terminada_en: ahora.toISOString() }, respuestas: [TERMINAMOS], efecto: 'armar_cv' };
  const animo = anteriorBloque && q.bloque !== anteriorBloque ? '¡Listo ese bloque! ✅\n\n' : '';
  return { estado: 'armando_solicitud', app, respuestas: [animo + textoPregunta(q, app.respuestas, ctx)] };
}

/** Llegó la FOTO (el servicio ya la guardó): se registra y sigue. Sólo si la pregunta en turno es la foto. */
export function aplicarFoto(app: Aplicacion, fotoKey: string, ctx: CtxSolicitud, ahora: Date): TurnoArmado | null {
  const q = siguiente(app.respuestas, ctx);
  if (!q || q.tipo !== 'foto') return null;
  const nueva = { ...guardar(app, q.k, 'Foto recibida', ctx, ahora), foto_key: fotoKey };
  return continuar(nueva, q.bloque, ctx, ahora);
}

/** Lo que se le recuerda tras un mensaje que no se pudo atender (audio sin llave, un archivo fuera de lugar…). */
export function pendienteArmado(estado: EstadoArmado, app: Aplicacion, ctx: CtxSolicitud): string {
  if (estado === 'armando_solicitud') {
    const q = siguiente(app.respuestas, ctx);
    return q ? `\n\n${textoPregunta(q, app.respuestas, ctx, { conAvance: false })}` : '';
  }
  if (estado === 'solicitud_pausada') return '\n\nCuando puedas seguir, escribe *seguir* y continuamos donde nos quedamos.';
  if (estado === 'revisando_cv') return `\n\n${COMO_LO_VES}`;
  return '\n\nDime qué dato quieres corregir, o escribe *ninguno*.';
}

// Para «corregir»: palabras que no distinguen nada, y cómo dice la gente los datos contra cómo se llaman en la hoja.
const PALABRAS_HUECAS = new Set([
  'que', 'cual', 'cuales', 'para', 'con', 'los', 'las', 'una', 'uno', 'del', 'dime', 'quiero', 'cambiar', 'cambia', 'corregir',
  'corrige', 'dato', 'datos', 'esta', 'este', 'esa', 'ese', 'eso', 'mal', 'por', 'favor', 'tengo', 'tiene', 'como', 'donde',
  'cuando', 'cuanto', 'mis', 'sus', 'tus', 'ahi', 'algo', 'esto', 'estan', 'error', 'equivoque', 'arregla', 'poner', 'pon', 'dice',
]);
const SINONIMOS: Record<string, string> = {
  correo: 'email', mail: 'email', gmail: 'email', celular: 'telefono', numero: 'telefono', tel: 'telefono',
  direccion: 'domicilio', calle: 'domicilio', trabajo: 'compania', empresa: 'compania', chamba: 'compania',
  salario: 'sueldo', pago: 'sueldo', nacimiento: 'fecha de nacimiento', estudios: 'escuela', prepa: 'preparatoria', universidad: 'profesional',
};
const sinAcentos = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** A qué pregunta(s) se refiere («mi correo», «la escuela»): primero por la ETIQUETA, luego por el texto de la pregunta. */
export function preguntasQueSuenanA(texto: string, d: Respuestas, ctx: CtxSolicitud): Array<{ k: string; etiqueta: string }> {
  const limpio = sinAcentos(texto).replace(/[^a-z0-9 ]/g, ' ').trim();
  if (limpio.length < 3) return [];
  const pegado = (x: string): string => sinAcentos(x).replace(/[^a-z0-9]/g, '');
  const buscadas = [...new Set(limpio.split(/\s+/).filter((p) => p.length >= 3 && !PALABRAS_HUECAS.has(p)).map((p) => pegado(SINONIMOS[p] ?? p)))].filter(Boolean);
  if (!buscadas.length) return [];
  const contestadas = aplicables(d, ctx).filter((q) => d[q.k] !== undefined && q.tipo !== 'foto');
  const porEtiqueta = contestadas.filter((q) => buscadas.some((p) => pegado(q.etiqueta).includes(p)));
  const halladas = porEtiqueta.length ? porEtiqueta
    : contestadas.filter((q) => typeof q.pregunta === 'string' && buscadas.some((p) => pegado(q.pregunta as string).includes(p)));
  return halladas.map((q) => ({ k: q.k, etiqueta: q.etiqueta }));
}

/** Un mensaje de texto en un estado del armado. */
export function avanzarArmado(estado: EstadoArmado, app: Aplicacion, textoCrudo: string | null, ctx: CtxSolicitud, ahora: Date): TurnoArmado {
  const texto = (textoCrudo ?? '').trim();
  const turno = (e: string, a: Aplicacion, msg: string): TurnoArmado => ({ estado: e, app: a, respuestas: [msg] });

  if (estado === 'armando_solicitud') {
    const q = siguiente(app.respuestas, ctx);
    if (!q) return { estado: 'revisando_cv', app, respuestas: [TERMINAMOS], efecto: 'armar_cv' };
    const r = responder(q, texto, app.respuestas, ctx);
    if ('comando' in r && r.comando === 'pausa') {
      const p = progreso(app.respuestas, ctx);
      return turno('solicitud_pausada', app, `Sin problema, aquí le paramos ✋ Llevas *${p.hechas} respuestas* (vas en el bloque ${p.bloque} de ${p.bloquesTotal}) `
        + 'y todo quedó guardado.\n\nCuando quieras seguir, escribe *seguir* y retomamos justo donde nos quedamos. 🙌');
    }
    if ('comando' in r) {
      const { respuestas, borrada } = atras(app.respuestas, ctx);
      if (!borrada) return turno(estado, app, `Todavía no hay nada que corregir 🙂\n\n${textoPregunta(q, app.respuestas, ctx)}`);
      const nueva = { ...app, respuestas: purgarSensibles(respuestas, ctx), ...(borrada === 'foto' ? { foto_key: null } : {}) };
      const q2 = siguiente(nueva.respuestas, ctx) ?? q;
      return turno(estado, nueva, `Va de nuevo, corregimos *${etiqueta(borrada)}* 👇\n\n${textoPregunta(q2, nueva.respuestas, ctx)}`);
    }
    if ('esperaFoto' in r) {
      return turno(estado, app, 'Para la foto necesito que me la mandes como *imagen* 📷 (el clip 📎 → Galería o Cámara).\n\n'
        + '_Si prefieres que tu CV no lleve foto, escribe *sin foto*._');
    }
    if ('error' in r) return turno(estado, app, `${r.error}\n\n${textoPregunta(q, app.respuestas, ctx, { conAvance: false })}`);
    return continuar(guardar(app, q.k, r.valor, ctx, ahora), q.bloque, ctx, ahora);
  }

  if (estado === 'solicitud_pausada') {
    if (CMD_SEGUIR.test(texto) || /seguir|continuar|retomar|ya estoy|vamos/i.test(texto)) {
      const q = siguiente(app.respuestas, ctx);
      if (!q) return { estado: 'revisando_cv', app, respuestas: [TERMINAMOS], efecto: 'armar_cv' };
      return turno('armando_solicitud', app, `¡Perfecto, retomamos! 🙌\n\n${textoPregunta(q, app.respuestas, ctx)}`);
    }
    const p = progreso(app.respuestas, ctx);
    return turno(estado, app, `Tu solicitud está *guardada*: ${p.hechas} respuestas, bloque ${p.bloque} de ${p.bloquesTotal} 💾\n`
      + 'Cuando puedas seguir, escribe *seguir* y continuamos donde nos quedamos.');
  }

  if (estado === 'revisando_cv') {
    // `(?![a-z…])` en vez de `\b`: en JS `\b` no reconoce el borde tras una vocal acentuada («sí, está bien»).
    if (/^(s[ií]|sube|s[uú]belo|est[aá] bien|as[ií] est[aá] bien|correcto|ok|okey|dale|va|listo|perfecto|me gusta)(?![a-záéíóúñ])/i.test(texto)) {
      return { estado, app, respuestas: [], efecto: 'subir_cv' };
    }
    if (/corregir|corrige|cambiar|cambia|mal|error|equivoc|arregla/i.test(texto)) {
      return turno('corrigiendo_solicitud', app, '¡Claro! ¿*Qué dato* quieres corregir? Escríbeme cómo se llama, por ejemplo:\n'
        + '• *correo*\n• *teléfono*\n• *escuela*\n• *puesto*\n• *funciones*\n\n_O escribe *ninguno* si mejor lo dejamos así._');
    }
    return turno(estado, app, COMO_LO_VES);
  }

  // corrigiendo_solicitud
  if (/^(ninguno|ninguna|nada|as[ií] est[aá] bien|d[eé]jalo|ya|olv[ií]dalo)(?![a-záéíóúñ])/i.test(texto)) {
    return turno('revisando_cv', app, 'Va, lo dejamos así 🙂 Contesta *sí* para que lo suba a tu postulación.');
  }
  const halladas = preguntasQueSuenanA(texto, app.respuestas, ctx);
  if (!halladas.length) {
    return turno(estado, app, 'No encontré ese dato 🤔 Dime una palabra del dato, por ejemplo *correo*, *domicilio*, *empresa*, *sueldo*, *referencia*.\n\n'
      + '_O escribe *ninguno* para dejarlo así._');
  }
  if (halladas.length > 1) {
    return turno(estado, app, `Hay varios datos que se llaman parecido. ¿Cuál de estos es?\n\n${halladas.slice(0, 6).map((q) => `• *${q.etiqueta}*`).join('\n')}`
      + '\n\nEscríbelo tal como aparece aquí.');
  }
  // Se borra la respuesta: la máquina vuelve a preguntar justo ésa, y al contestarla el CV se arma de nuevo solo.
  const k = halladas[0].k;
  const resto = { ...app.respuestas };
  delete resto[k];
  const nueva: Aplicacion = { ...app, respuestas: purgarSensibles(resto, ctx), cv_key: null, terminada_en: null };
  const cual = siguiente(nueva.respuestas, ctx);
  const q = cual ?? PREGUNTAS.find((x) => x.k === k);
  return turno('armando_solicitud', nueva, `Corregimos *${halladas[0].etiqueta}* 👇\n\n${q ? textoPregunta(q, nueva.respuestas, ctx, { conAvance: false }) : ''}`);
}
