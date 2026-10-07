/**
 * Elección de la voz del asistente: **femenina y latina**, o la menos mala.
 *
 * Vive fuera del componente y sin tocar el DOM porque es la pieza con reglas de
 * negocio (qué acento queremos, qué voz es de mujer) y es la que hay que poder
 * probar. El componente sólo le pasa lo que `speechSynthesis.getVoices()` le dio.
 *
 * **Por qué hace falta puntuar en vez de nombrar una voz:** `getVoices()` depende
 * del SISTEMA operativo y del navegador, no del proyecto. La misma app en un
 * Windows con Español (México) instalado ofrece *Sabina*; en Edge ofrece *Dalia*;
 * en un Chrome con voces de Google ofrece *Google español de Estados Unidos*; y
 * en un Windows recién instalado no ofrece **ninguna** en español. Hardcodear un
 * nombre garantiza que falle en la mayoría de las máquinas.
 */

/** Lo mínimo que necesitamos de una voz. Compatible con `SpeechSynthesisVoice`. */
export interface VozDisponible {
  name: string;
  lang: string;
  default?: boolean;
}

export interface EleccionDeVoz {
  /** La voz a usar, o `null` si no hay ninguna en español. */
  voz: VozDisponible | null;
  /** `false` = no hay voz española instalada; va a leer español con otro idioma. */
  esEspanol: boolean;
  /** Qué mostrar en pantalla (la elegida, o la que el sistema va a usar igual). */
  etiqueta: string | null;
}

/**
 * Femeninas conocidas en español. `SpeechSynthesisVoice` **no expone el sexo**
 * (no hay `v.gender`), así que se infiere del nombre — es la única señal que da
 * el API. Sabina = Windows es-MX · Dalia = Azure/Edge es-MX · Paloma, Renata,
 * Marina, Isabela, Camila = otras latinas · Helena, Laura, Elena = es-ES.
 */
const FEMENINAS = /sabina|dalia|paloma|renata|marina|isabela|camila|m[oó]nica|elena|laura|helena|female|mujer/;

/** Masculinas conocidas: restan, para no elegirlas por descarte. */
const MASCULINAS = /ra[uú]l|jorge|pablo|carlos|liberto|male|hombre/;

/** Latinoamérica sin México (México se puntúa aparte, más alto). */
const LATAM = /^es-(us|419|co|ar|cl|pe|ve|ec|gt|cr|bo|do|hn|ni|pa|py|sv|uy)/;

/** Puntaje de una voz. Mayor = mejor para "mujer latina". */
export function puntuarVoz(v: VozDisponible): number {
  const n = (v.name || '').toLowerCase();
  const l = (v.lang || '').toLowerCase();
  let p = 0;

  // 1) Acento. México primero porque es el mercado; el resto de LATAM después.
  //    España RESTA: es español correcto, pero no es lo que se pidió.
  if (l.startsWith('es-mx')) p += 40;
  else if (LATAM.test(l)) p += 30;
  else if (l.startsWith('es-es')) p -= 20;
  else p += 10; // `es` pelado u otra variante: mejor que nada

  // 2) Sexo inferido del nombre (el API no lo da).
  if (FEMENINAS.test(n)) p += 25;
  if (MASCULINAS.test(n)) p -= 25;

  // 3) Las voces de nube (Google / neural) suenan bastante mejor que las
  //    locales viejas de Windows, así que empatan a favor.
  if (/google|natural|neural|online/.test(n)) p += 10;

  return p;
}

/**
 * Elige entre las voces del sistema. Nunca lanza: si no hay ninguna en español
 * devuelve `esEspanol: false` con la etiqueta de la que el navegador va a usar
 * igual, para que la pantalla pueda avisar en vez de sonar raro sin explicación.
 */
export function elegirVozLatina(voces: readonly VozDisponible[] | null | undefined): EleccionDeVoz {
  const todas = voces || [];
  if (!todas.length) return { voz: null, esEspanol: true, etiqueta: null };

  const es = todas.filter((v) => /^es/i.test(v.lang || ''));
  if (!es.length) {
    const fallback = todas.find((v) => v.default) || todas[0];
    return {
      voz: null,
      esEspanol: false,
      etiqueta: fallback ? `${fallback.name} (${fallback.lang})` : null,
    };
  }

  // `sort` estable en ES2019+: ante empate gana la que el sistema listó primero.
  const mejor = [...es].sort((a, b) => puntuarVoz(b) - puntuarVoz(a))[0];
  return { voz: mejor, esEspanol: true, etiqueta: `${mejor.name} (${mejor.lang})` };
}
