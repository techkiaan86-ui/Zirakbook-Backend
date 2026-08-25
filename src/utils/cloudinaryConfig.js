require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
const api_key = process.env.CLOUDINARY_API_KEY;
const api_secret = process.env.CLOUDINARY_API_SECRET;

const isConfigured = Boolean(cloud_name && api_key && api_secret &&
    cloud_name !== 'your_cloud_name' &&
    api_key !== 'your_api_key' &&
    api_secret !== 'your_api_secret');

if (!isConfigured) {
    console.warn('--- WARNING: Cloudinary is not configured correctly. Uploads will fallback to Base64. ---');
}

cloudinary.config({
    cloud_name: isConfigured ? cloud_name : 'placeholder',
    api_key: isConfigured ? api_key : 'placeholder',
    api_secret: isConfigured ? api_secret : 'placeholder',
});

// Memory storage keeps file buffers accessible for direct Cloudinary upload or Base64 fallback
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/**
 * Helper function to upload a file (from req.file or req.files field) to Cloudinary,
 * or fallback to base64 Data URI if Cloudinary is not configured or fails.
 */
const uploadToCloudinaryOrBase64 = async (file, folder = 'company_logos') => {
    if (!file) return null;

    if (typeof file === 'string') return file;
    if (file.secure_url) return file.secure_url;
    if (file.url) return file.url;

    if (file.buffer) {
        if (isConfigured) {
            try {
                const base64Data = file.buffer.toString('base64');
                const dataUri = `data:${file.mimetype || 'image/png'};base64,${base64Data}`;
                const result = await cloudinary.uploader.upload(dataUri, {
                    folder: folder,
                    resource_type: 'auto',
                    use_filename: true,
                    unique_filename: true
                });
                return result.secure_url || result.url;
            } catch (err) {
                console.error('Cloudinary upload error:', err);
                return `data:${file.mimetype || 'image/png'};base64,${file.buffer.toString('base64')}`;
            }
        } else {
            return `data:${file.mimetype || 'image/png'};base64,${file.buffer.toString('base64')}`;
        }
    }

    if (file.path && typeof file.path === 'string' && file.path.startsWith('http')) {
        return file.path;
    }

    return null;
};

module.exports = {
    cloudinary,
    upload,
    isCloudinaryConfigured: isConfigured,
    uploadToCloudinaryOrBase64
};