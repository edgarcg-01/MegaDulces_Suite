# El gasto (X-A-10), escrito por la Suite en Kepler (`[PGP.123]`)

Plan: [`FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md`](../../../docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md).
Código: `libs/finance/src/lib/expense-proofs/comprobacion-kepler/` (escritor, revisión y servicio) y el armador
`libs/finance/src/lib/shared/gasto-kepler.armador.ts`. Prueba contra Postgres real (CI):
`database/tests/test-newdb-kepler-gasto-comprobacion.js`.

## El ensayo contra el Kepler vivo (G.10): no escribe nada

Corre el `KeplerGastoSinkAdapter` REAL —la solicitud viva con su candado, `kdmm`, `kdc3`, `kdc126`, `kdxg`, el
contador `KFXA1001.NN` y el número de póliza D— y cambia el único paso que escribe (`confirmar`) por la revisión
(`revisarEscrituraGasto`) + `ROLLBACK`. Sólo corre desde `md` (el `pg_hba` de Kepler acepta a `kepler_push` ahí).

```bash
# en la laptop: empaquetar (adaptador real + pg, un solo .cjs)
node ops/prod/ensayo-comprobacion-gasto/empaquetar.js /ruta/ensayo-gasto.cjs
scp /ruta/ensayo-gasto.cjs superoot@192.168.0.222:/tmp/

# en md: la URL viaja por stdin, nunca en la línea de comandos
n=05; URL=$(kubectl -n prod get secret kepler-push -o jsonpath="{.data.KEPLER_PUSH_URL_$n}" | base64 -d)
printf '%s\n%s\n' "$URL" '{"sucursal":"05","solicitud":"0000092"}' \
  | docker run --rm -i --network host -v /tmp/ensayo-gasto.cjs:/e.cjs:ro node:22-alpine node /e.cjs
```

La solicitud tiene que ser real, en `A`, con todo su saldo, del mes en curso y sin gasto. Verde = `fallas: []`,
`permisos` todos `true` y `control.igual: true` (contador, solicitud, gastos de la solicitud, máximo de la póliza D
del mes, filas de `kdxe` y `kdcn26`: como estaban). Código 1 = fallas; 2 = el control falló.

**2026-11-20:** verde en 02, 04, 05 y 07 (las cuatro de una sola secuencia de póliza D, DG7).

## Encender una sucursal

1. Bandera global (una vez): `KEPLER_GASTO_COMPROBACION=encendida` en el secreto `kepler-push`, **con
   `kubectl patch`** (nunca recrear el secreto desde el archivo: borra llaves) y anotada en `~/kepler-push.env`;
   después `kubectl -n prod rollout restart deployment/api deployment/worker`.
2. El renglón `comprobacion_gasto` de la sucursal en `commercial.kepler_push_switch`: `encendida`, `tope_dia`.
3. Sólo 02, 04, 05 y 07 escriben (DG7): en 00, 01, 03, 06 y 08 el escritor se queda apagado hasta medir el
   contador de su póliza D, aunque el renglón esté encendido.
