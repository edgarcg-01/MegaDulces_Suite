import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

/**
 * Object storage S3-compatible para comprobantes (Railway Bucket / Tigris).
 * Bucket PRIVADO: se sube el objeto y se sirve con URL PREFIRMADA temporal → abre
 * en el navegador sin el bloqueo de PDF de Cloudinary y sin exponer el documento
 * públicamente. **Solo PDF** (rechaza imágenes). Config por env S3_*; si falta,
 * `isConfigured()` es false y el llamador degrada.
 *
 * Reemplaza a Cloudinary para los comprobantes financieros (entradas, pagos,
 * cobranza, gastos, comprobaciones, caducidades, bancos).
 */
@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private _client: S3Client | null = null;
  private get bucket(): string { return process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || ''; }
  // Acepta los nombres S3_* (canónicos del proyecto) o los estándar AWS_* — así un typo
  // tipo `Access_Key_ID` se detecta claro (no matchea) en vez de fallar en silencio.
  private get endpoint(): string { return process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3 || ''; }
  private get accessKeyId(): string { return process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || ''; }
  private get secretAccessKey(): string { return process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || ''; }

  isConfigured(): boolean {
    return !!(this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey);
  }

  private client(): S3Client {
    if (this._client) return this._client;
    this._client = new S3Client({
      region: process.env.S3_REGION || process.env.AWS_REGION || 'auto',
      endpoint: this.endpoint,
      credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
      forcePathStyle: true, // S3-compatible (Tigris/MinIO/R2)
    });
    return this._client;
  }

  /** Valida que el data URI sea PDF y devuelve su base64 puro. Rechaza imágenes. */
  private pdfBase64(dataUri: string): string {
    const raw = dataUri || '';
    const body = raw.replace(/^data:[^,]*,/, '');
    const isPdf = /^data:application\/pdf/i.test(raw) || /^JVBER/i.test(body); // %PDF → base64 "JVBER…"
    if (!isPdf) throw new BadRequestException('Solo se aceptan archivos PDF.');
    return body;
  }

  /** Sube un PDF (data URI) al bucket privado. Rechaza imágenes. Devuelve la KEY. */
  async putPdf(dataUri: string, folder = 'docs'): Promise<{ key: string; kind: 'pdf' }> {
    if (!this.isConfigured()) throw new BadRequestException('Almacenamiento no configurado (faltan env S3_*).');
    const buf = Buffer.from(this.pdfBase64(dataUri), 'base64');
    const key = `${folder.replace(/^\/+|\/+$/g, '')}/${randomUUID()}.pdf`;
    await this.client().send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: buf,
      ContentType: 'application/pdf', ContentDisposition: 'inline',
    }));
    return { key, kind: 'pdf' };
  }

  /**
   * Sube CUALQUIER archivo (imagen o PDF) — para flujos donde la imagen es válida
   * (ej. fotos de ficha por WhatsApp en bank-capture). Guarda el ContentType real.
   */
  async putFile(dataUri: string, folder = 'docs'): Promise<{ key: string; kind: 'pdf' | 'image' }> {
    if (!this.isConfigured()) throw new BadRequestException('Almacenamiento no configurado (faltan env S3_*).');
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const ct = (m ? m[1] : 'application/octet-stream').toLowerCase();
    const isPdf = ct === 'application/pdf';
    const ext = isPdf ? 'pdf' : ((ct.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '') || 'bin');
    const buf = Buffer.from(dataUri.replace(/^data:[^,]*,/, ''), 'base64');
    const key = `${folder.replace(/^\/+|\/+$/g, '')}/${randomUUID()}.${ext}`;
    await this.client().send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: buf,
      ContentType: ct, ContentDisposition: 'inline',
    }));
    return { key, kind: isPdf ? 'pdf' : 'image' };
  }

  /** URL prefirmada de lectura (temporal) para abrir el archivo inline en el navegador. */
  async signedUrl(key: string, ttlSec = 600): Promise<string> {
    if (!key || !this.isConfigured()) return '';
    return getSignedUrl(
      this.client(),
      // El ContentType/Disposition inline se toman del objeto (seteados al subir); forzamos
      // inline por si el objeto no lo trae. NO forzamos ContentType (sirve img y PDF).
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: 'inline' }),
      { expiresIn: ttlSec },
    );
  }

  /**
   * Reemplaza `url` de cada archivo por una URL PREFIRMADA fresca a partir de su
   * key (guardada en `public_id`). Para llamar en las lecturas (detail/list) antes
   * de devolver los comprobantes al frontend. Archivos legacy (con url http de
   * Cloudinary y sin key) se dejan tal cual.
   */
  async signFiles<T extends { url?: string; public_id?: string }>(files: T[] | null | undefined, ttlSec = 600): Promise<T[]> {
    const list = Array.isArray(files) ? files : [];
    if (!list.length || !this.isConfigured()) return list;
    return Promise.all(list.map(async (f) => {
      const key = f?.public_id || '';
      // key del bucket = "<folder>/<uuid>.pdf"; si no parece key nuestra (o ya es http), no firmar.
      if (!key || /^https?:\/\//i.test(key)) return f;
      const url = await this.signedUrl(key, ttlSec).catch(() => '');
      return url ? ({ ...f, url } as T) : f;
    }));
  }

  async remove(key: string): Promise<void> {
    if (!key || !this.isConfigured() || /^https?:\/\//i.test(key)) return;
    try { await this.client().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
    catch (e: any) { this.logger.warn(`DELETE ${key}: ${e?.message || e}`); }
  }
}
