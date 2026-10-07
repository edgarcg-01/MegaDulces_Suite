import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { X509Certificate } from 'node:crypto';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CryptoService } from './crypto.service';

export interface UpsertCredInput {
  rfc: string;
  razon_social?: string;
  cer_b64: string;   // .cer en DER, base64
  key_b64: string;   // .key en DER (PKCS#8), base64
  password: string;  // contraseña de la .key
  ciec?: string;     // opcional (scraping)
}

/** Fila con material sellado — uso INTERNO (SAT WS layer), nunca sale por API. */
export interface SealedCred {
  id: string; rfc: string; razon_social: string | null;
  cer_der: Buffer;
  key_enc: Buffer; key_iv: Buffer; key_tag: Buffer;
  pwd_enc: Buffer; pwd_iv: Buffer; pwd_tag: Buffer;
  cer_valid_to: string | null;
}

@Injectable()
export class SatCredentialsService {
  private readonly logger = new Logger(SatCredentialsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly crypto: CryptoService,
  ) {}

  /** Alta/actualización de e.firma. Cifra key/pwd/ciec; parsea vigencia del cert. */
  async upsert(input: UpsertCredInput): Promise<{ rfc: string; cer_valid_to: string | null; vigente: boolean }> {
    const rfc = (input.rfc || '').trim().toUpperCase();
    if (!/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new BadRequestException('RFC inválido');
    if (!input.cer_b64 || !input.key_b64 || !input.password) throw new BadRequestException('Faltan cer/key/password');

    const cerDer = Buffer.from(input.cer_b64, 'base64');
    const keyDer = Buffer.from(input.key_b64, 'base64');

    // Vigencia + validación RFC desde el cert (best-effort: si no parsea, seguimos con input).
    let validFrom: string | null = null, validTo: string | null = null;
    try {
      const x = new X509Certificate(cerDer);
      validFrom = this.toDate(x.validFrom);
      validTo = this.toDate(x.validTo);
      const rfcInCert = this.extractRfc(x.subject);
      if (rfcInCert && rfcInCert !== rfc) {
        throw new BadRequestException(`El RFC (${rfc}) no coincide con el del certificado (${rfcInCert})`);
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`No se pudo parsear el .cer: ${e?.message || e}`);
      throw new BadRequestException('El .cer no es un certificado X.509 DER válido');
    }

    const key = this.crypto.seal(keyDer);
    const pwd = this.crypto.seal(Buffer.from(input.password, 'utf8'));
    const ciec = input.ciec ? this.crypto.seal(Buffer.from(input.ciec, 'utf8')) : null;
    keyDer.fill(0);

    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run(async (trx) => {
      const upd = {
        razon_social: input.razon_social ?? null,
        cer_der: cerDer,
        key_enc: key.data, key_iv: key.iv, key_tag: key.tag,
        pwd_enc: pwd.data, pwd_iv: pwd.iv, pwd_tag: pwd.tag,
        ciec_enc: ciec?.data ?? null, ciec_iv: ciec?.iv ?? null, ciec_tag: ciec?.tag ?? null,
        cer_valid_from: validFrom, cer_valid_to: validTo, active: true,
      };
      await trx('fiscal.sat_credentials')
        .insert({ tenant_id: tenantId, rfc, ...upd })
        .onConflict(['tenant_id', 'rfc'])
        .merge({ ...upd, updated_at: trx.fn.now() });
    });

    const vigente = !validTo || new Date(validTo) > new Date();
    this.logger.log(`e.firma ${rfc} guardada (vence ${validTo ?? '?'}).`);
    return { rfc, cer_valid_to: validTo, vigente };
  }

  /** Estado NO sensible de las credenciales del tenant (para UI/alertas). */
  async status(): Promise<Array<{ rfc: string; razon_social: string | null; cer_valid_to: string | null; dias_para_vencer: number | null; vigente: boolean; active: boolean; vault_ok: boolean }>> {
    const rows = await this.tk.run(async (trx) =>
      trx('fiscal.sat_credentials').select('rfc', 'razon_social', 'cer_valid_to', 'active'));
    const vaultOk = this.crypto.isConfigured();
    return rows.map((r: any) => {
      const dias = r.cer_valid_to ? Math.round((new Date(r.cer_valid_to).getTime() - Date.now()) / 86_400_000) : null;
      return { rfc: r.rfc, razon_social: r.razon_social, cer_valid_to: r.cer_valid_to, dias_para_vencer: dias, vigente: dias == null || dias > 0, active: r.active, vault_ok: vaultOk };
    });
  }

  /** Material sellado para la capa SAT WS. INTERNO — no exponer por API. */
  async getSealed(rfc?: string): Promise<SealedCred | null> {
    return this.tk.run(async (trx) => {
      let q = trx('fiscal.sat_credentials').where({ active: true });
      if (rfc) q = q.where({ rfc: rfc.trim().toUpperCase() });
      const r = await q.orderBy('updated_at', 'desc').first();
      return (r as SealedCred) ?? null;
    });
  }

  async remove(rfc: string): Promise<{ removed: number }> {
    return this.tk.run(async (trx) => ({ removed: await trx('fiscal.sat_credentials').where({ rfc: rfc.trim().toUpperCase() }).del() }));
  }

  private toDate(s: string): string | null {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  /** RFC del subject del cert SAT (OID 2.5.4.45 x500UniqueIdentifier trae " / RFC / CURP"). */
  private extractRfc(subject: string): string | null {
    const m = subject.match(/[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}/);
    return m ? m[0].toUpperCase() : null;
  }
}
