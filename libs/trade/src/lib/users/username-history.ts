import type { Knex } from 'knex';

/**
 * `[AU.34]` Dónde vive un username COMO LLAVE — lo que se rompería si se renombra.
 *
 * La cuenta tiene `id`, pero varias tablas guardan el **username en texto** y después lo
 * buscan, lo comparan o lo cruzan con Kepler. Renombrar una cuenta que aparece en ellas no
 * falla: deja de encontrar lo suyo en silencio. Medido en el código el 2026-11-06:
 *
 *   · El username ES el código de cajero de Kepler (`upper(username) = upper(cajero_code)`):
 *     la cajera renombrada pierde sus cortes y su arqueo.
 *   · La caja «Solicita» de un gasto en Kepler trae nuestro username: deja de ver sus vales.
 *   · `esDuenoDelVale` compara `created_by` (texto) con el username de hoy: renombrada,
 *     **puede aprobar su propio vale**. Lo mismo en comprobantes de pago y presupuestos.
 *   · La entrega de compras sólo la acepta `recipient_username`: queda sin quién la reciba.
 *
 * Por eso el renombre sólo se permite a una cuenta que no aparece en ninguna. Las ~45
 * columnas `*_by_username` que sólo GUARDAN historia no cuentan: ahí el nombre viejo es lo
 * correcto (era su nombre cuando lo hizo).
 *
 * El remedio de fondo es que esas columnas guarden el `user_id` y que el código de Kepler
 * viva en una tabla que lo ligue con la persona. Queda como deuda con nombre en `[AU.34]`.
 */
export interface ChequeoDeUsuario {
  /** Estable: viaja en la respuesta y la pantalla la usa. */
  clave: string;
  /** Lo que lee quien administra: por qué ESTO impide renombrar. */
  etiqueta: string;
  /** `schema.tabla`. Constante del catálogo, nunca dato del usuario. */
  tabla: string;
  columnas: readonly string[];
  /**
   * La columna guarda «persona» (`full_name || username`, a veces con `link:` o espacios de más) y
   * se compara con la normalización de `esDuenoDelVale`. Sin la marca se compara `upper(btrim())`:
   * códigos de Kepler y usernames, que ya vienen limpios — y dos regex por fila menos.
   */
  persona?: boolean;
  /**
   * Columna legada que puede no existir en este ambiente (la base nueva la quitó). Si no
   * existe no puede guardar el username: no hay nada que revisar. Una NO opcional que falta
   * es lo contrario —no se pudo medir— y el renombre se rechaza.
   */
  opcional?: boolean;
}

export const CHEQUEOS_DE_USUARIO: readonly ChequeoDeUsuario[] = [
  { clave: 'kepler_cajero', etiqueta: 'es un código de cajero en Kepler', tabla: 'analytics.pos_cashiers', columnas: ['cajero_code'] },
  { clave: 'kepler_cortes', etiqueta: 'cerró cortes de caja en Kepler', tabla: 'analytics.cash_cuts', columnas: ['cajero_cierre'] },
  { clave: 'arqueos', etiqueta: 'tiene arqueos (conteo ciego) a su nombre', tabla: 'reconciliation.blind_counts', columnas: ['cajero_code'] },
  { clave: 'kepler_solicita', etiqueta: 'aparece en «Solicita» de gastos de Kepler', tabla: 'analytics.expense_requests', columnas: ['solicitante'] },
  { clave: 'vales', etiqueta: 'creó, comprobó o autorizó vales de gasto', tabla: 'finance.expense_proofs', columnas: ['created_by', 'evidencia_por', 'validated_by'], persona: true },
  { clave: 'comprobantes_pago', etiqueta: 'subió comprobantes de pago a proveedor', tabla: 'finance.supplier_payment_proofs', columnas: ['created_by'], persona: true },
  { clave: 'presupuestos', etiqueta: 'creó presupuestos', tabla: 'budget.budgets', columnas: ['created_by'], persona: true },
  { clave: 'entregas', etiqueta: 'recibe entregas de compras', tabla: 'commercial.purchase_deliveries', columnas: ['recipient_username'] },
  { clave: 'tareas_maat', etiqueta: 'tiene tareas de conciliación asignadas', tabla: 'finance.recon_tasks', columnas: ['assigned_to_username'] },
  { clave: 'capturas', etiqueta: 'tiene capturas de visita', tabla: 'public.daily_captures', columnas: ['captured_by_username'], opcional: true },
];

