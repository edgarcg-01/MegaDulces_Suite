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
export * from './lib/collection-deposits/finance-collection-deposits.module';
export * from './lib/collection-deposits/collection-deposits.service';
export * from './lib/supplier-payment-proofs/finance-supplier-payment-proofs.module';
export * from './lib/supplier-payment-proofs/supplier-payment-proofs.service';
export * from './lib/goods-receipt-proofs/finance-goods-receipt-proofs.module';
export * from './lib/goods-receipt-proofs/goods-receipt-proofs.service';
export * from './lib/bank/finance-bank.module';
export * from './lib/bank/finance-bank.service';
export * from './lib/polizas/finance-polizas.module';
export * from './lib/polizas/polizas.service';
