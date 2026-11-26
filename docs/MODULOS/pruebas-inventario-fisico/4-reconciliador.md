# 4 · Reconciliador — el que cierra el folio

> Pruebas **de esta persona**. Lo común vive en
> [`../inventario-fisico-PRUEBAS.md`](../inventario-fisico-PRUEBAS.md).

> ⛔⛔ **ESTE BLOQUE NO SE CORRE TODAVÍA.** El ajuste cae en `commercial.stock`, congelada desde
> `[CANON.7.5]`: una prueba de cierre **saldría verde sin que pasara nada**, que es peor que
> fallar, porque dejaría escrito que el cierre funciona. Se corre **después de D-EX8**. Queda
> redactado para estar listo ese día.

## Quién es, medido en prod el 2026-11-25

**17 personas** con `COMMERCIAL_INVENTORY_RECONCILIAR`:

| Rol | Personas |
|---|---:|
| `superadmin` | 10 |
| `compras` | 4 |
| `gerente_compras` | 4 |
| `supervisor` | 3 |

⭐ **Marketing queda fuera**: puede abrir y congelar un almacén, pero no cerrarlo. Todos entran
desde Windows.

⭐⭐ **Lo que define a esta persona: es la única cuyo clic MUEVE EXISTENCIA.** Todos los demás
leen, asignan o capturan; ésta escribe el saldo. Por eso su bloque es el único con segregación de
funciones: **quien contó no puede cerrar**.

---

## Su jornada

```
entrar → /almacen/inventory/sessions/:id (detalle)
       → revisar cobertura y discrepancias
       → resolver renglón por renglón lo que no coincide
       → Reconciliar  ← el único clic que escribe
       → exportar el archivo para Kepler
```

---

## `REC-J` · La jornada tiene que funcionar

| ID | Paso | Tiene que pasar | Niv |
|---|---|---|---|
| `REC-J1` | Abrir el detalle | Ve cobertura, teórico, contado y varianza por renglón | B |
| `REC-J2` | Resolver una discrepancia a mano | Queda como resuelta, con quién la resolvió | B |
| `REC-J3` | Recalcular discrepancias **después** de resolver a mano | ⛔ **La resolución manual sobrevive**: el recálculo no la revierte | 🔴 B |
| `REC-J4` | Reconciliar un folio completo | Se aplica, el folio queda `reconciled`, y el resumen dice cuántos renglones se ajustaron y por cuánto | B |
| `REC-J5` | Exportar para Kepler | Sale el archivo con entradas y salidas, y queda registrado en `inventory_kepler_exports` *(hoy esa tabla está vacía: nunca se ha exportado)* | B |

---

## `REC-H` · Los errores que **sólo esta persona** comete

| ID | Qué se hace a propósito | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `REC-H1` | Cerrar **habiendo contado** un renglón del folio | **403 por segregación de funciones.** Es el control que impide que quien cuenta mal se absuelva solo | 🔴 | B |
| `REC-H2` | Cerrar **sin usuario de sesión** | 403: la reconciliación mueve existencia y exige saber quién | 🔴 | B |
| `REC-H3` | Cerrar con **SKUs sin contar** | Bloqueado — y el aviso tiene que haber llegado **antes**. ⚠️ *Éste es el defecto que mató los seis folios de junio: nadie supo que no podía cerrar hasta tener 3,664 SKUs contados y a la gente parada* | 🔴 | B |
| `REC-H4` | **Doble clic** en Reconciliar | Una sola aplicación | 🔴 | C |
| `REC-H5` | Cerrar **dos veces** el mismo folio | 409 claro | 🟠 | B |
| `REC-H6` | Cerrar un folio **cancelado** | 409 claro | 🟠 | B |
| `REC-H7` | Resolver un renglón **poniendo el teórico** porque «seguro está bien» | Anotar si hay registro de quién lo resolvió y con qué criterio (`resolved_by`, `reason_code`) | 🟠 | B |

---

## `REC-V` · Veracidad del ajuste — **las pruebas más caras del documento**

