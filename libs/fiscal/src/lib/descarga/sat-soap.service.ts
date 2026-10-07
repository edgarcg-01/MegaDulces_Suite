import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createPrivateKey, createSign, X509Certificate } from 'node:crypto';
import { SatSoapPort } from './sat-soap.port';
import { AuthToken, EfirmaMaterial, SolicitaParams, SolicitaResult, VerificaResult } from './sat-ws.types';

/**
 * FISCAL.4 — Impl de referencia del transporte SOAP al WS de Descarga Masiva del SAT.
 *
 * ⚠️ FIRMA WS-SECURITY: esta impl arma los envelopes y firma con node:crypto
 * (RSA-SHA1). La CANONICALIZACIÓN (exc-c14n) que exige el SAT es exigente y NO se
 * pudo validar contra el sandbox desde el entorno de desarrollo. Antes de prod:
 * validar en el ambiente de pruebas del SAT, o —recomendado para producción
 * endurecida— swapear esta impl por `@nodecfdi/sat-ws-descarga-masiva` (mismo
 * port SAT_SOAP_PORT, sin tocar la orquestación). Las URLs por defecto son las
 * documentadas; overrideables por env (el doc indica que las válidas están en el
 * portal del SAT).
 */
@Injectable()
export class SatSoapService implements SatSoapPort {
  private readonly logger = new Logger(SatSoapService.name);

  private readonly urls = {
    auth: process.env.FISCAL_SAT_AUTH_URL || 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/Autenticacion/Autenticacion.svc',
    solicita: process.env.FISCAL_SAT_SOLICITA_URL || 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/SolicitaDescargaService.svc',
    verifica: process.env.FISCAL_SAT_VERIFICA_URL || 'https://cfdidescargamasivasolicitud.clouda.sat.gob.mx/VerificaSolicitudDescargaService.svc',
    descarga: process.env.FISCAL_SAT_DESCARGA_URL || 'https://cfdidescargamasiva.clouda.sat.gob.mx/DescargaMasivaService.svc',
  };

  // ── Autenticación (§4 del doc): WS-Security + firma del Timestamp ─────────
  async authenticate(m: EfirmaMaterial): Promise<AuthToken> {
    const created = new Date();
    const expires = new Date(created.getTime() + 5 * 60_000);
    const certB64 = m.cerDer.toString('base64');
    const tsId = '_0';
    const ts = `<u:Timestamp u:Id="${tsId}"><u:Created>${created.toISOString()}</u:Created><u:Expires>${expires.toISOString()}</u:Expires></u:Timestamp>`;
    const signedTs = this.signEnveloped(ts, `#${tsId}`, m, certB64, 'u');

    const envelope =
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:u="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">` +
      `<s:Header><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">${signedTs}</o:Security></s:Header>` +
      `<s:Body><Autentica xmlns="http://DescargaMasivaTerceros.gob.mx"/></s:Body></s:Envelope>`;

    const res = await this.post(this.urls.auth, envelope, 'http://DescargaMasivaTerceros.gob.mx/IAutenticacion/Autentica');
    const token = this.between(res, '<AutenticaResult>', '</AutenticaResult>') || this.between(res, '<u:Created>', '</u:Created>');
    if (!token) throw new ServiceUnavailableException('SAT: no se obtuvo token de autenticación');
    return { token: token.trim(), expires };
  }

  // ── Solicitud de descarga ────────────────────────────────────────────────
  async solicita(token: string, m: EfirmaMaterial, p: SolicitaParams): Promise<SolicitaResult> {
    const tipoRol = p.rol === 'emitidas' ? 'RfcEmisor' : 'RfcReceptor';
    const attrs =
      `<des:solicitud FechaInicial="${p.fechaIni}T00:00:00" FechaFinal="${p.fechaFin}T23:59:59" ` +
      `RfcSolicitante="${p.rfcSolicitante}" TipoSolicitud="${p.tipo}" ${tipoRol}="${p.rfcSolicitante}">`;
    const inner = `<des:SolicitaDescarga>${attrs}{SIG}</des:solicitud></des:SolicitaDescarga>`;
    const body = this.signedBody(inner, m, token);
    const res = await this.post(this.urls.solicita, body, 'http://DescargaMasivaTerceros.sat.gob.mx/ISolicitaDescargaService/SolicitaDescarga', token);
    return {
      idSolicitud: this.attr(res, 'IdSolicitud') || '',
      cod: this.attr(res, 'CodEstatus') || '',
      mensaje: this.attr(res, 'Mensaje') || '',
    };
  }

  // ── Verificación (§5.1 del doc) ──────────────────────────────────────────
  async verifica(token: string, m: EfirmaMaterial, rfcSolicitante: string, idSolicitud: string): Promise<VerificaResult> {
    const inner =
      `<des:VerificaSolicitudDescarga><des:solicitud IdSolicitud="${idSolicitud}" RfcSolicitante="${rfcSolicitante}">{SIG}</des:solicitud></des:VerificaSolicitudDescarga>`;
    const body = this.signedBody(inner, m, token);
    const res = await this.post(this.urls.verifica, body, 'http://DescargaMasivaTerceros.sat.gob.mx/IVerificaSolicitudDescargaService/VerificaSolicitudDescarga', token);
    const paquetes = [...res.matchAll(/<IdsPaquetes>([^<]+)<\/IdsPaquetes>/g)].map((x) => x[1]);
    return {
      estadoSolicitud: Number(this.attr(res, 'EstadoSolicitud') || 0),
      codEstatus: this.attr(res, 'CodEstatus') || '',
      codigoEstadoSolicitud: this.attr(res, 'CodigoEstadoSolicitud') || '',
      numeroCFDIs: Number(this.attr(res, 'NumeroCFDIs') || 0),
      mensaje: this.attr(res, 'Mensaje') || '',
      idsPaquetes: paquetes,
    };
  }

