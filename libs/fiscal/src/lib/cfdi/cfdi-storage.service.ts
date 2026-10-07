import { Injectable, Logger } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * FISCAL.4.2 — Object storage del XML/ZIP crudo (Cloudflare R2, S3-compatible).
 *
 * Adaptación del SDD: R2 con Object Lock (WORM) para retención legal de 5 años,
 * egress $0. Config SOLO por env; si falta, la bóveda degrada a "no almacenado"
 * (stored_ref=null) sin romper la ingesta — el parseo a fiscal.cfdis sigue.
 *
 * Se guarda UN objeto por paquete (el ZIP), no un objeto por CFDI: 1 PUT vs miles.
 * Cada fiscal.cfdis referencia el paquete + el nombre de entry del XML.
 */
@Injectable()
export class CfdiStorageService {
  private readonly logger = new Logger(CfdiStorageService.name);
  private _client: S3Client | null = null;
  private readonly bucket = process.env.FISCAL_R2_BUCKET || '';
  private readonly retentionYears = Number(process.env.FISCAL_R2_RETENTION_YEARS || 5);

  isConfigured(): boolean {
    return !!(process.env.FISCAL_R2_ENDPOINT && this.bucket && process.env.FISCAL_R2_ACCESS_KEY_ID && process.env.FISCAL_R2_SECRET_ACCESS_KEY);
  }

  private client(): S3Client {
    if (this._client) return this._client;
    this._client = new S3Client({
      region: process.env.FISCAL_R2_REGION || 'auto',
      endpoint: process.env.FISCAL_R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.FISCAL_R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.FISCAL_R2_SECRET_ACCESS_KEY as string,
      },
      forcePathStyle: true, // R2
    });
    return this._client;
  }

  /**
   * Sube el ZIP de un paquete. Devuelve la key (stored_ref) o null si no hay storage.
   * Aplica retención WORM best-effort (requiere Object Lock habilitado en el bucket).
   */
  async putPackageZip(tenantId: string, packageId: string, buffer: Buffer, baseDate?: Date): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const key = `cfdi-zip/${tenantId}/${packageId}.zip`;
    const retainUntil = new Date(baseDate ?? new Date());
    retainUntil.setFullYear(retainUntil.getFullYear() + this.retentionYears);
    try {
      await this.client().send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: buffer,
        ContentType: 'application/zip',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }));
      return key;
    } catch (e: any) {
      // Reintento sin Object Lock (bucket sin lock habilitado): al menos persistir el objeto.
      this.logger.warn(`PUT con Object Lock falló (${e?.name || e?.message}); reintentando sin retención`);
      try {
        await this.client().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buffer, ContentType: 'application/zip' }));
        return key;
      } catch (e2: any) {
        this.logger.error(`No se pudo subir el ZIP a R2: ${e2?.message || e2}`);
        return null;
      }
    }
  }

  /** Descarga un objeto por key (para recuperación on-demand del XML). */
  async getObject(key: string): Promise<Buffer | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await this.client().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (e: any) {
      this.logger.error(`GET ${key}: ${e?.message || e}`);
      return null;
    }
  }
}
