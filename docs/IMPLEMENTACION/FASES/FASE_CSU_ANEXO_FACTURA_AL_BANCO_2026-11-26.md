<!-- INDICE-AUTO:INICIO -->

> **Índice navegable** — 51 KB, 540 líneas, 13 secciones.
> ⛔ **No intentes leer este archivo entero: no cabe en una ventana de contexto.**
> Buscá tu tema acá y leé sólo ese tramo: `sed -n 'DESDE,HASTAp' docs/IMPLEMENTACION/FASES/FASE_CSU_ANEXO_FACTURA_AL_BANCO_2026-11-26.md`.
> Lo genera `npm run docs:indices` — no lo edites a mano.

| Desde | Hasta | KB | Sección |
|---:|---:|---:|---|
| 25 | 61 | 3 | Fase CSU · Anexo FB — De la factura al banco |
| 62 | 90 | 2 | 1. En una pantalla |
| 91 | 158 | 5 | 2. El universo medido (1 al 25-nov-2026) |
| 159 | 168 | 1 | 3. Lo que creíamos y cayó |
| 169 | 179 | 1 | 4. Decisiones a firmar |
| 180 | 189 | 1 | 5. Qué NO incluye |
| 190 | 199 | 1 | 6. El orden |
| 200 | 413 | 21 | 7. Las capas y sus items |
| 414 | 421 | 1 | 8. Riesgos y bloqueos |
| 422 | 431 | 1 | 9. DoD |
| 432 | 476 | 7 | 10. Prueba visual de la pantalla de hoy — criterios de CSU.31/32 (2026-11-27) |
| 477 | 534 | 5 | 11. CSU.31 — el diseño, antes de la plantilla (2026-11-27) |
| 535 | 565 | 3 | Bitácora |

<!-- INDICE-AUTO:FIN -->
# Fase CSU · Anexo FB — De la factura al banco

