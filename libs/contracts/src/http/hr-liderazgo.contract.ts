/**
 * Fase RH · `[RH.2.4]` — el CUESTIONARIO DE LIDERAZGO que el candidato contesta por liga. Copia exacta de
 * `mega-talento-90/src/app/core/models/cuestionario-liderazgo.model.ts`: mismas 12 preguntas, misma escala, mismo
 * cálculo, mismo umbral. Vive en el contrato porque lo usan los dos lados: la página lo muestra y el servidor decide
 * con él (en Mega Talento lo decidía el navegador del candidato, que además movía su propia etapa).
 *
 * Modelo interaccionista (conducta orientada a la tarea y a las relaciones), Grid Gerencial de Blake y Mouton:
 * 6 preguntas por dimensión, cada una de 6 a 30.
 */

export interface HrPreguntaLiderazgo {
  num: number;
  texto: string;
  dimension: 'tarea' | 'relaciones';
}

export const HR_NIVELES_LIKERT = [
  { valor: 1, etiquetaCorta: 'Nunca', etiquetaLarga: 'Nunca se comporta de esa manera' },
  { valor: 2, etiquetaCorta: 'Rara vez', etiquetaLarga: 'Rara vez se comporta de esa manera' },
  { valor: 3, etiquetaCorta: 'De vez en cuando', etiquetaLarga: 'De vez en cuando se comporta de esa manera' },
  { valor: 4, etiquetaCorta: 'Frecuentemente', etiquetaLarga: 'Frecuentemente se comporta de esa manera' },
  { valor: 5, etiquetaCorta: 'Siempre', etiquetaLarga: 'Siempre se comporta de esa manera' },
] as const;

export const HR_CUESTIONARIO_LIDERAZGO: readonly HrPreguntaLiderazgo[] = [
  { num: 1, dimension: 'tarea', texto: 'Promueve buenas y duraderas opiniones, ideas, sentimientos e información con el fin de facilitar el funcionamiento del grupo.' },
  { num: 2, dimension: 'relaciones', texto: 'Anima con entusiasmo a todos los miembros del grupo para que participen, está abierto a sus ideas y les hace saber que aprecia sus contribuciones al grupo.' },
  { num: 3, dimension: 'tarea', texto: 'Solicita hechos, información, opiniones, ideas y sentimientos a los demás miembros con el fin de ayudar a la discusión del grupo.' },
  { num: 4, dimension: 'tarea', texto: 'Ayuda a que los miembros se comuniquen entre sí por medio de buenas habilidades de comunicación y se asegura de que cada uno entienda lo que dicen los demás.' },
  { num: 5, dimension: 'tarea', texto: 'Dirige al grupo planificando cómo abordar el trabajo, llamando la atención sobre las tareas que hay que realizar y asignando responsabilidades a diferentes miembros del grupo.' },
  { num: 6, dimension: 'relaciones', texto: 'Bromea y sugiere formas interesantes de realizar el trabajo con el fin de reducir la tensión en el grupo y hacer más divertido trabajar juntos.' },
  { num: 7, dimension: 'relaciones', texto: 'Reconoce los logros alcanzados por los miembros del grupo y les felicita por su buen desempeño. Así los anima a seguir trabajando bien.' },
  { num: 8, dimension: 'relaciones', texto: 'Se preocupa por conocer los problemas o dificultades que tienen los miembros del grupo y les apoya para encontrar soluciones cuando es necesario.' },
  { num: 9, dimension: 'tarea', texto: 'Fomenta que todos los miembros del grupo participen dando sus ideas y opiniones antes de tomar decisiones importantes.' },
  { num: 10, dimension: 'relaciones', texto: 'Establece comunicación clara, abierta y respetuosa con los miembros del grupo, escuchándolos y compartiendo la información necesaria.' },
  { num: 11, dimension: 'tarea', texto: 'Delega tareas de acuerdo con las habilidades y capacidades de cada integrante, dándoles la confianza y el apoyo necesario para que las realicen bien.' },
  { num: 12, dimension: 'relaciones', texto: 'Motiva al grupo a mantener una actitud positiva y comprometida, incluso en situaciones difíciles o cuando los resultados no son los esperados.' },
];

/** `{ [numPregunta]: valor 1-5 }` — la misma forma que guardaba Mega Talento en `portal_data.cuestionarioLiderazgo`. */
export type HrRespuestasLiderazgo = Record<number, number>;

export type HrEstiloLiderazgo = 'equipo' | 'autocratico' | 'club-campestre' | 'punto-medio' | 'empobrecido' | 'sin-evaluar';

