// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VerificationRegistry} from "../src/VerificationRegistry.sol";

contract VerificationRegistryTest {
    function testSubmitProofStoresRecord() public {
        VerificationRegistry registry = new VerificationRegistry();
        (bytes32 proofHash, bytes32 codeHash, bytes32 sourceHash, string memory compilerVersion, string memory ipfsCid)
        = _proofParams();

        registry.submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid);

        require(registry.proofExists(proofHash), "proof not stored");

        VerificationRegistry.VerificationRecord memory record = registry.getRecord(proofHash);
        require(record.codeHash == codeHash, "bad code hash");
        require(record.sourceHash == sourceHash, "bad source hash");
        require(_sameString(record.compilerVersion, compilerVersion), "bad compiler");
        require(_sameString(record.ipfsCid, ipfsCid), "bad cid");
        require(record.submitter == address(this), "bad submitter");
        require(record.submittedAt > 0, "bad timestamp");

        bytes32[] memory proofHashes = registry.getProofHashes(codeHash);
        require(proofHashes.length == 1, "bad proof count");
        require(proofHashes[0] == proofHash, "bad proof index");
    }

    function testAllowsMultipleProofsForSameCodeHash() public {
        VerificationRegistry registry = new VerificationRegistry();
        (bytes32 proofHash, bytes32 codeHash, bytes32 sourceHash, string memory compilerVersion, string memory ipfsCid)
        = _proofParams();

        registry.submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid);
        bytes32 alternateSourceHash = keccak256("alternate-source");
        registry.submitProof(
            keccak256("alternate-proof-payload"),
            codeHash,
            alternateSourceHash,
            compilerVersion,
            "bafybeicrossl2verifyproofalt"
        );

        require(registry.proofCount(codeHash) == 2, "expected two proofs");
    }

    function testRejectsDuplicateProof() public {
        VerificationRegistry registry = new VerificationRegistry();
        (bytes32 proofHash, bytes32 codeHash, bytes32 sourceHash, string memory compilerVersion, string memory ipfsCid)
        = _proofParams();

        registry.submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid);

        try registry.submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid) {
            revert("expected duplicate proof revert");
        } catch Error(string memory reason) {
            require(_sameString(reason, "proof exists"), "wrong revert");
        } catch {
            revert("unexpected revert");
        }
    }

    function testRegisterDeploymentTracksChains() public {
        VerificationRegistry registry = new VerificationRegistry();
        bytes32 codeHash = keccak256("runtime-bytecode");

        registry.registerDeployment(codeHash, 10, address(0x1001));
        registry.registerDeployment(codeHash, 42161, address(0x2002));

        address[] memory opDeployments = registry.getDeployments(codeHash, 10);
        address[] memory arbDeployments = registry.getDeployments(codeHash, 42161);
        uint256[] memory chainIds = registry.getRegisteredChainIds(codeHash);

        require(opDeployments.length == 1, "bad op count");
        require(opDeployments[0] == address(0x1001), "bad op address");
        require(arbDeployments.length == 1, "bad arb count");
        require(arbDeployments[0] == address(0x2002), "bad arb address");
        require(chainIds.length == 2, "bad chain count");
        require(chainIds[0] == 10, "bad first chain");
        require(chainIds[1] == 42161, "bad second chain");
    }

    function testRejectsDuplicateDeployment() public {
        VerificationRegistry registry = new VerificationRegistry();
        bytes32 codeHash = keccak256("runtime-bytecode");

        registry.registerDeployment(codeHash, 10, address(0x1001));

        try registry.registerDeployment(codeHash, 10, address(0x1001)) {
            revert("expected duplicate deployment revert");
        } catch Error(string memory reason) {
            require(_sameString(reason, "deployment exists"), "wrong revert");
        } catch {
            revert("unexpected revert");
        }
    }

    function testSubmitProofAndRegister() public {
        VerificationRegistry registry = new VerificationRegistry();
        (bytes32 proofHash, bytes32 codeHash, bytes32 sourceHash, string memory compilerVersion, string memory ipfsCid)
        = _proofParams();

        registry.submitProofAndRegister(
            proofHash, codeHash, sourceHash, compilerVersion, ipfsCid, 8453, address(0x3003)
        );

        require(registry.proofExists(proofHash), "proof missing");
        require(registry.deploymentCount(codeHash, 8453) == 1, "deployment missing");
    }

    function _proofParams()
        internal
        pure
        returns (
            bytes32 proofHash,
            bytes32 codeHash,
            bytes32 sourceHash,
            string memory compilerVersion,
            string memory ipfsCid
        )
    {
        proofHash = keccak256("proof-payload");
        codeHash = keccak256("runtime-bytecode");
        sourceHash = keccak256("source-bundle");
        compilerVersion = "0.8.26";
        ipfsCid = "bafybeicrossl2verifyproof";
    }

    function _sameString(string memory lhs, string memory rhs) internal pure returns (bool) {
        return keccak256(bytes(lhs)) == keccak256(bytes(rhs));
    }
}
