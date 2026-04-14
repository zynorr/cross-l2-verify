export const VERIFICATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "submitProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proofHash", type: "bytes32" },
      { name: "codeHash", type: "bytes32" },
      { name: "sourceHash", type: "bytes32" },
      { name: "compilerVersion", type: "string" },
      { name: "ipfsCid", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "submitProofAndRegister",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proofHash", type: "bytes32" },
      { name: "codeHash", type: "bytes32" },
      { name: "sourceHash", type: "bytes32" },
      { name: "compilerVersion", type: "string" },
      { name: "ipfsCid", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "deployment", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "registerDeployment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "codeHash", type: "bytes32" },
      { name: "chainId", type: "uint256" },
      { name: "deployment", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getRecord",
    stateMutability: "view",
    inputs: [{ name: "proofHash", type: "bytes32" }],
    outputs: [
      {
        components: [
          { name: "codeHash", type: "bytes32" },
          { name: "sourceHash", type: "bytes32" },
          { name: "compilerVersion", type: "string" },
          { name: "ipfsCid", type: "string" },
          { name: "submitter", type: "address" },
          { name: "submittedAt", type: "uint64" },
        ],
        name: "",
        type: "tuple",
      },
    ],
  },
  {
    type: "function",
    name: "getProofHashes",
    stateMutability: "view",
    inputs: [{ name: "codeHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "getDeployments",
    stateMutability: "view",
    inputs: [
      { name: "codeHash", type: "bytes32" },
      { name: "chainId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getRegisteredChainIds",
    stateMutability: "view",
    inputs: [{ name: "codeHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

