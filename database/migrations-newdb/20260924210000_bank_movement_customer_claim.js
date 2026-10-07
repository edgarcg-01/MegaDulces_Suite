/**
 * [CC.11] **De quién es este depósito** — lo declara una persona, porque ninguna fuente lo trae.
 *
 * ── EL CALLEJÓN SIN SALIDA QUE CIERRA ───────────────────────────────────────────────────
 * Medido en el prod real (2026-09-24): **5,240 abonos de cobranza por $118.9M entraron al banco
 * y ningún cobro de Kepler los explica**. Para esos, la pantalla «Abonos sin cobro» ofrece
 * «Ligar»… y no hay a qué ligar. Se acaba el camino.
 *
 * Y el dato que haría falta **no existe en ninguna fuente**, está medido:
 *   · el **banco** no dice quién pagó — el concepto dice `VENTA MORELIA ABASTOS` o viene vacío;
 *   · **ContPAQi** lleva clientes por *sucursal × régimen de IVA* (14 cuentas), nunca por cliente;
 *   · no hay **CFDIs emitidos**: de los 168,245 cargados, los 168,245 son recibidos.
 *
 * El único lugar donde un cobro tiene cliente es Kepler — que es justo el que no lo tiene
 * todavía. **Entonces lo pone un humano, o no se sabe.** Eso es lo que estas cuatro columnas
 * guardan, y por eso nacen con quién lo dijo y cuándo: una afirmación sin autor no se puede
 * revisar después.
 *
 * ── POR QUÉ ACÁ Y NO EN UNA TABLA NUEVA ─────────────────────────────────────────────────
 * Es un atributo **del movimiento**, no una entidad aparte. La regla del proyecto es extender la
 * tabla principal antes que crear una segunda materialización de lo mismo.
 *
 * ⭐ Y hay precedente exacto en esta misma tabla: el UPSERT del importador de estados de cuenta
 * (`finance-bank.service.ts`) **deja `category_id` y `classified_by` fuera de su `merge()`** a
 * propósito, *"para preservar la reclasificación manual"*. Estas columnas siguen esa regla: no
 * entran al `merge()`, así que un re-import del Excel **no las pisa**.
 *
 * ⚠️ Se evaluó y se descartó `finance.bank_capture_inbox` (Fase CBW), que ya tiene
 * `customer_code`/`rfc`: exige `from_phone NOT NULL` y su semántica es *"llegó una foto"*. Acá no
 * llegó ninguna foto — llegó dinero al banco y alguien sabe de quién es. Forzarlo habría sido
 * usar una tabla por sus columnas y no por su significado.
 *
 * ⛔ **Esto NO es el cobro.** No escribe a Kepler, no crea el asiento y no salda nada: sólo dice
 * *"este depósito es de tal cliente y Kepler todavía no lo tiene"*, que es exactamente lo que
 * crédito y cobranza necesita para dejar de llamar a quien ya pagó. El cobro lo captura quien
 * corresponde, en Kepler, y cuando aparezca se liga por el camino que ya existe
 * (`bank_recon_matches`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const t = 'finance.bank_movements';
  const cols = [
    ['customer_code', (tb) => tb.text('customer_code')],
    ['customer_nota', (tb) => tb.text('customer_nota')],
    ['customer_declared_by', (tb) => tb.text('customer_declared_by')],
    ['customer_declared_at', (tb) => tb.timestamp('customer_declared_at', { useTz: true })],
  ];
  for (const [name, add] of cols) {
    if (!(await knex.schema.withSchema('finance').hasColumn('bank_movements', name))) {
      await knex.schema.withSchema('finance').alterTable('bank_movements', add);
    }
  }

  // Índice parcial: la inmensa mayoría de los movimientos NUNCA va a tener cliente declarado
  // (son depósitos de tienda, traspasos, retiros). Un índice completo sería casi todo NULL.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_bank_mov_customer_claim
        ON finance.bank_movements (tenant_id, customer_code, movement_date DESC)
     WHERE customer_code IS NOT NULL AND deleted_at IS NULL`);

  await knex.raw(`
    COMMENT ON COLUMN finance.bank_movements.customer_code IS
      '[CC.11] De quien es este deposito, DECLARADO POR UNA PERSONA. Ninguna fuente lo trae: el '
      'banco no dice quien pago, ContPAQi lleva clientes por sucursal x regimen de IVA y no hay '
      'CFDIs emitidos. NO es el cobro ni lo sustituye: es la pista para capturarlo en Kepler y '
      'para que cobranza deje de llamar a quien ya pago. El importador NO la pisa (fuera del '
      'merge del UPSERT, igual que category_id/classified_by).'`);

  // ⛔ El freno que importa: si alguien mete estas columnas al `merge()` del importador, un
  // re-import del Excel borra en silencio el trabajo humano. Se comprueba, no se confía.
  const fs = require('node:fs');
  const path = require('node:path');
  const svc = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'bank',
    'finance-bank.service.ts');
  if (fs.existsSync(svc)) {
    const src = fs.readFileSync(svc, 'utf8');
    const i = src.indexOf("onConflict(['tenant_id', 'client_uuid'])");
    const merge = i >= 0 ? src.slice(i, i + 700) : '';
    if (/customer_code|customer_declared/.test(merge)) {
      throw new Error('[CC.11] el UPSERT de bank_movements incluye las columnas declaradas por '
        + 'humanos en su merge(): un re-import del Excel las borraria sin avisar. Sacarlas del '
        + 'merge, igual que category_id y classified_by.');
    }
  }
  console.log('  OK finance.bank_movements +4 columnas de cliente declarado (HITL) + indice parcial.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS finance.ix_bank_mov_customer_claim');
  for (const c of ['customer_code', 'customer_nota', 'customer_declared_by', 'customer_declared_at']) {
    if (await knex.schema.withSchema('finance').hasColumn('bank_movements', c)) {
      await knex.schema.withSchema('finance').alterTable('bank_movements', (tb) => tb.dropColumn(c));
    }
  }
};
