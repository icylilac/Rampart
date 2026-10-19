import type { Provider } from "@prisma/client";
import { AnchorProvider } from "./anchor";
import { MoonpayProvider } from "./moonpay";
import { SandboxProvider } from "./sandbox";
import { StripeProvider } from "./stripe";
import type { RampProvider } from "./types";

export type LiveProvider = Exclude<Provider, "SANDBOX">;

const live: Record<LiveProvider, RampProvider> = {
  STRIPE: new StripeProvider(),
  MOONPAY: new MoonpayProvider(),
  ANCHOR: new AnchorProvider(),
};

export const sandbox = new SandboxProvider();

/** Real providers, as listed by GET /v1/providers. */
export const allProviders = () => Object.values(live);

export function provider(id: Provider): RampProvider {
  return id === "SANDBOX" ? sandbox : live[id];
}

export const anchorProvider = () => live.ANCHOR as AnchorProvider;
