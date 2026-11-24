/**
 * `[COT.55]` El valor por defecto de «Solo precio 1 (sin mayoreo)» de un cliente de Kepler.
 *
 * Dato propio de la Suite (`commercial.customer_pricing_prefs`): el maestro de clientes de Kepler
 * (`kdud`) no tiene nivel de precio. La llave es la de Kepler, (sucursal, clave del cliente), la
 * misma que guarda la cotización. Sin fila = false (el cobro de siempre, con mayoreo).
 */

type ConRaw = { raw: (sql: string, bindings?: Record<string, unknown>) => PromiseLike<{ rows: Record<string, unknown>[] }> };

export interface PrecioListaCliente {
  branch: string;
  erp_customer_code: string;
  list_price_only: boolean;
  /** Quién y cuándo lo dejó así; null si nunca se configuró. */
  updated_at: string | null;
  updated_by_name: string | null;
}

const clave = (code: string) => String(code ?? '').trim().toUpperCase();

export async function precioListaDelCliente(k: ConRaw, branch: string, erpCode: string): Promise<PrecioListaCliente> {
  const b = String(branch ?? '').trim();
  const c = clave(erpCode);
  const r = await k.raw(
    `SELECT p.list_price_only, to_char(p.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS updated_at,
            coalesce(nullif(btrim(u.nombre), ''), u.username) AS updated_by_name
       FROM commercial.customer_pricing_prefs p
       LEFT JOIN identity.users u ON u.id = p.updated_by
      WHERE p.branch = :b AND p.erp_customer_code = :c AND p.deleted_at IS NULL
      LIMIT 1`,
    { b, c },
  );
  const f = r.rows[0];
  return {
    branch: b,
    erp_customer_code: c,
    list_price_only: f?.['list_price_only'] === true,
    updated_at: (f?.['updated_at'] as string | undefined) ?? null,
    updated_by_name: (f?.['updated_by_name'] as string | undefined) ?? null,
  };
}

/** Upsert por (tenant, sucursal, cliente). El tenant lo pone la sesión (RLS + `current_tenant_id()`). */
export async function fijarPrecioListaDelCliente(
  k: ConRaw, tenantId: string, branch: string, erpCode: string, valor: boolean, userId: string | null,
): Promise<void> {
  await k.raw(
    `INSERT INTO commercial.customer_pricing_prefs (tenant_id, branch, erp_customer_code, list_price_only, created_by, updated_by)
     VALUES (:t, :b, :c, :v, :u, :u)
     ON CONFLICT (tenant_id, branch, erp_customer_code) WHERE deleted_at IS NULL
     DO UPDATE SET list_price_only = EXCLUDED.list_price_only, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    { t: tenantId, b: String(branch ?? '').trim(), c: clave(erpCode), v: valor, u: userId },
  );
}
