/**
 * `[NP.7.L.11d]` **El worker que lee las fotos del levantamiento, con topes.**
 *
 * Plan: `FASE_NP7_ALTA_DESDE_FOTOS.md`, item NP.7.L.11d y §9 («costo de IA del levantamiento sin tope»):
 * ~6,500 SKUs × 5 caras, y la llave de Anthropic la comparten ~10 servicios en prod — un 429 los frena
 * a todos. Por eso: interruptor, concurrencia, tope diario, una llamada por foto, idempotencia por
 * `sha256` y, ante un 429 que no cede, se DETIENE el lote (no se insiste).
 *
 * Qué hace cada 5 minutos (`procesar`):
 *   1. Apagada (`NP7_AI_ENABLED` ≠ 'true', D6 sin firmar), sin sharp o sin `ANTHROPIC_API_KEY` → no consulta
 *      la base ni llama a nadie.
 *   2. Una sola corrida: bandera en memoria + `pg_try_advisory_xact_lock` (`tomarCandadoDeCron`), así
 *      dos pods no leen la misma foto dos veces.
 *   3. Tope diario: cuenta las llamadas REALES de hoy (hora de México) en `ai_raw.lecturas` (las que
 *      traen `uso`; una lectura copiada no se cobró y no cuenta).
 *   4. Fotos del peldaño principal cuyo `sha256` no tiene lectura en SU ficha. Si la MISMA foto ya se
 *      leyó en otra ficha, se copia (`uso: null`); si viene dos veces en el lote, una sola llamada.
 *   5. Por foto: bajar del bucket → recortar a la silueta y reducir (`preparar-foto.ts`, D6 opción A) →
 *      leer → UPDATE atómico de **sólo `ai_raw`**. Un error de configuración (400/401/403/404, sin llave)
 *      detiene el lote SIN guardar: se guardaría como lectura permanente de cada foto.
 *   6. Ficha con todas sus fotos reales leídas `ok` → propuesta (`fusionarLecturas`) y auditoría contra
 *      la ficha de Kepler de la sucursal (`auditarContraKepler`), también dentro de `ai_raw`.
 *
 * ⛔ **Nunca toca `sheet`, `status` ni `photos`**: en el piloto no hay publicación automática (§10b.3
 * punto 4); lo que la IA dice espera en `ai_raw` a que Catálogo lo acepte. Ni `updated_at`: la ficha no
 * cambió para quien la revisa; el momento de la lectura vive en `ai_raw.actualizado_en`.
 *
 * ── ⛔ DEUDA CON NOMBRE: lo que falta ANTES de encender `NP7_AI_ENABLED` en prod ──────────────────
 *  (a) **Borrado de la foto con ROSTRO (`rostro_visible`)** (D6, opción A de §10b.3 punto 7; criterio de
 *      Francisco del 2026-11-05, por confirmar por Edgar y legal en D6: las partes de una persona —mano,
 *      pierna, zapato, ropa— no son problema; los rostros y rasgos faciales sí): «si es `true`, la foto se borra
 *      ese mismo día, no se publica ni se usa para estudio, y se pide otra». El borrado va **sólo bajo el prefijo
 *      `levantamiento/`** (el bucket lo comparte con los comprobantes, NP.7.0.9) y con latido (NP.7.F.3). Aquí
 *      sólo queda la marca en la lectura (y el hallazgo `rostro_visible` en la auditoría cuando la ficha
 *      completa) y un aviso en el log. El borrado tiene que mirar `ai_raw.lecturas[*].lectura.rostro_visible`,
 *      no sólo la auditoría: una ficha con otra cara sin leer no llega a auditoría. ⚠️ Con la opción A, la foto
 *      con rostro YA viajó a Anthropic antes de detectarse: se declara, no se esconde.
 *      `persona_visible` (sin rostro) es INFORMATIVO: ni se borra, ni bloquea, ni se avisa en el log.
 *      ⛔ Dos cosas que el borrado y la publicación NO pueden leer como «sin rostro» (revisión del 2026-11-05):
 *        · una lectura que no quedó `ok` (`lectura: null`: inválida —p. ej. sin `rostro_visible`—, incompleta,
 *          rechazada o con error al preparar) NO trae el booleano: su rostro es **NO MEDIDO**. No se salta: va a
 *          revisión manual («tiene rostro»). Hoy sólo queda el aviso «ROSTRO NO MEDIDO» y `rostros_no_medidos`;
 *        · `rostro_visible: false` dice «sin rostro EN EL RECORTE que viajó» (`preparacion.recorte`; en 3:4, el 54.2 %
 *          del área), no «la foto guardada no tiene rostro»: la foto se guarda ENTERA y sus márgenes nadie los mira.
 *          NP.7.F.3 tiene que elegir: (i) que lo que se publica o va a estudio salga sólo del recorte, o (ii) que la
 *          marca manual «tiene rostro» sea el control de los márgenes.
 *  (b) **Latido** (`latirCron` de platform-core) + su fila en `CRON_JOBS`
 *      (`apps/api/src/modules/db-health/db-health.service.ts`, apartado por otra sesión el 2026-11-04).
 *      Sin los dos, un worker parado se ve verde (cron-heartbeat.ts, regla 3).
 *  (c) El pool de concurrencia (`enParalelo`) vive aquí: si aparece un segundo consumidor, sube a
 *      `libs/platform-core` (ADR-056, regla 16).
 *  (d) Cobertura tiene que decir «sin analizar: tope diario alcanzado» (NP.7.L.11d); aquí sólo el log.
 *  (e) Costo por ficha de las primeras 100 fichas (DoD L4): el dato queda por llamada en `uso`; el
 *      reporte para Edgar no está construido.
 *  (f) **No hay salida automática para volver a leer una lectura que no quedó `ok`** (`invalida`, `incompleta`,
 *      `rechazada_por_modelo`, o el `error` de una foto que no se pudo preparar o dio 413): se guardó para no
 *      pagarla otra vez. Para repetirla, a mano y fuera de horario, quitar su llave en TODAS las fichas del tenant
 *      (si queda en una, `LECTURAS_EXISTENTES_SQL` la vuelve a copiar):
 *        UPDATE catalog.product_sheets SET ai_raw = ai_raw #- ARRAY['lecturas', '<sha256>']
 *         WHERE tenant_id = '<tenant>' AND (ai_raw #> ARRAY['lecturas', '<sha256>']) IS NOT NULL;
 *      Un error de CONFIGURACIÓN (sin llave, 400/401/403/404) ya no se guarda: detiene el lote y no hay nada que borrar.
 *  (g) El tope diario cuenta llamadas COBRADAS (con `uso`). Un 4xx o un 429 no se cobran y no cuentan; con la
 *      configuración rota salen a lo más `concurrencia` peticiones por corrida (cada 5 min) hasta que se arregle.
 *  (h) `legible: 'parcial'` no produce hallazgo (sólo `'no'`, como dice el contrato): lo decide Catálogo.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, ObjectStorageService, tomarCandadoDeCron } from '@megadulces/platform-core';
import type { KdiiFila } from '../../shared/kdii-codigo';
import { kdiiPorSku } from '../../shared/kdii-lectura';
import {
  AI_RAW_VERSION,
  type AuditoriaKepler, type LecturaFotoV1, type LecturaGuardada, type PropuestaAmpliada, type ResultadoLectura,
} from './lectura-foto.contract';
import { leerConfigLector, type ConfigLector, type ModoRecorte } from './lector.config';
import { esErrorDeConfiguracion, esReintentable, LectorFotoService, TIMEOUT_MS } from './lector-foto.service';
import { fusionarLecturas } from './fusion-lecturas';
import { auditarContraKepler, hallazgosDeLegibilidad } from './auditoria-kepler';
import { bytesDeDataUri, prepararFoto, sharpDisponible, type FotoPreparada } from './preparar-foto';

/** El piloto es de Mega Dulces (Padre Hidalgo); tenant explícito como los demás crons (RLS forzada). */
export const TENANT_LECTOR = '00000000-0000-0000-0000-00000000d01c';
export const CLAVE_CANDADO_LECTOR = 'np7_lector_fotos';
/** Fotos por corrida, como máximo (además del tope diario). */
export const LOTE_MAX = 50;
export const INTENTOS_MAX = 3;
/** Espera exponencial desde 2 s (2 s, 4 s) si la respuesta no trae `retry-after`. */
export const ESPERA_BASE_MS = 2_000;
/**
 * Un `retry-after` más largo que esto no se espera dentro de la corrida NI se adelanta: el lote se detiene y el
 * cron vuelve en 5 min (la llave la comparten ~10 servicios; insistir antes de lo pedido los frena a todos).
 */
