/**
 * Image Upload Service
 *
 * Handles uploading local images to temporary storage for access by MCP tools
 * that require remote URLs (like analyze_image for non-multimodal models).
 *
 * Strategy:
 * 1. Save images to local uploads directory
 * 2. If remote access is enabled, serve via HTTP server
 * 3. Otherwise use file:// URL (local only)
 */

import { app } from 'electron';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ImageAttachment } from './agent/types';
import { getConfig } from './config.service';
import { getServerInfo } from '../http/server';

// ============================================
// Types
// ============================================

export interface UploadedImage {
  /** The original image ID */
  id: string;
  /** URL that can be accessed remotely */
  url: string;
  /** The media type (e.g., 'image/png') */
  mediaType: string;
}

// ============================================
// Image Upload Service
// ============================================

/**
 * Upload images to make them accessible via URL for MCP tools
 *
 * @param images - Array of image attachments with base64 data
 * @param spaceId - The current space ID for organizing uploads
 * @returns Array of uploaded image info with accessible URLs
 */
export async function uploadImagesForMcp(
  images: ImageAttachment[],
  spaceId: string,
): Promise<UploadedImage[]> {
  if (!images || images.length === 0) {
    return [];
  }

  const results: UploadedImage[] = [];

  for (const image of images) {
    try {
      const url = await uploadSingleImage(image, spaceId);
      results.push({
        id: image.id,
        url,
        mediaType: image.mediaType,
      });
    } catch (error) {
      console.error(`[ImageUpload] Failed to upload image ${image.id}:`, error);
      // Fallback: use data URL (may not work with all MCP tools)
      const dataUrl = `data:${image.mediaType};base64,${image.data}`;
      results.push({
        id: image.id,
        url: dataUrl,
        mediaType: image.mediaType,
      });
    }
  }

  return results;
}

/**
 * Upload a single image and return its accessible URL
 */
async function uploadSingleImage(image: ImageAttachment, spaceId: string): Promise<string> {
  // Create uploads directory in AICO-Bot data dir
  const uploadsDir = join(getUploadsDir(), spaceId);
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  // Generate unique filename
  const ext = getExtensionFromMediaType(image.mediaType);
  const filename = `${randomUUID()}${ext}`;
  const filepath = join(uploadsDir, filename);

  // Decode base64 and write to file
  const buffer = Buffer.from(image.data, 'base64');
  writeFileSync(filepath, buffer);

  console.log(`[ImageUpload] Saved image to: ${filepath}`);

  // Check if HTTP server is running and remote access is enabled
  const config = getConfig();
  const serverInfo = getServerInfo();

  if (config.remoteAccess?.enabled && serverInfo.running && serverInfo.port) {
    // Use HTTP server URL for remote access
    // The HTTP server needs to serve the uploads directory
    const httpUrl = `http://localhost:${serverInfo.port}/api/remote/uploads/${spaceId}/${filename}`;
    console.log(`[ImageUpload] Image accessible at: ${httpUrl}`);
    return httpUrl;
  }

  // Fallback: use file URL (only works locally)
  const fileUrl = `file://${filepath}`;
  console.log(`[ImageUpload] Using local file URL: ${fileUrl}`);
  return fileUrl;
}

/**
 * Get the uploads directory path
 */
function getUploadsDir(): string {
  // Use AICO-Bot data directory
  const spaceDataDir = app.getPath('userData');
  return join(spaceDataDir, 'uploads');
}

/**
 * Get file extension from media type
 */
function getExtensionFromMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.png';
  }
}

/**
 * Clean up old uploaded images (call periodically)
 */
export function cleanupOldUploads(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  const uploadsDir = getUploadsDir();

  if (!existsSync(uploadsDir)) {
    return;
  }

  const now = Date.now();

  // This is a simplified cleanup - in production you'd want to
  // check file modification times and delete old files
  console.log(`[ImageUpload] Cleanup would run on: ${uploadsDir}`);
}

// ============================================
// Export singleton instance for convenience
// ============================================

export const imageUploadService = {
  uploadImagesForMcp,
  cleanupOldUploads,
};
