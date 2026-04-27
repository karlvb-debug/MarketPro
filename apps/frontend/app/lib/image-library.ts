// ============================================
// Image Library — Local image upload & storage
// Stores images as base64 data URLs in localStorage.
// In production, these would upload to S3/CDN.
// ============================================

const STORAGE_KEY = 'clq-image-library';

export interface LibraryImage {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  size: number; // bytes
  uploadedAt: string;
}

/** Load all images from the library */
export function loadImageLibrary(): LibraryImage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

/** Save images to the library */
function saveImageLibrary(images: LibraryImage[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(images));
}

/** Add an image to the library */
export function addImageToLibrary(image: LibraryImage) {
  const images = loadImageLibrary();
  images.unshift(image); // newest first
  saveImageLibrary(images);
}

/** Remove an image from the library */
export function removeImageFromLibrary(id: string) {
  const images = loadImageLibrary().filter((img) => img.id !== id);
  saveImageLibrary(images);
}

/** Convert a File to a base64 data URL + metadata */
export function fileToLibraryImage(file: File): Promise<LibraryImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File is not an image'));
      return;
    }

    // 5MB limit for localStorage safety
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('Image must be under 5MB'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;

      // Get dimensions
      const img = new Image();
      img.onload = () => {
        resolve({
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          dataUrl,
          width: img.width,
          height: img.height,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        });
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** Format file size for display */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
