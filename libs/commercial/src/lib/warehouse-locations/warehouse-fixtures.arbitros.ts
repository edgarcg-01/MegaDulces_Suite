/**
 * `[UB.PL.14]` Los árbitros de `ON CONFLICT` de las caras del croquis.
 *
 * Viven en su propio archivo, **sin una sola dependencia**, por la misma razón que
 * `clasificar-migraciones.awk` vive aparte: para poder probarlos. Importar el servicio desde una
 * prueba arrastra NestJS entero y la prueba ni siquiera llega a correr.
 */

/**
 * El árbitro del `ON CONFLICT` al darle a una pieza las caras que le tocan.
 *
 * ⛔ **El `WHERE` no es decoración.** `commercial_faces_slot_unico` es un índice **parcial**, y
 * Postgres sólo lo acepta como árbitro si la cláusula repite su predicado exacto. Sin él, el
 * insert muere con *«there is no unique or exclusion constraint matching the ON CONFLICT
 * specification»*, y eso dejó el croquis **muerto para escritura un día entero en producción**
 * —derivar, crear una pieza y agregar una cara, los tres en 500— invisible porque el único botón
 * que lo dispara estaba escondido.
 */
export const ARBITRO_CARA_POR_SLOT = '(tenant_id, fixture_id, slot) WHERE deleted_at IS NULL';
