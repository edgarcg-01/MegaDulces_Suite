#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[SEG.1]` QUIÉN ENTRA A `md` — una llave por persona, y el log dice el nombre.
#
# ── El defecto que cierra ───────────────────────────────────────────────────────────────────
# Medido el 2026-09-24: `md` tiene **una sola llave SSH** (`sistemas@249-vl-ops`), un solo usuario
# con shell (`superoot`, que además está en `docker` y en `sudo` = root de facto) y **cero**
# atribución. Nadie de afuera entra — eso está bien — pero **tampoco se puede saber quién hizo
# qué**. Y en esta máquina "qué" incluye producción: recrear contenedores, aplicar migraciones,
# leer la base entera.
#
# Un acceso compartido no es un agujero de entrada; es un agujero de RESPONSABILIDAD. El día que
# algo se rompe, la pregunta "¿quién corrió eso?" no tiene respuesta.
#
# ── Por qué alcanza con esto, sin tocar nada del sistema ────────────────────────────────────
# ⭐ `sshd` **ya registra la huella de la llave** en cada acceso, con el `LogLevel INFO` que trae
# por defecto:
#
#     Accepted publickey for superoot from 192.168.0.243 port 65156 ssh2: ED25519 SHA256:W9Yk…
#
# Y `superoot` está en el grupo `adm`, así que **puede leer `/var/log/auth.log` sin sudo**. O sea
# que la atribución ya existe en el sistema: lo único que falta es que cada huella corresponda a
# UNA persona. Nada de configurar `sshd`, ni usuarios nuevos, ni permisos de root.
#
# ⚠️ Esto atribuye el ACCESO, no la acción. Todos siguen entrando como `superoot` y todos siguen
#    siendo root de facto por el grupo `docker`. Separar privilegios por persona es otro trabajo,
#    más grande, y se DECLARA acá en vez de dejar creer que esto lo resuelve.
#
#   ssh-llaves.sh listar               # las llaves dadas de alta, con su dueño y su huella
#   ssh-llaves.sh quien [N]            # los últimos N accesos, con NOMBRE en vez de huella
#   ssh-llaves.sh agregar <pub> <dueño>
#   ssh-llaves.sh quitar <dueño>
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

AK="$HOME/.ssh/authorized_keys"
LOG=/var/log/auth.log

huellas() {
  # Salida: <huella> <dueño>. El dueño es el comentario de la llave, que es la única etiqueta
  # que viaja con ella; por eso `agregar` lo exige y no lo deja vacío.
  # ⛔ Las variables de acá van con prefijo `_hu_` porque **en `sh` una función NO tiene ámbito
  # propio**: no hay `local` en POSIX, así que todo lo que asigne pisa al que la llamó. Esta
  # función usaba `n` como contador y `quien` usa `n` para "cuántos accesos mostrar" — como
  # `huellas` se llama JUSTO ANTES, dejaba `n` en 1 (la cantidad de llaves) y `quien 6` mostraba
  # **un** renglón diciendo "mostrando los ultimos 1". No falla: devuelve menos de lo que se
  # pidió, que es la clase de error que se lee como "no hay más datos".
  [ -f "$AK" ] || return 0
  _hu_n=0
  while IFS= read -r _hu_linea; do
    [ -n "$_hu_linea" ] || continue
    case "$_hu_linea" in \#*) continue ;; esac
    _hu_n=$((_hu_n + 1))
    echo "$_hu_linea" > "/tmp/.llave.$$"
    _hu_hf=$(ssh-keygen -lf "/tmp/.llave.$$" 2>/dev/null | awk '{print $2}')
    _hu_duenio=$(echo "$_hu_linea" | awk '{print $3}')
    [ -n "$_hu_hf" ] && echo "$_hu_hf ${_hu_duenio:-SIN-DUENIO(linea-$_hu_n)}"
  done < "$AK"
  rm -f "/tmp/.llave.$$"
}

