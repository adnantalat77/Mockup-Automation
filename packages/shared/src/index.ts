export type AssetKind = 'background' | 'garment' | 'preview';

export interface ImageAsset {
  id: string;
  kind: AssetKind;
  originalName: string;
  width: number;
  height: number;
  url: string;
  hasTransparency?: boolean;
}

export interface ApiError { error: string; details?: string }
export interface GenerateRequest { backgroundId: string; garmentId: string }

export interface ShopifyStatus {
  configured: boolean;
  connected: boolean;
  shop?: string;
  scopes: string[];
  error?: string;
}

export interface ShopifyProductSummary {
  id: string;
  title: string;
  handle: string;
  status: string;
  imageUrl?: string;
}

export interface ShopifyVariant {
  id: string;
  title: string;
  selectedOptions: Array<{ name: string; value: string }>;
  color?: string;
  size?: string;
  associatedImageIds: string[];
}

export type ShopifyImageValidation = 'transparent' | 'opaque' | 'unsupported' | 'unavailable';

export interface ShopifyProductImage {
  id: string;
  url: string;
  altText?: string;
  width?: number;
  height?: number;
  associatedColors: string[];
  association: 'reliable' | 'ambiguous' | 'unassociated';
  validation: ShopifyImageValidation;
  validationMessage?: string;
}

export interface ShopifyProductDetail extends ShopifyProductSummary {
  colors: string[];
  sizes: string[];
  variants: ShopifyVariant[];
  images: ShopifyProductImage[];
}
