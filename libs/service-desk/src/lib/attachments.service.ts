/**
 * `[MS.2.4]` Adjuntos de la Mesa de Servicio: validar por FIRMA, subir al bucket privado, y firmar la URL
 * en cada lectura.
 *
 * Orden que se respeta (y por qué):
 *  1. `preparar` valida TODO antes de tocar el bucket: un adjunto malo no deja huérfanos de los buenos.
 *  2. La subida va FUERA de la transacción de base de datos (no se retiene una conexión por red lenta).
 *  3. Si la transacción falla después, `descartar` borra del bucket lo que ya se subió.
 *
 * `ObjectStorageService.putFile` NO sirve acá: guarda el Content-Type DECLARADO. Se usa `putBuffer` con el
 * tipo que detectó la firma (ver `domain/attachment-signature.ts`).
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { SdAttachmentInput } from '@megadulces/contracts';
import { ObjectStorageService } from '@megadulces/platform-core';
import { sanitizarNombre, validarAdjunto, type AdjuntoValido } from './domain/attachment-signature';

export const MAX_ADJUNTOS_POR_ENVIO = 5;

export interface AdjuntoPreparado {
  file_name: string;
  adjunto: AdjuntoValido;
}

export interface AdjuntoSubido {
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
}

@Injectable()
export class ServiceDeskAttachmentsService {
  private readonly logger = new Logger(ServiceDeskAttachmentsService.name);

  constructor(private readonly storage: ObjectStorageService) {}

  /** Valida y decodifica. Lanza 400 con el motivo exacto del primer adjunto inválido. */
  preparar(entradas: SdAttachmentInput[] | undefined, maxBytes: number): AdjuntoPreparado[] {
    const lista = entradas ?? [];
    if (!Array.isArray(lista)) throw new BadRequestException('attachments debe ser una lista');
    if (lista.length > MAX_ADJUNTOS_POR_ENVIO) {
      throw new BadRequestException(`Máximo ${MAX_ADJUNTOS_POR_ENVIO} archivos por envío`);
    }
    return lista.map((e, i) => {
      const r = validarAdjunto(e?.file_base64, maxBytes);
      if (!r.ok) throw new BadRequestException(`Archivo ${i + 1}: ${r.detalle}`);
      return { file_name: sanitizarNombre(e?.file_name, r.adjunto.contentType), adjunto: r.adjunto };
    });
  }

  /** Sube al bucket. Si uno falla, borra los que ya se subieron y propaga el error. */
  async subir(preparados: AdjuntoPreparado[], carpeta: string): Promise<AdjuntoSubido[]> {
    const subidos: AdjuntoSubido[] = [];
    try {
      for (const p of preparados) {
        const { key } = await this.storage.putBuffer(p.adjunto.buffer, p.adjunto.contentType, carpeta, p.file_name);
        subidos.push({ storage_key: key, file_name: p.file_name, content_type: p.adjunto.contentType, size_bytes: p.adjunto.sizeBytes });
      }
    } catch (e) {
      await this.descartar(subidos);
      throw e;
    }
    return subidos;
  }

  /** Borra del bucket lo subido cuando la transacción de base de datos no llegó a confirmarse. Nunca lanza. */
  async descartar(subidos: AdjuntoSubido[]): Promise<void> {
    for (const s of subidos) {
      try {
        await this.storage.remove(s.storage_key);
      } catch (e) {
        this.logger.warn(`No se pudo borrar ${s.storage_key} del bucket tras un fallo: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** URL prefirmada fresca. Vacía si el bucket no está configurado (no se inventa un enlace). */
  firmar(key: string): Promise<string> {
    return this.storage.signedUrl(key, 600);
  }
}
