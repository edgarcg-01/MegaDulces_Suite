/**
 * `[NP.7.L.11d]` La configuración del lector de fotos, leída del entorno en UN lugar.
 *
 * Plan: `FASE_NP7_ALTA_DESDE_FOTOS.md` §9 (riesgo «costo de IA del levantamiento sin tope») y el item
 * NP.7.L.11d: interruptor, concurrencia y tope diario. Pura: se prueba sin Nest y sin base.
 *
 * ⛔ **Apagada por defecto.** Sólo `NP7_AI_ENABLED === 'true'` la enciende: D6 (¿se manda la foto a un
 * proveedor externo?) no está firmada, y cualquier otro valor («1», «TRUE», «si») se lee como apagada.
 *
 * ⛔ **Un valor mal escrito no se convierte en uno más caro.** Si `NP7_AI_DAILY_CAP` o
 * `NP7_AI_CONCURRENCY` traen algo que no es un número, se usa el valor SEGURO (tope 0, concurrencia 1),
 * no el de defecto, y queda en `advertencias` para que el worker lo diga en el log.
 */

export type ModoRecorte = 'silueta' | 'ninguno';

export interface ConfigLector {
  /** Sólo `NP7_AI_ENABLED === 'true'`. */
  habilitada: boolean;
  /** Llamadas al lector a la vez (1..8). La llave de Anthropic la comparten ~10 servicios (§9). */
  concurrencia: number;
  /** Llamadas reales por día (hora de México). 0 = ninguna. */
  topeDiario: number;
  modelo: string;
  /** `output_config.effort`. `null` = no se manda (Haiku 4.5 responde 400 si se manda). */
  effort: string | null;
  maxTokens: number;
  /** `silueta` = se manda la foto recortada al producto (D6, opción A de §10b.3 punto 7). */
  recorte: ModoRecorte;
  /** Valores del entorno que no se pudieron leer y con qué se reemplazaron. */
  advertencias: string[];
}

export const CONCURRENCIA_DEFECTO = 2;
export const CONCURRENCIA_MAX = 8;
/** 200 fotos al día ≈ 40 fichas de 5 caras: el piloto de Padre Hidalgo sin abrir la llave (§9). */
export const TOPE_DIARIO_DEFECTO = 200;
/**
 * ⚠️ Provisional: la decisión **D2** fija el modelo con los dos corpus (NP.7.1.2 y NP.7.L.11b), por
 * acierto de campos y de nivel físico al menor costo por ficha. Hasta entonces, el más capaz.
 */
export const MODELO_DEFECTO = 'claude-opus-5-5';
export const EFFORT_DEFECTO = 'low';
export const EFFORTS_VALIDOS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Una lectura completa (texto literal + 20 campos con evidencia) cabe holgada en 8,000 tokens. */
export const MAX_TOKENS_DEFECTO = 8000;
export const RECORTE_DEFECTO: ModoRecorte = 'silueta';

type Entorno = Record<string, string | undefined>;

/** `undefined` = no viene (usar el defecto); `NaN` = viene y no es un entero (usar el valor seguro). */
function entero(v: string | undefined): number | undefined {
  const t = String(v ?? '').trim();
  if (!t) return undefined;
  return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
}

export function leerConfigLector(env: Entorno = process.env): ConfigLector {
  const advertencias: string[] = [];

  const c = entero(env['NP7_AI_CONCURRENCY']);
  let concurrencia = c === undefined ? CONCURRENCIA_DEFECTO : c;
  if (Number.isNaN(concurrencia)) {
    advertencias.push(`NP7_AI_CONCURRENCY="${env['NP7_AI_CONCURRENCY']}" no es un entero: se usa 1`);
    concurrencia = 1;
  }
  concurrencia = Math.min(CONCURRENCIA_MAX, Math.max(1, concurrencia));

  const t = entero(env['NP7_AI_DAILY_CAP']);
  let topeDiario = t === undefined ? TOPE_DIARIO_DEFECTO : t;
  if (Number.isNaN(topeDiario) || topeDiario < 0) {
    advertencias.push(`NP7_AI_DAILY_CAP="${env['NP7_AI_DAILY_CAP']}" no es un entero >= 0: se usa 0 (ninguna lectura)`);
    topeDiario = 0;
  }

  const modelo = String(env['NP7_AI_MODEL'] ?? '').trim() || MODELO_DEFECTO;

  const e = String(env['NP7_AI_EFFORT'] ?? '').trim().toLowerCase();
  let effort: string | null = EFFORT_DEFECTO;
  if (e === 'none' || e === 'ninguno') effort = null;
  else if ((EFFORTS_VALIDOS as readonly string[]).includes(e)) effort = e;
  else if (e) {
    // Un effort desconocido daría 400 en CADA llamada, y un 400 detiene el lote en cada corrida (no se
    // guarda: `ErrorDeConfiguracionLector`): nada se leería. Mejor el defecto, dicho en el log.
    advertencias.push(`NP7_AI_EFFORT="${env['NP7_AI_EFFORT']}" no es ${EFFORTS_VALIDOS.join('|')}|none: se usa ${EFFORT_DEFECTO}`);
  }

  const r = String(env['NP7_AI_RECORTE'] ?? '').trim().toLowerCase();
  let recorte: ModoRecorte = RECORTE_DEFECTO;
  if (r === 'ninguno') recorte = 'ninguno';
  else if (r && r !== 'silueta') advertencias.push(`NP7_AI_RECORTE="${env['NP7_AI_RECORTE']}" no es silueta|ninguno: se usa silueta`);

  return {
    habilitada: env['NP7_AI_ENABLED'] === 'true',
    concurrencia,
    topeDiario,
    modelo,
    effort,
    maxTokens: MAX_TOKENS_DEFECTO,
    recorte,
    advertencias,
  };
}
