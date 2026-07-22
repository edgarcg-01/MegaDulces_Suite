// @megadulces/finance — barrel público.
// Dominio Finanzas (ADR-028 Maat): base de conocimiento, motor de patrones,
// hallazgos con feedback y chat AI. Depende solo de platform-core.
// NO importa commercial, trade ni logistics (frontera limpia: query-service
// propio sobre analytics.*/finance.*).

export * from './lib/maat/finance-maat.module';
export * from './lib/maat/maat-knowledge.service';
export * from './lib/maat/maat-chat.service';
export * from './lib/maat/maat-findings-sink.service';
export * from './lib/expense-proofs/finance-expense-proofs.module';
export * from './lib/expense-proofs/expense-proofs.service';
export * from './lib/bank/finance-bank.module';
export * from './lib/bank/finance-bank.service';