> Anexo de [`FASE_CSU_CORTES_SUCURSALES.md`](FASE_CSU_CORTES_SUCURSALES.md). Método:
> [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md). Pedido de Francisco, 2026-11-26, después de rastrear a
> mano las facturas de contado de Morelia Abastos: *«el reporte de facturas por tipo y notas de crédito aplicadas,
> ¿dónde puede vivir este módulo, y que amarre ese flujo con la trazabilidad de depósitos?»*. Maqueta aprobada por
> Francisco el mismo día («avanzamos»): [lienzo privado](https://claude.ai/artifact/Qn97ajsHCG11b2hRkymEgG), 4 pantallas.

```
OBJETIVO: Que Cortes / Sucursales diga, de cada corte y de cada factura de contado, si el dinero llegó al banco
          o a Caja General, con el renglón del estado de cuenta como testigo; y que lo que no llegó se vea con
          su causa (sin depósito, otra cuenta, sin estado de cuenta, no hallado), nunca como silencio.
MÉTRICA 1 (llegó): pesos aplicados por Kepler a los cortes cuyo destino la pantalla dice, con testigo
          HOY (2026-11-26): 0 — el paso «Llegó a la empresa» dice «Todavía no se mide» (CSU.2)
          MEDIDO CON EL TESTIGO DE LA PANTALLA (la conciliación de Bancos, CSU.26, 1–25 nov, 8 sucursales):
          $19,886,107.18 de $27,672,286.79 aplicados (71.9 %) están en el banco o en Caja General; $5,672,784.87
          esperan a que Bancos tenga el banco de esa fecha (Santander 1604); el resto, clasificado (§2b)
          → META: 100 % de lo aplicado clasificado en pantalla, ninguna clase en silencio
MÉTRICA 2 (venta sin forma de pago): cortes que pasan lo que la caja registró cobrado, con su causa a la vista
          HOY: se pintan «Corte distinto» sin causa (CSU.7: «otra causa, sin investigar»)
          MEDIDO CON EL MOTOR (CSU.27, 1–25 nov): 34 «Corte distinto» arriba de lo esperado; 33 tienen testigo
          (corte = venta del turno − devoluciones) → venta sin forma de pago $471,283.35 (23 en Morelia Abastos)
          → META: 33 de 33 con su causa y con «¿llegó su dinero?»; el que no tiene testigo, dicho como tal
MÉTRICA 3 (rastro de una factura): clics para saber en qué corte y en qué cuenta quedó una factura de contado
          HOY: no se puede en la Suite (se hizo con consultas a mano) → META: 1 búsqueda + 1 clic
CAPA TOPE: C3
ÁREA:      Finanzas (Ingresos / Tesorería)
DUEÑO:     Edgar (PM; dueño de CSU) · desarrollo: Francisco con Claude (D2 = b)
ESTADO:    🔨 — D1 = a y D2 = b elegidas por Francisco el 2026-11-26; falta que Edgar las ratifique. No es
           fase nueva: son items de CSU (🟢 entregada), que vuelve a la tabla activa con 10 fases 🔨 contra el
           cupo de 4. La pantalla la movió Edgar (CSU.21–25): antes de tocar el componente, mirar origin/main
```

Medido en `pg-prod` (`system_identifier` 7688376744939610156), usuario `francisco`, `BEGIN READ ONLY`, el
2026-11-26. Script reproducible fuera del repo (`C:\DEV\_tmp\rastreo-facturas-08\medir-red.js`); al construir C0
la consulta pasa al servicio y el script se retira.

## 1. En una pantalla

Cortes / Sucursales ya sigue **corte → cobros aplicados → cuenta de Kepler** (CSU.1, CSU.8). Le faltan los dos
extremos, y son justo los que se hicieron a mano:

| Tramo | Hoy | Lo que agrega este anexo |
|---|---|---|
| La venta del turno: tickets, facturas de contado por tipo, notas de crédito | Sólo devoluciones POS del turno (CSU.7) | Tickets del turno, facturas `U-D-12` y `U-D-5` con sus notas `U-A-21/25`, y la **venta sin forma de pago** |
| Corte → cobro → cuenta | ✅ CSU.1, CSU.8 | — |
| Cobro → renglón del banco | ⬜ CSU.3 | Liga de la conciliación → mismo importe → suma de varios depósitos del mismo día |
| Cobro en efectivo → Caja General | ⬜ CSU.4 | Su entrada `CI-…` y el corte `CC-…` de Caja General |
| Una factura → su corte → su banco | No existe | Pestaña «Facturas de contado» + el rastro de una factura; el buscador acepta factura y ticket |

**La cadena, medida (no supuesta):** factura `U-D-12-1` (`kdm1.c37/c38/c39` = ticket `U-D-10`, caja = `c38`) →
ticket (`c80` = turno, `c97` = «pagó|cambio») → corte `U-D-23` en `kdue` (`c16` = `Caja <caja>-<turno>`) →
`analytics.kepler_kdm5_vigente` (`c9=23, c10=1, c11` = folio del corte) → depósito `U-A-5` (`kdm1.c45` = cuenta) →
`finance.bank_recon_matches` / `finance.bank_statement_lines` (banco) o `finance.cash_ledger.origen_ref =
'<suc>|U-A-5|<folio>|<cuenta>'` (Caja General).

**Controles con respuesta conocida** (los usa toda prueba de este anexo):

| Caso | Resultado esperado |
|---|---|
| Factura `0000376` (Morelia Abastos, 2-nov) | ticket 3-5114 → corte `0000161` → 4 depósitos → Santander 1604, los 4 en el estado de cuenta |
| Corte `0000161` | 118 tickets $182,383.10 − devoluciones $8,751.25 = **$173,631.85, igual al corte**; venta sin forma de pago $89,436.19 |
| Facturas `0000379`/`0000380` | corte `0000163` → Caja General `CI-2026-00343` → `CC-2026-00023` (**probable**: el corte se repartió en dos cuentas) |
| Depósito `UA0501-0000401` ($8,335.54) | Kepler dice BBVA 4176; el abono está en **Banorte 7744** el 4-nov → «otra cuenta» |
| Zamora Centro, 4-nov | 4 depósitos de Kepler suman $26,942.50 = **un** abono en BB 854 → «agrupado» |

## 2. El universo medido (1 al 25-nov-2026)

| Concepto | Cortes | Pesos |
|---|---:|---:|
| Vendido en cortes (8 sucursales con corte) | 707 | $32,091,434.50 |
| Kepler aplicó depósito | — | $27,672,286.79 |
| → en el estado de cuenta de su cuenta | — | $24,019,249.82 |
| → en Caja General | — | $1,385,652.71 |
| → cuenta puente de Kepler (devoluciones, ajuste a saldo) | — | $24,104.35 |
| → cuenta de caja sin asiento en el libro de Caja General | — | $79,394.35 |
| → la cuenta aún no tiene estado de cuenta para esa fecha | — | $1,440,229.62 |
| → **probable otra cuenta** (el mismo importe, exacto, en otra cuenta) | — | $307,795.04 |
| → **no hallado** | — | $415,860.90 |
| Sin depósito en Kepler | — | $4,419,146.04 |
| Venta sin forma de pago | 41 | $686,250.43 |

**Cómo se halló el banco** (1,136 depósitos): 1,053 por la liga de la conciliación (motor de Bancos), 76 por el
mismo importe en la misma cuenta (±$5, del −3 al +7 día) y 7 por suma exacta de 2 a 5 depósitos del mismo día.

**Por sucursal**, lo que no llegó o no se halló:

| Sucursal | Aplicado | No hallado | Probable otra cuenta | Sin depósito | Venta sin forma de pago |
|---|---:|---:|---:|---:|---:|
| Padre Hidalgo | $4,660,786.94 | $7,349.59 | $18,284.13 | $553,256.35 | 5 · $214,639.86 |
| Morelia Abastos | $9,896,260.94 | — | $8,335.54 | $1,724,488.08 | 23 · $447,554.47 |
| Morelia Madero | $2,694,798.47 | — | — | $273,868.11 | — |
| 8 Esquinas | $4,062,006.28 | $460.57 | $55,392.36 | $268,215.78 | — |
| La Piedad Abastos | $1,466,966.50 | — | — | $605,446.95 | 3 · $2,439.66 |
| Yurécuaro | $654,673.17 | $58,765.56 | $40,675.00 | $12,492.61 | 1 · $66.25 |
| Canindo | $3,326,490.27 | $4,300.00 | $182,628.30 | $630,952.57 | 5 · $12,342.21 |
| Zamora Centro | $910,304.22 | $344,985.18 | $2,479.71 | $350,425.59 | 4 · $9,207.98 |

### 2b. La misma red, con el testigo de la pantalla (CSU.26)

El cruce de arriba se hizo a mano y también buscaba por importe. **La pantalla no lo hace**: su testigo es la
conciliación de Bancos (§7, CSU.26), para no tener dos reglas del mismo hecho (ADR-056). Medido con el código de
CSU.26 contra prod (`database/scripts/csu26-llegada-prod.js`, 1–25 nov, 1,298 depósitos, consulta en 314 ms):

| Clase | Pesos aplicados | Qué dice la pantalla |
|---|---:|---|
| En el banco (pareo de la conciliación) | $18,500,454.47 | el renglón del estado de cuenta |
| En Caja General | $1,385,652.71 | la entrada `CI-…` y su corte `CC-…` |
| Bancos todavía no tiene el banco de esa fecha | $5,672,784.87 | «todavía no se puede saber», con la fecha hasta la que llega el libro |
| Sin conciliar (el libro cubre la fecha y no hay pareo) | $2,009,896.04 | «sin conciliar en Bancos» |
| Caja sin asiento en el libro de Caja General | $79,394.35 | «falta su entrada en Caja General» |
| Puente (devoluciones, ajuste a saldo) | $24,104.35 | fuera de lo que debió llegar |

**Llegó: 71.9 %.** La diferencia contra el 91.8 % del cruce a mano es casi toda **Santander 1604**: es una de las
tres cuentas de banco activas que no se han pasado al estado de cuenta (`statement_source_since` vacío, con BB 3660
y STDR 5565; las otras 15 pasaron entre el 31-oct y el 10-nov), así que su libro termina el **10-nov** y la
conciliación no puede casar lo posterior. De los $5,672,784.87 «todavía no se puede saber», **$5,667,870.06 son
de Santander 1604**; el resto, depósitos del 26-nov y uno que Kepler fechó el 13-dic (`04 UA0501-0000134`).
Santander 1604 también tiene $816,307.38 «sin conciliar» con fecha hasta el 10-nov: si son abonos que cayeron
después del corte del libro, **NO MEDIDO**. Morelia Abastos (43.1 %) y Morelia Madero (66.2 %) depositan ahí.
**Pasar Santander 1604 al banco es de Bancos (BFU), no de esta pantalla** (§8).

> **Revisión del 2026-11-27 (CSU.26):** el último día de cada libro ya no se toma como completo, porque en 7 de 16 cuentas
> viene cortado. Con eso, del 1 al 25-nov, «por saber» queda en **$6,729,466.09** y «sin conciliar» en **$947,177.60**
> (99 depósitos). Santander 1604 casi sale de «sin conciliar»: de los $816,307.38 de arriba quedan $44,311.71. La
> tabla de arriba es la medición del 26-nov, con la regla anterior.

**El universo no es el trabajo.** El trabajo de C0 es clasificar los $27.7 M aplicados con testigo, no
«encontrar» los $415,860.90: esos se declaran «no hallado» con su búsqueda escrita. **Zamora Centro concentra
el 83 % de lo no hallado** ($344,985.18; 22 depósitos a BB 854). La hipótesis, vista en un solo día (4-nov:
cuatro documentos de Kepler = un abono): el banco recibe un depósito por día de venta y Kepler lo registra
partido, a veces con fechas distintas; sumar por el día que dice el concepto («VENTA DEL DIA dd/mm») es la
siguiente regla a probar. **NO MEDIDA** hoy.

## 3. Lo que creíamos y cayó

| # | Lo que se decía | Lo que midió prod |
|---|---|---|
| 1 | «La cuenta del depósito dice por dónde viajó el dinero de cada ticket» | Kepler liga el depósito al **corte**. Sólo 30 de 168 cortes de Morelia Abastos cuadran forma de pago por forma de pago: atribuir un depósito a un ticket **no se hace** |
| 2 | «Corte distinto» = faltante o error del cajero (CSU.7: «otra causa, sin investigar») | En 41 cortes el corte pasa lo que la caja registró cobrado: **venta sin forma de pago** (p. ej. ticket 3-5114, $66,086.21, pagó $0). En los ya depositados, el dinero llegó |
| 3 | CSU.3 «necesita cargar el estado de cuenta de octubre» | La conciliación ya liga 1,053 depósitos de cortes; el hueco real es otro: el libro de Santander 1604 termina el 10-nov (lo atiende BFU, métrica 3) y lo posterior vive en `bank_statement_lines` |
| 5 | «91.8 % llegó» (cruce a mano, con búsqueda por importe) | Con el testigo de Bancos, 71.9 %: lo demás es Santander 1604 sin pasar al banco. Un segundo buscador en esta pantalla lo habría tapado |
| 4 | «Los cortes del 19 al 25-nov no tienen depósito» (lectura de las 13:35) | Kepler aplica los depósitos días después: horas más tarde la misma consulta ya daba depósito hasta el corte del 23-nov. «Sin depósito» lleva su **edad**, no un veredicto |

## 4. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | ¿Dónde vive? | (a) dentro de Cortes / Sucursales, pestaña nueva en «Cortes y arqueos» · (b) módulo aparte | ✅ **(a)**, elegida por Francisco el 2026-11-26 (falta ratificación de Edgar): la cadena corte → cobro → cuenta ya vive ahí y su paso 3 está vacío esperando esto; un segundo módulo sería un segundo primitivo del mismo hecho (ADR-056) |
| D2 | ¿Quién lo construye? | (a) Edgar · (b) Francisco con Claude, completo · (c) partido por capas | ✅ **(b)**, elegida por Francisco el 2026-11-26 (falta ratificación de Edgar). Se recomendaba (c) por el componente compartido: C0–C2 van en archivos nuevos, y antes de tocar `finanzas-cortes-sucursales.component.ts` se mira `origin/main` |
| D3 | Unidad de la pestaña | facturas · tickets | **Facturas** (lo pedido). Los tickets sin factura se ven sólo dentro de su corte |
| D4 | Nombre del hallazgo | «Corte distinto» · «Venta sin forma de pago» | **«Venta sin forma de pago»** cuando el corte pasa lo cobrado según la caja; sigue contando en «Sin cuadrar» (CSU.21) |
| D5 | ¿Desde cuántos días «sin depósito» es alerta? | sin alerta · N días | Que lo diga Tesorería. Visto en Morelia Abastos: depósitos aplicados hasta 7 días después del corte (`0000161`: del 3 al 9-nov). La distribución en la red: **NO MEDIDA** |
| D6 | CSU.5 «cobro sin corte» | mostrar · no | Sigue pendiente desde octubre; no bloquea este anexo |

## 5. Qué NO incluye

- **No escribe nada** en Kepler, en Bancos ni en Caja General: es lectura. Ligar un abono «no hallado» a mano es
  trabajo de Bancos (BFU), no de esta pantalla; aquí se ve y se abre allá.
- No reparte un depósito entre tickets ni atribuye forma de pago (§3 fila 1).
- No toca el arqueo del cajero ni sus conteos (CSU.16–25).
- No incluye facturas que no salen de un ticket de caja: Telemarketing (`U-D-8`, salen de un embarque), crédito,
  ni la factura global (`U-D-6`, 25 en el periodo, $9.58 M: qué cubre está **por confirmar**).
- Sin importer ni tabla nueva: todo sale de `kepler_ods.*` y de tablas propias de Bancos y Caja General.

## 6. El orden

| Orden | Frente | Por qué ahí |
|---|---|---|
| 1 | **CSU.26** cobro → banco / Caja General (C0) | Lleva casi todo el dinero ($27.7 M) y los datos ya existen; cierra CSU.3 y CSU.4 |
| 2 | **CSU.27** motor «¿llegó?» y venta sin forma de pago (C1) | Sin él la pantalla no puede decir nada; explica los «Corte distinto» |
| 3 | **CSU.28** la venta del turno (C0+C1) | Da el porqué de la venta sin forma de pago y amarra la factura |
| 4 | **CSU.29**, **CSU.30** contrato y endpoints (C2) | Con la capa de abajo verificada |
| 5 | **CSU.31**, **CSU.32** pantallas (C3) | Último; la maqueta ya está aprobada por Francisco |

## 7. Las capas y sus items

- [ ] **[CSU.26]** 🧪 **Cada depósito aplicado a un corte dice dónde está: renglón del banco, Caja General, o por
  qué todavía no se puede decir** — 2026-11-26. **Para:** Tesorería, Finanzas, Contabilidad (los roles de
  `FINANCE_CORTES_VER`). **Por qué:** métrica 1, $27,672,286.79 del 1 al 25-nov. **Capa:** C0 (+ la clase de cada
  depósito). **Depende de:** nada (absorbe CSU.3 y CSU.4).
  **Hecho:** `libs/finance/src/lib/cortes-sucursales/llegada-al-banco.ts` — `SQL_LLEGADA` (cabecera del depósito en
  kdm1 por `ix_kdm1_abono_doc`, pareos de `bank_recon_matches`, asientos de `cash_ledger`, la cuenta de Bancos que
  concilia cada cuenta de Kepler y hasta dónde llega su libro) y `clasificarLlegada` (7 clases). ⭐ **El testigo es
  la conciliación de Bancos**, no un pareo propio (§2b); los pases débiles (`PASES_DEBILES`, del motor de
  categoría) salen marcados para decir «probable».
  **Criterios (los cinco, verificados en prod con `database/scripts/csu26-llegada-prod.js`):**
  - `UA0501-0000363` → en el banco: Santander 1604, 3-nov, $8,600.00, pareo `motor-tes`.
  - `UA0501-0000366` (cuenta 0011) → en Caja General: `CI-2026-00343` → `CC-2026-00023`.
  - `UA0501-0000538` (Santander 1604, 24-nov) → «Bancos todavía no tiene el banco de esa fecha», libro hasta el 10-nov — **nunca** «no llegó».
  - `UA0501-0000401` (BBVA 4176, 4-nov) → sin conciliar (su abono está en Banorte 7744: lo resuelve Bancos).
  - `UA0501-0000495` (cuenta 0001 DEVOLUCIONES) → puente.
  - La suma de las clases da los $27,672,286.79 aplicados (§2b).
  **Pruebas:** `llegada-al-banco.spec.ts` 17/17; 8 mutantes, los 8 mueren. **Rendimiento:** la red, un mes, 314 ms
  (la primera versión casaba la conciliación con `IN (SELECT …)` y pasaba de 90 s: la tabla no tiene índice por
  documento; ahora se lee una vez por la lista de folios). **¿Escribe?** no.
  **Falta para ✅:** colgarlo del servicio y el contrato (CSU.29) y verlo en pantalla (CSU.31).
  **No incluye:** ligar a mano lo sin conciliar, ni pasar Santander 1604 al banco (BFU).
  **Revisión independiente del diff (2026-11-27), dos cambios:**
  - **El último día del libro ya no cuenta como cubierto** (`libro_hasta <= fecha` → «por saber»). Medido ese día: en
    **7 de 16** cuentas el último día trae menos de la mitad de los abonos de un día hábil (BBVA 4176: 9 contra 23.8),
    y el banco asienta el 95 % de los depósitos el mismo día y el 99 % a más tardar al siguiente (1,341 casados). Antes
    → después, la red del 1 al 25-nov con los datos de ese día: «sin conciliar» **128 depósitos $2,003,858.82 → 99
    $947,177.60**; «por saber» $5,672,784.87 → **$6,729,466.09**; «llegó» sin cambio ($19,892,144.40, 71.9 %). Santander
    1604 «sin conciliar» bajó de $816,307.38 a $44,311.71: eran depósitos del 10-nov, el último día de su libro. Los
    cinco controles siguen dando lo mismo. Una cuenta que Bancos no concilia sigue «sin conciliar» (0 casos hoy).
  - **Un asiento de Caja General cancelado no es testigo** (`estado <> 'cancelado'`, como todo lector de
    `cash_ledger`). En toda la historia de prod hay 545 asientos de depósitos y **0 cancelados**: no cambia ninguna
    cifra hoy, y su negativa contra datos reales no se pudo hacer (no hay casos) — NO MEDIDO.
- [ ] **[CSU.27]** 🧪 **El corte dice si su dinero llegó, y la venta sin forma de pago deja de ser «Corte distinto»**
  — 2026-11-26. **Capa:** C1 (+ la venta del turno como testigo, C0). **Depende de:** CSU.26 (🧪).
  **Hecho:** `libs/finance/src/lib/cortes-sucursales/llegada-del-corte.ts`:
  - `SQL_VENTA_TURNO` + `ventaDelTurno`: tickets del turno por caja, folio de turno y ±1 día (por `ix_kdm1_venta_fecha`;
    la red, un mes, 369 ms). Ambiguo si otro corte de la misma caja-turno está a ±3 días (en nov: 0).
  - ⭐ **El testigo, medido:** el corte es igual, al centavo, a la venta del turno menos sus devoluciones en **698 de
    707** cortes (98.7 %).
  - `ventaSinFormaDePago`: sólo cuando el corte salió `corte_distinto`, ARRIBA de lo esperado, y es igual a la venta
    del turno menos devoluciones. Usa el `veredictoCuadre` que ya existe (no una regla paralela). `sobrante_arqueo` no
    se renombra: ya tiene causa.
  - `llegadaDelCorte`: `sin_deposito` (con su edad en días) → `sin_conciliar` → `parcial` → `por_saber` → `llego`,
    sumando lo que cada depósito aplicó a ESTE corte; lo puente no falta.
  **Criterios (verificados en prod con `database/scripts/csu27-corte-prod.js`):** `0000161` → llegó + venta sin forma
  de pago $89,436.19 (118 tickets); `0000165` → sin conciliar $8,335.54; `0000163` → llegó; Zamora Centro `0000154`
  («Corte distinto» +$188.33, el corte no es la venta del turno) → **sin causa**; «sin depósito» ⇔ sin cobros
  aplicados (0 fuera de 707).
  **Medido (1–25 nov, 707 cortes):** llegó 368 · por saber 84 (Santander 1604) · parcial 53 · sin conciliar 118 ·
  sin depósito 84. Hay cortes con depósito parcial de hasta 25 días (Padre Hidalgo 20, 8 Esquinas 8): **NO MEDIDO**
  si es dinero que falta o depósitos aplicados a otro documento (CSU.5).
  **Pruebas:** `llegada-del-corte.spec.ts` 19/19 (con CSU.26, 36/36); 11 mutantes, los 11 mueren.
  **Falta para ✅:** el contrato y la pantalla (CSU.29, CSU.31).
- [ ] **[CSU.28]** 🧪 **El detalle del corte muestra la venta del turno: tickets, devoluciones y facturas de
  contado con sus notas** — 2026-11-26. **Capa:** C0+C1. **Depende de:** CSU.27 (la venta del turno y `mismoTurno`).
  **Hecho:** `libs/finance/src/lib/cortes-sucursales/facturas-de-contado.ts`:
  - `SQL_FACTURAS_CONTADO`: las facturas `U-D-5` y `U-D-12` no canceladas que salen de un ticket, con su ticket (caja,
    folio, turno, fecha, total, «pagó|cambio» tal cual) y sus notas `U-A-21/25`. Trae las del periodo por fecha de
    factura Y las de los tickets del periodo: la misma consulta sirve al detalle del corte y a la pestaña (CSU.30).
    Medido: la factura sale el mismo día o el siguiente en el 95 %, pero hasta **83 días** después del ticket.
  - `mismoTurno` (en `llegada-del-corte.ts`) es la regla ÚNICA ticket → corte: la usan la venta del turno y las
    facturas, para que no puedan contradecirse.
  - `facturasDelTurno`, `corteDeFactura` (sin corte dice por qué: `sin_ticket` · `antes_del_corte_pos` · `sin_corte`
    · `ambiguo`) y `ventaDelTurnoDetalle` (tickets, devoluciones, neto, ¿igual al corte?, facturas).
  **Criterios (verificados en prod con `database/scripts/csu28-turno-prod.js`):** `0000161` → 118 tickets $182,383.10
  − $8,751.25 = $173,631.85, igual al corte, con `0000373`, `0000374` y `0000376`; `0000376` → nota `UA2501-0000017`
  −$8,392.25, neto $57,694.49; `0000379`/`0000380` → corte `0000163`; `0000471` (14-nov) → corte `0000024` de
  octubre (su ticket es del 6-oct); `0000539` → antes del corte POS. **Testigo independiente:** Morelia Abastos
  `U-D-12` 246 · $1,237,163.50 · 4 notas −$9,240.55 y `U-D-5` 251 · $586,310.30, iguales a la consulta directa a kdm1.
  **Cobertura (1–25 nov, red):** 3,658 facturas; 3,648 con su corte; 10 de tickets anteriores al 1-oct; ninguna en
  dos cortes.
  **Rendimiento:** la consulta pasó de 5.7 s a **174 ms** (el catálogo de tipos se leía por factura, y facturas contra
  tickets se casaban con un Nested Loop: 22 M filas descartadas; ahora por llave, la lección de CSU.22).
  **Pruebas:** `facturas-de-contado.spec.ts` 18/18 (las de Cortes / Sucursales, 115/115); 10 mutantes, los 10 mueren.
  **No incluye:** forma de pago por ticket (`c97` se muestra tal cual; un ticket con tarjeta y «0|0»: NO MEDIDO).
- [ ] **[CSU.29]** 🧪 **El contrato de Cortes / Sucursales trae la llegada al banco y la venta del turno** —
  2026-11-26. **Capa:** C2. **Depende de:** CSU.26–28 (🧪).
  **Hecho:**
  - Contrato (`cortes-sucursales.contract.ts`), una sola definición que también usa la librería:
    `CorteCobro.llegada` (`CobroLlegada`: clase, renglones del banco, asientos de Caja General, cuenta de Bancos y
    hasta dónde llega su libro), `CorteRow.llegada` / `venta_turno` / `venta_sin_forma_de_pago`, y en la respuesta
    `llegada` (`CortesLlegadaResumen`) y `venta_sin_forma_de_pago`. **`null` = no se midió**, nunca «no llegó».
  - Servicio: `anexarFacturaAlBanco` corre `SQL_LLEGADA` y `SQL_VENTA_TURNO` **en paralelo**, cada una en su
    conexión, después de la consulta de siempre; si una falla, su parte queda `null` y la pantalla de siempre sigue.
    `anexarLlegadaYVenta` (pura) cuelga todo y arma los resúmenes. El motor de Edgar sólo inicializa los campos en
    `null` (3 renglones). Las facturas del turno NO van en la lista: van en su consulta (CSU.30), para no pesar.
  - Consumidores recorridos: 9 archivos (la pantalla, sus 5 specs, Caja General y su spec, `cash-ledger.service`);
    todos arman sus datos con conversión de tipo, ninguno se rompe; `check:pantalla -- finanzas-cortes-sucursales`
    tipa en verde, 0 fallas nuevas.
  **Medido en prod** (`database/scripts/csu29-respuesta-prod.js`, el camino del servicio con jiti):
  - **Peso:** 1–25 nov 1,081 → 1,616 KB (gzip **103 → 137 KB**); octubre completo 1,462 → 2,207 KB (gzip **136 →
    175 KB**).
  - **Tiempo dentro de la base** (EXPLAIN ANALYZE, mediana de 3): `SQL_LLEGADA` 188–204 ms, `SQL_VENTA_TURNO`
    345 ms (nov) y **507 ms (octubre completo)**. En paralelo, el anexo tarda lo de la más lenta: **el criterio
    «< 500 ms por mes» falla por 7 ms en un mes completo** → deuda `[CSU.29b]`. Desde fuera del clúster, con red,
    529–651 ms; dentro de prod, de punta a punta: NO MEDIDO.
  - **Invariantes**, en los 707 cortes de nov y los 906 de oct: llegó + por saber + sin conciliar + puente =
    aplicado, y aplicado + sin depósito = monto (0 fuera). `0000161`: 4 depósitos en el banco, llegó, venta sin
    forma de pago $89,436.19.
  **Pruebas:** `llegada-del-corte.spec.ts` +7 (Cortes / Sucursales 122/122), con «la consulta falló → null».
  **Arranque:** no se tocaron decoradores ni lo que Nest inyecta (mismo constructor); el arranque del servicio
  NO se verificó en local (regla 3): lo verifica el despliegue.
- [ ] **[CSU.29b]** ⬜ **La venta del turno de un mes completo, en menos de 500 ms** — deuda de CSU.29. Hoy 507 ms
  dentro de la base (octubre): lee ~todos los documentos `U-D` del mes por `ix_kdm1_venta_fecha` para sumar los
  tickets. Opción: índice que cubra `(c9::date, sucursal, c5, c80, c16)` para tickets, creado `CONCURRENTLY` fuera de
  horario (regla 9). Medir antes/después con `csu29-respuesta-prod.js`.
- [ ] **[CSU.30]** 🧪 **Facturas de contado por tipo, con sus notas y su rastro, en la API** — 2026-11-26.
  **Capa:** C2. **Depende de:** CSU.28, CSU.29 (🧪).
  **Hecho:** `GET /finance/cortes-sucursales/facturas?month|from+to&sucursal&corte` → `FacturasContadoResponse`:
  resumen por tipo (facturas, monto, notas, neto y **el estado del corte** de cada factura: su llegada, por qué no
  tiene corte, o «no medido»), las facturas con su ticket, notas y corte, y los cortes una vez cada uno (el MISMO
  `CorteRow` de la pestaña Cortes: llegada, depósitos con su renglón del banco, venta sin forma de pago). Los cortes
  salen de `list()` del periodo ±1 día; una factura cuyo ticket es de fuera sale `otro_periodo` (no «sin corte»).
  Con `corte`: las facturas de su turno aunque la factura sea de otra fecha (el detalle del corte, CSU.31).
  `armarFacturas` es pura; el contrato trae los tipos de factura (una sola definición que usa la librería).
  **Criterios (verificados):**
  - ❌ Sin `FINANCE_CORTES_VER` no se entra: la ruta lleva la MISMA llave que la lista (`cortes-sucursales.arranque.spec.ts`
    lee la metadata que lee `RolesGuard`; el 403 en vivo: NO MEDIDO, sin API local).
  - ❌ Una tienda que pide otra sucursal → 403 **sin tocar la base**; una sucursal que no es código de 2 dígitos → 400.
  - En prod (`database/scripts/csu30-facturas-prod.js`): Morelia Abastos `U-D-12` 246 · $1,237,163.50 · 4 notas
    −$9,240.55 y `U-D-5` 251 · $586,310.30; `0000376` → corte `0000161` (llegó, venta sin forma de pago $89,436.19);
    `0000471` → `otro_periodo`; `0000539` → `antes_del_corte_pos`; con `corte=0000161` salen 373, 374 y 376.
  - Invariantes: cada factura tiene corte o por qué no, y su corte está en el mapa; por tipo, los estados suman las
    facturas.
  **Peso:** la red entera, 1–25 nov, 2 MB (gzip **197 KB**); una sucursal (Morelia Abastos) gzip **33 KB** → la
  pantalla pide por sucursal. **Tiempo** (desde fuera del clúster): los cortes con su llegada 1.4 s (lo mismo que la
  pestaña Cortes) + facturas 0.4 s; dentro de prod: NO MEDIDO.
  **Pruebas:** 138/138 en Cortes / Sucursales (+16: `armarFacturas`, «otro periodo», el corte de septiembre de
  Padre Hidalgo, rutas y permisos, 403/400). `lint:boundary` sin hallazgos; `check:pantalla` 0 nuevas.
  **Arranque:** mismo constructor y mismas dependencias (verificado por aridad y módulo en el spec); una ruta GET
  más con `@Query` de texto. NO se levantó la API en local (regla 3).
  **Corrige:** el error de tipos de `trx.raw(SQL_LLEGADA, …)` que traía el commit de CSU.29 (los parámetros eran
  `unknown[]`); no lo vi en esa revisión.
- [ ] **[CSU.31]** 🧪 **Cortes / Sucursales responde «¿llegó el dinero?»** — 2026-11-26. **Capa:** C3.
  **Depende de:** CSU.29. Pantallas 1 y 2 de la maqueta. Skill `diseno` + `check:pantalla` antes y después.
  **Criterios de la prueba visual (§10):** CSU.UI.1–7 y CSU.UI.9–11. ⛔ Sale **junto con CSU.29**: con la llegada
  en la respuesta y la pantalla diciendo «Todavía no se mide», la pantalla negaría un dato que ya tiene (CSU.UI.8).
  **Hecho** (`finanzas-cortes-sucursales.component.ts`, diseño en §11):
  - **La respuesta del periodo**, en una frase sobre los indicadores (`fraseDelPeriodo`): cuánto de lo aplicado
    llegó, lo «por saber» con su cuenta y hasta dónde llega su estado de cuenta, lo sin conciliar, lo sin depósito y
    la venta sin forma de pago. Cada número que cuenta cortes es un botón que los muestra.
  - **5 indicadores**: entra «Llegó a la empresa» (neutro; sin medición dice «No medido»). «Llegó», «Pendiente» y
    «Sin cuadrar» filtran la lista (`drill` de `MetricStrip`); otro toque lo quita.
  - **«Mostrar»** reemplaza «Sólo con saldo»: 9 filtros, cada uno con su número; los de llegada se apagan si no se
    midió. Con un filtro, la pista dice «N de M cortes · filtro · monto» y «Quitar filtro». ⭐ Una sola regla
    (`cumpleFiltro`) para la frase, los indicadores, «Mostrar» y la pista; los de llegada van por monto, así que la
    suma de los filtrados es la del resumen al centavo.
  - **La lista:** «¿Llegó?» reemplaza a «Cobro» y la caja-turno va bajo el folio (8 columnas, eran 9); cada celda
    con su rótulo y `role="cell"` para el celular; la fila del día dice «Llegó todo», «N por saber», «N sin
    conciliar» (sin medición, «Todo cobrado» como antes). «Corte distinto» se llama «Venta sin forma de pago»
    cuando la venta del turno lo explica (D4).
  - **El detalle, en 3 pasos** con su respuesta arriba (`fraseDelCorte`): 1 la venta del turno (tickets,
    devoluciones, igual al corte, lo que la caja registró cobrado, la venta sin forma de pago) y **las facturas de
    contado del turno** (CSU.30, pedidas al abrir el corte, con «Reintentar» si fallan); 2 el arqueo, como estaba;
    3 cada depósito con dónde llegó debajo: el renglón del banco (y si es un abono que cubre varios), la entrada de
    Caja General y su corte, o por qué todavía no se puede saber. El «Todavía no se mide» se fue.
  - **Debajo de 68.75rem** el detalle se abre en `app-side-peek` (CSU.UI.3).
  - CSU.UI.1: el «último cobro» es el de hasta hoy; los fechados en el futuro se dicen y un clic los busca (el
    buscador ahora encuentra por fecha de cobro y por estado de llegada). CSU.UI.6: encabezados a 12 px. CSU.UI.9:
    desplegar, enlaces y «Actualizar» a 44 px con puntero grueso. CSU.UI.10: el subtítulo en un renglón.
  - La ayuda de la pantalla (`context-help.dictionary.ts`) suma el grupo «¿Llegó el dinero?»: llegó, por saber, sin
    conciliar, sin depósito, venta sin forma de pago y «Mostrar».
  **Verificado en nivel A** (2026-11-27, la pantalla viva en los 3 perfiles contra `pg-prod` en sólo lectura, API
  local con CSU.29; `…/facturas` servida con la respuesta que arman las MISMAS funciones de CSU.30 contra prod,
  porque el `dist` local es anterior; escrituras bloqueadas; guiones `C:\DEV\_tmp\csu-visual\prueba31.js`):

  | Criterio | Antes | Después |
  |---|---|---|
  | CSU.UI.1 | «último cobro: 13/12/26» | «último cobro: 26/11/26 · 1 cobro con fecha posterior a hoy» (un clic lo busca) |
  | CSU.UI.2 | 0 de 4 indicadores llevan a sus cortes | **los 3 indicadores y los 5 números de la frase dan, en la pista, su mismo número** (189 · $19,886,107.18 · $5,682,259.07 · 93 · 121 · 184 · 103 · 33), en los 3 perfiles; «Mostrar» con sus 9 números |
  | CSU.UI.3 | el detalle a 54 px (celular) y 69 px (Fold) del borde, detrás de la barra | panel lateral con el título a la vista en Fold y celular; Escape lo cierra y el foco vuelve a la fila |
  | CSU.UI.4 | 9 renglones sin rótulo por corte | cada celda apilada con su rótulo («Monto», …) |
  | CSU.UI.5 | 9 columnas; el Fold se desplaza 47 px dentro de la tabla | 8 columnas; 0 px (716/716) |
  | CSU.UI.6 | encabezados a 16 px | 12 px |
  | CSU.UI.9 | 28×28 al dedo (20×28 en celular); enlaces de 18 px | 0 objetivos bajo 44 px en Fold y celular |
  | CSU.UI.10 | subtítulo de 6 renglones en celular | 1 renglón en escritorio y Fold, 3 en celular (sin cortes raros) |
  | Contraste AA | — | 0 fallas en claro y oscuro (el enlace de la frase, lo más justo: 4.54 en claro, 5.87 en oscuro); en Alto Contraste el número de la frase conserva su subrayado |

  El detalle de `0000161`: «El dinero del corte llegó: $173,631.85 en 4 depósitos del 03/11/26 al 09/11/26 a STDR
  1604», la venta sin forma de pago $89,436.19 con su venta del turno, **sus 7 facturas de contado del turno** (4
  «TK Contado» que la maqueta no mostraba) y cada depósito con su renglón del banco (uno: «un abono que cubre este y
  otros depósitos», $146,040.00). La prueba encontró y se corrigió: columnas de facturas pegadas, 15 px que aún se
  desplazaban en el Fold, un enlace de 37 px de ancho, los ceros del folio del ticket y el texto de la nota.
  **Pruebas:** `finanzas-cortes-sucursales.llegada.spec.ts` 29/29 (las de la pantalla, 79/79; con la ayuda, 106/106);
  **15 mutantes, los 15 mueren**. Tipos de la plantilla: `ngc` sobre el componente aislado, 0 errores, con su
  negativa en rojo (TS2339) — ⚠️ sobre la app entera la revisión de plantillas NO corre mientras el árbol traiga un
  error de tipos ajeno (hoy `autoabasto-a-mano.component.ts`, de otra sesión, sin commitear): la negativa salía verde.
  `check:pantalla` 0 nuevas; eslint 0 errores; `lint:boundary` sin hallazgos.
  **NO MEDIDO:** lector de pantalla; zoom 200 % y reflujo a 320 px; el tiempo en prod (CSU.UI.11); el `GET …/facturas`
  real (sólo su respuesta, calculada); el marco creció ~95 px en escritorio por la frase (la primera fila de sucursal
  pasó de 501 a ~600 px): se cambió por las tarjetas de la maqueta, pero no se recortó.
  **Revisión independiente del diff (2026-11-27)**, verificada en el código y medida en prod antes de tocar nada:
  - un corte saldado sólo con devoluciones o ajustes (puente) decía «Llegó» con $0 llegado → «Saldado con devoluciones
    o ajustes», y «Llegó todo» en el día exige dinero llegado (0 casos del 1 al 25-nov);
  - «sin conciliar» decía «no están ni en el banco ni en Caja General» → dice que falta el testigo, no el dinero;
  - un corte sin caja-turno, o con la venta del turno sin ligar, decía «Ningún ticket de este turno se facturó» sin
    haber buscado → «No se pueden buscar…», y no se piden;
  - un filtro de llegada sobrevivía a una recarga sin medición (lista vacía que se lee «ninguno») → se quita;
  - el enlace «N conteos fuera de corte» abría una lista de cortes → la pista dice cuántos conteos hay en la lista y
    cuántos caen en días sin cortes;
  - en el backend: el último día del libro y los asientos cancelados (ver CSU.26), y la orilla del rango en facturas
    (CSU.30: el ticket del primer o último día buscado sin corte es «otro periodo», no «sin corte»).
  Con la regla nueva de CSU.26 los números de la frase cambian: «por saber» 93 → **119** cortes, «sin conciliar» 121 →
  **92**; «con dinero que ya llegó» sigue en 549. Las llaves sin sub-tipo (`c5`) que señaló la revisión: **0 colisiones**
  medidas (U-A-5, U-D-5 y U-D-12 todas con sub 1; las notas U-A-21/25 sin folios repetidos entre subs). Pruebas: el
  spec de la pantalla 35/35, finance 139/139; **8 mutantes de los arreglos, los 8 mueren**.
  **Falta para ✅:** soltar CSU.29–31 juntos y medir en prod (CSU.UI.8, .11); Edgar firma D1–D2.
- [ ] **[CSU.32]** ⬜ **Pestaña «Facturas de contado» y el rastro de una factura; el buscador acepta factura y
  ticket** — 2026-11-26. **Capa:** C3. **Depende de:** CSU.30. Pantallas 3 y 4 de la maqueta; descarga a Excel.
  **Criterios de la prueba visual (§10):** CSU.UI.2 (sus indicadores filtran), CSU.UI.4 (filas con rótulo en
  celular), CSU.UI.12 (se pide por sucursal).

## 8. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| Dos manos en el mismo componente | Francisco (D2 = b) | CSU.21–25 de Edgar tocan `finanzas-cortes-sucursales.component.ts` | mirar `origin/main` antes de C3 y tocar el componente en un bloque |
| **Santander 1604 sin pasar al banco** ($5,672,784.87 «todavía no se puede saber» del 1 al 25-nov) | Edgar (BFU) / Tesorería | su libro termina el 10-nov; es la única cuenta de banco activa sin `statement_source_since` | «Usar el banco» en Bancos (CB.60b); la conciliación vuelve a casar sola (CB.53). Esta pantalla NO lo rodea |
| Lo no hallado de Zamora Centro | por asignar | depósitos partidos por día de venta | regla por concepto (§2), medida antes de pintarla |

## 9. DoD

- [ ] Métrica 1 y 2 re-medidas con la consulta del servicio (no con el script) y comparadas con §2
- [ ] Los 5 controles de §1 en las pruebas, con una prueba negativa por clase
- [ ] Ningún peso se pinta «llegó» sin renglón de banco o asiento de Caja General
- [ ] Permiso `FINANCE_CORTES_VER` repartido (ya lo está: CSU.1/CSU.6) y la pestaña nueva en el menú
- [ ] `check:pantalla` sin fallas nuevas; prueba visual en los 3 perfiles
- [ ] Tracker, log y CHANGELOG al cerrar
- [ ] Edgar firma D1–D2

## 10. Prueba visual de la pantalla de hoy — criterios de CSU.31/32 (2026-11-27)

**Nivel A** (la pantalla viva, `auditoria-diseno` §5): vista en `localhost:4200` y API local (el `dist` del
26-nov 23:51, que ya trae CSU.29) contra `pg-prod` en sólo lectura; noviembre, la red, usuario `superoot`;
escritorio 1440×900, Fold 7 abierto 750×832 táctil y celular 390×844 táctil. Recorrido: entrar → elegir Morelia
Abastos → desplegar un día → buscar `0000161` → abrir el corte; más cargando, falla (500 y «Reintentar»),
septiembre, teclado, oscuro y Alto Contraste. Toda escritura bloqueada (sólo se intentó la telemetría). Guiones
fuera del repo: `C:\DEV\_tmp\csu-visual\` (`prueba.js`, `recorrer.js`); cada instrumento con su control
(contraste 21 / 4.48; buscar un folio conocido; `--tap-min` aplica en táctil y no en escritorio).

**La prueba de la frase.** Hoy la pantalla contesta *«¿cuánto vendió cada caja y cuánto falta cobrar?»* **y**
*«¿cuadró el arqueo?»*. CSU.31 le agrega *«¿llegó el dinero?»*. Tres preguntas en una pantalla sólo caben si cada
corte las contesta en **un** estado y la respuesta del periodo va primero (pantalla 1 de la maqueta); sumar una
franja o columnas por pregunta es lo que hoy ya satura la vista (CSU.UI.5, CSU.UI.10).

**Jerarquía para CSU.31:** primario = la respuesta del periodo (una frase y sus cifras) · secundario = la lista
por día con su estado · terciario = folios, cajas y cuentas.

| # | Sev | Lo que se midió y lo que cuesta | Ley | Criterio de aceptación |
|---|---|---|---|---|
| CSU.UI.1 | 🔴 | La pista dice «último cobro aplicado en Kepler: **13/12/26**» con hoy 27/11: un cobro con fecha futura en Kepler (`04 UA0501-0000134`, $275.31) es el máximo, y la pantalla lo publica como frescura en la red y en cada sucursal | Ley 0 · ADR-056 · Cruce 2 | La fecha es la última **≤ hoy**; los de fecha futura se declaran («1 cobro con fecha posterior a hoy en Kepler») y se encuentran con el buscador. Prueba negativa: un cobro futuro en el spec no mueve «último cobro» |
| CSU.UI.2 | 🔴 | Ninguna cifra de arriba lleva a sus cortes: 0 de 4 indicadores se tocan; buscar «sin cuadrar» da **0** (los 189 se encuentran abriendo 208 días en 3 páginas); «$2,295,215.00 con más de 3 días» no tiene filtro («Sólo con saldo» da 184 cortes revueltos con los que están en plazo); los 385 conteos fuera de corte sólo se ven día por día. Las cifras nuevas (llegó, venta sin forma de pago, por saber, sin conciliar) nacerían igual | Cruce 1 · Q.4 | Cada indicador —los de hoy y los nuevos— filtra la lista: al tocarlo se ven exactamente esos cortes y la pista dice «N de N»; «Quitar filtro» lo deshace. Prueba: filas filtradas = cifra del indicador |
| CSU.UI.3 | 🔴 | En celular y Fold el detalle del corte se abre **debajo de toda la lista**: su borde queda en y=790 de 844 (detrás de la barra inferior); en el Fold asoman 69 px. Tocar un corte no cambia nada a la vista, y ahí vive el paso «Llegó a la empresa» | Visibilidad · Doherty (se pierde el hilo) | Debajo de 68.75rem el detalle se abre en `app-side-peek` (o la vista baja a su título con el foco ahí); al cerrarlo, el foco vuelve a la fila. Medido en los 3 perfiles: el título del detalle dentro de la vista después del toque |
| CSU.UI.4 | 🟠 | En celular, la tabla de cortes del día y la de «contado fuera de un corte» se apilan **sin rótulos**: 9 renglones sin nombre por corte («$173,631.85 / $173,631.85 / $0.00 / Cobrado…»); no se sabe cuál es Monto y cuál Cobrado | Cruce 2 · Comprensión | Cada celda apilada lleva su rótulo (`data-label`, como las filas de día), o la fila apilada se reduce a lo que decide, con rótulo |
| CSU.UI.5 | 🟠 | En el Fold la tabla del día (9 columnas) se sale 47 px y corta «Billetes y monedas»; el encabezado fijo, de 3 renglones, tapa la primera fila de días. Si CSU.31 **suma** columnas, la cortada sería la de la llegada | Tablas · Tesler | A 750 px ninguna columna se corta (sin desplazamiento lateral dentro de la tabla): la llegada **reemplaza o funde** columnas, no se suma |
| CSU.UI.6 | 🟠 | Encabezados de las tablas principales a **16 px/600**, más grandes que las celdas (14 px) e iguales al título de la sección; con su sub-rótulo bajan a 3 renglones. En la misma lista conviven dos estilos de encabezado (16 px arriba, 11 px en mayúsculas en la anidada) | Q.5 · Jerarquía | Encabezados del tamaño de la celda o menores, un solo estilo; la jerarquía de arriba, por escala de letra y contraste, no por cajas |
| CSU.UI.7 | 🟠 | «sin cuadrar» sale rojo en **8 de 8** sucursales (189 de 737 cortes, 26 %): el rojo ya no distingue; la sucursal elegida se pinta entera en color de acción y se lee como alarma; una celda de día junta verde, rojo y azul | Color · Von Restorff | Presupuesto: neutro + acción (sólo selección y botón principal) + rojo sólo para lo que está mal. «Llegó» va neutro, no verde; rojo sólo para «sin conciliar» y «sin depósito» vencido (D5); «por saber» neutro con su texto |
| CSU.UI.8 | 🔴 | Con CSU.29 desplegado y sin CSU.31, el paso 3 diría «Todavía **no se mide**» con la llegada ya en la respuesta (medido en local: la respuesta trae `llegada`) | Ley 0 · ADR-056 | CSU.29 y CSU.31 se sueltan juntos. Si la medición falla (`llegada: null`) se dice «No se pudo medir la llegada», nunca «no llegó» |
| CSU.UI.9 | 🟠 | Al dedo: el botón de desplegar mide 28×28 (20×28 en celular), «ver todas / limpiar / desplegar todos» 18 px de alto, «Actualizar» 28 px. Control: lo que ya usa `--tap-min` (el aviso «Cajero») sí llega a 44 | Fitts | Todo lo nuevo y lo que CSU.31 toque, ≥ 44 px con `pointer: coarse` vía `--tap-min` |
| CSU.UI.10 | 🟠 | Marco contra trabajo: en escritorio el 62 % de lo visible es marco antes de la primera fila y la lista de cortes empieza bajo el pliegue; en celular el encabezado mide 240 px (subtítulo de 6 renglones, «CONTADO» en uno propio), el primer monto está a 626 de 694 px y el primer día a 4.4 pantallas (8 tarjetas de sucursal de 242 px). Con el detalle abierto, 59 montos a la vista; «$173,631.85» 5 veces | Carga · Hick · F | La respuesta del periodo va arriba en una frase y CSU.31 no agrega franjas: lo nuevo reemplaza (una cifra que ya no decide) o entra en lo que hay; el subtítulo en un renglón |
| CSU.UI.11 | 🟠 | La respuesta de noviembre pesa **3.4 MB** de JSON (737 cortes; comprimida en el cable) y tarda 1.1–1.2 s con la API local (3.6 s la primera vez); la regla es < 500 ms. En prod: **NO MEDIDO** | Doherty · Rendimiento | Medir en prod antes y después de soltar CSU.29+31; si pasa de 1.5 s, la llegada se pide aparte (no bloquea la lista) |
| CSU.UI.12 | 🟡 | La pestaña de facturas de la red pesa 197 KB comprimidos contra 33 KB por sucursal (CSU.30) | Rendimiento | CSU.32 pide por sucursal |

**Lo que pasa (✓):** contraste AA sin fallas en claro y oscuro, en los 3 perfiles (lo más justo: pastillas ámbar
4.52 y verde 4.57); cargando, falla con «Reintentar» que funciona y el aviso de septiembre; `/` lleva al buscador y
el foco se ve en todo el recorrido; ningún perfil se desplaza de lado; en Alto Contraste las pastillas conservan
borde y texto (medido por estilo).

**NO MEDIDO:** lector de pantalla, zoom al 200 % y reflujo a 320 px, la respuesta al toque (INP) y el tiempo en
prod.

**Veredicto de la pantalla de hoy, por capa:** Veracidad 🔴 (CSU.UI.1, .2) · Visibilidad 🔴 en celular y Fold
(CSU.UI.3) · Comprensión, Tablas, Jerarquía, Color y Rendimiento 🟠 · Contraste, estados y teclado ✓. Las 🔴 son
criterio de CSU.31: no pasa a 🚀 sin ellas.

## 11. CSU.31 — el diseño, antes de la plantilla (2026-11-27)

Los doce pasos de `diseno` §0a, cortos; la maqueta aprobada (pantallas 1 y 2) se respeta salvo donde §10 la corrige.

1. **Propósito.** *«¿Dónde está hoy el dinero que vendió cada caja?»* — por cobrar en Kepler, aplicado sin testigo,
   o ya en el banco o en Caja General. Absorbe «¿cuánto falta cobrar?»; «¿cuadró el arqueo?» sigue en el detalle
   (paso 2), como hoy.
2. **Quién entra** (`analytics.ui_usage`, 30 días al 27-nov): `finanzas_operativo` 339 consultas en 24 días ·
   `encargado_tienda` 125 en 15 (sólo su sucursal) · `superadmin` 24 · `direccion` 19 · `contabilidad` 10 · otros 5.
   En celular: 1 persona-día contra 55 en computadora (`uso-movil.js`): se diseña para escritorio y no se rompe
   en el Fold ni en el celular.
3. **El estado real** (CSU.27, 1–25 nov, 707 cortes): llegó 368 · por saber 84 · parcial 53 · sin conciliar 118 ·
   sin depósito 84. Lo que más pesa es «por saber» ($5.67 M en Santander 1604): **es lo primero que se dice**, con
   la cuenta y hasta qué día llega su libro.
4. **Nivel 0, en este orden:** la respuesta del periodo en una frase (reemplaza el renglón «Periodo …»; no es una
   franja nueva) → 5 indicadores (Vendido · Cobrado en Kepler · **Llegó a la empresa** · Pendiente de cobro · Sin
   cuadrar) → la lista por día.
5. **Qué NO se ve:**

   | Pieza de la maqueta o de hoy | Decisión | Por qué |
   |---|---|---|
   | Tarjetas «Lo que hay que revisar» (maqueta) | fuera | son filtros vestidos de franja (CSU.UI.10); las mismas cifras filtran desde la frase y el selector |
   | Columnas «Llegó» y «A dónde» en la lista (maqueta) | fuera | la tabla ya se corta en el Fold (CSU.UI.5): el estado de llegada **reemplaza** la columna «Cobro»; la cuenta va en el detalle, por depósito |
   | Columna «Caja» de la tabla del día | se funde en «Corte» (renglón de abajo) | una columna menos para que quepa en 750 px |
   | Paso «Llegó a la empresa» separado del de cobros (maqueta) | se funden: cada depósito dice debajo dónde llegó | el mismo depósito escrito dos veces era repetición (CSU.UI.10) |
   | Interruptor «Sólo con saldo» | se vuelve el selector **«Mostrar»** | un control por otro: cada opción con su número, igual al indicador (CSU.UI.2) |

6. **Mapa de desglose** (cada cifra → dónde se abre → qué trae → de dónde sale):

   | Cifra | Se abre en | Trae | Fuente |
   |---|---|---|---|
   | Llegó a la empresa | «Mostrar: Llegó» (los cortes) → el corte | cada depósito con su renglón del banco o su `CI`→`CC` | `CortesLlegadaResumen`, `CobroLlegada` |
   | Por saber · Parcial · Sin conciliar · Sin depósito (frase) | «Mostrar» con esa clase → el corte | por depósito: cuenta, hasta dónde llega el libro, o la edad sin depósito | `CorteLlegada`, `CobroLlegada` |
   | Pendiente · con más de N días | «Mostrar: Con saldo» / «Con saldo de más de N días» | los cortes con saldo | `CorteRow.saldo` |
   | Sin cuadrar · Venta sin forma de pago | «Mostrar» con esa clase → paso 1 y 2 del corte | la venta del turno contra lo que la caja registró cobrado | `CorteRow.sin_cuadrar`, `venta_turno` |
   | Conteos fuera de corte | «Mostrar: Días con conteos fuera de corte» | los conteos del día | `conteos_fuera_de_corte` |
   | Facturas del turno (detalle) | dentro del paso 1 | factura, tipo, ticket, monto, nota | `GET …/facturas?corte=<clave>` (CSU.30), pedido al abrir el corte |

7. **Accesibilidad de la información:** toda cifra a 1 clic de sus cortes; el corte, a 1 clic de cada depósito con
   su renglón del banco (fecha, concepto, monto) o su entrada de Caja General. El selector «Mostrar» se usa con
   teclado. Los estados llevan palabra, nunca sólo color. El **documento fuente** (el estado de cuenta) vive en
   Bancos: aquí se ve el renglón; abrir el archivo del estado de cuenta: **NO** en este item.
8. **Ligas:** de dónde viene = el corte `U-D-23` y sus tickets (Kepler); a dónde va = el renglón del banco (Bancos)
   o la entrada `CI-…` y su corte `CC-…` (Caja General). Ligar a mano lo sin conciliar es de Bancos.
9. **¿Le toca a esta pantalla?** Sí (D1 = a). La pestaña de facturas y el rastro de una factura son CSU.32.
10. **La maqueta:** las pantallas 1 y 2 del lienzo, con los cambios del paso 5. Se conserva todo lo de Edgar (arqueo,
    conteos del cajero, devoluciones, cancelados).
11. **Criterios:** CSU.UI.1–11 (§10). Además: el estado de llegada de un corte se pinta igual en la lista, en la
    frase del detalle y en su paso 3; `null` = «no se pudo medir», nunca «no llegó».
12. **Lo que la interfaz NO resuelve:** Santander 1604 sin pasar al banco (BFU); cuántos días sin depósito son
    alerta (D5, de Tesorería: mientras, el plazo de cobro que ya usa la pantalla); el tiempo de la venta por turno
    (CSU.29b).

**Jerarquía:** primario = la frase del periodo y los 5 indicadores · secundario = la lista por día con su estado ·
terciario = folios, caja-turno y cuentas. **Color:** neutro para «llegó» y «por saber»; ámbar para lo que espera
más del plazo («sin depósito» vencido, «sin conciliar»); rojo sólo lo que ya era rojo (faltante de arqueo, cobrado
de más).

## Bitácora

- **2026-11-26** — Rastreo a mano de 623 facturas de contado de Morelia Abastos (10-sep → 26-nov) y cruce con el
  banco de los 41 cortes con hueco: los 128 depósitos están en el banco. Francisco pide dónde vive el módulo; se
  propone este anexo, se hace la maqueta y Francisco la aprueba. Medición de la red (§2).
- **2026-11-26 (noche)** — Francisco elige D1 = a y D2 = b. CSU.26 🧪: el testigo pasa a ser la conciliación de
  Bancos (§2b) — llegó 71.9 %; el hueco grande es Santander 1604 sin pasar al banco (bloqueo de BFU, §8).
- **2026-11-26 (noche)** — CSU.27 🧪. La venta del turno resultó testigo del corte en 698 de 707; con ella, la venta
  sin forma de pago baja de «41 cortes / $686,250.43» (regla hecha a mano en el rastreo) a **33 / $471,283.35** (la
  regla del motor + testigo). La cifra que vale es la segunda.
- **2026-11-26 (noche)** — CSU.28 🧪. Las 3,658 facturas de contado de la red (1–25 nov) tienen su ticket; 3,648 su
  corte. Falta colgar CSU.26–28 del servicio y el contrato (CSU.29): ahí se toca el código de Edgar.
- **2026-11-26 (noche)** — CSU.29 🧪. `origin/main` no traía cambios de Edgar en CSU. La respuesta ya trae la llegada
  y la venta del turno; +34 a +39 KB comprimidos por mes; el anexo cuesta lo de la venta por turno (345–507 ms en la
  base): `[CSU.29b]` queda como deuda con nombre. Sigue CSU.30 (las facturas en la API) y después la pantalla.
- **2026-11-27** — CSU.30 🧪: la API de facturas, con el estado del corte de cada una. En la red (1–25 nov), de 2,082
  «Cont No Fiscal» 1,420 están en cortes que llegaron; de 1,576 «TK Contado», 594. Lo que falta es C3 (CSU.31 y
  CSU.32): ya toca el componente de Edgar.
- **2026-11-27** — Prueba visual en nivel A de la pantalla de hoy, en los 3 perfiles, antes de tocarla (§10): 3 🔴
  de la pantalla de hoy (una fecha futura de Kepler publicada como «último cobro», cifras que no llevan a sus
  cortes, el detalle fuera de la vista en celular y Fold), 1 🔴 de la entrega (CSU.29 y CSU.31 salen juntos), 7 🟠
  y 1 🟡. Quedan como criterios de CSU.31 y CSU.32.
- **2026-11-27** — CSU.31 🧪: la pantalla dice dónde está el dinero. Diseño escrito antes de la plantilla (§11);
  la prueba visual de después, en los 3 perfiles, cumple CSU.UI.1–6, 9 y 10 (cada cifra lleva a su número, el
  detalle a la vista en celular y Fold); CSU.UI.8 y 11 esperan a soltar CSU.29–31 juntos. Sigue CSU.32 (la pestaña
  de facturas y el rastro de una factura).
- **2026-11-27** — Antes de enviar el PR, una revisión independiente del diff encontró 4 defectos y 4 casos de borde.
  Cada uno se verificó en el código y se midió en prod: el que pesaba era el último día del libro de Bancos, que viene
  cortado en 7 de 16 cuentas (29 depósitos, $1,056,681.22, pasan de «sin conciliar» a «por saber»). Los demás son 0
  casos hoy y se corrigieron igual; las llaves sin sub-tipo, 0 colisiones, se declaran.
