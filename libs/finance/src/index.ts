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
export * from './lib/expense-comprobaciones/finance-expense-comprobaciones.module';
export * from './lib/expense-comprobaciones/expense-comprobaciones.service';
export * from './lib/collection-deposits/finance-collection-deposits.module';
export * from './lib/collection-deposits/collection-deposits.service';
export * from './lib/customer-ledger/finance-customer-ledger.module';
export * from './lib/customer-ledger/customer-ledger.service';
export * from './lib/customer-ledger/customer-receivables-scanner.service';
export * from './lib/supplier-payment-proofs/finance-supplier-payment-proofs.module';
export * from './lib/supplier-payment-proofs/supplier-payment-proofs.service';
export * from './lib/goods-receipt-proofs/finance-goods-receipt-proofs.module';
export * from './lib/goods-receipt-proofs/goods-receipt-proofs.service';
export * from './lib/bank/finance-bank.module';
export * from './lib/jobs/finance-jobs.module';
export * from './lib/jobs/finance-jobs.service';
export * from './lib/bank/finance-bank.service';
export * from './lib/bank-capture/finance-bank-capture.module';
export * from './lib/bank-capture/bank-capture.service';
export * from './lib/polizas/finance-polizas.module';
export * from './lib/polizas/polizas.service';
export * from './lib/purchase-book/finance-purchase-book.module';
export * from './lib/purchase-book/purchase-book.service';
export * from './lib/payment-program/finance-payment-program.module';
export * from './lib/payment-program/payment-program.service';
export * from './lib/caja/finance-caja-general.module';
export * from './lib/caja/caja-general.service';
export * from './lib/feed-notify/finance-feed-notify.module';
export * from './lib/feed-notify/finance-feed-scanner.service';
