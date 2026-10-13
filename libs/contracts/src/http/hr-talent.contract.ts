/**
 * Fase RH · `[RH.2.2]` — contrato de la API de reclutamiento (`/api/hr/talent/*`).
 *
 * Campos en inglés snake_case (convención de la Suite). Las etapas y los apartados se escriben
 * con los ids de Mega Talento para que la carga única no traduzca nada.
 */

import type { HrCompetenciaStar, HrNivelStar } from './hr-aptitudes.contract';

export type HrTalentEtapa = 'filtro_inicial' | 'entrevista_rh' | 'aptitudes' | 'psicometria' | 'contratado' | 'rechazado';
export type HrTalentApartado = 'postulados' | 'en_proceso' | 'spam' | 'no_recontratables' | 'papelera';
export type HrTalentTipoEvento = 'contacto' | 'entrevista' | 'contratacion' | 'nota';
export type HrTalentCanal = 'llamada' | 'whatsapp' | 'presencial' | 'bot' | 'portal';
export type HrTalentMotivoPapelera = 'manual' | 'cierre_seguimiento' | 'fusionado';

/** Un renglón de la lista. */
export interface HrCandidatoFilaDto {
  id: string;
  full_name: string | null;
  phone: string | null;
  phone_key: string | null;
  city_branch: string | null;
  position_interest: string | null;
  /** La etapa con la que se lee (las viejas ya reubicadas; sin etapa = filtro_inicial). */
  stage: HrTalentEtapa;
  /** La que está guardada, tal cual (null = nunca se movió). */
  stage_raw: string | null;
  source: string | null;
  traffic_light: 'verde' | 'amarillo' | 'rojo' | null;
  has_cv: boolean;
  no_rehire: boolean;
  is_spam: boolean;
  created_at: string;
  last_activity_at: string | null;
  deleted_at: string | null;
  deletion_reason: HrTalentMotivoPapelera | null;
}

export interface HrCandidatosListaDto {
  total: number;
  filas: HrCandidatoFilaDto[];
  /** Conteo por etapa del apartado pedido, sin el filtro de etapa (el menú de RH). */
  por_etapa: Record<string, number>;
}

export interface HrCandidatoTransicionDto {
  id: string;
  candidate_id: string;
  stage_from: string | null;
  stage_to: string;
  hours_in_from: number | null;
  changed_by_name: string | null;
  changed_at: string;
}

export interface HrCandidatoEventoDto {
  id: string;
  candidate_id: string;
  event_type: HrTalentTipoEvento;
  channel: HrTalentCanal | null;
  note: string | null;
  actor_name: string | null;
  occurred_at: string;
}

/** La ficha: todo el candidato, con su historia y la de los registros que absorbió. */
export interface HrCandidatoFichaDto extends HrCandidatoFilaDto {
  email: string | null;
  legacy_portal_id: string | null;
  job_posting_id: string | null;
  origin: string | null;
  bot_state: string | null;
  commute_time: string | null;
  availability: string | null;
  previous_employer: string | null;
  desired_salary: string | null;
  rfc: string | null;
  nss: string | null;
  relative_in_company: string | null;
  rehire_note: string | null;
  cv_url: string | null;
  cv_back_url: string | null;
  cv_format: string | null;
  license_url: string | null;
  /** El expediente: cada documento con su URL firmada (si vive en el bucket) o la externa. */
  documents: HrDocumentoDto[];
  /** Los casilleros obligatorios que faltan (con lo vigente). */
  documentos_faltantes: string[];
  requested_documents: unknown[];
  application: unknown | null;
  aptitude_rubric: unknown | null;
  aptitude_eval: unknown | null;
  portal_data: Record<string, unknown>;
  no_rehire_reason: string | null;
  no_rehire_by_name: string | null;
  no_rehire_at: string | null;
  spam_reason: string | null;
  spam_by_name: string | null;
  spam_at: string | null;
  merged_into_id: string | null;
  /** Los registros que se fusionaron en éste (su historia aparece abajo). */
  absorbidos: Array<{ id: string; full_name: string | null; created_at: string }>;
  transiciones: HrCandidatoTransicionDto[];
  eventos: HrCandidatoEventoDto[];
  /** Otros registros vivos con el mismo teléfono (posibles duplicados). */
  mismo_telefono: Array<{ id: string; full_name: string | null; created_at: string; no_rehire: boolean }>;
}

/** Un casillero del expediente (catálogo del bot: las llaves coinciden exacto). */
export interface HrCasilleroDto {
  key: string;
  label: string;
  obligatorio: boolean;
}

/** Un documento del expediente. */
export interface HrDocumentoDto {
  /** Con qué se identifica para retirarlo (la llave del bucket o la URL externa). */
  llave: string;
  slot: string | null;
  file_name: string | null;
  content_type: string | null;
  /** Firmada y temporal si `en_bucket`; si no, la URL externa que trajo el bot o Cloudinary. */
  url: string | null;
  en_bucket: boolean;
  origen: string | null;
  recibido_en: string | null;
  subido_por_nombre: string | null;
  vigente: boolean;
  retired_at: string | null;
  retired_by_name: string | null;
  retire_reason: string | null;
}

