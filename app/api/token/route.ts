import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export const runtime = "nodejs";

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const room = (url.searchParams.get("room") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();

    if (!room || !name) {
      return NextResponse.json(
        { error: "Missing room or name." },
        { status: 400 }
      );
    }

    const LIVEKIT_URL = getEnv("LIVEKIT_URL");
    const LIVEKIT_API_KEY = getEnv("LIVEKIT_API_KEY");
    const LIVEKIT_API_SECRET = getEnv("LIVEKIT_API_SECRET");

    const at = new AccessToken(
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      {
        identity: name,
        ttl: "6h"
      }
    );

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await at.toJwt();

    return NextResponse.json({
      token,
      url: LIVEKIT_URL
    });

  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Token error" },
      { status: 500 }
    );
  }
}
