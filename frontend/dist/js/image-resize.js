// image-resize.js — shared client-side image resize + WebP conversion utility.
// No new dependencies — uses the browser's native Canvas API.
//
// Used by logo upload (project-page.js) + avatar upload (settings-page.js).
// Reduces 3.5MB 4K photos to ~100KB before upload (no server-side image tooling needed).
//
// Exposed via window.hibanaImageResize.

window.hibanaImageResize = (() => {
  /**
   * Decode a File into an HTMLImageElement (via createObjectURL — faster than FileReader for large files).
   * @param {File} file
   * @returns {Promise<HTMLImageElement>}
   */
  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => { URL.revokeObjectURL(img.src); resolve(img) }
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('decode failed')) }
      img.src = URL.createObjectURL(file)
    })
  }

  /**
   * Resize an image to fit within maxDim×maxDim (maintains aspect ratio, never upscales).
   * Returns a canvas with the resized image.
   * @param {HTMLImageElement} img
   * @param {number} maxDim — max width/height (default 512)
   * @returns {HTMLCanvasElement}
   */
  function resizeToCanvas(img, maxDim = 512) {
    let { width, height } = img
    // Never upscale — only downscale if the image exceeds maxDim
    if (width <= maxDim && height <= maxDim) {
      maxDim = Math.max(width, height)
    }
    // Maintain aspect ratio
    if (width > height) {
      height = Math.round((height / width) * maxDim)
      width = maxDim
    } else {
      width = Math.round((width / height) * maxDim)
      height = maxDim
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, width, height)
    return canvas
  }

  /**
   * Resize a File to fit within maxDim×maxDim + convert to WebP (quality 0.85).
   * Returns base64 string (no data: prefix).
   * Falls back to PNG if WebP isn't supported by the browser.
   *
   * @param {File} file — the uploaded image file
   * @param {object} opts — { maxDim: 512, quality: 0.85, mimeType: 'image/webp' }
   * @returns {Promise<{ dataBase64: string, mimeType: string }>}
   */
  async function resizeAndEncode(file, opts = {}) {
    const { maxDim = 512, quality = 0.85, mimeType = 'image/webp' } = opts
    const img = await decodeImage(file)
    const canvas = resizeToCanvas(img, maxDim)
    // Try WebP first (30-50% smaller than PNG/JPEG)
    let dataUrl
    let finalMime = mimeType
    try {
      dataUrl = canvas.toDataURL(mimeType, quality)
      // Some browsers silently fall back to PNG if WebP isn't supported — check the MIME
      if (!dataUrl.startsWith('data:' + mimeType)) {
        finalMime = 'image/png'
        dataUrl = canvas.toDataURL('image/png')
      }
    } catch {
      // WebP not supported — fall back to PNG
      finalMime = 'image/png'
      dataUrl = canvas.toDataURL('image/png')
    }
    return {
      dataBase64: dataUrl.split(',')[1],
      mimeType: finalMime,
    }
  }

  /**
   * Crop + resize to a centered square (for avatars/logos that need a square format).
   * @param {File} file
   * @param {number} size — square dimension (default 256)
   * @param {object} opts — { mimeType: 'image/webp', quality: 0.85 }
   * @returns {Promise<{ dataBase64: string, mimeType: string }>}
   */
  async function resizeSquare(file, size = 256, opts = {}) {
    const { mimeType = 'image/webp', quality = 0.85 } = opts
    const img = await decodeImage(file)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const s = Math.min(img.width, img.height)
    // cover-fit: crop to the largest centered square, then downscale to size
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size)
    let dataUrl
    let finalMime = mimeType
    try {
      dataUrl = canvas.toDataURL(mimeType, quality)
      if (!dataUrl.startsWith('data:' + mimeType)) {
        finalMime = 'image/png'
        dataUrl = canvas.toDataURL('image/png')
      }
    } catch {
      finalMime = 'image/png'
      dataUrl = canvas.toDataURL('image/png')
    }
    return {
      dataBase64: dataUrl.split(',')[1],
      mimeType: finalMime,
    }
  }

  return { resizeAndEncode, resizeSquare, decodeImage, resizeToCanvas }
})()
