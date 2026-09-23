import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "jev-browser-use",
    description: "Connect your Chrome profile to jev-browser-use for Jev and Puppeteer automation",
    permissions: ["debugger", "tabGroups", "storage"],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
});
