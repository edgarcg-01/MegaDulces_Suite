import { z } from 'zod';

/**
 * Schemas Zod para validar la estructura de columnas JSONB.
 *
 * Objetivo: reemplazar los blobs libres del legacy (role_permissions.permissions,
 * daily_captures.exhibiciones, daily_captures.stats, scoring_config.config) por
 * shapes tipados que se validen en serializers de NestJS.
 *
 * Uso típico:
 *   const parsed = PermissionsJsonbSchema.parse(req.body.permissions);
 *   // o .safeParse() para no lanzar
 *
 * Mantener estos schemas SINCRONIZADOS con:
 *   - apps/api/src/shared/constants/permissions.ts (enum Permission)
 *   - Cualquier columna JSONB nueva → agregar schema acá
 */

// ─────────────────────────────────────────────────────────────────────────────
// role_permissions.permissions
// ─────────────────────────────────────────────────────────────────────────────
// Object con keys del enum Permission y valores boolean. Las claves NO listadas
// se descartan (whitelist en service). Por eso es Record<string, boolean>
// permisivo en Zod — la whitelist real está en catalogs.service.ts.
export const PermissionsJsonbSchema = z.record(z.string(), z.boolean());
export type PermissionsJsonb = z.infer<typeof PermissionsJsonbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// daily_captures.exhibiciones
// ─────────────────────────────────────────────────────────────────────────────
// Array de exhibiciones evaluadas. Shape derivado del código actual de
// daily-captures.service + captures.component.
export const ExhibicionItemSchema = z.object({
  // IDs de catalogo (UUID strings)
  posicion_id: z.string().uuid().optional(),
  exhibicion_id: z.string().uuid().optional(),
  nivel_ejecucion_id: z.string().uuid().optional(),

  // Nombres denormalizados (compat con frontend legacy)
  posicion: z.string().optional(),
  tipo: z.string().optional(),
  nivelEjecucion: z.string().optional(),

  // Productos exhibidos (UUIDs)
  productos: z.array(z.string()).optional(),

  // Foto
  fotoUrl: z.string().url().optional(),
  fotoPublicId: z.string().optional(),

  // Scoring computado al momento
  score: z.number().optional(),
  scoreMaximo: z.number().optional(),
  is_own_brand: z.boolean().optional(),

  // Notas libres del capturista
  notas: z.string().optional(),
}).passthrough(); // permite keys extras desconocidas (compat hacia delante)

export const ExhibicionesJsonbSchema = z.array(ExhibicionItemSchema);
export type ExhibicionesJsonb = z.infer<typeof ExhibicionesJsonbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// daily_captures.stats — KPIs agregados de la visita
// ─────────────────────────────────────────────────────────────────────────────
export const StatsJsonbSchema = z.object({
  totalExhibiciones: z.number().int().nonnegative().optional(),
  totalScore: z.number().optional(),
  scoreMaximo: z.number().optional(),
  porcentajeEjecucion: z.number().min(0).max(100).optional(),
  productosUnicos: z.number().int().nonnegative().optional(),
  fotosPresentes: z.number().int().nonnegative().optional(),
}).passthrough();
export type StatsJsonb = z.infer<typeof StatsJsonbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// scoring_config.config — config legacy single-row
// ─────────────────────────────────────────────────────────────────────────────
export const ScoringConfigJsonbSchema = z.object({
  pesos_posicion: z.record(z.string(), z.number()).optional(),
  factores_tipo: z.record(z.string(), z.number()).optional(),
  niveles_ejecucion: z.record(z.string(), z.number()).optional(),
}).passthrough();
export type ScoringConfigJsonb = z.infer<typeof ScoringConfigJsonbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// tenants.metadata — espacio libre por tenant
// ─────────────────────────────────────────────────────────────────────────────
export const TenantMetadataSchema = z.record(z.string(), z.unknown());
export type TenantMetadata = z.infer<typeof TenantMetadataSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// commercial.customers.billing_address / shipping_address
// ─────────────────────────────────────────────────────────────────────────────
// Dirección postal MX. Todos los campos opcionales (perfil progresivo: a veces
// solo tenemos calle + colonia al alta y completamos después).
export const AddressJsonbSchema = z.object({
  street: z.string().max(200).optional(),
  exterior_number: z.string().max(20).optional(),
  interior_number: z.string().max(20).optional(),
  neighborhood: z.string().max(150).optional(),    // colonia
  city: z.string().max(150).optional(),            // municipio
  state: z.string().max(100).optional(),           // estado
  zip: z.string().regex(/^\d{5}$/).optional(),      // CP MX = 5 dígitos
  country: z.string().length(2).default('MX').optional(), // ISO 3166-1 alpha-2
  reference: z.string().max(300).optional(),       // referencia ("frente al OXXO")
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).passthrough();
export type AddressJsonb = z.infer<typeof AddressJsonbSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helper de validación que retorna { ok, data, errors }
// ─────────────────────────────────────────────────────────────────────────────
export function validateJsonb<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { ok: true; data: T } | { ok: false; errors: string[] } {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  };
}
