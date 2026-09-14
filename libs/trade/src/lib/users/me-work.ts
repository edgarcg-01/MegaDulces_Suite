import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import type { MeFlujo, MeVeredicto } from '@megadulces/contracts';
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
  | 'finanzas.conciliacion_ingresos'
  | 'finanzas.conciliacion_egresos';

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
  /** Valor que significa «abierto» (`'nuevo'`, `'pending_approval'`, `'open'`, `'draft'`). */
  estadoAbierto: string;
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
}

/**
 * Cuenta y fecha la cola en UNA sola pasada (`count(*)` + `min(<fecha>)`). Dos consultas por
 * bandeja duplicarían el trabajo de las ocho sin comprar nada: el filtro es el mismo.
 * `columnaFecha` se declara por bandeja porque en una cola con JOIN importa cuál de las dos
 * fechas es la que le habla a la persona.
 */
async function medirCola(knex: Knex, q: Knex.QueryBuilder, ejes: EjesCola): Promise<MedidaCola> {
  const { estadoCol, estadoAbierto, fecha, cierre } = ejes;
  /*
   * `[SN.29]` Los cinco contadores salen de UNA pasada con `FILTER`. Medido contra prod: la
   * consulta combinada cuesta 157-285 ms **incluyendo los ~154 ms de latencia a Railway**, o sea
   * lo mismo que la de dos contadores que reemplaza. La alternativa —una segunda consulta por
   * bandeja— habría sumado seis viajes en serie a la primera pantalla que todos abren.
   */
  const row = await q
    .clearSelect()
    .select(
      knex.raw('count(*) filter (where ?? = ?) as n', [estadoCol, estadoAbierto]),
      knex.raw('min(??) filter (where ?? = ?) as viejo', [fecha, estadoCol, estadoAbierto]),
      knex.raw(
        `count(*) filter (where ?? = ? and ?? > now() - interval '7 days') as e7`,
        [estadoCol, estadoAbierto, fecha],
      ),
      knex.raw(`count(*) filter (where ?? > now() - interval '30 days') as e30`, [fecha]),
      cierre
        ? knex.raw(
            `count(*) filter (where ?? <> ? and ?? > now() - interval '30 days') as c30`,
            [estadoCol, estadoAbierto, cierre],
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
    ruta: '/almacen/cuadre',
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
];

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
