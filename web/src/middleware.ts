import { NextResponse, type NextRequest } from "next/server";

// Cheap gate for signed-in pages; the API still verifies the session on every call.
export function middleware(req: NextRequest) {
  if (!req.cookies.has("gl_session")) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
}

export const config = { matcher: ["/account/:path*"] };
