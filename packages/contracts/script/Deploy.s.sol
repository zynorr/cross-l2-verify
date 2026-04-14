// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {VerificationRegistry} from "../src/VerificationRegistry.sol";

interface Vm {
    function envUint(string calldata name) external view returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Minimal Foundry deployment script for VerificationRegistry.
/// Usage:
///   forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL --broadcast
contract DeployScript {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);

        new VerificationRegistry();

        vm.stopBroadcast();
    }
}
