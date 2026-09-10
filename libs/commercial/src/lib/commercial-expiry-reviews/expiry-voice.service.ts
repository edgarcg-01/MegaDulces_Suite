import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  AnthropicService,
  todayMx,
} from '@megadulces/platform-core';
import { LineUnit, ResolveHit } from './commercial-expiry-reviews.service';
import { palabrasDeBusqueda, normalizarFrase, nombreParaDecir } from './expiry-voice-match';

/**
 * **Asistente de voz del Control de Caducidades** (P2.7).
 *
 * El encargado recorre el anaquel con las manos ocupadas y el teléfono en el
 * bolsillo: *hablar* es más rápido que teclear seis campos. Habla, y el asistente
 * pregunta lo que falte hasta tener lo esencial para el renglón.
 *
 * **Reparto de responsabilidades — hereda ADR-016 (el motor decide, el agente
 * comunica) y el nivel co-piloto de ADR-020:**
 *
 *  - El **LLM** hace UNA sola cosa: convertir habla suelta en campos
 *    (`product_query`, `presentation`, `quantity`, `unit`, `expiry_date`…) y
 *    redactar la siguiente pregunta. Nada más.
 *  - **El producto lo resuelve el catálogo, no el modelo.** El LLM nunca ve ni
 *    devuelve un `product_id`: dice el NOMBRE que escuchó y esta clase lo busca
 *    en `public.products`. Si hay varios, se devuelven candidatos para que el
 *    humano elija. Un LLM inventando UUIDs mete mercancía equivocada al FEFO.
 *  - **No escribe nada.** Devuelve los campos; el renglón lo agrega la persona
 *    desde la pantalla, viendo lo que entendió. La voz llena el formulario, no
 *    lo manda.
 *
 * La transcripción la hace el endpoint que ya existe
 * (`POST /commercial/intelligence/thot/transcribe`, Groq Whisper en español):
 * este servicio recibe **texto**, no audio.
 */

const CLAUDE_MODEL = process.env.EXPIRY_VOICE_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 20_000;
/** Candidatos que se le ofrecen al operador para desempatar. Más es ruido hablado. */
const MAX_CANDIDATES = 6;
/** Una caducidad a más de 5 años es error de dictado ("2062"), no un dato. */
const MAX_YEARS_AHEAD = 5;

export interface VoiceSlots {
  /** Lo que el operador dijo del producto ("paleta payaso chica"). */
  product_query?: string | null;
  /** Presentación dicha ("bolsa de 24", "caja", "granel"). Ayuda a desempatar. */
  presentation?: string | null;
  /** Resuelto por catálogo — el LLM NO lo escribe. */
  product_id?: string | null;
  product_name?: string | null;
  sku?: string | null;
  quantity?: number | null;
  unit?: LineUnit | null;
  /** YYYY-MM-DD. */
  expiry_date?: string | null;
  condition?: 'bueno' | 'regular' | 'malo' | null;
  location?: string | null;
  observations?: string | null;
  action?: string | null;
}

export interface VoiceTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface VoiceIntakeInput {
  /** Lo que se transcribió del audio (o se tecleó). */
  transcript: string;
  /** Lo ya reunido en turnos anteriores. */
  slots?: VoiceSlots;
  history?: VoiceTurn[];
}

export interface VoiceIntakeResult {
  /** Lo que el asistente responde (se muestra y se puede leer en voz alta). */
  reply: string;
  slots: VoiceSlots;
  /** Cuando el nombre dicho coincide con varios productos: que elija el humano. */
  candidates: ResolveHit[];
  /** Campos esenciales que faltan: 'producto' | 'cantidad' | 'caducidad'. */
  missing: string[];
  /** true = ya hay producto + cantidad + caducidad; la pantalla puede prellenar. */
  ready: boolean;
  /** Se degradó por falta de ANTHROPIC_API_KEY (la pantalla lo dice claro). */
  degraded?: boolean;
}

