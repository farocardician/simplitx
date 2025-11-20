/** @type {import('next').NextConfig} */
const nextConfig = {
  // Remove standalone for now - let's get basic build working first
  experimental: {
    // Increase body size limit to 100MB for file uploads
    serverActions: {
      bodySizeLimit: '100mb',
    },
  },
}

module.exports = nextConfig