export const ESPERA_MAX_MS = 60_000;
/**
 * Umbral amarillo del sensor de la base para «transacción abierta sin trabajar» (`ENGINE_LIMITS.idle_tx_s.warn`
 * = 300 s en `apps/api/src/modules/db-health/db-health.service.ts`; la lib no puede importar de `apps/`).
 */
export const UMBRAL_IDLE_TX_MS = 300_000;
/** Lo que se deja para guardar y armar propuestas después de la última llamada, con el candado todavía abierto. */
export const HOLGURA_CANDADO_MS = 30_000;
/**
 * Pasado este tiempo no EMPIEZA ninguna llamada (ni foto nueva ni reintento) y no se espera para reintentar. El
 * candado vive en una transacción abierta toda la corrida, y una llamada que empezó justo antes del límite puede
 * durar `TIMEOUT_MS` (180 s). Peor caso: `DURACION_MAX_MS + TIMEOUT_MS + HOLGURA_CANDADO_MS` = 300 s, que no pasa
 * del amarillo. ❌ Antes 4 min con reintentos que no miraban el reloj: ~13 min abiertos en el peor caso
 * (revisión independiente del 2026-11-04). La prueba unitaria se pone roja si alguien sube uno sin el otro.
 */
export const DURACION_MAX_MS = UMBRAL_IDLE_TX_MS - TIMEOUT_MS - HOLGURA_CANDADO_MS;
/** Estados cuyas fotos se leen (el levantamiento ya terminó la captura). */
export const ESTADOS_A_LEER = ['fotos_tomadas', 'publicada'] as const;
const PELDANOS = ['base', 'dos', 'tres'] as const;
type PeldanoPrincipal = (typeof PELDANOS)[number];

const ESTADOS_SQL = ESTADOS_A_LEER.map((e) => `'${e}'`).join(',');
/** `ai_raw.lecturas` como objeto (vacío si `ai_raw` es null o trae otra cosa). */
const LECTURAS_DE = (alias: string) =>
  `CASE WHEN jsonb_typeof(${alias}.ai_raw->'lecturas') = 'object' THEN ${alias}.ai_raw->'lecturas' ELSE '{}'::jsonb END`;
/** Foto real del peldaño principal: con llave en el bucket y con `sha256`. */
const FOTO_REAL = (f: string, s: string) =>
  `${f}->>'peldano' = ${s}.sheet->>'principal' AND coalesce(${f}->>'storage_key', '') <> '' AND coalesce(${f}->>'sha256', '') <> ''`;

// ── SQL (exportado: la prueba unitaria revisa que ninguna escritura toque otra columna que `ai_raw`) ──

/**
 * Llamadas reales de HOY en hora de México: lecturas con `uso` (las copiadas traen `uso: null`). Todas las
 * fichas del tenant, borradas incluidas: lo que se gastó hoy se gastó aunque la ficha ya no esté.
 * Bindings: tenant, ahora (ISO).
 */
