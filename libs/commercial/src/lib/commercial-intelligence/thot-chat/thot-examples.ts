/**
 * TC.4a — Ejemplos dorados semilla (few-shot). Dan valor desde el día 1 sin curar
 * nada; los de `commercial.thot_chat_examples` (curados) se suman/ranquean encima.
 * Enseñan vocabulario de negocio + qué tool elegir + estilo de respuesta. NO traen
 * cifras (esas siempre salen de tools en vivo).
 */

export interface ThotExample {
  profile?: 'admin' | 'portal' | 'vendor';
  question: string;
  tools: string[];
  /** Respuesta modelo (estilo + ruteo), sin números fijos. */
  answer: string;
  note?: string;
}

export const THOT_SEED_EXAMPLES: ThotExample[] = [
  {
    profile: 'admin',
    question: '¿Qué porcentaje representan las ventas en ruta?',
    tools: ['thot_flexible_aggregate'],
    answer:
      'En la venta real del ERP **no hay un canal etiquetado "ruta"**. El desglose por canal es **Tienda (mayoría)**, Crédito y Mayoreo (usá los share_pct de la tool). Si "ruta" te importa como métrica, hoy no está tagueada por separado (probablemente se registra como mostrador); se podría derivar por zona/vendedor.',
    note: 'No rajarse: probar flexible_aggregate por channel; si no existe el corte, mostrar lo que sí hay y aclarar. % de share_pct, no calculados.',
  },
  {
    profile: 'admin',
    question: 'Margen por categoría del último trimestre',
    tools: ['thot_margin_by_category'],
    answer:
      'Arrancá con la categoría más rentable en **negrita** y su margen %, luego las demás. Cerrá con una acción (ej: revisar precio/mezcla de la de menor margen). Citá período y fuente.',
  },
  {
    profile: 'admin',
    question: '¿Cómo va la marca Kinder?',
    tools: ['thot_resolve_entity', 'thot_flexible_aggregate'],
    answer:
      'Para una marca difusa primero resolvé la entidad y luego agregá revenue por marca (o top_products). Reportá su venta y participación (share_pct).',
    note: 'Entidad difusa → resolve_entity antes de consultar.',
  },
  {
    profile: 'vendor',
    question: '¿A quién le ofrezco y qué?',
    tools: ['thot_find_customer', 'thot_suggest_for_customer'],
    answer:
      'Resolvé el cliente en la cartera y traé los sugeridos del motor con su razón (rotación/whitespace/promo). Corto y accionable para la calle.',
  },
  {
    profile: 'portal',
    question: '¿Qué me conviene pedir?',
    tools: ['thot_my_recommendations'],
    answer:
      'Mostrá 4-5 sugeridos con su precio, cálido y breve, invitando a agregarlos al pedido. Nunca menciones márgenes ni otros clientes.',
  },
  {
    profile: 'admin',
    question: 'Top 10 productos más vendidos del mes',
    tools: ['thot_top_products'],
    answer:
      'Listá el ranking con unidades/revenue (negrita el #1). Aclarar período y que es venta real ERP. Cerrá con una lectura (concentración, marca dominante).',
    note: 'Venta real → top_products (ERP), no el pipeline B2B.',
  },
  {
    profile: 'admin',
    question: '¿Qué clientes están inactivos / dejaron de comprar?',
    tools: ['thot_inactive_customers'],
    answer:
      'Listá los clientes y sus días sin comprar; ordená por más críticos. Cerrá con acción (priorizar recuperación de los de mayor valor).',
  },
  {
    profile: 'admin',
    question: '¿Cuánto capital tengo parado en stock muerto?',
    tools: ['thot_dead_stock'],
    answer:
      'Arrancá con el **total de capital parado** y # de SKUs. Si hay desglose por almacén, mostralo. Acción: liquidar/dejar de surtir lo de mayor capital.',
  },
  {
    profile: 'admin',
    question: '¿Qué productos están por agotarse / necesito reabastecer?',
    tools: ['thot_out_of_stock_bestsellers', 'thot_low_stock'],
    answer:
      'Prioridad a best-sellers ya agotados (venta perdida) y luego stock bajo. Lista accionable de reposición.',
  },
  {
    profile: 'admin',
    question: 'Comparame las ventas de este mes contra el mes pasado',
    tools: ['thot_flexible_aggregate'],
    answer:
      'Usá una TABLA de comparación (período A vs B, variación %). Arrancá con el veredicto (subió/bajó X%). % desde la tool, no calculados.',
    note: 'Comparaciones → tabla; el contraste se lee mejor así.',
  },
  {
    profile: 'admin',
    question: 'Dame la clasificación ABC / qué productos son clase A',
    tools: ['thot_product_ranking', 'thot_flexible_aggregate'],
    answer:
      'Explicá A/B/C por participación de revenue y listá los A. Cerrá con foco (cuidar disponibilidad de los A).',
  },
  {
    profile: 'vendor',
    question: '¿A quién no le he vendido / quién está inactivo en mi ruta?',
    tools: ['thot_inactive_customers'],
    answer:
      'Listá los clientes de TU cartera sin compra reciente, los más críticos primero. Corto, para visitar hoy.',
  },
  {
    profile: 'vendor',
    question: '¿Hay stock de tal producto para surtir?',
    tools: ['thot_product_stock'],
    answer:
      'Resolvé el producto y dá el disponible en PH (sí/no + cantidad). No prometas lo que no hay en PH.',
  },
];

const STOP = new Set(['de','la','el','los','las','que','en','y','a','un','una','del','por','con','cual','cuanto','cuánto','como','cómo','para','mi','mis','me','es','son','hay','dame','muestra','muéstrame']);

function tokens(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9áéíóúñ ]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Ranking por solape de tokens (cheap, determinista; los embeddings llegan en TC.4b). */
export function rankExamples(question: string, pool: ThotExample[], profile: string, topK = 3): ThotExample[] {
  const qt = new Set(tokens(question));
  if (!qt.size) return [];
  return pool
    .filter((e) => !e.profile || e.profile === profile)
    .map((e) => {
      const et = tokens(e.question);
      const overlap = et.reduce((n, w) => n + (qt.has(w) ? 1 : 0), 0);
      return { e, score: overlap };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.e);
}

/** Fragmento few-shot para el system prompt. */
export function formatExamples(examples: ThotExample[]): string {
  if (!examples.length) return '';
  const blocks = examples.map((e, i) => {
    const lines = [`Ejemplo ${i + 1}:`, `- Pregunta: ${e.question}`, `- Tools: ${e.tools.join(', ') || '—'}`];
    if (e.answer) lines.push(`- Respuesta modelo: ${e.answer}`);
    if (e.note) lines.push(`- Nota: ${e.note}`);
    return lines.join('\n');
  });
  return `EJEMPLOS DE REFERENCIA (cómo resolver preguntas parecidas — adaptá a los datos reales que devuelvan las tools, no copies cifras):\n${blocks.join('\n\n')}`;
}
