import {
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { LlmExtractorService } from '@megadulces/platform-core';
import { CloudinaryService } from '@megadulces/platform-core';
import {
  AiProductMatcherService,
  MatchResponse,
} from '@megadulces/platform-core';

export interface TicketExtractResult {
  ticket_url: string;
  ticket_public_id: string;
  match: MatchResponse;
  /** HV.2 — espacios etiquetados SIN producto (quiebre de stock). Solo en el flujo de exhibidor. */
  empty_slots?: string[];
}

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — Anthropic vision límite
/**
 * Deadline global del endpoint. Cloudinary + vision (30s) + Voyage (10s×3≈36s)
 * se apilan; sin tope el request puede colgar >2min y el navegador móvil lo
 * cancela → 502. Con esto respondemos 504 limpio (el cliente reintenta).
 */
const PIPELINE_DEADLINE_MS = 45_000;

/**
 * Fase V — Pipeline OCR de ticket → productos del catálogo.
 *
 * Flujo:
 *   1. Sube la imagen del ticket a Cloudinary (folder `tickets/{tenant}/{user}`).
 *   2. Claude Haiku 4.5 vision lee el ticket → líneas de producto estructuradas.
 *   3. `AiProductMatcherService.matchExtractedItems()` matchea cada línea contra
 *      el catálogo (Voyage embeddings + KNN + rerank). Devuelve product_ids con
 *      confidence (high/medium/low/no_match).
 *
 * El frontend usa esto en el paso "foto del ticket" del wizard del vendedor:
 * pre-llena el campo `productosMarcados` del exhibidor con los `product_id` de
 * alta confianza, y deja los de baja confianza marcados como pendientes de
 * revisión manual.
 */
@Injectable()
export class TicketExtractorService {
  private readonly logger = new Logger(TicketExtractorService.name);

  constructor(
    private readonly cloudinary: CloudinaryService,
    private readonly llm: LlmExtractorService,
    private readonly matcher: AiProductMatcherService,
  ) {}

  async extractAndMatch(
    file: Express.Multer.File,
    tenantId: string,
    userId: string,
  ): Promise<TicketExtractResult> {
    if (!file) throw new BadRequestException('file requerido');
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `mimetype no soportado: ${file.mimetype}. Aceptados: ${[...ACCEPTED_MIME_TYPES].join(', ')}`,
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `Imagen excede ${MAX_BYTES} bytes (recibido ${file.size}). Reducí calidad o tamaño.`,
      );
    }

    // Tope global: corta el pipeline a los 45s con un 504 limpio en vez de
    // dejar al vendedor esperando >2min hasta que el navegador cancele (502).
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new GatewayTimeoutException(
              'La lectura del ticket tardó demasiado. Revisá tu conexión y reintentá.',
            ),
          ),
        PIPELINE_DEADLINE_MS,
      );
    });
    const pipeline = this.runPipeline(file, tenantId, userId);
    // Si el deadline gana la carrera, el pipeline sigue corriendo en background;
    // este handler evita un unhandledRejection cuando termine por su cuenta.
    pipeline.catch(() => undefined);
    try {
      return await Promise.race([pipeline, timeout]);
    } finally {
      clearTimeout(deadline!);
    }
  }

  /**
   * HV.2 — Foto de EXHIBIDOR → productos del catálogo (sugerencias para pre-poblar
   * la lista de la captura). Mismo pipeline que el ticket, pero: (1) vision lee
   * productos del ANAQUEL (no líneas de recibo), (2) matchea contra el corpus
   * `catalog` (el que usan captures/planograma), (3) carpeta `exhibitions/`.
   *
   * Gate HV.0: rinde ~24-29% en este catálogo → SUGERENCIAS a confirmar, no marca
   * definitiva. El frontend las mete como items con confidence, el vendedor revisa.
   */
  async extractExhibitionAndMatch(
    file: Express.Multer.File,
    tenantId: string,
    userId: string,
  ): Promise<TicketExtractResult> {
    if (!file) throw new BadRequestException('file requerido');
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `mimetype no soportado: ${file.mimetype}. Aceptados: ${[...ACCEPTED_MIME_TYPES].join(', ')}`,
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `Imagen excede ${MAX_BYTES} bytes (recibido ${file.size}). Reducí calidad o tamaño.`,
      );
    }
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new GatewayTimeoutException(
              'La lectura de la foto tardó demasiado. Revisá tu conexión y reintentá.',
            ),
          ),
        PIPELINE_DEADLINE_MS,
      );
    });
    const pipeline = this.runExhibitionPipeline(file, tenantId, userId);
    pipeline.catch(() => undefined);
    try {
      return await Promise.race([pipeline, timeout]);
    } finally {
      clearTimeout(deadline!);
    }
  }

  private async runExhibitionPipeline(
    file: Express.Multer.File,
    tenantId: string,
    userId: string,
  ): Promise<TicketExtractResult> {
    const t0 = Date.now();
    const folder = `exhibitions/${tenantId}/${userId}`;
    const uploaded = await this.cloudinary.uploadImage(file, folder);
    const base64 = file.buffer.toString('base64');
    const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    this.logger.log(
      `[exhibición] START tenant=${tenantId} user=${userId} img=${(file.size / 1024).toFixed(0)}KB ${mediaType} → ${uploaded.public_id} (+${Date.now() - t0}ms)`,
    );

    const { products: items, emptySlots } = await this.llm.extractFromExhibitionImage(base64, mediaType);
    // LOG DIAGNÓSTICO: qué LEYÓ la visión (para ver si el problema es lectura o match).
    this.logger.log(
      `[exhibición] vision leyó ${items.length} producto(s): ${items.map((i) => `"${i.normalized}"×${i.quantity}`).join(', ') || '(NINGUNO)'} (+${Date.now() - t0}ms)`,
    );
    if (emptySlots.length) {
      this.logger.log(`[exhibición] espacios VACÍOS (quiebre): ${emptySlots.join(', ')}`);
    }
    if (items.length === 0) {
      this.logger.warn(
        `[exhibición] vision devolvió 0 productos — foto no es anaquel legible, ilegible, o sin ANTHROPIC_API_KEY. tenant=${tenantId}`,
      );
    }

    // Corpus 'catalog' (el de captures/planograma), NO 'active' (que es del ticket ERP).
    const match = await this.matcher.matchExtractedItems(items, t0);
    // LOG DIAGNÓSTICO: qué DECIDIÓ el matcher por cada item (raw → match + confidence + score).
    for (const it of match.items) {
      const s = it.suggested;
      this.logger.log(
        `[exhibición]   "${it.raw}" → ${s?.product_name ? `${s.product_name} [${s.confidence}${s.score != null ? ` ${s.score}` : ''}]${s.autoConfirm ? ' ✓auto' : ''}` : 'SIN MATCH'}`,
      );
    }
    // Corpus 'catalog' identifica por product_id (UUID), NO por sku (que queda null).
    const matched = match.items.filter((i) => i.suggested?.product_id || i.suggested?.sku).length;
    const auto = match.items.filter((i) => i.suggested?.autoConfirm).length;
    this.logger.log(
      `[exhibición] RESULTADO: leídos=${items.length} matcheados=${matched} autoConfirm=${auto} sin_match=${match.items.length - matched} vacíos=${emptySlots.length} (${match.meta.elapsed_ms}ms total)`,
    );
    return { ticket_url: uploaded.secure_url, ticket_public_id: uploaded.public_id, match, empty_slots: emptySlots };
  }

  private async runPipeline(
    file: Express.Multer.File,
    tenantId: string,
    userId: string,
  ): Promise<TicketExtractResult> {
    const t0 = Date.now();

    // 1) Upload Cloudinary primero — así si la AI falla la foto queda subida y
    //    el frontend puede mostrarla o reintentar la extracción sin re-subir.
    const folder = `tickets/${tenantId}/${userId}`;
    const uploaded = await this.cloudinary.uploadImage(file, folder);
    this.logger.log(
      `[ticket] uploaded ${uploaded.public_id} (+${Date.now() - t0}ms)`,
    );

    // 2) Claude vision → items extraídos del ticket.
    //    Pasamos el buffer original (no el comprimido de Cloudinary) para no
    //    perder resolución; el límite de 8MB ya fue validado.
    const base64 = file.buffer.toString('base64');
    const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    const items = await this.llm.extractFromTicketImage(base64, mediaType);
    this.logger.log(
      `[ticket] vision extrajo ${items.length} líneas (+${Date.now() - t0}ms)`,
    );

    // 3) Match contra el set activo ERP (inventory.products_active, 6489) por sku.
    //    Aislado del corpus catalog (1199) que usan captures y route-control.
    const match = await this.matcher.matchExtractedItems(items, t0, 'active');
    this.logger.log(
      `[ticket] match completo: ${match.items.length} items, ` +
        `${match.items.filter((i) => i.suggested?.autoConfirm).length} autoConfirm ` +
        `(${match.meta.elapsed_ms}ms total)`,
    );

    return {
      ticket_url: uploaded.secure_url,
      ticket_public_id: uploaded.public_id,
      match,
    };
  }
}