export const LLAMADAS_DE_HOY_SQL = `
SELECT count(*)::int AS n
  FROM catalog.product_sheets s
 CROSS JOIN LATERAL jsonb_each(${LECTURAS_DE('s')}) AS l(sha256, lectura)
 WHERE s.tenant_id = ?
   AND jsonb_typeof(l.lectura->'uso') = 'object'
   AND (l.lectura->>'leida_en') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
   AND ((l.lectura->>'leida_en')::timestamptz AT TIME ZONE 'America/Mexico_City')::date
       = (?::timestamptz AT TIME ZONE 'America/Mexico_City')::date`;

/**
 * Fotos del peldaño principal sin lectura en su ficha, en el orden en que se crearon las fichas.
 * `total` cuenta TODAS las pendientes (antes del LIMIT). Bindings: tenant, límite.
 * ⚠️ Sin el operador `?` de jsonb (knex lo toma por binding): `#> … IS NULL`.
 */
export const PENDIENTES_SQL = `
SELECT s.id AS sheet_id, s.sku, s.branch_code, s.sheet->>'principal' AS principal,
       f.foto->>'cara' AS cara, f.foto->>'peldano' AS peldano,
       f.foto->>'storage_key' AS storage_key, f.foto->>'sha256' AS sha256,
       (count(*) OVER ())::int AS total
  FROM catalog.product_sheets s
 CROSS JOIN LATERAL jsonb_array_elements(s.photos) WITH ORDINALITY AS f(foto, orden)
 WHERE s.tenant_id = ? AND s.origin = 'levantamiento' AND s.deleted_at IS NULL
   AND s.status IN (${ESTADOS_SQL})
   AND ${FOTO_REAL('f.foto', 's')}
   AND (s.ai_raw #> ARRAY['lecturas', f.foto->>'sha256']) IS NULL
 ORDER BY s.created_at, s.id, f.orden
 LIMIT ?`;

/**
 * La lectura que ya existe de cada `sha256`, en cualquier ficha del tenant (la idempotencia es por los
 * BYTES de la foto). Se prefiere una `ok` y la original (con `uso`). Bindings: tenant, sha256[].
 */
export const LECTURAS_EXISTENTES_SQL = `
SELECT DISTINCT ON (l.sha256) l.sha256, l.lectura
  FROM catalog.product_sheets s
 CROSS JOIN LATERAL jsonb_each(${LECTURAS_DE('s')}) AS l(sha256, lectura)
 WHERE s.tenant_id = ? AND l.sha256 = ANY(?::text[])
 ORDER BY l.sha256, (l.lectura->>'estado' = 'ok') DESC NULLS LAST,
          (jsonb_typeof(l.lectura->'uso') = 'object') DESC, l.lectura->>'leida_en' DESC`;

/**
 * Guarda UNA lectura en `ai_raw.lecturas.<sha256>` (inicializa `ai_raw` si es null) y deja `propuesta` y
 * `auditoria` en null: con una lectura nueva, la propuesta anterior ya no corresponde a las fotos.
 * Condicional: no pisa una lectura que ya exista (la primera, la que se cobró, se queda).
 * Bindings: versión, sha256, lectura, ahora, id, tenant, sha256.
 */
export const GUARDAR_LECTURA_SQL = `
UPDATE catalog.product_sheets
   SET ai_raw = coalesce(ai_raw, '{}'::jsonb) || jsonb_build_object(
         'version', coalesce(ai_raw->>'version', ?::text),
         'lecturas', jsonb_set(${LECTURAS_DE('product_sheets')}, ARRAY[?::text], ?::jsonb, true),
         'propuesta', NULL::jsonb,
         'auditoria', NULL::jsonb,
         'actualizado_en', ?::text)
 WHERE id = ? AND tenant_id = ?
   AND (ai_raw #> ARRAY['lecturas', ?::text]) IS NULL`;

/**
 * Fichas cuyas fotos reales del peldaño principal tienen TODAS lectura `ok` y todavía no tienen propuesta.
 * Bindings: tenant, límite.
 */
export const FICHAS_LISTAS_SQL = `
SELECT s.id, s.sku, s.branch_code, s.sheet->>'principal' AS principal, s.photos,
       s.ai_raw->'lecturas' AS lecturas, s.ai_raw->>'actualizado_en' AS actualizado_en
  FROM catalog.product_sheets s
 WHERE s.tenant_id = ? AND s.origin = 'levantamiento' AND s.deleted_at IS NULL
   AND s.status IN (${ESTADOS_SQL})
   AND jsonb_typeof(s.ai_raw->'lecturas') = 'object'
   AND coalesce(jsonb_typeof(s.ai_raw->'propuesta'), 'null') = 'null'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.photos) f WHERE ${FOTO_REAL('f', 's')})
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.photos) f
                    WHERE ${FOTO_REAL('f', 's')}
                      AND coalesce(s.ai_raw #>> ARRAY['lecturas', f->>'sha256', 'estado'], '') <> 'ok')
 ORDER BY s.created_at, s.id
 LIMIT ?`;

/**
 * Escribe propuesta y auditoría. Optimista: sólo si nadie guardó otra lectura (`actualizado_en`) ni cambió
 * las fotos desde que se leyó la ficha. Bindings: propuesta, auditoría, ahora, id, tenant, actualizado_en, photos.
 */
export const GUARDAR_PROPUESTA_SQL = `
UPDATE catalog.product_sheets
   SET ai_raw = ai_raw || jsonb_build_object('propuesta', ?::jsonb, 'auditoria', ?::jsonb, 'actualizado_en', ?::text)
 WHERE id = ? AND tenant_id = ? AND ai_raw IS NOT NULL
   AND (ai_raw->>'actualizado_en') IS NOT DISTINCT FROM ?::text
   AND photos = ?::jsonb`;