/** El del service hermano no se exporta; se repite acá a propósito (una línea). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS: LineUnit[] = ['caja', 'pieza', 'bulto', 'kg'];
const CONDITIONS = ['bueno', 'regular', 'malo'];

@Injectable()
export class ExpiryVoiceService {
  private readonly logger = new Logger(ExpiryVoiceService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly anthropic: AnthropicService,
  ) {}

  async intake(input: VoiceIntakeInput): Promise<VoiceIntakeResult> {
    const transcript = String(input.transcript || '').trim();
    if (!transcript) throw new BadRequestException('transcript vacío');
    if (transcript.length > 1000) throw new BadRequestException('transcript demasiado largo');

    const prev: VoiceSlots = { ...(input.slots || {}) };

    if (!this.anthropic.hasApiKey) {
      // Sin key no se inventa una conversación: se dice qué falta configurar y
      // la pantalla sigue sirviendo por escaneo/teclado (el camino no se bloquea).
      this.logger.warn('ANTHROPIC_API_KEY ausente — asistente de voz degradado.');
      return {
        reply: 'El asistente de voz no está configurado en este servidor (falta ANTHROPIC_API_KEY). Podés capturar escaneando o escribiendo.',
        slots: prev,
        candidates: [],
        missing: this.missingOf(prev),
        ready: false,
        degraded: true,
      };
    }

    // 1) El LLM extrae campos y redacta la siguiente pregunta. No resuelve producto.
    let heard: VoiceSlots & { reply?: string };
    try {
      heard = await this.extract(transcript, prev, input.history || []);
    } catch (e: any) {
      this.logger.warn(`extract() falló: ${e?.message || e}`);
      return {
        reply: 'No te entendí bien, ¿me lo repetís?',
        slots: prev,
        candidates: [],
        missing: this.missingOf(prev),
        ready: false,
      };
    }

    const slots = this.merge(prev, heard);

    // 2) El producto lo resuelve el catálogo. Si el operador nombró otro producto,
    //    el `product_id` anterior deja de valer: manda lo último que dijo.
    let candidates: ResolveHit[] = [];
    if (heard.product_query && heard.product_query !== prev.product_query) {
      slots.product_id = null;
      slots.product_name = null;
      slots.sku = null;
    }
    if (!slots.product_id && slots.product_query) {
      const found = await this.findProducts(slots.product_query, slots.presentation || null);
      if (found.length === 1) {
        this.applyProduct(slots, found[0]);
      } else if (found.length > 1) {
        candidates = found;
      }
    }

    // 3) La respuesta la manda el estado real, no el humor del modelo: si falta
    //    algo, se pregunta por eso; si hay que desempatar, se pide elegir.
    const missing = this.missingOf(slots);
    const reply = this.composeReply(slots, candidates, missing, heard.reply);

    return { reply, slots, candidates, missing, ready: missing.length === 0 };
  }

  /**
   * El operador tocó un candidato: se fija y se sigue la conversación. Va por el
   * mismo camino que el resolvedor de escaneo para que la pantalla reciba lo
   * mismo (presentación, ubicación, unidad del código).
   */
  async pickProduct(slots: VoiceSlots, productId: string): Promise<VoiceIntakeResult> {
    // Validar ANTES de consultar. Un id que no es UUID llegaba crudo a Postgres
    // (`invalid input syntax for type uuid`) y salía como **500** en vez del 400
    // que es. Lo cazó el smoke corriendo contra la API real, no la revisión.
    if (!UUID_REGEX.test(String(productId || '')))
      throw new BadRequestException('product_id inválido (UUID)');
    const out: VoiceSlots = { ...slots };
    const hit = await this.productById(productId);
    if (!hit) throw new BadRequestException('product_id no encontrado');
    this.applyProduct(out, hit);
    const missing = this.missingOf(out);
    return { reply: this.composeReply(out, [], missing), slots: out, candidates: [], missing, ready: missing.length === 0 };
  }

  // ───── LLM: habla → campos ─────

  private async extract(transcript: string, prev: VoiceSlots, history: VoiceTurn[]) {
    const hoy = todayMx();
    const system = `Sos el asistente de Control de Caducidades de Mega Dulces (distribuidora de dulces en México). Un encargado de tienda te habla mientras revisa el anaquel y quiere dar de alta un producto próximo a vencer o ya vencido.

HOY ES ${hoy} (America/Mexico_City). Zona: México.

Tu ÚNICO trabajo es (a) extraer los campos de lo que dijo y (b) redactar la siguiente pregunta, corta y hablada.

CAMPOS:
- product_query: el nombre del producto TAL COMO lo dijo ("paleta payaso", "mazapán de la rosa"). NO inventes SKUs ni códigos.
- presentation: la presentación si la dijo ("bolsa de 24", "caja", "granel", "de 500 gramos").
- quantity: número.
- unit: una de caja | pieza | bulto | kg. "cajas"→caja, "piezas"/"sueltas"→pieza, "bultos"/"costales"→bulto, "kilos"→kg.
- expiry_date: la caducidad en formato YYYY-MM-DD. Convertí lo que diga a fecha absoluta usando HOY. Si sólo dijo mes y año ("octubre del 26"), usá el ÚLTIMO día de ese mes. Si no dijo año, elegí el próximo que caiga en el futuro.
- condition: bueno | regular | malo — SOLO si habló del estado FÍSICO (roto, húmedo, aplastado). El estado NO se deduce de la fecha.
- location: dónde está ("anaquel 3", "bodega", "exhibidor de caja").
- observations: cualquier detalle suelto ("las bolsas están grasosas").
- action: qué hacer ("retirar", "promocionar", "devolver a proveedor").

REGLAS:
1. Devolvé SOLO los campos que el operador dijo en ESTE mensaje. Lo que no dijo, omitilo — no lo rellenes con suposiciones ni lo repitas de antes.
2. Nunca inventes un producto que no nombró.
3. ESENCIALES para el renglón: producto, cantidad y caducidad. Si falta alguno, tu "reply" pide EL QUE FALTA, uno por vez, en una frase corta.
4. Hablás español mexicano, directo y amable. Frases de una línea: esto se escucha, no se lee.
5. Si el mensaje no tiene nada que ver con dar de alta caducidades, respondé eso en "reply" y no llenes campos.

Ya reunido de turnos anteriores (contexto, NO lo repitas en tu salida):
${JSON.stringify(this.publicSlots(prev))}

Respondé SIEMPRE invocando la tool "capturar_caducidad".`;

    const messages = [
      ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user' as const, content: transcript },
    ];

    const json: any = await this.anthropic.messages(
      {
        model: CLAUDE_MODEL,
        maxTokens: 1024,
        system,
        messages,
        tools: [
          {
            name: 'capturar_caducidad',
            description: 'Campos escuchados en este mensaje + la siguiente pregunta para el operador.',
            input_schema: {
              type: 'object',
              properties: {
                reply: { type: 'string', description: 'Lo que le decís al operador. Una frase corta, hablada.' },
                product_query: { type: 'string', description: 'Nombre del producto tal como lo dijo.' },
                presentation: { type: 'string' },
                quantity: { type: 'number' },
                unit: { type: 'string', enum: UNITS },
                expiry_date: { type: 'string', description: 'YYYY-MM-DD' },
                condition: { type: 'string', enum: CONDITIONS },
                location: { type: 'string' },
                observations: { type: 'string' },
                action: { type: 'string' },
              },
              required: ['reply'],
            },
          },
        ],
        toolChoice: { type: 'tool', name: 'capturar_caducidad' },
      },
      { timeoutMs: TIMEOUT_MS },
    );

    const toolUse = (json?.content || []).find((c: any) => c.type === 'tool_use');
    if (!toolUse) throw new Error('el modelo no devolvió tool_use');
    return (toolUse.input || {}) as VoiceSlots & { reply?: string };
  }

  // ───── catálogo: nombre dicho → producto (determinista) ─────

  /**
   * Busca por palabras, no por la frase completa: el habla trae relleno ("una
   * paleta payaso de las chicas") y un `ilike '%frase%'` no pega nunca. Cada
   * palabra de ≥3 letras tiene que aparecer en nombre o SKU.
   */
  /**
   * Nombre dicho → productos del catálogo, **por parecido, no por coincidencia
   * exacta**.
   *
   * La primera versión exigía que TODAS las palabras aparecieran en el nombre, y
   * eso fallaba con el habla real. Medido contra los 11,197 productos: de 8
   * frases de prueba, **4 devolvían NADA** — *"tengo tres cajas de gansito"*
   * (relleno del habla), *"chicle motita"* (el operador agrega la categoría que
   * el catálogo no usa), *"bubulubu de fresa"* y *"sabritas adobadas"* (el sabor
   * o la marca no están en el nombre). Una sola palabra ausente mataba la
   * búsqueda entera. Con ranking, las 8 devuelven algo útil.
   *
   * Cómo puntúa, en este orden:
   *  1. `hits` — cuántas palabras dichas aparecen en el nombre. Es lo que más
   *     pesa: "coca cola 600" con 3 de 3 le gana a cualquier parecido difuso.
   *  2. `wsim` — `word_similarity` de pg_trgm entre la frase y el nombre, que
   *     tolera plural, diminutivo y dedazo ("motita" pega con "MOTO C/CHICLE").
   *  3. Nombre más corto — entre "PULPARINDO 20PZ" y una promo de tres renglones,
   *     el corto es el producto y el largo es el paquete.
   *
   * Umbral de entrada: al menos una palabra presente **o** `wsim > 0.5`. Sin eso
   * la lista se llena de ruido y el operador pierde más tiempo descartando.
   */
  private async findProducts(query: string, presentation: string | null): Promise<ResolveHit[]> {
    const words = palabrasDeBusqueda(query);
    const frase = normalizarFrase(query);
    if (!words.length && frase.length < 3) return [];
    const userId = this.tenantCtx.get()?.userId;

    return this.tk.run(async (trx) => {
      // Scoping de promotor de marca propia: solo sus marcas (igual que el buscador).
      const brandIds = userId
        ? (await trx('commercial.promoter_brands').where('user_id', userId).select('brand_id')).map((r: any) => r.brand_id)
        : [];

      // `translate` y no `unaccent()`: la extensión existe pero **no siempre en el
      // mismo schema** — en esta DB vive en `identity`, no en `public`, así que
      // `public.unaccent(...)` tronaba. Con translate no hay dependencia de
      // extensión ni de search_path para quitar acentos (nombres en español).
      const SIN_ACENTOS = `translate(lower(p.nombre), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')`;
      const ranked = `
        WITH cand AS (
          SELECT p.id, p.sku, p.nombre, p.barcode, p.brand_id, b.nombre AS brand_name,
                 p.unit_sale, p.factor_sale, p.location,
                 (SELECT count(*) FROM unnest(?::text[]) w
                   WHERE ${SIN_ACENTOS} LIKE '%' || w || '%')::int AS hits,
                 word_similarity(?, ${SIN_ACENTOS}) AS wsim
            FROM public.products p
            LEFT JOIN public.brands b ON b.id = p.brand_id
           WHERE p.deleted_at IS NULL
             AND (? = 0 OR p.brand_id = ANY(?::uuid[]))
             AND (
               EXISTS (SELECT 1 FROM unnest(?::text[]) w
                        WHERE ${SIN_ACENTOS} LIKE '%' || w || '%')
               OR word_similarity(?, ${SIN_ACENTOS}) > 0.5
             )
        )
        SELECT * FROM cand
         ORDER BY hits DESC, wsim DESC, length(nombre) ASC
         LIMIT ?`;

      // Sin `word_similarity` (pg_trgm ausente) la consulta lanza. En vez de
      // tumbar la captura entera, se degrada a ranking por palabras: peor
      // tolerancia al dedazo, pero el operador sigue trabajando.
      const soloHits = `
        WITH cand AS (
          SELECT p.id, p.sku, p.nombre, p.barcode, p.brand_id, b.nombre AS brand_name,
                 p.unit_sale, p.factor_sale, p.location,
                 (SELECT count(*) FROM unnest(?::text[]) w
                   WHERE ${SIN_ACENTOS} LIKE '%' || w || '%')::int AS hits
            FROM public.products p
            LEFT JOIN public.brands b ON b.id = p.brand_id
           WHERE p.deleted_at IS NULL
             AND (? = 0 OR p.brand_id = ANY(?::uuid[]))
             AND EXISTS (SELECT 1 FROM unnest(?::text[]) w
                          WHERE ${SIN_ACENTOS} LIKE '%' || w || '%')
        )
        SELECT * FROM cand WHERE hits > 0
         ORDER BY hits DESC, length(nombre) ASC
         LIMIT ?`;

      const scope = brandIds.length ? 1 : 0;
      const lim = MAX_CANDIDATES * 3;
      let rows: any;
      try {
        rows = await trx.raw(ranked, [words, frase, scope, brandIds, words, frase, lim]);
      } catch (e: any) {
        this.logger.warn(`búsqueda difusa no disponible (${e?.message || e}); ranking por palabras.`);
        rows = await trx.raw(soloHits, [words, scope, brandIds, words, lim]);
      }

      const cands: any[] = rows.rows || [];
      if (!cands.length) return [];

      // La presentación dicha ("de 24", "granel") desempata sin excluir: se pide
      // como bonus, no como filtro — si filtrara, un sinónimo dejaría 0 resultados.
      const presTokens = palabrasDeBusqueda(presentation || '');
      const scored = cands.map((r) => {
        const hay = `${r.nombre || ''} ${r.unit_sale || ''} ${r.factor_sale || ''}`.toLowerCase();
        return { r, bonus: presTokens.filter((t) => hay.includes(t)).length };
      });
      const best = Math.max(0, ...scored.map((x) => x.bonus));
      const pool = best > 0 ? scored.filter((x) => x.bonus === best) : scored;

      return pool.slice(0, MAX_CANDIDATES).map((x) => this.toHit(x.r));
    });
  }

  private async productById(productId: string): Promise<ResolveHit | null> {
    return this.tk.run(async (trx) => {
      const r = await trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .where('p.id', productId)
        .whereNull('p.deleted_at')
        .first(
          'p.id', 'p.sku', 'p.nombre', 'p.barcode', 'p.brand_id', 'b.nombre as brand_name',
          'p.unit_sale', 'p.factor_sale', 'p.location',
        );
      return r ? this.toHit(r) : null;
    });
  }

  private toHit(r: any): ResolveHit {
    return {
      id: r.id,
      sku: r.sku ?? null,
      nombre: r.nombre ?? null,
      brand_id: r.brand_id ?? null,
      brand_name: r.brand_name ?? null,
      barcode: r.barcode ?? null,
      unit_sale: r.unit_sale ?? null,
      factor_sale: r.factor_sale != null ? Number(r.factor_sale) : null,
      location: r.location ?? null,
      scanned_unit: null, // por voz no hay etiqueta leída
      factor: null,
      unit_hint: null,
    };
  }

  private applyProduct(slots: VoiceSlots, hit: ResolveHit): void {
    slots.product_id = hit.id;
    slots.product_name = hit.nombre;
    slots.sku = hit.sku;
    if (!slots.location && hit.location) slots.location = hit.location;
  }

  // ───── helpers ─────

  /** Los campos que el LLM puede ver: sin ids internos. */
  private publicSlots(s: VoiceSlots) {
    return {
      producto: s.product_name || s.product_query || null,
      presentacion: s.presentation || null,
      cantidad: s.quantity ?? null,
      unidad: s.unit || null,
      caducidad: s.expiry_date || null,
      estado_fisico: s.condition || null,
      ubicacion: s.location || null,
    };
  }

  /**
   * Mezcla lo escuchado sobre lo ya reunido, **validando**: el modelo puede
   * devolver una unidad inventada o una fecha imposible, y eso terminaría en el
   * sub-ledger FEFO. Lo que no pasa validación se descarta (se vuelve a preguntar).
   */
  private merge(prev: VoiceSlots, heard: VoiceSlots): VoiceSlots {
    const out: VoiceSlots = { ...prev };
    if (heard.product_query) { out.product_query = String(heard.product_query).slice(0, 120); }
    if (heard.presentation) out.presentation = String(heard.presentation).slice(0, 60);
    if (heard.quantity != null && Number.isFinite(Number(heard.quantity)) && Number(heard.quantity) > 0)
      out.quantity = Number(heard.quantity);
    if (heard.unit && UNITS.includes(heard.unit)) out.unit = heard.unit;
    const ymd = this.validDate(heard.expiry_date);
    if (ymd) out.expiry_date = ymd;
    if (heard.condition && (CONDITIONS as string[]).includes(heard.condition)) out.condition = heard.condition;
    if (heard.location) out.location = String(heard.location).slice(0, 120);
    if (heard.observations) out.observations = String(heard.observations).slice(0, 300);
    if (heard.action) out.action = String(heard.action).slice(0, 200);
    return out;
  }

  /** YYYY-MM-DD real y dentro de un rango creíble; si no, se ignora. */
  private validDate(v: unknown): string | null {
    const s = String(v || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null; // 31 de febrero
    const thisYear = Number(todayMx().slice(0, 4));
    // Hacia atrás se acepta (dar de alta lo YA vencido es medio sentido de la hoja);
    // hacia adelante, 5 años es el techo de lo creíble en dulcería.
    if (y < thisYear - 5 || y > thisYear + MAX_YEARS_AHEAD) return null;
    return s;
  }

  private missingOf(s: VoiceSlots): string[] {
    const out: string[] = [];
    if (!s.product_id) out.push('producto');
    if (s.quantity == null || s.quantity <= 0) out.push('cantidad');
    if (!s.expiry_date) out.push('caducidad');
    return out;
  }

  /**
   * La última palabra la tiene el estado, no el modelo: si falta un esencial se
   * pregunta por ése, y si hay empate se pide elegir. El `reply` del LLM se usa
   * sólo cuando no hay nada pendiente que reclamar (ahí aporta el tono).
   */
  private composeReply(slots: VoiceSlots, candidates: ResolveHit[], missing: string[], llmReply?: string): string {
    // Un bot de voz que dice "encontré 5, ¿cuál es?" obliga a mirar la pantalla.
    // Se NOMBRAN los primeros: así el operador contesta sin dejar de contar.
    if (candidates.length > 1) {
      const refs = candidates.slice(0, 3).map((c) => nombreParaDecir(c.nombre || c.sku));
      const cola = candidates.length > 3 ? `, o alguno de los otros ${candidates.length - 3}` : '';
      return `No lo tengo exacto. ¿Es ${refs.join(', ')}${cola}?`;
    }
    if (!slots.product_id && slots.product_query)
      return `No encontré nada parecido a "${slots.product_query}". Escaneá el código, o decímelo con otra palabra.`;
    if (missing.includes('producto')) return llmReply || '¿Qué producto es?';
    if (missing.includes('cantidad')) return `¿Cuántas ${slots.unit ? this.plural(slots.unit) : 'piezas'} de ${slots.product_name}?`;
    if (missing.includes('caducidad')) return `¿Qué fecha de caducidad marca el ${slots.product_name}?`;
    const qty = `${slots.quantity} ${this.plural(slots.unit || 'pieza')}`;
    return `Listo: ${qty} de ${slots.product_name}, caduca ${this.human(slots.expiry_date!)}. Revisalo y agregá el renglón.`;
  }

  private plural(u: LineUnit): string {
    return u === 'caja' ? 'cajas' : u === 'bulto' ? 'bultos' : u === 'kg' ? 'kilos' : 'piezas';
  }

  private human(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  }
}
