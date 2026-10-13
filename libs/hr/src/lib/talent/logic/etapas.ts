import { casilleroDe, llaveDocumento, vigente, type EntradaDocumento } from './expediente';

/**
 * Fase RH · `[RH.2.2]` — las reglas puras de reclutamiento: etapas, apartados y fusión.
 *
 * Traslado de `mega-talento-90/src/app/core/models/proceso.model.ts` (etapas) y de
 * `api/src/candidatos.ts` (fusión, apartados). Sin base: se prueban en CI.
 */

/** Las 4 etapas vigentes del proceso, en orden (el stepper de RH). */
export const ETAPAS_VIGENTES = ['filtro_inicial', 'entrevista_rh', 'aptitudes', 'psicometria'] as const;

/** Desenlaces: no son etapas del flujo, pero son a donde se mueve a alguien al terminar. */
export const DESENLACES = ['contratado', 'rechazado'] as const;

export type EtapaVigente = (typeof ETAPAS_VIGENTES)[number];
export type Desenlace = (typeof DESENLACES)[number];
export type Etapa = EtapaVigente | Desenlace;

/**
 * Ids que Mega Talento ya no muestra pero siguen en datos viejos: se LEEN y se reubican en la
 * etapa vigente equivalente. Copia exacta de `normalizar()` en `src/app/rh/etapa/etapa.ts` (y
 * `layout.ts`). Nunca se escriben.
 */
const ETAPAS_VIEJAS: Record<string, Etapa> = {
  contacto_pendiente: 'filtro_inicial',
  entrevista: 'entrevista_rh',
  nuevo: 'filtro_inicial',
  entrevista_jefe: 'aptitudes',
  documental: 'psicometria',
  oferta: 'psicometria',
  dictamen: 'psicometria',
};

/** Sin etapa = recién llegado por el bot: para RH está en Filtro Inicial. */
export const ETAPA_INICIAL: EtapaVigente = 'filtro_inicial';

/** Las etapas a las que RH puede mover a alguien. */
export function esEtapaDestino(x: unknown): x is Etapa {
  return typeof x === 'string' && ([...ETAPAS_VIGENTES, ...DESENLACES] as string[]).includes(x);
}

/** La etapa con la que se lee a un candidato (vieja → vigente, vacía → filtro inicial). */
export function etapaDe(stage: string | null | undefined): Etapa {
  if (!stage || !String(stage).trim()) return ETAPA_INICIAL;
  const s = String(stage).trim();
  if (esEtapaDestino(s)) return s;
  return ETAPAS_VIEJAS[s] ?? ETAPA_INICIAL;
}

/**
 * Los apartados de la lista. `postulados` es el default y sigue la regla de Mega Talento
 * (`ES_POSTULACION`, 05-ago-2026): una postulación empieza cuando manda su CV, no cuando saluda
 * al bot — o cuando RH ya lo movió a mano (sale con su marca de «sin CV»).
 */
export const APARTADOS = ['postulados', 'en_proceso', 'spam', 'no_recontratables', 'papelera'] as const;
export type Apartado = (typeof APARTADOS)[number];

export function esApartado(x: unknown): x is Apartado {
  return typeof x === 'string' && (APARTADOS as readonly string[]).includes(x);
}

/**
 * ¿Tiene CV? El de la web (`cv_url`), el que mandó por WhatsApp o el que subió RH
 * (`documents[].slot='cv'` vigente, con archivo).
 */
export function tieneCv(c: { cv_url?: string | null; documents?: unknown }): boolean {
  if (c.cv_url && String(c.cv_url).trim()) return true;
  if (!Array.isArray(c.documents)) return false;
  return c.documents.some((d) => {
    const x = d as EntradaDocumento | null;
    return !!x && vigente(x) && casilleroDe(x) === 'cv' && !!String(x['storage_key'] ?? x['url'] ?? x['archivo_local'] ?? '').trim();
  });
}

/** El mismo criterio, en SQL, para filtrar en la base (alias `c`). */
export const SQL_ES_POSTULACION = `(
  (c.cv_url IS NOT NULL AND btrim(c.cv_url) <> '')
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.documents) = 'array' THEN c.documents ELSE '[]'::jsonb END) d
     WHERE coalesce(d->>'slot', d->>'tipo') = 'cv' AND d->>'retired_at' IS NULL
       AND coalesce(d->>'storage_key', d->>'url', d->>'archivo_local', '') <> ''
  )
  OR c.stage IS NOT NULL
)`;

/** El motivo de una marca: obligatorio, sin espacios sobrantes, máximo 500. */
export function motivoValido(m: unknown): string | null {
  const s = String(m ?? '').trim().slice(0, 500);
  return s.length >= 3 ? s : null;
}

// ── Fusión ─────────────────────────────────────────────────────────────────────────────────

/**
 * Las columnas que la fusión RELLENA desde el absorbido cuando en el que se conserva están vacías.
 * Las mismas de Mega Talento (`HUECOS`), con nombres de la Suite. Nunca se pisa un dato.
 */
export const COLUMNAS_QUE_SE_RELLENAN = [
  'full_name', 'phone', 'email', 'city_branch', 'position_interest', 'job_posting_id',
  'cv_url', 'cv_back_url', 'cv_format', 'license_url', 'relative_in_company', 'rehire_note',
  'source', 'origin', 'bot_state', 'stage', 'legacy_portal_id',
  'commute_time', 'availability', 'previous_employer', 'desired_salary', 'rfc', 'nss',
  'application', 'aptitude_rubric', 'aptitude_eval',
] as const;

const vacio = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());

/**
 * Lo que la fusión le escribe al registro que se CONSERVA. Reglas de Mega Talento:
 *   1. sólo se rellenan huecos;
 *   2. `portal_data`: lo del absorbido abajo, lo del conservado encima;
 *   3. documentos: la unión, sin repetir el mismo archivo (por url);
 *   4. la fecha de alta es la más vieja (el día en que la persona se postuló de verdad) y la última
 *      actividad la más reciente.
 */
export function fusion(conservar: Record<string, unknown>, absorber: Record<string, unknown>): {
  cambios: Record<string, unknown>; rellenados: string[];
} {
  const cambios: Record<string, unknown> = {};
  const rellenados: string[] = [];
  for (const col of COLUMNAS_QUE_SE_RELLENAN) {
    if (vacio(conservar[col]) && !vacio(absorber[col])) {
      cambios[col] = absorber[col];
      rellenados.push(col);
    }
  }
  const pd = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  cambios['portal_data'] = { ...pd(absorber['portal_data']), ...pd(conservar['portal_data']) };

  const docs = (x: unknown) => (Array.isArray(x) ? (x as Array<Record<string, unknown>>) : []);
  const vistos = new Set<string>();
  const unidos: Array<Record<string, unknown>> = [];
  for (const d of [...docs(conservar['documents']), ...docs(absorber['documents'])]) {
    const llave = llaveDocumento(d ?? {});
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    unidos.push(d);
  }
  cambios['documents'] = unidos;

  const t = (x: unknown) => (x ? new Date(String(x)).getTime() : NaN);
  const altaA = t(conservar['created_at']), altaB = t(absorber['created_at']);
  if (!Number.isNaN(altaB) && (Number.isNaN(altaA) || altaB < altaA)) cambios['created_at'] = absorber['created_at'];
  const actA = t(conservar['last_activity_at']), actB = t(absorber['last_activity_at']);
  if (!Number.isNaN(actB) && (Number.isNaN(actA) || actB > actA)) cambios['last_activity_at'] = absorber['last_activity_at'];
  return { cambios, rellenados };
}