export const SQL_LECTOR = {
  LLAMADAS_DE_HOY_SQL, PENDIENTES_SQL, LECTURAS_EXISTENTES_SQL, GUARDAR_LECTURA_SQL, FICHAS_LISTAS_SQL, GUARDAR_PROPUESTA_SQL,
} as const;

// ── Tipos ───────────────────────────────────────────────────────────────────────────────────────

/** Una foto del peldaño principal sin lectura en SU ficha. */
export interface FotoPendiente {
  sheet_id: string;
  sku: string;
  branch_code: string;
  principal: string;
  cara: string;
  peldano: string | null;
  storage_key: string;
  sha256: string;
}

/** La forma mínima de una foto de `photos` que el worker necesita. */
export interface FotoDeFicha {
  peldano: string | null;
  cara: string;
  storage_key: string | null;
  sha256: string | null;
}

export interface FichaParaPropuesta {
  id: string;
  sku: string;
  branch_code: string;
  principal: string;
  photos: FotoDeFicha[];
  lecturas: Record<string, LecturaGuardada>;
  actualizado_en: string | null;
}

/** La misma foto (por `sha256`) y las fichas donde falta su lectura. */
export interface GrupoFoto {
  sha256: string;
  storage_key: string;
  pares: Array<{ sheet_id: string; cara: string; peldano: string | null }>;
}

export type DatosKepler = Parameters<typeof auditarContraKepler>[1];

export type EstadoCorrida =
  'apagada' | 'ocupado' | 'sin_preparacion' | 'sin_llave' | 'tope_diario' | 'sin_pendientes' | 'completa' | 'detenida';

export interface ResumenLector {
  estado: EstadoCorrida;
  /** Fotos distintas con lectura `ok` NUEVA (una llamada real cada una). */
  leidas: number;
  /** Foto-en-ficha resuelta COPIANDO una lectura ya pagada (otra ficha, o la misma foto en el lote). */
  reusadas: number;
  /** Fotos distintas que no quedaron con lectura `ok` por un fallo de esta corrida. */
  fallidas: number;
  /** Llamadas reales (con `uso`): lo que cuenta el tope y lo que se cobró. */
  llamadas: number;
  /** Foto-en-ficha sin lectura al terminar. `null` = no se midió (apagada, ocupada, tope). */
  pendientes_restantes: number | null;
  /** Suma de `uso.costo_usd` de las llamadas de esta corrida. `null` si alguna no trae precio. */
  costo_usd: number | null;
  llamadas_sin_precio: number;
  /** Fichas a las que se les escribió propuesta + auditoría. */
  propuestas: number;
  /**
   * Fotos leídas en esta corrida que traen un ROSTRO (deuda (a): se tienen que borrar). Una mano o un zapato
   * (`persona_visible` sin rostro) no cuentan: son informativos (Francisco, 2026-11-05).
   */
  rostros_visibles: number;
  /**
   * Fotos de esta corrida que quedaron guardadas SIN lectura `ok` (inválida, incompleta, rechazada, error al
   * preparar): no traen `rostro_visible`, así que su rostro es NO MEDIDO y van a revisión manual (deuda (a)).
   * Una foto que no se guardó (el bucket no respondió, lote detenido) no cuenta: sigue pendiente y se vuelve a leer.
   */
  rostros_no_medidos: number;
  detalle: string | null;
}

type ResultadoFoto =
  | { tipo: 'guardar'; resultado: ResultadoLectura; preparacion: LecturaGuardada['preparacion'] }
  | { tipo: 'fallo'; motivo: string }
  | { tipo: 'detener'; motivo: string }
  /** El tiempo de corrida se acabó antes de la primera llamada: no se intentó, queda pendiente y no es un fallo. */
  | { tipo: 'pospuesta' };

/** Lo que `leerUna` consulta antes de cada llamada y de cada espera. */
interface Freno {
  /** Otra foto ya detuvo el lote. */
  detenido(): boolean;
  /** Milisegundos que quedan de `DURACION_MAX_MS` (negativo = agotado). */
  quedaMs(): number;
}

// ── Reglas puras ───────────────────────────────────────────────────────────────────────────────

/** Agrupa por `sha256` y quita la misma (ficha, foto) repetida: dos caras con los mismos bytes son UNA llave. */
export function agruparPorFoto(fotos: readonly FotoPendiente[]): GrupoFoto[] {
  const grupos = new Map<string, GrupoFoto>();
  for (const f of fotos) {
    const g = grupos.get(f.sha256) ?? { sha256: f.sha256, storage_key: f.storage_key, pares: [] };
    if (!g.pares.some((p) => p.sheet_id === f.sheet_id)) g.pares.push({ sheet_id: f.sheet_id, cara: f.cara, peldano: f.peldano });
    grupos.set(f.sha256, g);
  }
  return [...grupos.values()];
}

/** Las fotos reales del peldaño principal (con llave y `sha256`). */
export function fotosReales(photos: readonly FotoDeFicha[], principal: string): FotoDeFicha[] {
  return (photos ?? []).filter((f) => f.peldano === principal && !!f.storage_key && !!f.sha256);
}

/**
 * ¿La ficha tiene TODAS sus fotos reales del peldaño principal leídas `ok`? (y al menos una). Es también la
 * regla con la que quien muestre `ai_raw.propuesta` sabe si sigue vigente: si hay una foto nueva sin
 * lectura, la propuesta (si quedó) es de otras fotos.
 */
