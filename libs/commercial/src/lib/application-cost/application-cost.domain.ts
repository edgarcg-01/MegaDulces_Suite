/**
 * `[PQ.157]` C1 — las reglas de la decisión de costo viven en el contrato (las comparten la API y la pantalla);
 * aquí sólo se reexportan para el dominio de Compras. La tabla es `commercial.application_cost_decisions`.
 */
export {
  CENTAVO_COSTO, TOL_COSTO, MOTIVO_MINIMO, redondear2, mismoCosto, maximoReclamable, validarDecision, yaDecididoAntes,
} from '@megadulces/contracts/http/application-cost';
