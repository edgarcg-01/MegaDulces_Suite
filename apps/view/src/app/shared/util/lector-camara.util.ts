/**
 * `[VTK.17]` Los dos apagados del lector de códigos se movieron a `@megadulces/ui-web`
 * (`camara/lector-codigos.ts`), con su prueba, para que la app de vendedores los use sin copiarlos.
 *
 * Este archivo queda como reexportación para no tocar a los cuatro lectores de esta app
 * (levantamiento/caducidades, andén, verificador, conteo). Lo de fondo —por qué hay dos `stop()` en
 * zxing 0.2 y por qué un `try/catch` no alcanza— está documentado allá, junto al código.
 */
export { controlesSiSigueAbierta, detenerLector } from '@megadulces/ui-web';
