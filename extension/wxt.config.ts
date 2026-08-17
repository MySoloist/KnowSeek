import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  vite: () => ({
    build: {
      minify: 'esbuild' as const,
    },
    optimizeDeps: {
      include: ['katex', 'marked-katex-extension'],
    },
  }),
  manifest: {
    name: "知寻",
    version: "1.0.0",
    description: "在网页上高亮文本、添加笔记、管理标签，轻松记录和整理你的阅读笔记。",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv8Snw1fYa4iITNu9RfDD6JdUez5zrz8172lvi5eBlxwNpqa+sFxwLs4q9YpW4q7p63RWecfO4zxEbwS8/7FWiT7gj8J2WlCK/AzthUSN054Dwp+4/gQHS+3wc36Kp2bZ65GxmUGkmy/idTxFjrRDZ0zMhy7TO+r4a0rD2U5r3PDlBqtFBk3R/PkrW/dsT08S9ldEuPegoXEtulzDpgNONSIDTS5pl9GBIKEOPPvUGwo6L6GUM24IWsDEdJz0P1+0zTv/F7AO4i9aKzRHIsXiHFjBKjYSbTa6VEN6+AjP3Pgjz6KOcIgECzJR+AnOPoH8eA7nxxR3yMfeRmIWvnTJ1QIDAQAB",
    permissions: [
      "storage",
      "activeTab",
      "tabs",
      "scripting",
      "sidePanel",
      "contextMenus",
      "alarms",
      "webRequest",
      "cookies"
    ],
    host_permissions: ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*"],
    action: {
      default_title: "知寻",
      default_icon: {
        "16": "icons/icon128.png",
        "48": "icons/icon128.png",
        "128": "icons/icon128.png"
      }
    },
    side_panel: {
      default_path: "sidebar.html"
    },
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["src/content/content-hook.js"],
        run_at: "document_start",
        world: "MAIN"
      }
    ],
    icons: {
      "16": "icons/icon128.png",
      "48": "icons/icon128.png",
      "128": "icons/icon128.png"
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src * data: blob:"
    },
    web_accessible_resources: [
      {
        resources: [
          "images/*",
          "icons/*"
        ],
        matches: ["<all_urls>"]
      }
    ]
  }
});