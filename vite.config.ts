import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";


const plugins = [
  react(),
  tailwindcss(),
  jsxLocPlugin(),
  VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['favicon.ico', 'icons/*.png', 'screenshots/*.png'],
    manifest: {
      name: 'VPP Consumer Platform',
      short_name: 'VPP Platform',
      description: 'Virtual Power Plant consumer platform for managing solar energy assets, trading, and payments',
      theme_color: '#10b981',
      background_color: '#d4f1e8',
      display: 'standalone',
      orientation: 'portrait-primary',
      scope: '/',
      start_url: '/',
      icons: [
        {
          src: '/icons/icon-72x72.png',
          sizes: '72x72',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-96x96.png',
          sizes: '96x96',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-128x128.png',
          sizes: '128x128',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-144x144.png',
          sizes: '144x144',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-152x152.png',
          sizes: '152x152',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-384x384.png',
          sizes: '384x384',
          type: 'image/png',
          purpose: 'any maskable'
        },
        {
          src: '/icons/icon-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable'
        }
      ],
      categories: ['energy', 'utilities', 'finance'],
      shortcuts: [
        {
          name: 'Dashboard',
          short_name: 'Home',
          description: 'View your energy dashboard',
          url: '/',
          icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }]
        },
        {
          name: 'Assets',
          short_name: 'Assets',
          description: 'Manage your energy assets',
          url: '/assets',
          icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }]
        },
        {
          name: 'Trading',
          short_name: 'Trade',
          description: 'Energy trading marketplace',
          url: '/trading',
          icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }]
        },
        {
          name: 'Payments',
          short_name: 'Pay',
          description: 'Make payments and view billing',
          url: '/payments',
          icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }]
        }
      ]
    },
    workbox: {
      maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MB
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
      runtimeCaching: [
        {
          urlPattern: /^https:\/\/api\..*/i,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'api-cache',
            expiration: {
              maxEntries: 100,
              maxAgeSeconds: 60 * 60 * 24 // 24 hours
            },
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        },
        {
          urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
          handler: 'CacheFirst',
          options: {
            cacheName: 'google-fonts-cache',
            expiration: {
              maxEntries: 10,
              maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
            },
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        },
        {
          urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
          handler: 'CacheFirst',
          options: {
            cacheName: 'images-cache',
            expiration: {
              maxEntries: 60,
              maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
            }
          }
        }
      ],
      cleanupOutdatedCaches: true,
      skipWaiting: true,
      clientsClaim: true
    },
    devOptions: {
      enabled: true,
      type: 'module'
    }
  })
];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Every dependency group is split out, because a single chunk over
        // `maximumFileSizeToCacheInBytes` fails the service-worker build and
        // `build:client` then produces no deployable PWA at all. One bundle
        // holding all of them was 3.34 MB and did exactly that.
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (id.includes('node_modules/wouter')) return 'router';
          if (id.includes('node_modules/@trpc')) return 'trpc';
          if (id.includes('node_modules/@tanstack')) return 'query';
          if (id.includes('node_modules/@radix-ui')) return 'radix';
          if (id.includes('node_modules/lucide-react')) return 'ui';
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'charts';
          if (id.includes('node_modules/framer-motion')) return 'motion';
          if (id.includes('node_modules/react-hook-form') || id.includes('node_modules/zod')) return 'forms';
          if (
            id.includes('node_modules/html5-qrcode') ||
            id.includes('node_modules/qrcode') ||
            id.includes('node_modules/canvas-confetti')
          ) {
            return 'media';
          }
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          return 'vendor';
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: true,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
