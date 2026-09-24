import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import {
  CAJA_VENTANA_DIAS,
  type MeDesgloseItem,
  type MeFlujo,
  type MeVeredicto,
} from '@megadulces/contracts';
import { branchKeySql } from '@megadulces/platform-core';

/**
 * `[SN.7]` — El registro de BANDEJAS de trabajo pendiente que alimenta `GET /users/me/work`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * La landing mostraba a qué proyectos podés ENTRAR. No decía qué te toca HACER. Este registro es
 * la lista de colas de trabajo que la suite ya construyó (y que ya tienen su pantalla), con su
 * conteo de pendientes al momento y la ruta que las resuelve.
 *
 * ── ⚠️ `[SN.15]` Corrección de una medición vencida ─────────────────────────────────────────
 * Acá decía —y la landing publicaba— que las tres tablas de asignación nominal estaban en CERO
 * filas (medición del 2026-09-10). **Era falso.** Medido de nuevo el 2026-09-11 contra prod:
 * `finance.recon_tasks` 15 abiertas · `commercial.supervisor_tasks` 2 · `inventory_count_
 * assignments` 18 · `trade.daily_assignments` 119 → **151 tareas vivas sobre 38 de 118 personas**.
 * La frase «Nadie te asignó trabajo hoy» mentía para un tercio del padrón.
 *
 * Lo asignado se mudó a `me-tasks.ts`, que es donde vive la tercera pregunta. Este archivo se
 * queda con las otras dos, y **la regla que las separa** (`work/task.contract.ts`) es:
 *
 *   > El PERMISO decide si podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO; la TAREA dice que
 *   > alguien te lo asignó. **Una cola sin `assigned_to` no es una tarea: es una bandeja.**
 *
 * Por eso `conteos-asignados` YA NO ESTÁ ACÁ: su fila trae `assigned_by`, o sea que alguien te la
 * repartió — es una tarea. Lo que queda es:
 *   · `'mio'`     — trabajo propio que esta persona EMPEZÓ (nadie se lo asignó): su borrador.
 *   · `'bandeja'` — cola COMPARTIDA que abre su permiso. Nadie la repartió.
 *
 * ── Reglas duras ────────────────────────────────────────────────────────────────────────────
 *  1. `anyOf` DEBE ser el permiso que gatea `ruta`. Si no, el número lleva a un rebote — el mismo
 *     defecto que `landing-guards.spec.ts` encontró en tres destinos. Lo verifica el **bloque 4 de
 *     `database/tests/test-newdb-me-context.js`** contra `app.routes.ts`.
 *     ⚠️ Acá decía "y `me-work.spec.ts`": ese archivo NO EXISTE, y `libs/trade` no tiene runner de
 *     pruebas (sólo `lint`), así que crearlo habría sido una prueba huérfana más — la Fase VP contó
 *     21. Los candados de este registro viven todos en el smoke, que sí corre en `run-all-tests.js`.
 *  2. Un conteo es información: sólo se cuenta la bandeja cuyo permiso tiene la persona.
 *  3. Lo que no se pudo contar se DECLARA (`no_medido` con motivo), nunca baja a 0 — un cero
 *     dibujado se lee igual que "estás al día" (ADR-056).
 *  4. Una bandeja en 0 NO se pinta. La pantalla no tiene cajas vacías.
 *  5. `responsabilidad` es la MISMA clave que `identity.responsibilities` (catálogo de `[OR.1b]`).
 *     Eran dos vocabularios para las mismas ocho colas (`cuadre` acá, `almacen.cuadre` allá) sin
 *     mapeo en código; sin esta columna, el día que `[OR.3]` enrute no va a poder cruzar.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS (igual que `ReportsService`/`CommercialMapService`), así
 * que el aislamiento es por filtro `tenant_id` EXPLÍCITO en cada conteo. No usar TenantKnexService.
 */

export type AlcancePendiente = 'mio' | 'bandeja';

/**
 * Las claves de `identity.responsibilities` (`[OR.1b]`). Las 8 primeras corresponden 1:1 con las
 * bandejas y lo verifica el candado; las dos de conciliación las agrega `[SN.17]` y pertenecen a
 * ciclos, no a bandejas — por eso el candado de biyección las excluye explícitamente.
 */
export type ResponsabilidadKey =
  | 'finanzas.hallazgos'
  | 'finanzas.acciones'
  | 'almacen.cuadre'
  | 'compras.reabasto'
  | 'almacen.conteo'
  | 'tienda.caducidades'
  | 'logistica.flota'
  | 'comercial.thot'
  | 'finanzas.caja'
  | 'finanzas.conciliacion_ingresos'
  | 'finanzas.conciliacion_egresos'
  | 'sistemas.salud_datos'
  | 'finanzas.cartera'
  | 'compras.entradas';

/**
 * `[SN.15]` Lo que cada conteo necesita saber de quién pregunta.
 *
 * `sucursales` viene de `ScopeService` (dimensión `warehouse`, ADR-050) y son **códigos**
 * (`'00'..'06'`, `'MD-30'`), que es lo que guarda la ficha — las tablas guardan el uuid del
 * almacén, así que el filtro pasa por `commercial.warehouses`.
 *
 * ⛔ `null` significa **"no acotar"**, y cubre dos casos que NO se deben confundir con "nada":
 * alcance `all`, y una ficha sin sucursal (`resolvable: false`). Medido en prod: el **74%** de
 * quienes ven la bandeja de reabasto no tienen `warehouse_code`. Si a esa gente se le acotara a
 * `[]`, vería **0** y leería "estoy al día" — el default disfrazado que ADR-056 prohíbe. Un array
 * vacío nunca llega acá: se convierte en `null` y la fila se rotula "de toda la red".
 */
export interface MedirCtx {
  tenantId: string;
  userId: string;
  sucursales: string[] | null;
}

/**
 * `[SN.12]` Lo que una bandeja reporta. El `total` solo no alcanza para ordenar: el orden por
 * volumen pone 1,865 descuadres arriba y 5 alertas de flota abajo, cuando un vehículo sin señal
 * probablemente urge más. `mas_viejo_at` es el segundo dato —cuándo entró el pendiente más
 * antiguo— y es lo que convierte una lista en una prioridad. `null` = no se pudo medir; se
 * DECLARA, no se asume "reciente" (ADR-056).
 */
export interface MedidaCola {
  total: number;
  mas_viejo_at: string | null;
  /** `[SN.29]` Entradas contra salidas, de la misma pasada. */
  flujo: MeFlujo;
}

/**
 * `[SN.29]` Lo que una bandeja necesita declarar para que su flujo se pueda medir en UNA consulta.
 *
 * El registro pasa de entregar una consulta YA filtrada al estado abierto, a entregar la consulta
 * BASE más el predicado del estado. Es lo que permite contar, en la misma pasada, las que están
 * abiertas y las que ya salieron — sin una segunda consulta por bandeja (serían 6 más por request,
 * y `workFor` cuenta en serie).
 */