export const HR_ESTILOS_LIDERAZGO: Record<HrEstiloLiderazgo, { nombre: string; resumen: string }> = {
  equipo: { nombre: 'Liderazgo de Equipo', resumen: 'Alto interés tanto por la tarea como por las personas. Logra resultados a través del compromiso y el trabajo en equipo.' },
  autocratico: { nombre: 'Autoridad-Obediencia', resumen: 'Centrado en la tarea, poco interés por las relaciones. Logra eficiencia pero puede generar baja motivación.' },
  'club-campestre': { nombre: 'Club Campestre', resumen: 'Centrado en las personas, descuida la tarea. Buen ambiente pero los resultados pueden quedar pendientes.' },
  'punto-medio': { nombre: 'Estilo de Punto Medio', resumen: 'Equilibrio aceptable entre tarea y personas. Resultados medios sin destacar en ninguna dimensión.' },
  empobrecido: { nombre: 'Liderazgo Empobrecido', resumen: 'Bajo interés por tarea y personas. Esfuerzo mínimo. Estilo poco efectivo.' },
  'sin-evaluar': { nombre: 'Sin evaluar', resumen: 'Aún no se ha completado el cuestionario.' },
};

export type HrNivelLiderazgo = 'destacado' | 'solido' | 'en-desarrollo' | 'requiere-desarrollo' | 'sin-evaluar';

export interface HrResultadoLiderazgo {
  contestadas: number;
  total: number;
  puntaje: number;
  puntajeMax: number;
  porcentaje: number;
  puntajeTarea: number;
  puntajeRelaciones: number;
  estilo: HrEstiloLiderazgo;
  nivel: HrNivelLiderazgo;
  interpretacion: string;
}

/** Umbral con el que un candidato «califica»: 66% o más (nivel sólido o destacado). El de Mega Talento. */
export const HR_UMBRAL_LIDERAZGO = 66;

/** Ejes del Grid de 6 a 30: bajo 6-12, medio 13-21, alto 22-30. */
export function hrClasificarEstilo(tarea: number, relaciones: number): HrEstiloLiderazgo {
  const n = (p: number) => (p <= 12 ? 'bajo' : p <= 21 ? 'medio' : 'alto');
  const t = n(tarea), r = n(relaciones);
  if (t === 'alto' && r === 'alto') return 'equipo';
  if (t === 'alto' && r === 'bajo') return 'autocratico';
  if (t === 'bajo' && r === 'alto') return 'club-campestre';
  if (t === 'bajo' && r === 'bajo') return 'empobrecido';
  return 'punto-medio';
}

export function hrResultadoLiderazgo(respuestas: HrRespuestasLiderazgo | null | undefined): HrResultadoLiderazgo {
  const r = respuestas ?? {};
  let suma = 0, tarea = 0, rel = 0, contestadas = 0;
  for (const p of HR_CUESTIONARIO_LIDERAZGO) {
    const v = Number(r[p.num]);
    if (Number.isInteger(v) && v >= 1 && v <= 5) {
      suma += v; contestadas++;
      if (p.dimension === 'tarea') tarea += v; else rel += v;
    }
  }
  const total = HR_CUESTIONARIO_LIDERAZGO.length;
  const puntajeMax = total * 5;
  const porcentaje = contestadas > 0 ? Math.round((suma / puntajeMax) * 100) : 0;
  let nivel: HrNivelLiderazgo = 'sin-evaluar';
  let interpretacion = 'Aún no se ha completado el cuestionario.';
  let estilo: HrEstiloLiderazgo = 'sin-evaluar';
  if (contestadas === total) {
    estilo = hrClasificarEstilo(tarea, rel);
    if (porcentaje >= 83) { nivel = 'destacado'; interpretacion = 'Liderazgo destacado · perfil sólido en ambas dimensiones.'; }
    else if (porcentaje >= 66) { nivel = 'solido'; interpretacion = 'Liderazgo sólido · cumple con la mayoría de las conductas esperadas.'; }
    else if (porcentaje >= 50) { nivel = 'en-desarrollo'; interpretacion = 'Liderazgo en desarrollo · requiere fortalecimiento.'; }
    else { nivel = 'requiere-desarrollo'; interpretacion = 'Requiere desarrollo · áreas de oportunidad importantes.'; }
  } else if (contestadas > 0) {
    interpretacion = `Faltan ${total - contestadas} pregunta(s) por contestar.`;
  }
  return { contestadas, total, puntaje: suma, puntajeMax, porcentaje, puntajeTarea: tarea, puntajeRelaciones: rel, estilo, nivel, interpretacion };
}

/** ¿Completó el cuestionario Y calificó (>= 66%)? */
export function hrCalificaLiderazgo(r: HrResultadoLiderazgo | null | undefined): boolean {
  return !!r && r.total > 0 && r.contestadas === r.total && r.porcentaje >= HR_UMBRAL_LIDERAZGO;
}
