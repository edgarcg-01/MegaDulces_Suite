# Corrimiento de 6 horas en los timestamps de `kepler_ods`

> **Para quien toma esto:** especialista en bases de datos. No hace falta conocer el resto del
> proyecto. Todo lo que sigue está medido en producción el **2026-09-23**; cada afirmación trae la
> consulta que la produjo para que la puedas rehacer.
>
> **Qué se te pide decidir:** si se corrigen los datos históricos, cuáles, y cómo. El pipeline ya
> está sano hacia adelante — esto es deuda de datos, no un incidente en curso.

---

## 1. El síntoma, en una línea

La **misma fila** tiene distinto timestamp en el origen y en el ODS:

```
ODS        2026-09-21 06:00:00 | 06:41:34.99 | 17023 | BTO
RÉPLICA    2026-09-21 00:00:00 | 06:41:34.99 | 17023 | BTO
                      ^^^^^^^^
```

Seis horas exactas = `America/Mexico_City` (UTC−6). Tabla: `kdpv_bitacora_precios`, sucursal `08`.

**Reproducirlo:**

```sql
-- en pg-prod (destino), base `railway`
SELECT c1::text, c2, c3, c4
  FROM kepler_ods.kdpv_bitacora_precios
 WHERE sucursal='08' AND c1::date = current_date - 2
 ORDER BY c2, c3, c4 LIMIT 3;

-- en pgvector-md (origen), base `kepler_md_08`
SELECT c1::text, c2, c3, c4
  FROM md.kdpv_bitacora_precios
 WHERE c1::date = current_date - 2
 ORDER BY c2, c3, c4 LIMIT 3;
```

⚠️ El `ORDER BY c1` NO sirve para comparar: `c1` empata en miles de filas y el orden queda
indefinido. Ordenar por las otras tres columnas de la PK es lo que hace comparables los renglones.

---

## 2. El corte es limpio, y eso es lo más informativo

```sql
SELECT c1::date AS dia,
       count(*) FILTER (WHERE c1::time = '06:00:00') AS con_6h_de_mas,
       count(*) FILTER (WHERE c1::time = '00:00:00') AS correctas,
       count(*) AS total
  FROM kepler_ods.kdpv_bitacora_precios
 WHERE sucursal='08' AND c1 >= current_date - 8
 GROUP BY 1 ORDER BY 1;
```

| día | con +6 h | correctas |
|---|---|---|
| 2026-09-15 | 10,017 | 0 |
| 2026-09-16 | 4,393 | 0 |
| 2026-09-17 | 3,253 | 0 |
| 2026-09-18 | 11,197 | 0 |
| 2026-09-19 | 18,933 | 0 |
| 2026-09-20 | 10,078 | 0 |
| 2026-09-21 | 12,330 | 0 |
| 2026-09-22 | 8,492 | 0 |
| **2026-09-23** | **0** | **8,674** |

**Todo lo anterior al 2026-09-23 está corrido. Desde el 2026-09-23, correcto.** Cero mezcla.

---

## 3. La causa probable, y por qué **ya no** ocurre

El 2026-09-22 la base de producción se mudó de Railway a un servidor propio. Las zonas horarias
medidas hoy:

| Pieza | `timezone` |
|---|---|
| Réplicas de sucursal (origen, `:5433`) | **`Etc/UTC`** |
| `pg-prod` (destino, base `railway`) | **`America/Mexico_City`** |
| Proceso Node que copia (contenedor) | `TZ=America/Mexico_City` |

Antes de la mudanza, el destino corría en **`Etc/UTC`** (era Railway).

**Hipótesis:** las columnas son `timestamp without time zone`. El driver `node-postgres` las entrega
como un `Date` de JS *interpretado en la zona local del proceso* (`America/Mexico_City`), y al
escribirlas las serializa con offset. Con el destino en UTC, el valor se corría +6 h. Con el destino
en `America/Mexico_City`, el viaje de ida y vuelta es neutro.

⇒ **El corrimiento no empezó con la mudanza: terminó con ella.** Lo que queda es histórico.

⚠️ **Esto es hipótesis, no medición.** Encaja con el corte limpio y con las tres zonas, pero no
reprodujimos el camino de escritura contra un destino en UTC. Si vas a corregir datos, vale la pena
confirmarlo primero (p. ej. escribiendo una fila de prueba con `SET TIME ZONE 'UTC'` en el destino).

---

## 4. Qué está afectado y qué no — y qué **no se midió**

Medido tabla por tabla en la sucursal `08`, contando cuántas filas caen exactamente en `06:00:00`
contra `00:00:00`:

| Tabla | Columna | ¿Corrida? |
|---|---|---|
| `kdpv_bitacora_precios` | `c1` | **sí** (todo < 09-23) |
| `kdmx_26` | `c9` | **sí** (5,920 de 6,345 en 3 días) |
| `kdlogmov` | `c2` | **sí** (223 de 254) |
| `kdc22609` | `c2` | **sí** |
| `kdm1` | `c68` | **no** — 0 corridas en 4 días |

⛔ **No es global, y el alcance real está SIN MEDIR.**

```sql
SELECT count(DISTINCT c.relname) AS tablas, count(*) AS columnas
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  JOIN pg_type t ON t.oid = a.atttypid
 WHERE ns.nspname = 'kepler_ods' AND c.relkind = 'r'
   AND t.typname IN ('timestamp','timestamptz');
-- → 130 tablas, 264 columnas
```

**Se revisaron 5 de 264 columnas.** El resto es trabajo tuyo.