export function fichaLista(photos: readonly FotoDeFicha[], principal: string, lecturas: Record<string, LecturaGuardada> | null | undefined): boolean {
  const reales = fotosReales(photos, principal);
  return reales.length > 0 && reales.every((f) => lecturas?.[f.sha256!]?.estado === 'ok' && !!lecturas?.[f.sha256!]?.lectura);
}

/**
 * El `status` HTTP de lo que lanzó el lector (`null` = sin respuesta: red o timeout). La regla de qué se
 * reintenta es UNA y vive en el lector (`esReintentable`: 429, 529, 5xx o sin status).
 */
export function statusDeError(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/**
 * `retryAfterMs` si viene; si no, 2 s, 4 s, … `null` = la API pidió esperar MÁS que `ESPERA_MAX_MS`: no se
 * reintenta en esta corrida (❌ antes se recortaba a 60 s y se insistía antes del plazo pedido).
 */
export function esperaDeReintento(e: unknown, intento: number): number | null {
  const ra = Number((e as { retryAfterMs?: unknown } | null)?.retryAfterMs);
  if (Number.isFinite(ra) && ra > 0) return ra > ESPERA_MAX_MS ? null : ra;
  return Math.min(ESPERA_MAX_MS, ESPERA_BASE_MS * 2 ** (intento - 1));
}

/**
 * Corre `fn` sobre `items` con a lo más `limite` a la vez; deja de tomar nuevos cuando `parar()` es true
 * (los que van en vuelo terminan). `fn` no debe lanzar. Deuda (c): subirlo a platform-core si se repite.
 */
export async function enParalelo<T>(items: readonly T[], limite: number, parar: () => boolean, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const carril = async (): Promise<void> => {
    while (i < items.length && !parar()) {
      const x = items[i++];
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, carril));
}

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const describir = (e: unknown): string => {
  // El error de configuración ya trae el mensaje de la API sin base64 (el lector lo limpió): es lo que hay que leer.
  if (esErrorDeConfiguracion(e)) return e.status == null ? e.message : `HTTP ${e.status}: ${mensaje(e)}`;
  const s = (e as { status?: unknown } | null)?.status;
  return s == null ? `sin status: ${mensaje(e)}` : `HTTP ${String(s)}`;
};
const json = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; } }
  return v as Record<string, unknown>;
};

// ── Acceso a datos (separado para que la prueba unitaria lo sustituya y la de integración lo ejerza) ──

export class RepoLectorFotos {
  async llamadasDeHoy(trx: Knex.Transaction, tenant: string, ahora: Date): Promise<number> {
    const { rows } = await trx.raw(LLAMADAS_DE_HOY_SQL, [tenant, ahora.toISOString()]);
    return Number(rows?.[0]?.n ?? 0);
  }

  async pendientes(trx: Knex.Transaction, tenant: string, limite: number): Promise<{ fotos: FotoPendiente[]; total: number }> {
    const { rows } = await trx.raw(PENDIENTES_SQL, [tenant, limite]);
    const filas = (rows ?? []) as Array<Record<string, unknown>>;
    return {
      total: filas.length ? Number(filas[0]['total']) : 0,
      fotos: filas.map((r) => ({
        sheet_id: String(r['sheet_id']), sku: String(r['sku']), branch_code: String(r['branch_code']), principal: String(r['principal']),
        cara: String(r['cara'] ?? ''), peldano: (r['peldano'] as string | null) ?? null,
        storage_key: String(r['storage_key']), sha256: String(r['sha256']),
      })),
    };
  }

  async lecturasExistentes(trx: Knex.Transaction, tenant: string, sha256s: string[]): Promise<Map<string, LecturaGuardada>> {
    if (!sha256s.length) return new Map();
    const { rows } = await trx.raw(LECTURAS_EXISTENTES_SQL, [tenant, sha256s]);
    return new Map(((rows ?? []) as Array<{ sha256: string; lectura: unknown }>).map((r) => [r.sha256, json(r.lectura) as unknown as LecturaGuardada]));
  }

  async guardarLectura(trx: Knex.Transaction, tenant: string, sheetId: string, sha256: string, lectura: LecturaGuardada, ahora: string): Promise<boolean> {
    const r = await trx.raw(GUARDAR_LECTURA_SQL, [AI_RAW_VERSION, sha256, JSON.stringify(lectura), ahora, sheetId, tenant, sha256]);
    return Number(r?.rowCount ?? 0) === 1;
  }

  async fichasListas(trx: Knex.Transaction, tenant: string, limite: number): Promise<FichaParaPropuesta[]> {
    const { rows } = await trx.raw(FICHAS_LISTAS_SQL, [tenant, limite]);
    return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r['id']), sku: String(r['sku']), branch_code: String(r['branch_code']), principal: String(r['principal']),
      photos: (Array.isArray(r['photos']) ? r['photos'] : (json(r['photos']) as unknown as FotoDeFicha[] | null) ?? []) as FotoDeFicha[],
      lecturas: (json(r['lecturas']) ?? {}) as unknown as Record<string, LecturaGuardada>,
      actualizado_en: (r['actualizado_en'] as string | null) ?? null,
    }));
  }

  async kepler(trx: Knex.Transaction, sucursal: string, sku: string): Promise<KdiiFila | null> {
    const filas = await kdiiPorSku(trx, sucursal, [sku], { tresCompleta: true });
    return filas[0] ?? null;
  }

  async guardarPropuesta(
    trx: Knex.Transaction, tenant: string, ficha: FichaParaPropuesta, propuesta: PropuestaAmpliada, auditoria: AuditoriaKepler, ahora: string,
  ): Promise<boolean> {
    const r = await trx.raw(GUARDAR_PROPUESTA_SQL, [
      JSON.stringify(propuesta), JSON.stringify(auditoria), ahora, ficha.id, tenant, ficha.actualizado_en, JSON.stringify(ficha.photos),
    ]);
    return Number(r?.rowCount ?? 0) === 1;
  }
}

