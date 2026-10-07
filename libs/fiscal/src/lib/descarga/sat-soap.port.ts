import { AuthToken, EfirmaMaterial, SolicitaParams, SolicitaResult, VerificaResult } from './sat-ws.types';

/**
 * Port del transporte SOAP hacia el WS de Descarga Masiva del SAT. La
 * orquestación (DescargaService) depende de esta interfaz, no de la impl — así el
 * motor de firma WS-Security se puede swapear (impl de referencia con node:crypto
 * ↔ @nodecfdi/sat-ws-descarga-masiva endurecido) sin tocar el pipeline.
 */
export const SAT_SOAP_PORT = 'SAT_SOAP_PORT';

export interface SatSoapPort {
  authenticate(m: EfirmaMaterial): Promise<AuthToken>;
  solicita(token: string, m: EfirmaMaterial, p: SolicitaParams): Promise<SolicitaResult>;
  verifica(token: string, m: EfirmaMaterial, rfcSolicitante: string, idSolicitud: string): Promise<VerificaResult>;
  descargaPaquete(token: string, m: EfirmaMaterial, rfcSolicitante: string, idPaquete: string): Promise<Buffer>;
}
