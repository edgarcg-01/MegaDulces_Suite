import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { LlmExtractorService } from '@megadulces/platform-core';
import { CloudinaryService } from '@megadulces/platform-core';
import {
  AiProductMatcherService,
  MatchResponse,
} from '../ai-product-matcher/ai-product-matcher.service';

export interface TicketExtractResult {
  ticket_url: string;
  ticket_public_id: string;
  match: MatchResponse;
}

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB — Anthropic vision límite

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

    // 3) Match contra catálogo.
    const match = await this.matcher.matchExtractedItems(items, t0);
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
