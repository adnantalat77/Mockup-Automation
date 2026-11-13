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

export type BatchItemStatus = 'queued' | 'processing' | 'success' | 'skipped' | 'failed' | 'cancelled';
export type BatchStatus = 'running' | 'completed' | 'partial' | 'cancelled';

export interface MockupBatchItem {
  color: string;
  sourceImageId?: string;
  status: BatchItemStatus;
  reason?: string;
  attempts: number;
  preview?: ImageAsset;
}

export interface MockupBatch {
  id: string;
  productId: string;
  productTitle: string;
  backgroundId: string;
  status: BatchStatus;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  items: MockupBatchItem[];
  counts: { total: number; queued: number; processing: number; success: number; failed: number; skipped: number; cancelled: number };
}

export type PublicationStatus = 'validated' | 'publishing' | 'published' | 'partial' | 'rolling_back' | 'rolled_back' | 'rollback_partial' | 'conflict';

export interface PublicationItem {
  color: string;
  previewId: string;
  variantIds: string[];
  createdMediaId?: string;
  status: 'pending' | 'uploaded' | 'associated' | 'failed' | 'rolled_back';
  error?: string;
}

export interface PublicationOperation {
  id: string;
  version: 1;
  batchId: string;
  productId: string;
  productTitle: string;
  createdAt: string;
  updatedAt: string;
  status: PublicationStatus;
  originalMediaOrder: string[];
  originalVariantMedia: Array<{ variantId: string; mediaIds: string[] }>;
  items: PublicationItem[];
  completedSteps: string[];
  errors: string[];
}

export interface PublishReadiness {
  ready: boolean;
  batchId: string;
  productId: string;
  imageCount: number;
  variantCount: number;
  colors: Array<{ color: string; variantCount: number; previewId: string }>;
  errors: string[];
}
