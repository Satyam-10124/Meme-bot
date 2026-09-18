#!/bin/bash
# Interactive clone-launch loop: paste a CA, get a clone CA back. Real funds.
# Every launch goes out from a fresh job wallet (funded from central, refunded after)
# and does NOT pre-buy — launch fee + gas only.
cd "$(dirname "$0")"

echo "=== pons interactive launcher (LIVE, fresh wallet per launch, no pre-buy) ==="
echo "Paste a source token CA to clone it. Type 'q' to quit."
echo ""

while true; do
  read -p "Source CA> " ca
  ca=$(echo "$ca" | tr -d '[:space:]')
  if [[ "$ca" == "q" || "$ca" == "quit" || "$ca" == "exit" ]]; then
    echo "bye"
    break
  fi
  if [[ ! "$ca" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "not a valid address, try again"
    continue
  fi
  DRY_RUN=false npm run bot -- spawn "$ca"
  echo ""
done
