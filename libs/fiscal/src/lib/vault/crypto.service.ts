import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed { data: Buffer; iv: Buffer; tag: Buffer; }

/**
 * FISCAL.2 — Cifrado de credenciales SAT en reposo (AES-256-GCM).
 *
 * La master key vive SOLO en env (FISCAL_CRYPTO_KEY, 32 bytes en hex o base64),
 * nunca en la DB. Adaptación del SDD a Railway: pgcrypto/env en vez de AWS KMS.
 * El material en claro (.key, contraseña) se descifra en memoria y se ZEROIZA al
 * salir del scope, aunque `fn` lance.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private _key: Buffer | null = null;

  private masterKey(): Buffer {
    if (this._key) return this._key;
    const raw = process.env.FISCAL_CRYPTO_KEY;
    if (!raw) throw new ServiceUnavailableException('FISCAL_CRYPTO_KEY no configurada (bóveda deshabilitada)');
    let key: Buffer;
    try {
      key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    } catch {
      throw new ServiceUnavailableException('FISCAL_CRYPTO_KEY inválida (esperado 32 bytes hex o base64)');
    }
    if (key.length !== 32) throw new ServiceUnavailableException('FISCAL_CRYPTO_KEY debe ser de 32 bytes (256 bits)');
    this._key = key;
    return key;
  }

  /** ¿Está la bóveda configurada? (para reportar estado sin lanzar). */
  isConfigured(): boolean {
    try { this.masterKey(); return true; } catch { return false; }
  }

  seal(plain: Buffer): Sealed {
    const iv = randomBytes(12); // GCM nonce
    const c = createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const data = Buffer.concat([c.update(plain), c.final()]);
    return { data, iv, tag: c.getAuthTag() };
  }

  open(sealed: Sealed): Buffer {
    const d = createDecipheriv('aes-256-gcm', this.masterKey(), sealed.iv);
    d.setAuthTag(sealed.tag);
    return Buffer.concat([d.update(sealed.data), d.final()]);
  }

  /**
   * Descifra la .key + su contraseña en memoria, se las entrega a `fn`, y ZEROIZA
   * los buffers al terminar (pase lo que pase). El material en claro nunca se
   * persiste, loguea ni serializa.
   */
  async withDecryptedEfirma<T>(
    creds: { key_enc: Buffer; key_iv: Buffer; key_tag: Buffer; pwd_enc: Buffer; pwd_iv: Buffer; pwd_tag: Buffer },
    fn: (m: { key: Buffer; password: Buffer }) => Promise<T>,
  ): Promise<T> {
    const key = this.open({ data: creds.key_enc, iv: creds.key_iv, tag: creds.key_tag });
    let password: Buffer | null = null;
    try {
      // Dentro del try: si open(password) lanza, el finally igual zeroiza la .key ya descifrada.
      password = this.open({ data: creds.pwd_enc, iv: creds.pwd_iv, tag: creds.pwd_tag });
      return await fn({ key, password });
    } finally {
      key.fill(0);
      password?.fill(0);
    }
  }
}
