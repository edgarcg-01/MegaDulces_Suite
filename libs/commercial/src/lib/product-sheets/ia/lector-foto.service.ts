import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService, type AnthropicMessagesParams, type ErrorHttpAnthropic } from '@megadulces/platform-core';
import type { ResultadoLectura } from './lectura-foto.contract';
import { costoDeLlamada } from './lector-costos';
import { normalizarLectura } from './lector-foto.normalizar';
import { ESQUEMA_LECTURA_FOTO, SYSTEM_LECTOR_FOTO } from './lector-foto.schema';

/**
 * `[NP.7.L.11d]` El lector: UNA llamada por foto → `LecturaFotoV1` (extracción + nivel físico + `rostro_visible`,
 * que bloquea, y `persona_visible`, informativo desde el 2026-11-05).
 *
 * ⛔ Lo que este servicio NO hace, a propósito:
 *  - **No recibe ni manda la descripción de Kepler ni el SKU** (testigo independiente, ADR-059): la entrada sólo
 *    trae la imagen y el nombre de la cara. Si el modelo viera lo que dice Kepler, «leería» eso y la auditoría
 *    compararía a Kepler consigo mismo.
 *  - **No decide si se llama**: el interruptor `NP7_AI_ENABLED`, la concurrencia, el tope diario, la idempotencia
 *    por `sha256` y los reintentos viven en el worker. Aquí, un 429/529/5xx o un error de red se RE-LANZA tal
 *    cual (con `status` y `retryAfterMs` de `AnthropicService`) para que el worker espere y reintente.
 *  - **No convierte un error de configuración en una lectura.** Lo que el worker GUARDA queda para siempre en
 *    `ai_raw.lecturas[sha256]` (la foto ya no se vuelve a pedir). Por eso sólo vuelve como estado `error` lo que es
 *    de ESTA foto (413: la imagen es lo único grande de la petición). La falta de llave y cualquier otro 4xx —400
 *    esquema o parámetro rechazado, 401/403 llave, 404 modelo— fallarían igual con TODAS las fotos: se LANZA
 *    `ErrorDeConfiguracionLector` y el worker detiene el lote sin guardar nada (revisión independiente del
 *    2026-11-04: con el estado `error`, un 401 marcaba todo el atraso como leído y arreglar la llave no lo recuperaba).
 *  - **No usa `tool_choice`**: los modelos 5.5 lo rechazan forzado (400). El JSON lo garantiza structured
 *    outputs (`output_config.format`). Tampoco manda `thinking`: cada modelo usa su default.
 *  - **Nunca registra la imagen** (ni en logs ni en el texto de error).
 */

export interface EntradaLectorFoto {
  /** La foto en base64, ya recortada y reducida por quien llama (§10b.3 punto 7, opción A). */
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Nombre de la cara («frente», «reverso», «lateral_izq»…). Es lo ÚNICO de texto que viaja con la foto. */
  cara: string;
}

export interface ConfigLectorFoto {
  modelo: string;
  /** `output_config.effort`; `null` = el default del modelo. Haiku 4.5 no lo admite (400) y se omite. */
  effort: string | null;
  maxTokens: number;
}

/**
 * Tiempo de espera de UNA llamada. El default del transporte (30 s) no alcanza: imagen + razonamiento + un JSON
 * de ~60 campos, y la primera llamada con un esquema nuevo además lo compila (la API documenta hasta 180 s).
 * Un timeout sale sin `status` y el worker lo reintenta. Exportado: el worker dimensiona su tiempo de corrida
 * con él (`DURACION_MAX_MS`).
 */
export const TIMEOUT_MS = 180_000;

/** Lo que se reintenta: límite de tasa, sobrecarga, error del servidor o sin respuesta (red/timeout). */
export function esReintentable(status: number | null): boolean {
  return status === null || status === 429 || status === 529 || status >= 500;
}

/**
 * ¿El rechazo es de ESTA foto (los mismos bytes fallan igual mañana) y no de la petición? Sólo el 413: la imagen
 * es lo único grande que viaja (el system y el esquema son fijos).
 *
 * ⛔ Un 400 NO cuenta como «de la foto», aunque su mensaje hable de la imagen: la foto ya llega re-codificada por
 * sharp (`preparar-foto.ts`), y no se adivina por el texto del mensaje (regla 10). El costo es asimétrico: un 400 de
 * esquema tratado como «de la foto» marcaría TODAS las fotos; un 400 de una foto tratado como configuración detiene
 * el lote en esa foto en cada corrida, a la vista (estado `detenida` con el mensaje de la API), sin guardar nada.
 */
export function esFallaDeLaFoto(status: number | null): boolean {
  return status === 413;
}

/**
 * Lo que ningún reintento arregla y no es culpa de una foto: falta la llave, la API rechazó la petición (400), la
 * llave (401/403) o el modelo (404). El worker lo trata como «detener el lote sin guardar».
 */
export class ErrorDeConfiguracionLector extends Error {
  readonly configuracion = true as const;
  /** El `status` de la API; `null` = la llamada no salió (sin llave). */
  readonly status: number | null;
  constructor(mensaje: string, status: number | null) {
    super(mensaje);
    this.name = 'ErrorDeConfiguracionLector';
    this.status = status;
  }
}

