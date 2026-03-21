import { type Express } from "express";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );

      // DEV ONLY: Strip Shopify App Bridge from storefront routes (/s/designer etc.)
      //
      // App Bridge detects the shopify-api-key meta tag and causes Shopify's CDN to
      // redirect any browser to accounts.shopify.com — even in incognito mode.
      // The storefront designer uses the public storefront API and does NOT need
      // App Bridge, so it's safe to remove it for these routes in development.
      // Production is unaffected: this file is only used when NODE_ENV=development.
      const isStorefrontRoute = url.startsWith("/s/") || url.split("?")[0] === "/s/designer";
      if (isStorefrontRoute) {
        template = template
          .replace(/<meta name="shopify-api-key"[^>]*>\s*/g, "")
          .replace(/<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>\s*/g, "");
      }

      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
