import path from 'node:path';

export interface ShopifyConfig {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

export interface AppConfig { dataDir: string; maxUploadBytes: number; webOrigin: string; shopify?: ShopifyConfig; shopifyConfigurationError?: string; publishingEnabled: boolean; publishingAuthToken?: string }

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const maxMb = Number(process.env.MAX_UPLOAD_MB ?? 12);
  const shopifyValues = [process.env.SHOPIFY_SHOP_DOMAIN, process.env.SHOPIFY_CLIENT_ID, process.env.SHOPIFY_CLIENT_SECRET];
  const suppliedShopifyValues = shopifyValues.filter(Boolean).length;
  const shopify = suppliedShopifyValues === 3 ? {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN!,
    clientId: process.env.SHOPIFY_CLIENT_ID!,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
    apiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-10'
  } : undefined;
  return {
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data')),
    maxUploadBytes: Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1024 * 1024 : 12 * 1024 * 1024,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3000',
    shopify,
    shopifyConfigurationError: suppliedShopifyValues > 0 && suppliedShopifyValues < 3 ? 'Shopify configuration is incomplete.' : undefined,
    publishingEnabled: process.env.SHOPIFY_PUBLISHING_ENABLED === 'true',
    publishingAuthToken: process.env.SHOPIFY_PUBLISHING_AUTH_TOKEN,
    ...overrides
  };
}
