import { describe, expect, it, vi } from 'vitest';
import { ShopifyError, ShopifyService } from './shopify.js';

const config = { shopDomain: 'equipd-wear.myshopify.com', clientId: 'client-id', clientSecret: 'client-secret', apiVersion: '2026-10' };
const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('ShopifyService', () => {
  it('uses client credentials, verifies scopes, and caches the token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'secret-token', expires_in: 3600 }))
      .mockImplementation(() => Promise.resolve(json({ data: { shop: { name: 'Equipd Wear' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } } })));
    const service = new ShopifyService(config, fetcher as unknown as typeof fetch);
    await expect(service.status()).resolves.toMatchObject({ connected: true, shop: 'Equipd Wear', scopes: ['read_products'] });
    await service.status();
    expect(fetcher).toHaveBeenCalledTimes(3);
    const tokenRequest = fetcher.mock.calls[0];
    expect(tokenRequest[0]).toBe('https://equipd-wear.myshopify.com/admin/oauth/access_token');
    expect(String(tokenRequest[1].body)).toContain('grant_type=client_credentials');
    expect(fetcher.mock.calls[1][1].headers['X-Shopify-Access-Token']).toBe('secret-token');
  });

  it('reports client-credentials ineligibility without another auth fallback', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: 'shop_not_permitted' }, 401));
    const service = new ShopifyService(config, fetcher as unknown as typeof fetch);
    await expect(service.status()).rejects.toMatchObject({ code: 'shop_not_permitted' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('searches by title with bounded results', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ data: { products: { nodes: [{ id: 'gid://shopify/Product/123', title: 'Texas Shirt', handle: 'texas-shirt', status: 'ACTIVE', featuredMedia: null }] } } }));
    const service = new ShopifyService(config, fetcher as unknown as typeof fetch);
    await expect(service.searchProducts('Texas Shirt')).resolves.toHaveLength(1);
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.variables).toEqual({ query: 'title:"Texas Shirt"', first: 20 });
  });

  it('maps colors only from direct variant image associations', async () => {
    const image = { id: 'gid://shopify/ProductImage/10', url: 'https://cdn.shopify.com/image.png', altText: 'Black shirt', width: 100, height: 100 };
    const product = {
      id: 'gid://shopify/Product/123', title: 'Shirt', handle: 'shirt', status: 'ACTIVE', images: { nodes: [image] }, media: { nodes: [] },
      variants: { nodes: [
        { id: 'gid://shopify/ProductVariant/1', title: 'Black / M', selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'M' }], image, media: { nodes: [] } },
        { id: 'gid://shopify/ProductVariant/2', title: 'Black / L', selectedOptions: [{ name: 'Color', value: 'Black' }, { name: 'Size', value: 'L' }], image, media: { nodes: [] } }
      ] }
    };
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 })).mockResolvedValueOnce(json({ data: { product } }));
    const detail = await new ShopifyService(config, fetcher as unknown as typeof fetch).getProduct(product.id, false);
    expect(detail.colors).toEqual(['Black']);
    expect(detail.sizes).toEqual(['M', 'L']);
    expect(detail.images[0]).toMatchObject({ association: 'reliable', associatedColors: ['Black'] });
  });

  it('paginates product images, media, and variants', async () => {
    const connection = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
    const variant = (id: number, color: string) => ({ id: `gid://shopify/ProductVariant/${id}`, title: `${color} / M`, selectedOptions: [{ name: 'Color', value: color }], image: null, media: { nodes: [] } });
    const page = (variants: unknown[], hasNextPage: boolean, cursor: string | null) => ({ data: { product: { id: 'gid://shopify/Product/123', title: 'Shirt', handle: 'shirt', status: 'ACTIVE', images: connection([], false, null), media: connection([], false, null), variants: connection(variants, hasNextPage, cursor) } } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(json(page([variant(1, 'Black')], true, 'next')))
      .mockResolvedValueOnce(json(page([variant(2, 'Navy')], false, null)));
    const detail = await new ShopifyService(config, fetcher as unknown as typeof fetch).getProduct('gid://shopify/Product/123', false);
    expect(detail.variants.map((item) => item.color)).toEqual(['Black', 'Navy']);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).variables.variantAfter).toBe('next');
  });

  it('fully paginates publication media, variants, and nested variant media', async () => {
    const connection = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ data: { product: { media: connection([{ id: 'gid://shopify/MediaImage/1' }], true, 'm2') } } }))
      .mockResolvedValueOnce(json({ data: { product: { media: connection([{ id: 'gid://shopify/MediaImage/2' }]) } } }))
      .mockResolvedValueOnce(json({ data: { product: { variants: connection([{ id: 'gid://shopify/ProductVariant/1', selectedOptions: [{ name: 'Color', value: 'Black' }] }], true, 'v2') } } }))
      .mockResolvedValueOnce(json({ data: { product: { variants: connection([{ id: 'gid://shopify/ProductVariant/2', selectedOptions: [{ name: 'Color', value: 'Navy' }] }]) } } }))
      .mockResolvedValueOnce(json({ data: { node: { media: connection([{ id: 'gid://shopify/MediaImage/1' }], true, 'vm2') } } }))
      .mockResolvedValueOnce(json({ data: { node: { media: connection([{ id: 'gid://shopify/MediaImage/2' }]) } } }))
      .mockResolvedValueOnce(json({ data: { node: { media: connection([]) } } }));
    const state = await new ShopifyService(config, fetcher as unknown as typeof fetch).getPublicationState('gid://shopify/Product/123');
    expect(state).toMatchObject({ complete: true, mediaIds: ['gid://shopify/MediaImage/1', 'gid://shopify/MediaImage/2'] });
    expect(state.variants[0].mediaIds).toEqual(['gid://shopify/MediaImage/1', 'gid://shopify/MediaImage/2']);
    expect(JSON.parse(fetcher.mock.calls[6][1].body).variables.after).toBe('vm2');
  });

  it('fails safely when a publication cursor cannot advance', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ data: { product: { media: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }));
    await expect(new ShopifyService(config, fetcher as unknown as typeof fetch).getPublicationState('gid://shopify/Product/123')).rejects.toMatchObject({ code: 'INCOMPLETE_SNAPSHOT' });
  });

  it('refreshes an expired token once after a 401', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'old', expires_in: 3600 }))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'new', expires_in: 3600 }))
      .mockResolvedValueOnce(json({ data: { products: { nodes: [] } } }));
    await new ShopifyService(config, fetcher as unknown as typeof fetch).searchProducts('shirt');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retries a throttled HTTP response once', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(json({}, 429, { 'Retry-After': '0.01' }))
      .mockResolvedValueOnce(json({ data: { products: { nodes: [] } } }));
    await expect(new ShopifyService(config, fetcher as unknown as typeof fetch).searchProducts('shirt')).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects untrusted image hosts before making a request', async () => {
    const fetcher = vi.fn();
    const service = new ShopifyService(config, fetcher as unknown as typeof fetch);
    await expect(service.downloadImage('http://127.0.0.1/private.png')).rejects.toBeInstanceOf(ShopifyError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized image downloads from trusted hosts', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('x', { headers: { 'Content-Length': '1000' } }));
    const service = new ShopifyService(config, fetcher as unknown as typeof fetch, 100);
    await expect(service.downloadImage('https://cdn.shopify.com/image.png')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
  });
});