  // ── Descarga del paquete (ZIP base64 en la respuesta) ────────────────────
  async descargaPaquete(token: string, m: EfirmaMaterial, rfcSolicitante: string, idPaquete: string): Promise<Buffer> {
    const inner =
      `<des:PeticionDescargaMasivaTercerosEntrada><des:peticionDescarga IdPaquete="${idPaquete}" RfcSolicitante="${rfcSolicitante}">{SIG}</des:peticionDescarga></des:PeticionDescargaMasivaTercerosEntrada>`;
    const body = this.signedBody(inner, m, token);
    const res = await this.post(this.urls.descarga, body, 'http://DescargaMasivaTerceros.sat.gob.mx/IDescargaMasivaTercerosService/Descargar', token);
    const b64 = this.between(res, '<Paquete>', '</Paquete>');
    if (!b64) throw new ServiceUnavailableException('SAT: respuesta de descarga sin <Paquete>');
    return Buffer.from(b64.trim(), 'base64');
  }

  // ── Firma / transporte ───────────────────────────────────────────────────
  /** Envuelve el body con una firma enveloped sobre el nodo `des:solicitud`/similar. */
  private signedBody(innerWithSigPlaceholder: string, m: EfirmaMaterial, _token: string): string {
    const certB64 = m.cerDer.toString('base64');
    // Firma enveloped con Reference URI="" (todo el elemento solicitud).
    const sig = this.buildSignature('', m, certB64);
    const inner = innerWithSigPlaceholder.replace('{SIG}', sig);
    return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:des="http://DescargaMasivaTerceros.sat.gob.mx" xmlns:xd="http://www.w3.org/2000/09/xmldsig#"><soapenv:Header/><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
  }

  /** Firma un elemento referenciado (auth Timestamp): devuelve el elemento + <Signature>. */
  private signEnveloped(element: string, refUri: string, m: EfirmaMaterial, certB64: string, _nsPrefix: string): string {
    return element + this.buildSignature(refUri, m, certB64, element);
  }

  /**
   * Construye el bloque <Signature> XML-DSig (RSA-SHA1). Si `refElement` se provee
   * se digiere ese elemento (auth Timestamp); si no, se asume enveloped (URI="").
   * ⚠️ c14n mínima — validar contra sandbox SAT (ver nota de clase).
   */
  private buildSignature(refUri: string, m: EfirmaMaterial, certB64: string, refElement?: string): string {
    const canon = refElement ? this.c14n(refElement) : '';
    const digest = refElement ? createHash('sha1').update(canon).digest('base64') : '';
    const transforms = refElement
      ? `<Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>`
      : `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>`;
    const signedInfo =
      `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
      `<CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>` +
      `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
      `<Reference URI="${refUri}"><Transforms>${transforms}</Transforms>` +
      `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
      `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;

    const key = createPrivateKey({ key: m.keyDer, format: 'der', type: 'pkcs8', passphrase: m.password });
    const signatureValue = createSign('RSA-SHA1').update(this.c14n(signedInfo)).sign(key, 'base64');

    return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfo}` +
      `<SignatureValue>${signatureValue}</SignatureValue>` +
      `<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
  }

  /** c14n mínima: normaliza para la firma. VALIDAR en sandbox (ver nota de clase). */
  private c14n(xml: string): string {
    return xml.replace(/>\s+</g, '><').trim();
  }

  private async post(url: string, xml: string, soapAction: string, token?: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: `"${soapAction}"` };
    if (token) headers['Authorization'] = `WRAP access_token="${token}"`;
    const res = await fetch(url, { method: 'POST', headers, body: xml, signal: AbortSignal.timeout(90_000) });
    const text = await res.text();
    if (!res.ok) {
      this.logger.error(`SAT ${url} → ${res.status}: ${text.slice(0, 400)}`);
      throw new ServiceUnavailableException(`SAT devolvió ${res.status}`);
    }
    return text;
  }

  private attr(xml: string, name: string): string | null {
    // \b ancla el nombre: sin esto attr('EstadoSolicitud') matchea DENTRO de
    // CodigoEstadoSolicitud="..." (no hay frontera entre 'o' y 'E') y lee el valor equivocado.
    const m = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : null;
  }
  private between(xml: string, a: string, b: string): string | null {
    const i = xml.indexOf(a); if (i < 0) return null;
    const j = xml.indexOf(b, i + a.length); if (j < 0) return null;
    return xml.slice(i + a.length, j);
  }

  /** Valida vigencia del cert (usado por el orquestador antes de firmar). */
  static certVigente(cerDer: Buffer): boolean {
    try { const x = new X509Certificate(cerDer); return new Date(x.validTo) > new Date(); } catch { return false; }
  }
}
