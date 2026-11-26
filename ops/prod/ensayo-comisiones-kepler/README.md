# Las comisiones de la terminal, escritas por la Suite en Kepler (`[CB.62.4]`)

Plan: [`FASE_CB_CONCILIACION_BANCARIA.md` §9.5](../../../docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md).
Código: `libs/finance/src/lib/bank/comisiones-kepler/` (`comisiones-kepler.escritor.ts` traduce,
`comisiones-kepler.escritor.service.ts` encadena). Permiso: [`cb62_comisiones_terminal.sql`](../kepler-grants/cb62_comisiones_terminal.sql).

## ⛔ Por qué aquí NO hay un cuarto ensayo

La Suite no escribe estos documentos: encadena a los tres que ya existen, y **cada uno ya tiene su ensayo verde
contra el Kepler vivo**. Escribir un cuarto sería volver a probar lo mismo con otro código:

| Paso | Escritor | Su ensayo |
|---|---|---|
| Solicitud `X-A-15` | `[PGP.122]` | [`ops/prod/ensayo-solicitud-gasto/`](../ensayo-solicitud-gasto/) |
| Gasto `X-A-10` | `[PGP.123]` | [`ops/prod/ensayo-comprobacion-gasto/`](../ensayo-comprobacion-gasto/) — verde en 02, 04, 05 y 07 (2026-11-20) |
| Pago `X-D-26` | `[PGP.106]` | [`ops/prod/ensayo-pago-kepler/`](../ensayo-pago-kepler/) |

⚠️ **Y una cadena de tres NO se puede ensayar entera con `ROLLBACK`.** Cada escritor abre y cierra su propia
transacción: el gasto necesita que la solicitud EXISTA viva para clonarla, y una solicitud deshecha por un
`ROLLBACK` no existe. Fingir lo contrario —un ensayo que «pasa» porque cada paso corrió aislado— sería un
instrumento que afirma lo que no probó. Lo que de verdad prueba la cadena es el **canario**: un día real,
escrito de verdad, revisado documento por documento. Así se probó el primer `X-A-10` de la Suite (PGP.123).

## 1 · Antes de nada: ver qué se escribiría, sin escribir

Desde la laptop, sólo lectura (fuerza `default_transaction_read_only`):

```bash
npx esbuild ops/prod/ensayo-comisiones-kepler/que-se-escribiria.ts --bundle --platform=node \
  --tsconfig=tsconfig.base.json --external:pg --external:knex --outfile=<scratchpad>/que.cjs
NODE_PATH=node_modules DATABASE_URL=<url de sólo lectura> node <scratchpad>/que.cjs [dias]
```

Imprime, por cada día `lista`: la solicitud `X-A-15` que nacería (acreedor, renglones `611-003`, IVA, marca),
el gasto que la aplicaría y **un pago por cargo del banco**, con su cuenta y su importe. Es lo mismo que vería
el escritor: sale de `leerPropuesta` + `entregasDelDia`, no de una copia.

⛔ Si un día no sale aquí, **no se escribe**: o un candado lo frenó (Finanzas ya lo tocó), o su cuenta todavía
no pasó a la Suite (D3).

## 2 · Encender una cuenta (D3), en este orden

D3 (Edgar, 2026-11-10): el cambio de manos va **cuenta por cuenta**, empezando por **BBVA 4885**.

1. **Avisarle a Finanzas** que deja de capturar las comisiones de esa cuenta. ⛔ Sin esto, los dos capturan lo
   mismo y el candado tiene que atajarlo — que es justo lo que no queremos que trabaje.
2. El `GRANT` en los Kepler de 01–08 (una vez, y **cada mes** por la tabla de póliza `kdc2AAMM`):
   ```bash
   node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/cb62_comisiones_terminal.sql --servidores 01,02,03,04,05,06,07,08
   #   … --aplicar     (desde md, como postgres; la contraseña la teclea una persona)
   ```
3. La bandera global en el secreto `kepler-push`, **con `kubectl patch`** (⛔ nunca recrear el secreto desde un
   archivo: borra llaves que su maestro no tiene), y después `rollout restart deployment/api deployment/worker`:
   `KEPLER_COMISIONES_TERMINAL=encendida`.
4. El renglón de la sucursal en `commercial.kepler_push_switch` (`tipo = 'comisiones_terminal'`): `encendida`,
   y **con `tope_dia`** el primer día (1 día de venta basta para el canario).
5. ⭐ El dial de D3, en la cuenta — y es una **fecha**, no un sí/no:
   ```sql
   UPDATE finance.bank_accounts
      SET comisiones_kepler_desde = DATE '<el día del cambio de manos>',
          comisiones_kepler_set_at = now()
    WHERE account_label = '4885';
   ```
   Un cargo anterior a esa fecha **no se escribe**: es atraso de Finanzas, no trabajo de la Suite.

## 3 · El canario: el primer día, verificado documento por documento

1. Foto de contadores antes: `node ops/prod/ensayo-pago-kepler/foto-contadores.js` (es genérica).
2. `POST /api/finance/bank/comisiones-kepler/generar` con `FINANCE_BANK_GESTIONAR`, con el tope en 1.
3. Verde = la respuesta trae `estado: 'escrito'` con sus tres folios, y en Kepler:
   - la `X-A-15` quedó en **`F` con saldo 0** (la aplicó su gasto) y con la marca `SUITE SG-…` del día;
   - el `X-A-10` apunta a esa solicitud (`c36='A'`, `c37=15`, `c38=1`), su póliza D cuadra y su `kdxe` existe;
   - hay **un `X-D-26` por cargo del banco**, cada uno con su `kdm5`, su póliza E y su `kdxf` contra el gasto;
   - el saldo de la CxP del gasto (`kdxe.c20`) quedó en **0**;
   - la foto de contadores sólo se movió en lo que explican estos documentos.
4. Rojo o dudoso: apagar el dial de la cuenta (`comisiones_kepler_desde = NULL`) y **no reintentar** hasta
   entender qué pasó. El renglón de `finance.bank_commission_kepler_days` dice en qué paso se quedó.

⛔ **`en_duda` no se reintenta.** Significa que el `COMMIT` salió y la respuesta no volvió. Antes de cualquier
reintento se busca en Kepler la marca de ese día (es determinista: la misma llave da siempre la misma marca).
