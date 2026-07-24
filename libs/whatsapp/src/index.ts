// @megadulces/whatsapp — barrel público.
// Fase F (ADR-006/007/034): comercio conversacional por WhatsApp. Canal detrás
// de un puerto abstracto (Meta Cloud API / simulador), cola degradable
// (BullMQ o in-process) y estado de conversación. Depende solo de platform-core.
// NO importa commercial/trade/logistics (frontera limpia; el pedido se crea vía
// createIntake desde el orquestador, cableado en el composition root del API).

export * from './lib/whatsapp.module';
export * from './lib/ports/whatsapp.port';
export * from './lib/adapters/simulator.adapter';
export * from './lib/adapters/meta-cloud.adapter';
export * from './lib/queue/whatsapp-queue.service';
export * from './lib/conversation/conversation-thread.service';
