import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import { HR_SUCURSALES_EMPLEO } from '@megadulces/contracts';
import { vacantesUnicas } from './vacante-match';
import type { CampoRegistro, InterpretacionRegistro, VacanteBot } from './registro';

/**
 * Fase RH · `[RH.3.2.1]` — la IA del registro por WhatsApp: saca de UN mensaje los datos que la persona menciona
 * («soy Ana, de Zamora, busco de cajera») y, si preguntó algo, la respuesta. Portado de `interpretarMensaje` de Mega
 * Talento, con sus descripciones de campo y sus reglas (no inventar; un saludo no es un puesto).
 *
 * Es una PROPUESTA: `registro.ts` pasa cada dato por los mismos validadores que la captura a mano. Y degrada limpio
 * —sin `ANTHROPIC_API_KEY`, con un error o tras el tiempo de espera devuelve `null`— y la conversación sigue por el
 * camino determinista, como en Mega Talento.
 *
 * La respuesta a una duda es texto de la IA que le llega a una persona: se le dan SÓLO datos reales (vacantes publicadas,
 * sucursales, dónde sacar RFC/NSS) y la instrucción de decir que RH lo confirma cuando el dato no está; sin prometer la
 * plaza. Se acota en `registro.ts`.
 */

const MODELO = process.env['HR_BOT_LLM_MODEL'] || 'claude-haiku-4-5-20251001';
const TIEMPO_MAX_MS = 8_000;
const HERRAMIENTA = 'registrar_datos';

/** Qué es cada campo, para que el modelo sepa qué poner (las de Mega Talento). */
const DESCRIPCION: Record<CampoRegistro, string> = {
  position_interest: 'el PUESTO o tipo de trabajo que busca, tal como lo diga ("cajera", "lo que sea", "algo administrativo"). '
    + 'Si sólo saluda, se presenta o manda su CV sin decir qué busca, deja null — NO inventes un puesto',
  full_name: 'nombre completo de la persona',
  email: 'correo electrónico (ej. juan@gmail.com). Sólo si lo escribe; si dice que no tiene correo, deja null',
  city_branch: 'ciudad o sucursal donde quiere trabajar',
  commute_time: 'tiempo de traslado de su casa al trabajo',
  availability: 'disponibilidad de horario',
  previous_employer: 'empresa donde trabajó anteriormente',
  desired_salary: 'salario mensual o por hora que desea',
  rfc: 'RFC (clave fiscal mexicana)',
  nss: 'NSS (número de seguro social del IMSS)',
  relative_in_company: 'si tiene algún familiar o pareja (esposo/a, hermano/a, hijo/a, padre/madre, novio/a) que trabaje '
    + 'actualmente en Mega Dulces; captura el nombre y el parentesco que mencione, o la palabra "ninguno" si dice que no tiene',
  rehire_note: 'si YA TRABAJÓ ANTES en Mega Dulces. Si dice que sí, en una línea: sucursal, puesto, jefe directo y cuánto '
    + 'tiempo estuvo (ej. "Sí — Yurécuaro, surtidor, jefe Juan Pérez, 3 semanas"). Si nunca ha trabajado aquí, exactamente "no". '
    + 'Ojo: es sobre MEGA DULCES, no otra empresa (para eso está la empresa anterior)',
};

/** La forma de la respuesta que se lee (el cliente compartido la devuelve cruda). */
interface RespuestaMensajes { content?: Array<{ type: string; name?: string; input?: unknown }> }

@Injectable()
export class HrRecruitmentInterpreterService {
  private readonly logger = new Logger(HrRecruitmentInterpreterService.name);

  constructor(private readonly anthropic: AnthropicService) {}

