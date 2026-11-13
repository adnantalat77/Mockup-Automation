import type {
  ShopifyProductDetail, ShopifyProductImage, ShopifyProductSummary, ShopifyStatus, ShopifyVariant
} from '@mockup-automation/shared';
import type { ShopifyConfig } from '../config.js';
import { analyzeTransparency, ImageValidationError, inspectImage } from './images.js';

type Fetcher = typeof fetch;
type GraphqlResponse<T> = { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }>; extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } } };
type ImageNode = { id: string; url: string; altText?: string | null; width?: number | null; height?: number | null };
type MediaNode = { id: string; mediaContentType: string; image?: ImageNode | null; preview?: { image?: ImageNode | null } | null };
export interface ShopifyPublicationState { complete: true; mediaIds: string[]; variants: Array<{ id: string; color?: string; mediaIds: string[] }> }
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

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

  async getPublicationState(productId: string): Promise<ShopifyPublicationState> {
    this.assertProductId(productId);
    const mediaIds: string[] = [];
    let mediaCursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const data: { product: { media: { nodes: Array<{ id: string }>; pageInfo: PageInfo } } | null } = await this.graphql(`
      query PublicationMedia($id: ID!, $after: String) {
        product(id: $id) {
          media(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
        }
      `, { id: productId, after: mediaCursor });
      if (!data.product) throw new ShopifyError('Shopify product not found.', 404, 'NOT_FOUND');
      mediaIds.push(...data.product.media.nodes.map((node) => node.id));
      if (!data.product.media.pageInfo.hasNextPage) break;
      const next = data.product.media.pageInfo.endCursor;
      if (!next || next === mediaCursor || page === 99) throw new ShopifyError('Shopify media pagination could not be completed safely.', 502, 'INCOMPLETE_SNAPSHOT');
      mediaCursor = next;
    }

    const variantNodes: Array<{ id: string; selectedOptions: Array<{ name: string; value: string }> }> = [];
    let variantCursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const data: { product: { variants: { nodes: typeof variantNodes; pageInfo: PageInfo } } | null } = await this.graphql(`
        query PublicationVariants($id: ID!, $after: String) {
          product(id: $id) { variants(first: 100, after: $after) { nodes { id selectedOptions { name value } } pageInfo { hasNextPage endCursor } } }
        }
      `, { id: productId, after: variantCursor });
      if (!data.product) throw new ShopifyError('Shopify product not found.', 404, 'NOT_FOUND');
      variantNodes.push(...data.product.variants.nodes);
      if (!data.product.variants.pageInfo.hasNextPage) break;
      const next = data.product.variants.pageInfo.endCursor;
      if (!next || next === variantCursor || page === 99) throw new ShopifyError('Shopify variant pagination could not be completed safely.', 502, 'INCOMPLETE_SNAPSHOT');
      variantCursor = next;
    }

    const color = (options: Array<{ name: string; value: string }>) => options.find((option) => ['color', 'colour'].includes(option.name.toLowerCase()))?.value;
    const variants: ShopifyPublicationState['variants'] = [];
    for (const variant of variantNodes) {
      const variantMediaIds: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const data: { node: { media: { nodes: Array<{ id: string }>; pageInfo: PageInfo } } | null } = await this.graphql(`
          query PublicationVariantMedia($id: ID!, $after: String) {
            node(id: $id) { ... on ProductVariant { media(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } }
          }
        `, { id: variant.id, after: cursor });
        if (!data.node) throw new ShopifyError('Shopify variant snapshot could not be completed safely.', 502, 'INCOMPLETE_SNAPSHOT');
        variantMediaIds.push(...data.node.media.nodes.map((node) => node.id));
        if (!data.node.media.pageInfo.hasNextPage) break;
        const next = data.node.media.pageInfo.endCursor;
        if (!next || next === cursor || page === 99) throw new ShopifyError('Shopify variant-media pagination could not be completed safely.', 502, 'INCOMPLETE_SNAPSHOT');
        cursor = next;
      }
      variants.push({ id: variant.id, color: color(variant.selectedOptions), mediaIds: variantMediaIds });
    }
    return {
      complete: true,
      mediaIds,
      variants
    };
  }

  async stageImage(filename: string, bytes: Buffer) {
    const result = await this.graphql<{ stagedUploadsCreate: { stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }> | null; userErrors: Array<{ message: string }> } }>(`
      mutation StageImage($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
      }
    `, { input: [{ filename, mimeType: 'image/png', httpMethod: 'PUT', resource: 'PRODUCT_IMAGE' }] });
    this.assertUserErrors(result.stagedUploadsCreate.userErrors);
    const target = result.stagedUploadsCreate.stagedTargets?.[0];
    if (!target) throw new ShopifyError('Shopify did not return a staged upload target.', 502, 'STAGED_UPLOAD_FAILED');
    const uploadUrl = this.validateStagedUrl(target.url);
    const headers = Object.fromEntries(target.parameters.map((parameter) => [parameter.name, parameter.value]));
    const uploaded = await this.fetcher(uploadUrl, { method: 'PUT', headers, body: new Uint8Array(bytes), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!uploaded.ok) throw new ShopifyError(`Shopify staged upload failed with status ${uploaded.status}.`, 502, 'STAGED_UPLOAD_FAILED');
    return target.resourceUrl;
  }

  async createImageFile(resourceUrl: string, alt: string) {
    const result = await this.graphql<{ fileCreate: { files: Array<{ id: string; fileStatus: string }> | null; userErrors: Array<{ message: string }> } }>(`
      mutation CreateImageFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) { files { id fileStatus } userErrors { message } }
      }
    `, { files: [{ originalSource: resourceUrl, contentType: 'IMAGE', alt, duplicateResolutionMode: 'APPEND_UUID' }] });
    this.assertUserErrors(result.fileCreate.userErrors);
    const file = result.fileCreate.files?.[0];
    if (!file?.id) throw new ShopifyError('Shopify did not create the image file.', 502, 'FILE_CREATE_FAILED');
    return file;
  }

  async waitForFileReady(fileId: string, attempts = 20) {
    this.assertMediaId(fileId);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const data = await this.graphql<{ node: { id: string; fileStatus: string; fileErrors: Array<{ message: string }> } | null }>(`
        query FileStatus($id: ID!) { node(id: $id) { ... on MediaImage { id fileStatus fileErrors { message } } } }
      `, { id: fileId });
      if (data.node?.fileStatus === 'READY') return;
      if (!data.node || data.node.fileStatus === 'FAILED') throw new ShopifyError(data.node?.fileErrors?.[0]?.message ?? 'Shopify media processing failed.', 502, 'MEDIA_PROCESSING_FAILED');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ShopifyError('Shopify media processing timed out.', 504, 'MEDIA_PROCESSING_TIMEOUT');
  }

  async addFileToProduct(fileId: string, productId: string) {
    this.assertMediaId(fileId); this.assertProductId(productId);
    const result = await this.graphql<{ fileUpdate: { files: Array<{ id: string }> | null; userErrors: Array<{ message: string }> } }>(`
      mutation AddFileToProduct($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { message } } }
    `, { files: [{ id: fileId, referencesToAdd: [productId] }] });
    this.assertUserErrors(result.fileUpdate.userErrors);
  }

  async removeFileFromProduct(fileId: string, productId: string) {
    this.assertMediaId(fileId); this.assertProductId(productId);
    const result = await this.graphql<{ fileUpdate: { userErrors: Array<{ message: string }> } }>(`
      mutation RemoveFileFromProduct($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { message } } }
    `, { files: [{ id: fileId, referencesToRemove: [productId] }] });
    this.assertUserErrors(result.fileUpdate.userErrors);
  }

  async appendVariantMedia(productId: string, mediaId: string, variantIds: string[]) {
    this.assertProductId(productId); this.assertMediaId(mediaId); variantIds.forEach((id) => this.assertVariantId(id));
    const result = await this.graphql<{ productVariantAppendMedia: { userErrors: Array<{ message: string }> } }>(`
      mutation AppendVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
        productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) { userErrors { message } }
      }
    `, { productId, variantMedia: variantIds.map((variantId) => ({ variantId, mediaIds: [mediaId] })) });
    this.assertUserErrors(result.productVariantAppendMedia.userErrors);
  }

  async detachVariantMedia(productId: string, mediaId: string, variantIds: string[]) {
    this.assertProductId(productId); this.assertMediaId(mediaId); variantIds.forEach((id) => this.assertVariantId(id));
    const result = await this.graphql<{ productVariantDetachMedia: { userErrors: Array<{ message: string }> } }>(`
      mutation DetachVariantMedia($productId: ID!, $variantMedia: [ProductVariantDetachMediaInput!]!) {
        productVariantDetachMedia(productId: $productId, variantMedia: $variantMedia) { userErrors { message } }
      }
    `, { productId, variantMedia: variantIds.map((variantId) => ({ variantId, mediaIds: [mediaId] })) });
    this.assertUserErrors(result.productVariantDetachMedia.userErrors);
  }

  async reorderMedia(productId: string, mediaIds: string[]) {
    this.assertProductId(productId); mediaIds.forEach((id) => this.assertMediaId(id));
    const result = await this.graphql<{ productReorderMedia: { job: { id: string; done: boolean } | null; mediaUserErrors: Array<{ message: string }> } }>(`
      mutation ReorderMedia($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) { job { id done } mediaUserErrors { message } }
      }
    `, { id: productId, moves: mediaIds.map((id, index) => ({ id, newPosition: String(index) })) });
    this.assertUserErrors(result.productReorderMedia.mediaUserErrors);
    if (result.productReorderMedia.job && !result.productReorderMedia.job.done) await this.waitForJob(result.productReorderMedia.job.id);
  }

  async deleteFile(fileId: string) {
    this.assertMediaId(fileId);
    const result = await this.graphql<{ fileDelete: { deletedFileIds: string[]; userErrors: Array<{ message: string }> } }>(`
      mutation DeleteFile($fileIds: [ID!]!) { fileDelete(fileIds: $fileIds) { deletedFileIds userErrors { message } } }
    `, { fileIds: [fileId] });
    this.assertUserErrors(result.fileDelete.userErrors);
    if (!result.fileDelete.deletedFileIds.includes(fileId)) throw new ShopifyError('Shopify did not confirm file deletion.', 502, 'FILE_DELETE_FAILED');
  }

  async verifyFileDeletionSafe(fileId: string, productId: string): Promise<{ safe: boolean; reason: string }> {
    this.assertMediaId(fileId); this.assertProductId(productId);
    // Admin GraphQL 2026-10 exposes product references as write-only
    // referencesToAdd/referencesToRemove inputs. It does not expose a complete
    // inverse reference connection on File/MediaImage, so global ownership
    // cannot be proven without an external ownership registry.
    return { safe: false, reason: 'Shopify 2026-10 cannot enumerate every product reference for a file; global deletion requires manual confirmation.' };
  }

  private async waitForJob(jobId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const data = await this.graphql<{ node: { done: boolean } | null }>(`query JobStatus($id: ID!) { node(id: $id) { ... on Job { done } } }`, { id: jobId });
      if (data.node?.done) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ShopifyError('Shopify asynchronous job timed out.', 504, 'JOB_TIMEOUT');
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

  private validateStagedUrl(rawUrl: string) {
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw new ShopifyError('Shopify returned an invalid staged upload URL.', 502, 'INVALID_STAGED_URL'); }
    const host = url.hostname.toLowerCase();
    const trusted = host.endsWith('.shopify.com') || host.endsWith('.shopifycdn.com') || host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com') || host.endsWith('.googleapis.com');
    if (url.protocol !== 'https:' || !trusted || url.username || url.password) throw new ShopifyError('Shopify returned an untrusted staged upload URL.', 502, 'INVALID_STAGED_URL');
    return url;
  }

  private assertUserErrors(errors: Array<{ message: string }> | undefined) {
    if (errors?.length) throw new ShopifyError(errors[0].message, 422, 'SHOPIFY_USER_ERROR');
  }

  private assertProductId(id: string) { if (!PRODUCT_GID.test(id)) throw new ShopifyError('Invalid Shopify product ID.', 400, 'INVALID_ID'); }
  private assertMediaId(id: string) { if (!/^gid:\/\/shopify\/MediaImage\/[1-9]\d*$/.test(id)) throw new ShopifyError('Invalid Shopify media ID.', 400, 'INVALID_ID'); }
  private assertVariantId(id: string) { if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(id)) throw new ShopifyError('Invalid Shopify variant ID.', 400, 'INVALID_ID'); }
  private mediaImage(media: MediaNode) { return media.mediaContentType === 'IMAGE' ? media.image ?? media.preview?.image ?? undefined : undefined; }
}
