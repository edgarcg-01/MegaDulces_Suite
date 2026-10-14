import type { ConsentimientoSensibles } from './solicitud';

/**
 * Fase RH · `[RH.3.3.3]` — el consentimiento EXPRESO para las preguntas sensibles de la solicitud (salud, estatura y
 * peso, familia, situación económica, afiliación sindical). LFPDPPP arts. 3 y 9: los datos sensibles piden
 * consentimiento expreso y por escrito.
 *
 * ⚠️ ES UN BORRADOR. No es texto legal revisado. Por eso está APAGADO por omisión: sin `HR_CONSENTIMIENTO_SENSIBLES=
 * vigente`, el bot NO pregunta nada sensible (fail-closed, el mismo criterio que el aviso de privacidad de PRV.2: sin
 * texto vigente publicado no hay consentimiento posible). Para prenderlo: RH/legal aprueban el texto, se sube la
 * VERSIÓN (cada aceptación guarda la versión que aceptó; un texto publicado no se edita, se versiona) y se prende la
 * variable.
 *
 * ⬜ Deuda declarada: PRV.2 (`servicedesk.privacy_notices`) ya resuelve avisos versionados con aceptación inmutable,
 * pero liga la aceptación a un USUARIO de la Suite; un candidato no lo es. Aquí la evidencia queda en la solicitud
 * (versión + fecha). Cuando el mecanismo de avisos suba a un lib común con titulares que no son usuarios, esto migra.
 */
export const CONSENTIMIENTO_SENSIBLES_BORRADOR: ConsentimientoSensibles = {
  version: 'rh-solicitud-sensibles-v1-borrador',
  texto: '🔒 *Antes de seguir:* las siguientes preguntas son sobre tu *salud, estatura y peso, tu familia, tu situación '
    + 'económica y si has estado afiliado(a) a un sindicato*. Son datos personales *sensibles*.\n\n'
    + 'Mega Dulces los usa sólo para tu proceso de selección; no se comparten fuera de Capital Humano y no deciden por sí '
    + 'solos si te contratan. Puedes no contestarlos.',
};

/** El consentimiento vigente, o null si no hay texto aprobado (y entonces no se pregunta lo sensible). */
export function consentimientoVigente(env: Record<string, string | undefined> = process.env): ConsentimientoSensibles | null {
  return env['HR_CONSENTIMIENTO_SENSIBLES'] === 'vigente' ? CONSENTIMIENTO_SENSIBLES_BORRADOR : null;
}
