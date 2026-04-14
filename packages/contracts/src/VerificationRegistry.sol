// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title VerificationRegistry
/// @notice Anchors immutable verification attestations on Ethereum L1 and tracks
/// deployments of the same runtime bytecode across chains.
contract VerificationRegistry {
    struct VerificationRecord {
        bytes32 codeHash;
        bytes32 sourceHash;
        string compilerVersion;
        string ipfsCid;
        address submitter;
        uint64 submittedAt;
    }

    mapping(bytes32 proofHash => VerificationRecord record) private _verificationRecords;
    mapping(bytes32 proofHash => bool exists) public proofExists;
    mapping(bytes32 codeHash => bytes32[] proofHashes) private _proofsByCodeHash;
    mapping(bytes32 codeHash => mapping(uint256 chainId => address[] deployments)) private _deploymentsByCodeHash;
    mapping(bytes32 codeHash => uint256[] chainIds) private _chainIdsByCodeHash;
    mapping(bytes32 codeHash => mapping(uint256 chainId => bool exists)) public chainIdExists;
    mapping(bytes32 codeHash => mapping(uint256 chainId => mapping(address deployment => bool exists))) public
        deploymentExists;

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
    ) public {
        require(proofHash != bytes32(0), "proof hash required");
        require(codeHash != bytes32(0), "code hash required");
        require(sourceHash != bytes32(0), "source hash required");
        require(bytes(compilerVersion).length != 0, "compiler required");
        require(bytes(ipfsCid).length != 0, "cid required");

        require(!proofExists[proofHash], "proof exists");

        proofExists[proofHash] = true;
        _verificationRecords[proofHash] = VerificationRecord({
            codeHash: codeHash,
            sourceHash: sourceHash,
            compilerVersion: compilerVersion,
            ipfsCid: ipfsCid,
            submitter: msg.sender,
            submittedAt: uint64(block.timestamp)
        });
        _proofsByCodeHash[codeHash].push(proofHash);

        emit ProofSubmitted(codeHash, proofHash, sourceHash, compilerVersion, ipfsCid, msg.sender);
    }

    function submitProofAndRegister(
        bytes32 proofHash,
        bytes32 codeHash,
        bytes32 sourceHash,
        string calldata compilerVersion,
        string calldata ipfsCid,
        uint256 chainId,
        address deployment
    ) external {
        submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid);
        _registerDeployment(codeHash, chainId, deployment);
    }

    function registerDeployment(bytes32 codeHash, uint256 chainId, address deployment) external {
        _registerDeployment(codeHash, chainId, deployment);
    }

    function getRecord(bytes32 proofHash) external view returns (VerificationRecord memory) {
        require(proofExists[proofHash], "proof missing");
        return _verificationRecords[proofHash];
    }

    function getProofHashes(bytes32 codeHash) external view returns (bytes32[] memory) {
        return _proofsByCodeHash[codeHash];
    }

    function getDeployments(bytes32 codeHash, uint256 chainId) external view returns (address[] memory) {
        return _deploymentsByCodeHash[codeHash][chainId];
    }

    function getRegisteredChainIds(bytes32 codeHash) external view returns (uint256[] memory) {
        return _chainIdsByCodeHash[codeHash];
    }

    function proofCount(bytes32 codeHash) external view returns (uint256) {
        return _proofsByCodeHash[codeHash].length;
    }

    function deploymentCount(bytes32 codeHash, uint256 chainId) external view returns (uint256) {
        return _deploymentsByCodeHash[codeHash][chainId].length;
    }

    function _registerDeployment(bytes32 codeHash, uint256 chainId, address deployment) internal {
        require(codeHash != bytes32(0), "code hash required");
        require(chainId != 0, "chain id required");
        require(deployment != address(0), "deployment required");
        require(!deploymentExists[codeHash][chainId][deployment], "deployment exists");

        if (!chainIdExists[codeHash][chainId]) {
            chainIdExists[codeHash][chainId] = true;
            _chainIdsByCodeHash[codeHash].push(chainId);
        }

        deploymentExists[codeHash][chainId][deployment] = true;
        _deploymentsByCodeHash[codeHash][chainId].push(deployment);

        emit DeploymentRegistered(codeHash, chainId, deployment, msg.sender);
    }
}
