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
 * tipo que detectó la firma (ver `platform-core/storage/attachment-signature.ts`).
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { SdAttachmentInput, SdLinkInput } from '@megadulces/contracts';
import { ObjectStorageService, sanitizarNombre, validarAdjunto, type AdjuntoValido } from '@megadulces/platform-core';

import { nombreDeAdjunto } from './domain/nombre-adjunto';
import { MAX_ENLACES_POR_ENVIO, normalizarEnlaceGoogle, type TipoEnlace } from './domain/enlaces';

export const MAX_ADJUNTOS_POR_ENVIO = 5;
/** `[MS.ADJ.1.3]` Suma máxima de bytes reales por envío (D9, aprobado 2026-10-22). En base64 son ~29 MB: cabe en el cuerpo de 32 MB. */
export const MAX_TOTAL_ADJUNTOS_BYTES = 22 * 1048576;

export interface AdjuntoPreparado {
  file_name: string;
  adjunto: AdjuntoValido;
}

export interface EnlacePreparado {
  url: string;
  kind: TipoEnlace;
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
    // `[MS.ADJ.1.3]` Tope del ENVÍO completo, ANTES de decodificar: 5 × 8 MB = 40 MB reales (~53 MB en base64) rebasaban el
    // límite de 32 MB del cuerpo y el usuario recibía un 413 genérico en vez de este mensaje. Se estima desde el largo del base64.
    const estimado = lista.reduce((s, e) => s + Math.floor(((typeof e?.file_base64 === 'string' ? e.file_base64.length : 0) * 3) / 4), 0);
    if (estimado > MAX_TOTAL_ADJUNTOS_BYTES) {
      throw new BadRequestException(`Los archivos suman más de ${MAX_TOTAL_ADJUNTOS_BYTES / 1048576} MB por envío; adjunta menos o más livianos`);
    }
    return lista.map((e, i) => {
      const r = validarAdjunto(e?.file_base64, maxBytes);
      if (!r.ok) throw new BadRequestException(`Archivo ${i + 1}: ${r.detalle}`);
      // `[MS.ADJ.1.1/1.2]` el nombre (y con él la extensión de la clave del bucket) dice lo que el archivo ES, no lo que declaró el cliente.
      const file_name = nombreDeAdjunto(sanitizarNombre(e?.file_name, r.adjunto.contentType), r.adjunto.contentType);
      return { file_name, adjunto: r.adjunto };
    });
  }

  /**
   * `[MS.ADJ.2.2]` Enlaces de Google: se normalizan y validan (host exacto, https, sin credenciales; ver `domain/enlaces.ts`). Sin red:
   * el servidor jamás visita la URL. Lanza 400 con el motivo del primero inválido; un enlace repetido en el envío se guarda una vez.
   */
  prepararEnlaces(entradas: SdLinkInput[] | undefined): EnlacePreparado[] {
    const lista = entradas ?? [];
    if (!Array.isArray(lista)) throw new BadRequestException('links debe ser una lista');
    if (lista.length > MAX_ENLACES_POR_ENVIO) throw new BadRequestException(`Máximo ${MAX_ENLACES_POR_ENVIO} enlaces por envío`);
    const vistos = new Set<string>();
    const listos: EnlacePreparado[] = [];
    lista.forEach((e, i) => {
      const r = normalizarEnlaceGoogle(e?.url);
      if (!r.ok) throw new BadRequestException(`Enlace ${i + 1}: ${r.motivo}`);
      if (vistos.has(r.url)) return;
      vistos.add(r.url);
      listos.push({ url: r.url, kind: r.tipo });
    });
    return listos;
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
  /** `[MSH.2]` H4: `vidaS` = segundos de vida de la URL (600 de siempre; 60 en un ticket confidencial: una URL reenviada vale eso). */
  firmar(key: string, vidaS = 600): Promise<string> {
    return this.storage.signedUrl(key, vidaS);
  }
}
