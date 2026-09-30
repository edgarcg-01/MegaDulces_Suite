# Fase BP — Bitácora de productos retirados del ticket en el POS

> **Estado: 🔨 DISEÑADO (medido, sin código).** 2026-09-28.
> Pregunta que la originó: *"¿Kepler almacena cuándo el cajero borra un producto que agregó
> por error en el POS?"*
>
> **Respuesta corta: no lo almacena, y no hay nada que activar.** Lo que sigue es cómo se
> midió, qué se descartó y por qué, y qué se propone construir.

---

## 1 · El punto de partida era incorrecto, y descartarlo es parte del resultado

La hipótesis inicial fue la tabla **`pos95historico`**. No puede ser: sus 11 columnas son de
caja (`k_tipomovimiento`, `k_monto`, `k_folio_apertura`, `k_moneda`, `k_cajero`, `k_supervisor`)
y **no tiene ninguna columna de producto**. Además está en **0 filas en las 9 ramas**, junto con
`pos95caja` y `pos95cajero` — y ya estaba vacía en un volcado del **19-jun-2026**, así que el
módulo POS95 nunca se usó. El POS vivo es la generación `kdpv_*` (`kdpv_kdku` 153 cajeros con
PIN, `kdpv_gerentes`, `kdpv_folio_caja`).

*Sin esta medición, alguien podía pasar semanas buscando el interruptor de una tabla que no
puede guardar lo que se le pide.*

---

## 2 · El mecanismo real, leído en el fuente y confirmado en vivo

El cliente de Kepler guarda sus programas en `.kpl` (XML + script, UTF-16 LE). El flujo es:

1. La rejilla del ticket tiene `OnF10="Dialog(0,pv_aut_cambios)"` sobre la columna Producto.
2. **F10** abre `pv_aut_cambios.kpl` — *"Eliminación Autorizada de Productos"*.
3. Valida al supervisor contra `kdpv_kdku` (PIN) y `kdpv_gerentes` (que sea gerente de esa
   sucursal). ⭐ **`kdb.open("g,kdpv_gerentes,u,kdpv_kdku")` — sólo esas dos tablas, sólo lectura.
   Cero escrituras.**
4. `elimina_prod()` en `pv_tk.kpl` **marca la celda en memoria**:
   `frn.setX("ELIMINADO","k_mov",-1,"k_parte")` y antepone `"ELIMINADO "` a la descripción.
5. `pv_tk.kpl` línea 1335 **impide grabar** cualquier renglón con cantidad ≤ 0
   (*"Se ha generado el siguiente error: producto con cantidad 0"*), así que el renglón marcado
   **no puede llegar a la base**: hay que quitarlo de la rejilla para poder cobrar.

**El evento se autentica con un supervisor y después Kepler se asegura de que no quede rastro.**

### 2.1 · Cinco mediciones independientes

| prueba | resultado |
|---|---|
| Numeración `kdm2.c7` en tickets U-D-10 (7 d, rama 03) | **0 huecos**, 0 duplicados, todos arrancan en 1 — 5,237 tickets / 20,123 renglones |
| Σ`kdm2.c13` vs `kdm1.c16` | **5,239 de 5,239 cuadran al centavo** |
| Secuencia de folio U-D-10, 5 cajas, 30 d | **0 folios faltantes** en 21,213 tickets |
| `"ELIMINADO"` en las **46 columnas de texto** de `kdm2` (rama 04, tabla completa) | **0 coincidencias** |
| Barrido de escrituras: 323 tablas, antes/después de un borrado real | sólo se movió lo de vender; `kdlogmov` **0→0**, `pos95historico` **0→0**, `orglogtbl_26` +8 y **todas `sysConnect`** (contabilidad de sesión) |

### 2.2 · Confirmado en runtime, en una caja real

Un operador hizo el F10 en `44caja1` (sucursal 04). En pantalla apareció
`ELIMINADO LA ROSA MAZAPAN /30`; en la base, **nada**. Y con el ticket `UD1005-0000001` abierto
en pantalla, `kdm1` tenía como último folio el **anterior** — *el documento no existe hasta que
se graba*.

⭐ La misma pantalla confirmó gratis otra cosa: **`Hora Ticket 17:42:40.28`** — la hora de Kepler
lleva **centésimas**, lo que coincide con lo medido en 610,000 filas (§5.2).

---

## 3 · No hay interruptor: `kdconfig` trae el catálogo completo

`md.kdconfig` (clave `c1`=módulo, `c2`=parámetro, `c3`=valor, `c4`=descripción) tiene **48
parámetros**, idénticos en las 9 ramas. **5 tienen valor vacío pero existen como fila con su
descripción** → la tabla guarda el catálogo entero, no sólo lo configurado. Por lo tanto los
**19 parámetros de la sección `POS` son la lista completa**, y **ninguno es de bitácora**.

