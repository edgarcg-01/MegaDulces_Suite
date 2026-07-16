import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  Fiel, FielRequestBuilder, Service, CResponse, WebClientException,
  QueryParameters, DateTimePeriod, DownloadType, RequestType, DocumentStatus,
} from '@nodecfdi/sat-ws-descarga-masiva';
import { SatSoapPort } from './sat-soap.port';
import { AuthToken, EfirmaMaterial, SolicitaParams, SolicitaResult, VerificaResult } from './sat-ws.types';

/**
 * FE.9 — Impl del transporte SOAP de Descarga Masiva con `@nodecfdi/sat-ws-descarga-masiva`
 * (firma WS-Security real). Reemplaza la impl de referencia (c14n falsa → HTTP 500).
 * Mismo puerto `SAT_SOAP_PORT`, sin tocar la orquestación. Probado E2E esta sesión
 * (837 CFDIs). @nodecfdi maneja el token de auth internamente por Service, así que
 * `authenticate` solo valida la e.firma; cada op reconstruye el Service desde `m`.
 */

/** WebClient con fetch: evita el bug del HttpsWebClient de @nodecfdi (lanza Error plano
 *  en timeout → runRequest le llama .getResponse() → crash). Timer explícito que se limpia. */
class FetchWebClient {
  fireRequest(): void {}
  fireResponse(): void {}
  async call(request: any): Promise<CResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(request.getUri(), {
        method: request.getMethod(),
        headers: request.getHeaders(),
        body: request.getBody(),
        signal: ctrl.signal,
      });
      const body = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return new CResponse(res.status, body, headers);
    } catch (err: any) {
      const msg = err?.message || String(err);
      throw new WebClientException(msg, request, new CResponse(0, msg, {}));
    } finally {
      clearTimeout(timer);
    }
  }
}

@Injectable()
export class SatSoapNodecfdiService implements SatSoapPort {
  private readonly logger = new Logger(SatSoapNodecfdiService.name);

  private fielFrom(m: EfirmaMaterial): Fiel {
    // Fiel.create espera contenidos binarios (como readFileSync(path, 'binary')).
    const fiel = Fiel.create(m.cerDer.toString('binary'), m.keyDer.toString('binary'), m.password.toString('utf8'));
    if (!fiel.isValid()) throw new ServiceUnavailableException('e.firma inválida (certificado/llave/contraseña).');
    return fiel;
  }
  private serviceFrom(m: EfirmaMaterial): Service {
    return new Service(new FielRequestBuilder(this.fielFrom(m)), new FetchWebClient() as any);
  }

  async authenticate(m: EfirmaMaterial): Promise<AuthToken> {
    this.fielFrom(m); // valida cert/llave/contraseña localmente
    return { token: 'nodecfdi', expires: new Date(Date.now() + 55 * 60_000) };
  }

  async solicita(_token: string, m: EfirmaMaterial, p: SolicitaParams): Promise<SolicitaResult> {
    const service = this.serviceFrom(m);
    const period = DateTimePeriod.createFromValues(`${p.fechaIni} 00:00:00`, `${p.fechaFin} 23:59:59`);
    const download = new DownloadType(p.rol === 'emitidas' ? 'issued' : 'received');
    const reqType = new RequestType(p.tipo === 'Metadata' ? 'metadata' : 'xml');
    const params = QueryParameters.create(period, download, reqType).withDocumentStatus(new DocumentStatus('active'));
    const q = await service.query(params);
    const status = q.getStatus();
    const cod = String((status as any).getCode?.() ?? '');
    if (!status.isAccepted()) {
      this.logger.warn(`SAT solicita no aceptada: ${status.getMessage()}`);
      return { idSolicitud: '', cod: cod || '404', mensaje: status.getMessage() };
    }
    return { idSolicitud: q.getRequestId(), cod: cod || '5000', mensaje: status.getMessage() };
  }

  async verifica(_token: string, m: EfirmaMaterial, _rfcSolicitante: string, idSolicitud: string): Promise<VerificaResult> {
    const service = this.serviceFrom(m);
    const v = await service.verify(idSolicitud);
    const status = v.getStatus();
    const sr: any = v.getStatusRequest();
    return {
      estadoSolicitud: this.mapEstado(sr),
      codEstatus: String((status as any).getCode?.() ?? ''),
      codigoEstadoSolicitud: String((v as any).getCodeRequest?.()?.getValue?.() ?? ''),
      numeroCFDIs: v.getNumberCfdis(),
      mensaje: status.getMessage(),
      idsPaquetes: v.getPackageIds(),
    };
  }

  async descargaPaquete(_token: string, m: EfirmaMaterial, _rfcSolicitante: string, idPaquete: string): Promise<Buffer> {
    const service = this.serviceFrom(m);
    const dl = await service.download(idPaquete);
    if (!dl.getStatus().isAccepted()) {
      throw new ServiceUnavailableException(`SAT rechazó la descarga del paquete ${idPaquete}: ${dl.getStatus().getMessage()}`);
    }
    return Buffer.from(dl.getPackageContent(), 'base64');
  }

  /** StatusRequest de @nodecfdi → EstadoSolicitud del SAT (1-6). Ante desconocido:
   *  'en proceso' (2) para que el orquestador siga polleando (tiene cap), no error. */
  private mapEstado(sr: any): number {
    try {
      if (sr.isTypeOf('Finished')) return 3;
      if (sr.isTypeOf('Failure')) return 4;
      if (sr.isTypeOf('Rejected')) return 5;
      if (sr.isTypeOf('Expired')) return 6;
    } catch { /* noop */ }
    return 2;
  }
}
