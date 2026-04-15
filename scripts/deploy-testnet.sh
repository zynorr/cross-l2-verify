#!/usr/bin/env bash
set -euo pipefail

# Deploy VerificationRegistry to Sepolia and optionally verify a sample
# contract across L2 testnets (OP Sepolia, Base Sepolia, Arb Sepolia).
#
# Required env vars:
#   PRIVATE_KEY        Deployer wallet private key (needs Sepolia ETH)
#   L1_RPC_URL         Sepolia RPC endpoint
#
# Optional env vars:
#   OP_SEPOLIA_RPC     OP Sepolia RPC (default: public endpoint)
#   BASE_SEPOLIA_RPC   Base Sepolia RPC (default: public endpoint)
#   ARB_SEPOLIA_RPC    Arb Sepolia RPC (default: public endpoint)
#   PINATA_JWT         Pinata JWT for IPFS pinning (skip proof submission if unset)
#   SKIP_SAMPLE        Set to "1" to skip sample contract deployment

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

: "${PRIVATE_KEY:?Set PRIVATE_KEY to a funded Sepolia wallet}"
: "${L1_RPC_URL:?Set L1_RPC_URL to a Sepolia RPC endpoint}"

OP_SEPOLIA_RPC="${OP_SEPOLIA_RPC:-https://sepolia.optimism.io}"
BASE_SEPOLIA_RPC="${BASE_SEPOLIA_RPC:-https://sepolia.base.org}"
ARB_SEPOLIA_RPC="${ARB_SEPOLIA_RPC:-https://sepolia-rollup.arbitrum.io/rpc}"

echo "==> Deploying VerificationRegistry to Sepolia..."

DEPLOY_OUTPUT=$(forge create \
  --rpc-url "$L1_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --root "$ROOT/packages/contracts" \
  src/VerificationRegistry.sol:VerificationRegistry \
  --json 2>/dev/null) || {
    echo "ERROR: forge create failed. Make sure Foundry is installed and PRIVATE_KEY has Sepolia ETH."
    exit 1
  }

REGISTRY=$(echo "$DEPLOY_OUTPUT" | jq -r '.deployedTo')
TX_HASH=$(echo "$DEPLOY_OUTPUT" | jq -r '.transactionHash')

echo "    Registry deployed: $REGISTRY"
echo "    Transaction:       $TX_HASH"
echo ""

if [[ "${SKIP_SAMPLE:-0}" == "1" ]]; then
  echo "==> Skipping sample contract (SKIP_SAMPLE=1)"
  echo ""
  echo "Done. Registry address: $REGISTRY"
  exit 0
fi

echo "==> Deploying sample Counter to OP Sepolia..."

COUNTER_SRC='// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
contract Counter {
    uint256 public count;
    function increment() external { count++; }
}'

TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/src"
echo "$COUNTER_SRC" > "$TMPDIR/src/Counter.sol"
cat > "$TMPDIR/foundry.toml" <<'TOML'
[profile.default]
src = "src"
out = "out"
TOML

COUNTER_OUTPUT=$(forge create \
  --rpc-url "$OP_SEPOLIA_RPC" \
  --private-key "$PRIVATE_KEY" \
  --root "$TMPDIR" \
  src/Counter.sol:Counter \
  --json 2>/dev/null) || {
    echo "ERROR: Counter deployment to OP Sepolia failed."
    rm -rf "$TMPDIR"
    exit 1
  }

COUNTER_ADDR=$(echo "$COUNTER_OUTPUT" | jq -r '.deployedTo')
echo "    Counter deployed: $COUNTER_ADDR (OP Sepolia, chain 11155420)"
rm -rf "$TMPDIR"

if [[ -z "${PINATA_JWT:-}" ]]; then
  echo ""
  echo "==> PINATA_JWT not set, skipping proof submission."
  echo "    To verify, run:"
  echo "    pnpm cli verify --address $COUNTER_ADDR --chain-id 11155420 \\"
  echo "      --target-rpc $OP_SEPOLIA_RPC --l1-rpc $L1_RPC_URL \\"
  echo "      --registry $REGISTRY --input <compiler-input.json> \\"
  echo "      --contract-path src/Counter.sol --contract-name Counter \\"
  echo "      --compiler-version 0.8.26"
else
  echo ""
  echo "==> Verifying Counter via CLI..."
  # Generate compiler input for the simple Counter
  COMPILER_INPUT='{"language":"Solidity","sources":{"src/Counter.sol":{"content":"// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\ncontract Counter {\n    uint256 public count;\n    function increment() external { count++; }\n}"}},"settings":{"outputSelection":{"*":{"*":["evm.bytecode","evm.deployedBytecode"],"":["ast"]}},"optimizer":{"enabled":false,"runs":200},"evmVersion":"paris"}}'

  INPUT_FILE=$(mktemp)
  echo "$COMPILER_INPUT" > "$INPUT_FILE"

  pnpm --filter @cross-l2-verify/cli cli verify \
    --input "$INPUT_FILE" \
    --contract-path "src/Counter.sol" \
    --contract-name Counter \
    --address "$COUNTER_ADDR" \
    --chain-id 11155420 \
    --target-rpc "$OP_SEPOLIA_RPC" \
    --l1-rpc "$L1_RPC_URL" \
    --registry "$REGISTRY" \
    --compiler-version 0.8.26

  rm -f "$INPUT_FILE"
fi

echo ""
echo "==> Summary"
echo "    Registry:  $REGISTRY (Sepolia)"
echo "    Counter:   $COUNTER_ADDR (OP Sepolia)"
echo ""
echo "    Next steps:"
echo "    1. Deploy the same Counter bytecode to Base Sepolia / Arb Sepolia"
echo "    2. Run: pnpm cli propagate-batch --address $COUNTER_ADDR \\"
echo "         --chains \"84532=$BASE_SEPOLIA_RPC,421614=$ARB_SEPOLIA_RPC\" \\"
echo "         --l1-rpc $L1_RPC_URL --registry $REGISTRY"
echo "    3. Query: pnpm cli status --code-hash <hash> --l1-rpc $L1_RPC_URL --registry $REGISTRY"