/** Identificador SQL seguro: sólo minúsculas, dígitos y `_`. Se valida, no se escapa. */
const IDENT = /^[a-z_][a-z0-9_]*$/;

export function partesDeTabla(tabla: string): { schema: string; nombre: string } {
  const [schema, nombre] = tabla.split('.');
  if (!nombre || !IDENT.test(schema) || !IDENT.test(nombre)) throw new Error(`[AU.34] tabla inválida en el catálogo: ${tabla}`);
  return { schema, nombre };
}

/**
 * Con `persona`, la misma normalización que `normalizarPersona` (contracts/finance/dueno-del-vale):
 * sin el prefijo `link:`, sin espacios en los bordes ni dobles, en mayúsculas. Sin ella, mayúsculas
 * y sin bordes, como compara el código que usa esas columnas (`upper(username) = upper(cajero_code)`).
 */
export function expresionNormalizada(columna: string, persona = false): string {
  if (!IDENT.test(columna)) throw new Error(`[AU.34] columna inválida en el catálogo: ${columna}`);
  return persona
    ? `upper(regexp_replace(btrim(regexp_replace("${columna}", '^\\s*link:', '', 'i')), '\\s+', ' ', 'g'))`
    : `upper(btrim("${columna}"))`;
}

export interface HistoriaDeUsuario {
  /** Dónde aparece: si hay al menos uno, no se renombra. */
  encontrados: Array<{ clave: string; etiqueta: string }>;
  /** Tablas que debían existir y no se pudieron revisar: tampoco se renombra (NO MEDIDO ≠ limpio). */
  sinRevisar: Array<{ clave: string; etiqueta: string; motivo: string }>;
}

/**
 * Revisa el catálogo para `username` en el tenant. ⚠️ Filtra `tenant_id` EXPLÍCITO en cada
 * consulta: la conexión de `UsersService` es superusuario y se salta RLS, así que sin el
 * filtro vería otros tenants (y con RLS sin contexto vería CERO filas, que se leería como
 * «no tiene historia» — el error que esto existe para evitar).
 */
export async function buscarHistoriaDeUsuario(
  db: Knex | Knex.Transaction,
  tenantId: string,
  username: string,
): Promise<HistoriaDeUsuario> {
  const historia: HistoriaDeUsuario = { encontrados: [], sinRevisar: [] };

  const pares = CHEQUEOS_DE_USUARIO.flatMap((c) => {
    const { schema, nombre } = partesDeTabla(c.tabla);
    return [...c.columnas, 'tenant_id'].map((col) => `${schema}.${nombre}.${col}`);
  });
  const existentes = new Set<string>(
    (
      await db.raw(
        `SELECT table_schema || '.' || table_name || '.' || column_name AS k
           FROM information_schema.columns
          WHERE (table_schema || '.' || table_name || '.' || column_name) IN (${pares.map(() => '?').join(', ')})`,
        pares,
      )
    ).rows.map((r: { k: string }) => r.k),
  );

  const buscado = username.trim().toUpperCase();
  for (const c of CHEQUEOS_DE_USUARIO) {
    const { schema, nombre } = partesDeTabla(c.tabla);
    const faltan = [...c.columnas, 'tenant_id'].filter((col) => !existentes.has(`${schema}.${nombre}.${col}`));
    if (faltan.length) {
      if (!c.opcional) historia.sinRevisar.push({ clave: c.clave, etiqueta: c.etiqueta, motivo: `falta ${c.tabla}(${faltan.join(', ')})` });
      continue;
    }
    const condicion = c.columnas.map((col) => `${expresionNormalizada(col, !!c.persona)} = ?`).join(' OR ');
    try {
      // En su propio savepoint: dentro de la transacción del renombre, una consulta que falla
      // abortaría todo lo demás. Fuera de una transacción, `transaction()` abre una corta.
      const hay = await db.transaction(async (sp) => {
        const r = await sp.raw(
          `SELECT EXISTS (SELECT 1 FROM "${schema}"."${nombre}" WHERE tenant_id = ? AND (${condicion})) AS hay`,
          [tenantId, ...c.columnas.map(() => buscado)],
        );
        return !!r.rows[0]?.hay;
      });
      if (hay) historia.encontrados.push({ clave: c.clave, etiqueta: c.etiqueta });
    } catch (e) {
      historia.sinRevisar.push({ clave: c.clave, etiqueta: c.etiqueta, motivo: (e as Error).message.slice(0, 160) });
    }
  }
  return historia;
}
