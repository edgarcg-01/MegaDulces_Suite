// @megadulces/fiscal — barrel público.
// Dominio Fiscal (auditoría CFDI / cumplimiento SAT). Depende solo de
// platform-core. NO importa commercial, trade ni logistics (frontera limpia:
// query-service propio sobre analytics.* y fiscal.*).
//
// FISCAL.0 = EFOS 69-B · FISCAL.1 = Art. 69 + validación de RFC.
// Motor de listas SAT extensible (sat-lists.config.ts).
export * from './lib/listas/fiscal-listas.module';
export * from './lib/listas/fiscal-listas.service';
export * from './lib/listas/sat-list-ingest.service';
export * from './lib/listas/sat-list-cross.service';
export * from './lib/listas/rfc-validation.service';
export * from './lib/listas/sat-lists.config';
