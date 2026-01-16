// RotatingRpcProvider.ts
import { ethers } from "ethers";

function is429(err: any): boolean {
  const status = String(err?.info?.responseStatus || "");
  if (status.includes("429")) return true;

  if (err?.info?.error?.code === 429) return true;

  const body = String(err?.info?.responseBody || "");
  if (body.includes("\"code\":429")) return true;

  return false;
}

export type RotatingOptions = {
  chainId: number;              // required
  slotIntervalMs?: number;      // throttle per backend
  maxAttempts?: number;         // set to 1 so rotation happens fast
  debug?: boolean;              // log switches + errors
};

export class RotatingRpcProvider extends ethers.AbstractProvider {
  private readonly urls: string[];
  private readonly providers: ethers.JsonRpcProvider[];
  private readonly network: ethers.Network;
  private activeIndex = 0;
  private readonly debug: boolean;

  constructor(urls: string[], opts: RotatingOptions) {
    const network = ethers.Network.from(opts.chainId);

    // AbstractProvider will call _detectNetwork() later; super() does not remove that requirement. [web:44]
    super(network);

    this.urls = urls;
    this.network = network;
    this.debug = !!opts.debug;

    const slotIntervalMs = opts.slotIntervalMs ?? 250;
    const maxAttempts = opts.maxAttempts ?? 1;

    this.providers = urls.map((url, i) => {
      const req = new ethers.FetchRequest(url);
      req.setThrottleParams({ slotInterval: slotIntervalMs, maxAttempts });

      // staticNetwork avoids repeated eth_chainId calls (saves throughput)
      const p = new ethers.JsonRpcProvider(req, network, { staticNetwork: network });

      if (this.debug) {
        p.on("error", (e) => console.log(`[rpc#${i}] ${url} ERROR`, e));
      }

      return p;
    });

    console.log("[rotate] urls:", this.urls);
    console.log("[rotate] starting activeIndex=0");
  }

  // REQUIRED by AbstractProvider. [web:44]
  async _detectNetwork(): Promise<ethers.Network> {
    return this.network;
  }

  getActiveUrl(): string {
    return this.urls[this.activeIndex];
  }

  getActiveIndex(): number {
    return this.activeIndex;
  }

  // Delegate each operation to the active backend; on 429, try next URL.
  async _perform(req: any): Promise<any> {
    let lastErr: any;

    for (let hop = 0; hop < this.providers.length; hop++) {
      const idx = (this.activeIndex + hop) % this.providers.length;

      try {
        const result = await (this.providers[idx] as any)._perform(req);

        if (idx !== this.activeIndex) {
          console.log(`[rotate] switch ${this.activeIndex} -> ${idx} (${this.urls[idx]})`);
          this.activeIndex = idx;
        }

        return result;
      } catch (e: any) {
        lastErr = e;

        if (is429(e)) {
          console.log(
            `[rotate] 429 on #${idx} (${this.urls[idx]}) op=${req?.method ?? req?.action ?? "unknown"}; trying next`
          );
          continue;
        }

        throw e;
      }
    }

    throw lastErr;
  }
}
