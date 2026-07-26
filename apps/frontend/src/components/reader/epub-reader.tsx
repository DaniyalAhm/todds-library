'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useBook, useBookProgress, useUpdateProgress, useCreateBookmark } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  Search,
  Bookmark,
  List,
  X,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface EpubReaderProps {
  bookId: string;
}

export function EpubReader({ bookId }: EpubReaderProps) {
  const { data: book } = useBook(bookId);
  const { data: progress } = useBookProgress(bookId);
  const updateProgress = useUpdateProgress(bookId);
  const createBookmark = useCreateBookmark(bookId);

  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const objectUrlRef = useRef<string | null>(null);
  const progressLocationRef = useRef<string | null | undefined>(null);
  const updateProgressRef = useRef(updateProgress);

  const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>('dark');
  const [fontSize, setFontSize] = useState(100);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [toc, setToc] = useState<any[]>([]);
  const [currentLocation, setCurrentLocation] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    progressLocationRef.current = progress?.location;
  }, [progress?.location]);

  useEffect(() => {
    updateProgressRef.current = updateProgress;
  }, [updateProgress]);

  const initBook = useCallback(async () => {
    if (!book?.download_url || !viewerRef.current) return;

    try {
      setLoadError('');
      const ePub = (await import('epubjs')).default;
      const response = await fetch(book.download_url);
      if (!response.ok) {
        throw new Error('Book file failed to load.');
      }
      if (renditionRef.current) {
        renditionRef.current.destroy();
        renditionRef.current = null;
      }
      if (bookRef.current) {
        bookRef.current.destroy();
        bookRef.current = null;
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      const arrayBuffer = await response.arrayBuffer();
      bookRef.current = ePub(arrayBuffer, { openAs: 'binary' });
      renditionRef.current = bookRef.current.renderTo(viewerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });

      const themeStyles = {
        light: { body: { background: '#f5f0e8', color: '#3a3a3a' } },
        dark: { body: { background: '#1a1a2e', color: '#e0e0e0' } },
        sepia: { body: { background: '#f4ecd8', color: '#5b4636' } },
      };

      renditionRef.current.themes.register(themeStyles);
      renditionRef.current.themes.select('dark');
      renditionRef.current.themes.fontSize('100%');

      const tocData = await bookRef.current.loaded.navigation;
      const tocItems = tocData.toc.map((item: any) => ({
        href: item.href,
        label: item.label,
      }));
      setToc(tocItems);

      await renditionRef.current.display(progressLocationRef.current || undefined);

      renditionRef.current.on('relocated', (location: any) => {
        const { start } = location;
        if (start?.cfi) {
          setCurrentLocation(start.cfi);
          const total = bookRef.current?.spine?.length || 1;
          const current = start.index || 0;
          updateProgressRef.current.mutate({
            progress: current / total,
            position: current,
            location: start.cfi,
          });
        }
      });
    } catch (err) {
      console.error('Failed to load epub:', err);
      setLoadError('Book file failed to load.');
    }
  }, [book?.download_url]);

  useEffect(() => {
    setTheme('dark');
  }, []);

  useEffect(() => {
    initBook();
    return () => {
      if (renditionRef.current) {
        renditionRef.current.destroy();
      }
      if (bookRef.current) {
        bookRef.current.destroy();
      }
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [initBook]);

  useEffect(() => {
    if (renditionRef.current) {
      renditionRef.current.themes.select(theme);
    }
  }, [theme]);

  useEffect(() => {
    if (renditionRef.current) {
      renditionRef.current.themes.fontSize(`${fontSize}%`);
    }
  }, [fontSize]);

  const handleNavigate = (href: string) => {
    if (renditionRef.current) {
      renditionRef.current.display(href);
      setShowSidebar(false);
    }
  };

  const handlePrev = () => renditionRef.current?.prev();
  const handleNext = () => renditionRef.current?.next();

  const handleAddBookmark = () => {
    if (currentLocation) {
      const title = `Page ${toc.findIndex((t) => t.href === currentLocation) + 1}`;
      createBookmark.mutate({
        note: title,
        position: currentLocation ? 1 : 0,
        location: currentLocation,
      });
    }
  };

  const handleSearch = async (query: string) => {
    if (!bookRef.current || !query) return;
    const results = await bookRef.current.search(query);
    if (results.length > 0) {
      renditionRef.current.display(results[0].cfi);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-2 py-2 sm:px-4">
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSidebar(!showSidebar)}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>

        <div className="order-3 flex w-full items-center justify-center gap-2 sm:order-none sm:w-auto">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={handlePrev}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs text-muted-foreground sm:min-w-[80px]">
              {currentLocation ? `Page ${Math.round(parseFloat(currentLocation.split('/').pop() || '0'))}` : ''}
            </span>
            <Button variant="ghost" size="icon" onClick={handleNext}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSearch(!showSearch)}
          >
            <Search className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleAddBookmark}>
            <Bookmark className="h-4 w-4" />
          </Button>
          <Button className="hidden sm:inline-flex" variant="ghost" size="icon" onClick={() => setFontSize(Math.max(80, fontSize - 10))}>
            <Type className="h-4 w-4" />
          </Button>
          <Button className="hidden sm:inline-flex" variant="ghost" size="icon" onClick={() => setFontSize(Math.min(200, fontSize + 10))}>
            <Type className="h-5 w-5" />
          </Button>
          <div className="ml-1 flex rounded-md border border-border sm:ml-2">
            <Button
              variant={theme === 'light' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-r-none px-2"
              onClick={() => setTheme('light')}
            >
              <Sun className="h-3 w-3" />
            </Button>
            <Button
              variant={theme === 'dark' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none px-2"
              onClick={() => setTheme('dark')}
            >
              <Moon className="h-3 w-3" />
            </Button>
            <Button
              variant={theme === 'sepia' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-l-none px-2"
              onClick={() => setTheme('sepia')}
            >
              <Sun className="h-3 w-3 text-amber-500" />
            </Button>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="border-b border-border bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {showSearch && (
        <div className="border-b border-border bg-card p-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search in book..."
              className="pl-10"
              onChange={(e) => handleSearch(e.target.value)}
              autoFocus
            />
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {showSidebar && (
          <div className="absolute inset-y-0 left-0 z-20 w-[min(18rem,85vw)] shrink-0 border-r border-border bg-card shadow-xl md:relative md:inset-auto md:w-64 md:shadow-none">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="text-sm font-medium">Contents</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowSidebar(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <ScrollArea className="h-full">
              <div className="p-2">
                {toc.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleNavigate(item.href)}
                    className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <div
          ref={viewerRef}
          className={cn(
            'h-full min-h-0 min-w-0 flex-1 overflow-hidden',
            theme === 'dark' ? 'bg-[#1a1a2e]' : theme === 'sepia' ? 'bg-[#f4ecd8]' : 'bg-[#f5f0e8]'
          )}
        />
      </div>
    </div>
  );
}
