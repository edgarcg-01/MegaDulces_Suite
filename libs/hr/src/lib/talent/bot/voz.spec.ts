/**
 * `[RH.3.3.1]` Las notas de voz: lo que se descarta como alucinación de Whisper, el nombre que el proveedor necesita
 * para reconocer el formato, el eco de lo entendido y el mensaje según el motivo de la falla.
 */
import { conEco, esAlucinacion, mensajeFallaVoz, motivoDe, nombreAudio } from './voz';

describe('[RH.3.3.1] notas de voz', () => {
  it.each(['Gracias por ver el video.', '¡Gracias por su atención!', 'Subtítulos realizados por la comunidad de Amara.org',
    'Suscríbete al canal', 'Thanks for watching', '...', 'Mmm', '', '   '])('«%s» → alucinación (se le pide repetir)', (t) => {
    expect(esAlucinacion(t)).toBe(true);
  });
  it.each(['Me llamo Ana López, gracias', 'Busco de cajera en Zamora', 'no tengo correo', 'sí'])(
    '«%s» → se conserva (una frase real que termina en «gracias» no es alucinación)', (t) => {
      expect(esAlucinacion(t)).toBe(false);
    });

  it('el nombre del archivo lleva la extensión que el proveedor reconoce; WhatsApp manda ogg/opus', () => {
    expect(nombreAudio('audio/ogg; codecs=opus')).toBe('nota.ogg');
    expect(nombreAudio('audio/mpeg')).toBe('nota.mp3');
    expect(nombreAudio('audio/mp4')).toBe('nota.m4a');
    expect(nombreAudio('audio/webm')).toBe('nota.webm');
    expect(nombreAudio(null)).toBe('nota.ogg');
  });

  it('el eco va delante de la PRIMERA respuesta; sin respuestas, sólo el eco', () => {
    expect(conEco('busco de cajera', ['¡Buenas noticias!', 'segunda'])).toEqual(['🎤 _Escuché:_ "busco de cajera"\n\n¡Buenas noticias!', 'segunda']);
    expect(conEco('hola', [])).toEqual(['🎤 _Escuché:_ "hola"']);
  });

  it('cada falla pide algo distinto', () => {
    expect(mensajeFallaVoz(motivoDe('too_big'))).toMatch(/más corta/);
    expect(mensajeFallaVoz(motivoDe('no_key'))).toMatch(/no puedo escucharla/);
    expect(mensajeFallaVoz('vacio')).toMatch(/más cerca/);
    expect(mensajeFallaVoz(motivoDe('stt_error'))).toMatch(/otra vez o me lo \*escribes\*/);
  });
});
