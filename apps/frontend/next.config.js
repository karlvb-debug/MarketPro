/** @type {import('next').NextConfig} */
const nextConfig = {
  // @repo/core ships TypeScript source (no build step), so Next must compile it.
  transpilePackages: ['@repo/core'],
};

export default nextConfig;
