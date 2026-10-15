#!/bin/sh
# Fills one set of the twin's stores once: the library edition in Mongo and the legislation index in
# Elasticsearch. Usage: seed.sh <mongo container> <elasticsearch port> <edition> <legislation json lines>
set -eu
MONGO=$1 ES=http://127.0.0.1:$2 EDITION=$3 TEXTS=$4
for _ in $(seq 1 90); do curl -sf "$ES/_cluster/health?wait_for_status=yellow&timeout=1s" >/dev/null 2>&1 && break; sleep 2; done
docker exec "$MONGO" mongosh --quiet --eval "db.getSiblingDB('research').library.updateOne({ _id: 'edition' }, { \$setOnInsert: { name: '$EDITION' } }, { upsert: true })" >/dev/null
if ! curl -sf "$ES/legislation" >/dev/null 2>&1; then
  curl -sf -X PUT "$ES/legislation" -H 'content-type: application/json' -d '{"mappings":{"properties":{"cite":{"type":"keyword"},"text":{"type":"text"}}}}' >/dev/null
  n=0
  while IFS= read -r doc; do
    n=$((n + 1))
    curl -sf -X PUT "$ES/legislation/_doc/$n" -H 'content-type: application/json' -d "$doc" >/dev/null
  done < "$TEXTS"
  curl -sf -X POST "$ES/legislation/_refresh" >/dev/null
fi
