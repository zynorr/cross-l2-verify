import assert from "node:assert/strict";
import test from "node:test";

import { resolveFoundryHookInput, resolveHardhatHookInput } from "./hooks.js";

test("resolveFoundryHookInput infers address and chain id from broadcast json", () => {
  const result = resolveFoundryHookInput({
    contractName: "Counter",
    broadcast: {
      chain: "421614",
      transactions: [
        {
          transactionType: "CALL",
          contractName: "Setup",
        },
        {
          transactionType: "CREATE2",
          contractName: "Counter",
          contractAddress: "0x0000000000000000000000000000000000000042",
        },
      ],
    },
  });

  assert.deepEqual(result, {
    address: "0x0000000000000000000000000000000000000042",
    chainId: 421614,
  });
});

test("resolveHardhatHookInput infers compiler input, path, address, and chain id", () => {
  const result = resolveHardhatHookInput({
    contractName: "Counter",
    buildInfo: {
      solcLongVersion: "0.8.26+commit.8a97fa7a",
      input: {
        language: "Solidity",
        sources: {
          "contracts/Counter.sol": {
            content: "pragma solidity ^0.8.26; contract Counter { }",
          },
        },
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      output: {
        contracts: {
          "contracts/Counter.sol": {
            Counter: {
              abi: [],
            },
          },
        },
      },
    },
    deployment: {
      address: "0x0000000000000000000000000000000000000042",
      receipt: {
        chainId: 84532,
      },
    },
  });

  assert.equal(result.contractPath, "contracts/Counter.sol");
  assert.equal(result.compilerVersion, "0.8.26+commit.8a97fa7a");
  assert.equal(result.address, "0x0000000000000000000000000000000000000042");
  assert.equal(result.chainId, 84532);
});
