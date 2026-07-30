export const routes = {
  home: '/',
  login: '/login',
  register: '/register',
  dashboard: '/dashboard',
  books: '/books',
  libraries: '/libraries',
  search: '/search',
  settings: '/settings',
  admin: '/admin',
  adminMetadata: '/admin/metadata',
  adminSettings: '/admin/settings',
  adminUsers: '/admin/users',
  book: (id: string) => `/books/${encodeURIComponent(id)}`,
  bookRead: (id: string) => `/books/${encodeURIComponent(id)}/read`,
  bookListen: (id: string) => `/books/${encodeURIComponent(id)}/listen`,
  library: (id: string) => `/libraries/${encodeURIComponent(id)}`,
  searchQuery: (query: string) => `/search?q=${encodeURIComponent(query)}`,
} as const;

export type AppRoute = string;
