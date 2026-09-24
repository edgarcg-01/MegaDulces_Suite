/**
 * `[GX.16]` — **Proponer qué área de gasto le toca a cada persona.** Función pura.
 *
 * El problema medido el 2026-09-24: de **76 usuarios** con permiso de capturar gastos,
 * **0 tenían un área asignada**. El selector existe en `/admin/usuarios` desde GX.8 y
 * nadie lo usó, así que **63 abrían su bandeja y veían una lista vacía** — que no se lee
 * como un error, se lee como «no tenés nada pendiente».
 *
 * ## ⚠️ Por qué la regla es tan estricta
 * Asignar un área **da visibilidad sobre el gasto de otra persona**. Una propuesta mal
 * hecha que alguien confirma en lote es una fuga, no un error cosmético.
 *
 * El primer matcher que escribí comparaba tokens en común, y sobre los datos reales
 * proponía cosas como:
 *
 * | Usuario | Propuesta | Por qué está mal |
 * |---|---|---|
 * | `Miriam Jazmin Carrillo Contreras` | `JUAN JESUS CARRILLO CONTRERAS` | otra persona, mismos apellidos |
 * | `Maria del Pilar Nava Tafoya` | `MARIA DEL CARMEN RODRIGUEZ VERA` | coincide «MARIA» y nada más |
 * | `JOSE LUIS MUÑOZ MOTA` | `LUIS F` | un token suelto |
 *
 * La regla que queda **mata los tres**: el nombre del área tiene que estar **contenido
 * entero** en el de la persona (subconjunto), y tener al menos dos palabras propias.
 * `JUAN JESUS CARRILLO CONTRERAS` no está contenido en `Miriam … Carrillo Contreras`
 * porque le faltan `JUAN` y `JESUS`.
 *
 * Medida con esa regla sobre los 76: **17 ya casan exacto, 10 reciben una propuesta única
 * y 2 reciben varias** (que resultaron ser el mismo nombre escrito de tres formas en el
 * catálogo). Quedan **47 sin propuesta** — y eso se declara, no se rellena: para esos la
 * asignación sigue siendo a mano, que es justamente lo que la pantalla deja hacer.
 */

/** Palabras que no distinguen a nadie y ensucian la comparación. */
const VACIAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'SUC', 'SUCURSAL', 'SRA', 'SR']);

/**
 * Mayúsculas, sin acentos y con un solo espacio.
 *
 * Quitar acentos NO es cosmético: el catálogo trae `PERLA GARCÍA` y `PILAR GARCIA`
 * —la misma familia de nombres escrita de las dos formas—, y sin normalizarlos se
 * pierden 3 coincidencias exactas de las 17.
 */
export function normalizarNombre(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Las palabras que sí distinguen: 3 letras o más y que no sean de relleno. */
export function tokensDeNombre(s: string | null | undefined): string[] {
  return normalizarNombre(s).split(' ').filter((t) => t.length >= 3 && !VACIAS.has(t));
}

export interface AreaCandidata {
  id: string;
  name: string;
  /** Cuántas solicitudes trae esa área. Es la evidencia que mira quien confirma. */
  solicitudes?: number;
}

export type MotivoPropuesta = 'exacta' | 'contenida' | 'sin_propuesta';

export interface PropuestaDeAreas {
  motivo: MotivoPropuesta;
  /** Las áreas que se proponen. Vacío cuando `motivo` es `sin_propuesta`. */
  areas: AreaCandidata[];
  /** Frase corta para la pantalla: por qué se propone esto y no otra cosa. */
  explicacion: string;
}

/**
 * Qué áreas proponerle a una persona, a partir de su nombre.
 *
 * Devuelve **varias** cuando varias pasan la regla, y eso es correcto, no ambigüedad:
 * `ANGEL ALBERTO VAZQUEZ MEJIA` tiene en el catálogo `ANGEL MEJÍA`, `ANGEL MEJIA` y
 * `ANGEL VAZQUEZ MEJIA` — es el mismo nombre escrito de tres formas, y las tres le
 * corresponden. El campo del usuario es una lista justamente para eso.
 *
 * ⚠️ Nunca inventa: si nada pasa la regla devuelve `sin_propuesta` con su motivo. Bajar
 * el umbral para que «no quede nadie sin propuesta» es exactamente cómo se cuela el caso
 * `Miriam → JUAN JESUS`.
 */
export function proponerAreas(nombreUsuario: string | null | undefined, areas: readonly AreaCandidata[]): PropuestaDeAreas {
  const nk = normalizarNombre(nombreUsuario);
  if (!nk) {
    return { motivo: 'sin_propuesta', areas: [], explicacion: 'el usuario no tiene nombre capturado' };
  }

  // 1 · Coincidencia exacta. Es la que ya funciona hoy sin asignar nada (el alcance cae
  //     al nombre), pero se propone igual: dejarla escrita sobrevive a que alguien le
  //     corrija el nombre a la persona.
  const exactas = areas.filter((a) => normalizarNombre(a.name) === nk);
  if (exactas.length) {
    return {
      motivo: 'exacta',
      areas: exactas,
      explicacion: 'el nombre del área es idéntico al de la persona',
    };
  }

  // 2 · El nombre del área, contenido ENTERO en el de la persona.
  const tu = new Set(tokensDeNombre(nombreUsuario));
  const contenidas = areas.filter((a) => {
    const ta = tokensDeNombre(a.name);
    // Dos palabras como mínimo: con una sola, «GLORIA» casaría con cualquier Gloria de
    // la empresa, y «LUIS F» con cualquier Luis.
    return ta.length >= 2 && ta.every((t) => tu.has(t));
  });

  if (contenidas.length) {
    return {
      motivo: 'contenida',
      areas: contenidas,
      explicacion: contenidas.length === 1
        ? `«${contenidas[0].name}» está contenido en el nombre de la persona`
        : `${contenidas.length} variantes del mismo nombre están contenidas en el de la persona`,
    };
  }

  return {
    motivo: 'sin_propuesta',
    areas: [],
    explicacion: 'ningún área del catálogo está contenida en su nombre — hay que elegirla a mano',
  };
}