export interface EjesCola {
  /** Columna de estado (`'status'`, `'estado'`, o `'f.status'` cuando hay JOIN). */
  estadoCol: string;
  /**
   * Valor que significa «abierto» (`'nuevo'`, `'pending_approval'`, `'open'`, `'draft'`).
   *
   * `[SN.32]` **`null` = abierto es «`estadoCol` está vacía»**, no «el estado es NULL». Es el
   * segundo patrón real de la casa: `analytics.db_health_alerts` no tiene columna de estado
   * abierto/cerrado —su `status` es `warn|critical`, o sea la GRAVEDAD— y lo que marca la salida
   * es `resolved_at IS NULL`. Ahí `estadoCol` y `cierre` son la MISMA columna, y eso es correcto.
   *
   * ⛔ Se generaliza el helper en vez de escribirle una medición a mano a esa bandeja: los cinco
   * contadores tienen que significar lo mismo en todas las colas. Cada `medir` propio es una
   * oportunidad de que `entradas_7d` cuente una cosa acá y otra allá, sin que nadie lo note.
   */
  estadoAbierto: string | null;
  /** Columna de entrada. La misma que ordenaba antes (`'created_at'`, `'f.created_at'`). */
  fecha: string;
  /**
   * Columna que marca la SALIDA del estado abierto.
   *
   * ⛔ `null` = esta fuente no puede contestar cuántas salieron, y entonces `cerradas_30d` viaja
   * `null` — **nunca 0**, que es la afirmación contraria («nadie cerró ninguna»). Hoy ninguna de
   * las seis está en ese caso, pero la rama existe porque `logistics.fleet_alerts` sí carece de
   * `updated_at` y estuvo a un `??  0` de mentir.
   *
   * ⚠️ Se declara por bandeja porque la columna precisa NO es siempre `updated_at`, y dos de las
   * candidatas obvias están MUERTAS (medido en prod, 30 días): `commercial_actions.approved_at`
   * devuelve 0 con 376 filas cerradas, y `fleet_alerts.acknowledged_at` devuelve 0 con 10,339.
   * Elegir «la que suena bien» habría declarado congeladas dos colas sanas.
   */
  cierre: string | null;
  /**
   * `[SN.36]` Predicado SQL extra que se exige **sólo del lado ABIERTO**, nunca del cerrado.
   *
   * ── Por qué no alcanza con filtrar la consulta base ──────────────────────────────────────
   * `finance.findings` es una bandeja que un detector **reconfirma cada día**: si un cliente deja
   * de tener saldo vencido, su hallazgo **no se cierra** — simplemente deja de refrescarse y
   * queda en `nuevo` para siempre. Medido en prod el 2026-09-22: de las **680** filas en `nuevo`
   * de `cxc_cliente_vencido`, **40 no las vio el detector hoy** (la más rezagada del 25-ago). Son
   * casos que ya no existen y que inflarían la cola un 6%.
   *
   * ⛔ Poner ese filtro en la consulta BASE rompería `cerradas_30d`: un hallazgo que alguien
   * triageó deja de refrescarse por definición, así que el filtro lo excluiría y la cola saldría
   * **`congelada` siempre**, incluso trabajándola a diario. Sería exactamente la mentira que
   * `[SN.29]` fue a matar, con el signo invertido.
   *
   * ⛔ Y tampoco se filtra por «`last_seen` de los últimos N días»: el día que el detector no
   * corra, **todas** quedan rezagadas y la cola publica **0** — el cero disfrazado de ADR-056.
   * El predicado correcto ancla en la ÚLTIMA PASADA del propio detector (`max(last_seen)`): si no
   * corrió, el número se queda quieto en vez de desaparecer.
   *
   * `undefined` = sin predicado extra, que es el caso de las nueve bandejas anteriores.
   */
  abiertaExtra?: { sql: string; args: readonly (string | number)[] };
}

export interface BandejaDef {
  id: string;
  label: string;
  detalle: string;
  ruta: string;
  icono: string;
  alcance: AlcancePendiente;
  /** La misma cola en el catálogo de `[OR.1b]`. Un solo vocabulario para las dos mitades. */
  responsabilidad: ResponsabilidadKey;
  /**
   * `true` si la tabla tiene columna de sucursal y el conteo SE ACOTA cuando la ficha lo permite.
   * La pantalla lo usa para rotular honestamente: acotado, o "de toda la red".
   * Medido en la mig `20260911140000`: sólo 3 de las 8 colas tienen eje, y de esas, 2 ya filtran
   * por persona — así que la única que gana algo real acá es el reabasto.
   */
  acotablePorSucursal: boolean;
  /** Cualquiera de estas claves abre la bandeja. Debe coincidir con el guard de `ruta`. */
  anyOf: readonly Permission[];
  /**
   * `[SN.18]` Si está presente, la bandeja **NO se cuenta ni se muestra**, y el texto dice por qué.
   *
   * Se apaga acá en vez de borrar la entrada a propósito: una bandeja retirada sigue teniendo su
   * ruta, su permiso y su responsabilidad, y el día que la fuente sea confiable se prende quitando
   * una línea. Borrarla perdería el mapeo y el motivo — y el motivo es lo que evita que alguien la
   * vuelva a agregar dentro de tres meses sin saber por qué se había quitado.
   *
   * ⛔ Retirar la bandeja **no le quita el acceso a nadie**: la pantalla sigue abierta por su
   * puerta en el espacio que la aloja.
   */
  retirada?: string;
  /**
   * `[SN.29]` **Cuántos días puede esperar el más viejo antes de contar como atrasado.**
   *
   * Es POLÍTICA, no medición, y por eso cada valor lleva su motivo pegado abajo. Se cambia en una
   * línea y no hay que tocar nada más — igual que el umbral de un feed en `CRON_JOBS`.
   *
   * ⛔ **Obligatorio en toda bandeja viva.** Sin umbral, `veredictoDe` no puede emitir `atrasada`
   * y la cola se pinta `al_dia` para siempre: el `cfg ? classify : 'ok'` que la Fase VP encontró
   * dando verde incondicional a las matvistas del sell-out. El bloque 4g del smoke lo vigila, con
   * su prueba negativa.
   */
  umbral_dias: number;
  medir: (knex: Knex, ctx: MedirCtx) => Promise<MedidaCola>;
  /**
   * `[SN.33]` **Opcional: nombrar las filas que forman el total.**
   *
   * Sólo se declara donde el QUÉ importa más que el CUÁNTO y el total es chico por naturaleza.
   * ⛔ No se agrega «porque se puede»: desglosar una cola de miles mudaría su pantalla a la
   * portada, y la regla de `[SN.7]` es que acá va el número y el enlace.
   *
   * Recibe `tope` y devuelve a lo sumo esas filas. **Cuántas quedaron fuera NO se calcula acá**:
   * lo hace `workFor` restando contra el `total` que `medir` ya midió, que es el único número que
   * puede decirlo exacto. Recortar sin declararlo haría que «eso es todo» y «eso es lo que cabe»
   * se lean igual.
   */
  desglosar?: (knex: Knex, ctx: MedirCtx, tope: number) => Promise<MeDesgloseItem[]>;
}

/**
 * `[SN.33]` Cuántas filas del desglose se pintan antes de resumir con «+N más».
 *
 * 8 no es un número redondo: la cola de salud llegó a **7** abiertas el día que se midió y su
 * régimen de 30 días fueron 764 entradas con 759 salidas, o sea que vive entre 0 y una decena.
 * Un tope de 8 muestra el caso normal entero y sólo recorta cuando de verdad hay una cascada —
 * que es justo cuando el detalle importa menos que el hecho de que se cayó todo.
 */
export const TOPE_DESGLOSE = 10;

/*
 * `[SN.39]` **Por qué 10 y ya no 8.** El 8 salía de la cola de salud, que vive entre 0 y una
 * decena — sigue siendo cierto y 10 la cubre mejor. Lo que obligó a moverlo es otra medición: el
 * desglose de entradas es **una fila por sucursal y hay NUEVE**, así que con tope 8 se caía una —
 * y al ordenar por lo que falta, la que se caía era `08`, **la que mejor va (78%)**. Un desglose
 * que existe para que cada auxiliar vea SU porcentaje y le esconde una sucursal entera no cumple
 * su único trabajo. Dos renglones más no le cuestan nada a las otras dos bandejas.
 */

/**
 * `[SN.39]` **Cuántos días atrás se le pide comprobante a una entrada de mercancía.**
 *
 * 90 días. El histórico completo son **12,634 entradas desde agosto-2024 con 2.33% de cobertura**:
 * arrastrarlo entero pondría doce mil renglones en la portada de cinco personas, por papeles que
 * ya no existen. Noventa días es lo que todavía se puede ir a buscar al archivero — y es la misma
 * ventana con la que se midió el 78% de `08` y el 37.5% de `01`, o sea la que ya usan.
 *
 * ⚠️ Vive ACÁ ARRIBA y no junto a su bandeja: el `detalle` la interpola en un template literal, y
 * el array `BANDEJAS` se construye al cargar el módulo. Declarada después, sería un `const` en
 * zona muerta temporal y el import entero reventaría con `ReferenceError`.
 */
