import { OAuth2Client } from "google-auth-library";

export type GoogleIdTokenPayload = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
};

export function getGoogleOAuthClientId(): string | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  return id || null;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload | null> {
  const clientId = getGoogleOAuthClientId();
  if (!clientId) return null;

  const client = new OAuth2Client(clientId);
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub) return null;
    return {
      sub: payload.sub,
      email: payload.email,
      email_verified: payload.email_verified,
      name: payload.name,
    };
  } catch (err) {
    console.warn("[Google Auth] ID token verification failed:", err);
    return null;
  }
}