// ── El worker ──────────────────────────────────────────────────────────────────────────────────

@Injectable()
export class LectorFotosWorker {
  private readonly logger = new Logger(LectorFotosWorker.name);
  /** Una corrida a la vez en este proceso (el candado de la base cubre a los demás pods). */
  private corriendo = false;

  // Costuras para las pruebas (el mismo patrón de `protected` que `LevantamientoService`).
  protected repo = new RepoLectorFotos();
  protected duracionMaxMs = DURACION_MAX_MS;
  protected config(): ConfigLector { return leerConfigLector(); }
  protected ahora(): Date { return new Date(); }
  /** Reloj del tiempo de corrida (separado de `ahora`, que fecha lo guardado): la prueba lo simula. */
  protected reloj(): number { return Date.now(); }
  protected esperar(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
  protected sharpListo(): boolean { return sharpDisponible(); }
  protected llaveLista(): boolean { return this.lector.tieneLlave; }
  protected preparar(bytes: Buffer, recorte: ModoRecorte): Promise<FotoPreparada> { return prepararFoto(bytes, { recorte }); }
  protected fusionar(entradas: Array<{ cara: string; lectura: LecturaFotoV1 }>): PropuestaAmpliada { return fusionarLecturas(entradas); }
  protected auditar(propuesta: PropuestaAmpliada | null, kepler: DatosKepler): AuditoriaKepler { return auditarContraKepler(propuesta, kepler); }

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly storage: ObjectStorageService,
    private readonly lector: LectorFotoService,
  ) {}

  /** Cada 5 minutos. Apagada, no toca la base: sale en la primera línea de `procesar`. */
  @Cron('0 */5 * * * *', { timeZone: 'America/Mexico_City' })
  async programado(): Promise<void> {
    try {
      await this.procesar('cron');
    } catch (e) {
      // ⛔ No se re-lanza desde el cron (patrón de `CommissionAutoRunService`): se registra y se sigue.
      this.logger.error(`[NP.7.L.11d] la lectura de fotos falló: ${mensaje(e)}`);
    }
  }

  async procesar(origen: 'cron' | 'manual' = 'manual'): Promise<ResumenLector> {
    const cfg = this.config();
    if (!cfg.habilitada) return resumen('apagada', null, 'NP7_AI_ENABLED no es "true" (D6 sin firmar)');
    for (const a of cfg.advertencias) this.logger.warn(`[NP.7.L.11d] ${a}`);
    if (this.corriendo) return resumen('ocupado', null, 'otra corrida sigue en este proceso');
    if (!this.sharpListo()) {
      this.logger.error('[NP.7.L.11d] sin sharp no hay recorte: no se manda ninguna foto (D6, opción A)');
      return resumen('sin_preparacion', null, 'sharp no está disponible');
    }
    if (!this.llaveLista()) {
      // Como sin sharp: ni se toca la base. ❌ Antes cada foto se guardaba como lectura «error» permanente.
      this.logger.error('[NP.7.L.11d] sin ANTHROPIC_API_KEY: no se lee ninguna foto ni se guarda nada');
      return resumen('sin_llave', null, 'falta ANTHROPIC_API_KEY');
    }
    this.corriendo = true;
    const t0 = this.reloj();
    let candado: Knex.Transaction | null = null;
    try {
      candado = await this.knex.transaction();
      if (!(await tomarCandadoDeCron(candado, CLAVE_CANDADO_LECTOR))) return resumen('ocupado', null, 'otra instancia tiene el candado');
      const r = await this.corrida(cfg, t0);
      const nivel = r.estado === 'detenida' ? 'warn' : 'log';
      this.logger[nivel](`[NP.7.L.11d] ${origen}: ${r.estado} · ${r.llamadas} llamadas · ${r.leidas} leídas · ${r.reusadas} reusadas · `
        + `${r.fallidas} fallidas · ${r.pendientes_restantes ?? 'NO MEDIDO'} pendientes · costo ${r.costo_usd ?? 'NO MEDIDO'} USD`
        + `${r.detalle ? ` · ${r.detalle}` : ''}`);
      return r;
    } finally {
      this.corriendo = false;
      // El candado se suelta al terminar su transacción; en ella no se escribió nada.
      if (candado && !candado.isCompleted()) await candado.commit().catch(() => undefined);
    }
  }

