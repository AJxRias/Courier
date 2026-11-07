import { jwtVerify, SignJWT, errors } from "jose";

export interface Principal {
  userId: string;
  username: string;
  /** Token expiry, epoch seconds. Sockets are closed when it passes. */
  exp: number;
}

export class Auth {
  private key: Uint8Array;

  constructor(secret: string, private ttlSec: number) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(userId: string, username: string, ttlSec = this.ttlSec): Promise<string> {
    return new SignJWT({ name: username })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setIssuer("courier")
      .setAudience("courier")
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
      .sign(this.key);
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ["HS256"],
      issuer: "courier",
      audience: "courier",
    });
    if (!payload.sub || typeof payload.name !== "string" || !payload.exp) {
      throw new errors.JWTInvalid("missing claims");
    }
    return { userId: payload.sub, username: payload.name, exp: payload.exp };
  }

  /** Pulls a bearer token out of an Authorization header. */
  static bearer(header: string | undefined): string | null {
    const m = header?.match(/^Bearer\s+(.+)$/i);
    return m?.[1] ?? null;
  }
}
