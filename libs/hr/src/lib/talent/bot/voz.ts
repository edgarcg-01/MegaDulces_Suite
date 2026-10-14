/**
 * Fase RH · `[RH.3.3.1]` — las NOTAS DE VOZ del registro por WhatsApp. Lógica pura, portada de `transcribir.js` de Mega
 * Talento: mucha gente contesta por audio (es más rápido y hay quien escribe con dificultad); el texto entra al flujo
 * COMO SI LO HUBIERA ESCRITO, y SIEMPRE se le repite lo que se entendió — una transcripción equivocada que se guarda
 * callada deja un dato falso en su registro sin que se entere.
 */

/** Palabras de la casa: con este empujón Whisper no escribe «ana quelista» ni «curb». */
export const PISTA_VOZ = 'MegaDulces, Mega Dulces, anaquelista, bodeguero, cajera, vendedor, auxiliar de prevención, '
  + 'CURP, RFC, NSS, IMSS, INE, currículum, vacante, sucursal, Morelia, Zamora, Yurécuaro, La Piedad, Santa Ana Pacueco, '
  + 'Canindo, Padre Hidalgo, Michoacán.';

/**
 * Con audio en silencio o puro ruido, Whisper NO devuelve vacío: se inventa frases de los subtítulos con que lo
 * entrenaron (en Mega Talento, dos segundos de silencio dieron «Gracias por ver el video.»). Se tratan como «no te
 * entendí». Sólo cuando la frase ES el mensaje completo: un «… gracias» al final de algo real sí se conserva.
 */
const ALUCINACIONES = [
  /^gracias por ver (el )?(v[ií]deo|este v[ií]deo)\.?!?$/i,
  /^¡?gracias por (ver|su atenci[oó]n|acompa[ñn]arme)\.?!?$/i,
  /^subt[ií]tulos? (realizados|por|creados)/i,
  /amara\.org/i,
  /^(suscr[ií]bete|s[ií]guenos|no olvides suscribirte)/i,
  /^thanks? for watching/i,
  /^(please )?subscribe/i,
  /^www\./i,
  /^\.+$/,
  /^(mm+|ah+|eh+|uh+|hm+)\.?$/i,
];

export function esAlucinacion(texto: string | null | undefined): boolean {
  const t = String(texto ?? '').trim();
  return !t || ALUCINACIONES.some((re) => re.test(t));
}

/** El nombre de archivo que espera el proveedor (deduce el formato por la extensión). WhatsApp manda ogg/opus. */
export function nombreAudio(mime: string | null | undefined): string {
  const t = String(mime ?? '').toLowerCase();
  const ext = t.includes('mpeg') || t.includes('mp3') ? 'mp3'
    : t.includes('mp4') || t.includes('m4a') ? 'm4a'
      : t.includes('wav') ? 'wav'
        : t.includes('webm') ? 'webm'
          : t.includes('amr') ? 'amr'
            : 'ogg';
  return `nota.${ext}`;
}

export type MotivoFallaVoz = 'sin_llave' | 'vacio' | 'muy_grande' | 'sin_audio' | 'error';

/** Lo que se le dice cuando no se entendió su audio: cada motivo le pide algo distinto. */
export function mensajeFallaVoz(motivo: MotivoFallaVoz): string {
  if (motivo === 'muy_grande') {
    return '🎤 Tu nota de voz es muy larga y no la pude procesar. ¿Me la mandas *más corta* o mejor *escríbeme* la respuesta?';
  }
  if (motivo === 'vacio') {
    return '🎤 Escuché tu nota pero no alcancé a distinguir lo que dijiste. ¿Lo intentas de nuevo hablando un poco más cerca, o me lo *escribes*?';
  }
  if (motivo === 'sin_llave') {
    return '🎤 Recibí tu nota de voz, pero ahorita no puedo escucharla. ¿Me *escribes* tu respuesta, por favor?';
  }
  return '🎤 No pude entender tu nota de voz 😕 ¿Me la mandas otra vez o me lo *escribes*?';
}

/** El eco de lo que se entendió, delante de la primera respuesta. */
export function conEco(transcripcion: string, respuestas: readonly string[]): string[] {
  const eco = `🎤 _Escuché:_ "${transcripcion}"`;
  return respuestas.length ? [`${eco}\n\n${respuestas[0]}`, ...respuestas.slice(1)] : [eco];
}

/** Traduce el error del servicio de transcripción a un motivo para la persona. */
export function motivoDe(error: string | undefined): MotivoFallaVoz {
  if (error === 'no_key') return 'sin_llave';
  if (error === 'too_big') return 'muy_grande';
  return 'error';
}
