import type { DefinicionVista } from '@megadulces/contracts';

/**
 * `[DP.3.2]` Los temas de la nómina RD que dependen de una pregunta de negocio (`rd.<tema>.*`) y la
 * vista de `/comercial/comisiones` donde pesan. Un tema que no está acá no se pinta: una pregunta
 * nueva se nota como hueco en esta tabla, no como una línea con su clave cruda.
 */
export const TEMAS_DEFINICION: Readonly<Record<string, { etiqueta: string; vista: string }>> = {
  universo: { etiqueta: 'A quién sigue la comisión (chofer o tipo de ruta)', vista: 'padron' },
  vecinal: { etiqueta: 'Rutas vecinales', vista: 'padron' },
  tlmk: { etiqueta: 'Rutas TLMK', vista: 'padron' },
  ausencia: { etiqueta: 'Vacaciones, incapacidad y percances', vista: 'quincena' },
  faltante: { etiqueta: 'Cobro de faltante de mercancía', vista: 'quincena' },
  bono_asistencia: { etiqueta: 'Bono de asistencia y puntualidad', vista: 'bonos' },
};

/** Un tema de la nómina con lo que le falta para poder calcularse. */
export interface TemaDefinicion {
  readonly tema: string;
  readonly etiqueta: string;
  /** Preguntas vivas (sin las descartadas). */
  readonly total: number;
  readonly sinDefinir: number;
  /** Quién contesta lo que falta. */
  readonly duenos: readonly string[];
  /** Cuántas de las que faltan no tienen dueño: nadie las va a contestar (D4). */
  readonly sinDueno: number;
  /** Alguna de las que faltan es de quien mira. */
  readonly mias: boolean;
}

/** Los temas de una vista con lo que les falta. `yo` = id de quien mira (o `null`). */
export function temasDeVista(
  definiciones: readonly DefinicionVista[], vista: string, yo: string | null,
): TemaDefinicion[] {
  const vivas = definiciones.filter((d) => d.status !== 'descartada');
  const temas: TemaDefinicion[] = [];
  for (const [tema, meta] of Object.entries(TEMAS_DEFINICION)) {
    if (meta.vista !== vista) continue;
    const suyas = vivas.filter((d) => d.key.startsWith(`rd.${tema}.`));
    if (!suyas.length) continue;
    const faltan = suyas.filter((d) => d.status === 'pendiente');
    temas.push({
      tema, etiqueta: meta.etiqueta, total: suyas.length, sinDefinir: faltan.length,
      duenos: [...new Set(faltan.map((d) => d.asignado_nombre).filter((n): n is string => !!n))],
      sinDueno: faltan.filter((d) => !d.assigned_to).length,
      mias: !!yo && faltan.some((d) => d.assigned_to === yo),
    });
  }
  return temas;
}

/**
 * La línea de un tema. ⛔ Una respuesta guardada NO significa que el motor la use: ninguna de estas
 * reglas la lee todavía el cálculo (`[RD.103]`–`[RD.106]`), y decir «definido» lo afirmaría.
 */
export function textoTema(t: TemaDefinicion): string {
  if (!t.sinDefinir) {
    return t.total > 1 ? 'contestadas; el cálculo todavía no las usa' : 'contestada; el cálculo todavía no la usa';
  }
  const cuantas = t.total > 1 ? `${t.sinDefinir} de ${t.total} sin definir` : 'sin definir';
  const quien = [
    t.duenos.length ? `lo define ${t.duenos.join(', ')}` : '',
    t.sinDueno ? (t.duenos.length ? `${t.sinDueno} sin dueño` : 'sin dueño') : '',
  ].filter(Boolean).join(' · ');
  return `${cuantas} · ${quien}`;
}
