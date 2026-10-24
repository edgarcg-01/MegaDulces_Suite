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
/**
 * `[PGP.7]` **De cuatro pestañas a dos, y el motivo se midió el 2026-10-23.**
 *
 * Pedido de Edgar ese día: *«calendario de pagos, pronto pago, programa de pagos… hacen lo
 * mismo»*. Tenía razón, y el inventario que decía lo contrario (`FASE_TP` §23, del 19-oct)
 * estaba **vencido**: se midió ANTES de que `[TP.20.4]` llevara al Calendario los campos que
 * justificaban tener Pronto pago aparte.
 *
 * | Pestaña | Su dato, medido contra prod el 2026-10-23 |
 * |---|---|
 * | **Programa de pagos** | el Excel importado: **76 días sin cargar** (última: 2026-08-08) |
 * | **Pronto pago**, mitad retrospectiva | 98 hallazgos, **55 días sin producir** (el detector calló el 29-ago) y los 98 sin triar |
 * | **Pronto pago**, mitad prospectiva | ya viaja al Calendario: límite, beneficio, estado y —desde `[PGP.7]`— la tasa |
 *
 * ⭐ O sea: **dos de las cuatro pestañas mostraban dato muerto**, y la tercera ya estaba
 * adentro de la primera.
 *
 * ⛔ **Lo que el §23 sí tenía bien, y por eso no se fusiona a lo bruto:** las dos listas ordenan
 * al revés —el Calendario agrupa por beneficiario porque un pago es UNA transferencia; Pronto
 * pago no puede agrupar porque cada factura tiene su propia fecha límite—. Pero eso justifica
 * **un orden alternativo**, no una pantalla: `[PGP.7]` lo resuelve con el parámetro `orden` en
 * la lista de obligaciones, que es el mismo listado leído por urgencia de descuento.
 *
 * ⚠️ **Las rutas siguen vivas.** Salen del menú, no del router — mismo criterio que `[GX.80]`
 * con «Levantamiento de gasto» y el «Tablero de gastos»: quien las tenga en marcadores las
 * sigue abriendo, y lo que estaba congelado se puede volver a mirar. Lo que cambia es que
 * nadie llega a ellas creyendo que son parte del trabajo diario.
 */
export const PAGOS_TABS: readonly PageTab[] = [
  {
    // Fase TP — el único lugar donde se hace un pago: qué se paga cada día, quién lo preparó y
    // quién lo autorizó. Desde `[PGP.7]` también dice qué factura pierde descuento y cuándo.
    label: 'Calendario de pagos',
    route: '/finanzas/calendario-pagos',
    icon: 'pi pi-calendar',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
  {
    // Fase CC (ext.) — el expediente de evidencia de lo que ya salió. NO se absorbe: es la otra
    // mitad del ciclo (comprobar), y su fusión con el libro sigue bloqueada por falta de llave
    // (el libro no guarda el folio del pago de Kepler — `FASE_TP` §23).
    label: 'Pagos a proveedor',
    route: '/finanzas/pagos-comprobantes',
    icon: 'pi pi-send',
    permission: Permission.FINANCE_PAYMENTS_VER,
  },
];
