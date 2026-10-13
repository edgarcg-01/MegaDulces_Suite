/**
 * Fase RH · `[RH.2.3]` — cómo se NOMBRA y se muestra lo de reclutamiento. Funciones puras (se prueban sin DOM).
 *
 * Los nombres de las etapas son los que RH ya usa en Mega Talento (`proceso.model.ts`): cambiarlos obligaría a
 * reaprender una pantalla que ya conocen.
 */
import type { HrTalentApartado, HrTalentEtapa } from '@megadulces/contracts';

export interface EtapaVista {
  id: HrTalentEtapa;
  label: string;
  corto: string;
  /** Horas que RH se dio como meta para responder en esa etapa (SLA de Mega Talento). */
  slaHoras: number | null;
}

/** Las 4 etapas del proceso, en orden, más los dos desenlaces. */
export const ETAPAS: readonly EtapaVista[] = [
  { id: 'filtro_inicial', label: 'Filtro Inicial', corto: 'Filtro', slaHoras: 24 },
  { id: 'entrevista_rh', label: 'Entrevista Orientación Conductual', corto: 'Conductual', slaHoras: 48 },
  { id: 'aptitudes', label: 'Aptitudes y Entrevista Técnica', corto: 'Aptitudes', slaHoras: 48 },
  { id: 'psicometria', label: 'Psicométricas', corto: 'Psicométricas', slaHoras: 72 },
  { id: 'contratado', label: 'Contratados', corto: 'Contratados', slaHoras: null },
  { id: 'rechazado', label: 'Rechazados', corto: 'Rechazados', slaHoras: null },
];

export const ETAPAS_DEL_FLUJO = ETAPAS.slice(0, 4);

export function etapaLabel(id: string | null | undefined): string {
  return ETAPAS.find((e) => e.id === id)?.label ?? (id ? id : 'Sin etapa');
}

export const APARTADOS: readonly { id: HrTalentApartado; label: string; ayuda: string }[] = [
  { id: 'postulados', label: 'Postulados', ayuda: 'Ya mandaron su CV, o RH ya los movió de etapa.' },
  { id: 'en_proceso', label: 'Todos en proceso', ayuda: 'Incluye a quien sólo ha hablado con el bot y todavía no manda CV.' },
  { id: 'no_recontratables', label: 'No recontratables', ayuda: 'Marcados para no volver a entrar, con su motivo.' },
  { id: 'spam', label: 'Spam', ayuda: 'Postulaciones que no son de verdad. No se borran.' },
  { id: 'papelera', label: 'Papelera', ayuda: 'Se puede restaurar. Nada se borra.' },
];

/** Siguiente etapa del flujo (null si ya está en la última o en un desenlace). */
export function siguienteEtapa(id: HrTalentEtapa): HrTalentEtapa | null {
  const i = ETAPAS_DEL_FLUJO.findIndex((e) => e.id === id);
  return i >= 0 && i < ETAPAS_DEL_FLUJO.length - 1 ? ETAPAS_DEL_FLUJO[i + 1].id : null;
}

/** «hace 3 h», «hace 2 días»… desde una fecha ISO. `ahora` inyectable para probar. */
export function hace(iso: string | null | undefined, ahora: Date = new Date()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const min = Math.max(0, Math.round((ahora.getTime() - t) / 60000));
  if (min < 60) return min <= 1 ? 'hace un momento' : `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

/** Fecha corta en hora de México: «12 oct 2026». */
export function fechaMx(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Fecha y hora en hora de México: «12 oct, 09:30». */
export function fechaHoraMx(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Horas como «18 h» o «3.5 días» (el KPI de tiempo por etapa). */
export function duracion(horas: number | null | undefined): string {
  if (horas == null || Number.isNaN(horas)) return '—';
  if (horas < 48) return `${Math.round(horas * 10) / 10} h`;
  return `${Math.round((horas / 24) * 10) / 10} días`;
}

/**
 * ¿La etapa ya rebasó su meta? Sólo para etapas del flujo con SLA; mide desde la última actividad (o el alta).
 * `null` = no aplica (desenlace o sin fecha) — no se pinta como "a tiempo".
 */
export function rebasaSla(etapa: HrTalentEtapa, desdeIso: string | null | undefined, ahora: Date = new Date()): boolean | null {
  const sla = ETAPAS.find((e) => e.id === etapa)?.slaHoras;
  if (!sla || !desdeIso) return null;
  const t = new Date(desdeIso).getTime();
  if (Number.isNaN(t)) return null;
  return (ahora.getTime() - t) / 3600000 > sla;
}

export const TIPOS_EVENTO = [
  { value: 'contacto', label: 'Contacto' },
  { value: 'entrevista', label: 'Entrevista' },
  { value: 'contratacion', label: 'Contratación' },
  { value: 'nota', label: 'Nota' },
] as const;

export const CANALES = [
  { value: 'llamada', label: 'Llamada' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'presencial', label: 'Presencial' },
  { value: 'portal', label: 'Portal' },
] as const;

/** Tamaño máximo de un documento (el mismo que valida el servidor). */
export const MAX_DOCUMENTO_BYTES = 10 * 1024 * 1024;

/** Lee un `File` como data URI (lo que espera la API). */
export function leerComoDataUri(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('No se pudo leer el archivo.'));
    r.readAsDataURL(f);
  });
}

/** El teléfono en grupos legibles: «351 123 4567». */
export function telefono(t: string | null | undefined): string {
  if (!t) return '—';
  const d = t.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : t;
}
