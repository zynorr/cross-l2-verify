// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IVerificationRegistry
/// @notice Interface for the cross-L2 verification registry.
interface IVerificationRegistry {
    struct VerificationRecord {
        bytes32 codeHash;
        bytes32 sourceHash;
        string compilerVersion;
        string ipfsCid;
        address submitter;
        uint64 submittedAt;
    }

    event ProofSubmitted(
        bytes32 indexed codeHash,
        bytes32 indexed proofHash,
        bytes32 indexed sourceHash,
        string compilerVersion,
        string ipfsCid,
        address submitter
    );

    event DeploymentRegistered(
        bytes32 indexed codeHash, uint256 indexed chainId, address indexed deployment, address submitter
    );

    function submitProof(
        bytes32 proofHash,
        bytes32 codeHash,
        bytes32 sourceHash,
        string calldata compilerVersion,
        string calldata ipfsCid
    ) external;

    function submitProofAndRegister(
        bytes32 proofHash,
        bytes32 codeHash,
        bytes32 sourceHash,
        string calldata compilerVersion,
        string calldata ipfsCid,
        uint256 chainId,
        address deployment
    ) external;

    function registerDeployment(bytes32 codeHash, uint256 chainId, address deployment) external;

    function getRecord(bytes32 proofHash) external view returns (VerificationRecord memory);

    function getProofHashes(bytes32 codeHash) external view returns (bytes32[] memory);

    function getDeployments(bytes32 codeHash, uint256 chainId) external view returns (address[] memory);

    function getRegisteredChainIds(bytes32 codeHash) external view returns (uint256[] memory);

    function proofCount(bytes32 codeHash) external view returns (uint256);

    function deploymentCount(bytes32 codeHash, uint256 chainId) external view returns (uint256);

    function proofExists(bytes32 proofHash) external view returns (bool);

    function chainIdExists(bytes32 codeHash, uint256 chainId) external view returns (bool);

    function deploymentExists(bytes32 codeHash, uint256 chainId, address deployment) external view returns (bool);
}
