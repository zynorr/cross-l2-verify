import { getAddress, keccak256, toBeHex, type AbstractProvider } from "ethers";

// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// ERC-1967 beacon slot: keccak256("eip1967.proxy.beacon") - 1
const ERC1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// ERC-1822 (UUPS) slot
const ERC1822_SLOT = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";

export interface ProxyDetectionResult {
  isProxy: boolean;
  proxyType?: "erc1967" | "erc1967-beacon" | "erc1822";
  implementationAddress?: string;
  proxyAddress: string;
}

export async function detectProxy(
  provider: AbstractProvider,
  address: string,
): Promise<ProxyDetectionResult> {
  const base = { isProxy: false, proxyAddress: getAddress(address) };

  // Try ERC-1967 implementation slot first.
  const implSlot = await provider.getStorage(address, ERC1967_IMPL_SLOT);
  const implAddr = slotToAddress(implSlot);
  if (implAddr) {
    return {
      isProxy: true,
      proxyType: "erc1967",
      implementationAddress: implAddr,
      proxyAddress: getAddress(address),
    };
  }

  // Try ERC-1967 beacon slot.
  const beaconSlot = await provider.getStorage(address, ERC1967_BEACON_SLOT);
  const beaconAddr = slotToAddress(beaconSlot);
  if (beaconAddr) {
    // Read the implementation from the beacon's implementation() method.
    // implementation() selector = 0x5c60da1b
    try {
      const implResult = await provider.call({
        to: beaconAddr,
        data: "0x5c60da1b",
      });
      const beaconImpl = slotToAddress(implResult);
      if (beaconImpl) {
        return {
          isProxy: true,
          proxyType: "erc1967-beacon",
          implementationAddress: beaconImpl,
          proxyAddress: getAddress(address),
        };
      }
    } catch {
      // Beacon didn't respond to implementation() — not a standard beacon.
    }
  }

  // Try ERC-1822 (UUPS) slot.
  const uupsSlot = await provider.getStorage(address, ERC1822_SLOT);
  const uupsAddr = slotToAddress(uupsSlot);
  if (uupsAddr) {
    return {
      isProxy: true,
      proxyType: "erc1822",
      implementationAddress: uupsAddr,
      proxyAddress: getAddress(address),
    };
  }

  return base;
}

export async function resolveImplementation(
  provider: AbstractProvider,
  address: string,
): Promise<{ address: string; isProxy: boolean; proxyAddress?: string }> {
  const result = await detectProxy(provider, address);

  if (result.isProxy && result.implementationAddress) {
    return {
      address: result.implementationAddress,
      isProxy: true,
      proxyAddress: result.proxyAddress,
    };
  }

  return { address: getAddress(address), isProxy: false };
}

function slotToAddress(slot: string): string | undefined {
  if (!slot || slot === "0x" || BigInt(slot) === 0n) return undefined;

  // Storage slot is 32 bytes, address is the last 20 bytes.
  const hex = toBeHex(BigInt(slot), 20);
  try {
    return getAddress(hex);
  } catch {
    return undefined;
  }
}
