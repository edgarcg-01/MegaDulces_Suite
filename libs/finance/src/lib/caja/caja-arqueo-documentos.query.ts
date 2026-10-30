import type { Knex } from 'knex';
import type { DocumentoEnCaja, TipoDocumentoCaja } from '@megadulces/contracts';

/**
 * `[CGS.59]` Los cheques y papeles que ESTÁN en un arqueo, cada uno con el día en que se vio por
 * primera vez (`visto_desde`: el primer arqueo con su `pieza`). Lo leen el arqueo (lo que hay que
 * marcar al volver a contar) y la posición (el total del rubro, abierto documento por documento).
 *
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function documentosQueEstan(trx: Knex.Transaction, tenantId: string, arqueoId: string): Promise<DocumentoEnCaja[]> {
  const filas = (await trx.raw(`
    SELECT d.pieza, d.tipo, d.clase, d.monto, d.banco, d.numero, d.de_quien, d.concepto,
           to_char(d.fecha, 'YYYY-MM-DD') AS fecha,
           (SELECT to_char(min((a2.counted_at AT TIME ZONE 'America/Mexico_City')::date), 'YYYY-MM-DD')
              FROM finance.cash_arqueo_documentos d2
              JOIN finance.cash_arqueos a2 ON a2.id = d2.arqueo_id
             WHERE d2.tenant_id = d.tenant_id AND d2.pieza = d.pieza) AS visto_desde
      FROM finance.cash_arqueo_documentos d
     WHERE d.tenant_id = ? AND d.arqueo_id = ?::uuid AND d.estado = 'esta'
     ORDER BY d.tipo, d.created_at, d.id`, [tenantId, arqueoId])).rows as Array<Record<string, unknown>>;
  return filas.map((r) => ({
    pieza: String(r['pieza']),
    tipo: r['tipo'] as TipoDocumentoCaja,
    clase: (r['clase'] ?? null) as DocumentoEnCaja['clase'],
    monto: Number(r['monto']),
    banco: (r['banco'] ?? null) as string | null,
    numero: (r['numero'] ?? null) as string | null,
    de_quien: String(r['de_quien']),
    concepto: (r['concepto'] ?? null) as string | null,
    fecha: (r['fecha'] ?? null) as string | null,
    visto_desde: String(r['visto_desde']),
  }));
}

/** ¿Esta base ya tiene la tabla de los renglones? (migración `[CGS.59]`) */
export async function hayDocumentosDeArqueo(trx: Knex.Transaction): Promise<boolean> {
  return (await trx.raw(`SELECT to_regclass('finance.cash_arqueo_documentos') IS NOT NULL AS t`)).rows[0]?.t === true;
}

/** ¿Esta base ya tiene los documentos de los movimientos? (migración `[CGS.60]`) */
export async function hayDocumentosDeMovimiento(trx: Knex.Transaction): Promise<boolean> {
  return (await trx.raw(`SELECT to_regclass('finance.cash_ledger_documentos') IS NOT NULL AS t`)).rows[0]?.t === true;
}

/**
 * ⭐ `[CGS.60]` Lo que DEBERÍA haber en la caja de un apartado: lo que estaba en el último arqueo
 * que lo contó (`base`), más lo que entró con un movimiento capturado después, menos lo que salió
 * con uno. Un movimiento cancelado no cuenta. Es la lista que el arqueo pide marcar y de la que un
 * pago elige su cheque: las dos leen lo mismo.
 */
