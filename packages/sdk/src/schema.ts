import { z } from "zod";

const HexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const SoliditySourceSchema = z
  .object({
    content: z.string(),
    keccak256: HexSchema.optional(),
    urls: z.array(z.string()).optional(),
  })
  .passthrough();

export const SolidityStandardJsonInputSchema = z
  .object({
    language: z.literal("Solidity"),
    sources: z.record(z.string(), SoliditySourceSchema),
    settings: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const VerificationProofSchema = z
  .object({
    proofVersion: z.literal("1"),
    language: z.literal("Solidity"),
    contract: z.object({
      path: z.string(),
      name: z.string(),
    }),
    compiler: z.object({
      version: z.string().min(1),
      settings: z.record(z.string(), z.unknown()),
    }),
    sourceBundle: SolidityStandardJsonInputSchema,
    artifacts: z.object({
      creationBytecode: HexSchema,
      creationBytecodeHash: HexSchema,
      runtimeBytecode: HexSchema,
      runtimeBytecodeHash: HexSchema,
    }),
    attestation: z.object({
      codeHash: HexSchema,
      sourceHash: HexSchema,
      proofHash: HexSchema,
    }),
    deployments: z.array(
      z.object({
        chainId: z.number().int().positive(),
        address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      }),
    ),
    metadata: z.object({
      createdAt: z.string().min(1),
      tooling: z.object({
        sdk: z.string().min(1),
      }),
    }),
  })
  .passthrough();

export type SolidityStandardJsonInput = z.infer<typeof SolidityStandardJsonInputSchema>;
export type VerificationProof = z.infer<typeof VerificationProofSchema>;