  private async corrida(cfg: ConfigLector, t0: number): Promise<ResumenLector> {
    const hechas = await this.enTenant((trx) => this.repo.llamadasDeHoy(trx, TENANT_LECTOR, this.ahora()));
    const restante = cfg.topeDiario - hechas;
    if (restante <= 0) {
      this.logger.warn(`[NP.7.L.11d] tope diario alcanzado: ${hechas} de ${cfg.topeDiario} llamadas hoy; lo pendiente queda sin analizar`);
      return resumen('tope_diario', null, `${hechas} de ${cfg.topeDiario} llamadas hoy`);
    }

    const { fotos, total } = await this.enTenant((trx) => this.repo.pendientes(trx, TENANT_LECTOR, Math.min(restante, LOTE_MAX)));
    const grupos = agruparPorFoto(fotos);
    const r = resumen('completa', 0, null);
    let guardadas = 0;

    // 1) La misma foto ya leída en otra ficha: se copia, no se paga dos veces.
    const previas = grupos.length ? await this.enTenant((trx) => this.repo.lecturasExistentes(trx, TENANT_LECTOR, grupos.map((g) => g.sha256))) : new Map();
    const porLeer: GrupoFoto[] = [];
    for (const g of grupos) {
      const previa = previas.get(g.sha256);
      if (!previa) { porLeer.push(g); continue; }
      for (const p of g.pares) {
        if (await this.guardar(p.sheet_id, g.sha256, { ...previa, uso: null, cara: p.cara, peldano: p.peldano })) { r.reusadas++; guardadas++; }
      }
    }

    // 2) Las demás, una llamada por foto, a lo más `concurrencia` a la vez.
    let detener: string | null = null;
    let empezadas = 0;
    let pospuestas = 0;
    // El mismo reloj frena dos cosas: tomar otra foto (`parar`) y, dentro de una foto, reintentar o esperar (`freno`).
    const freno: Freno = { detenido: () => detener != null, quedaMs: () => this.duracionMaxMs - (this.reloj() - t0) };
    const parar = () => freno.detenido() || freno.quedaMs() < 0;
    await enParalelo(porLeer, cfg.concurrencia, parar, async (g) => {
      empezadas++;
      try {
        const res = await this.leerUna(g, cfg, freno);
        if (res.tipo === 'pospuesta') { pospuestas++; return; }
        if (res.tipo === 'detener') { detener ??= res.motivo; r.fallidas++; return; }
        if (res.tipo === 'fallo') { this.logger.warn(`[NP.7.L.11d] ${res.motivo}`); r.fallidas++; return; }
        const { resultado, preparacion } = res;
        if (resultado.uso) {
          r.llamadas++;
          if (resultado.uso.costo_usd == null) r.llamadas_sin_precio++;
          else r.costo_usd = (r.costo_usd ?? 0) + resultado.uso.costo_usd;
        }
        if (resultado.estado === 'ok' && resultado.lectura) r.leidas++;
        else {
          r.fallidas++;
          // Sin lectura no hay `rostro_visible`: el rostro de esta foto es NO MEDIDO, no «sin rostro» (regla 11). Esa foto
          // no llega a propuesta ni a auditoría (`fichaLista`) y no se relee sola (deuda (f)): sin este aviso, pasaba
          // como una foto limpia (revisión del 2026-11-05).
          r.rostros_no_medidos++;
          this.logger.warn(`[NP.7.L.11d] lectura «${resultado.estado}» de ${g.sha256.slice(0, 12)}… (fichas ${g.pares.map((p) => p.sheet_id).join(', ')}): `
            + `${resultado.error ?? 'sin detalle'} · ROSTRO NO MEDIDO: no es una foto limpia; revisarla a mano y marcar «tiene rostro» `
            + 'si lo tiene — DEUDA (a)');
        }
        // Sólo el rostro bloquea; `persona_visible` sin rostro (una mano, un zapato) es informativo y no se avisa.
        if (resultado.lectura?.rostro_visible) {
          r.rostros_visibles++;
          this.logger.warn(`[NP.7.L.11d] foto con ROSTRO visible (sha256 ${g.sha256.slice(0, 12)}…, fichas ${g.pares.map((p) => p.sheet_id).join(', ')}): `
            + 'se tiene que borrar el mismo día, sólo bajo levantamiento/ (D6, opción A) — DEUDA (a), sin construir');
        }
        const leidaEn = this.ahora().toISOString();
        const [primero, ...resto] = g.pares;
        const original: LecturaGuardada = { ...resultado, cara: primero.cara, peldano: primero.peldano, leida_en: leidaEn, preparacion };
        if (await this.guardar(primero.sheet_id, g.sha256, original)) guardadas++;
        for (const p of resto) {
          if (await this.guardar(p.sheet_id, g.sha256, { ...original, uso: null, cara: p.cara, peldano: p.peldano })) { r.reusadas++; guardadas++; }
        }
      } catch (e) {
        // Un fallo de la base al guardar: la foto sigue pendiente y la corrida sigue con las demás.
        this.logger.error(`[NP.7.L.11d] no se pudo guardar la lectura de ${g.sha256.slice(0, 12)}…: ${mensaje(e)}`);
        r.fallidas++;
      }
    });

    // 3) Fichas completas → propuesta + auditoría contra Kepler.
    r.propuestas = await this.proponer();

    r.pendientes_restantes = Math.max(0, total - guardadas);
    r.costo_usd = r.llamadas_sin_precio > 0 ? null : Math.round((r.costo_usd ?? 0) * 1e6) / 1e6;
    if (detener) { r.estado = 'detenida'; r.detalle = `lote detenido: ${detener}`; }
    else if (empezadas < porLeer.length || pospuestas > 0) { r.estado = 'detenida'; r.detalle = `tiempo de corrida agotado (${Math.round(this.duracionMaxMs / 1000)} s); sigue en la próxima`; }
    else if (!grupos.length) r.estado = 'sin_pendientes';
    if (r.llamadas_sin_precio > 0) r.detalle = `${r.detalle ? `${r.detalle} · ` : ''}${r.llamadas_sin_precio} llamadas sin precio en la tabla: costo NO MEDIDO`;
    return r;
  }

