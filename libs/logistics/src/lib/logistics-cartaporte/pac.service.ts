import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Puerto al PAC (Proveedor Autorizado de Certificación). Default: Facturama.
 * Mantiene el timbrado fuera del service de negocio para poder cambiar de PAC
 * sin tocar el armado del complemento.
 *
 * Credenciales por env:
 *   PAC_PROVIDER          = facturama (default)
 *   FACTURAMA_BASE_URL    = https://apisandbox.facturama.mx | https://api.facturama.mx
 *   FACTURAMA_USER        = usuario
 *   FACTURAMA_PASSWORD    = contraseña
 */
export interface PacStampResult {
  uuid: string;
  serie?: string;
  folio?: string;
  xml_base64?: string;
  pdf_base64?: string;
  raw: unknown;
}

@Injectable()
export class PacService {
  private readonly logger = new Logger(PacService.name);
  readonly provider = process.env.PAC_PROVIDER || 'facturama';

  private cfg() {
    const base = process.env.FACTURAMA_BASE_URL || 'https://apisandbox.facturama.mx';
    const user = process.env.FACTURAMA_USER;
    const pass = process.env.FACTURAMA_PASSWORD;
    if (!user || !pass) {
      throw new ServiceUnavailableException(
        'PAC no configurado: faltan FACTURAMA_USER / FACTURAMA_PASSWORD',
      );
    }
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    return { base, auth };
  }

  /** Timbra un CFDI (con complemento Carta Porte ya incluido en el payload). */
  async stamp(cfdiPayload: unknown): Promise<PacStampResult> {
    const { base, auth } = this.cfg();
    const res = await fetch(`${base}/3/cfdis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(cfdiPayload),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.logger.error(`PAC stamp ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
      throw new ServiceUnavailableException(
        `PAC rechazó el timbrado (${res.status}): ${data?.Message || data?.message || 'ver pac_response'}`,
      );
    }
    return {
      uuid: data.Complement?.TaxStamp?.Uuid || data.Uuid || data.uuid,
      serie: data.Serie,
      folio: data.Folio,
      xml_base64: data.Xml,
      pdf_base64: data.Pdf,
      raw: data,
    };
  }

  /** Cancela un CFDI timbrado ante el SAT. */
  async cancel(facturamaId: string, motive = '02'): Promise<unknown> {
    const { base, auth } = this.cfg();
    const res = await fetch(`${base}/cfdi/${facturamaId}?motive=${motive}`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${auth}` },
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `PAC rechazó la cancelación (${res.status}): ${data?.Message || 'ver respuesta'}`,
      );
    }
    return data;
  }
}
