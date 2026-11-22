/**
 * `[ALC.4.3]` La configuración de la lectura con IA del alta, leída del entorno en UN lugar (pura).
 *
 * ⛔ **Apagada por defecto.** Sólo `ALC_AI_ENABLED === 'true'` la enciende: mandar la constancia o la
 * foto de un cliente (RFC, CURP, domicilio) a un proveedor externo es la decisión **D9** del plan
 * (datos personales, LFPDPPP), y no está firmada. Cualquier otro valor se lee como apagada.
 * ⛔ **Un valor mal escrito no se convierte en uno más caro**: un tope que no es entero se lee como 0
 * (ninguna lectura) y queda en `advertencias`, como en NP.7 (`lector.config.ts`).
 */

export interface ConfigLecturaAlta {
  habilitada: boolean;
  modelo: string;
  /** `output_config.effort`; `null` = no se manda (Haiku 4.5 responde 400 si se manda). */
  effort: string | null;
  maxTokens: number;
  /** Lecturas con IA por día (hora de México), en todo el tenant. 0 = ninguna. */
  topeDiario: number;
  advertencias: string[];
}

/** El más capaz: un RFC mal leído cuesta más que la llamada (Opus 5.5: $4 / $20 por millón de tokens). */
export const MODELO_DEFECTO = 'claude-opus-5-5';
export const EFFORT_DEFECTO = 'medium';
export const EFFORTS_VALIDOS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Una lectura completa (≈30 campos de texto + regímenes + avisos) cabe holgada en 4,000 tokens. */
export const MAX_TOKENS_DEFECTO = 4000;
/** Unas cuantas altas al día en las 9 sucursales; 60 lecturas dejan margen sin abrir la llave. */
export const TOPE_DIARIO_DEFECTO = 60;
/** Archivos por lectura: las dos o tres hojas de la constancia y una captura. */
export const MAX_ARCHIVOS = 4;

export function leerConfigLecturaAlta(env: Record<string, string | undefined> = process.env): ConfigLecturaAlta {
  const advertencias: string[] = [];
  const t = String(env['ALC_AI_DAILY_CAP'] ?? '').trim();
  let topeDiario = TOPE_DIARIO_DEFECTO;
  if (t) {
    if (/^\d+$/.test(t)) topeDiario = Number(t);
    else {
      advertencias.push(`ALC_AI_DAILY_CAP="${t}" no es un entero >= 0: se usa 0 (ninguna lectura)`);
      topeDiario = 0;
    }
  }
  const modelo = String(env['ALC_AI_MODEL'] ?? '').trim() || MODELO_DEFECTO;
  const e = String(env['ALC_AI_EFFORT'] ?? '').trim().toLowerCase();
  let effort: string | null = EFFORT_DEFECTO;
  if (e === 'none' || e === 'ninguno') effort = null;
  else if ((EFFORTS_VALIDOS as readonly string[]).includes(e)) effort = e;
  else if (e) advertencias.push(`ALC_AI_EFFORT="${e}" no es ${EFFORTS_VALIDOS.join('|')}|none: se usa ${EFFORT_DEFECTO}`);
  if (modelo.startsWith('claude-haiku-4-5')) effort = null;
  return {
    habilitada: String(env['ALC_AI_ENABLED'] ?? '').trim() === 'true',
    modelo, effort, maxTokens: MAX_TOKENS_DEFECTO, topeDiario, advertencias,
  };
}
