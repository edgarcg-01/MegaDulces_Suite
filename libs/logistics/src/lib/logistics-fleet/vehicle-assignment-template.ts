/**
 * FC.1 — Catálogo del "FORMATO DE ASIGNACIÓN VEHICULAR" (v1).
 *
 * Transcripción literal del formato en papel de Mega Dulces: 4 bloques
 * (interiores, exteriores, accesorios) con dos columnas cada uno. El orden y el
 * texto respetan la hoja para que quien viene de llenarla a mano encuentre lo
 * mismo en pantalla.
 *
 * La calificación es de TRES niveles — M/R/B — no un check. Ese es el motivo
 * por el que este formato no reusa `logistics.shipment_checklists`, cuya
 * respuesta es booleana y cuelga de un embarque, no de una unidad + persona.
 *
 * `version` viaja en `logistics.vehicle_assignments.condition_template`: si el
 * formato cambia, las actas viejas siguen sabiendo contra qué se llenaron.
 */

export type ConditionGrade = 'M' | 'R' | 'B';

export const CONDITION_GRADES: { value: ConditionGrade; label: string }[] = [
  { value: 'M', label: 'Malo' },
  { value: 'R', label: 'Regular' },
  { value: 'B', label: 'Bueno' },
];

export interface AssignmentConditionItem {
  /** id estable: se guarda como clave en el JSONB `condition`. NUNCA renombrar. */
  id: string;
  label: string;
  section: 'interiores' | 'exteriores' | 'accesorios';
}

export const VEHICLE_ASSIGNMENT_TEMPLATE_VERSION = 'md-asignacion-v1';

export const VEHICLE_ASSIGNMENT_TEMPLATE: AssignmentConditionItem[] = [
  // ── INTERIORES ─────────────────────────────────────────────────────────
  { id: 'unidad_de_luces', label: 'Unidad de luces', section: 'interiores' },
  { id: 'intermitentes', label: 'Intermitentes', section: 'interiores' },
  { id: 'calefaccion', label: 'Calefacción', section: 'interiores' },
  { id: 'elevadores', label: 'Elevadores', section: 'interiores' },
  { id: 'radio', label: 'Radio', section: 'interiores' },
  { id: 'reloj', label: 'Reloj', section: 'interiores' },
  { id: 'encendedor', label: 'Encendedor', section: 'interiores' },
  { id: 'espejo_retrovisor', label: 'Espejo retrovisor', section: 'interiores' },
  { id: 'ceniceros', label: 'Ceniceros', section: 'interiores' },
  { id: 'viseras', label: 'Viseras', section: 'interiores' },
  { id: 'tapetes', label: 'Tapetes', section: 'interiores' },
  { id: 'cabeceras', label: 'Cabeceras', section: 'interiores' },
  { id: 'tapete_cajuela', label: 'Tapete cajuela', section: 'interiores' },
  { id: 'manijas', label: 'Manijas', section: 'interiores' },
  { id: 'tablero', label: 'Tablero', section: 'interiores' },
  { id: 'guantera', label: 'Guantera', section: 'interiores' },
  { id: 'cinturones', label: 'Cinturones', section: 'interiores' },
  { id: 'claxon', label: 'Claxon', section: 'interiores' },

  // ── EXTERIORES ─────────────────────────────────────────────────────────
  { id: 'cuartos_de_luces', label: 'Cuartos de luces', section: 'exteriores' },
  { id: 'antena', label: 'Antena', section: 'exteriores' },
  { id: 'espejo_lateral', label: 'Espejo lateral', section: 'exteriores' },
  { id: 'parabrisas', label: 'Parabrisas', section: 'exteriores' },
  { id: 'medallon', label: 'Medallón', section: 'exteriores' },
  { id: 'emblemas', label: 'Emblemas', section: 'exteriores' },
  { id: 'llantas', label: 'Llantas (4)', section: 'exteriores' },
  { id: 'tapones_para_ruedas', label: 'Tapones para ruedas (4)', section: 'exteriores' },
  { id: 'molduras', label: 'Molduras', section: 'exteriores' },
  { id: 'tapon_de_gasolina', label: 'Tapón de gasolina', section: 'exteriores' },
  { id: 'alarma', label: 'Alarma', section: 'exteriores' },
  { id: 'biseles', label: 'Biseles', section: 'exteriores' },
  { id: 'calaveras', label: 'Calaveras', section: 'exteriores' },
  { id: 'hules_limpiadores', label: 'Hules limpiadores', section: 'exteriores' },
  { id: 'brazos_limpiadores', label: 'Brazos limpiadores', section: 'exteriores' },
  { id: 'defensas', label: 'Defensas', section: 'exteriores' },
  { id: 'salpicaderas', label: 'Salpicaderas', section: 'exteriores' },
  { id: 'cofre', label: 'Cofre', section: 'exteriores' },
  { id: 'toldo', label: 'Toldo', section: 'exteriores' },
  { id: 'cajuela', label: 'Cajuela', section: 'exteriores' },

  // ── ACCESORIOS ─────────────────────────────────────────────────────────
  { id: 'gato', label: 'Gato', section: 'accesorios' },
  { id: 'maneral_de_gato', label: 'Maneral de gato', section: 'accesorios' },
  { id: 'extintor', label: 'Extintor', section: 'accesorios' },
  { id: 'cables_pasacorriente', label: 'Cables pasacorriente', section: 'accesorios' },
  { id: 'llave_de_bujias', label: 'Llave de bujías', section: 'accesorios' },
  { id: 'llave_de_ruedas', label: 'Llave de ruedas', section: 'accesorios' },
  { id: 'desarmadores_planos', label: 'Desarmadores planos', section: 'accesorios' },
  { id: 'desarmadores_de_cruz', label: 'Desarmadores de cruz', section: 'accesorios' },
  { id: 'pinzas', label: 'Pinzas', section: 'accesorios' },
  { id: 'llaves_espanolas', label: 'Llaves españolas', section: 'accesorios' },
  { id: 'triangulos_de_seguridad', label: 'Triángulos de seguridad', section: 'accesorios' },
  { id: 'llanta_de_refaccion', label: 'Llanta de refacción c/rin', section: 'accesorios' },
];

/** Índice por id, para validar sin recorrer el arreglo en cada request. */
export const ASSIGNMENT_ITEM_IDS = new Set(VEHICLE_ASSIGNMENT_TEMPLATE.map((i) => i.id));

/**
 * Valida el JSONB `condition` de un acta: cada clave debe existir en la
 * plantilla y cada valor ser M/R/B. Devuelve la lista de problemas — vacía si
 * está bien. No completa lo que falta: un concepto sin calificar se queda sin
 * calificar, no se asume "Bueno".
 */
export function validateCondition(condition: unknown): string[] {
  if (condition == null) return [];
  if (typeof condition !== 'object' || Array.isArray(condition)) {
    return ['condition debe ser un objeto { concepto: "M"|"R"|"B" }'];
  }
  const problemas: string[] = [];
  for (const [k, v] of Object.entries(condition as Record<string, unknown>)) {
    if (!ASSIGNMENT_ITEM_IDS.has(k)) problemas.push(`concepto desconocido: "${k}"`);
    else if (v !== 'M' && v !== 'R' && v !== 'B') {
      problemas.push(`"${k}" tiene "${String(v)}"; se espera M, R o B`);
    }
  }
  return problemas;
}
