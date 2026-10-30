import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE, GATE_PAGE, gateToken, isOpenPath, passwordMatches } from "./src/gate.mjs";

// The "coming soon" gate in front of every page (src/gate.mjs). Off when MAISTRO_GATE_PASSWORD is unset.
export async function middleware(req: NextRequest) {
  const password = process.env.MAISTRO_GATE_PASSWORD;
  if (!password) return NextResponse.next();
  const secret = process.env.MAISTRO_SESSION_SECRET || "";
  const { pathname } = req.nextUrl;
  const home = req.nextUrl.clone();
  home.pathname = "/";
  home.search = "";

  if (pathname === "/gate") {
    if (req.method !== "POST") return NextResponse.redirect(home, 303);
    const form = await req.formData().catch(() => null);
    const given = String(form?.get("password") ?? "");
    if (!(await passwordMatches(given, password))) {
      await new Promise((r) => setTimeout(r, 600)); // slows guessing a little
      home.search = "?denied=1";
      return NextResponse.redirect(home, 303);
    }
    const res = NextResponse.redirect(home, 303);
    res.cookies.set(GATE_COOKIE, await gateToken(secret, password), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: GATE_MAX_AGE });
    return res;
  }

  if (isOpenPath(pathname)) return NextResponse.next();
  if (req.cookies.get(GATE_COOKIE)?.value === (await gateToken(secret, password))) return NextResponse.next();
  const page = req.nextUrl.clone();
  page.pathname = GATE_PAGE;
  const res = NextResponse.rewrite(page);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
