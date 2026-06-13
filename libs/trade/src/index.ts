// @megadulces/trade — barrel público.
// Dominio Trade Marketing: auditoría de visitas/capturas en PdV, scoring,
// planogramas, reports realtime, catálogos legacy, stores, visitas, users.
// Depende solo de @megadulces/platform-core. El gateway websocket (/reports)
// es interno a este dominio (lo consumen daily-captures y reports).

export * from './lib/catalogs/catalogs.module';
export * from './lib/commercial-map/commercial-map.module';
export * from './lib/daily-assignments/daily-assignments.module';
export * from './lib/daily-captures/daily-captures.module';
export * from './lib/data/data.module';
export * from './lib/planograms/planograms.module';
export * from './lib/reports/reports.module';
export * from './lib/scoring/scoring.module';
export * from './lib/scoring/scoring-v2.module';
export * from './lib/stores/stores.module';
export * from './lib/users/users.module';
export * from './lib/visits/visits.module';
export * from './lib/websocket/websocket.module';
