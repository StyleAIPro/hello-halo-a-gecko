/**
 * useImageAttachments - Image paste/drop/file-input handling
 *
 * Manages the complete image attachment lifecycle:
 * validation, compression, adding/removing images,
 * paste/drop/file-input handling, loading state, and error display.
 */

import { useState, useEffect, useCallback, useRef, type ClipboardEvent, type DragEvent } from 'react'
import { processImage, isValidImageType, formatFileSize } from '../utils/imageProcessor'
import type { ImageAttachment } from '../types'
import { useTranslation } from '../i18n'

const MAX_IMAGE_SIZE = 20 * 1024 * 1024  // 20MB max per image (before compression)
export const MAX_IMAGES = 10

interface ImageError {
  id: string
  message: string
}

interface UseImageAttachmentsOptions {
  onImagesChange?: (images: ImageAttachment[]) => void
}

interface UseImageAttachmentsResult {
  images: ImageAttachment[]
  isDragOver: boolean
  isProcessingImages: boolean
  imageError: ImageError | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  addImages: (files: File[]) => Promise<void>
  removeImage: (id: string) => void
  handlePaste: (e: ClipboardEvent) => Promise<void>
  handleDragOver: (e: DragEvent) => void
  handleDragLeave: (e: DragEvent) => void
  handleDrop: (e: DragEvent) => Promise<void>
  handleFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  clearImages: () => void
  hasImages: boolean
}

export function useImageAttachments(_options?: UseImageAttachmentsOptions): UseImageAttachmentsResult {
  const { t } = useTranslation()
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  const [imageError, setImageError] = useState<ImageError | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto-clear error after 3 seconds
  useEffect(() => {
    if (imageError) {
      const timer = setTimeout(() => setImageError(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [imageError])

  const showError = (message: string) => {
    setImageError({ id: `err-${Date.now()}`, message })
  }

  // Process file to ImageAttachment with compression
  const processFileWithCompression = async (file: File): Promise<ImageAttachment | null> => {
    if (!isValidImageType(file)) {
      showError(t('Unsupported image format: {{type}}', { type: file.type || t('Unknown') }))
      return null
    }

    if (file.size > MAX_IMAGE_SIZE) {
      showError(t('Image too large ({{size}}), max 20MB', { size: formatFileSize(file.size) }))
      return null
    }

    try {
      const processed = await processImage(file)
      return {
        id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'image',
        mediaType: processed.mediaType,
        data: processed.data,
        name: file.name,
        size: processed.compressedSize
      }
    } catch (error) {
      console.error(`Failed to process image: ${file.name}`, error)
      showError(t('Failed to process image: {{name}}', { name: file.name }))
      return null
    }
  }

  // Add images (with limit check and loading state)
  const addImages = useCallback(async (files: File[]) => {
    const remainingSlots = MAX_IMAGES - images.length
    if (remainingSlots <= 0) return

    const filesToProcess = files.slice(0, remainingSlots)
    setIsProcessingImages(true)

    try {
      const newImages = await Promise.all(filesToProcess.map(processFileWithCompression))
      const validImages = newImages.filter((img): img is ImageAttachment => img !== null)

      if (validImages.length > 0) {
        setImages(prev => [...prev, ...validImages])
      }
    } finally {
      setIsProcessingImages(false)
    }
  }, [images.length, processFileWithCompression, t])

  const removeImage = useCallback((id: string) => {
    setImages(prev => prev.filter(img => img.id !== id))
  }, [])

  const clearImages = useCallback(() => {
    setImages([])
  }, [])

  // Handle paste event
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    const imageFiles: File[] = []
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault()
      await addImages(imageFiles)
    }
  }, [addImages])

  // Handle drag events
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (!isDragOver) setIsDragOver(true)
  }, [isDragOver])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    const files = Array.from(e.dataTransfer.files).filter(file => isValidImageType(file))
    if (files.length > 0) {
      await addImages(files)
    }
  }, [addImages])

  // Handle file input change
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      await addImages(files)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [addImages])

  return {
    images,
    isDragOver,
    isProcessingImages,
    imageError,
    fileInputRef,
    addImages,
    removeImage,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileInputChange,
    clearImages,
    hasImages: images.length > 0
  }
}
