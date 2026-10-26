#!/bin/sh
# Nightly logical backup of the PostgreSQL database into ./backups, keeping
# BACKUP_KEEP_DAYS days. Back up ENCRYPTION_KEY separately: without it,
# restored connections cannot be decrypted.
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
while true; do
  STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
  FILE="/backups/automation-${STAMP}.dump"
  if pg_dump -h postgres -U automation -d automation -Fc -f "${FILE}.partial"; then
    mv "${FILE}.partial" "${FILE}"
    echo "backup ok: ${FILE} ($(du -h "${FILE}" | cut -f1))"
  else
    rm -f "${FILE}.partial"
    echo "backup FAILED at ${STAMP}" >&2
  fi
  find /backups -name 'automation-*.dump' -mtime "+${KEEP}" -delete
  sleep 86400
done
