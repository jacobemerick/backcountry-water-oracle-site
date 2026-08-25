import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        // /forecast was a ranked table of every source, retired in #38. It is a
        // permanent 308 rather than a 404 because the URL was shared, and
        // landing on the front door beats landing on nothing.
        source: "/forecast",
        destination: "/",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
