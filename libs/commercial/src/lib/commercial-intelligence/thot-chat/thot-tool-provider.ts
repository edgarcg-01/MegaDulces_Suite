/**
 * TC-S (ADR-026) — Perfiles de Thot Chat. El loop conversacional es agnóstico;
 * cada audiencia (admin / portal / vendor) provee su catálogo de tools, su prompt
 * y su SCOPE. El scope se deriva del JWT en el controller y se IMPONE server-side:
 * el LLM jamás elige cliente/almacén fuera de su alcance.
 */

export interface ThotToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export type ThotProfile = 'admin' | 'portal' | 'vendor';

export interface ThotScope {
  profile: ThotProfile;
  /** Portal: el cliente dueño del JWT (obligatorio). Todo se filtra a este id. */
  customerId?: string | null;
  /** Vendor: user id del vendedor (para su cartera). */
  vendorUserId?: string | null;
  /** Almacén de surtido fijo (portal+vendor = PH/MD-10). Disponibilidad sale de acá. */
  warehouseCode?: string | null;
  /** Nombre para el saludo. */
  userName?: string | null;
}

/** Contrato que implementa cada perfil. */
export interface ThotToolProvider {
  /** Catálogo de tools visible para este scope. */
  definitions(scope: ThotScope): ThotToolDef[];
  /** Ejecuta una tool respetando el scope (RLS + filtros server-side). */
  execute(name: string, input: any, scope: ThotScope): Promise<any>;
  /** System prompt de la audiencia. */
  systemPrompt(scope: ThotScope, ctx: { today: string }): string;
}

/** Almacén de surtido para portal y vendor (Sucursal Hidalgo). Configurable. */
export const PH_FULFILLMENT_WAREHOUSE = process.env.THOT_FULFILLMENT_WAREHOUSE || 'MD-10';
