/**
 * `[MOS.1]` — Lo que el buscador del mostrador sabe hacer con el catálogo.
 *
 * ⭐ `[VTK.17]` **El código se movió a `@megadulces/ui-web` (`precios/catalogo-mostrador.ts`), con su
 * spec**, para que el checador de precios de la app de vendedores busque y cuente la caja con LA
 * MISMA regla que este verificador. Este archivo sólo reexporta, para no tocar a sus tres
 * importadores (`verificador.service`, `tienda-caja`, `faltante-express`).
 *
 * En la librería los tipos del respaldo son estructurales (`ui-web` no depende de otras librerías);
 * acá se fijan a los del contrato, que es lo que esta app ya usaba: `Buscable` es el de
 * `VerificadorSnapshotItem`, así `b.item.m` sigue siendo el mayoreo compacto que `expandirTier` lee.
 */
import type { VerificadorSnapshotItem } from '@megadulces/contracts';
import type { Buscable as BuscableLib, Coincidencia as CoincidenciaLib } from '@megadulces/ui-web';

export {
  aBuscable, buscarEnCatalogo, escalonesDe, presentacionesDe, tramoNormal,
  singularDe, pluralDe, nombreDe, ETIQUETA_CAMPO,
} from '@megadulces/ui-web';
export type {
  CampoCoincidencia, Escalon, UnidadConFactor, PresentacionMostrador as Presentacion,
} from '@megadulces/ui-web';

export type Buscable = BuscableLib<VerificadorSnapshotItem>;
export type Coincidencia = CoincidenciaLib<VerificadorSnapshotItem>;

