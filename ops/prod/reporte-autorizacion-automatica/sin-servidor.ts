/**
 * Va como PRIMER import de `reporte.ts`. Las librerías de la Suite exigen un secreto de firma al cargarse
 * (`requireJwtSecret`); este script no levanta servidor ni firma nada, así que recibe uno al azar, de un solo uso,
 * que no se guarda en ningún lado.
 */
import { randomBytes } from 'node:crypto';

process.env['JWT_SECRET'] ||= randomBytes(32).toString('hex');
