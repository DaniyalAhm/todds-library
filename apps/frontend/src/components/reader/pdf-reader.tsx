'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download } from 'lucide-react';
import { useBook } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';

interface PdfReaderProps {
  bookId: string;
}

export function PdfReader({ bookId }: PdfReaderProps) {
  const { data: book } = useBook(bookId);
  const objectUrlRef = useRef<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!book?.download_url) return;

    let cancelled = false;

    async function loadPdf() {
      setLoadError('');
      setPdfUrl('');
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }

      try {
        const response = await fetch(book!.download_url);
        if (!response.ok) {
          throw new Error('PDF file failed to load.');
        }
        const blob = await response.blob();
        if (cancelled) return;
        objectUrlRef.current = URL.createObjectURL(blob);
        setPdfUrl(objectUrlRef.current);
      } catch {
        if (!cancelled) {
          setLoadError('PDF file failed to load.');
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [book]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-destructive">{loadError}</p>
      </div>
    );
  }

  if (!pdfUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-end border-b border-border bg-card px-4 py-2">
        <Button variant="outline" size="sm" asChild>
          <a href={pdfUrl} download={book?.title ? `${book.title}.pdf` : 'book.pdf'}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </a>
        </Button>
      </div>
      <iframe
        src={pdfUrl}
        title={book?.title || 'PDF reader'}
        className="h-full w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}
