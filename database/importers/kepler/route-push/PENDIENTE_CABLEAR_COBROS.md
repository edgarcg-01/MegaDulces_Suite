# Camionetas que no mandan los cobros — lista de trabajo

**Medido contra el runner (`md:5433/kepler_consolidado`) y prod el 2026-10-16.**
Para: quien entra a cada camioneta. Una fila = una máquina.

---

## El problema, en tres renglones

Cada camioneta ya manda **ventas, existencia y movimientos**. **No manda los cobros.**
El cobro (`UA0501`) es el documento que salda el corte de caja de la ruta — sin él, la venta se
ve y **el dinero no entra a ningún libro**.

**11 camionetas empujan. Sólo 4 tienen el bloque de cobros, y las 4 están paradas desde el
12-oct.** Hoy hay **36 cortes ($608,045.99)** que no están en ninguna parte.

---

## GRUPO A — Padre Hidalgo: pegar el bloque y listo

Tienen todo lo demás en orden. Falta **sólo** pegar el bloque de cobros.

| # | Camioneta | IP | Almacén | Venta últimos 14 días |
|---|---|---|---|---:|
| 1 | **`ruta_23`** | `192.168.10.249` | `01-003` | $229,179.29 |
| 2 | **`ruta_28`** | `192.168.10.152` | `01-006` | $178,190.22 |

### Qué hacer en cada una

1. Entrar a la máquina y abrir su `push-ruta.cmd`.
2. Pegar el contenido de **`push-cobros.snippet.cmd`** (está en esta misma carpeta)
   **antes del `endlocal`, después del bloque de existencia**.
3. Guardar y correr el `.cmd` **a mano una vez**, para ver que no truena.
4. Dejar que corra solo esa noche por su tarea programada.

> ⛔ **No cambies el filtro de almacén del bloque.** Está ahí porque la base local de la
> camioneta arrastra el CEDIS entero: medido en `ruta_27`, son **16,641 cobros del almacén `00`**
> contra **9 propios**. Sin el filtro, esa camioneta mandaría 16,641 cobros ajenos **y
> duplicados**, porque esos mismos ya llegan por otro camino.

---

## GRUPO B — Canindo: PRIMERO el catálogo, después el bloque

⛔ **Estas cinco no se pueden cablear todavía.** En el catálogo del sistema
(`analytics.v_rd_route_identity`) las cinco tienen el **almacén en blanco**, así que aunque el
cobro llegara **no habría con qué ligarlo**.

⭐ **Y el dato ya existe:** el push de cada una **ya declara su almacén**. Hay que copiarlo al
catálogo, no averiguarlo.

| # | Camioneta | IP | Almacén (lo dice su push) | Venta 14 días | Ojo |
|---|---|---|---|---:|---|
| 3 | **`ruta_501`** | `192.168.50.20` | `06-001` | $175,366.81 | va **2 días** atrasada |
| 4 | **`ruta_502`** | `192.168.50.22` | `06-002` | $239,827.24 | al día |
| 5 | **`ruta_503`** | `192.168.50.18` | `06-003` | $277,616.80 | al día |
| 6 | **`ruta_504`** | `192.168.50.21` | `06-004` | sin ventas | ⚠️ **15 días atrasada** |
| 7 | **`ruta_505`** | **(nunca conectó)** | `06-005` | sin ventas | ⛔ **36 días muerta** |

> ⭐ **El mapa está completo y es 1:1** — `501→06-001`, `502→06-002`, `503→06-003`,
> `504→06-004`, `505→06-005`. Sale del histórico del propio push (1,188 folios de la `504` y 506
> de la `505`), así que **no hay nada que averiguar ni que decidir**: es copiar cinco renglones
> al catálogo.

### Orden de trabajo del grupo B

1. **Cargar el almacén de las 5 en el catálogo de rutas.** Sin esto, los pasos 2 y 3 no sirven.
2. Recién entonces, pegar el bloque de cobros igual que en el grupo A.
3. **`ruta_504` y `ruta_505` van aparte** (abajo): tienen un problema anterior.

---

## GRUPO C — Dos máquinas con un problema distinto

Éstas **no son de cableado**: su push dice que corrió bien pero **no trae días nuevos**. Es el
caso más engañoso, porque el tablero las muestra en verde.

| Camioneta | Almacén | Dice que corrió | Pero sus datos llegan hasta | Atraso |
|---|---|---|---|---:|
| **`ruta_504`** | `06-004` | hoy 15:30 | **2026-10-01** | **15 días** |
| **`ruta_505`** | `06-005` | **15-sep 00:56** | 2026-09-10 | **36 días** |

**Qué revisar, en este orden:**

1. ¿La máquina está prendida y en la red? `ruta_505` **nunca registró una IP** — puede estar
   apagada, cambiada o reinstalada.
2. ¿Su Kepler local tiene movimientos recientes? Si no los tiene, no es la tubería: es que la
   ruta no está operando.
3. Si la máquina está viva y su Kepler tiene datos, entonces sí es el push y hay que mirar su log.

---

## Las 4 que SÍ tienen el bloque y están paradas

No necesitan cableado. Se listan para que nadie las dé por sanas.

| Camioneta | IP | Almacén | Último cobro enviado |
|---|---|---|---|
| `ruta_21` | `192.168.10.239` | `01-001` | **2026-10-12** |
| `ruta_22` | `192.168.10.7` | `01-002` | **2026-10-12** |
| `ruta_26` | `192.168.10.253` | `01-004` | **2026-10-12** |
| `ruta_27` | `192.168.10.16` | `01-005` | **2026-10-12** |

Las cuatro **siguen mandando ventas todos los días** — o sea que la máquina y la red están bien.
Lo que se detuvo es sólo el cobro. Revisar su `push-ruta.cmd`: lo más probable es que el bloque
se haya corrido a mano el 12-oct y nunca haya quedado dentro de la tarea programada.

---

## Cómo saber que quedó bien

Después de tocar una camioneta, se comprueba **de este lado**, no en la máquina:

```sql
-- En el runner (md:5433/kepler_consolidado)
SELECT truck, last_ok, rows_last
  FROM ingest.route_collections_heartbeat
 ORDER BY truck;
```

La camioneta que tocaste tiene que **aparecer en esa lista con la fecha de hoy**. Si no aparece,
no quedó — aunque el `.cmd` no haya dado error.

Y el panorama completo, desde el repo:

```
npm run check:corte-sin-cobro
```

Los cortes de esa camioneta tienen que dejar de salir como `fuera_del_ods`.

---

## Resumen para quien reparte el trabajo

| Grupo | Qué es | Camionetas | Quién |
|---|---|---:|---|
| **A** | Pegar el bloque | 2 — `ruta_23`, `ruta_28` | sistemas, en la máquina |
| **B** | Catálogo y después el bloque | 5 — `ruta_501`…`505` | catálogo primero, luego sistemas |
| **C** | Push que no avanza | 2 — `ruta_504`, `ruta_505` | revisar la máquina antes que nada |
| — | Cableadas pero paradas | 4 — `ruta_21`, `22`, `26`, `27` | revisar su tarea programada |

⚠️ **Y una pregunta que no es de sistemas y hay que hacer igual:** desde el 12-oct, en toda la
empresa, Kepler casi dejó de registrar los depósitos de efectivo a Caja General (de ~90–115 por
semana a **3**). Los gastos siguen normales. Alguien de operación tiene que decir qué cambió ese
día, porque ninguna de estas camionetas lo explica.
