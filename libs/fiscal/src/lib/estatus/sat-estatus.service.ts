import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SatEstatusPort, EstatusConsulta, EstatusResult } from './sat-estatus.port';

/**
 * FISCAL.6 — Impl del WS público del SAT ConsultaCFDIService (SOAP, sin e.firma).
 *
 * A diferencia de la descarga masiva, este WS NO requiere firma WS-Security: solo
 * la "expresión impresa" ?re=&rr=&tt=&id=. Devuelve Estado (Vigente/Cancelado/No
 * Encontrado) + EsCancelable + EstatusCancelacion. URL override por env.
 *
 * ⚠️ El formato de `tt` (total) que espera el SAT es sensible; validar contra el WS
 * real con un CFDI conocido antes de confiar en prod (igual que la firma de FISCAL.4).
 */
@Injectable()
export class SatEstatusService implements SatEstatusPort {
  private readonly logger = new Logger(SatEstatusService.name);
  private readonly url = process.env.FISCAL_SAT_ESTATUS_URL
    || 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';

  async consulta(q: EstatusConsulta): Promise<EstatusResult> {
    const expr = `?re=${q.re}&rr=${q.rr}&tt=${q.tt}&id=${q.id}`;
    const envelope =
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">` +
      `<soapenv:Header/><soapenv:Body><tem:Consulta>` +
      `<tem:expresionImpresa>${this.esc(expr)}</tem:expresionImpresa>` +
      `</tem:Consulta></soapenv:Body></soapenv:Envelope>`;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: 'http://tempuri.org/IConsultaCFDIService/Consulta' },
      body: envelope,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      this.logger.warn(`SAT estatus ${res.status}: ${text.slice(0, 200)}`);
      throw new ServiceUnavailableException(`SAT ConsultaCFDIService devolvió ${res.status}`);
    }
    return {
      estado: this.tag(text, 'Estado') || 'No Encontrado',
      esCancelable: this.tag(text, 'EsCancelable') || '',
      estatusCancelacion: this.tag(text, 'EstatusCancelacion') || '',
      codigoEstatus: this.tag(text, 'CodigoEstatus') || '',
    };
  }

  private tag(xml: string, name: string): string | null {
    // Tolera namespace: <a:Estado> o <Estado>.
    const m = xml.match(new RegExp(`<(?:[a-zA-Z0-9]+:)?${name}>([^<]*)</(?:[a-zA-Z0-9]+:)?${name}>`));
    return m ? m[1].trim() : null;
  }
  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
