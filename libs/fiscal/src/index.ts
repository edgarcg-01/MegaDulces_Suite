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
export * from './lib/listas/fiscal-findings-bridge.service';
export * from './lib/listas/sat-lists.config';

// FISCAL.2 bóveda · FISCAL.3 jobs · FISCAL.4 descarga masiva CFDI (WS SAT).
export * from './lib/vault/fiscal-vault.module';
export * from './lib/vault/crypto.service';
export * from './lib/vault/sat-credentials.service';
export * from './lib/jobs/fiscal-jobs.module';
export * from './lib/jobs/job-queue.service';
export * from './lib/jobs/job-runner.service';
export * from './lib/descarga/fiscal-descarga.module';
export * from './lib/descarga/descarga.service';
export * from './lib/descarga/sat-soap.port';
export * from './lib/descarga/sat-ws.types';

// FISCAL.4.2 = almacén CFDI 4.0 (parser XML + ingesta desde ZIP + storage R2).
export * from './lib/cfdi/fiscal-cfdi.module';
export * from './lib/cfdi/cfdi.service';
export * from './lib/cfdi/cfdi-parser.service';
export * from './lib/cfdi/cfdi-ingest.service';
export * from './lib/cfdi/cfdi.types';

// FISCAL.5.1 = conciliación PUE/PPD ↔ REP · FISCAL.5.2 = CFDI ↔ póliza (heurística).
export * from './lib/conciliacion/fiscal-conciliacion.module';
export * from './lib/conciliacion/conciliacion.service';
export * from './lib/conciliacion/poliza-cruce.service';

// FISCAL.8.1 = DIOT + conciliación de IVA (IVA efectivamente pagado).
export * from './lib/diot/fiscal-diot.module';
export * from './lib/diot/diot.service';

// FISCAL.6 = validación de estatus CFDI ante el SAT (vigente/cancelado).
export * from './lib/estatus/fiscal-estatus.module';
export * from './lib/estatus/estatus.service';
export * from './lib/estatus/sat-estatus.port';

// FISCAL.9 = contabilidad electrónica (XMLs SAT: catálogo + balanza).
export * from './lib/contabilidad/fiscal-contabilidad.module';
export * from './lib/contabilidad/contabilidad-electronica.service';

// FISCAL.10.1 = expediente de materialidad por proveedor.
export * from './lib/materialidad/fiscal-materialidad.module';
export * from './lib/materialidad/materialidad.service';

// FISCAL.18 = impuestos provisionales (ISR + IVA mensual).
export * from './lib/impuestos/fiscal-impuestos.module';
export * from './lib/impuestos/impuestos.service';

// FE = Facturación electrónica (emisión/timbrado CFDI 4.0 vía PAC SW/Conectia).
export * from './lib/emision/fiscal-emision.module';
export * from './lib/emision/emision.service';
export * from './lib/emision/order-invoice-issuer.service';
export * from './lib/emision/pac.port';
export * from './lib/emision/emision.types';
