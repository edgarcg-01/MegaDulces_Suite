/**
 * [GX.9] Familias contables del reporte de EGRESOS (`/finanzas/egresos`).
 *
 * ADR-056: la etiqueta de una familia se define UNA vez. Antes vivía duplicada a
 * mano en tres lugares (el `CASE` de `expenses()`, el `famLabel()` de
 * `expensesTree()` y el selector del componente) y por eso una familia nueva
 * salía en pantalla como `'1'` / `'7'` pelado.
 *
 * El ALCANCE de cuentas que entra a `analytics.expense_entries` lo aplica el
 * importer `database/importers/kepler/import-expenses-polizas.js` (es SQL contra
 * Kepler, no corre en TS); acá se documenta para que las dos mitades no se
 * separen en silencio.
 *
 * Verificado contra `kepler_ods.kdc126` (plan de cuentas, 2026-09-11):
 *   150 = ACTIVO NO CIRCULANTE   · subcuentas 150-001..150-011 (mobiliario,
 *         equipo de cómputo/reparto, terrenos, edificio, licencias de software)
 *   511 = COMPRAS
 *   6xx = GASTOS
 *   701 = PRODUCTOS FINANCIEROS  ← INGRESO: queda FUERA a propósito
 *   702 = GASTOS FINANCIEROS     · 760 IMPUESTOS · 761 ISR · 762 IMPUESTO SOBRE
 *         NÓMINAS · 763 IMPUESTO CEDULAR · 764 PTU DEL EJERCICIO
 */

/** Primer dígito de la cuenta contable = familia. */
export type ExpenseFamilia = '1' | '5' | '6' | '7';

/** Etiqueta de pantalla por familia. Fuente única (service + frontend). */
export const EXPENSE_FAMILIA_LABEL: Record<ExpenseFamilia, string> = {
  '1': 'Activo no circulante',
  '5': 'Compras / Costo',
  '6': 'Gastos',
  '7': 'Financieros e impuestos',
};

/** Etiqueta corta para chips/leyendas donde no cabe la larga. */
export const EXPENSE_FAMILIA_SHORT: Record<ExpenseFamilia, string> = {
  '1': 'Activo',
  '5': 'Compra',
  '6': 'Gasto',
  '7': 'Financiero',
};

/** Clave de la serie mensual (`ExpenseSeriesPoint`) por familia. */
export const EXPENSE_FAMILIA_SERIES_KEY: Record<ExpenseFamilia, 'activo' | 'compras' | 'gastos' | 'financiero'> = {
  '1': 'activo',
  '5': 'compras',
  '6': 'gastos',
  '7': 'financiero',
};

/** Orden de presentación (mayor peso primero, como se leen en el P&L). */
export const EXPENSE_FAMILIA_ORDER: ExpenseFamilia[] = ['5', '6', '7', '1'];

/**
 * Etiqueta de una familia; devuelve el código pelado si llega una desconocida
 * (ADR-056: lo que no se sabe se DECLARA, no se inventa).
 */
export function expenseFamiliaLabel(f: string | null | undefined): string {
  if (!f) return '(sin familia)';
  return EXPENSE_FAMILIA_LABEL[f as ExpenseFamilia] ?? f;
}
