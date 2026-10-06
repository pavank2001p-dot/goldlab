import type { NextConfig } from "next";

// The browser only ever talks to this site; /api/* is proxied to the FastAPI service,
// so the session cookie stays first-party.
const API_URL = process.env.API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default nextConfig;
