import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PacPort, PacStampResult, PacCancelInput, PacCancelResult, PacStatusResult } from './pac.port';

/**
 * FE.0 — Adapter del PAC SW SmarterWeb / Luna Soft (Conectia).
 * Probado E2E contra el sandbox 2026-07-16 (emisión JSON CFDI 4.0).
 *
 * Env:
 *   SW_BASE_URL   = https://services.test.sw.com.mx (default) | https://services.sw.com.mx
 *   SW_TOKEN      = token infinito (si está, se usa directo)
 *   SW_USER       = usuario de API  ┐ si no hay SW_TOKEN, se autentica y cachea
 *   SW_PASSWORD   = contraseña       ┘ un token temporal (2h) que se renueva solo
 *
 * Modelo: SW arma+sella+timbra desde JSON con el CSD cargado en la cuenta
 * (Sello/NoCertificado/Certificado vacíos), elegido por `Emisor.Rfc`.
 */
@Injectable()
export class SwPacService implements PacPort {
  readonly provider = 'sw';
  private readonly logger = new Logger(SwPacService.name);
  private cachedToken: { value: string; expiresAt: number } | null = null;

  private base(): string {
    return process.env.SW_BASE_URL || 'https://services.test.sw.com.mx';
  }

  /** Token: infinito por env, o temporal auto-renovado con user/password. */
  private async token(): Promise<string> {
    const infinite = process.env.SW_TOKEN;
    if (infinite) return infinite;

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.value;
    }

    const user = process.env.SW_USER;
    const password = process.env.SW_PASSWORD;
    if (!user || !password) {
      throw new ServiceUnavailableException(
        'PAC SW no configurado: falta SW_TOKEN o SW_USER/SW_PASSWORD',
      );
    }
    const res = await fetch(`${this.base()}/v2/security/authenticate`, {
      method: 'POST',
      headers: { user, password },
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.status !== 'success' || !data?.data?.token) {
      throw new ServiceUnavailableException(
        `PAC SW auth falló (${res.status}): ${data?.message || 'sin token'}`,
      );
    }
    const ttlSec = Number(data.data.expires_in) || 7200;
    this.cachedToken = { value: data.data.token, expiresAt: now + ttlSec * 1000 };
    return this.cachedToken.value;
  }