  /** Los datos explícitos del mensaje (sólo de `faltantes`) y la respuesta a su duda; null si la IA no está o falló. */
  async interpretar(texto: string, faltantes: readonly CampoRegistro[], vacantes: readonly VacanteBot[]): Promise<InterpretacionRegistro | null> {
    if (!this.anthropic.hasApiKey || !texto.trim() || !faltantes.length) return null;
    try {
      const resp: RespuestaMensajes = await this.anthropic.messages({
        model: MODELO,
        maxTokens: 1024,
        system: sistema(vacantes),
        messages: [{
          role: 'user',
          content: `Datos que aún faltan:\n${faltantes.map((c) => `- ${c}: ${DESCRIPCION[c]}`).join('\n')}\n\n`
            + `Mensaje del candidato:\n"${texto.slice(0, 2000)}"\n\nExtrae los datos presentes y responde su pregunta si la hizo.`,
        }],
        toolChoice: { type: 'tool', name: HERRAMIENTA },
        tools: [{ name: HERRAMIENTA, description: 'Registra los datos explícitos del mensaje y la respuesta a su duda.', input_schema: esquema(faltantes) }],
      }, { timeoutMs: TIEMPO_MAX_MS });
      const uso = (resp.content ?? []).find((b) => b.type === 'tool_use' && b.name === HERRAMIENTA);
      return uso ? limpiar(uso.input, faltantes) : null;
    } catch (err) {
      this.logger.warn(`[RH.3.2.1] la IA no pudo interpretar el mensaje (sigue el camino determinista): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/** El esquema de la herramienta: sólo los campos que faltan, cada uno texto o null. */
export function esquema(faltantes: readonly CampoRegistro[]): Record<string, unknown> {
  const props = Object.fromEntries(faltantes.map((c) => [c, { type: ['string', 'null'], description: DESCRIPCION[c] }]));
  return {
    type: 'object',
    properties: {
      datos: { type: 'object', properties: props, required: [...faltantes], additionalProperties: false },
      respuesta_pregunta: { type: ['string', 'null'], description: 'respuesta breve a su duda, o null si no preguntó nada' },
    },
    required: ['datos', 'respuesta_pregunta'],
  };
}

/** Lo que el modelo devolvió, reducido a lo que se pidió: un campo que no faltaba no entra, aunque venga. */
export function limpiar(entrada: unknown, faltantes: readonly CampoRegistro[]): InterpretacionRegistro | null {
  if (!entrada || typeof entrada !== 'object') return null;
  const e = entrada as { datos?: Record<string, unknown>; respuesta_pregunta?: unknown };
  const datos: InterpretacionRegistro['datos'] = {};
  for (const c of faltantes) {
    const v = e.datos?.[c];
    if (typeof v === 'string' && v.trim()) datos[c] = v.trim();
  }
  const r = typeof e.respuesta_pregunta === 'string' && e.respuesta_pregunta.trim() ? e.respuesta_pregunta.trim() : null;
  return { datos, respuesta_pregunta: r };
}

/** Las instrucciones, con los datos REALES con que puede contestar dudas. */
export function sistema(vacantes: readonly VacanteBot[]): string {
  const lista = vacantesUnicas(vacantes).map((v) => [
    `- ${v.name}`,
    v.salary_text ? `sueldo: ${v.salary_text}` : null,
    v.schedule_text ? `horario: ${v.schedule_text}` : null,
    v.requirements ? `requisitos: ${String(v.requirements).slice(0, 200)}` : null,
  ].filter(Boolean).join(' · ')).join('\n');
  return 'Eres el asistente de un bot de reclutamiento de Mega Dulces por WhatsApp. Analizas el mensaje de un candidato y '
    + 'extraes ÚNICAMENTE los datos que menciona de forma EXPLÍCITA. No inventes ni adivines: si un dato no aparece, '
    + 'déjalo en null. Si hace una pregunta (sueldo, horario, ubicación, proceso, vacantes, sucursales), respóndela en '
    + '"respuesta_pregunta" en una o dos frases amables, usando SÓLO la información de abajo; si el dato no está abajo, di '
    + 'que el equipo de Capital Humano se lo confirma. Nunca prometas que lo van a contratar. Si no preguntó nada, deja '
    + '"respuesta_pregunta" en null.\n\n'
    + `Vacantes publicadas:\n${lista || '(ninguna publicada ahora; puede registrarse igual para futuras vacantes)'}\n`
    + 'Si pregunta por un puesto que no está en la lista, dile que igual puede registrarse.\n\n'
    + `Sucursales:\n${HR_SUCURSALES_EMPLEO.map((s) => `- ${s.ciudad}: ${s.direccion}`).join('\n')}\n\n`
    + 'Si no conoce su RFC: lo saca en el SAT (sat.gob.mx) con su CURP. Si no conoce su NSS: en el IMSS '
    + '(serviciosdigitales.imss.gob.mx) con su CURP.';
}
