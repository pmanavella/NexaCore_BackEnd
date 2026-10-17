#!/usr/bin/env bash
# Crea las etiquetas del registro de defectos en el repositorio actual.
# Requiere GitHub CLI autenticado (gh auth login). Ejecutar desde la raíz del repo del backend.
set -e

gh label create "defecto"                --color d73a4a --description "Defecto del módulo Financiero" --force

gh label create "severidad: crítica"     --color b60205 --description "Datos incorrectos, expuestos o acceso indebido" --force
gh label create "severidad: alta"        --color e99695 --description "Funcionalidad principal sin alternativa" --force
gh label create "severidad: media"       --color fbca04 --description "Falla parcial o con alternativa" --force
gh label create "severidad: baja"        --color c2e0c6 --description "Visual o de texto" --force

gh label create "estado: nuevo"          --color ededed --description "Registrado, sin revisar" --force
gh label create "estado: confirmado"     --color bfd4f2 --description "Reproducido por otra integrante" --force
gh label create "estado: en corrección"  --color 1d76db --description "Corrección en curso" --force
gh label create "estado: corregido"      --color 5319e7 --description "PR integrado, falta regresión" --force
gh label create "estado: verificado"     --color 0e8a16 --description "Regresión en verde; se cierra" --force

echo "Etiquetas creadas."
