/**
 * `[NP.7.L.11b]` **Calificación del corpus del levantamiento**: cuánto acierta el lector, campo por campo
 * y en el nivel físico, contra respuestas que una persona etiquetó a mano.
 *
 * Por qué existe: la «confianza» la declara el propio modelo y nadie la ha medido. De este acierto
 * (con su n) salen los umbrales de la compuerta (c) de §10b.3 punto 4, y D2 elige el modelo con él.
 * Hoy el corpus **NO está medido**: esto es el instrumento, no el resultado.
 *
 * Control (plan, criterio de L.11b): con las respuestas **barajadas** entre casos, el acierto tiene que
 * caer a la tasa de clase mayoritaria. Si no cae, la calificación está midiendo otra cosa (un
 * comparador demasiado tolerante, un corpus donde todo es igual) y el número real no vale.
 *
 * Funciones puras y deterministas (sin `Math.random`): el mismo corpus con la misma semilla da el mismo
 * control, para que se pueda repetir y publicar.
 */
import { mismoValor } from './fusion-lecturas';
import {
  NOMBRES_CAMPOS,
  type CamposLeidos, type NivelFisico, type NombreCampo, type PropuestaAmpliada,
} from './lectura-foto.contract';

/**
 * - `acierto`: la respuesta y lo leído coinciden (comparación de la fusión, estricta; listas como conjuntos).
 *   También cuando la respuesta dice «el empaque no lo trae» (`null`) y el lector no inventó nada.
 * - `fallo`: leyó otra cosa, o inventó algo que el empaque no trae.
 * - `no_leido`: el empaque lo trae y el lector devolvió `null`.
 * - `sin_respuesta`: la persona no etiquetó ese campo (`undefined`): no cuenta, ni a favor ni en contra.
 */
export type ResultadoCampo = 'acierto' | 'fallo' | 'no_leido' | 'sin_respuesta';

type ValorDe<K extends NombreCampo> = NonNullable<CamposLeidos[K]>['valor'];

/**
 * La respuesta correcta de un caso, etiquetada a mano. `undefined` (llave ausente) = no se etiquetó;
 * `null` = se revisó y el empaque NO lo trae.
 */
export type RespuestaCorpus = { [K in NombreCampo]?: ValorDe<K> | null } & { nivel_fisico?: NivelFisico | null };

export interface CalificacionLectura {
  campos: Record<NombreCampo, ResultadoCampo>;
  nivel_fisico: ResultadoCampo;
}

export interface CasoCorpus {
  /** SKU o identificador del caso, para poder rastrear un fallo hasta su foto. */
  id: string;
  /** Lo que propuso el lector (fusionado). `null` = la lectura falló: todo lo etiquetado cuenta como no leído. */
  propuesta: PropuestaAmpliada | null;
  respuesta: RespuestaCorpus;
}

export interface ResumenCampo {
  /** Casos etiquetados en este campo (acierto + fallo + no leído). */
  n: number;
  aciertos: number;
  fallos: number;
  no_leidos: number;
  /** `aciertos / n`; `null` con n = 0: sin casos no hay tasa (no es 0, regla 11). */
  tasa: number | null;
}

export interface ResumenNivel extends ResumenCampo {
  /** La línea base: el nivel más frecuente en las respuestas y qué tasa daría decir siempre ése. */
  clase_mayoritaria: NivelFisico | null;
  tasa_clase_mayoritaria: number | null;
}

export interface ResumenCorpus {
  casos: number;
  campos: Record<NombreCampo, ResumenCampo>;
  nivel_fisico: ResumenNivel;
}

function calificar(leido: unknown, esperado: unknown): ResultadoCampo {
  if (esperado === undefined) return 'sin_respuesta';
  if (esperado === null) return leido == null ? 'acierto' : 'fallo';
  if (leido == null) return 'no_leido';
  return mismoValor(leido, esperado) ? 'acierto' : 'fallo';
}