export function esErrorDeConfiguracion(e: unknown): e is ErrorDeConfiguracionLector {
  return (e as { configuracion?: unknown } | null)?.configuracion === true;
}

function statusDe(e: unknown): number | null {
  const s = (e as Partial<ErrorHttpAnthropic> | null)?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * Lo único que el lector lee de la respuesta de la API (`AnthropicService.messages` la devuelve sin tipo). Todo
 * llega como `unknown` y se comprueba al leerlo: lo que no tenga la forma esperada se trata como ausente.
 */
interface RespuestaMensajes {
  model?: unknown;
  usage?: unknown;
  stop_reason?: unknown;
  stop_details?: { category?: unknown } | null;
  content?: unknown;
}

function esBloqueDeTexto(b: unknown): b is { type: 'text'; text: string } {
  const o = b as { type?: unknown; text?: unknown } | null;
  return o?.type === 'text' && typeof o.text === 'string';
}

/** Defensa: si un mensaje de error llegara a citar la imagen, la tira larga de base64 no se guarda ni se registra. */
function sinBase64(texto: string): string {
  return texto.replace(/[A-Za-z0-9+/=]{100,}/g, '[base64 omitido]');
}

/**
 * El texto del mensaje del usuario: SOLO la cara. Los nombres de cara son una palabra («frente», «lateral_izq»),
 * así que se toma la primera palabra (letras, números, `_`, `-`; 24 caracteres): si alguien pasara algo más
 * —una descripción, un SKU— no viaja (testigo independiente, ADR-059).
 */
export function textoDeCara(cara: string): string {
  const palabra = (String(cara ?? '').match(/[\p{L}\p{N}_-]+/u)?.[0] ?? '').slice(0, 24);
  return `Cara de la foto: ${palabra || 'sin indicar'}.`;
}

@Injectable()
export class LectorFotoService {
  private readonly logger = new Logger(LectorFotoService.name);

  constructor(private readonly anthropic: AnthropicService) {}

  /** ¿Hay llave? El worker lo pregunta ANTES de la corrida (como con sharp) para no tocar la base sin ella. */
  get tieneLlave(): boolean {
    return this.anthropic.hasApiKey;
  }

  async leerFoto(entrada: EntradaLectorFoto, cfg: ConfigLectorFoto): Promise<ResultadoLectura> {
    // Sin llave no sale la llamada: es configuración, no algo que un reintento arregle ni algo de esta foto.
    if (!this.anthropic.hasApiKey) {
      throw new ErrorDeConfiguracionLector('sin ANTHROPIC_API_KEY: la llamada no salió', null);
    }

    const params: AnthropicMessagesParams = {
      model: cfg.modelo,
      maxTokens: cfg.maxTokens,
      system: SYSTEM_LECTOR_FOTO,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: entrada.mediaType, data: entrada.base64 } },
            { type: 'text', text: textoDeCara(entrada.cara) },
          ],
        },
      ],
      outputFormat: { type: 'json_schema', schema: ESQUEMA_LECTURA_FOTO },
    };
    if (cfg.effort && !cfg.modelo.startsWith('claude-haiku-4-5')) params.effort = cfg.effort;

    let resp: RespuestaMensajes | null = null;
    try {
      resp = await this.anthropic.messages(params, { cachePrefix: true, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      const status = statusDe(e);
      if (esReintentable(status)) throw e;
      const mensaje = sinBase64(e instanceof Error ? e.message : String(e));
      // Configuración o petición: falla igual con cualquier foto. No se devuelve como lectura (se guardaría).
      if (!esFallaDeLaFoto(status)) throw new ErrorDeConfiguracionLector(mensaje, status);
      this.logger.warn(`[NP.7.L.11d] lectura rechazada por la API (HTTP ${status}, cara ${textoDeCara(entrada.cara)}): ${mensaje}`);
      return { estado: 'error', lectura: null, uso: null, error: mensaje };
    }

    const modelo = resp?.model;
    const modeloQueRespondio = typeof modelo === 'string' && modelo ? modelo : cfg.modelo;
    const uso = costoDeLlamada(modeloQueRespondio, resp?.usage);

    if (resp?.stop_reason === 'refusal') {
      const cat = resp?.stop_details?.category;
      const categoria = typeof cat === 'string' && cat ? cat : null;
      return { estado: 'rechazada_por_modelo', lectura: null, uso, error: `el modelo rechazó la lectura (categoría: ${categoria ?? 'sin categoría'})` };
    }
    if (resp?.stop_reason === 'max_tokens') {
      return { estado: 'incompleta', lectura: null, uso, error: `la respuesta se cortó en max_tokens (${cfg.maxTokens})` };
    }

    const contenido = resp?.content;
    const texto = (Array.isArray(contenido) ? (contenido as unknown[]) : [])
      .filter(esBloqueDeTexto)
      .map((b) => b.text)
      .join('');
    let crudo: unknown;
    try {
      crudo = JSON.parse(texto);
    } catch {
      return { estado: 'invalida', lectura: null, uso, error: `la respuesta no es JSON (${texto.length} caracteres)` };
    }
    const norm = normalizarLectura(crudo);
    if (!norm.ok) return { estado: 'invalida', lectura: null, uso, error: norm.error };
    return { estado: 'ok', lectura: norm.lectura, uso, error: null };
  }
}
