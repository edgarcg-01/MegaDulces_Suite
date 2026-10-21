import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[CG.121]` — **Las tres pantallas del efectivo, en pestañas.**
 *
 * Pedido de Edgar (2026-10-19): *"necesito un selector en caja (captura) donde yo seleccione si
 * quiero capturar, expediente o caja fuerte, y que todas vivan en un solo módulo"*.
 *
 * Eran tres renglones sueltos del menú —y el Expediente no estaba ni en el menú ni en las
 * pestañas de Finanzas: se llegaba sólo escribiendo la URL—. Ahora son UNA entrada, «Caja», y
 * adentro se cambia con la barra de arriba. Es el patrón de Gastos (`gastos-tabs.ts`) y Pagos
 * (`pagos-tabs.ts`).
 *
 * ── El orden NO es alfabético: es el recorrido del dinero ──────────────────────────────────
 *
 *   Captura → se registra el movimiento contra su documento del ERP, contando piezas.
 *   Expediente → a la mañana siguiente se revisa si el corte coincide con lo que hay en la caja.
 *   Caja Fuerte → la bóveda física (CAOS), de donde sale y a donde vuelve el efectivo.
 *
 * ── ⛔ Cada pestaña lleva EL MISMO permiso que su ruta ──────────────────────────────────────
 *
 * Copiado de `app.routes.ts`, no inventado. Una pestaña con un gate distinto al de su ruta falla
 * de las dos maneras y ninguna avisa: más floja, ofrece una pantalla que al abrirse manda a
 * `/sin-acceso`; más dura, esconde una pantalla que la persona sí puede abrir.
 *
 * ⚠️ Lo que eso implica, dicho para que no se lea como descuido: **Captura y Expediente no
 * tienen el mismo público.** La ruta de Captura admite `VER`, `GESTIONAR` o `AUTORIZAR`; la del
 * Expediente exige `VER` a secas. Quien tenga sólo `GESTIONAR` captura pero no ve el expediente,
 * y la barra se lo va a reflejar. No se empareja acá: emparejarlo es cambiar un permiso de una
 * ruta, y eso se decide en el árbol de authz, no en una barra de pestañas.
 *
 * ⚠️ `/finanzas/caja-general/firma` NO es pestaña a propósito: es la pantalla del TELÉFONO del
 * mostrador, se entra por el código de seis que muestra la caja, y el teléfono se le presta a
 * quien viene a firmar. Una pestaña ahí la pondría al alcance de un clic desde la PC, que es
 * justo lo contrario de para qué existe.
 */
export const CAJA_TABS: readonly PageTab[] = [
  {
    // `[CG.14]` La mitad que ESCRIBE el libro. Espejo de `anyPermissionGuard` en la ruta.
    label: 'Captura',
    route: '/finanzas/caja-general',
    icon: 'pi pi-pencil',
    anyOf: [
      Permission.FINANCE_CAJA_VER,
      Permission.FINANCE_CAJA_GESTIONAR,
      Permission.FINANCE_CAJA_AUTORIZAR,
    ],
  },
  {
    /**
     * ⭐⭐ `[CGS.2]` **Arqueos** — y es UNA pestaña donde había dos.
     *
     * Edgar, 2026-10-20, en dos pedidos del mismo día: *«en historial tengo que hacer scroll
     * hasta abajo para ver los arqueos; hagamos una pestaña extra que diga Arqueos»* y después
     * *«Expediente y Arqueos es lo mismo, hay que fusionarlos»*.
     *
     * ⛔ **Y tenía razón en que eran lo mismo**: las dos contestaban la revisión de la mañana con
     * la mitad de la respuesta cada una. El Expediente enseñaba los movimientos del día sin decir
     * si el arqueo cuadró; el arqueo decía si cuadró sin enseñar con qué. Ahora es una fila por
     * día y un solo cajón con las tres preguntas en orden.
     *
     * Va SEGUNDA, pegada a Captura: lo que motivó la pestaña es que el arqueo estaba al fondo de
     * la pantalla de Captura, y mandarla al final de la barra sería mover el scroll de sitio.
     *
     * ⚠️ Mismo permiso que su ruta (`FINANCE_CAJA_VER`), copiado de `app.routes.ts`. Una pestaña
     * con un gate distinto al de su ruta falla de las dos maneras y ninguna avisa.
     *
     * ⛔ `exact` queda en su default (true) y eso importa: esta ruta CUELGA de la de Captura. Con
     * `exact: false` en Captura, las dos pestañas se encenderían a la vez estando acá, y la barra
     * dejaría de decir dónde estás — que es lo único que la barra hace.
     */
    label: 'Arqueos',
    route: '/finanzas/caja-general/arqueos',
    icon: 'pi pi-check-square',
    permission: Permission.FINANCE_CAJA_VER,
  },
  {
    // `[CS.2]` La bóveda física (dispositivo AST700). Permiso PROPIO, no el de Caja General:
    // es otro circuito de efectivo, y así está declarado en `permissions.ts`.
    label: 'Caja Fuerte',
    route: '/finanzas/caos',
    icon: 'pi pi-lock',
    permission: Permission.FINANCE_CAOS_VER,
  },
];
