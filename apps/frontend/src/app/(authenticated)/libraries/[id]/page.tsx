'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useBooks } from '@/hooks/use-books';
import { useLibrary } from '@/hooks/use-libraries';
import { BookGrid } from '@/components/books/book-grid';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Search } from 'lucide-react';

export default function LibraryDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [search, setSearch] = useState('');
  const [format, setFormat] = useState('all');
  const [sort, setSort] = useState('title');

  const { data: library, isLoading: loadingLib } = useLibrary(id);
  const { data: books, isLoading: loadingBooks } = useBooks({
    library_id: id,
    search: search || undefined,
    format: format !== 'all' ? format : undefined,
    sort,
    limit: 100,
  });

  return (
    <div className="space-y-6">
      <div>
        {loadingLib ? (
          <Skeleton className="h-8 w-48" />
        ) : (
          <h1 className="text-3xl font-bold text-foreground">
            {library?.name || 'Library'}
          </h1>
        )}
        {library && (
          <p className="mt-1 text-sm text-muted-foreground">{library.path}</p>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search in this library..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={format} onValueChange={setFormat}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Formats</SelectItem>
            <SelectItem value="epub">EPUB</SelectItem>
            <SelectItem value="pdf">PDF</SelectItem>
            <SelectItem value="mobi">MOBI</SelectItem>
            <SelectItem value="mp3">MP3</SelectItem>
            <SelectItem value="m4b">M4B</SelectItem>
            <SelectItem value="cbz">CBZ</SelectItem>
            <SelectItem value="cbr">CBR</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="title">Title</SelectItem>
            <SelectItem value="author">Author</SelectItem>
            <SelectItem value="created_at">Date Added</SelectItem>
            <SelectItem value="updated_at">Last Updated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <BookGrid
        books={books?.items}
        isLoading={loadingBooks}
        emptyMessage="No books in this library"
      />
    </div>
  );
}
