# `[RD.32]` Repartir la existencia a las once camionetas

> Qué hace: que cada camioneta mande **lo que trae arriba**, no sólo lo que vendió.
> Hermano de [`RUNBOOK_ALTA_CAMIONETA.md`](RUNBOOK_ALTA_CAMIONETA.md) (que da de alta el push de venta).
> Levantado el **2026-10-05**.

---

## 0. Por qué, en tres cifras

Kepler **central** no publica saldo de ruta (`kdik` sólo tiene una fila por sucursal; los almacenes
`01-00N` no existen ahí) y **no hay documento de retorno**. Así que el saldo del camión se venía
reconstruyendo de *embarque menos venta*. Medido en la ruta 21:

| | |
|---|---|
| lo que la pantalla publicaba | **$18,427** |
| lo que el camión traía | **$37,766** |
| de la diferencia, mercancía que ya traía antes de que viéramos sus ventas | **89 %** |

⭐ El Kepler **de la laptop** sí lo sabe — de ahí salió el reporte que destapó esto. Y ya hay un
canal que lo trae: el agente que empuja la venta **cada 15 minutos**. Le falta **una consulta**.

⛔ Por eso no se construyó una pantalla para subir un Excel. Un archivo que alguien sube a mano
envejece el día que esa persona se va de vacaciones.

---

## 1. Lo que ya está hecho (no repetirlo)

- ✅ **Lado runner aplicado** en `kepler_consolidado` (`192.168.0.222:5433`) el 2026-10-05:
  `ingest.route_stock_stg` · `mart.existencias_ruta` · `ingest.merge_route_stock(text)` ·
  `ingest.route_stock_heartbeat`, con sus `GRANT` al rol `ingest`.
  Fuente: [`runner-stock-setup.sql`](runner-stock-setup.sql). **Es aditivo: no toca nada de ventas.**
- ✅ Verificado en vivo con prueba negativa: un segundo push que sólo trae `X2` **borra** a `X1`
  de la foto (reemplaza, no acumula) y los productos en existencia 0 **no entran**.
- ✅ Plantilla actualizada: [`push-ruta.v2.template.cmd`](push-ruta.v2.template.cmd).
- ✅ Verificador de reparto: `node database/scripts/check-route-stock-push.js`.

---

## 2. ⭐ El pegado es IDÉNTICO en las once

No hay nada que personalizar por camioneta. El bloque nuevo usa **sólo variables que el archivo de
esa van ya define** (`%PSQL%`, `%SRC%`, `%DST%`, `%TRUCK%`, `%LOG%`) — verificado leyendo las dos
plantillas: **v1 y v2 definen las mismas cinco**. Una van vieja sirve igual que una nueva.

⇒ Se copia y se pega. No se edita, no se busca la serie, no se pregunta la base local.

En `C:\KeplerPush\push-ruta.cmd`, **antes** de la última línea `echo ... OK %TRUCK%`:

```bat
%PSQL% "%DST%" -c "delete from ingest.route_stock_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% "%SRC%" -c "\copy (select '%TRUCK%',btrim(k.c2),btrim(i.c2),btrim(i.c11),k.c5::numeric,k.c16::numeric,(k.c5*k.c16)::numeric from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0) to stdout csv" | %PSQL% "%DST%" -c "\copy ingest.route_stock_stg (truck,sku,producto,unidad,existencia,costo,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge existencia -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_stock('%TRUCK%')" >> "%LOG%" 2>&1
```

**Las columnas están verificadas contra el ODS, no adivinadas** (2026-10-05):
`kdii.c1`=SKU · `kdii.c2`=descripción · `kdii.c11`=unidad · `kdik.c2`=SKU · `kdik.c5`=existencia ·
`kdik.c16`=costo. La unidad del reporte que imprime el camión coincide con `kdii.c11` en
**256 de 257** renglones; la única que no, **viene en blanco en el origen**.

---

## 3. El orden: la 21 primero, y sola

⛔ **No se reparte a las once hasta que la 21 cuadre.** Es la única de la que tenemos el número que
el propio camión imprimió, así que es la única que puede decirnos si la consulta está bien.

### 3.1 En la laptop de la 21

1. **Identificarla.** ⚠️ Las IPs de la tabla de inventario **no son confiables** — son laptops que
   viajan y toman DHCP. La única forma segura, ya adentro:
   ```bat
   findstr /i "TRUCK" C:\KeplerPush\push-ruta.cmd
   ```
   Tiene que decir `set TRUCK=ruta_21`.