/** Subir un documento: data URI en base64 (máx. 10 MB; PDF o imagen, validado por firma). */
export interface HrDocumentoNuevo {
  slot: string;
  file_name?: string | null;
  file_base64: string;
}

/** Lo que RH puede corregir a mano de un candidato. */
export interface HrCandidatoEdicion {
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  city_branch?: string | null;
  position_interest?: string | null;
  job_posting_id?: string | null;
}

export interface HrCandidatoEventoNuevo {
  event_type: HrTalentTipoEvento;
  channel?: HrTalentCanal | null;
  note?: string | null;
  /** yyyy-MM-ddTHH:mm (hora de México) — default: ahora. */
  occurred_at?: string | null;
}

export interface HrFusionResultadoDto {
  conservado: string;
  absorbido: string;
  rellenados: string[];
}

/** Un grupo de registros vivos con el mismo teléfono. */
export interface HrDuplicadoGrupoDto {
  phone_key: string;
  candidatos: Array<{ id: string; full_name: string | null; source: string | null; created_at: string; has_cv: boolean; stage: HrTalentEtapa }>;
}

/** Alguien vivo en proceso con el mismo teléfono que alguien marcado como no recontratable. */
export interface HrReingresoAlertaDto {
  id: string;
  full_name: string | null;
  phone: string | null;
  stage: HrTalentEtapa;
  created_at: string;
  marcado_id: string;
  marcado_nombre: string | null;
  motivo: string | null;
  marcado_por: string | null;
  marcado_en: string | null;
}

export interface HrTiempoPorEtapaDto {
  etapa: string;
  n: number;
  avg_horas: number;
  min_horas: number;
  max_horas: number;
}

