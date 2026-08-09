import { NextAuthOptions } from 'next-auth';
import { JWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      image?: string;
      isAdmin: boolean;
    };
    accessToken: string;
    sessionToken: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    email: string;
    name: string;
    image?: string;
    isAdmin: boolean;
    accessToken: string;
    sessionToken: string;
  }
}

const authentikProvider = process.env.AUTHENTIK_ISSUER && process.env.AUTHENTIK_CLIENT_ID && process.env.AUTHENTIK_CLIENT_SECRET
  ? [
      {
        id: 'authentik',
        name: 'Authentik',
        type: 'oauth' as const,
        issuer: process.env.AUTHENTIK_ISSUER,
        clientId: process.env.AUTHENTIK_CLIENT_ID!,
        clientSecret: process.env.AUTHENTIK_CLIENT_SECRET!,
        authorization: {
          params: { scope: 'openid email profile' },
        },
        idToken: true,
        checks: ['pkce', 'state'] as ('pkce' | 'state')[],
        profile(profile: Record<string, unknown>) {
          return {
            id: profile.sub as string,
            email: profile.email as string,
            name: (profile.name || profile.preferred_username) as string,
            image: profile.picture as string,
          };
        },
      },
    ]
  : [];

function getServerApiUrl(): string {
  return process.env.API_INTERNAL_URL || 'http://backend:8000/api';
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function getJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// Refresh the backend access token before it expires. The backend token is
// short-lived, but the Redis-backed session (carried by the session token)
// lives 30 days, so we can silently exchange it as long as the session is
// alive. This works even when the access token has already expired.
const REFRESH_BUFFER_SECONDS = 10 * 60;

interface RefreshResult {
  accessToken: string;
  sessionToken: string;
}

async function refreshBackendSession(sessionToken: string): Promise<RefreshResult | null> {
  try {
    const response = await fetch(`${getServerApiUrl()}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_token: sessionToken }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      access_token?: unknown;
      session_token?: unknown;
    };
    if (typeof data.access_token !== 'string') return null;
    return {
      accessToken: data.access_token,
      sessionToken: typeof data.session_token === 'string' ? data.session_token : sessionToken,
    };
  } catch {
    return null;
  }
}

const isSecureCookies = Boolean(process.env.NEXTAUTH_URL?.startsWith('https://'));

export const authOptions: NextAuthOptions = {
  providers: [
    {
      id: 'credentials',
      name: 'Credentials',
      type: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        try {
          const response = await fetch(
            `${getServerApiUrl()}/auth/login`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: credentials.username,
                password: credentials.password,
              }),
            }
          );
          if (!response.ok) return null;
          const data = await response.json();
          return {
            id: data.user_id,
            email: data.email || '',
            name: data.username,
            isAdmin: data.is_admin,
            accessToken: data.access_token,
            sessionToken: data.session_token,
          };
        } catch {
          return null;
        }
      },
    },
    ...authentikProvider,
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name: isSecureCookies ? '__Secure-next-auth.session-token' : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: isSecureCookies,
        maxAge: 30 * 24 * 60 * 60,
      },
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === 'authentik') {
        try {
          const response = await fetch(
            `${getServerApiUrl()}/auth/authentik`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: user.name || '',
                password: account.id_token,
              }),
            }
          );
          if (!response.ok) return false;
          const data = await response.json();
          (account as { access_token?: string; session_token?: string }).access_token =
            data.access_token;
          (account as { access_token?: string; session_token?: string }).session_token =
            data.session_token;
        } catch {
          return false;
        }
      }
      return true;
    },
    async jwt({ token, account, user }) {
      if (account) {
        const authAccount = account as { access_token?: string; session_token?: string };
        if (authAccount.access_token) {
          token.accessToken = authAccount.access_token;
        }
        if (authAccount.session_token) {
          token.sessionToken = authAccount.session_token;
        }
      }
      if (user) {
        const userData = user as {
          id?: string;
          email?: string | null;
          name?: string | null;
          image?: string | null;
          accessToken?: string;
          sessionToken?: string;
          isAdmin?: boolean;
        };
        token.id = userData.id || token.id;
        token.email = userData.email || token.email;
        token.name = userData.name || token.name;
        token.image = userData.image || token.image;
        if (userData.accessToken) {
          token.accessToken = userData.accessToken;
        }
        if (userData.sessionToken) {
          token.sessionToken = userData.sessionToken;
        }
        if (userData.isAdmin !== undefined) {
          token.isAdmin = userData.isAdmin;
        }
      }
      if (token.accessToken && token.sessionToken) {
        const exp = getJwtExpiry(token.accessToken);
        if (exp !== null && exp - Math.floor(Date.now() / 1000) < REFRESH_BUFFER_SECONDS) {
          const refreshed = await refreshBackendSession(token.sessionToken);
          if (refreshed) {
            token.accessToken = refreshed.accessToken;
            token.sessionToken = refreshed.sessionToken;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id || '';
      session.user.email = token.email || '';
      session.user.name = token.name || '';
      session.user.image = token.image;
      session.user.isAdmin = Boolean(token.isAdmin);
      session.accessToken = token.accessToken;
      session.sessionToken = token.sessionToken;
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
};