export function calificarLectura(propuesta: PropuestaAmpliada | null, respuesta: RespuestaCorpus): CalificacionLectura {
  const campos = {} as Record<NombreCampo, ResultadoCampo>;
  for (const k of NOMBRES_CAMPOS) {
    const esperado = Object.prototype.hasOwnProperty.call(respuesta, k) ? respuesta[k] : undefined;
    campos[k] = calificar(propuesta?.campos?.[k]?.valor ?? null, esperado);
  }
  const nivelEsperado = Object.prototype.hasOwnProperty.call(respuesta, 'nivel_fisico') ? respuesta.nivel_fisico : undefined;
  return { campos, nivel_fisico: calificar(propuesta?.nivel_fisico?.valor ?? null, nivelEsperado) };
}

function vacio(): ResumenCampo {
  return { n: 0, aciertos: 0, fallos: 0, no_leidos: 0, tasa: null };
}

function sumar(r: ResumenCampo, x: ResultadoCampo): void {
  if (x === 'sin_respuesta') return;
  r.n += 1;
  if (x === 'acierto') r.aciertos += 1;
  else if (x === 'fallo') r.fallos += 1;
  else r.no_leidos += 1;
}

function cerrar(r: ResumenCampo): void {
  r.tasa = r.n ? r.aciertos / r.n : null;
}

export function resumenCorpus(casos: CasoCorpus[]): ResumenCorpus {
  const campos = Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, vacio()])) as Record<NombreCampo, ResumenCampo>;
  const nivel = vacio();
  const porNivel = new Map<NivelFisico, number>();
  for (const caso of casos) {
    const cal = calificarLectura(caso.propuesta, caso.respuesta);
    for (const k of NOMBRES_CAMPOS) sumar(campos[k], cal.campos[k]);
    sumar(nivel, cal.nivel_fisico);
    const esperado = caso.respuesta.nivel_fisico;
    if (esperado != null) porNivel.set(esperado, (porNivel.get(esperado) ?? 0) + 1);
  }
  for (const k of NOMBRES_CAMPOS) cerrar(campos[k]);
  cerrar(nivel);
  // Clase mayoritaria (empate → la que apareció primero). Su tasa se calcula sobre los casos con nivel
  // etiquetado (los `null` no tienen clase).
  let clase: NivelFisico | null = null;
  let max = 0;
  for (const [k, v] of porNivel) if (v > max) { clase = k; max = v; }
  const conClase = [...porNivel.values()].reduce((a, b) => a + b, 0);
  return {
    casos: casos.length,
    campos,
    nivel_fisico: { ...nivel, clase_mayoritaria: clase, tasa_clase_mayoritaria: conClase ? max / conClase : null },
  };
}

// ── Control con respuestas barajadas ──────────────────────────────────────────────────────────────

/** Generador con semilla (mulberry32): determinista, sin `Math.random`. */
export function generadorConSemilla(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reparte las respuestas entre los casos con una permutación SIN puntos fijos (algoritmo de Sattolo):
 * ningún caso se queda con su propia respuesta, que es lo que hace de esto un control. Con menos de 2
 * casos no hay a quién pasarle la respuesta y el corpus se devuelve igual (el control no aplica).
 */
export function barajarRespuestas(casos: CasoCorpus[], semilla: number): CasoCorpus[] {
  const respuestas = casos.map((c) => c.respuesta);
  const azar = generadorConSemilla(semilla);
  for (let i = respuestas.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * i); // 0 ≤ j < i: Sattolo
    [respuestas[i], respuestas[j]] = [respuestas[j], respuestas[i]];
  }
  return casos.map((c, i) => ({ ...c, respuesta: respuestas[i] }));
}

/** El mismo resumen, con las respuestas barajadas. Se publica junto al real (criterio de NP.7.L.11b). */
export function controlBarajado(casos: CasoCorpus[], semilla: number): ResumenCorpus {
  return resumenCorpus(barajarRespuestas(casos, semilla));
}
