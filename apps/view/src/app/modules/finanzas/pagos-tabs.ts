import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[TP.20.3]` — **Las cuatro pantallas de Pagos, en pestañas** (objetivo O5).
 *
 * En el menú eran cuatro renglones sueltos con nombres que se parecen —*Pagos a proveedor*,
 * *Pronto pago*, *Calendario de pagos*, *Programa de pagos*— y que hacen cosas distintas: dos
 * miran lo ya pagado, una el plazo que vence y una lo que se va a pagar. Juntarlas en una entrada
 * con pestañas dice que son un ciclo, no cuatro reportes.
 *
 * Esta lista la leen dos lugares y por eso vive una sola vez: la barra (`PagosTabsComponent`) y
 * la entrada del menú (`layout.component.ts`), que lleva a la primera pestaña visible y se marca
 * activa en las cuatro.
 *
 * ⛔ **No hay un shell de ruta, a diferencia de «Gastos» (`[GX.80]`), y es una decisión medida:**
 * el área Gastos ya ocupa el único padre con `path: ''` que `/finanzas` puede tener al final —el
 * que «matorra» cualquier URL restante— y meter un segundo padre vacío arriesga que
 * `/finanzas/mis-gastos` deje de resolver. Eso **no se puede comprobar sin levantar la app**, que
 * en este repo está prohibido. La barra se embebe en cada una de las cuatro pantallas: una línea
 * por pantalla contra el riesgo de romper cuatro que están en uso.
 *
 * ⚠️ El orden es el del ciclo del dinero, no alfabético: **se debe → se programa → se paga → se
 * audita**. Pronto pago va primero porque es el único con fecha límite; lo demás espera.
 */
export const PAGOS_TABS: readonly PageTab[] = [
  {
    // `[PP.1]` Lo que todavía se puede ganar, y hasta cuándo. El único con reloj.
    label: 'Pronto pago',
    route: '/finanzas/pronto-pago',
    icon: 'pi pi-bolt',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    // Fase TP — lo único que PLANEA: qué se paga cada día y quién lo autorizó.
    label: 'Calendario de pagos',
    route: '/finanzas/calendario-pagos',
    icon: 'pi pi-calendar',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    // Fase CC (ext.) — el expediente de evidencia de lo que ya salió.
    label: 'Pagos a proveedor',
    route: '/finanzas/pagos-comprobantes',
    icon: 'pi pi-send',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    // Fase PP — el libro de Tesorería: qué se pagó y qué no está asentado en Kepler.
    label: 'Programa de pagos',
    route: '/finanzas/programa-pagos',
    icon: 'pi pi-book',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
];
