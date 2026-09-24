import type { NextConfig } from 'next';

// Every page is a client-rendered experience over static media: export a static site.
const nextConfig: NextConfig = { output: 'export', trailingSlash: true, images: { unoptimized: true } };

export default nextConfig;
