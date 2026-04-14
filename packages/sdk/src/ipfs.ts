export interface PinJsonResult {
  cid: string;
  gatewayUrl: string;
}

export interface IpfsPinClient {
  pinJson(payload: unknown, options?: { name?: string }): Promise<PinJsonResult>;
  fetchJson<T>(cid: string): Promise<T>;
}

export interface PinataIpfsClientOptions {
  jwt?: string;
  gatewayUrl?: string;
}

export class PinataIpfsClient implements IpfsPinClient {
  private readonly jwt?: string;
  private readonly gatewayUrl: string;

  constructor(options: PinataIpfsClientOptions) {
    this.jwt = options.jwt;
    this.gatewayUrl = (options.gatewayUrl ?? "https://gateway.pinata.cloud/ipfs").replace(/\/$/, "");
  }

  async pinJson(payload: unknown, options?: { name?: string }): Promise<PinJsonResult> {
    if (!this.jwt) {
      throw new Error("Pinata JWT is required to pin JSON");
    }

    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinataOptions: {
          cidVersion: 1,
        },
        pinataMetadata: options?.name ? { name: options.name } : undefined,
        pinataContent: payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Pinata pin failed: ${response.status} ${await response.text()}`);
    }

    const json = (await response.json()) as { IpfsHash: string };
    return {
      cid: json.IpfsHash,
      gatewayUrl: `${this.gatewayUrl}/${json.IpfsHash}`,
    };
  }

  async fetchJson<T>(cid: string): Promise<T> {
    const response = await fetch(`${this.gatewayUrl}/${cid}`);
    if (!response.ok) {
      throw new Error(`IPFS fetch failed for ${cid}: ${response.status} ${await response.text()}`);
    }

    return (await response.json()) as T;
  }
}
