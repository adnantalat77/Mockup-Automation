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