Sí existe el que controla el evento:

```
POS | k_passRow | 1 | Se requere la contraseña de supervisor para eliminar un registro del grid Si(1)/No(0)
```

**Kepler controla el borrado pero no lo anota.** No es una bitácora apagada: no existe.

---

## 4 · Por qué no se puede parchear por nuestra cuenta

### 4.1 · El cliente re-descarga y borra cualquier parche local — medido

Se instaló el parche en el caché local del cliente de desarrollo (`D:\K95_Dev\temp\`), verificado
byte a byte. Al abrir Kepler, el cliente **se bajó las páginas del servidor y lo sobrescribió**:

```
18:24:41  pv_tk.kpl            (380,684 bytes — la copia previa tenía ~348 KB)
18:24     pv_lib.kpl
18:25:02  pv_aut_cambios.kpl   (4,474 bytes — ni el parche de 5,740 ni el original de 4,340)
```

El parche duró 90 minutos en disco y **cero segundos en ejecución**.

### 4.2 · Las páginas viajan por protocolo propietario, no por carpeta

`md.pv_suc_ip` lista los 9 servidores de aplicación, todos en el **puerto 1801**
(`mdyurecuaro.ddns.net`, `mddlaph.ddns.net`, …). Verificado: `192.168.10.10:1801` y
`192.168.44.44:1801` responden. **Un mirror exigiría reimplementar un protocolo sin documentar.**

### 4.3 · El proveedor edita ese archivo activamente

`pv_aut_cambios.kpl` **cambió el mismo 2026-09-28**, mientras se hacía esta investigación:

```diff
- tit="Eliminación Autorizada de Productos"
+ tit="Modificación Autorizada de Productos"
- <inp id="q" ... visible="N"/>
+ <sp/><txt>Cantidad</txt> <inp id="q" ... visible="Y"/>
-          pon();
+            //pon();
```

La función pasó de *borrar* a *modificar la cantidad*: ahora el campo Cantidad es visible y el
supervisor escribe el valor nuevo. **Y la versión nueva sigue sin registrar nada**
(`kdlogmov`=0, `BORR`=0, `kdb.write`=0).

### 4.4 · Las sucursales corren versiones distintas

La caja mostraba *"Ventas 1.39"*; el cliente de desarrollo, *"Ventas 1.42"*. Cada una baja de su
propio servidor. **Un parche habría que aplicarlo y mantenerlo en 9 servidores, y el proveedor lo
pisa en cada entrega.**

> ⛔ **Y una tabla nueva no se puede crear con SQL**: Kepler resuelve las tablas por su propio
> diccionario (`sysTable`/`sysColumn`), que **no vive en Postgres** (verificado: no existe en la
> réplica ni en el origen). Una tabla creada sólo en la base sería invisible para `kdb.open`.

---

## 5 · Lo que sí se aprendió del ERP, y vale por separado

### 5.1 · ⭐ Bug del proveedor: la llave de TODO lo que se borra del catálogo se pierde

`kdlogmov` es la bitácora de cambios campo por campo de Kepler
(`c1`=usuario · `c2`=fecha · `c3`=hora · `c4`=programa `.kpl` · `c5`=columna o `BORR` ·
`c6`/`c7`=valores · `c8`=tabla · `c9`=llave). **PK = `(c1,c2,c3,c4)`.**

**14 programas** escriben ahí. Al borrar un registro escriben `c5='BORR'` — pero
**13 de los 14 pierden la llave**, así que Kepler sabe que *algo* se borró y no *qué*.

La causa, predicha desde el fuente y confirmada contra la base:

```
fun camposLlave() { var llave="'" & frn.get("clave") & "'"; return llave; }   // devuelve YA entrecomillado
...
kdb.write("...,6,'"&camposLlave()&"',...")                                    // y se usa entrecomillado OTRA VEZ
```

Produce `6,''05001''` → Kepler guarda **`''`**, que es exactamente el valor medido en la base.
El único correcto es **`documentos.kpl`**, que arma la llave en línea y escribe `c7` **y** `c9`:
**9 de 9 filas con llave**, contra **0** en todos los demás.

⚠️ Segundo defecto de la misma tabla: con PK a resolución de **1 segundo**, dos eventos del mismo
usuario en el mismo segundo **se pisan**. Medido: pasó 1 vez en ~800 filas (un CAMBIO sobrescrito
por un BORR), y explica la única fila anómala del conjunto.

### 5.2 · La hora de Kepler: dos funciones, dos resoluciones

Separación perfecta en **610,000 filas**, sin una sola excepción:

| columna | quién la escribe | filas | sólo segundos | con centésimas |
|---|---|---|---|---|
| `kdlogmov.c3` | `sys.time()` | 17,554 | **17,554** | 0 |
| `kdpv_bitacora_precios.c2` | `kdb.get("time")` | 592,441 | 0 | **592,441** |

### 5.3 · Los borrados de CATÁLOGO ya los tenemos, gratis

`kepler_ods.kdii` **no propaga DELETE** (decisión explícita de `ods-reconcile-chicas`), así que
conserva los productos borrados en origen: **59 SKUs en la rama 03** (41–65 por rama), con todos
sus datos, y el ODS es **superconjunto perfecto** (0 huecos en la dirección contraria).
Verificado por contenido: 45 de 59 son `* DESCONTINUADO` / `****` / vacíos.
⚠️ **Sin columna de tiempo**: sabemos *qué* se borró, no *cuándo* ni *quién*.

### 5.4 · ⚠️ Hallazgo de seguridad, ajeno a esta fase

`pv_sc_lib.kpl` —la librería que replica cambios de catálogo a las 9 sucursales— **lleva usuario
y contraseña de SUPERADMIN en texto plano en el fuente**, y con ellos abre conexión a cada
sucursal leyendo `md.pv_suc_ip`. Reportado aparte.

---

## 6 · Lo que se propone construir

Con el proveedor fuera de alcance y el parche descartado (§4), el dato **tiene que nacer de una
persona**. Precedente directo en este proyecto: la Fase **FLT**, que nació del mismo problema —
*un hecho que ningún feed puede ver porque nunca toca la base*.

### BP.1 · Captura HITL

Tabla propia (no vista), `tenant_id` + RLS forzado + campos de auditoría completos. Registra:
sucursal, caja, supervisor que autorizó, cajero, producto, cantidad original, cantidad nueva,
**motivo** (CHECK cerrado) y notas. El motivo es lo único que **ningún** parche podría darnos.

Pantalla propia, a un clic de donde el supervisor ya está parado tecleando su contraseña.

### BP.2 · Termómetro, para que la captura sea auditable

Sin denominador, una captura manual es un papel. El denominador sale del **Postgres de cada
sucursal** (no de la réplica: **las lecturas no se replican** — el `seq_scan=1019` de la réplica
es ruido de nuestro propio pipeline releyendo el catálogo).

⭐ **Sólo dos programas tocan `kdpv_gerentes`**: `PV_abre_caja.kpl` (una vez por turno) y
`pv_aut_cambios.kpl` (cada autorización). Y las aperturas de caja **se cuentan exacto** en
`kdpv_folio_caja`. Entonces:

```
autorizaciones ≈ Δ seq_scan(kdpv_gerentes) − Δ aperturas de caja
```

Medido en la rama 04: `seq_scan = 5344`, `stats_reset = nunca`.

⚠️ **Requiere calibración antes de publicar cualquier número**: hay que hacer N autorizaciones
controladas y medir cuánto sube el contador por cada una. Sin eso es una razón sin unidad.
⚠️ Y el contador **se reinicia si el Postgres de la sucursal cae** → el hueco se declara, no se
interpola.

⛔ `pg_stat_statements` daría un denominador exacto, pero **está disponible y no instalada**, y
activarla exige reiniciar el Postgres de la sucursal = parar la venta. **Descartado.**

### BP.3 · El cruce

`capturas / autorizaciones estimadas` = cumplimiento, por sucursal y por supervisor. Es lo que
convierte la captura manual en un control exigible.

---

## 7 · Decisiones abiertas

- **¿Tenemos acceso administrativo a los 9 servidores de aplicación (puerto 1801)?** Si las
  páginas son archivos en una carpeta ahí, la vía automática vuelve a estar sobre la mesa —
  con el costo permanente de §4.3 y §4.4.
- El factor de calibración de BP.2 (autorizaciones por incremento de `seq_scan`).
- Si la captura vive en la superficie de tienda (patrón FLT, `/tienda/*`) o en Operación.

## 8 · Lo que NO se probó

- **El parche nunca se ejecutó.** Quedó verificado estructuralmente (XML, balance, comillas,
  `kdb.exec()`, cadena carácter por carácter idéntica a `documentos.kpl`) y **fue borrado por la
  re-descarga antes de correr**. No hay evidencia de runtime de que `kdb.write` acepte la cadena.
- El comportamiento de la versión nueva (*"Modificación Autorizada"*) no se ejerció.

---

## 9 · Línea base del termómetro — 2026-09-28 18:47 MX

Leída del Postgres **de cada sucursal** (no de la réplica). `stats_reset = nunca` en las nueve,
así que los contadores no se han perdido y el Δ será limpio.

| rama | `seq_scan` kdpv_gerentes | aperturas (`kdpv_folio_caja`) | gerentes | cajeros |
|---|---|---|---|---|
| 00 | 346 | 2 | — | — |
| 01 | 29,982 | 658 | 18 | 158 |
| 02 | 18,314 | 1,174 | — | — |
| 03 | 2,439 | 1,064 | 4 | 154 |
| 04 | 5,345 | 502 | 5 | 134 |
| 05 | 7,442 | 570 | — | — |
| 06 | 11,631 | 183 | — | — |
| 07 | 1,225 | 78 | — | — |
| 08 | 3,724 | 53 | — | — |

⛔ **Los valores absolutos NO son comparables entre ramas** — acumulan desde momentos distintos.
Un primer intento de validar el diseño comparando la razón `seq_scan / aperturas` entre sucursales
dio 2.3 / 10.6 / 45.6 y **no significa nada**: la medición válida es el **Δ sobre una ventana
conocida**, que es para lo que existe esta línea base.

### 9.1 · ⭐ Calibración accidental: el contador sube 1 por escaneo

Entre dos lecturas separadas por minutos, las ramas 01 y 04 subieron **exactamente +1** cada una.
No fue el POS: fue una consulta propia `select count(*) from md.kdpv_gerentes`.

Dos consecuencias:

1. **El contador incrementa 1 por escaneo de la tabla** — es la unidad del termómetro.
2. ⛔ **El poller NO debe consultar `kdpv_gerentes`**, o se cuenta a sí mismo. Sólo
   `pg_stat_user_tables` y `md.kdpv_folio_caja`. La consulta de línea base ya cumple esto.

### 9.2 · Lo que falta calibrar

Cuántos escaneos genera **una** autorización (`pv_aut_cambios.kpl` hace un `kdb.search` sobre el
alias `g`, pero habría que confirmar si el `kdb.open` también escanea) y cuántos **una apertura de
caja** (`PV_abre_caja.kpl`). Se mide con N eventos controlados contra esta línea base.
**Hasta tenerlo, el termómetro no publica números.**

---

## 10 · ⛔ CORRECCIÓN: el termómetro de §6/BP.2 se descartó, medido

Lo de arriba (§6 BP.2, §9) describe un termómetro que cuenta las lecturas de `kdpv_gerentes`.
**Se construyó el diseño, se midió, y se cayó solo.** Queda escrito para que nadie lo reconstruya:

| defecto | medición |
|---|---|
| Las lecturas **no se replican** | el `seq_scan=1019` de la réplica es ruido de nuestro propio pipeline releyendo el catálogo. El contador real vive en el Postgres de cada sucursal → habría que abrir conexiones a **las 9 máquinas donde se cobra** |
| **El poller se cuenta a sí mismo** | verificado: cada consulta a la tabla suma exactamente +1 |
| Mezcla dos hechos | `PV_abre_caja.kpl` también la lee |
| **Sin atribución** | no dice quién autorizó ni en qué caja |
| Se reinicia | si el Postgres de la sucursal cae, el hueco no se interpola |
| Necesita calibración | sin saber cuántos escaneos genera una autorización, la razón no tiene unidad |

⛔ `pg_stat_statements` daría el denominador exacto, pero **está disponible y no instalada**, y
activarla exige **reiniciar el Postgres de la sucursal = parar la venta**. Descartado.

### Lo que se construyó en su lugar: `analytics.v_pos_void_capture_rate` `[BP.9]`

**Capturas por cada mil tickets**, por sucursal y semana. Los tickets ya están en el ODS
(`kepler_ods.kdm1`, `U-D-10`, frescos al día): **cero conexiones nuevas, cero calibración, cero
tablas** — derivada, como manda la regla.

⚠️ **Mide cumplimiento RELATIVO** —una plaza contra sus pares, una semana contra la anterior—.
**No** dice cuántos retiros quedaron sin registrar: eso exigiría saber cuántos ocurrieron, que es
exactamente lo que Kepler no guarda. Una plaza con 0.2 por mil al lado de otra con 8 es una
**pregunta**, no una medición de fraude.

**Rendimiento medido contra prod:** 318 ms a 12 semanas. La forma importa — agregar `kdm1` antes
de unir (96 filas en vez de 44 mil) bajó de **702 ms a 318**.

**Verificado en laboratorio, 6 de 6:** ignora los doctypes ajenos (9,999 filas de `U-D-6` no
entran), la tasa cuadra, una sucursal sin capturas aparece con 0 **y no desaparece de la lista**,
el monto viaja con su acompañante `sin_valorar`, una sucursal sin capturas da valor **NULL y no 0**,
y `security_invoker` está activo (sin él la vista saltaría el RLS).

### Lo que esto deja pendiente, honestamente

La **calibración** (§9.2) ya no bloquea nada: la vista no la necesita. Pero con ella se pierde la
posibilidad de estimar el cumplimiento **absoluto**. Se declara: hoy sabemos si una plaza registra
mucho menos que sus pares; **no** sabemos cuántos retiros ocurrieron en total.