const ENTRADAS_VENTANA_DIAS = 90;

/**
 * `[CC.10]` El recorte de la bandeja de abonos sin ligar. Mismo motivo que arriba para vivir
 * acá: el `detalle` los interpola y `BANDEJAS` se arma al cargar el módulo.
 *
 * **45 días y $10,000.** Medido en prod el 2026-09-24: sin recorte son **5,244 abonos por
 * $118,935,974.22** —el backlog completo, que no es trabajo de hoy—; con él, **1,838 por
 * $63,971,506.77**, que es el flujo del mes y sí se puede drenar. Bajar el monto o ampliar la
 * ventana convierte la bandeja en un número que nadie mira, que es cómo murió `[SN.18]`.
 */
const COBRANZA_VENTANA_DIAS = 45;
const COBRANZA_MIN_MONTO = 10000;

/**
 * Cuenta y fecha la cola en UNA sola pasada (`count(*)` + `min(<fecha>)`). Dos consultas por
 * bandeja duplicarían el trabajo de las ocho sin comprar nada: el filtro es el mismo.
 * `columnaFecha` se declara por bandeja porque en una cola con JOIN importa cuál de las dos
 * fechas es la que le habla a la persona.
 */
async function medirCola(knex: Knex, q: Knex.QueryBuilder, ejes: EjesCola): Promise<MedidaCola> {
  const { estadoCol, estadoAbierto, fecha, cierre, abiertaExtra } = ejes;
  /*
   * `[SN.29]` Los cinco contadores salen de UNA pasada con `FILTER`. Medido contra prod: la
   * consulta combinada cuesta 157-285 ms **incluyendo los ~154 ms de latencia a Railway**, o sea
   * lo mismo que la de dos contadores que reemplaza. La alternativa —una segunda consulta por
   * bandeja— habría sumado seis viajes en serie a la primera pantalla que todos abren.
   */
  /*
   * `[SN.32]` El predicado de «abierta» se arma una vez y se reusa en los cuatro contadores que
   * lo necesitan. Con `estadoAbierto: null` la pregunta deja de ser «¿el estado es tal?» y pasa a
   * ser «¿la columna de cierre está vacía?» — ver `EjesCola.estadoAbierto`.
   */
  const BASE_AB = estadoAbierto === null ? '?? is null' : '?? = ?';
  const CERRADA = estadoAbierto === null ? '?? is not null' : '?? <> ?';
  // La comparación va inline (y no contra un `porNulo` precalculado) porque es la que hace que
  // TypeScript estreche `estadoAbierto` a `string` en la rama que sí lo usa como binding.
  const baseAb: string[] = estadoAbierto === null ? [estadoCol] : [estadoCol, estadoAbierto];

  /*
   * `[SN.36]` El predicado extra se AÑADE al lado abierto y **no toca `CERRADA`**. Ver
   * `EjesCola.abiertaExtra`: lo que distingue «ya no aplica» de «alguien lo cerró» es
   * precisamente que el primero sigue en el estado abierto — si el mismo filtro pesara de los dos
   * lados, `cerradas_30d` daría 0 siempre y la cola se declararía congelada trabajándose a diario.
   */
  const ABIERTA = abiertaExtra ? `(${BASE_AB}) and (${abiertaExtra.sql})` : BASE_AB;
  const argsAb: (string | number)[] = abiertaExtra
    ? [...baseAb, ...abiertaExtra.args]
    : baseAb;

  const row = await q
    .clearSelect()
    .select(
      knex.raw(`count(*) filter (where ${ABIERTA}) as n`, argsAb),
      knex.raw(`min(??) filter (where ${ABIERTA}) as viejo`, [fecha, ...argsAb]),
      knex.raw(
        `count(*) filter (where ${ABIERTA} and ?? > now() - interval '7 days') as e7`,
        [...argsAb, fecha],
      ),
      knex.raw(`count(*) filter (where ?? > now() - interval '30 days') as e30`, [fecha]),
      cierre
        ? knex.raw(
            `count(*) filter (where ${CERRADA} and ?? > now() - interval '30 days') as c30`,
            // ⛔ `baseAb`, NO `argsAb`: `CERRADA` no lleva el predicado extra, así que tampoco
            // puede llevar sus bindings — con `argsAb` sobrarían y knex tiraría «Expected N».
            [...baseAb, cierre],
          )
        : // ⛔ `null`, NO `0`: la fuente no puede contestarlo. Son afirmaciones opuestas.
          knex.raw('null::int as c30'),
    )
    .first<{
      n: string | number;
      viejo: Date | string | null;
      e7: string | number | null;
      e30: string | number | null;
      c30: string | number | null;
    }>();

  const viejo = row?.viejo ?? null;
  /** `null` se preserva; sólo se convierte a número lo que de verdad vino. */
  const num = (v: string | number | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);

  return {
    total: Number(row?.n ?? 0),
    mas_viejo_at: viejo ? new Date(viejo).toISOString() : null,
    flujo: { entradas_7d: num(row?.e7), entradas_30d: num(row?.e30), cerradas_30d: num(row?.c30) },
  };
}

