import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: {
    signIn: '/login',
  },
});

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/books/:path*',
    '/libraries/:path*',
    '/search/:path*',
    '/settings/:path*',
    '/admin/:path*',
  ],
};
