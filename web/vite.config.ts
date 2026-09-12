import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Opt-in, set ONLY by .devcontainer/devcontainer.json (containerEnv).
//
// Vite's dev server answers 403 "Blocked request" to any request whose Host
// header isn't localhost — a DNS-rebinding defence, and exactly the right
// default for an app whose /api/run executes arbitrary code. In a Codespace
// the browser reaches this server through GitHub's per-user proxy, so every
// Host header is "<codespace>-5173.app.github.dev" and, without this opt-in,
// the whole app 403s.
//
// Setting it widens the dev server to the codespace forwarding domain and
// binds it to every interface *inside the container*. That is safe there: the
// container is disposable, belongs to one reviewer, and only GitHub's
// authenticated port-forwarding proxy can reach it. It must never be set on a
// personal machine — see the same note in .devcontainer/README.md.
const remote = process.env.PT_ALLOW_REMOTE_HOST === "1";

// Normally "app.github.dev"; GitHub Enterprise codespaces use their own
// domain and publish it here.
const forwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
const allowedHosts = [...new Set([".app.github.dev", ...(forwardingDomain ? [`.${forwardingDomain}`] : [])])];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Default (no opt-in): localhost-bound, localhost-only Host header —
    // unchanged for every real install.
    ...(remote ? { host: true, allowedHosts } : {}),
    proxy: {
      // changeOrigin is load-bearing, not decoration: it rewrites the Host
      // header to "127.0.0.1:4517" on the hop to the API server, whose own
      // guard (server/src/index.ts) accepts loopback names only. Behind the
      // Codespaces proxy the inbound Host is "<codespace>-5173.app.github.dev",
      // which the API would reject with 403 — so every /api call would fail.
      // Vite's string-shorthand proxy form defaults this to true today;
      // spelling it out means a Vite upgrade can't quietly break the app.
      // 127.0.0.1, because the API binds IPv4 only and a "localhost" target
      // can try ::1 first and eat a timeout on every cold socket.
      "/api": { target: "http://127.0.0.1:4517", changeOrigin: true },
    },
  },
});