Aquí es donde un error no se ve: produce un número creíble y equivocado.

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `REC-V1` | ⛔⛔ Cerrar un folio **congelado** después de que la tienda **vendió por el POS** | **Hoy aplica un set absoluto y borra esas ventas.** El *freeze integrity guard* busca los movimientos en `commercial.stock_movements` —nuestra tabla, 102 filas en toda su historia— y es **ciego a Kepler**, que es por donde se mueve la mercancía de verdad. **Ésta es la prueba más importante de todo el plan** | 🔴 | B |
| `REC-V2` | Cerrar un folio **no congelado** (cíclico) con ventas en medio | Aplica **delta relativo** contra `book_at_count` y **conserva** las ventas. Es el camino correcto, y hay que verificar que de verdad lo tome | 🔴 | B |
| `REC-V3` | Un renglón **sin costo en ningún ERP** | `unit_cost` queda **nulo**, nunca cero. Un cero publica la merma de ese renglón como $0.00, indistinguible de «no hubo merma» (ADR-056) | 🔴 | B |
| `REC-V4` | Un renglón cuyo saldo quedaría **bajo lo reservado** | Ese renglón queda como diferencia con su nota, el resto se aplica, y ⚠️ **el resumen tiene que decir cuántos quedaron fuera** y dejarlos listos para reintentar | 🟠 | B |
| `REC-V5` | Comparar el **teórico del folio** contra la existencia del ODS **en el momento de cerrar** | ⛔ Hoy nadie hace esa comparación. El teórico es una foto tomada al abrir y nada dice cuánto envejeció | 🔴 | B |
| `REC-V6` | Cerrar y después **leer la existencia en la pantalla de almacén** | ⛔ **Hoy el ajuste no se vería**: cae en tabla congelada. Es por esto que el bloque está suspendido | 🔴 | B |

---

## `REC-C` · Causalidad

| ID | Qué se provoca | Tiene que pasar | Sev | Niv |
|---|---|---|---|---|
| `REC-C1` | ⭐ Cerrar un folio total de **4,819 renglones** (Padre Hidalgo) | **Medir el tiempo y anotarlo.** El tope es `statement_timeout = 60s` y se recorre renglón por renglón —bloqueo, actualización, movimiento, estado—: unas **19 mil sentencias** en una sola transacción, ~3 ms de presupuesto cada una. Si no cabe, se descubre con la sucursal parada | 🔴 | B·M |
| `REC-C2` | ⚡ **Cortar la luz del servidor** a media reconciliación | Todo es una transacción: o entra completo o no entra. El folio sigue abierto y se reintenta sin quedar a medias | 🔴 | B |
| `REC-C3` | **Matar el pod de la API** a media reconciliación | Igual | 🔴 | B |
| `REC-C4` | Cortar la **red del navegador** mientras el servidor reconcilia | El servidor termina igual. Anotar qué ve la persona y si puede saber el resultado al volver | 🟠 | B |
| `REC-C5` | Reconciliar **dos personas a la vez** el mismo folio | Una gana (`forUpdate` sobre el folio), la otra recibe 409 | 🔴 | B |

---

## `REC-N` · Sus negativas

| ID | Qué intenta | Tiene que pasar | Niv |
|---|---|---|---|
| `REC-N1` | Un usuario **`marketing`** cierra un folio | **403.** Abre y congela, pero no cierra | B |
| `REC-N2` | Un **`almacenista`** cierra | 403 | B |
| `REC-N3` | Un **`encargado_tienda`** cierra | 403 | B |
| `REC-N4` | Exportar a Kepler sin `RECONCILIAR` | 403 | B |
| `REC-N5` | Reconciliar un folio **de otro tenant** | 404 | B |

---

## Lo que esta persona enseña del módulo

`REC-V1` y `REC-C1` son, juntas, la razón por la que el módulo no debe encenderse: **una puede
destruir existencia y la otra puede no terminar nunca.** Ninguna de las dos se descubre leyendo
código ni probando con tres SKUs: hay que cerrar un folio del tamaño real, con movimiento real
en medio. Es la prueba más cara de montar y la única que decide.
