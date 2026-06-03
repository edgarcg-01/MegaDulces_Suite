import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { CloudinaryService } from '@megadulces/platform-core';

export type PhotoCategory =
  | 'loading'
  | 'transit'
  | 'delivery'
  | 'incident'
  | 'checklist'
  | 'other';

export interface UploadPhotoDto {
  shipment_id: string;
  category?: PhotoCategory;
  description?: string;
  /** Base64 data URL (data:image/jpeg;base64,...) o solo base64. */
  image_base64?: string;
  /** URL ya subida (modo "registrar URL externa", sin tocar Cloudinary). */
  external_url?: string;
  cloudinary_public_id?: string;
  guide_id?: string;
  driver_id?: string;
  gps_lat?: number;
  gps_lng?: number;
  captured_at?: string; // ISO timestamp del device
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES: PhotoCategory[] = [
  'loading',
  'transit',
  'delivery',
  'incident',
  'checklist',
  'other',
];

@Injectable()
export class LogisticsPhotosService {
  private readonly logger = new Logger(LogisticsPhotosService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async upload(dto: UploadPhotoDto) {
    if (!UUID_REGEX.test(dto.shipment_id)) {
      throw new BadRequestException('shipment_id inválido');
    }
    const category: PhotoCategory = dto.category || 'other';
    if (!CATEGORIES.includes(category)) {
      throw new BadRequestException(`category inválido: ${category}`);
    }
    if (!dto.image_base64 && !dto.external_url) {
      throw new BadRequestException('Debe venir image_base64 (sube a Cloudinary) o external_url (registra URL existente)');
    }
    if (dto.guide_id && !UUID_REGEX.test(dto.guide_id)) {
      throw new BadRequestException('guide_id inválido');
    }
    if (dto.driver_id && !UUID_REGEX.test(dto.driver_id)) {
      throw new BadRequestException('driver_id inválido');
    }

    // Subir a Cloudinary si vino base64
    let url = dto.external_url || '';
    let publicId = dto.cloudinary_public_id || null;
    if (dto.image_base64) {
      try {
        const folder = `logistics/${this.tenantCtx.requireTenantId()}/${dto.shipment_id}`;
        const result = await this.cloudinary.uploadImageBase64(dto.image_base64, folder);
        url = result.secure_url;
        publicId = result.public_id;
      } catch (e: any) {
        this.logger.error('Cloudinary upload failed', e);
        throw new BadRequestException(`Upload a Cloudinary falló: ${e.message || e}`);
      }
    }

    return this.tk.run(async (trx) => {
      // Verificar shipment existe
      const shipment = await trx('logistics.shipments')
        .where({ id: dto.shipment_id })
        .whereNull('deleted_at')
        .first();
      if (!shipment) throw new NotFoundException(`Shipment ${dto.shipment_id} no encontrado`);

      const userId = this.tenantCtx.get()?.userId;
      const [row] = await trx('logistics.shipment_photos')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          shipment_id: dto.shipment_id,
          guide_id: dto.guide_id || null,
          driver_id: dto.driver_id || null,
          uploaded_by_user_id: userId || null,
          category,
          url,
          cloudinary_public_id: publicId,
          description: dto.description || null,
          gps_lat: dto.gps_lat ?? null,
          gps_lng: dto.gps_lng ?? null,
          captured_at: dto.captured_at || null,
        })
        .returning('*');
      return row;
    });
  }

  async listByShipment(shipmentId: string, category?: PhotoCategory) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('logistics.shipment_photos')
        .where({ shipment_id: shipmentId })
        .whereNull('deleted_at')
        .orderBy('uploaded_at', 'desc');
      if (category) q = q.where({ category });
      return q;
    });
  }

  async listByGuide(guideId: string) {
    if (!UUID_REGEX.test(guideId)) throw new BadRequestException('guide_id inválido');
    return this.tk.run(async (trx) =>
      trx('logistics.shipment_photos')
        .where({ guide_id: guideId })
        .whereNull('deleted_at')
        .orderBy('uploaded_at', 'desc'),
    );
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const row = await trx('logistics.shipment_photos')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Photo ${id} no encontrada`);
      return row;
    });
  }

  /** Soft-delete + intenta borrar de Cloudinary si tiene public_id. */
  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    const row = await this.findById(id);

    if (row.cloudinary_public_id) {
      try {
        await this.cloudinary.deleteImage(row.cloudinary_public_id);
      } catch (e: any) {
        // No abortamos el soft-delete si Cloudinary falla; loggeamos y seguimos.
        this.logger.warn(`Cloudinary delete falló para ${row.cloudinary_public_id}: ${e.message || e}`);
      }
    }

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId;
      await trx('logistics.shipment_photos')
        .where({ id })
        .update({
          deleted_at: trx.fn.now(),
          deleted_by: userId || null,
        });
      return { deleted: true, id };
    });
  }
}
