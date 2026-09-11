# VL.2b · Paso previo — habilitar al servidor nuevo en las 5 sucursales que lo rechazan

> **Bloquea VL.2b.** Sin esto, mover las réplicas a `md` deja 5 de 8 ramas sin poder retomar
> de su slot, **y se descubriría dentro de la ventana de mantenimiento.**
> Medido el 2026-09-10 con [`vl2-probe-publishers.sh`](vl2-probe-publishers.sh).

## Qué pasa

La replicación lógica **jala**: el suscriptor se conecta hacia afuera. Hoy ese suscriptor es
`.249`, y **5 sucursales tienen su `pg_hba.conf` con una línea específica para esa IP**. El
servidor nuevo (`192.168.0.222`) no está en la lista:

```
FATAL: no hay una línea en pg_hba.conf para «192.168.0.222»,
       usuario «ods_repl», base de datos «md_00», sin cifrado
```

Las 3 que **sí** aceptan son las del puerto 1977 — coincide con la nota del runbook de
replicación: *"a menudo ya está cubierto por una regla `host all all` previa"*.

| Sucursal | Host : puerto | Base | Estado |
|---|---|---|---|
| md_00 | `192.168.9.95:5432` | `md_00` | ⛔ **falta** |
| md_01 | `192.168.10.10:1977` | `md_01` | ✅ ya acepta |
| md_02 | `192.168.42.42:5432` | `md_02` | ⛔ **falta** |
| md_03 | `192.168.40.40:5432` | `md_03` | ⛔ **falta** (`sub_pilot`) |
| md_04 | `192.168.44.44:5432` | `md_04` | ⛔ **falta** |
| md_05 | `192.168.54.54:5432` | `md_05` | ⛔ **falta** |
| md_06 | `192.168.50.50:1977` | `md_06` | ✅ ya acepta |
| md_07 | `192.168.32.32:1977` | `md_07` | ✅ ya acepta |

## Por qué lo tenés que hacer vos

`ods_repl` **no es superusuario** — verificado: ni siquiera puede leer `pg_hba_file_rules`.
Editar ese archivo necesita acceso al SO de cada servidor. El runbook de replicación lógica ya
asignaba ese paso así: *"lo que toca el POS, hecho por Edgar como `postgres` + OS"*.

## ⭐ Esto NO reinicia nada ni corta a Kepler

A diferencia del `wal_level=logical` de aquella vez —que sí pidió `net stop`/`net start`—
**`pg_reload_conf()` no reinicia el servicio, no corta conexiones y no toca al ERP.** Las
sucursales siguen vendiendo mientras lo hacés, y la replicación viva hacia `.249` no se
interrumpe. Se puede hacer en horario hábil.

## El procedimiento, por sucursal (PostgreSQL 16.4 sobre Windows)

**1. Ubicar el archivo** — en `psql` como `postgres`:

```sql
SHOW hba_file;   -- típicamente C:\Program Files\PostgreSQL\16\data\pg_hba.conf
```

**2. Respaldarlo antes de tocarlo:**

```cmd
copy "C:\Program Files\PostgreSQL\16\data\pg_hba.conf" "C:\Program Files\PostgreSQL\16\data\pg_hba.conf.bak-20260910"
```

**3. Agregar UNA línea, junto a la que ya existe para `.249`** (para que herede la misma
posición relativa; el orden importa: `pg_hba` usa la **primera** regla que coincide).
Cambiá `<db>` por la base de esa sucursal según la tabla de arriba:

```
host    <db>    ods_repl    192.168.0.222/32    scram-sha-256
```

⚠️ **NO borres la línea de `.249`.** Es el suscriptor vivo y es el rollback del corte. Se
retira después, cuando VL.2b esté probado.

**4. Recargar sin reiniciar** — en `psql` como `postgres`:

```sql
SELECT pg_reload_conf();
```

**5. Confirmar que la recarga no tuvo errores de sintaxis:**

```sql
SELECT line_number, error FROM pg_hba_file_rules WHERE error IS NOT NULL;
```

Debe devolver **0 filas**. Red de seguridad útil: si el archivo quedó mal escrito,
`pg_reload_conf()` lo **rechaza y conserva la configuración anterior** — nada se rompe en
caliente. Pero un archivo roto **sí impide arrancar en el próximo reinicio**, así que este
chequeo no es opcional.

## Verificación desde acá (hasta llegar a 8/8)

```bash
docker exec pgvector-md psql -U postgres -tAc \
  "select subname||'|'||subconninfo from pg_subscription order by subname;" \
  | ssh superoot@192.168.0.222 'bash /tmp/vl2-probe-publishers.sh'
```

Recién con **8 OK / 0 FALLA** se agenda la ventana de VL.2b.

## Dos notas

- **Alternativa considerada y descartada:** si `md` tomara la IP `192.168.0.249`, ningún
  `pg_hba` haría falta. No aplica: `.249` sigue viva como estación de trabajo y como sede del
  carril Wincaja hasta VL.5 (decisión D3).
- **No aprovechar este paso para rotar `ods_repl`.** Su contraseña es `superoot` y está
  pendiente de rotación desde el runbook de replicación, pero cambiarla **en el mismo
  movimiento** obliga a reescribir los 8 `subconninfo` y mezcla dos cambios en una ventana.
  Va después, con su propio paso.