export const BANDEJAS: readonly BandejaDef[] = [
  // ── Trabajo propio: lo empezó esta persona, nadie se lo asignó ─────────────────────────────
  {
    id: 'caducidades-mias',
    label: 'Revisiones de caducidad a tu nombre',
    detalle: 'hojas de revisión que iniciaste y no has enviado',
    ruta: '/tienda/caducidades',
    icono: 'pi pi-clock',
    alcance: 'mio',
    responsabilidad: 'tienda.caducidades',
    // La tabla tiene `warehouse_id`, pero ya filtra por `responsible_user_id`: acotar por sucursal
    // no quitaría ni una fila y sí sugeriría una precisión que no aporta.
    acotablePorSucursal: false,
    // Es TU borrador y lo empezaste vos: una hoja de revisión abierta más de dos días ya perdió
    // el momento de la visita que la originó.
    umbral_dias: 2,
    anyOf: [Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR],
    medir: (knex, { tenantId, userId }) =>
      medirCola(
        knex,
        knex('commercial.expiry_reviews').where({
          tenant_id: tenantId,
          responsible_user_id: userId,
        }),
        { estadoCol: 'status', estadoAbierto: 'draft', fecha: 'created_at', cierre: 'submitted_at' },
      ),
  },

  // ── Colas compartidas ──────────────────────────────────────────────────────────────────────
  {
    id: 'cuadre',
    label: 'Descuadres por revisar',
    detalle: 'caja, inventario y cruce · sin clasificar todavía',
    // `[SM.9]` La pantalla se mudó a Finanzas. La CLAVE de responsabilidad se queda
    // como `almacen.cuadre` a propósito: está persistida en `identity.responsibilities`
    // y repartida a roles reales en prod (migs 20260911140000/220000, 20260918120000).
    // Renombrarla es una migración de datos, no un cambio de ruta — y el prefijo no es
    // la ubicación de la pantalla sino el nombre con el que ya se reparte el trabajo.
    ruta: '/finanzas/cuadre',
    icono: 'pi pi-exclamation-triangle',
    alcance: 'bandeja',
    responsabilidad: 'almacen.cuadre',
    acotablePorSucursal: false, // medido: la tabla NO tiene ninguna columna de ruteo
    // El cuadre de caja e inventario es semanal: un descuadre que cruza la semana ya no se puede
    // contrastar contra el turno que lo produjo.
    umbral_dias: 7,
    anyOf: [Permission.RECONCILIATION_VER],
    /*
     * ⚠️ **Esta cola sale `congelada` en prod, y no es un error de la regla.** Medido el
     * 2026-09-14: 2,409 abiertas de **2,409 filas totales** — ni una sola ha salido de `nuevo`
     * desde el 8-jul. `updated_at` es la única columna de cierre que la tabla tiene (no hay
     * `resolved_at`) y da 0 en 30 días. El veredicto lo va a decir en pantalla en vez de
     * publicar «2,409 pendientes» como si alguien los estuviera trabajando.
     */
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('reconciliation.discrepancies').where({ tenant_id: tenantId }), {
        estadoCol: 'status',
        estadoAbierto: 'nuevo',
        fecha: 'created_at',
        cierre: 'updated_at',
      }),
  },
  {
    id: 'finanzas-hallazgos',
    label: 'Hallazgos de finanzas sin triage',
    detalle: 'detectados por Maat · nadie los ha confirmado ni descartado',
    ruta: '/finanzas/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.hallazgos',
    acotablePorSucursal: false,
    /*
     * `[SN.18]` RETIRADA por decisión de Edgar (2026-09-12): *"por el momento quitemos hallazgos
     * como fuente principal, ya que falla mucho y no es confiable"*. Lo medido lo respalda:
     *
     *  · **82,377 en `nuevo`**, con el más viejo del **7-jul-2026** — 67 días sin que nadie
     *    confirme ni descarte. Una cola que nadie trabaja no es trabajo pendiente, es ruido.
     *  · Dominaba el titular: **82,377 de 82,569 = el 99.8%** de lo que la pantalla reportaba como
     *    pendiente para un auxiliar de finanzas. Las demás bandejas eran invisibles al lado.
     *  · La fuente tiene un defecto medido: **281 filas con el `periodo` corrupto** (`"Wed Sep"`,
     *    por `String(fecha).slice(0,7)` sobre un `Date` en `maat-detector.service.ts`), y esos
     *    hallazgos ni siquiera llegan a generar tarea de conciliación.
     *
     * ⛔ **Nadie pierde acceso**: la pantalla sigue abierta por su puerta en «Auditoría, Prevención
     * y Control». Lo que se retira es el CONTEO de la landing, no el módulo.
     *
     * Para volver a prenderla: borrar esta línea. Antes, arreglar el detector y triagear la cola.
     */
    retirada:
      'La fuente no es confiable todavía: 82,377 sin triage desde julio y 281 periodos corruptos.',
    umbral_dias: 7,
    anyOf: [Permission.FINANCE_AI_CHAT],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('finance.findings').where({ tenant_id: tenantId }), {
        estadoCol: 'status',
        estadoAbierto: 'nuevo',
        fecha: 'created_at',
        cierre: 'updated_at',
      }),
  },
  {
    id: 'maat-acciones',
    label: 'Acciones de finanzas por aprobar',
    detalle: 'propuestas de Maat esperando una decisión humana',
    ruta: '/finanzas/pagos-control',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.acciones',
    acotablePorSucursal: false,
    // Una propuesta de pago que espera tres días ya no sirve para decidir: el vencimiento, el
    // saldo y el tipo de cambio con los que se calculó se movieron.
    umbral_dias: 3,
    anyOf: [Permission.FINANCE_AI_CHAT],
    /*
     * ⚠️ También sale `congelada`, y también es cierto. Medido: 192 abiertas de 198 filas; las
     * únicas 6 que salieron se decidieron **todas el 6-ago** (3 ejecutadas, 3 rechazadas) y no ha
     * habido una más en 39 días. ⛔ `decided_at` existe y sería la columna semánticamente exacta,
     * pero da **0 en 30 días** igual que `updated_at`: acá las dos coinciden porque no hay nada
     * que contar. Se usa `updated_at`, que es la que no depende de que el flujo escriba bien.
     */
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('finance.proposed_actions').where({ tenant_id: tenantId }), {
        estadoCol: 'estado',
        estadoAbierto: 'pending_approval',
        fecha: 'created_at',
        cierre: 'updated_at',
      }),
  },
  {
    id: 'thot-acciones',
    label: 'Acciones comerciales por aprobar',
    detalle: 'propuestas de Thot esperando curación',
    ruta: '/comercial/thot-curation',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    responsabilidad: 'comercial.thot',
    acotablePorSucursal: false,
    // La acción comercial se propone contra la semana de venta que la disparó: pasada esa
    // ventana, curarla es archivar, no decidir.
    umbral_dias: 7,
    anyOf: [Permission.COMMERCIAL_THOT_GESTIONAR],
    /*
     * ⛔ **`approved_at` está MUERTA y habría declarado congelada una cola sana.** Medido en prod:
     * 376 filas salieron de `pending_approval` en 30 días y `approved_at > now()-30d` devuelve
     * **0** — nunca se escribe (o sólo en la rama de aprobación, que no es por donde salen). Es
     * el caso exacto por el que la columna de cierre se declara por bandeja y se verifica contra
     * el dato, en vez de elegir «la que suena bien».
     */
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('commercial.commercial_actions').where({ tenant_id: tenantId }), {
        estadoCol: 'status',
        estadoAbierto: 'pending_approval',
        fecha: 'created_at',
        cierre: 'updated_at',
      }),
  },
  {
    id: 'compras-hallazgos',
    label: 'Hallazgos de reabastecimiento',
    detalle: 'agotados y bajo reorden detectados en el barrido nocturno',
    ruta: '/compras/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    responsabilidad: 'compras.reabasto',
    /*
     * La ÚNICA cola que gana algo real con el acotado: 21,940 abiertos repartidos en 9 almacenes
     * (`00` 5,621 · `MD-30` 2,813 · `01` 2,709 · `06` 2,429 · `03` 2,249 …). Para quien tiene
     * sucursal en su ficha, el número pasa de "toda la red" a lo suyo.
     */
    acotablePorSucursal: true,
    // El barrido es nocturno: un agotado que sobrevive dos barridos es venta perdida, no cola.
    umbral_dias: 2,
    anyOf: [Permission.COMPRAS_HALLAZGOS_VER],
    medir: (knex, { tenantId, sucursales }) => {
      const q = knex('commercial.replenishment_findings as f').where({ 'f.tenant_id': tenantId });
      if (sucursales) {
        /*
         * La tabla guarda el uuid del almacén y la ficha guarda el código: el puente es
         * `warehouses`. ⚠️ Pero NO se une por `w.code`, sino por la LLAVE CANÓNICA (`[RE.23]`):
         * las 7 sucursales Kepler guardan `'00'..'06'` en `code`, y las de Morelia guardan
         * `'MD-30'`/`'MD-32'` con el código de 2 dígitos en `wincaja_source_branch`. Medido en
         * prod: la ficha de esas 2 personas dice `'30'`/`'32'`, así que `whereIn('w.code', …)`
         * les habría devuelto **0** teniendo 2,813 y 1,944 hallazgos — el cero disfrazado exacto
         * que esta fase existe para no dibujar.
         */
        q.join('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'f.warehouse_id').andOn('w.tenant_id', '=', 'f.tenant_id');
        }).whereRaw(
          `(${branchKeySql('w')}) IN (${sucursales.map(() => '?').join(', ')})`,
          sucursales,
        );
      }
      return medirCola(knex, q, {
        estadoCol: 'f.status',
        estadoAbierto: 'open',
        fecha: 'f.created_at',
        cierre: 'f.resolved_at',
      });
    },
  },
  {
    id: 'flota-alertas',
    label: 'Alertas de flota abiertas',
    detalle: 'sin señal o exceso de velocidad · sin acuse',
    ruta: '/logistica/rastreo',
    icono: 'pi pi-bell',
    alcance: 'bandeja',
    responsabilidad: 'logistica.flota',
    acotablePorSucursal: false,
    // Sin señal o exceso de velocidad son hechos del día de operación: al día siguiente ya no hay
    // a quién preguntarle qué pasó.
    umbral_dias: 1,
    anyOf: [Permission.LOGISTICS_FLEET_VER],
    /*
     * ⛔ Esta tabla **no tiene `updated_at`** — fue la que obligó a que `cierre` pudiera ser
     * `null` y a que `cerradas_30d` viaje `null` en vez de `0`. Sí tiene `resolved_at`, y es la
     * correcta: 7,202 resueltas en 30 días. ⚠️ `acknowledged_at` da **0** con 10,339 filas
     * cerradas: nadie acusa recibo, las cierra el propio scanner. La cola se drena, pero por
     * máquina — el veredicto mide la cola, no el esfuerzo humano, y no debe afirmar lo segundo.
     */
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('logistics.fleet_alerts').where({ tenant_id: tenantId }), {
        estadoCol: 'status',
        estadoAbierto: 'open',
        fecha: 'created_at',
        cierre: 'resolved_at',
      }),
  },
  {
    id: 'caja-por-confirmar',
    label: 'Movimientos de caja por confirmar',
    detalle: 'lo que Kepler ya registró en la caja y el libro todavía no aplicó',
    ruta: '/finanzas/caja-general',
    icono: 'pi pi-wallet',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.caja',
    acotablePorSucursal: false,
    /*
     * `[CG.21]` **3 días.** Medido sobre 673 movimientos que llevan la fecha del hecho en el
     * texto: la captura va **4.7 días** detrás del dinero en promedio, sólo el **11 %** entra el
     * mismo día y el peor caso fueron **34**. El umbral se pone POR DEBAJO del promedio actual a
     * propósito — la bandeja existe para bajarlo, así que calibrarlo en 5 sería declarar sano
     * justo el rezago que esta fase vino a eliminar.
     */
    umbral_dias: 3,
    anyOf: [Permission.FINANCE_CAJA_VER],
    /*
     * ⛔ **No usa `medirCola`, y no es capricho.** La fuente es una VISTA que por construcción sólo
     * tiene lo pendiente: no hay columna de estado que filtrar ni fecha de cierre que mirar. Las
     * salidas se cuentan del otro lado, en el libro.
     *
     * ⚠️⚠️ **El guard de tenant es el corazón de este bloque.** `medir` recibe el knex crudo, y
     * `finance.v_caja_movimientos_pendientes` filtra por `current_tenant_id()`: si la sesión no
     * trae tenant, la vista devuelve **0 filas sin error** y la bandeja publicaría "al día" sobre
     * una cola llena. Es exactamente el default disfrazado de ADR-056, y acá saldría con cara de
     * buena noticia. Preguntarlo primero convierte ese cero mudo en un `no_medido` declarado —
     * `workFor` atrapa el throw y lo reporta como lo que es: no se pudo medir.
     */
    medir: async (knex) => {
      const g = await knex.raw('select current_tenant_id() as t');
      if (!g.rows?.[0]?.t) {
        throw new Error(
          'La bandeja de caja se mide con RLS y la sesión no trae tenant: contar acá devolvería 0 '
          + 'sin error, y un 0 falso se lee como "al día".',
        );
      }
      /*
       * Los cinco contadores en UNA pasada, igual que `medirCola`. `e7`/`e30` son la ENTRADA (qué
       * tanto documento nuevo fecha Kepler) y `c30` el DRENAJE (cuánto se confirmó): dos lados de
       * la misma cola, y sin el segundo no se puede distinguir una bandeja que crece de una que
       * simplemente es grande.
       *
       * ⭐ **La ventana de 45 días no es cosmética.** Medido en prod el 2026-09-22: sin ella esta
       * bandeja publica **12,160 pendientes con el más viejo en 2025-01-01**, porque
       * `finance.cash_ledger` está vacío y entonces "sin aplicar" es todo lo que Kepler registró
       * desde que hay ODS. El número es cierto y la lectura es falsa: diría que la persona lleva
       * veinte meses de atraso sobre un libro que no existía. Lo anterior a la ventana es una
       * decisión de migración histórica, no trabajo del día, y se declara en la pantalla
       * (`fuera_de_ventana`), no acá.
       */
      const r = await knex.raw(`
        select (select count(*) from finance.v_caja_movimientos_pendientes
                 where fecha_valor >= now()::date - ${CAJA_VENTANA_DIAS})                         as n,
               (select min(fecha_valor) from finance.v_caja_movimientos_pendientes
                 where fecha_valor >= now()::date - ${CAJA_VENTANA_DIAS})                         as viejo,
               (select count(*) from finance.v_caja_movimientos_pendientes
                 where fecha_valor > now()::date - 7)                                             as e7,
               (select count(*) from finance.v_caja_movimientos_pendientes
                 where fecha_valor > now()::date - 30)                                            as e30,
               (select count(*) from finance.cash_ledger
                 where origen_tipo is not null and deleted_at is null and estado <> 'cancelado'
                   and created_at > now() - interval '30 days')                                   as c30`);
      const row = r.rows?.[0] ?? {};
      const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return {
        total: Number(row.n ?? 0),
        mas_viejo_at: row.viejo ? new Date(row.viejo).toISOString() : null,
        flujo: { entradas_7d: num(row.e7), entradas_30d: num(row.e30), cerradas_30d: num(row.c30) },
      };
    },
  },
  {
    id: 'salud-datos',
    label: 'Fuentes de datos con falla',
    detalle: 'bases, réplicas y feeds que dejaron de actualizarse · sin resolver',
    ruta: '/admin/db-health',
    icono: 'pi pi-database',
    alcance: 'bandeja',
    responsabilidad: 'sistemas.salud_datos',
    acotablePorSucursal: false,
    /*
     * `[SN.32]` **1 día.** Medido en prod el 2026-09-22 sobre las **758 alertas resueltas** en los
     * últimos 30 días: la mediana de vida es **0.5 h** y el percentil 90 **11.8 h** — o sea que
     * una alerta viva más de un día ya está fuera del régimen normal, no es «todavía fresca».
     * El promedio (8.06 h) y el máximo (30 días) muestran de dónde sale la diferencia: casi todas
     * se resuelven solas en el siguiente ciclo del feed, y las pocas que no, se quedan meses.
     *
     * ⚠️ Con este umbral la bandeja **nace `atrasada`**, y eso es correcto: hoy hay 6 abiertas y
     * la más vieja lleva desde el 12-sep. Subirlo para que se vea al día sería el
     * `cfg ? classify : 'ok'` de la Fase VP con otro sombrero.
     */
    umbral_dias: 1,
    anyOf: [Permission.USUARIOS_GESTIONAR],
    /*
     * ⛔ **La pantalla ya existe** (`[DBH.1]`, `/admin/db-health`: frescura por fuente + bandeja +
     * motor). Acá no se recalcula nada: se lee la MISMA tabla que esa pantalla publica, para que
     * el número de la portada y el de la pantalla no puedan discrepar.
     *
     * ⛔ `status` es **`warn|critical`**, o sea la GRAVEDAD, no el estado: lo que abre y cierra es
     * `resolved_at`. Por eso `estadoCol` y `cierre` son la misma columna y `estadoAbierto` va
     * `null`. Tomar `status` como estado habría contado las críticas como «abiertas» y las de
     * aviso como «cerradas» — un número verosímil y falso.
     *
     * ⚠️ El filtro por `tenant_id` es EXPLÍCITO porque este knex bypassa RLS (ver la cabecera).
     * Desde `[DBH.4]` el barrido corre bajo un solo tenant —el de plataforma—, así que en la
     * práctica es una sola familia de filas; el filtro queda igual, que es lo que hace el resto
     * del registro.
     *
     * ⚠️ Lo que esta cola NO ve, y se dice: las fuentes en `unknown` (no configuradas o no
     * alcanzables desde este backend) **no abren alerta** por decisión del scanner. No son falla
     * comprobada; salen declaradas en la pantalla, no contadas acá.
     *
     * ⚠️ **Deuda heredada de `medirCola`, medida acá porque acá se nota:** `entradas_7d` cuenta
     * sólo las que entraron en 7 días **y siguen abiertas**, mientras `entradas_30d` cuenta todas
     * las que entraron. En una cola que drena en 0.5 h de mediana eso se lee raro —medido contra
     * prod: **4 en 7 días contra 762 en 30**—, cuando las entradas reales de 7 días fueron 188.
     * No se corrige acá: la asimetría es del helper compartido y moverla cambiaría el flujo de las
     * nueve bandejas, que es otro commit y otra medición.
     */
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('analytics.db_health_alerts').where({ tenant_id: tenantId }), {
        estadoCol: 'resolved_at',
        estadoAbierto: null,
        fecha: 'first_seen_at',
        cierre: 'resolved_at',
      }),
    /*
     * `[SN.33]` **Un renglón por fuente, porque acá el QUÉ es la información.**
     *
     * Pedido de Edgar (2026-09-22): *«tienes que desglosarlo»*. Un «7» le dice a Sistemas cuánto,
     * no qué — y no es lo mismo que fallen dos réplicas de Wincaja a que falle el reconciliador
     * del ODS, que es el que decide si la venta publicada está completa.
     *
     * ⛔ **El orden es gravedad y después antigüedad, NO antigüedad sola.** Medido el 22-sep: las
     * dos más viejas (10 d) son de Wincaja y las dos que nacieron hoy son `cdc_reconcile` y la
     * foto de inventario — ordenar sólo por fecha manda al fondo lo que se rompió hace una hora.
     *
     * ⛔ La gravedad **no se deriva acá**: sale de `status`, que es lo único que esa columna
     * significa (`warn|critical`). Un `CASE` propio sería una segunda opinión sobre un dato que la
     * fuente ya emitió — y cuando un CASE mezcla dos preguntas, la precedencia le miente a una
     * (ADR-057).
     *
     * ⚠️ Una consulta MÁS por request, y sólo para esta bandeja. Se paga porque su cola vive entre
     * 0 y una decena de filas y el índice `idx_db_health_alerts_tenant_open` la cubre; ninguna otra
     * bandeja declara `desglosar` justamente para que esto no se vuelva N consultas.
     */
    desglosar: async (knex, { tenantId }, tope) => {
      const filas = await knex('analytics.db_health_alerts')
        .where({ tenant_id: tenantId })
        .whereNull('resolved_at')
        .orderByRaw(`case when status = 'critical' then 0 else 1 end`)
        .orderBy('first_seen_at', 'asc')
        .limit(tope)
        .select('source_key', 'source_label', 'status', 'first_seen_at', 'note');

      const items: MeDesgloseItem[] = filas.map((f) => ({
        id: String(f.source_key),
        // La etiqueta de la fuente es la que se lee; la clave técnica queda de respaldo, no de
        // texto por defecto: «wincaja_feed» no le dice nada a nadie fuera de Sistemas.
        label: String(f.source_label || f.source_key),
        // ⛔ Sin `?? 'warn'`: si algún día la fuente deja de declarar gravedad, se dice, no se
        // inventa la más benigna.
        nivel: f.status === 'critical' || f.status === 'warn' ? f.status : null,
        desde: f.first_seen_at ? new Date(f.first_seen_at).toISOString() : null,
        nota: f.note ? String(f.note) : null,
      }));
      return items;
    },
  },

  // ── `[SN.36]` Crédito y Cobranza ───────────────────────────────────────────────────────────
  /*
   * Las dos bandejas leen `finance.findings` y **no la vista viva de cartera**, y eso es una
   * decisión medida, no una comodidad:
   *
   *   · El agregado sobre `analytics.customer_receivables` cuesta **1,336 ms** de `Execution
   *     Time` (7,542 páginas) sólo para los contadores — más que todo el presupuesto de la
   *     portada, que la casa fija en **menos de 1 segundo**. Es una vista sobre `kepler_ods.kdue`:
   *     no hay índice que la salve, se materializa entera cada vez.
   *   · Contar los hallazgos cuesta **28 ms**.
   *   · Y no son dos verdades distintas: el detector calcula los hallazgos **desde esa misma
   *     vista**, a las 08:30 MX. Lo que se lee acá es esa cuenta, ya pagada.
   *
   * ⚠️ **El corte de $2,000 viaja en la etiqueta.** El detector sólo emite hallazgo cuando el
   * vencido del cliente supera `MIN_VENCIDO`, así que esta cola dice **680** donde la vista viva
   * dice **980 clientes con algún documento vencido**. No es un error: son dos preguntas. Por eso
   * el `detalle` nombra el piso — un número sin su corte al lado es el que después nadie puede
   * cuadrar contra la pantalla.
   *
   * ⛔ **NO se enlaza a `/finanzas/hallazgos`**, aunque sea la tabla de origen: esa bandeja está
   * `retirada` por `[SN.18]` con 82 mil filas sin triage, y mandar a Crédito y Cobranza ahí sería
   * darle la aguja y el pajar. El destino es `/finanzas/cartera`, que es donde se ve el saldo del
   * cliente, su aging y su teléfono — o sea donde se cobra.
   */
  {
    id: 'cartera-vencida',
    label: 'Clientes con saldo vencido por cobrar',
    detalle: 'más de $2,000 vencidos · confirmados en la última corrida del detector',
    ruta: '/finanzas/cartera',
    icono: 'pi pi-credit-card',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.cartera',
    acotablePorSucursal: false,
    /*
     * **7 días.** Una cuenta vencida que lleva una semana sin que nadie la toque dejó de ser
     * gestión de cobranza y pasó a ser riesgo de incobrable.
     *
     * ⚠️ La bandeja **nace `congelada`**, y es cierto: medido en prod el 2026-09-22, de los 680
     * hallazgos abiertos hay **0 triageados en 30 días** y 351 llevan más de un mes. Es lo que
     * pasa cuando una cola existe y nadie la tiene a cargo — que es justo lo que esta entrega
     * corrige. Subir el umbral para que se vea al día sería el `cfg ? classify : 'ok'` de la
     * Fase VP con otro sombrero.
     */
    umbral_dias: 7,
    anyOf: [Permission.FINANCE_RECEIVABLES_VER],
    /*
     * ⚠️ `mas_viejo_at` sale de `created_at`, que es **cuándo el detector vio esto por primera
     * vez**, no cuándo venció la factura. Son fechas distintas y la diferencia es grande: el
     * detector arrancó el 23-ago-2026, así que ningún hallazgo puede verse más viejo que eso
     * aunque el documento detrás venza desde 2025. La antigüedad REAL de la deuda viaja por
     * cliente en el desglose, que es donde se puede decir sin promediar dos cosas distintas.
     */
    medir: (knex, { tenantId }) =>
      medirCola(
        knex,
        knex('finance.findings').where({ tenant_id: tenantId, rule_key: 'cxc_cliente_vencido' }),
        {
          estadoCol: 'status',
          estadoAbierto: 'nuevo',
          fecha: 'created_at',
          // El triage de `/finanzas/hallazgos` escribe acá al confirmar o descartar.
          cierre: 'updated_at',
          abiertaExtra: ultimaPasadaDe(tenantId, 'cxc_cliente_vencido'),
        },
      ),
    desglosar: (knex, { tenantId }, tope) =>
      desglosarHallazgoCxc(knex, tenantId, 'cxc_cliente_vencido', tope),
  },
  {
    id: 'cartera-sobre-limite',
    label: 'Clientes que ya pasaron su línea de crédito',
    detalle: 'su saldo supera el límite de Kepler · revisar antes de venderles a crédito',
    ruta: '/finanzas/cartera',
    icono: 'pi pi-ban',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.cartera',
    acotablePorSucursal: false,
    /*
     * **3 días**, más corto que el de vencido a propósito: acá el daño no es el saldo que ya
     * existe sino el pedido de mañana. Un cliente sobre su línea que sigue comprando agranda el
     * problema todos los días; uno vencido sólo envejece.
     */
    umbral_dias: 3,
    anyOf: [Permission.FINANCE_RECEIVABLES_VER],
    medir: (knex, { tenantId }) =>
      medirCola(
        knex,
        knex('finance.findings').where({ tenant_id: tenantId, rule_key: 'cxc_sobre_limite' }),
        {
          estadoCol: 'status',
          estadoAbierto: 'nuevo',
          fecha: 'created_at',
          cierre: 'updated_at',
          abiertaExtra: ultimaPasadaDe(tenantId, 'cxc_sobre_limite'),
        },
      ),
    /*
     * ⛔ **Esta NO se desglosa, y es una decisión.** La de vencido sí, porque ahí el desglose ES
     * el trabajo: ocho nombres con su monto son la lista de a quién llamar hoy. Acá la acción no
     * nace de una lista sino del mostrador —«¿le vendo a crédito a éste?»— y ese momento ocurre
     * en `/finanzas/cartera` con el cliente delante, no leyendo la portada. Un segundo desglose
     * sumaría ocho renglones a la landing sin cambiar ninguna decisión.
     */
  },

  /**
   * `[CC.10]` **El dinero que entró al banco y Kepler no registró.**
   *
   * La pestaña «Abonos sin cobro» de `/finanzas/cobranza` existía desde CC.6 y **sólo se veía si
   * alguien se acordaba de abrirla**: sin bandeja, sin aviso, sin nadie a cargo.
   *
   * ── ⛔ POR QUÉ CUENTA EN VIVO Y NO DESDE `finance.findings` ──────────────────────────────
   * Las dos bandejas de cartera de arriba cuentan hallazgos. Ésta **no**, y es a propósito:
   *
   *  · **Volumen medido:** son **5,244 abonos sin explicar por $118,935,974.22** en el
   *    histórico. La bandeja `/finanzas/hallazgos` ya fue **retirada** (`[SN.18]`) por acumular
   *    **82,377 filas en `nuevo` sin triage**. Volcar esto ahí sería reconstruir el cementerio.
   *  · ⭐ **Y la razón de fondo:** acá **el trabajo cierra el item solo**. Ligar el abono lo saca
   *    de la cuenta. Un hallazgo exigiría además un triage manual («confirmar / descartar») que
   *    **duplica** la acción real — y es justo el paso que en los 82 mil nadie dio nunca.
   *
   * ── El recorte, y lo que deja afuera ────────────────────────────────────────────────────
   * Últimos `${COBRANZA_VENTANA_DIAS}` días y **≥ $${COBRANZA_MIN_MONTO}**: es el flujo del mes,
   * no el backlog histórico. Medido en prod: **1,838 abonos por $63,971,506.77** dentro del
   * recorte, contra 5,244 sin él.
   *
   * ⚠️ **Sólo cuenta `recon_status = 'pending'`.** Los **`unmatched`** —donde el conciliador de
   * `[CB]` ya miró y no encontró— quedan fuera: son **136 abonos por $3,911,556.33** en la misma
   * ventana. No es que no sean trabajo; es que son OTRO trabajo (investigación, no ligado), y
   * `medirCola` mide un solo estado abierto. Queda declarado, no disfrazado.
   */
  {
    id: 'cobranza-abonos-sin-ligar',
    label: 'Depósitos de cobranza sin ligar a un cobro',
    detalle: `últimos ${COBRANZA_VENTANA_DIAS} días · el dinero entró al banco y Kepler no lo tiene aplicado`,
    ruta: '/finanzas/cobranza',
    icono: 'pi pi-link',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.cartera',
    acotablePorSucursal: false,
    /*
     * **3 días.** Un depósito sin ligar no envejece solo: mientras no se aplique, el cliente
     * sigue apareciendo como deudor en la cartera y cobranza lo llama por algo que ya pagó.
     */
    umbral_dias: 3,
    anyOf: [Permission.FINANCE_COLLECTIONS_VER],
    medir: (knex, { tenantId }) =>
      medirCola(
        knex,
        knex('finance.bank_movements as m')
          .join('finance.movement_categories as c', 'c.id', 'm.category_id')
          .where('m.tenant_id', tenantId)
          .where('c.code', 'cobranza')
          .where('m.amount_in', '>', COBRANZA_MIN_MONTO)
          .whereNull('m.deleted_at')
          .whereRaw(`m.movement_date >= current_date - ${COBRANZA_VENTANA_DIAS}`),
        {
          estadoCol: 'm.recon_status',
          estadoAbierto: 'pending',
          fecha: 'm.movement_date',
          // `updated_at` lo mueve `writeReconMatch` al ligar: el cierre es la acción real.
          cierre: 'm.updated_at',
        },
      ),
    /*
     * ⛔ **No se desglosa.** El desglose sirve cuando la lista ES el trabajo (como en cartera
     * vencida: ocho nombres a quién llamar). Acá cada renglón es un depósito anónimo —el banco
     * no dice quién pagó— así que una lista de importes en la portada no decide nada: el trabajo
     * es abrir la pantalla, ver el candidato y ligarlo.
     */
  },

  // ── `[SN.39]` Compras: el comprobante de las entradas ──────────────────────────────────────
  {
    id: 'entradas-sin-comprobante',
    label: 'Entradas de mercancía sin comprobante',
    detalle: `órdenes de entrada de los últimos ${ENTRADAS_VENTANA_DIAS} días · falta subir el documento`,
    ruta: '/compras/entradas',
    icono: 'pi pi-file-import',
    alcance: 'bandeja',
    responsabilidad: 'compras.entradas',
    acotablePorSucursal: true,
    /*
     * **7 días.** La entrada se comprueba con el papel que llegó con la mercancía; si pasó una
     * semana, el papel ya no está en el mostrador y aparece el reclamo al proveedor sin respaldo.
     *
     * ⚠️ Nace `atrasada` en casi toda la red, y es correcto: medido el 2026-09-22, siete de las
     * nueve sucursales tienen la entrada sin comprobante más vieja desde **junio**.
     */
    umbral_dias: 7,
    /*
     * ⚠️ `COMPRAS_ENTRADAS_GESTIONAR`, **no `_VER`**: la ruta la gatea con `permissionGuard(
     * GESTIONAR)`, no con el `anyPermissionGuard` de las pantallas de captura. Poner `_VER` acá
     * mandaría a `direccion` —que tiene `VER: true` y `GESTIONAR: false`— a un rebote.
     */
    anyOf: [Permission.COMPRAS_ENTRADAS_GESTIONAR],
    /*
     * ⛔ **La cola es «sin comprobante», no «todas las entradas».** El `LEFT JOIN … IS NULL` es lo
     * que la hace trabajo pendiente; contar entradas sería contar la operación del ERP, que no es
     * de nadie.
     *
     * ⛔ **Ventana de 90 días, y no es pereza.** El histórico completo son 12,634 entradas desde
     * agosto-2024 con **2.33%** de cobertura: arrastrar dos años pondría 12 mil en la portada de
     * cinco personas y ninguno de esos papeles existe ya. Lo que se puede subir hoy es lo reciente.
     *
     * ⛔ **No hay columna de cierre y se DECLARA.** Una entrada no «se cierra»: aparece su
     * comprobante en otra tabla. `cierre: null` hace que `cerradas_30d` viaje `null` —nunca 0—, y
     * el veredicto se apoya en el ritmo de entrada y la antigüedad, no en un cero inventado que
     * diría «nadie la trabaja» cuando en `08` subieron el 78%.
     *
     * ⛔ El puente a sucursal es por la LLAVE CANÓNICA (`[RE.23]`), igual que reabasto. Acá además
     * `erp_goods_receipts` YA guarda `sucursal` como código de 2 dígitos, así que el join a
     * `warehouses` existe sólo para traducir la ficha, que puede decir `'MD-30'`.
     */
    medir: (knex, { tenantId, sucursales }) => {
      const q = knex('analytics.erp_goods_receipts as r')
        .leftJoin('finance.goods_receipt_proofs as p', function () {
          this.on('p.tenant_id', '=', 'r.tenant_id')
            .andOn('p.sucursal', '=', 'r.sucursal')
            .andOn('p.folio', '=', 'r.folio');
        })
        .where({ 'r.tenant_id': tenantId })
        .whereRaw(`r.receipt_date >= current_date - ${ENTRADAS_VENTANA_DIAS}`);
      if (sucursales) {
        q.join('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'r.warehouse_id').andOn('w.tenant_id', '=', 'r.tenant_id');
        }).whereRaw(
          `(${branchKeySql('w')}) IN (${sucursales.map(() => '?').join(', ')})`,
          sucursales,
        );
      }
      return medirCola(knex, q, {
        // El «estado» es si existe el comprobante: `p.folio IS NULL` = abierta.
        estadoCol: 'p.folio',
        estadoAbierto: null,
        fecha: 'r.receipt_date',
        cierre: null,
      });
    },
    /*
     * ⭐ **El desglose ES el pedido.** Edgar (2026-09-22): *«cada auxiliar de compras debe ver el
     * porcentaje que subió en su sucursal»*. Una fila por sucursal con `subidas de total · %`.
     *
     * ⛔ Y es lo que hace la bandeja útil HOY, con las fichas como están: ninguno de los cinco
     * auxiliares tiene `warehouse_code`, y su rol declara `warehouse: all` (`[ID.8c]`), así que el
     * conteo NO se acota y la fila dice «de toda la red». Con el desglose por sucursal, cada uno
     * encuentra la suya igual. Cuando la ficha tenga sucursal, la fila se acota sola y el desglose
     * queda en un renglón — el suyo.
     *
     * ⛔ **`nivel: null` en todas, a propósito.** No hay meta de cobertura registrada en ningún
     * lado, así que pintar rojo/amarillo exigiría inventar un umbral acá — que es exactamente el
     * `cfg ? classify : 'ok'` que ADR-076 prohíbe, con el signo invertido. El porcentaje se
     * publica y habla solo; el semáforo llega cuando haya meta.
     *
     * ⚠️ Ordena por lo que FALTA, no por el porcentaje: el renglón que pide trabajo es el que
     * tiene más papeles pendientes, y `00` sola son 2,509 de los 3,442.
     */
    desglosar: async (knex, { tenantId }, tope) => {
      const filas = await knex('analytics.erp_goods_receipts as r')
        .leftJoin('finance.goods_receipt_proofs as p', function () {
          this.on('p.tenant_id', '=', 'r.tenant_id')
            .andOn('p.sucursal', '=', 'r.sucursal')
            .andOn('p.folio', '=', 'r.folio');
        })
        .where({ 'r.tenant_id': tenantId })
        .whereRaw(`r.receipt_date >= current_date - ${ENTRADAS_VENTANA_DIAS}`)
        .groupBy('r.sucursal')
        .orderByRaw('count(*) filter (where p.folio is null) desc')
        .limit(tope)
        .select(
          'r.sucursal',
          knex.raw('count(*)::int as total'),
          knex.raw('count(p.folio)::int as con'),
          knex.raw('count(*) filter (where p.folio is null)::int as faltan'),
          knex.raw('min(r.receipt_date) filter (where p.folio is null) as mas_vieja'),
        );

      return filas.map((f) => {
        const total = Number(f.total) || 0;
        const con = Number(f.con) || 0;
        // ⛔ Sin filas no hay porcentaje: `null`, no 0%. «Nadie subió nada» y «no hubo entradas»
        // son afirmaciones distintas y el `0%` las confunde.
        const pct = total > 0 ? Math.round((con / total) * 1000) / 10 : null;
        return {
          id: String(f.sucursal),
          label: `Sucursal ${f.sucursal}`,
          nivel: null,
          desde: f.mas_vieja ? new Date(f.mas_vieja).toISOString() : null,
          nota:
            pct === null
              ? 'sin entradas en la ventana'
              : `${con} de ${total} subidas · ${pct}% · faltan ${f.faltan}`,
        };
      });
    },
  },
];