  async stamp(cfdiJson: unknown): Promise<PacStampResult> {
    const token = await this.token();
    const res = await fetch(`${this.base()}/v3/cfdi33/issue/json/v4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsontoxml', Authorization: `Bearer ${token}` },
      body: JSON.stringify(cfdiJson),
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok || data?.status !== 'success') {
      const msg = data?.message || (typeof data === 'string' ? data.slice(0, 300) : 'ver pac_response');
      this.logger.error(`SW stamp ${res.status}: ${msg}`);
      throw new ServiceUnavailableException(`El PAC rechazó el timbrado (${res.status}): ${msg}`);
    }
    const d = data.data || {};
    return {
      uuid: d.uuid,
      xml: this.normalizeXml(d.cfdi),
      no_certificado_sat: d.noCertificadoSAT,
      fecha_timbrado: d.fechaTimbrado,
      sello_sat: d.selloSAT,
      cadena_original_sat: d.cadenaOriginalSAT,
      raw: data,
    };
  }

  /**
   * FE.10 — Cancelación con el CSD ya cargado en la cuenta (por parámetros).
   * SW: DELETE /cfdi/{rfc}/{uuid}/{motivo}/{folioSustitucion}. Devuelve
   * `data.uuid = {"<UUID>":"<codigoEstatus>"}` + `data.acuse` (XML/base64 del SAT).
   * El estatus real (vigente/cancelado) lo confirma `status()` — la cancelación
   * con aceptación queda "en proceso" hasta que el receptor acepte (72h).
   */
  async cancel(input: PacCancelInput): Promise<PacCancelResult> {
    const token = await this.token();
    const motivo = input.motivo || '02';
    const sustit = motivo === '01' ? (input.folioSustitucion || '') : '';
    const url = `${this.base()}/cfdi/${encodeURIComponent(input.rfc)}/${encodeURIComponent(input.uuid)}/${motivo}/${sustit}`;
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok || data?.status === 'error') {
      const msg = data?.message || (typeof data === 'string' ? data.slice(0, 300) : 'ver respuesta');
      this.logger.error(`SW cancel ${res.status}: ${msg}`);
      throw new ServiceUnavailableException(`El PAC rechazó la cancelación (${res.status}): ${msg}`);
    }

    const d = data?.data || {};
    const codes: Record<string, string> = {};
    if (d.uuid && typeof d.uuid === 'object') {
      for (const [k, v] of Object.entries(d.uuid)) codes[String(k).toUpperCase()] = String(v);
    }
    const code = codes[input.uuid.toUpperCase()] || '';
    // 201 = petición aceptada (en proceso si requiere aceptación). 202 = ya estaba
    // cancelado. Otros 2xx = aceptada. La confirmación fina la da status().
    const estatus: PacCancelResult['estatus'] =
      code === '202' ? 'cancelado' : (data?.status === 'success' ? 'en_proceso_cancelacion' : 'desconocido');
    return { estatus, acuse: d.acuse ?? null, codes, raw: data };
  }

  /**
   * FE.10 — Consulta el estatus del CFDI ante el SAT (vía SW). Best-effort: si el
   * endpoint falla o cambia, devuelve null (no rompe el flujo de cancelación).
   * SW: GET /cfdi/status/{rfcEmisor}/{rfcReceptor}/{total}/{uuid}.
   */
  async status(input: { uuid: string; emisorRfc: string; receptorRfc: string; total: string | number }): Promise<PacStatusResult | null> {
    try {
      const token = await this.token();
      const total = String(input.total);
      const url = `${this.base()}/cfdi/status/${encodeURIComponent(input.emisorRfc)}/${encodeURIComponent(input.receptorRfc)}/${encodeURIComponent(total)}/${encodeURIComponent(input.uuid)}`;
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || data?.status === 'error') {
        this.logger.warn(`SW status ${res.status}: ${data?.message || 'sin data'}`);
        return null;
      }
      const d = data?.data || {};
      return {
        estado: d.estadoComprobante || d.EstadoComprobante || d.estado,
        es_cancelable: d.esCancelable || d.EsCancelable,
        estatus_cancelacion: d.estatusCancelacion || d.EstatusCancelacion,
        raw: data,
      };
    } catch (e: any) {
      this.logger.warn(`SW status falló: ${e?.message || e}`);
      return null;
    }
  }

  /** Base del servicio de PDF de SW (host distinto: services.* → api.*). */
  private pdfBase(): string {
    if (process.env.SW_PDF_BASE_URL) return process.env.SW_PDF_BASE_URL;
    return this.base().replace('services.', 'api.');
  }

  async pdf(xml: string): Promise<string | null> {
    const token = await this.token();
    const res = await fetch(`${this.pdfBase()}/pdf/v1/api/GeneratePdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ xmlContent: xml, templateId: 'cfdi40' }),
    });
    const data: any = await res.json().catch(() => ({}));
    const b64 = data?.data?.contentB64;
    if (!res.ok || !b64) {
      this.logger.warn(`SW PDF ${res.status}: ${data?.message || 'sin contentB64'}`);
      return null;
    }
    return b64;
  }

  /** SW devuelve el XML timbrado en `data.cfdi` (crudo o base64). Normaliza a XML. */
  private normalizeXml(cfdi: unknown): string | undefined {
    if (typeof cfdi !== 'string' || !cfdi) return undefined;
    const t = cfdi.trimStart();
    if (t.startsWith('<')) return cfdi;
    try {
      const decoded = Buffer.from(cfdi, 'base64').toString('utf8');
      return decoded.trimStart().startsWith('<') ? decoded : cfdi;
    } catch { return cfdi; }
  }
}