export interface HrVacanteDto {
  id: string;
  name: string;
  description: string | null;
  area: string | null;
  branch_codes: string[];
  branches_text: string | null;
  salary_text: string | null;
  schedule_text: string | null;
  requirements: string | null;
  image_url: string | null;
  competencies_sheet: string | null;
  extra: Record<string, unknown>;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type HrVacanteEdicion = Partial<Omit<HrVacanteDto, 'id' | 'created_at' | 'updated_at'>>;

// ── Bolsa de trabajo pública (`[RH.2.4]`) ───────────────────────────────────────────────────

/**
 * Las sucursales donde se contrata, con su ciudad. Copia de `SUCURSALES` de Mega Talento
 * (`src/app/core/models/sucursales.model.ts`): los `id` son los que ya guardan sus vacantes en `branch_codes`, así
 * que NO se cambian. Los centros internos (corporativo, CEDIS, bodegas) no van: Mega Talento los excluye a propósito
 * del portal de candidatos.
 */
export const HR_SUCURSALES_EMPLEO = [
  { id: 'morelia-vicente-guerrero', ciudad: 'Morelia', direccion: 'Av Francisco I. Madero Pte 3600, Vicente Guerrero, 58189 Morelia, Mich.' },
  { id: 'morelia-figaredo', ciudad: 'Morelia', direccion: 'Soledad Gutiérrez de Figaredo 510, 58218 Morelia, Mich.' },
  { id: 'zamora-canindo', ciudad: 'Zamora', direccion: 'Block P Bodega 6, Canindo, 59757 Zamora de Hidalgo, Mich.' },
  { id: 'zamora-catedral', ciudad: 'Zamora', direccion: 'C. Dámaso Cárdenas 7, Jardines de Catedral, 59670 Zamora de Hidalgo, Mich.' },
  { id: 'santa-ana-pacueco', ciudad: 'Santa Ana Pacueco', direccion: 'Av Padre Hidalgo 322, Sta Ana Pacueco, 36910 Santa Ana Pacueco, Gto.' },
  { id: 'la-piedad-abastos', ciudad: 'La Piedad', direccion: 'Abastos, Av. Mariano Jiménez 1582, Peña, 59389 La Piedad de Cabadas, Mich.' },
  { id: 'la-piedad-centro', ciudad: 'La Piedad', direccion: 'Pino Suárez 259, Centro, 59300 La Piedad de Cabadas, Mich.' },
  { id: 'yurecuaro-centro', ciudad: 'Yurécuaro', direccion: 'Sr. Cura Don Miguel Hidalgo 22, Centro, 59250 Yurécuaro, Mich.' },
] as const;

/** Las ciudades, en el orden del catálogo, sin repetir. */
export const HR_CIUDADES_EMPLEO: readonly string[] = [...new Set(HR_SUCURSALES_EMPLEO.map((s) => s.ciudad))];

/** «¿Dónde te enteraste de la vacante?» — la misma lista de Mega Talento (es el dato de qué canal trae gente). */
export const HR_FUENTES_EMPLEO = [
  'Facebook / Redes Sociales',
  'Lona o cartel en sucursal',
  'Recomendación de un amigo/familiar',
  'Feria de empleo',
  'Otro',
] as const;

/**
 * ¿La vacante aplica en esa ciudad? Una vacante sin sucursales asignadas aplica en todas (regla de Mega Talento:
 * así no se esconden las viejas mientras se reconfiguran).
 */
export function hrVacanteEnCiudad(branchCodes: readonly string[] | null | undefined, ciudad: string): boolean {
  if (!branchCodes || !branchCodes.length) return true;
  return branchCodes.some((id) => HR_SUCURSALES_EMPLEO.some((s) => s.id === id && s.ciudad === ciudad));
}

/** ¿El puesto pide licencia de manejo? Regla de Mega Talento: Chofer y Logística. */
export function hrPideLicencia(nombreVacante: string | null | undefined): boolean {
  const n = String(nombreVacante ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return n === 'chofer' || n === 'logistica';
}

/** Una vacante tal como se publica (sin nada interno). */
export interface HrVacantePublicaDto {
  id: string;
  name: string;
  area: string | null;
  branch_codes: string[];
  branches_text: string | null;
  salary_text: string | null;
  schedule_text: string | null;
  requirements: string | null;
  description: string | null;
  image_url: string | null;
}

/** Lo que manda el formulario público. El CV es obligatorio (data URI, PDF o imagen, máx. 10 MB). */
export interface HrPostulacionPublica {
  full_name: string;
  phone: string;
  email?: string | null;
  city_branch: string;
  /** La vacante elegida; si no hay, el puesto escrito. */
  job_posting_id?: string | null;
  position_interest?: string | null;
  relative_in_company?: string | null;
  rehire_note?: string | null;
  /** ¿Dónde se enteró de la vacante? Uno de `HR_FUENTES_EMPLEO`. */
  heard_from: string;
  cv_base64: string;
  cv_file_name?: string | null;
  /** Obligatoria si el puesto es Chofer o Logística (`hrPideLicencia`). */
  license_base64?: string | null;
  license_file_name?: string | null;
  privacy_accepted: boolean;
  /** Campo trampa: una persona no lo ve. Si llega lleno, es un robot. */
  website?: string | null;
}

// ── Ligas personales (`[RH.2.4]`) ───────────────────────────────────────────────────────────

/**
 * Lo que una liga deja hacer: subir el CV o contestar el cuestionario de liderazgo (las abre el CANDIDATO), o la
 * evaluación de aptitudes (la abre el JEFE que entrevista).
 */
export type HrLigaFormulario = 'cv' | 'liderazgo' | 'aptitudes';

/** Lo que recibe RH al generar una liga. */
export interface HrLigaCreadaDto {
  url: string;
  expires_at: string;
  /** El texto sugerido para mandarla. */
  mensaje: string;
  /** `wa.me` con el mensaje, si el candidato tiene teléfono. */
  whatsapp_url: string | null;
}

/** Lo que ve la página pública de la liga: lo mínimo. Nada del expediente. */
export interface HrLigaContextoDto {
  form: HrLigaFormulario;
  nombre: string | null;
  puesto: string | null;
  ya_tiene_cv: boolean;
  vence: string | null;
  /** Cuestionario de liderazgo: lo que ya contestó (para retomar donde se quedó). Nunca el puntaje. */
  respuestas?: Record<number, number> | null;
  /** Cuestionario de liderazgo: ya contestó las 12 y quedó cerrado. */
  terminado?: boolean;
  /** Aptitudes (la abre el jefe): el nombre completo del candidato, para saber a quién evalúa. Nada de contacto. */
  candidato_nombre?: string | null;
  /** Aptitudes: las competencias CONGELADAS al generar la liga (la hoja del puesto). */
  competencias?: HrCompetenciaStar[];
  /** Aptitudes: lo que ya calificó (para corregir sin empezar de cero, como en Mega Talento). */
  rubrica?: Record<string, HrNivelStar> | null;
  evaluacion?: { evaluador: string; cargoEvaluador: string; tiempo: string; observaciones: string } | null;
}

/** Una respuesta del cuestionario de liderazgo. */
export interface HrLiderazgoRespuesta {
  num: number;
  valor: number;
}

/** Cómo va el cuestionario: sin puntaje (el candidato no ve su resultado). */
export interface HrLiderazgoAvanceDto {
  contestadas: number;
  total: number;
  terminado: boolean;
}

/** Subir el CV desde la liga: un PDF, o dos fotos (frente y reverso). */
export interface HrLigaCvSubida {
  files: Array<{ file_base64: string; file_name?: string | null }>;
}

/** La respuesta: nunca dice para qué vacante está la persona ni si está en la lista negra. */
export interface HrPostulacionResultadoDto {
  resultado: 'recibida' | 'rechazada';
  mensaje: string;
}
