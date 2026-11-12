import type {
  ShopifyProductDetail, ShopifyProductImage, ShopifyProductSummary, ShopifyStatus, ShopifyVariant
} from '@mockup-automation/shared';
import type { ShopifyConfig } from '../config.js';
import { analyzeTransparency, ImageValidationError, inspectImage } from './images.js';

type Fetcher = typeof fetch;
type GraphqlResponse<T> = { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }>; extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } };
type ImageNode = { id: string; url: string; altText?: string | null; width?: number | null; height?: number | null };
type MediaNode = { id: string; mediaContentType: string; image?: ImageNode | null; preview?: { image?: ImageNode | null } | null };

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const IMAGE_GID = /^gid:\/\/shopify\/(?:ProductImage|MediaImage)\/[1-9]\d*$/;
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const MAX_SEARCH_RESULTS = 20;
const MAX_PRODUCT_IMAGES = 250;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export class ShopifyError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'SHOPIFY_ERROR') { super(message); }
}

export class ShopifyService {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly config: ShopifyConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly maxDownloadBytes = 12 * 1024 * 1024
  ) {
    if (!SHOP_DOMAIN.test(config.shopDomain)) throw new ShopifyError('SHOPIFY_SHOP_DOMAIN must be a valid *.myshopify.com domain.', 500, 'INVALID_CONFIGURATION');
    if (config.apiVersion !== '2026-10') throw new ShopifyError('Phase 2 requires SHOPIFY_API_VERSION=2026-10.', 500, 'INVALID_CONFIGURATION');
  }

  async status(): Promise<ShopifyStatus> {
    const data = await this.graphql<{ shop: { name: string }; currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(`
      query Connectivity {
        shop { name }
        currentAppInstallation { accessScopes { handle } }
      }
    `);
    const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
    if (!scopes.includes('read_products')) throw new ShopifyError('Shopify connected, but the app is missing the required read_products scope.', 403, 'MISSING_SCOPE');
    return { configured: true, connected: true, shop: data.shop.name, scopes };
  }

  async searchProducts(title: string): Promise<ShopifyProductSummary[]> {
    const trimmed = title.trim();
    if (trimmed.length < 2 || trimmed.length > 200) throw new ShopifyError('Enter a product title between 2 and 200 characters.', 400, 'INVALID_SEARCH');
    const queryValue = `title:${JSON.stringify(trimmed)}`;
    const data = await this.graphql<{ products: { nodes: Array<{ id: string; title: string; handle: string; status: string; featuredMedia?: MediaNode | null }> } }>(`
      query ProductSearch($query: String!, $first: Int!) {
        products(first: $first, query: $query, sortKey: TITLE) {
          nodes { id title handle status featuredMedia { preview { image { id url altText width height } } } }
        }
      }
    `, { query: queryValue, first: MAX_SEARCH_RESULTS });
    return data.products.nodes.map((product) => ({
      id: product.id, title: product.title, handle: product.handle, status: product.status,
      imageUrl: product.featuredMedia?.preview?.image?.url
    }));
  }

  async getProduct(productId: string, validateImages = true): Promise<ShopifyProductDetail> {
    this.assertProductId(productId);
    let imageCursor: string | null = null;
    let mediaCursor: string | null = null;
    let variantCursor: string | null = null;
    let product: any | null = null;
    const imageNodes: ImageNode[] = [];
    const mediaNodes: MediaNode[] = [];
    const variantNodes: any[] = [];
    for (let page = 0; page < 20; page += 1) {
      const data: { product: any | null } = await this.graphql<{ product: any | null }>(`
      query ProductDetail($id: ID!, $imageAfter: String, $mediaAfter: String, $variantAfter: String) {
        product(id: $id) {
          id title handle status
          images(first: 100, after: $imageAfter) { nodes { id url altText width height } pageInfo { hasNextPage endCursor } }
          media(first: 100, after: $mediaAfter) { nodes { id mediaContentType preview { image { id url altText width height } } ... on MediaImage { image { id url altText width height } } } pageInfo { hasNextPage endCursor } }
          variants(first: 100, after: $variantAfter) {
            nodes {
              id title selectedOptions { name value }
              image { id url altText width height }
              media(first: 100) { nodes { id mediaContentType preview { image { id url altText width height } } ... on MediaImage { image { id url altText width height } } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `, { id: productId, imageAfter: imageCursor, mediaAfter: mediaCursor, variantAfter: variantCursor });
      if (!data.product) throw new ShopifyError('Shopify product not found.', 404, 'NOT_FOUND');
      product ??= data.product;
      imageNodes.push(...data.product.images.nodes);
      mediaNodes.push(...data.product.media.nodes);
      variantNodes.push(...data.product.variants.nodes);
      const imagePage: { hasNextPage?: boolean; endCursor?: string | null } | undefined = data.product.images.pageInfo;
      const mediaPage: { hasNextPage?: boolean; endCursor?: string | null } | undefined = data.product.media.pageInfo;
      const variantPage: { hasNextPage?: boolean; endCursor?: string | null } | undefined = data.product.variants.pageInfo;
      const hasMore = Boolean(imagePage?.hasNextPage || mediaPage?.hasNextPage || variantPage?.hasNextPage);
      if (!hasMore) break;
      imageCursor = imagePage?.hasNextPage ? imagePage.endCursor ?? imageCursor : imageCursor;
      mediaCursor = mediaPage?.hasNextPage ? mediaPage.endCursor ?? mediaCursor : mediaCursor;
      variantCursor = variantPage?.hasNextPage ? variantPage.endCursor ?? variantCursor : variantCursor;
      if (page === 19) throw new ShopifyError('Shopify product exceeds the supported pagination limit.', 422, 'CATALOG_TOO_LARGE');
    }
    product.images.nodes = [...new Map(imageNodes.map((node) => [node.id, node])).values()];
    product.media.nodes = [...new Map(mediaNodes.map((node) => [node.id, node])).values()];
    product.variants.nodes = [...new Map(variantNodes.map((node) => [node.id, node])).values()];
    const variants: ShopifyVariant[] = product.variants.nodes.map((variant: any) => {
      const option = (name: string) => variant.selectedOptions.find((item: any) => item.name.toLowerCase() === name)?.value;
      const associatedImageIds = new Set<string>();
      if (variant.image?.id) associatedImageIds.add(variant.image.id);
      for (const media of variant.media.nodes as MediaNode[]) {
        const image = this.mediaImage(media);
        if (image?.id) associatedImageIds.add(image.id);
        if (media.id) associatedImageIds.add(media.id);
      }
      return { id: variant.id, title: variant.title, selectedOptions: variant.selectedOptions, color: option('color') ?? option('colour'), size: option('size'), associatedImageIds: [...associatedImageIds] };
    });

    const imageCandidates: ImageNode[] = [];
    for (const image of product.images.nodes as ImageNode[]) imageCandidates.push(image);
    for (const media of product.media.nodes as MediaNode[]) {
      const image = this.mediaImage(media);
      if (image) {
        imageCandidates.push(image, { ...image, id: media.id });
      }
    }
    const imagesByUrl = new Map<string, { image: ImageNode; aliases: Set<string> }>();
    for (const image of imageCandidates) {
      const existing = imagesByUrl.get(image.url);
      if (existing) existing.aliases.add(image.id);
      else imagesByUrl.set(image.url, { image, aliases: new Set([image.id]) });
    }
    const uniqueImages = [...imagesByUrl.values()].slice(0, MAX_PRODUCT_IMAGES);
    const images: ShopifyProductImage[] = [];
    for (const { image, aliases } of uniqueImages) {
      const colors = new Set(variants.filter((variant) => variant.associatedImageIds.some((id) => aliases.has(id))).map((variant) => variant.color).filter((color): color is string => Boolean(color)));
      const association = colors.size === 1 ? 'reliable' : colors.size > 1 ? 'ambiguous' : 'unassociated';
      let validation: ShopifyProductImage['validation'] = 'unavailable';
      let validationMessage: string | undefined;
      if (validateImages) {
        try {
          const downloaded = await this.downloadImage(image.url);
          const inspected = await inspectImage(downloaded, ['png', 'jpeg']);
          validation = inspected.format === 'png' && (await analyzeTransparency(downloaded)).isMeaningfullyTransparent ? 'transparent' : 'opaque';
        } catch (error) {
          validation = error instanceof ImageValidationError ? 'unsupported' : 'unavailable';
          validationMessage = error instanceof Error ? error.message : 'Image validation failed.';
        }
      }
      images.push({ id: image.id, url: image.url, altText: image.altText ?? undefined, width: image.width ?? undefined, height: image.height ?? undefined, associatedColors: [...colors], association, validation, validationMessage });
    }
    const colors = [...new Set(variants.map((variant) => variant.color).filter((value): value is string => Boolean(value)))];
    const sizes = [...new Set(variants.map((variant) => variant.size).filter((value): value is string => Boolean(value)))];
    return { id: product.id, title: product.title, handle: product.handle, status: product.status, imageUrl: images[0]?.url, colors, sizes, variants, images };
  }

  async importTransparentImage(productId: string, imageId: string) {
    this.assertProductId(productId);
    if (!IMAGE_GID.test(imageId)) throw new ShopifyError('Invalid Shopify image ID.', 400, 'INVALID_ID');
    const product = await this.getProduct(productId, false);
    const image = product.images.find((candidate) => candidate.id === imageId);
    if (!image) throw new ShopifyError('The requested image is not associated with this product.', 404, 'NOT_FOUND');
    const buffer = await this.downloadImage(image.url);
    const info = await inspectImage(buffer, ['png', 'jpeg']);
    if (info.format !== 'png' || !(await analyzeTransparency(buffer)).isMeaningfullyTransparent) throw new ShopifyError('The selected Shopify image is not a transparent PNG garment source.', 400, 'INCOMPATIBLE_IMAGE');
    return { buffer, info, originalName: `shopify-${imageId.split('/').at(-1)}.png` };
  }

  async downloadImage(rawUrl: string): Promise<Buffer> {
    let url = this.validateImageUrl(rawUrl);
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      const response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new ShopifyError('Shopify image redirect could not be validated.', 502, 'UNTRUSTED_REDIRECT');
        url = this.validateImageUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok || !response.body) throw new ShopifyError('Shopify image download failed.', 502, 'DOWNLOAD_FAILED');
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > this.maxDownloadBytes) throw new ShopifyError('Shopify image exceeds the configured download limit.', 413, 'IMAGE_TOO_LARGE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > this.maxDownloadBytes) { await reader.cancel(); throw new ShopifyError('Shopify image exceeds the configured download limit.', 413, 'IMAGE_TOO_LARGE'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
    throw new ShopifyError('Shopify image download failed.', 502, 'DOWNLOAD_FAILED');
  }

  private async accessToken(force = false) {
    if (!force && this.token && Date.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    const response = await this.fetcher(`https://${this.config.shopDomain}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret })
    });
    const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!response.ok || !payload.access_token) {
      const reason = payload.error === 'shop_not_permitted' ? 'Client credentials are not permitted for this shop. Confirm the app and store belong to the same Shopify organization and the app is installed.' : 'Shopify rejected client-credentials authentication.';
      throw new ShopifyError(reason, 502, payload.error ?? 'AUTHENTICATION_FAILED');
    }
    const expiresIn = Number(payload.expires_in ?? 86_400);
    this.token = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
    return this.token.value;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetcher(`https://${this.config.shopDomain}/admin/api/${this.config.apiVersion}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables })
    });
    if (response.status === 401 && retry) { this.token = undefined; return this.graphql<T>(query, variables, false); }
    if (response.status === 429 && retry) {
      const seconds = Math.min(2, Math.max(0.1, Number(response.headers.get('retry-after') ?? 0.5)));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return this.graphql<T>(query, variables, false);
    }
    if (!response.ok) throw new ShopifyError(`Shopify Admin API request failed with status ${response.status}.`, 502, 'GRAPHQL_HTTP_ERROR');
    const payload = await response.json() as GraphqlResponse<T>;
    const throttled = payload.errors?.some((error) => error.extensions?.code === 'THROTTLED');
    if (throttled && retry) { await new Promise((resolve) => setTimeout(resolve, 500)); return this.graphql<T>(query, variables, false); }
    if (payload.errors?.length || !payload.data) throw new ShopifyError(payload.errors?.[0]?.message ?? 'Shopify returned an invalid GraphQL response.', 502, throttled ? 'THROTTLED' : 'GRAPHQL_ERROR');
    return payload.data;
  }

  private validateImageUrl(rawUrl: string) {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ShopifyError('Shopify returned an invalid image URL.', 400, 'INVALID_URL'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'cdn.shopify.com' || host.endsWith('.shopifycdn.com'))) throw new ShopifyError('Shopify image URL uses an untrusted host.', 400, 'UNTRUSTED_URL');
    if (url.username || url.password || url.port) throw new ShopifyError('Shopify image URL contains unsupported authority components.', 400, 'UNTRUSTED_URL');
    return url;
  }

  private assertProductId(id: string) { if (!PRODUCT_GID.test(id)) throw new ShopifyError('Invalid Shopify product ID.', 400, 'INVALID_ID'); }
  private mediaImage(media: MediaNode) { return media.mediaContentType === 'IMAGE' ? media.image ?? media.preview?.image ?? undefined : undefined; }
}
