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
  sourceAsset?: ImageAsset;
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

export type PublicationStatus = 'validated' | 'publishing' | 'published' | 'partial' | 'rolling_back' | 'rolled_back' | 'rolled_back_files_retained' | 'rollback_partial' | 'conflict' | 'abandoned';

export interface RollbackFinalizationEvidence {
  verifiedAt: string;
  finalizedAt?: string;
  operationId: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  snapshotComplete: true;
  originalMediaIdsVerified: string[];
  originalVariantAssociationsVerified: Array<{ variantId: string; mediaIds: string[] }>;
  retainedGeneratedMediaIds: string[];
  retainedFileConflicts: string[];
  retainedFileOutcomes?: GeneratedFileCleanupOutcome[];
  cleanupReason: 'global_file_deletion_ownership_unproven';
  previousStatus?: 'conflict';
  newStatus?: 'rolled_back_files_retained';
  confirmation?: string;
}

export type GeneratedFileCleanupOutcome =
  | { kind: 'deleted_safely'; mediaId: string; recordedAt: string; ownershipProof: 'exclusive_operation_ownership' }
  | { kind: 'retained_ownership_unproven'; mediaId: string; recordedAt: string; reasonCode: 'global_references_unverifiable'; reason: string }
  | { kind: 'cleanup_failed'; mediaId: string; recordedAt: string; phase: 'ownership_verification' | 'reference_removal'; reason: string }
  | { kind: 'cleanup_outcome_uncertain'; mediaId: string; recordedAt: string; phase: 'file_delete'; reason: string };

export type PublicationConflictKind = 'retained_file_ownership_unproven' | 'cleanup_failed' | 'cleanup_outcome_uncertain' | 'uncertain_file_creation' | 'restoration_mismatch' | 'external_state_conflict';

export interface RollbackFinalizationReadiness {
  eligible: boolean;
  operationId: string;
  productId: string;
  retainedFileCount: number;
  errors: string[];
  evidence?: RollbackFinalizationEvidence;
}

export interface AbandonmentEvidence {
  verifiedAt: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  mediaIds: string[];
  variantAssociations: Array<{ variantId: string; mediaIds: string[] }>;
  generatedMediaIdsChecked: string[];
  snapshotComplete: true;
}

export interface AbandonReadiness {
  eligible: boolean;
  operationId: string;
  productId: string;
  errors: string[];
  evidence?: AbandonmentEvidence;
  alreadyAbandoned?: boolean;
}

export interface PublicationItem {
  color: string;
  previewId: string;
  variantIds: string[];
  createdMediaId?: string;
  stagedResourceUrl?: string;
  intent?: 'stage_upload' | 'create_file' | 'add_product_reference' | 'append_variants' | 'replace_variants' | 'remove_original_reference' | 'restore_original_reference' | 'restore_variants' | 'reorder_published' | 'detach_variants' | 'remove_product_reference' | 'delete_file' | 'restore_order';
  uncertainCreation?: boolean;
  cleanupPending?: boolean;
  cleanupDisposition?: 'retained_manual_ownership_review';
  cleanupOutcome?: GeneratedFileCleanupOutcome;
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
  publicationMode?: 'append_originals' | 'replace_gallery';
  predecessorOperationId?: string;
  originalMediaOrder: string[];
  originalVariantMedia: Array<{ variantId: string; mediaIds: string[] }>;
  expectedPublishedMediaOrder: string[];
  items: PublicationItem[];
  completedSteps: string[];
  errors: string[];
  productRestored?: boolean;
  cleanupConflicts?: string[];
  conflictKinds?: PublicationConflictKind[];
  abandonedAt?: string;
  abandonmentReason?: string;
  abandonmentEvidence?: AbandonmentEvidence;
  rollbackFinalizedAt?: string;
  rollbackFinalizationEvidence?: RollbackFinalizationEvidence;
}

export interface PublishReadiness {
  ready: boolean;
  batchId: string;
  productId: string;
  imageCount: number;
  variantCount: number;
  currentGalleryImageCount: number;
  expectedFinalGalleryImageCount: number;
  confirmationText: string;
  replacesGallery: boolean;
  colors: Array<{ color: string; variantCount: number; previewId: string }>;
  errors: string[];
}

export interface RecoveryReadiness {
  eligible: boolean;
  operationId: string;
  batchId: string;
  productId: string;
  imageCount: number;
  variantCount: number;
  orderingComplete: boolean;
  errors: string[];
}