### Por qué `kdm1` se salva (hipótesis con evidencia indirecta)

`kdm1` es una de las 5 tablas que tienen **red de seguridad**: un reconciliador compara llaves contra
la réplica y **repone** lo que falte. Desde la mudanza viene reponiendo, y reponer **reescribe** la
fila con el valor correcto. Las tablas sin red conservan el valor viejo.

Si eso es cierto, tiene una consecuencia práctica fuerte: **re-shipear una fila la corrige**. Eso
abre un camino de reparación distinto al `UPDATE` masivo (ver §6).

---

## 5. ⛔ Lo que NO hay que hacer

**No meter las tablas afectadas al reconciliador.** El timestamp forma parte de la **llave primaria**
en varias de ellas (`kdpv_bitacora_precios.c1`, `kdlogmov.c2`, `orglogtbl_26.k_date`). Con la llave
corrida, la misma fila aparece como **ausente y sobrante a la vez**. Medido en seco:

```
kdpv_bitacora_precios · sucursal 08 · ventana 3 días
    faltan 38,487 · sobrantes 30,900
```

Verificado además en SQL puro con `::text` (30,900 / 38,365 — las mismas cifras), así que **no es un
artefacto del comparador**, son los datos. Reconciliarlas re-shipearía 38k filas y borraría 30k en
**cada pasada**, sin converger nunca.

El reconciliador ya las rechaza con el motivo escrito; el freno está en
`database/importers/kepler/reconcile-ods-window.js` (`pkNoComparable`). **No hay que desactivarlo sin
resolver esto primero.**

---

## 6. Las opciones, tal como las vemos

Ninguna está elegida. La decisión es tuya.

| | Qué implica | Riesgo |
|---|---|---|
| **A. No corregir** | Declarar que los timestamps del ODS previos al 2026-09-23 valen ±6 h y que nadie los use para nada fino | Barato hoy, caro cada vez que alguien cruce por hora |
| **B. `UPDATE` masivo** `col = col - interval '6 hours'` donde el valor sea anterior al corte | Directo | ⛔ **La PK contiene el timestamp en varias tablas** → el UPDATE puede chocar contra filas ya correctas. Y hay que saber CUÁLES filas se escribieron antes del corte, no cuáles TIENEN fecha anterior: no es lo mismo |
| **C. Re-shipear desde la réplica** | Si §4 es correcto, reponer reescribe con el valor bueno y no hay que calcular nada | Volumen (1.1 M filas en una sola tabla) y hay que confirmar que el upsert **pisa** por PK — si la PK cambió, inserta duplicado en vez de corregir |

⚠️ **El problema difícil de B y C es el mismo:** no hay marca de *cuándo se escribió* cada fila del
ODS. `kepler_ods._sync_status` guarda un `last_push_at` **por tabla**, no por fila. Distinguir "fila
vieja con fecha vieja" de "fila vieja corrida" hay que hacerlo contra la réplica, fila por fila.

---

## 7. Cómo medir el alcance real (por dónde empezaríamos)

Para cada tabla con columna `timestamp`, comparar contra la réplica. El patrón que funcionó:

```sql
-- en el destino
SELECT count(*) FILTER (WHERE <col>::time = '06:00:00') AS con_6h,
       count(*) FILTER (WHERE <col>::time = '00:00:00') AS medianoche,
       count(*) AS total
  FROM kepler_ods.<tabla>
 WHERE sucursal = '08' AND <col> >= current_date - 3;
```

⚠️ **Sirve sólo donde el valor de origen es fecha sin hora** (queda en `00:00:00` y el corrimiento lo
manda a `06:00:00`). Para columnas con hora real (`orglogtbl_26.k_date`) hay que cruzar llave por
llave contra la réplica, no contar por hora. Es la diferencia entre una prueba rápida y una buena.

---

## 8. Acceso y ubicación

| Pieza | Dónde |
|---|---|
| Destino (ODS) | `pg-prod`, base `railway`, schema `kepler_ods` — servidor `md`, `192.168.0.222` |
| Origen (réplicas) | `pgvector-md` (`:5433`), bases `kepler_md_00` … `kepler_md_08`, schema `md` |
| Reconciliador | `database/importers/kepler/reconcile-ods-window.js` |
| Ventanas por tabla | `database/importers/lib/ods-recent-window.js` |
| Catálogo de sucursales | `database/importers/lib/kepler-branches.js` (**única** lista válida) |

⚠️ Hay **tres** Postgres en esa máquina y confundirlos es el error más caro: `:5432` prod, `:5433`
réplicas, `:5434` expuesto de prod. Una medición contra la base equivocada se lee perfectamente bien.

---

## 9. Contexto: por qué salió esto ahora

Apareció auditando otra cosa — que el ODS estuviera completo en todas sus tablas. En esa ronda se
corrigieron tres defectos distintos, y este es el único que **no** se corrigió:

1. La lista de sucursales estaba escrita a mano con 7 ramas de 9: el propagador de DELETEs nunca miró
   Morelia Madero ni Morelia Abastos. Corregido y con compuerta.
2. El comparador de llaves usaba `String()` de JS: no determinista sobre `timestamp` y `numeric`.
   Corregido — la llave la arma Postgres.
3. **Este corrimiento.** Declarado, acotado, y explícitamente no tocado.

El defecto (2) es el que destapó (3): al ampliar la cobertura, las tablas nuevas empezaron a reportar
"falta y sobra la misma fila", y tirando de ahí apareció el corrimiento.
