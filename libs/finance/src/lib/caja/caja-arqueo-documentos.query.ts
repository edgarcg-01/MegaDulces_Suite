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
