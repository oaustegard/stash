import { GitHubProvider } from "./github-provider.ts";
import { BitbucketDataCenterProvider } from "./bitbucket-datacenter-provider.ts";
import type { ProviderClass } from "../types.ts";

export const providers: Record<string, ProviderClass> = {
  github: GitHubProvider as unknown as ProviderClass,
  "bitbucket-dc": BitbucketDataCenterProvider as unknown as ProviderClass,
};
