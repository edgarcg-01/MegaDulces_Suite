import { BadRequestException } from '@nestjs/common';

/**
 * ⛔⛔ `[CG.154]` **Una regla del libro violada es un 400 con su frase, no un 500 con el SQL.**
 *
 * Medido contra producción el 2026-10-14 (auditoría E2E, hallazgo E4): glosa de menos de 5
 * caracteres, `monto = 0` y un `client_uuid` mal formado devolvían **500 Internal server error**.
 * Son los `CHECK` de la tabla saliendo sin traducir — o sea que la persona que captura recibe
 * «error interno» cuando lo que pasó es que le faltan dos letras en la glosa.
 *
 * ⚠️ Y es la misma familia que `[CG.143.3]` cerró del lado de la frescura —*«el error de Postgres
 * no se le pinta al cajero»*—: estos tres caminos quedaron afuera porque aquello miraba el
 * `label` de un eslabón y esto es el cuerpo de la respuesta. **Cerrar una salida del error crudo
 * no cierra las otras.**
 *
 * ── Dos decisiones, y las dos importan
 *
 * 1. **Se traduce por NOMBRE de constraint, no por el texto del mensaje.** El texto de Postgres
 *    cambia entre versiones y está localizado; el nombre lo fija la migración.
 * 2. ⛔ **Lo que no está en el mapa NO se traduce a una frase inventada**: se deja pasar tal cual
 *    para que siga siendo un 500 ruidoso. Un 400 genérico sobre una causa desconocida convierte
 *    un defecto del servidor en «el usuario escribió algo mal», que es exactamente la mentira que
 *    este módulo viene arrastrando (cero filas leídas como falta de adopción).
 */
const POR_CONSTRAINT: Record<string, string> = {
  cash_ledger_glosa_chk: 'La descripción es muy corta: necesita al menos 5 caracteres.',
  cash_ledger_monto_chk: 'El monto tiene que ser mayor que cero.',
  cash_ledger_morralla_chk: 'La morralla no puede ser negativa.',
  cash_ledger_venta_credito_chk: 'La venta a crédito no puede ser negativa.',
  cash_ledger_cuenta_chk: 'Falta la cuenta contable de Kepler.',
  cash_ledger_concepto_chk: 'Falta el concepto de Kepler.',
  cash_ledger_tipo_chk: 'El tipo de movimiento no es uno de los válidos (ingreso, gasto o depósito).',
  cash_ledger_estado_chk: 'El estado del movimiento no es uno de los válidos.',
  cash_ledger_cancel_chk: 'Para cancelar hace falta decir quién y por qué.',
  cash_ledger_sin_doc_motivo_chk:
    'El motivo de «sin documento» es muy corto: necesita al menos 12 caracteres.',
  cash_ledger_origen_chk: 'El origen del movimiento no es uno de los válidos.',
  cash_ledger_firma_estado_chk: 'El estado de la firma no es coherente con el movimiento.',
  cut_denom_piezas_chk: 'Una denominación con cero piezas no se guarda: quitala del conteo.',
  cut_denom_par_chk: 'La denominación no coincide con su llave (por ejemplo, $20 billete contra $20 moneda).',
  cut_denom_momento_chk: 'El momento del desglose sólo puede ser apertura o cierre.',
};

/** Códigos de Postgres que SÍ son culpa de lo que se mandó, no del servidor. */
const CODIGOS_DEL_CLIENTE: Record<string, string> = {
  // `invalid_text_representation` — p. ej. un `client_uuid` que no es un UUID.
  '22P02': 'Alguno de los datos no tiene el formato que se espera (revisá el identificador).',
  // `not_null_violation` — falta un campo obligatorio.
  '23502': 'Falta un dato obligatorio del movimiento.',
};

interface ErrorPg { code?: string; constraint?: string }

/**
 * Convierte el error de Postgres en un `BadRequestException` con una frase para humanos, **o lo
 * vuelve a lanzar tal cual** si no se reconoce.
 *
 * ⚠️ Nunca incluye el mensaje crudo de Postgres en la respuesta: lleva nombres de tabla, de
 * columna y de constraint a una pantalla de captura de efectivo.
 */
export function traducirErrorDeCaja(e: unknown): never {
  const pg = e as ErrorPg;
  const porNombre = pg?.constraint ? POR_CONSTRAINT[pg.constraint] : undefined;
  if (porNombre) throw new BadRequestException(porNombre);

  // `check_violation` de una regla que no está en el mapa: se dice que es una regla del libro,
  // sin nombrarla. Es lo único honesto — la regla existe y la persona no la cumplió, pero no
  // tenemos una frase escrita para ella.
  if (pg?.code === '23514') {
    throw new BadRequestException(
      'El movimiento no cumple una de las reglas del libro de caja. Revisá los datos y volvé a intentar.',
    );
  }

  const porCodigo = pg?.code ? CODIGOS_DEL_CLIENTE[pg.code] : undefined;
  if (porCodigo) throw new BadRequestException(porCodigo);

  // ⛔ Desconocido: NO se disfraza de 400. Que siga siendo un 500 es lo que hace que alguien lo
  // mire.
  throw e as Error;
}