/**
 * `[SN.36]` El predicado de frescura de una regla de `finance.findings`.
 *
 * El ancla es `max(last_seen)` **de la propia regla**, no `current_date`, por la razón que explica
 * `EjesCola.abiertaExtra`: un hallazgo que el detector dejó de confirmar sigue en `nuevo` para
 * siempre (40 de 680 el día que se midió), pero si el ancla fuera el día de hoy, **el día que el
 * detector no corra la cola publicaría 0** en vez de quedarse quieta.
 */
function ultimaPasadaDe(tenantId: string, regla: string): EjesCola['abiertaExtra'] {
  return {
    sql: `last_seen >= (select max(last_seen)::date from finance.findings
                         where tenant_id = ? and rule_key = ?)`,
    args: [tenantId, regla],
  };
}

/**
 * `[SN.36]` Los clientes de arriba, por dinero.
 *
 * ⛔ **El orden es el importe, no la fecha.** En cobranza el renglón que importa es el grande:
 * medido el 22-sep, los dos primeros (`TLMKT Morelia Abastos` y `TLMKT Canindo Abastos`) suman
 * **$22.1 M de los $52.7 M vencidos** — ordenar por antigüedad los mandaría al fondo detrás de
 * cuentas de tres cifras. Es la contracara de `salud-datos`, donde el orden sí es la gravedad:
 * la regla no es «siempre por fecha», es **por lo que decide a quién llamar primero**.
 *
 * ⛔ `nivel` sale de `severity`, que el detector ya emitió. No se recalcula acá (ADR-057).
 *
 * ⚠️ `desde` se DERIVA: `last_seen - dias_max` es la fecha de vencimiento más vieja del cliente,
 * tal como el detector la midió. Es una resta sobre dos datos suyos, no una fecha inventada —
 * pero si `dias_max` no viene, va `null`, **nunca `now()`**, que leería «vencido hoy».
 */
