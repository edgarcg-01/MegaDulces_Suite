import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[FCU.3]` — **Logística › Costos y reportes › Costo por unidad, en pestañas.**
 *
 * Lo que hacía la hoja «TRANSPORTES 2026 - COSTOS DE TRANSPORTE», con pantalla (regla de la fase:
 * «todo debe tener pantalla»). Cada pestaña contesta UNA pregunta:
 *
 *  · **Unidades** — ¿cuánto cuesta cada unidad contra lo presupuestado, y por km? (con su ficha y
 *    su detalle, renglón por renglón, al abrirla).
 *  · **Gastos sin unidad** — ¿qué gastos de flota de Kepler todavía no sé de qué unidad son?
 *  · **Presupuesto** — ¿cuánto se presupuestó por unidad y rubro? (lo que hoy dice la hoja).
 *  · **Nómina administrativa** — ¿cuánto cuesta el personal administrativo y cómo se reparte?
 *    (dato sensible: sólo quien gestiona).
 *  · **Reposición** — ¿cuánto pierde una unidad por año y por km, contra reponerla?
 *
 * La leen cada pantalla (su barra), el menú lateral (una sola entrada) y su prueba.
 */
export const COSTO_UNIDAD_TABS: readonly PageTab[] = [
  { label: 'Unidades', route: '/logistica/costo-unidad/unidades', icon: 'pi pi-truck', permission: Permission.LOGISTICS_COSTO_UNIDAD_VER },
  { label: 'Gastos sin unidad', route: '/logistica/costo-unidad/pendientes', icon: 'pi pi-inbox', permission: Permission.LOGISTICS_COSTO_UNIDAD_VER },
  { label: 'Presupuesto', route: '/logistica/costo-unidad/presupuesto', icon: 'pi pi-table', permission: Permission.LOGISTICS_COSTO_UNIDAD_VER },
  { label: 'Nómina administrativa', route: '/logistica/costo-unidad/nomina', icon: 'pi pi-briefcase', permission: Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR },
  { label: 'Reposición', route: '/logistica/costo-unidad/reposicion', icon: 'pi pi-chart-line', permission: Permission.LOGISTICS_COSTO_UNIDAD_VER },
];
