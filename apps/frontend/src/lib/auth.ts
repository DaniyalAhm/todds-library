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
          account.access_token = data.access_token;
        } catch {
          return false;
        }
      }
      return true;
    },
    async jwt({ token, account, user }) {
      if (account) {
        token.accessToken = account.access_token as string;
      }
      if (user) {
        const userData = user as {
          id?: string;
          email?: string | null;
          name?: string | null;
          image?: string | null;
          accessToken?: string;
          isAdmin?: boolean;
        };
        token.id = userData.id || token.id;
        token.email = userData.email || token.email;
        token.name = userData.name || token.name;
        token.image = userData.image || token.image;
        if (userData.accessToken) {
          token.accessToken = userData.accessToken;
        }
        if (userData.isAdmin !== undefined) {
          token.isAdmin = userData.isAdmin;
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
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
};