case "${1:-listar}" in

  listar)
    echo "Llaves dadas de alta en $(hostname):"
    huellas | while read -r hf duenio; do
      # Último acceso de ESA llave. Si nunca entró, se dice — una llave que nadie usa es una
      # llave que sobra, y sobran llaves es como se llega a no saber de quién son.
      ult=$(grep -F "$hf" "$LOG" 2>/dev/null | tail -1 | cut -c1-19)
      printf '  %-50s %-24s %s\n' "$hf" "$duenio" "${ult:-NUNCA USADA}"
    done
    echo
    echo "⚠️ Todos entran como superoot, que está en docker y sudo. Esto dice QUIÉN entró, no qué hizo."
    ;;

  quien)
    n=${2:-20}
    echo "Últimos $n accesos por llave, con nombre:"
    if [ ! -r "$LOG" ]; then
      echo "  NO MEDIDO: no se puede leer $LOG (¿el usuario salió del grupo 'adm'?)."
      exit 0
    fi
    # ⛔ TODO EN UN SOLO `awk`, y no es por elegancia. La primera versión recorría el log con un
    # `while read` y adentro llamaba a `awk` para buscar el dueño: **`awk` sin un archivo legible
    # lee STDIN**, o sea que se tragaba el resto de la tubería y el bucle iteraba UNA vez. Salía
    # un único renglón —el último— y parecía un log con un solo acceso, no un bug. Medido:
    # 3,150 accesos en el log y la herramienta mostraba 1.
    #
    # Un comando dentro de un `while read` que pueda leer stdin es siempre esta trampa. Acá
    # `awk` lee dos archivos (el mapa y el log) y nada consume la tubería, porque no hay tubería.
    huellas > "/tmp/.mapa.$$"
    awk -v n="$n" '
      NR == FNR { duenio[$1] = $2; next }                 # 1er archivo: mapa huella→dueño
      /Accepted publickey/ {
        hf = ""; ip = ""
        for (i = 1; i <= NF; i++) {
          if ($i ~ /^SHA256:/) hf = $i
          if ($i == "from") ip = $(i + 1)
        }
        cuando = substr($1, 1, 19)                        # el sello ISO, sin microsegundos ni zona
        # ⛔ Una huella que NO está en authorized_keys entró con una llave que después se quitó,
        # o el log es anterior al alta. Se marca fuerte: es lo único de esta salida que puede ser
        # un problema de seguridad y no un dato de rutina.
        quien = (hf in duenio) ? duenio[hf] : ("*** HUELLA DESCONOCIDA " hf)
        c++; linea[c] = sprintf("  %-19s %-16s %s", cuando, ip, quien)
      }
      END {
        if (c == 0) { print "  (ningun acceso registrado en el log vigente)"; exit }
        desde = (c - n + 1); if (desde < 1) desde = 1
        for (i = desde; i <= c; i++) print linea[i]
        printf "  --- %d accesos en el log, mostrando los ultimos %d ---\n", c, c - desde + 1
      }' "/tmp/.mapa.$$" "$LOG"
    rm -f "/tmp/.mapa.$$"
    ;;

  agregar)
    pub="${2:-}"; duenio="${3:-}"
    [ -f "$pub" ] || { echo "Falta el archivo .pub. Uso: ssh-llaves.sh agregar <archivo.pub> <dueño>"; exit 1; }
    [ -n "$duenio" ] || { echo "Falta el DUEÑO, y no es opcional: sin él la llave vuelve a ser anónima."; exit 1; }
    contenido=$(awk '{print $1" "$2}' "$pub")
    [ -n "$contenido" ] || { echo "El archivo no parece una llave pública."; exit 1; }
    if grep -qF "$(echo "$contenido" | awk '{print $2}')" "$AK" 2>/dev/null; then
      echo "Esa llave YA está dada de alta. No se duplica."; exit 0
    fi
    cp "$AK" "$AK.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null
    echo "$contenido $duenio" >> "$AK"
    chmod 600 "$AK"
    echo "Alta OK: $duenio"
    echo "$contenido $duenio" > "/tmp/.nueva.$$"; ssh-keygen -lf "/tmp/.nueva.$$" 2>/dev/null | sed 's/^/  /'; rm -f "/tmp/.nueva.$$"
    ;;

  quitar)
    duenio="${2:-}"
    [ -n "$duenio" ] || { echo "Uso: ssh-llaves.sh quitar <dueño>"; exit 1; }
    total=$(grep -cvE '^\s*(#|$)' "$AK" 2>/dev/null || echo 0)
    cuantas=$(awk -v d="$duenio" '$3==d' "$AK" 2>/dev/null | wc -l)
    [ "$cuantas" -gt 0 ] || { echo "No hay ninguna llave de '$duenio'."; exit 1; }
    # ⛔ Nunca dejar la máquina sin llaves. `md` no tiene consola a mano ni IPMI: quedarse sin
    # acceso significa caminar hasta el equipo, y prod corre ahí.
    if [ "$total" -le "$cuantas" ]; then
      echo "⛔ ABORTA: eso dejaría authorized_keys VACÍO y nadie podría entrar a $(hostname)."
      echo "   Esta máquina no tiene IPMI; recuperarla sería físicamente. Da de alta otra llave primero."
      exit 1
    fi
    cp "$AK" "$AK.bak.$(date +%Y%m%d%H%M%S)"
    awk -v d="$duenio" '$3!=d' "$AK" > "$AK.tmp" && mv "$AK.tmp" "$AK"
    chmod 600 "$AK"
    echo "Baja OK: $duenio ($cuantas llave/s). Respaldo en $AK.bak.*"
    ;;

  *) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
