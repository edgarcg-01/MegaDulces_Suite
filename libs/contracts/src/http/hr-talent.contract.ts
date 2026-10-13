/**
 * Fase RH · `[RH.2.2]` — contrato de la API de reclutamiento (`/api/hr/talent/*`).
 *
 * Campos en inglés snake_case (convención de la Suite). Las etapas y los apartados se escriben
 * con los ids de Mega Talento para que la carga única no traduzca nada.
 */

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
  cv_base64: string;
  cv_file_name?: string | null;
  privacy_accepted: boolean;
  /** Campo trampa: una persona no lo ve. Si llega lleno, es un robot. */
  website?: string | null;
}

/** La respuesta: nunca dice para qué vacante está la persona ni si está en la lista negra. */
export interface HrPostulacionResultadoDto {
  resultado: 'recibida' | 'rechazada';
  mensaje: string;
}
