import { z } from "zod";

export const LibraryType = z.enum(["ebook", "audiobook", "mixed"]);
export type LibraryType = z.infer<typeof LibraryType>;

export const BookFormat = z.enum(["epub", "pdf", "mobi", "cbz", "cbr", "mp3", "m4b", "flac", "ogg"]);
export type BookFormat = z.infer<typeof BookFormat>;

export const MetadataSource = z.enum(["openlibrary", "google_books", "audible", "isbndb"]);
export type MetadataSource = z.infer<typeof MetadataSource>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().email().optional(),
  authentikSub: z.string(),
  isAdmin: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const LibrarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  path: z.string().min(1),
  type: LibraryType,
  userId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Library = z.infer<typeof LibrarySchema>;

export const CreateLibrarySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1),
  type: LibraryType,
});
export type CreateLibrary = z.infer<typeof CreateLibrarySchema>;

export const BookSchema = z.object({
  id: z.string().uuid(),
  libraryId: z.string().uuid(),
  title: z.string(),
  author: z.string().optional(),
  series: z.string().optional(),
  seriesIndex: z.number().optional(),
  isbn: z.string().optional(),
  asin: z.string().optional(),
  description: z.string().optional(),
  publisher: z.string().optional(),
  publishedDate: z.string().optional(),
  language: z.string().optional(),
  pageCount: z.number().optional(),
  duration: z.number().optional(),
  filePath: z.string(),
  fileFormat: BookFormat,
  fileSize: z.number(),
  coverPath: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Book = z.infer<typeof BookSchema>;

export const BookChapterSchema = z.object({
  id: z.string().uuid(),
  bookId: z.string().uuid(),
  index: z.number(),
  title: z.string(),
  startPosition: z.number(),
});
export type BookChapter = z.infer<typeof BookChapterSchema>;

export const ReadingProgressSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  bookId: z.string().uuid(),
  position: z.number(),
  progress: z.number().min(0).max(1),
  lastUpdated: z.string().datetime(),
});
export type ReadingProgress = z.infer<typeof ReadingProgressSchema>;

export const UpdateProgressSchema = z.object({
  position: z.number(),
  progress: z.number().min(0).max(1),
});
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>;

export const BookmarkSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  bookId: z.string().uuid(),
  position: z.number(),
  note: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Bookmark = z.infer<typeof BookmarkSchema>;

export const CreateBookmarkSchema = z.object({
  position: z.number(),
  note: z.string().optional(),
});
export type CreateBookmark = z.infer<typeof CreateBookmarkSchema>;

export const MetadataCacheSchema = z.object({
  id: z.string().uuid(),
  bookId: z.string().uuid(),
  source: MetadataSource,
  rawData: z.record(z.unknown()),
  lastFetched: z.string().datetime(),
});
export type MetadataCache = z.infer<typeof MetadataCacheSchema>;

export const ScanResultSchema = z.object({
  libraryId: z.string().uuid(),
  totalFiles: z.number(),
  newBooks: z.number(),
  updatedBooks: z.number(),
  removedBooks: z.number(),
  errors: z.array(z.string()),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const SearchResultSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  author: z.string().optional(),
  series: z.string().optional(),
  coverPath: z.string().optional(),
  fileFormat: BookFormat,
  libraryId: z.string().uuid(),
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
