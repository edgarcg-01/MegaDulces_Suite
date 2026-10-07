/** FISCAL.6 — Port de consulta de estatus de CFDI ante el SAT (ConsultaCFDIService). */
export const SAT_ESTATUS_PORT = Symbol('SAT_ESTATUS_PORT');

export interface EstatusConsulta {
  re: string;   // RFC emisor
  rr: string;   // RFC receptor
  tt: string;   // total (como en el CFDI)
  id: string;   // UUID (folio fiscal)
}

export interface EstatusResult {
  estado: string;              // 'Vigente' | 'Cancelado' | 'No Encontrado'
  esCancelable: string;
  estatusCancelacion: string;
  codigoEstatus: string;
}

export interface SatEstatusPort {
  consulta(q: EstatusConsulta): Promise<EstatusResult>;
}
