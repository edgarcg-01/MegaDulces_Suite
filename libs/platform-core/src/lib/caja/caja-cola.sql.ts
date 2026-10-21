/**
 * ⭐⭐ `[CGA-A.49]` — **La cola de captura de Caja General, definida UNA vez.**
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────────────────
 *
 * «Lo que Kepler ya registró en la caja y el libro todavía no aplicó» se contaba en TRES lugares,
 * con tres reglas distintas. Medido en prod el 2026-10-20 sobre la misma vista
 * (`finance.v_caja_movimientos_pendientes`):
 *
 *     la bandeja de /finanzas/caja-general      106   $1,551,543.33   (desde 1-oct, sin lo saldado
 *                                                                      por Control ni lo declarado
 *                                                                      desde CAOS)
 *     el aviso horario (campana, [CGP-L.13])     60     $755,819.29   (desde el 1er corte, SIN
 *                                                                      quitar lo declarado desde CAOS)
 *     «Mi trabajo» de tesorería                1,782  $16,182,680.78   (ventana de 45 días: toda la
 *                                                                      era Control, ya saldada)
 *
 * La responsable de la caja abría «Mi trabajo» y veía **diecisiete veces** el trabajo real — una
 * bandeja que no se puede vaciar se deja de mirar. Y la campana avisaba de 9 documentos que ya
 * estaban capturados desde la caja fuerte.
 *
 * ⭐ Vive en `platform-core` por la misma razón que `ejercicio-prueba.sql.ts`: la consumen
 * `libs/finance` (bandeja y sensor) y `libs/trade` (el registro de «Mi trabajo»), que no se
 * pueden importar entre sí. Copiarla es cómo nacieron los tres números.
 *
 * ── Lo que NO entra acá, a propósito ────────────────────────────────────────────────────────
 *
 * El rezago de la era Control (del 1 del mes del relevo al día anterior al primer corte, menos lo
 * que el Control ya saldó — `[CGA-A.44]`) se decide con el casamiento por importe del Cuadre
 * (`casarPorImporte`, voraz, en TypeScript). Repetirlo en SQL sería una segunda implementación
 * del mismo algoritmo. Por eso la cola DIARIA —la que avisa y la que ve «Mi trabajo»— es la del
 * libro (desde el primer corte), y la bandeja publica el rezago de Control APARTE, con su número.
 */

/**
 * **El documento de Kepler NO se capturó ya desde la caja fuerte (CAOS).**
 *
 * La vista excluye lo capturado por su propia identidad (`origen_ref`). Lo que no puede ver es lo
 * capturado desde la OTRA fuente del mismo efectivo: un movimiento de CAOS que declara el
 * documento — por llave (`declared_doc_ref`, `[CGA-A.10]`) o, sólo lo histórico sin llave, en la
 * glosa (`[CG.85]`). El `origen_tipo = 'caos'` no es cosmético (`[CGA-A.9]`): sin él, el folio de
 * una camioneta escondía el cobro de otra.
 *
 * @param alias cómo se llama la vista en la consulta que lo usa. Se interpola como identificador
 *   —lo elige el llamador, no es entrada de usuario—, igual que `branchKeySql`.
 */
export const cajaNoCapturadaDesdeCaosSql = (alias = 'v_caja_movimientos_pendientes'): string =>
  `NOT EXISTS (SELECT 1 FROM finance.cash_ledger yac
                WHERE yac.tenant_id = ${alias}.tenant_id
                  AND yac.deleted_at IS NULL AND yac.estado <> 'cancelado'
                  AND yac.origen_tipo = 'caos'
                  AND (yac.declared_doc_ref = ${alias}.origen_ref
                       OR (yac.declared_doc_ref IS NULL
                           AND yac.glosa LIKE ${alias}.doc_tipo || ' ' || ${alias}.folio || '%')))`;

/**
 * **La cola DIARIA: lo pendiente desde el primer corte del libro hasta hoy.**
 *
 * · Desde el PRIMER corte (`finance.cash_ledger_cuts`): lo anterior es la era Control y va aparte.
 *   Sin ningún corte no hay cola del libro, y la condición deja todo fuera — el llamador declara
 *   eso como «sin libro», no como «al día».
 * · Hasta HOY en México: lo fechado a futuro es un error de Kepler (`[CG.28]`), se cuenta aparte.
 * · Sin lo ya capturado desde CAOS (`cajaNoCapturadaDesdeCaosSql`).
 *
 * ⚠️ El primer corte se busca con `current_tenant_id()` y NO correlacionado con la fila: medido el
 * 2026-10-20, la versión correlacionada (`c.tenant_id = v.tenant_id`) se ejecutaba **13,385 veces**
 * —una por fila de la vista— y tardaba ~88 ms; así es un `InitPlan` que corre una vez. Exige lo
 * mismo que la vista: `app.tenant_id` fijado en la sesión (sin él la vista ya devuelve 0 filas, y
 * los llamadores lo guardan antes de contar).
 */
export const cajaColaDelLibroSql = (alias = 'v_caja_movimientos_pendientes'): string =>
  `${alias}.fecha_valor >= (SELECT min(c.fecha) FROM finance.cash_ledger_cuts c WHERE c.tenant_id = public.current_tenant_id())
   AND ${alias}.fecha_valor <= (now() AT TIME ZONE 'America/Mexico_City')::date
   AND ${cajaNoCapturadaDesdeCaosSql(alias)}`;
