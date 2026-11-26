import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { Permission } from '../../core/constants/permissions';

/**
 * `[PQ.3.23]` El apartado «Proveedores» de Compras (DC32, anexo C §9): la relación con el proveedor en un
 * solo lugar. Lo decidieron la jefa de compras, Edgar y Francisco el 2026-11-24 y nace del Calendario de
 * compras, que es su primer apartado.
 *
 * Los cinco apartados acordados, y dónde está cada uno:
 *  - **Calendario** — `/compras/calendario` (PQ.3.2–PQ.3.22): EXISTE.
 *  - **Citas** — `/compras/citas`: la agenda de reuniones con el proveedor (PQ.3.8): EXISTE. Las visitas por WhatsApp
 *    (PQ.3.13) y la invitación (PQ.3.12) entran sobre ella.
 *  - **Revisión** — la revisión de negocio y su ficha (PQ.3.9): por construir.
 *  - **Acuerdos** — lo pactado, con dueño y fecha, y el plan de trabajo anual (PQ.3.10, PQ.3.11): por construir.
 *  - **Listas de precios** — la del proveedor, con su vigencia y cada cambio autorizado (PQ.155, anexo P):
 *    por construir; hoy sólo hay una ruta de marcador en Catálogo (`/compras/catalogo/listas-precios`).
 *
 * ⛔ **Sólo es pestaña lo que existe** (`[PF.12.1]`): una pestaña que abre «Contenido por desarrollar» le
 * miente a quien entra (medido en Catálogo el 2026-10-29). Cada apartado se agrega AQUÍ cuando tenga
 * pantalla, y el sidebar, la barra y la migaja lo toman de esta lista. Con una sola pestaña la barra no se
 * pinta (`app-page-tabs` la esconde) y la entrada del menú lleva directo al Calendario.
 *
 * `[AUD-A5]` El conjunto se llama «Proveedores» y ninguna de sus pestañas se llama así: la migaja toma la
 * etiqueta del sidebar. Por lo mismo, la pestaña de Parámetros de compra que se llamaba «Proveedores» pasa a
 * «Por proveedor» (dos lugares del mismo menú con el mismo nombre).
 */
export const PROVEEDORES_LABEL = 'Proveedores';

export const PROVEEDORES_TABS: PageTab[] = [
  {
    label: 'Calendario',
    route: '/compras/calendario',
    icon: 'pi pi-calendar-clock',
    // Las tres llaves del calendario (DC7): quien sólo consulta, quien marca y quien define reglas.
    anyOf: [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR, Permission.COMPRAS_CALENDARIO_CICLO],
  },
  {
    label: 'Citas',
    route: '/compras/citas',
    icon: 'pi pi-users',
    // `[PQ.3.8]` Quien consulta (Dirección) y quien agenda (Compras, Mercadotecnia y Tesorería; DC41). Quien sólo tiene
    // estas llaves entra al apartado por aquí: la entrada del menú abre su primera pestaña visible.
    anyOf: [Permission.COMPRAS_CITAS_VER, Permission.COMPRAS_CITAS_AGENDAR],
  },
];