2. **Respaldar** antes de tocar: `copy C:\KeplerPush\push-ruta.cmd C:\KeplerPush\push-ruta.bak.cmd`
3. **Pegar** el bloque de §2 antes del `echo ... OK`.
4. **Correr a mano** sin esperar los 15 min:
   ```bat
   schtasks /Run /TN "Ruta21"
   ```
   ⚠️ `schtasks /Query /TN "Ruta*"` **no funciona** (`/TN` no acepta comodines y el error se lee
   como "la tarea no existe"). Es `schtasks /Query /FO LIST | findstr /i "Ruta"`.
5. **Mirar el log**: `type C:\KeplerPush\push_ruta_21.log` — las últimas líneas deben traer
   `merge existencia -> filas:` con un número distinto de cero.

### 3.2 La aceptación, desde cualquier lado

```
node database/scripts/check-route-stock-push.js --truck ruta_21
```

**Esperado:** la foto del día con **257 productos** y **$37,765.58** (±$0.04 por redondeo de
renglón), que es lo que la 21 imprimió el 2026-10-05.

| si pasa | significa |
|---|---|
| cuadra | la consulta está bien → se reparte a las otras diez |
| **el total no cuadra pero los productos sí** | el **peldaño de la unidad**: el costo viene en otra unidad que la cantidad. ⛔ No repartir |
| **vienen muchos más productos** | la laptop sirve a **más de una ruta** y `kdik` las mezcla. Para la venta hay filtro de serie (`c63`); para la existencia **no hay**, y hay que resolverlo antes |
| no llega nada | el runner no contesta. El agente **sale en silencio** por diseño: ver `RUNNER_CONN` en el log |

---

## 4. Las otras diez

Mismo §3.1, cambiando el nombre de la tarea. Al terminar, el tablero completo:

```
node database/scripts/check-route-stock-push.js
```

Estado al 2026-10-05, antes de empezar:

| camioneta | venta | existencia |
|---|---|---|
| 21 · 22 · 23 · 26 · 27 · 28 · 501 · 502 · 503 · 504 | al día (6 min – 8.3 h) | ⬜ sin repartir |
| **505** | ⛔ **21 días** | — |

⚠️ **La 505 no es un problema de este reparto**: lleva 21 días sin empujar *venta*. Pegarle el
bloque no la arregla — hay que levantarla primero (`RUNBOOK_ALTA_CAMIONETA.md`, CASO 4).

---

## 5. Lo que queda declarado, no resuelto

- ⛔ **La contraseña del rol `ingest` viaja en texto plano** dentro de cada `push-ruta.cmd`, en las
  once laptops. Este reparto **no la empeora** (usa la misma variable `%DST%` que ya estaba), pero
  es buen momento para rotarla: tocar las once ya está en el programa.
- ⚠️ **Una laptop con dos rutas mandaría la existencia sumada.** La venta se separa por serie
  (`kdm1.c63`); `kdik` no tiene con qué. Si aparece, hay que decidir cómo partirlo — y la
  aceptación de §3.2 lo delata antes de que contamine.
- ⚠️ **La foto no sabe la hora de la laptop.** La fecha la pone el runner en hora de México a
  propósito: son once relojes que nadie sincroniza, y la fecha es parte de la llave.
- ⬜ **El feed runner → prod ya está escrito pero NO agendado**:
  `database/importers/kepler/import-route-stock.js`. Se corre a mano la primera vez
  (`--apply`), se mira que la 21 quede en $37,765.58, y **recién después** se agenda en
  `ops/vl/crontab.feeds`. Agendarlo antes haría que lata en verde entregando cero, que es
  justo la falla que la Fase OBS existe para evitar.

  ⭐ El feed trae su propio freno: mide **cuántos SKU de la foto existen en el vocabulario del
  ledger de esa ruta** y, por debajo del 50 %, **no escribe**. Una foto que no empalma es peor
  que no tener foto — el ancla resetea, así que mandaría a cero mercancía que sí está arriba.

  ⛔ Y **no le quita los ceros de la izquierda al SKU**, aunque el archivo de Excel invite a
  hacerlo: medido, las tres fuentes de Kepler los conservan (`kdik.c2` 480 de 4,514 · `kdii.c1`
  1,072 de 9,642 · `kdm2.c8` 6,811 de 65,789). **Quien los perdió fue Excel**, que leyó `08057`
  como número. El push viaja DB→DB en texto y no tiene ese problema.
