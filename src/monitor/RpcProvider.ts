// RpcProvider.ts
import { ethers } from "ethers";
import { RotatingRpcProvider } from "./RotatingRpcProvider";

type Env = {
  RPC_URLS: string;
  CHAIN_ID: string;
  RPC_SLOT_INTERVAL_MS?: string;
  RPC_MAX_ATTEMPTS?: string;
  RPC_DEBUG?: string;
};

export class RpcProvider {
  private readonly provider: RotatingRpcProvider;

  constructor(env: Env = process.env as any) {
    const urls = (env.RPC_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    console.log("[rpc] urls:", urls);

    if (urls.length === 0) throw new Error("RPC_URLS is empty.");
    if (!env.CHAIN_ID) throw new Error("CHAIN_ID is required (42161 for Arbitrum).");

    const chainId = Number(env.CHAIN_ID);
    const slotIntervalMs = Number(env.RPC_SLOT_INTERVAL_MS || 250);
    const maxAttempts = Number(env.RPC_MAX_ATTEMPTS || 1);
    const debug = String(env.RPC_DEBUG || "").toLowerCase() === "true";

    this.provider = new RotatingRpcProvider(urls, {
      chainId,
      slotIntervalMs,
      maxAttempts,
      debug,
    });
  }

  getProvider(): ethers.AbstractProvider {
    return this.provider;
  }

  dumpState(tag = "state") {
    console.log(
      `[rotate:${tag}] activeIndex=${this.provider.getActiveIndex()} activeUrl=${this.provider.getActiveUrl()}`
    );
  }
}
