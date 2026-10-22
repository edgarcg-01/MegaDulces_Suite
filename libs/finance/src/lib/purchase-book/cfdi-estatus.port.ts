/**
 * `[LC.19.1]` — Port para verificar ante el SAT, en el momento, el estatus de los CFDI que van a
 * una póliza (vigente / cancelado).
 *
 * Lo declara quien lo consume (el libro de compras). La implementación vive en `libs/fiscal`
 * (`EstatusService.verificarUuids`, WS público ConsultaCFDIService), y `finance` no puede
 * importar `fiscal` por frontera: el binding está en `apps/api/src/composition`, el único lugar
 * que conoce los dos lados. Se inyecta `@Optional`: sin binding, el libro DECLARA que no pudo
 * verificar, nunca lo da por vigente.
 */
export const CFDI_ESTATUS_PORT = 'CFDI_ESTATUS_PORT';

export interface VerificacionCfdis {
  consultados: number;
  vigentes: number;
  cancelados: number;
  /** El SAT no lo encontró: sigue `desconocido`, que NO es vigente. */
  no_encontrados: number;
  /** El WS falló: tampoco se sabe nada. */
  fallidos: number;
  /** false = no hay con qué consultar al SAT; nada se consultó. */
  disponible: boolean;
}

export interface CfdiEstatusPort {
  verificarUuids(tenantId: string, uuids: string[]): Promise<VerificacionCfdis>;
}