async function desglosarHallazgoCxc(
  knex: Knex,
  tenantId: string,
  regla: string,
  tope: number,
): Promise<MeDesgloseItem[]> {
  const filas = await knex('finance.findings')
    .where({ tenant_id: tenantId, rule_key: regla, status: 'nuevo' })
    .whereRaw(
      `last_seen >= (select max(last_seen)::date from finance.findings
                      where tenant_id = ? and rule_key = ?)`,
      [tenantId, regla],
    )
    .orderBy('importe', 'desc')
    .limit(tope)
    .select(
      'id',
      'severity',
      'importe',
      'last_seen',
      knex.raw(`entity->>'nombre' as nombre`),
      knex.raw(`entity->>'cliente_code' as cliente_code`),
      knex.raw(`entity->>'sucursal' as sucursal`),
      knex.raw(`(evidencia->>'dias_max')::int as dias_max`),
    );

  return filas.map((f) => {
    const dias = f.dias_max == null ? null : Number(f.dias_max);
    const visto = f.last_seen ? new Date(f.last_seen) : null;
    const desde =
      visto && dias != null && Number.isFinite(dias)
        ? new Date(visto.getTime() - dias * 86400000).toISOString()
        : null;
    const monto = f.importe == null ? null : Number(f.importe);
    return {
      /*
       * ⛔ El id lleva la SUCURSAL, no sólo el código de cliente. Medido al ejercerlo contra
       * prod: `JUAN PABLO FONSECA GUTIÉRREZ` (`C1015`) sale **dos veces** —$1,079,287 en la
       * sucursal 00 y $1,072,286 en la 01—, que es correcto: son dos carteras distintas del
       * mismo cliente. Con el código solo, los dos renglones compartirían clave y la lista los
       * colapsaría en pantalla. El detector ya usa ese par como `dedup_key`.
       */
      id: `${f.sucursal ?? '?'}:${f.cliente_code ?? f.id}`,
      // El código del cliente queda de respaldo, no de texto por defecto: «30-73» no le dice
      // nada a quien va a llamar por teléfono.
      label: String(f.nombre || f.cliente_code || f.id),
      nivel: f.severity === 'critical' || f.severity === 'warn' ? f.severity : null,
      desde,
      nota:
        monto == null
          ? null
          : `${PESOS.format(monto)}${f.sucursal ? ` · sucursal ${f.sucursal}` : ''}`,
    };
  });
}

/** Sin decimales: en una lista de ocho renglones los centavos sólo estorban al comparar. */
const PESOS = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0,
});

/** ¿Esta persona puede abrir esta bandeja? God-mode ve todas; el resto, por clave exacta. */
export function puedeVerBandeja(
  b: BandejaDef,
  permisos: Record<string, boolean> | null | undefined,
  esAdmin: boolean,
): boolean {
  if (esAdmin) return true;
  const p = permisos ?? {};
  return b.anyOf.some((k) => p[k] === true);
}