export async function documentosEnCaja(
  trx: Knex.Transaction, tenantId: string, tipo: TipoDocumentoCaja,
  ultimo: { counted_at: string | Date } | null, base: readonly DocumentoEnCaja[],
): Promise<DocumentoEnCaja[]> {
  const enCaja = new Map(base.filter((d) => d.tipo === tipo).map((d) => [d.pieza, d]));
  if (!(await hayDocumentosDeMovimiento(trx))) return [...enCaja.values()];
  const desde = ultimo ? new Date(ultimo.counted_at).toISOString() : null;
  const movs = (await trx.raw(`
    SELECT d.pieza, d.sentido, d.tipo, d.clase, d.monto, d.banco, d.numero, d.de_quien, d.concepto,
           to_char(d.fecha, 'YYYY-MM-DD') AS fecha,
           to_char((l.created_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS dia
      FROM finance.cash_ledger_documentos d
      JOIN finance.cash_ledger l ON l.id = d.cash_ledger_id
     WHERE d.tenant_id = ? AND d.tipo = ? AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       ${desde ? 'AND l.created_at > ?::timestamptz' : ''}
     ORDER BY l.created_at, d.created_at, d.id`, desde ? [tenantId, tipo, desde] : [tenantId, tipo])).rows as Array<Record<string, unknown>>;
  for (const r of movs) {
    const pieza = String(r['pieza']);
    if (r['sentido'] === 'sale') { enCaja.delete(pieza); continue; }
    enCaja.set(pieza, {
      pieza, tipo, clase: (r['clase'] ?? null) as DocumentoEnCaja['clase'], monto: Number(r['monto']),
      banco: (r['banco'] ?? null) as string | null, numero: (r['numero'] ?? null) as string | null,
      de_quien: String(r['de_quien']), concepto: (r['concepto'] ?? null) as string | null,
      fecha: (r['fecha'] ?? null) as string | null, visto_desde: String(r['dia']),
    });
  }
  return [...enCaja.values()];
}

/**
 * `[CGS.60]` El último arqueo de la Suite que contó un apartado, lo que ese arqueo vio (`propios`) y
 * lo que hay ahora (`piezas`: más lo que entró y menos lo que salió con movimientos después). UNA
 * función para el arqueo y para el alta de un movimiento: los dos ven la misma caja.
 */
export async function piezasEnCaja(trx: Knex.Transaction, tenantId: string, tipo: TipoDocumentoCaja): Promise<{
  ultimo: { id: string; counted_at: string; quien: string | null; total: number } | null;
  propios: DocumentoEnCaja[];
  piezas: DocumentoEnCaja[];
}> {
  const campo = tipo === 'cheque' ? 'cheques' : 'papeles';
  const ult = await trx('finance.cash_arqueos').where({ tenant_id: tenantId }).whereNotNull(campo)
    .orderBy([{ column: 'counted_at', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first('id', 'counted_at', 'created_by_username', campo);
  const ultimo = ult
    ? { id: String(ult.id), counted_at: new Date(ult.counted_at).toISOString(), quien: (ult.created_by_username ?? null) as string | null, total: Number(ult[campo]) }
    : null;
  const propios = ultimo ? (await documentosQueEstan(trx, tenantId, ultimo.id)).filter((d) => d.tipo === tipo) : [];
  const piezas = await documentosEnCaja(trx, tenantId, tipo, ultimo, propios);
  return { ultimo, propios, piezas };
}

/**
 * `[CGS.60]` La huella de los movimientos con documentos (alta o cancelación): si cambia entre que
 * se abre el arqueo y se guarda, la lista de «lo que había» ya no es la de ahora. Va en la llave
 * contra dos conteos a la vez, junto con el último arqueo.
 */
export async function huellaDeDocumentosDeMovimiento(trx: Knex.Transaction, tenantId: string): Promise<string> {
  if (!(await hayDocumentosDeMovimiento(trx))) return '';
  const r = (await trx.raw(`
    SELECT coalesce(to_char(max(greatest(l.created_at, l.updated_at)), 'YYYY-MM-DD"T"HH24:MI:SS.US'), '') AS h,
           count(DISTINCT d.cash_ledger_id)::int AS n
      FROM finance.cash_ledger_documentos d
      JOIN finance.cash_ledger l ON l.id = d.cash_ledger_id
     WHERE d.tenant_id = ?`, [tenantId])).rows[0] as { h: string; n: number };
  return `${r.h}#${r.n}`;
}
