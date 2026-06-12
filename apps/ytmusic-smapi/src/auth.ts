import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { Innertube } from "youtubei.js";

// Mirror of youtubei.js OAuth2Tokens — not exported from the package's public surface.
type OAuth2Tokens = {
  access_token: string;
  expiry_date: string;
  expires_in?: number;
  refresh_token: string;
  scope?: string;
  token_type?: string;
  client?: { client_id: string; client_secret: string };
};

const CRED_PATH = process.env.YTMUSIC_CREDENTIALS_PATH ?? `${homedir()}/.misonos/ytmusic.json`;

export type AuthStatus =
  | { state: "signed-out" }
  | { state: "pending"; verificationUrl: string; userCode: string; expiresAt: number }
  | { state: "signed-in" };

let status: AuthStatus = { state: "signed-out" };
let listenersAttached = false;
let signInInFlight = false;

export function currentStatus(): AuthStatus {
  return status;
}

async function persist(credentials: OAuth2Tokens): Promise<void> {
  await mkdir(dirname(CRED_PATH), { recursive: true });
  await writeFile(CRED_PATH, JSON.stringify(credentials, null, 2), "utf8");
}

async function readSaved(): Promise<OAuth2Tokens | null> {
  try {
    const data = await readFile(CRED_PATH, "utf8");
    if (!data.trim()) return null;
    return JSON.parse(data) as OAuth2Tokens;
  } catch {
    return null;
  }
}

function attachListeners(yt: Innertube): void {
  if (listenersAttached) return;
  listenersAttached = true;
  yt.session.on("auth-pending", (data) => {
    status = {
      state: "pending",
      verificationUrl: data.verification_url,
      userCode: data.user_code,
      expiresAt: Date.now() + data.expires_in * 1000
    };
  });
  yt.session.on("auth", ({ credentials }) => {
    status = { state: "signed-in" };
    void persist(credentials);
  });
  yt.session.on("update-credentials", ({ credentials }) => {
    void persist(credentials);
  });
  yt.session.on("auth-error", (err) => {
    console.warn("[ytmusic] auth error:", err);
    status = { state: "signed-out" };
  });
}

export async function tryRestore(yt: Innertube): Promise<void> {
  attachListeners(yt);
  const saved = await readSaved();
  if (!saved) return;
  try {
    await yt.session.signIn(saved);
    status = { state: "signed-in" };
    console.log("[ytmusic] restored saved session");
  } catch (error) {
    console.warn("[ytmusic] failed to restore session:", error instanceof Error ? error.message : error);
    status = { state: "signed-out" };
  }
}

export function startSignIn(yt: Innertube): AuthStatus {
  attachListeners(yt);
  if (status.state === "signed-in") return status;
  if (signInInFlight) return status;
  signInInFlight = true;
  // signIn() resolves only after the user enters the code; fire-and-forget so we
  // return immediately. The client polls /auth/status to pick up the code.
  void yt.session
    .signIn()
    .catch((error) => {
      console.warn("[ytmusic] signIn error:", error instanceof Error ? error.message : error);
      status = { state: "signed-out" };
    })
    .finally(() => {
      signInInFlight = false;
    });
  return status;
}

export async function signOut(yt: Innertube): Promise<void> {
  try {
    await yt.session.signOut();
  } catch {
    // ignore
  }
  status = { state: "signed-out" };
  try {
    await rm(CRED_PATH, { force: true });
  } catch {
    // ignore
  }
}
