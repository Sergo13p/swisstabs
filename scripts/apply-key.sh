#!/usr/bin/env bash
# Фиксирует ID расширения: генерирует (или переиспользует) приватный ключ
# ВНЕ папки расширения и вставляет публичную часть в manifest.json.
#
# Зачем: по умолчанию Chrome выводит ID расширения из пути к папке — при
# переносе/копировании на другой компьютер ID меняется, а OAuth client ID
# Google привязан к ID. С фиксированным key ID одинаков везде.
#
# ВАЖНО: ключ НЕ должен лежать внутри папки расширения — Chrome запрещает
# загружать такие расширения («это неприемлемо»). Скрипт хранит его в
# ~/.config/swisstabs/key.pem. Не удаляйте этот файл и не меняйте поле key —
# иначе ID изменится и синхронизация с Google потребует нового client_id.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_DIR="${HOME}/.config/swisstabs"
KEY_FILE="$KEY_DIR/key.pem"

mkdir -p "$KEY_DIR"
if [[ ! -f "$KEY_FILE" ]]; then
  for OLD in "${HOME}/tabsbook-key.pem" "${HOME}/.config/tabsbook/key.pem"; do
    if [[ -f "$OLD" ]]; then
      mv "$OLD" "$KEY_FILE"
      echo "Перенесён существующий ключ: $OLD → $KEY_FILE"
      break
    fi
  done
fi
if [[ ! -f "$KEY_FILE" ]]; then
  openssl genrsa -out "$KEY_FILE" 2>/dev/null
  echo "Сгенерирован новый ключ: $KEY_FILE"
fi
chmod 600 "$KEY_FILE"

PUB_KEY="$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | openssl base64 -A)"
EXT_ID="$(printf '%s' "$PUB_KEY" | python3 -c "
import sys, base64, hashlib
der = base64.b64decode(sys.stdin.read().strip())
h = hashlib.sha256(der).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in h))
")"

python3 - "$DIR/manifest.json" "$PUB_KEY" <<'EOF'
import json, sys, collections
manifest_path, key = sys.argv[1], sys.argv[2]
with open(manifest_path) as f:
    m = json.load(f, object_pairs_hook=collections.OrderedDict)
new = collections.OrderedDict()
for k, v in m.items():
    if k == "key":
        continue
    if k == "manifest_version":
        new[k] = v
        new["key"] = key
    else:
        new[k] = v
with open(manifest_path, "w") as f:
    json.dump(new, f, ensure_ascii=False, indent=2)
    f.write("\n")
EOF

echo "ID расширения зафиксирован: $EXT_ID"
echo "(укажите этот ID в Google Cloud как Item ID, если настраиваете синхронизацию)"