  /**
   * Bajar → preparar → leer (con reintentos). No escribe nada.
   * Ninguna llamada empieza pasado `DURACION_MAX_MS`, ni se espera para un reintento que ya no cabría: el peor
   * caso del candado abierto es `DURACION_MAX_MS + TIMEOUT_MS` (una llamada que empezó justo antes del límite).
   */
  private async leerUna(g: GrupoFoto, cfg: ConfigLector, freno: Freno): Promise<ResultadoFoto> {
    const uri = await this.storage.getDataUri(g.storage_key).catch(() => null);
    const bytes = bytesDeDataUri(uri);
    // Puede ser pasajero (el bucket no respondió): no se guarda nada y la foto queda para la próxima.
    if (!bytes) return { tipo: 'fallo', motivo: `no se pudo bajar ${g.storage_key} del almacén` };

    let prep: FotoPreparada;
    try {
      prep = await this.preparar(bytes, cfg.recorte);
    } catch (e) {
      // Permanente (los mismos bytes fallan igual mañana): se guarda como lectura con error, sin llamada.
      return { tipo: 'guardar', resultado: { estado: 'error', lectura: null, uso: null, error: `la foto no se pudo preparar: ${mensaje(e)}` }, preparacion: null };
    }
    const preparacion = { ancho: prep.ancho, alto: prep.alto, recorte: prep.recorte, bytes: prep.bytes };
    const cara = g.pares[0].cara;
    for (let intento = 1; ; intento++) {
      // Bajar y preparar toman tiempo: se vuelve a mirar el reloj justo antes de llamar.
      if (freno.quedaMs() < 0) {
        return intento === 1 ? { tipo: 'pospuesta' } : { tipo: 'detener', motivo: 'tiempo de corrida agotado entre reintentos; sigue en la próxima' };
      }
      try {
        const resultado = await this.lector.leerFoto(
          { base64: prep.base64, mediaType: prep.mediaType, cara },
          {
            modelo: cfg.modelo,
            effort: cfg.effort,
            maxTokens: cfg.maxTokens,
          },
        );
        return { tipo: 'guardar', resultado, preparacion };
      } catch (e) {
        // Configuración o petición (sin llave, 400/401/403/404): falla igual con todas las fotos. Se detiene el lote
        // y NO se guarda nada: arreglada la configuración, el próximo cron las lee.
        if (esErrorDeConfiguracion(e) || !esReintentable(statusDeError(e))) {
          return { tipo: 'detener', motivo: `error de configuración o de la petición, no de la foto (${describir(e)}); no se guardó ninguna lectura` };
        }
        if (intento >= INTENTOS_MAX) return { tipo: 'detener', motivo: `${INTENTOS_MAX} intentos sin respuesta (${describir(e)}); la llave la comparten ~10 servicios` };
        const espera = esperaDeReintento(e, intento);
        if (espera == null) {
          const pedido = Math.round(Number((e as { retryAfterMs?: unknown }).retryAfterMs) / 1000);
          return { tipo: 'detener', motivo: `la API pidió esperar ${pedido} s (${describir(e)}), más de ${ESPERA_MAX_MS / 1000} s: no se insiste antes; sigue el próximo cron` };
        }
        if (freno.detenido()) return { tipo: 'detener', motivo: `el lote ya se detuvo (${describir(e)})` };
        if (freno.quedaMs() < espera) {
          return { tipo: 'detener', motivo: `tiempo de corrida agotado: no alcanza para esperar ${Math.round(espera / 1000)} s y reintentar (${describir(e)}); sigue en la próxima` };
        }
        await this.esperar(espera);
        if (freno.detenido()) return { tipo: 'detener', motivo: `el lote ya se detuvo (${describir(e)})` };
      }
    }
  }

  private async guardar(sheetId: string, sha256: string, lectura: LecturaGuardada): Promise<boolean> {
    return this.enTenant((trx) => this.repo.guardarLectura(trx, TENANT_LECTOR, sheetId, sha256, lectura, this.ahora().toISOString()));
  }

  /**
   * Propuesta + auditoría de las fichas con todas sus fotos reales leídas `ok`. Devuelve cuántas escribió.
   * `foto_no_legible` se agrega aquí y no en `auditarContraKepler`: la propuesta fusionada no trae `legible` por
   * cara. ❌ Antes nadie lo emitía y una ficha ilegible quedaba con `hallazgos: []`, igual que una que cuadra.
   */
  private async proponer(): Promise<number> {
    const listas = await this.enTenant((trx) => this.repo.fichasListas(trx, TENANT_LECTOR, LOTE_MAX));
    let escritas = 0;
    for (const f of listas) {
      const principal = f.principal as PeldanoPrincipal;
      if (!(PELDANOS as readonly string[]).includes(principal) || !fichaLista(f.photos, principal, f.lecturas)) continue;
      try {
        const entradas = fotosReales(f.photos, principal).map((x) => ({ cara: x.cara, lectura: f.lecturas[x.sha256!].lectura! }));
        const propuesta = this.fusionar(entradas);
        const ok = await this.enTenant(async (trx) => {
          const k = await this.repo.kepler(trx, f.branch_code, f.sku);
          const kepler: DatosKepler = { nombre: k?.nombre ?? null, principal, u1: k?.u1 ?? null, u2: k?.u2 ?? null, f2: k?.f2 ?? null, u3: k?.u3 ?? null, f3: k?.f3 ?? null };
          const contraKepler = this.auditar(propuesta, kepler);
          const auditoria: AuditoriaKepler = { ...contraKepler, hallazgos: [...contraKepler.hallazgos, ...hallazgosDeLegibilidad(entradas)] };
          return this.repo.guardarPropuesta(trx, TENANT_LECTOR, f, propuesta, auditoria, this.ahora().toISOString());
        });
        if (ok) escritas++;
      } catch (e) {
        this.logger.error(`[NP.7.L.11d] no se pudo armar la propuesta de la ficha ${f.id}: ${mensaje(e)}`);
      }
    }
    return escritas;
  }

  /** Transacción corta con el tenant puesto: `catalog.product_sheets` tiene RLS FORZADA (sin él, CERO filas). */
  private enTenant<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_LECTOR]);
      return fn(trx);
    });
  }
}

function resumen(estado: EstadoCorrida, costo: number | null, detalle: string | null): ResumenLector {
  return {
    estado, leidas: 0, reusadas: 0, fallidas: 0, llamadas: 0, pendientes_restantes: null,
    // Sin llamadas, el costo es un cero MEDIDO (no se llamó); `null` se reserva para «no se sabe».
    costo_usd: costo ?? 0, llamadas_sin_precio: 0, propuestas: 0, rostros_visibles: 0, rostros_no_medidos: 0, detalle,
  };
}
