import type { Provider } from "@prisma/client";
import { AnchorProvider } from "./anchor";
import { MoonpayProvider } from "./moonpay";
import { StripeProvider } from "./stripe";
import type { RampProvider } from "./types";

const providers: Record<Exclude<Provider, "MOCK">, RampProvider> = {
  STRIPE: new StripeProvider(),
  MOONPAY: new MoonpayProvider(),
  ANCHOR: new AnchorProvider(),
};

export const allProviders = () => Object.values(providers);
export const provider = (id: Exclude<Provider, "MOCK">) => providers[id];
