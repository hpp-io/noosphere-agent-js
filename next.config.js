/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile local @noosphere packages
  transpilePackages: ['@noosphere/crypto', '@noosphere/agent-core', '@noosphere/registry'],

  webpack: (config, { isServer }) => {
    // Handle symlinked packages
    config.resolve.symlinks = true;

    // External packages that should not be bundled
    if (isServer) {
      config.externals.push('pino-pretty', 'lokijs', 'encoding');
    }

    return config;
  },
};

module.exports = nextConfig;
